// ===== Fonctions de calcul pures (aucune dépendance externe) =====
// Opèrent sur des tableaux de relevés [{ts, value}] triés par ts croissant.
// Isolées ici pour être testables sans le module natif SQLite.

// Somme reset-aware : pour un compteur qui peut se remettre à zéro (reset
// journalier à minuit), additionne les segments. Pour un compteur monotone
// (jamais de reset), équivaut à last - first.
const deltaWithResets = (rows) => {
  const vals = rows.map(r => r.value).filter(v => v !== null && !Number.isNaN(v));
  if (vals.length < 2) return 0;
  let total = 0;
  let segStart = vals[0];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] < vals[i - 1]) {       // reset détecté
      total += vals[i - 1] - segStart;
      segStart = vals[i];
    }
  }
  return Math.max(0, total + vals[vals.length - 1] - segStart);
};

// Pic (max) d'un capteur instantané sur la plage
const peak = (rows) => {
  const vals = rows.map(r => r.value).filter(v => v !== null && !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : 0;
};

// Construit le cumul reset-aware point par point : renvoie [{ts, cum}]
const buildCumulative = (rows) => {
  const out = [];
  let total = 0;
  let segStart = null;
  let prev = null;
  for (const r of rows) {
    const v = r.value;
    if (v === null || Number.isNaN(v)) continue;
    if (segStart === null) { segStart = v; prev = v; out.push({ ts: r.ts, cum: 0 }); continue; }
    if (v < prev) { total += prev - segStart; segStart = v; }   // reset
    out.push({ ts: r.ts, cum: total + v - segStart });
    prev = v;
  }
  return out;
};

// Échantillonne le cumul aux bornes `edges` (epoch sec) : dernière valeur ≤ edge
const cumulativeAtEdges = (rows, edges) => {
  const cum = buildCumulative(rows);
  const result = new Array(edges.length).fill(0);
  let i = 0;
  let last = 0;
  for (let e = 0; e < edges.length; e++) {
    while (i < cum.length && cum[i].ts <= edges[e]) { last = cum[i].cum; i++; }
    result[e] = last;
  }
  return result;
};

// Échantillonne un capteur instantané aux bornes : moyenne des points du bucket.
// Les `rows` étant triés et `edges` croissants, chaque point est consommé une
// seule fois, rangé dans le premier bucket dont la borne haute le couvre.
const instantAtEdges = (rows, edges) => {
  const result = new Array(edges.length).fill(null);
  let i = 0;
  for (let e = 0; e < edges.length; e++) {
    const hi = edges[e];
    let sum = 0, n = 0;
    while (i < rows.length && rows[i].ts <= hi) {
      const v = rows[i].value;
      if (v !== null && !Number.isNaN(v)) { sum += v; n++; }
      i++;
    }
    result[e] = n > 0 ? sum / n : null;
  }
  return result;
};

// Génère `points` bornes de temps régulières entre since et until (epoch sec)
const makeEdges = (since, until, points) => {
  const edges = [];
  const step = (until - since) / points;
  for (let k = 1; k <= points; k++) edges.push(Math.round(since + step * k));
  return edges;
};

module.exports = {
  deltaWithResets,
  peak,
  buildCumulative,
  cumulativeAtEdges,
  instantAtEdges,
  makeEdges,
};
