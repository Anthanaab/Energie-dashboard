// ===== Poller Home Assistant → SQLite =====
// - Au démarrage : backfill de l'historique HA encore disponible (avant purge recorder)
// - Puis collecte régulière (POLL_INTERVAL_MS) de l'état courant de tous les capteurs
// Si un appel HA échoue, on saute (aucune écriture de 0/null → pas de faux trous).

const db = require('./db');
const { ALL_ENTITIES } = require('./sensors');

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '365', 10);
const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || '30', 10);

const nowSec = () => Math.floor(Date.now() / 1000);
const toLocalISO = (date) => {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
};

// ===== Collecte instantanée =====
const pollOnce = async (haClient) => {
  const ts = nowSec();
  const rows = [];
  const results = await Promise.allSettled(
    ALL_ENTITIES.map(id => haClient.get(`/states/${id}`))
  );
  results.forEach((r, idx) => {
    if (r.status !== 'fulfilled' || !r.value?.data) return;       // skip si échec
    const v = parseFloat(r.value.data.state);
    if (Number.isNaN(v)) return;                                  // skip 'unavailable'/'unknown'
    rows.push({ entity_id: ALL_ENTITIES[idx], ts, value: v });
  });
  if (rows.length) db.insertReadings(rows);
  return rows.length;
};

// ===== Backfill historique (au premier démarrage) =====
const backfill = async (haClient) => {
  const now = new Date();
  const start = new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const startISO = toLocalISO(start);
  const endISO = toLocalISO(now);

  let totalInserted = 0;
  for (const id of ALL_ENTITIES) {
    // Ne backfill que si on n'a pas déjà des données anciennes pour ce capteur
    const oldest = db.getOldestTs(id);
    if (oldest !== null && oldest <= Math.floor(start.getTime() / 1000) + 3600) continue;

    try {
      const resp = await haClient.get(`/history/period/${startISO}`, {
        params: { filter_entity_id: id, end_time: endISO },
      });
      const series = resp.data?.[0] || [];
      const rows = [];
      for (const point of series) {
        const v = parseFloat(point.state);
        if (Number.isNaN(v)) continue;
        const ts = Math.floor(new Date(point.last_changed).getTime() / 1000);
        rows.push({ entity_id: id, ts, value: v });
      }
      if (rows.length) { db.insertReadings(rows); totalInserted += rows.length; }
    } catch (err) {
      console.error(`[backfill] ${id}: ${err.message}`);
    }
  }
  console.log(`[backfill] ${totalInserted} relevés importés depuis HA`);
};

// ===== Rétention =====
const purge = () => {
  const before = nowSec() - RETENTION_DAYS * 24 * 60 * 60;
  const deleted = db.purgeBefore(before);
  if (deleted) console.log(`[purge] ${deleted} relevés supprimés (> ${RETENTION_DAYS}j)`);
};

// ===== Démarrage =====
let pollTimer = null;
let purgeTimer = null;

const start = async (haClient) => {
  console.log(`[poller] base : ${db.DB_PATH} (${db.count()} relevés existants)`);

  // Backfill au boot (non bloquant pour le serveur, mais on l'attend ici)
  try {
    await backfill(haClient);
  } catch (err) {
    console.error('[backfill] échec global :', err.message);
  }

  // Premier poll immédiat puis boucle
  const tick = async () => {
    try {
      const n = await pollOnce(haClient);
      if (n === 0) console.warn('[poll] aucun capteur lu (HA injoignable ?)');
    } catch (err) {
      console.error('[poll] erreur :', err.message);
    }
  };
  await tick();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);

  // Purge quotidienne
  purge();
  purgeTimer = setInterval(purge, 24 * 60 * 60 * 1000);

  console.log(`[poller] démarré (intervalle ${POLL_INTERVAL_MS / 1000}s, rétention ${RETENTION_DAYS}j)`);
};

const stop = () => {
  if (pollTimer) clearInterval(pollTimer);
  if (purgeTimer) clearInterval(purgeTimer);
};

module.exports = { start, stop, pollOnce, backfill };
