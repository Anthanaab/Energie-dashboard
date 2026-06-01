const express = require('express');
const axios = require('axios');
const path = require('path');

const db = require('./db');
const poller = require('./poller');
const { MAIN, WATER, DEVICES } = require('./sensors');

const app = express();
const PORT = 3000;

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

        // Lectures brutes (pleine résolution → deltas précis)
        const hpRows      = db.getReadings(MAIN.hp, since, until);
        const hcRows      = db.getReadings(MAIN.hc, since, until);
        const surplusRows = db.getReadings(MAIN.surplus, since, until);
        const prodRows    = db.getReadings(MAIN.production, since, until);
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
            energy: db.deltaWithResets(db.getReadings(energyId, since, until)),
            power: db.getLatest(powerId) ?? 0,
        }));

        // Période précédente (comparaison)
        const prev = {
            hp:         db.deltaWithResets(db.getReadings(MAIN.hp, prevSince, prevUntil)),
            hc:         db.deltaWithResets(db.getReadings(MAIN.hc, prevSince, prevUntil)),
            production: db.deltaWithResets(db.getReadings(MAIN.production, prevSince, prevUntil)),
            surplus:    db.deltaWithResets(db.getReadings(MAIN.surplus, prevSince, prevUntil)),
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

        const rows = db.getReadings(WATER, since, until);
        const liters = db.deltaWithResets(rows);

        const edges = db.makeEdges(since, until, CHART_POINTS);
        const cumLiters = db.cumulativeAtEdges(rows, edges);
        const timestamps = edges.map(tsToISO);

        res.json({ liters, history: { timestamps, liters: cumLiters } });
    } catch (error) {
        console.error('Error in water-data:', error.message);
        res.status(500).json({ error: 'Failed to compute water data' });
    }
});

// ===== Statut / debug =====
app.get('/api/status', (req, res) => {
    res.json({ ok: true, readings: db.count(), db: db.DB_PATH });
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
