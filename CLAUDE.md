# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`energie-dashboard` — a Node.js/Express proxy server + vanilla JS frontend that displays real-time energy data from a local Home Assistant instance (Enphase Envoy solar system + Ecojoko smart meter + smart plugs). Includes an Eau (water) tab.

## Commands

```bash
cd energie-dashboard

# Install dependencies
npm install

# Run (production)
npm start          # node server.js on port 3000

# Run (development, auto-reload)
npm run dev        # nodemon server.js
```

No build step, no test suite.

## Architecture

```
energie-dashboard/
  server.js          # Express proxy: forwards /api/* requests to Home Assistant
  public/
    index.html       # Single-page dashboard (French UI) — Énergie + Eau tabs
    script.js        # All frontend logic: data fetching, Chart.js, DOM updates
    style.css        # Dark theme styling
```

**Proxy architecture:** `script.js` calls `/api/*` on the local Express server, which forwards to Home Assistant with the token. The token never reaches the browser.

**Batch endpoint:** The frontend primarily uses `/api/all-energy-data?period=X` which returns all current states, device data (with period energy deltas), and history in a single call (~33 individual calls → 1).

**Configuration:** `HA_URL` and `HA_TOKEN` are required environment variables. `docker-compose.yml` a des valeurs par défaut (via `${VAR:-default}`) donc fonctionne sans config Portainer. `public/script.js` holds `HA_CONFIG` with pricing only:
```js
const HA_CONFIG = {
    priceHP: 0.1876,    // €/kWh heures pleines
    priceHC: 0.1456,    // €/kWh heures creuses
    priceSurplus: 0.13, // €/kWh vendu au réseau
    priceWater: 4.82    // €/m³
};
```

## Key details

- Home Assistant at `http://192.168.40.214:8123`; server listens on `0.0.0.0:3000`
- Energy sensors: Enphase Envoy (`sensor.envoy_122303081421_*`) + Ecojoko (`sensor.ecojoko_*`)
- Device sensors: 10 smart plugs (`sensor.prise_*`, `sensor.garage_prise_*`), each with `_energy` and `_power` variants
- Water sensor: `sensor.consommation_eau_totale`
- Charts use Chart.js 4.4 + luxon adapter (loaded from CDN)
- Auto-refresh: configurable interval (10s/30s/1min/5min) with enable/disable toggle
- Numbers formatted with French locale (comma as decimal separator)
- `window.HADashboard` is exposed on the global for browser-console debugging

## Sensor configuration

Sensor definitions are in `server.js` (the `/api/all-energy-data` endpoint) and `public/script.js` (`SENSORS` object). Both must be kept in sync when adding/removing sensors.

### Sensor gotchas

- **Enphase lifetime sensors are in MWh**, not kWh → multiply delta by 1000
  - `sensor.envoy_122303081421_lifetime_net_energy_consumption` = total home load (solar + grid), in MWh
  - `sensor.envoy_122303081421_lifetime_net_energy_production` = total solar produced, in MWh
- **Ecojoko HP/HC/surplus sensors reset daily at midnight** → use `historyDeltaWithResets()` to sum across resets for multi-day periods
- **HA history API defaults to 24h** without `end_time` param → always pass `end_time=now` in history calls
- **Ecojoko `sensor.ecojoko_consommation_temps_reel`** (current power W) can go negative during solar export → clip with `Math.max(0, v)`

## History helper functions

```js
// Simple delta: last - first (for monotonically increasing sensors like Enphase lifetime)
historyDelta(history)

// Reset-aware delta: sums segments across daily resets (for HP, HC, surplus)
historyDeltaWithResets(history)

// Fetch history for a given period ('hour'|'day'|'week'|'month')
// Always passes end_time=now to avoid HA's 24h default cap
getHistory(entityId, period)
```

## Auto-consumption & self-sufficiency

Calculated from surplus sensor, not from Enphase vs Ecojoko delta comparison (which drifts):

```
selfConsumed       = production − surplus_injecté
auto-consommation  = selfConsumed / production × 100      (% de la prod utilisée localement)
autosuffisance     = selfConsumed / (HP + HC + selfConsumed) × 100  (% de la conso couverte par solaire)
```

## UI layout (Énergie tab)

**Stat cards (top):** Puissance Actuelle | Réseau HP+HC + coût | Production + revente surplus | Conso. Maison

**Detail cards (bottom):** Heures Pleines | Heures Creuses | Pic de Puissance | Auto-consommation | Autosuffisance

## Deployment (Production)

### Infrastructure
- **Git:** Gitea local → `http://10.20.0.29:3000/antha/energie-dashboard.git` (branch: `master`)
- **Docker host:** `192.168.50.69` managed via Portainer → `https://192.168.50.69:9443`
- **Stack name:** `energie-dashboard` — deployed via Portainer Repository mode
- **URL prod:** `http://192.168.50.69:3000`

### Config Docker
- `HA_URL` et `HA_TOKEN` passés en variables d'environnement dans `docker-compose.yml`
- `server.js` lit `process.env.HA_URL` et `process.env.HA_TOKEN` (pas de fallback — plantage si absents)

### Workflow de mise à jour
```powershell
# 1. Modifier le code
git add .
git commit -m "description du changement"
git push

# 2. Dans Portainer → Stacks → energie-dashboard → Pull and redeploy
```

### Développement local (sans Docker)
```bash
cd energie-dashboard
npm install
npm run dev   # nodemon, port 3000
```
