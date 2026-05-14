const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

// ===== Configuration Home Assistant =====
const HA_CONFIG = {
    url: process.env.HA_URL,
    token: process.env.HA_TOKEN
};

// ===== Validation =====
if (!HA_CONFIG.url || !HA_CONFIG.token) {
    console.error('ERREUR: HA_URL et HA_TOKEN doivent être définis via les variables d\'environnement.');
    process.exit(1);
}

// ===== Middleware =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

// ===== HA API Client =====
const haClient = axios.create({
    baseURL: HA_CONFIG.url + '/api',
    headers: {
        'Authorization': `Bearer ${HA_CONFIG.token}`,
        'Content-Type': 'application/json'
    }
});

// ===== Proxy Endpoints =====

// GET /api/states/:entityId
app.get('/api/states/:entityId', async (req, res) => {
    try {
        const { entityId } = req.params;
        const response = await haClient.get(`/states/${entityId}`);
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching state:', error.message);
        res.status(500).json({ error: 'Failed to fetch state' });
    }
});

// GET /api/history/period/:startTime
app.get('/api/history/period/:startTime', async (req, res) => {
    try {
        const { startTime } = req.params;
        const { filter, end_time } = req.query;

        const url = `/history/period/${startTime}`;
        const params = {};
        if (filter) params.filter_entity_id = filter;
        if (end_time) params.end_time = end_time;
        
        const response = await haClient.get(url, { params });
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching history:', error.message);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

// GET /api/states - Get multiple states
app.get('/api/states', async (req, res) => {
    try {
        const { entities } = req.query;
        if (!entities) {
            return res.status(400).json({ error: 'Missing entities parameter' });
        }
        
        const entityList = entities.split(',');
        const promises = entityList.map(entity => haClient.get(`/states/${entity}`));
        const responses = await Promise.allSettled(promises);
        
        const results = {};
        responses.forEach((response, index) => {
            if (response.status === 'fulfilled') {
                results[entityList[index]] = response.value.data;
            } else {
                results[entityList[index]] = null;
            }
        });
        
        res.json(results);
    } catch (error) {
        console.error('Error fetching multiple states:', error.message);
        res.status(500).json({ error: 'Failed to fetch states' });
    }
});

// ===== Helpers =====
const periodToStartTime = (period, now = new Date()) => {
    switch (period) {
        case 'hour': return new Date(now.getTime() - 1 * 60 * 60 * 1000);
        case 'week': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        case 'month': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        default: return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
};

const toLocalISO = (date) => {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
};

// GET /api/all-energy-data - Endpoint batch unique pour le dashboard
app.get('/api/all-energy-data', async (req, res) => {
    try {
        const { period = 'day' } = req.query;
        const now = new Date();
        const startTime = periodToStartTime(period, now);
        const startISO = toLocalISO(startTime);
        const endISO = toLocalISO(now);

        // All sensors needed by the dashboard
        const mainEntityIds = [
            'sensor.envoy_122303081421_consommation_d_energie_du_jour',
            'sensor.envoy_122303081421_lifetime_net_energy_consumption',
            'sensor.envoy_122303081421_lifetime_net_energy_production',
            'sensor.envoy_122303081421_production_d_energie_du_jour',
            'sensor.ecojoko_consommation_temps_reel',
            'sensor.ecojoko_surplus_de_production',
            'sensor.ecojoko_consommation_hp_reseau',
            'sensor.ecojoko_consommation_hc_reseau'
        ];

        const devicePairs = [
            ['sensor.prise_rack_energy', 'sensor.prise_rack_power', 'Rack'],
            ['sensor.prise_tv_energy', 'sensor.prise_tv_power', 'TV'],
            ['sensor.prise_proxmox_energy', 'sensor.prise_proxmox_power', 'Proxmox (PC Gaming)'],
            ['sensor.prise_grenier_energy', 'sensor.prise_grenier_power', 'Grenier'],
            ['sensor.prise_pc_ss_energy', 'sensor.prise_pc_ss_power', 'PC Secondaire'],
            ['sensor.prise_sdb_energy', 'sensor.prise_sdb_power', 'Salle de Bain'],
            ['sensor.prise_pompe_energy', 'sensor.prise_pompe_power', 'Pompe'],
            ['sensor.prise_buffet_energy', 'sensor.prise_buffet_power', 'Buffet (Salon)'],
            ['sensor.garage_prise_porte_garage_192_energy', 'sensor.garage_prise_porte_garage_192_power', 'Porte Garage'],
            ['sensor.garage_prise_garage_194_energy', 'sensor.garage_prise_garage_194_power', 'Garage']
        ];

        // === Phase 1 : fetch all current states (28 calls, rapides) ===
        const statePromises = [
            ...mainEntityIds.map(id => haClient.get(`/states/${id}`)),
            ...devicePairs.flatMap(([e, p]) => [haClient.get(`/states/${e}`), haClient.get(`/states/${p}`)])
        ];

        const stateResults = await Promise.allSettled(statePromises);

        // Build main states
        const main = {};
        mainEntityIds.forEach((id, i) => {
            const r = stateResults[i];
            main[id] = r?.status === 'fulfilled' && r.value?.data
                ? parseFloat(r.value.data.state)
                : null;
        });

        // Build device current powers
        const deviceOff = mainEntityIds.length;
        const devices = devicePairs.map(([energyEntity, powerEntity, name], i) => {
            const pState = stateResults[deviceOff + i * 2 + 1];
            const power = pState?.status === 'fulfilled' && pState.value?.data
                ? parseFloat(pState.value.data.state)
                : 0;
            return { name, energy: 0, power };
        });

        // === Phase 2 : fetch histories (appels individuels — fiable, pas de souci d'ordre) ===
        const historyEntityIds = [
            'sensor.envoy_122303081421_lifetime_net_energy_consumption',
            'sensor.envoy_122303081421_lifetime_net_energy_production',
            'sensor.ecojoko_consommation_temps_reel',
            'sensor.ecojoko_consommation_hp_reseau',
            'sensor.ecojoko_consommation_hc_reseau',
            'sensor.ecojoko_surplus_de_production'
        ];

        const deviceEnergyIds = devicePairs.map(([e]) => e);

        const [historyResults, deviceHistoryResults] = await Promise.all([
            Promise.allSettled(historyEntityIds.map(id =>
                haClient.get(`/history/period/${startISO}`, {
                    params: { filter_entity_id: id, end_time: endISO }
                })
            )),
            Promise.allSettled(deviceEnergyIds.map(id =>
                haClient.get(`/history/period/${startISO}`, {
                    params: { filter_entity_id: id, end_time: endISO }
                })
            ))
        ]);

        // Parse history — HA returns [[{state,last_changed},...]]
        const histKeys = ['consumption', 'production', 'power', 'hp', 'hc', 'surplus'];
        const history = {};
        histKeys.forEach((key, i) => {
            const r = historyResults[i];
            history[key] = r?.status === 'fulfilled' && r.value?.data?.[0]
                ? r.value.data[0]
                : [];
        });

        // Parse device histories — compute energy deltas
        devicePairs.forEach(([energyEntity, powerEntity, name], i) => {
            const r = deviceHistoryResults[i];
            const hist = r?.status === 'fulfilled' && r.value?.data?.[0]
                ? r.value.data[0]
                : [];
            let energy = 0;
            if (hist.length >= 2) {
                const first = parseFloat(hist[0].state) || 0;
                const last = parseFloat(hist[hist.length - 1].state) || 0;
                energy = Math.max(0, last - first);
            }
            devices[i].energy = energy;
        });

        res.json({ main, devices, history });
    } catch (error) {
        console.error('Error in all-energy-data:', error.message);
        res.status(500).json({ error: 'Failed to fetch energy data' });
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
  📍 Network: http://0.0.0.0:${PORT}
  
  Press CTRL+C to stop
`);
});

// Handle errors
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});
