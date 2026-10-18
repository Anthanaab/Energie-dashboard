const express = require('express');
const axios = require('axios');
const path = require('path');
const { execFile, spawn } = require('child_process');

const db = require('./db');
const poller = require('./poller');
const { MAIN, WATER, DEVICES } = require('./sensors');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);   // 80 dans le LXC (voir install_lxc.sh)

// ===== Configuration Home Assistant =====
if (!process.env.HA_URL || !process.env.HA_TOKEN) {
    console.error('FATAL: HA_URL et HA_TOKEN doivent être définis via les variables d\'environnement.');
    process.exit(1);
}
const HA_CONFIG = { url: process.env.HA_URL, token: process.env.HA_TOKEN };

// ===== Middleware =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

// ===== Client HA (poller + météo live) =====
const haClient = axios.create({
    baseURL: HA_CONFIG.url + '/api',
    headers: {
        'Authorization': `Bearer ${HA_CONFIG.token}`,
        'Content-Type': 'application/json'
    },
    timeout: 8000
});

// ===== Helpers =====
const CHART_POINTS = 150;
const nowSec = () => Math.floor(Date.now() / 1000);
const periodSeconds = (period) => {
    switch (period) {
        case 'hour':  return 60 * 60;
        case 'week':  return 7 * 24 * 60 * 60;
        case 'month': return 30 * 24 * 60 * 60;
        case 'day':
        default:      return 24 * 60 * 60;
    }
};
const tsToISO = (ts) => new Date(ts * 1000).toISOString();

// ===== Météo (Pirate Weather + sun.sun via HA, en direct) =====
app.get('/api/weather', async (req, res) => {
    const entityId = process.env.WEATHER_ENTITY || 'weather.pirateweather';
    try {
        const [weatherRes, sunRes] = await Promise.all([
            haClient.get(`/states/${entityId}`),
            haClient.get('/states/sun.sun')
        ]);
        const s = weatherRes.data;
        const sun = sunRes.data.attributes;
        const toH = iso => { const d = new Date(iso); return d.getHours() + d.getMinutes() / 60; };
        res.json({
            condition: s.state,
            temperature: s.attributes.temperature,
            apparent_temperature: s.attributes.apparent_temperature,
            wind_speed: s.attributes.wind_speed,
            wind_bearing: s.attributes.wind_bearing,
            humidity: s.attributes.humidity,
            uv_index: s.attributes.uv_index,
            pressure: s.attributes.pressure,
            sunrise: toH(sun.next_rising),
            sunset:  toH(sun.next_setting),
            source: 'ha'
        });
    } catch (error) {
        console.error('Error fetching weather from HA:', error.message);
        res.status(500).json({ error: 'Failed to fetch weather' });
    }
});

// ===== Endpoint énergie (lecture DB, calculs serveur) =====
app.get('/api/all-energy-data', (req, res) => {
    try {
        const period = req.query.period || 'day';
        const len = periodSeconds(period);
        const until = nowSec();
        const since = until - len;
        const prevUntil = since;
        const prevSince = since - len;

        // Lectures brutes (pleine résolution → deltas précis).
        // sanitize() retire les pics isolés corrompus (ex: valeur backfill aberrante).
        const hpRows      = db.sanitize(db.getReadings(MAIN.hp, since, until));
        const hcRows      = db.sanitize(db.getReadings(MAIN.hc, since, until));
        const surplusRows = db.sanitize(db.getReadings(MAIN.surplus, since, until));
        const prodRows    = db.sanitize(db.getReadings(MAIN.production, since, until));
        const powerRows   = db.getReadings(MAIN.currentPower, since, until);

        const hp         = db.deltaWithResets(hpRows);
        const hc         = db.deltaWithResets(hcRows);
        const surplus    = db.deltaWithResets(surplusRows);
        const production = db.deltaWithResets(prodRows);
        const peakPower  = db.peak(powerRows);

        // États courants (dernière valeur connue)
        const currentPower = db.getLatest(MAIN.currentPower) ?? 0;
        const currentSolarPower = db.getLatest(MAIN.solarPower) ?? 0;

        // Prises (top consommateurs)
        const devices = DEVICES.map(([energyId, powerId, name]) => ({
            name,
            energy: db.deltaWithResets(db.sanitize(db.getReadings(energyId, since, until))),
            power: db.getLatest(powerId) ?? 0,
        }));

        // Période précédente (comparaison)
        const prev = {
            hp:         db.deltaWithResets(db.sanitize(db.getReadings(MAIN.hp, prevSince, prevUntil))),
            hc:         db.deltaWithResets(db.sanitize(db.getReadings(MAIN.hc, prevSince, prevUntil))),
            production: db.deltaWithResets(db.sanitize(db.getReadings(MAIN.production, prevSince, prevUntil))),
            surplus:    db.deltaWithResets(db.sanitize(db.getReadings(MAIN.surplus, prevSince, prevUntil))),
        };

        // Séries graphiques (downsamplées)
        const edges = db.makeEdges(since, until, CHART_POINTS);
        const prodCurve = db.cumulativeAtEdges(prodRows, edges);
        const hpCurve   = db.cumulativeAtEdges(hpRows, edges);
        const hcCurve   = db.cumulativeAtEdges(hcRows, edges);
        const surCurve  = db.cumulativeAtEdges(surplusRows, edges);
        const consoCurve = edges.map((_, i) =>
            hpCurve[i] + hcCurve[i] + Math.max(0, prodCurve[i] - surCurve[i])
        );
        const powerCurve = db.instantAtEdges(powerRows, edges);
        const timestamps = edges.map(tsToISO);

        res.json({
            main: { currentPower, currentSolarPower },
            period: { hp, hc, surplus, production, peakPower },
            prev,
            devices,
            history: { timestamps, consumption: consoCurve, production: prodCurve, power: powerCurve },
        });
    } catch (error) {
        console.error('Error in all-energy-data:', error.message);
        res.status(500).json({ error: 'Failed to compute energy data' });
    }
});

// ===== Endpoint eau (lecture DB) =====
app.get('/api/water-data', (req, res) => {
    try {
        const period = req.query.period || 'day';
        const until = nowSec();
        const since = until - periodSeconds(period);
        const edges = db.makeEdges(since, until, CHART_POINTS);
        const timestamps = edges.map(tsToISO);

        const readMeter = (entityId) => {
            const rows = db.sanitize(db.getReadings(entityId, since, until));
            return {
                liters: db.deltaWithResets(rows),
                history: { timestamps, liters: db.cumulativeAtEdges(rows, edges) },
            };
        };

        const main = readMeter(WATER.main);
        const ext = readMeter(WATER.ext);

        // Champs legacy (liters/history) conservés à plat = compteur principal, pour compat rétro
        res.json({ liters: main.liters, history: main.history, main, ext });
    } catch (error) {
        console.error('Error in water-data:', error.message);
        res.status(500).json({ error: 'Failed to compute water data' });
    }
});

// ===== Statut / debug =====
app.get('/api/status', (req, res) => {
    res.json({ ok: true, readings: db.count(), db: db.DB_PATH, updating });
});

// ===== Mise à jour de l'application (git pull + npm + restart) =====
const REPO_DIR = __dirname;
const SERVICE_NAME = 'energie-dashboard';
let updating = false;

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
    execFile(cmd, args, {
        timeout: 180000,
        env: {
            ...process.env,
            HOME: '/data',
            npm_config_cache: '/data/.npm',
            GIT_TERMINAL_PROMPT: '0',
        },
        ...opts,
    }, (err, stdout, stderr) => {
        resolve({
            code: err ? (err.code !== undefined ? err.code : 1) : 0,
            stdout: (stdout || '').toString(),
            stderr: (stderr || '').toString(),
        });
    });
});

app.get('/api/version', async (req, res) => {
    const r = await run('git', ['-C', REPO_DIR, 'rev-parse', '--short', 'HEAD']);
    res.json({ commit: r.stdout.trim() || '?', ok: r.code === 0 });
});

app.post('/api/update', async (req, res) => {
    if (updating) return res.status(409).json({ error: 'Une mise à jour est déjà en cours.' });
    updating = true;
    const log = [];
    const record = (label, r) => {
        const t = (r.stdout || r.stderr).trim();
        log.push(`$ ${label}${t ? '\n' + t.split('\n').map(l => '   ' + l).join('\n') : ''}`);
    };
    try {
        const pull = await run('git', ['-C', REPO_DIR, 'pull', '--ff-only'], { cwd: REPO_DIR });
        record('git pull --ff-only', pull);
        if (pull.code !== 0) {
            return res.status(500).json({ ok: false, error: 'git pull a échoué (fichier modifié localement ?)', log });
        }
        if (/already up to date/i.test(pull.stdout)) {
            return res.json({ ok: true, upToDate: true, log, message: 'Déjà à jour.' });
        }
        const npm = await run('npm', ['install', '--omit=dev'], { cwd: REPO_DIR });
        record('npm install --omit=dev', npm);
        if (npm.code !== 0) {
            return res.status(500).json({ ok: false, error: "npm install a échoué (voir log), le service n'a pas été redémarré.", log });
        }
        res.json({ ok: true, upToDate: false, log });
        // Redémarrage différé : le serveur s'arrête, on détache le process pour qu'il survive.
        setTimeout(() => {
            spawn('sh', ['-c', `sleep 1 && sudo -n systemctl restart ${SERVICE_NAME}`],
                { detached: true, stdio: 'ignore' }).unref();
        }, 300);
    } catch (e) {
        res.status(500).json({ error: 'Échec de la mise à jour.', log, detail: String((e && e.message) || e) });
    } finally {
        updating = false;
    }
});

// ===== Debug : analyse d'une série (diagnostic over-count) =====
// /api/debug/series?entity=<id>&period=month  (entity par défaut = production)
app.get('/api/debug/series', (req, res) => {
    try {
        const entity = req.query.entity || MAIN.production;
        const period = req.query.period || 'month';
        const until = nowSec();
        const since = until - periodSeconds(period);
        const rows = db.getReadings(entity, since, until);

        let upSum = 0, downSteps = 0, downMag = 0, zeros = 0;
        for (let i = 1; i < rows.length; i++) {
            const d = rows[i].value - rows[i - 1].value;
            if (d > 0) upSum += d; else if (d < 0) { downSteps++; downMag += -d; }
            if (rows[i].value === 0) zeros++;
        }
        // Découpage par jour (UTC) : max-min = production de la journée
        const days = {};
        for (const r of rows) {
            const day = new Date(r.ts * 1000).toISOString().slice(0, 10);
            (days[day] = days[day] || []).push(r.value);
        }
        const daily = Object.entries(days).map(([day, vs]) => ({
            day, n: vs.length, min: Math.min(...vs), max: Math.max(...vs),
            span: +(Math.max(...vs) - Math.min(...vs)).toFixed(3)
        }));
        const sumDailySpan = +daily.reduce((a, b) => a + b.span, 0).toFixed(3);

        res.json({
            entity, period, points: rows.length,
            total_currentMethod: +db.deltaWithResets(rows).toFixed(3),
            total_positiveIncrements: +upSum.toFixed(3),
            sumDailySpan,        // référence robuste (somme des prod journalières)
            downSteps, downMagnitude: +downMag.toFixed(3), zeros,
            min: rows.length ? Math.min(...rows.map(r => r.value)) : null,
            max: rows.length ? Math.max(...rows.map(r => r.value)) : null,
            daily
        });
    } catch (error) {
        console.error('Error in debug/series:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ===== Serve Frontend =====
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== Start Server =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ⚡ Energie Dashboard Server
  ========================
  📍 Local:   http://localhost:${PORT}
  🔗 Home Assistant: ${HA_CONFIG.url}
`);
    poller.start(haClient).catch(err => console.error('[poller] échec démarrage :', err.message));
});

// Arrêt propre
const shutdown = () => { poller.stop(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle errors
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});
