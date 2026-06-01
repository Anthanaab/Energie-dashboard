// ===== Module base de données (SQLite via better-sqlite3) =====
// Stocke des relevés bruts (entity_id, ts, value) et fournit les helpers
// de calcul de deltas / séries pour les graphiques.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const compute = require('./compute');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'energie.db');

// S'assurer que le dossier existe
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // meilleures perfs en lecture/écriture concurrente
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    entity_id TEXT NOT NULL,
    ts        INTEGER NOT NULL,   -- epoch (secondes)
    value     REAL,
    PRIMARY KEY (entity_id, ts)
  );
  CREATE INDEX IF NOT EXISTS idx_readings_entity_ts ON readings(entity_id, ts);
`);

// ===== Écriture =====
const _insert = db.prepare(
  'INSERT OR IGNORE INTO readings (entity_id, ts, value) VALUES (?, ?, ?)'
);

// Insère un lot de relevés [{entity_id, ts, value}] dans une transaction
const insertReadings = db.transaction((rows) => {
  for (const r of rows) {
    if (r.value === null || r.value === undefined || Number.isNaN(r.value)) continue;
    _insert.run(r.entity_id, r.ts, r.value);
  }
});

// ===== Lecture =====
const _selectRange = db.prepare(
  'SELECT ts, value FROM readings WHERE entity_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC'
);
const getReadings = (entityId, sinceTs, untilTs) =>
  _selectRange.all(entityId, sinceTs, untilTs);

const _selectLatest = db.prepare(
  'SELECT ts, value FROM readings WHERE entity_id = ? ORDER BY ts DESC LIMIT 1'
);
const getLatest = (entityId) => {
  const row = _selectLatest.get(entityId);
  return row ? row.value : null;
};

// Plus ancien ts connu pour un capteur (sert au backfill conditionnel)
const _selectOldest = db.prepare(
  'SELECT ts FROM readings WHERE entity_id = ? ORDER BY ts ASC LIMIT 1'
);
const getOldestTs = (entityId) => {
  const row = _selectOldest.get(entityId);
  return row ? row.ts : null;
};

const _count = db.prepare('SELECT COUNT(*) AS n FROM readings');
const count = () => _count.get().n;

// ===== Rétention =====
const _purge = db.prepare('DELETE FROM readings WHERE ts < ?');
const purgeBefore = (beforeTs) => _purge.run(beforeTs).changes;

module.exports = {
  db,
  insertReadings,
  getReadings,
  getLatest,
  getOldestTs,
  count,
  purgeBefore,
  // Helpers de calcul (réexportés depuis compute.js, sans dépendance native)
  ...compute,
  DB_PATH,
};
