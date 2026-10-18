// ===== Configuration des capteurs, surchargeable au runtime =====
// - Valeurs par défaut : sensors.js (source de vérité committée)
// - Surcharge persistante : /data/sensors-config.json (écrit par le menu
//   "Réglages", dans le volume /data => persiste et modifiable sans redéploiement)
// Les appels de lecture (getConfig/getAllEntities) sont résolus à chaque
// utilisation : le poller intègre toute modification au poll suivant.

const fs = require('fs');
const path = require('path');

const defaults = require('./sensors');

const DB_DIR = path.dirname(process.env.DB_PATH || '/data/energie.db');
const CONFIG_PATH = process.env.SENSORS_CONFIG_PATH || path.join(DB_DIR, 'sensors-config.json');

// Normalise une prise : {energy, power, name, icon}
const normalize = (dev) => {
  if (Array.isArray(dev)) {
    return { energy: dev[0], power: dev[1], name: dev[2], icon: dev[3] || '🔌' };
  }
  return {
    energy: dev.energy,
    power: dev.power,
    name: dev.name,
    icon: dev.icon || '🔌',
  };
};

const defaultsConfig = () => ({
  main: { ...defaults.MAIN },
  water: { ...defaults.WATER },
  devices: defaults.DEVICES.map(normalize),
});

let cache = null;

const load = () => {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const d = defaultsConfig();
    cache = {
      main: { ...d.main, ...(j.main || {}) },
      water: { ...d.water, ...(j.water || {}) },
      devices: Array.isArray(j.devices) ? j.devices.map(normalize) : d.devices,
    };
  } catch (_) {
    cache = defaultsConfig();
  }
  return cache;
};

const reload = () => { cache = null; return load(); };

const getConfig = () => load();
const getMain = () => load().main;
const getWater = () => load().water;
const getDevices = () => load().devices;

const getAllEntities = () => {
  const c = load();
  const ids = Object.values(c.main).concat(Object.values(c.water));
  for (const d of c.devices) {
    ids.push(d.energy, d.power);
    if (d.energy === d.power) ids.pop(); // évite un doublon si même entité
  }
  return ids;
};

const saveConfig = (ctx) => {
  const d = defaultsConfig();
  const merged = {
    main: { ...d.main, ...((ctx && ctx.main) || {}) },
    water: { ...d.water, ...((ctx && ctx.water) || {}) },
    devices: Array.isArray(ctx && ctx.devices) ? ctx.devices.map(normalize) : d.devices,
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  cache = merged;
  return merged;
};

const resetConfig = () => {
  try { if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH); } catch (_) {}
  cache = null;
  return load();
};

module.exports = {
  getConfig,
  getMain,
  getWater,
  getDevices,
  getAllEntities,
  saveConfig,
  resetConfig,
  reload,
  CONFIG_PATH,
};