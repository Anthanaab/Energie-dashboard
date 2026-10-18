# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`energie-dashboard` — a Node.js/Express server + vanilla JS frontend that displays energy data from a local Home Assistant instance (Enphase Envoy solar + Ecojoko smart meter + smart plugs). Includes an Eau (water) tab, weather widget, animated solar flow, mix chart, CO₂/net-balance stats, period comparison and CSV export. **A background poller collects HA data into a local SQLite DB; the frontend reads computed values from the DB, not HA directly** (live weather/sun are the only direct HA reads).

## Commands

```bash
cd energie-dashboard

# Install dependencies (better-sqlite3 is a native module — see dev note)
npm install

# Run (production)
npm start          # node server.js on port 3000

# Run (development, auto-reload)
npm run dev        # nodemon server.js
```

No build step. Pure compute logic lives in `compute.js` and is unit-testable without the DB.

⚠️ **Dev local & Node version:** `better-sqlite3` ships prebuilt binaries for Node LTS (18/20/22). On bleeding-edge Node (e.g. 25) there's no prebuild → `npm install` tries to compile (needs Visual Studio build tools on Windows). For local dev use **Node 20 LTS**, or rely on Docker (`node:20-slim`).

## Architecture

```
energie-dashboard/
  server.js     # Express: serves frontend + read endpoints (reads SQLite, computes values) + /api/weather (live HA)
  poller.js     # Background loop: polls HA every 30s → SQLite ; backfills HA history on boot
  db.js         # SQLite access (better-sqlite3): schema, read/write, retention
  compute.js    # Pure calc helpers (deltas, cumulative, downsampling) — no native dep, testable
  sensors.js    # Single source of truth for all HA entity IDs (used by poller + server)
  public/
    index.html  # Single-page dashboard (French UI) — Énergie + Eau tabs
    script.js   # Display layer: fetches computed values + live weather, renders Chart.js + DOM
    style.css   # Glassmorphism dark theme
```

**Data flow:** `poller.js` reads HA every 30s and writes raw `(entity_id, ts, value)` rows to SQLite. The server endpoints read that continuous series and compute period deltas/curves **server-side** at full resolution. The frontend reads those computed scalars + downsampled chart series; it no longer computes deltas. The HA token never reaches the browser, and the dashboard stays up if HA is down (serves last stored data).

**Why a DB:** recomputing from HA's live history every refresh caused inconsistencies (variable history windows, recorder purge on 7j/30j, partial fetches, midnight-reset edge cases). Owning a continuous local series removes those root causes.

**Endpoints:**
- `GET /api/all-energy-data?period=X` (reads DB) → `{ main:{currentPower,currentSolarPower}, period:{hp,hc,surplus,production,peakPower}, prev:{hp,hc,production,surplus}, devices:[{name,energy,power}], history:{timestamps,consumption,production,power} }`. `period.*` are accurate scalars; `history.*` are downsampled (150 pts) for charts; `prev` is the previous same-length period for comparison badges.
- `GET /api/water-data?period=X` (reads DB) → `{ liters, history:{timestamps,liters} }`
- `GET /api/weather` (live HA passthrough) → Pirate Weather state + sun.sun rise/set hours
- `GET /api/status` → `{ ok, readings, db }` (debug)
- `period` ∈ `hour|day|week|month`.

**Configuration:** `HA_URL` and `HA_TOKEN` are required env vars — no hardcoded fallback; `server.js` exits if missing. Other env: `DB_PATH` (default `/data/energie.db`), `POLL_INTERVAL_MS` (30000), `RETENTION_DAYS` (365), `BACKFILL_DAYS` (30), `WEATHER_ENTITY` (`weather.pirateweather`). `public/script.js` holds `HA_CONFIG` with pricing only:
```js
const HA_CONFIG = {
    priceHP: 0.1876,    // €/kWh heures pleines
    priceHC: 0.1456,    // €/kWh heures creuses
    priceSurplus: 0.13, // €/kWh vendu au réseau
    priceWater: 4.82    // €/m³
};
```

## Key details

- Home Assistant at `http://<HA_HOST>:8123` (adresse LAN à remplacer) ; server listens on `0.0.0.0:3000`
- Charts use Chart.js 4.4 + luxon adapter (loaded from CDN)
- Auto-refresh: configurable interval (10s/30s/1min/5min) with enable/disable toggle. **Note:** display refresh ≠ data freshness — data is only as fresh as the last poll (≤30s).
- Numbers formatted with French locale (comma as decimal separator)
- `window.HADashboard` is exposed on the global for browser-console debugging

## Sensors (`sensors.js` — single source of truth)

```
MAIN.hp           = sensor.ecojoko_consommation_hp_reseau          (kWh import HP, reset minuit)
MAIN.hc           = sensor.ecojoko_consommation_hc_reseau          (kWh import HC, reset minuit)
MAIN.surplus      = sensor.surplus_de_production_positif           (kWh injecté réseau, POSITIF, reset minuit)
MAIN.production   = sensor.envoy_122303081421_production_d_energie_du_jour  (kWh prod solaire, reset minuit)
MAIN.currentPower = sensor.ecojoko_consommation_temps_reel         (W instantané, PAS de reset, négatif = export)
MAIN.solarPower   = sensor.envoy_122303081421_current_power_production  (W prod solaire instantanée, flux solaire)
WATER             = sensor.consommation_eau_totale                 (litres, reset minuit)
DEVICES           = 10 prises (sensor.prise_* / garage_prise_*), chacune _energy + _power
```

Ajouter/retirer un capteur = éditer `sensors.js` uniquement (poller + serveur le partagent). L'ordre de `DEVICES` doit correspondre à l'ordre des icônes dans `SENSORS.devices` (script.js).

### Sensor gotchas

- **Tous les compteurs d'énergie se remettent à zéro à minuit** (HP, HC, surplus, production, eau, prises) → deltas via `deltaWithResets()` (somme des segments entre resets ; = `last − first` si monotone, donc sûr partout).
- **`MAIN.currentPower`** (W) n'a pas de reset, peut être négatif lors d'export → stocké/affiché brut (négatif = export), on ne clippe PAS.
- **Le surplus est déjà positif** (`sensor.surplus_de_production_positif`) → plus de bricolage en valeur absolue.
- **On n'utilise plus le net Enphase** (`lifetime_net_energy_consumption`, MWh, import−export) — source d'incohérences. La conso maison est dérivée de HP/HC/prod/surplus.
- **Recorder purge HA** : n'impacte plus que le *backfill initial* (≈30 derniers jours dispo dans HA). Ensuite la série locale grossit en continu et n'est purgée qu'après `RETENTION_DAYS` → 7j/30j fiables sans toucher HA.

## Compute helpers (`compute.js`, pure & testées)

```js
sanitize(rows)                     // retire les pics isolés corrompus (anti-spike)
deltaWithResets(rows)              // somme reset-aware (= last-first si monotone)
peak(rows)                         // max d'un capteur instantané
buildCumulative(rows)              // cumul reset-aware point par point [{ts,cum}]
cumulativeAtEdges(rows, edges)     // échantillonne le cumul aux bornes de temps
instantAtEdges(rows, edges)        // moyenne d'un capteur instantané par bucket
makeEdges(since, until, points)    // génère N bornes de temps régulières
```
`rows` = `[{ts, value}]` triés par `ts` croissant (epoch secondes). `db.js` réexporte ces helpers.

⚠️ **Anti-spike :** le backfill HA peut contenir des valeurs aberrantes ponctuelles (ex: un point à 27008 kWh au milieu de journées à ~50). `sanitize()` retire un point isolé absurdement plus haut que ses deux voisins (montée puis redescente immédiate), sans toucher aux montées légitimes ni aux pics réels avant reset. **Appliqué à tous les compteurs d'énergie/eau** avant tout calcul de delta dans `server.js`. Endpoint de diagnostic dispo : `GET /api/debug/series?entity=<id>&period=month`.

## Auto-consumption & self-sufficiency

Calculé à partir de production/surplus (pas de comparaison Enphase/Ecojoko qui dérive). Le serveur renvoie les kWh bruts ; le frontend dérive `selfConsumed`, les % et les coûts :

```
selfConsumed       = max(0, production − surplus_injecté)
consoMaison        = HP + HC + selfConsumed
auto-consommation  = selfConsumed / production × 100              (% de la prod utilisée localement)
autosuffisance     = selfConsumed / (HP + HC + selfConsumed) × 100  (% de la conso couverte par solaire)
```

### Surplus

Lu depuis `sensor.surplus_de_production_positif` (déjà positif, reset minuit) via `deltaWithResets()` sur la série SQLite → delta correct sur toutes les périodes.

## UI layout (Énergie tab)

**Widget météo (haut):** Conditions Pirate Weather depuis HA — icône, temp, ressenti, vent, humidité, indice UV

**Stat cards (top):** Puissance Actuelle | Réseau HP+HC + coût + badge comparaison | Production + revente + badge comparaison | Conso. Maison

**Charts:** Consommation & Production (line) | Puissance Instantanée (line) | Mix Énergétique (donut HP/HC/Solaire)

**Top Consommateurs:** énergie kWh + puissance W live par appareil — bouton export CSV

**Detail cards (bottom):** Heures Pleines | Heures Creuses | Pic de Puissance | Auto-consommation | Autosuffisance | Bilan Net € | CO₂ Évité

### Puissance Actuelle card
- Affiche la valeur absolue du capteur `ecojoko_consommation_temps_reel`
- Badge vert `↑ export` visible quand la valeur est négative (export solaire vers le réseau)
- La carte passe en thème vert (`.exporting`) en mode export

### Conso. Maison
- Calculé comme `HP + HC + selfConsumed` (selfConsumed = production − surplus injecté)
- **Ne pas utiliser** le net Enphase (`lifetime_net_energy_consumption`) pour cette valeur — il mesure import−export et peut être négatif ou sous-estimer la conso réelle lors d'export important

### Bilan Net
- `revente surplus − coût réseau (HP+HC)` — vert si positif, rouge si négatif

### CO₂ Évité
- `production (kWh) × 0,057 kg/kWh` (facteur moyen réseau français, source ADEME 2023)

### Comparaison période précédente
- Badges `↑/↓ X% vs préc.` sur les cartes HP+HC et Production
- Le serveur calcule les deltas de la période précédente (même durée, décalée) dans `/api/all-energy-data` et les retourne dans `prev: { hp, hc, production, surplus }`

### Mix Énergétique (donut)
- Affiche la composition de la consommation maison : Réseau HP / Réseau HC / Solaire autoconsommé
- Mis à jour à chaque refresh via `updateMixChart()`

### Widget Météo
- Entité HA : `weather.pirateweather` (configurable via `WEATHER_ENTITY` dans `.env`)
- Rafraîchi toutes les 10 minutes, indépendamment du refresh énergie
- Affiche : condition, température, ressenti, vent, humidité, barre indice UV
- Mapping conditions HA → emoji dans `haConditionToInfo()` (script.js)

### Export CSV
- Bouton `⬇ CSV` dans la section Top Consommateurs
- Exporte : résumé période (HP, HC, production, surplus, conso maison, coût, revente, CO₂) + tableau appareils
- Encodage UTF-8 avec BOM pour Excel

## Deployment (Production)

### Infrastructure
- **Git:** GitHub → `https://github.com/Anthanaab/Energie-dashboard.git` (branch: `master`)
- **Docker host:** `<DOCKER_HOST_IP>` managed via Portainer → `https://<DOCKER_HOST_IP>:9443`
- **Stack name:** `energie-dashboard` — deployed via Portainer Repository mode
- **URL prod:** `http://<DOCKER_HOST_IP>:3000`

### Config Docker
- Image `node:20-slim` (Debian/glibc) — requis pour `better-sqlite3` (module natif). Le Dockerfile installe `python3 make g++` au cas où aucun prebuild ne correspond.
- `docker-compose.yml` utilise `${HA_URL}` et `${HA_TOKEN}` (sans fallback) → à saisir dans **Portainer → Stacks → energie-dashboard → Environment variables**
- `server.js` plante au démarrage si l'une des deux variables est absente ; le token ne doit jamais être committé
- **Volume nommé `energie-data` monté sur `/data`** → persiste la base SQLite entre les redeploys. ⚠️ Ne pas supprimer ce volume (perte de l'historique accumulé).
- Autres env (défauts dans `docker-compose.yml`) : `DB_PATH=/data/energie.db`, `POLL_INTERVAL_MS=30000`, `RETENTION_DAYS=365`

### Développement local (sans Docker)
Créer un fichier `.env` à la racine (déjà dans `.gitignore`), voir `.env.example` :
```
HA_URL=http://<HA_HOST>:8123
HA_TOKEN=<ton token>
WEATHER_ENTITY=weather.pirateweather   # optionnel, c'est le défaut
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
