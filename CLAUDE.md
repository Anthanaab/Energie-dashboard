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

**Configuration:** `HA_URL` and `HA_TOKEN` are required environment variables — no hardcoded fallback. `server.js` exits at startup if either is missing. `public/script.js` holds `HA_CONFIG` with pricing only:
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
  - `sensor.envoy_122303081421_lifetime_net_energy_consumption` = **grid net** (import − export), NOT total home load. In MWh. When exporting > importing, the delta is negative.
  - `sensor.envoy_122303081421_lifetime_net_energy_production` = total solar produced, in MWh
- **Ecojoko HP/HC/surplus sensors reset daily at midnight** → use `historyDeltaWithResets()` to sum across resets for multi-day periods
- **HA history API defaults to 24h** without `end_time` param → always pass `end_time=now` in history calls
- **Ecojoko `sensor.ecojoko_consommation_temps_reel`** (current power W) can go negative during solar export → displayed raw (negative = export en cours), do NOT clip to 0
- **Ecojoko `sensor.ecojoko_surplus_de_production`** (kWh, total_increasing) can go negative at night and resets daily at midnight.
  → Uses `historyDeltaWithResetsAbs()` to handle negative values + daily resets for multi-day periods
- **Water `sensor.consommation_eau_totale`** resets daily at midnight. Uses `historyDeltaWithResets()` for period calculation.
  ⚠️ **Limitation:** For 7j/30j periods, if HA's recorder purges data (default ~7-10 days), the calculated delta will be incomplete.
  **Fix:** Increase `purge_keep_days` in `configuration.yaml`:
  ```yaml
  recorder:
    purge_keep_days: 30
  ```
  Then restart HA. Wait 24-48h for full 30-day data to accumulate.

## History helper functions

```js
// Simple delta: last - first (for monotonically increasing sensors like Enphase lifetime)
historyDelta(history)

// Same but allows negative delta (for Enphase net consumption which decreases when exporting)
historyDeltaSigned(history)

// Reset-aware delta: sums segments across daily resets (for HP, HC)
historyDeltaWithResets(history)

// Reset-aware delta for negative sensors: converts to absolute values before summing segments
// Use for Ecojoko surplus sensor which sends negative values and resets daily at midnight
historyDeltaWithResetsAbs(history)

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

### Surplus calculation

Le surplus est lu directement depuis `sensor.ecojoko_surplus_de_production` via `historyDeltaWithResetsAbs()`.
Ce capteur envoie des valeurs négatives et se remet à zéro à minuit chaque jour.
La fonction `historyDeltaWithResetsAbs()` convertit chaque valeur en absolu avant de sommer les segments,
ce qui permet d'obtenir un delta correct sur toutes les périodes (1h, 24h, 7j, 30j).

## UI layout (Énergie tab)

**Stat cards (top):** Puissance Actuelle | Réseau HP+HC + coût | Production + revente surplus | Conso. Maison

**Detail cards (bottom):** Heures Pleines | Heures Creuses | Pic de Puissance | Auto-consommation | Autosuffisance

### Puissance Actuelle card
- Affiche la valeur absolue du capteur `ecojoko_consommation_temps_reel`
- Badge vert `↑ export` visible quand la valeur est négative (export solaire vers le réseau)
- La carte passe en thème vert (fond + glow) en mode export via la classe CSS `.exporting`

### Conso. Maison
- Calculé comme `HP + HC + selfConsumed` (selfConsumed = production − surplus injecté)
- **Ne pas utiliser** le net Enphase (`lifetime_net_energy_consumption`) pour cette valeur — il mesure import−export et peut être négatif ou sous-estimer la conso réelle lors d'export important

## Deployment (Production)

### Infrastructure
- **Git:** Gitea local → `http://192.168.50.15:3000/antha/energie-dashboard.git` (branch: `master`)
- **Docker host:** `192.168.50.69` managed via Portainer → `https://192.168.50.69:9443`
- **Stack name:** `energie-dashboard` — deployed via Portainer Repository mode
- **URL prod:** `http://192.168.50.69:3000`

### Config Docker
- `docker-compose.yml` utilise `${HA_URL}` et `${HA_TOKEN}` (sans fallback)
- Les valeurs sont à saisir dans **Portainer → Stacks → energie-dashboard → Environment variables**
- `server.js` plante au démarrage si l'une des deux variables est absente
- Le token ne doit jamais être committé dans le code

### Développement local (sans Docker)
Créer un fichier `.env` à la racine (déjà dans `.gitignore`), voir `.env.example` :
```
HA_URL=http://192.168.40.214:8123
HA_TOKEN=<ton token>
```

```bash
cd energie-dashboard
npm install
npm run dev   # nodemon, port 3000
```

### Workflow de mise à jour
```powershell
# 1. Modifier le code
git add .
git commit -m "description du changement"
git push

# 2. Dans Portainer → Stacks → energie-dashboard → Pull and redeploy
```
