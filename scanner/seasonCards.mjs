// Builds small per-player season stat shards from each season's season.json.gz, so the Discord bot never has to
// download or analyze the big file. Output (on the orphan 'season-cards' branch):
//   <seasonStartDate>/<first 2 chars of tag>.json   { season, days, lengthDays, generatedAt, players: { TAG: {...} } }
//   index.json                                      { keys: [...], updated }
// Runs the current and the previous season. Skips a season whose source file hasn't changed since the last run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REPO = process.env.GITHUB_REPOSITORY || 'somebody-is-da-goat-6967/coc-leaderboard';
const RAW = process.env.RAW_BASE || `https://raw.githubusercontent.com/${REPO}`; // RAW_BASE only for local testing
const OUT = process.env.OUT_DIR || 'cards-out';
const SEASON_ANCHOR = Date.parse('2026-10-05T05:00:00Z'); // keep in sync with legend.js CONFIG and scanner/archive.mjs
const SEASON_DAYS = 28, DAY = 864e5;
const MIN_RATE_ATTACKS = 8; // percentiles for rates / averages need at least this many attacks (defenses)

const normTag = (t) => String(t || '').replace(/^#/, '').toUpperCase();
const seasonKeys = (now = Date.now()) => {
  const cur = Math.floor((now - SEASON_ANCHOR) / (SEASON_DAYS * DAY));
  return [cur, cur - 1].filter((i) => i >= 0).map((i) => new Date(SEASON_ANCHOR + i * SEASON_DAYS * DAY).toISOString().slice(0, 10));
};

async function fetchBuf(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${url}?t=${Date.now()}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === 2) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
}

// ---- percentiles with sorted arrays (O(n log n) instead of O(n^2)) ----
const lowerBound = (a, v) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; };
const upperBound = (a, v) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; } return lo; };
function pctile(sorted) { // "Top X%": share of players doing better than `mine`
  const n = sorted.length;
  return (mine, higher = true) => {
    if (!n || !Number.isFinite(mine)) return null;
    const better = higher ? n - upperBound(sorted, mine) : lowerBound(sorted, mine);
    return Math.max(1, Math.ceil((100 * (better + 1)) / n));
  };
}
const sortedOf = (rows, val, ok = () => true) => rows.filter(ok).map(val).filter(Number.isFinite).sort((a, b) => a - b);

function buildShards(agg) {
  const entries = Object.entries(agg.players || {}).filter(([, p]) => p.na || p.nd);
  const rows = entries.map(([, p]) => p);
  const pNet = pctile(sortedOf(rows, (x) => x.a - x.d));
  const pOff = pctile(sortedOf(rows, (x) => x.a));
  const pRate = pctile(sortedOf(rows, (x) => x.s3 / x.na, (x) => x.na >= MIN_RATE_ATTACKS));
  const pAvgA = pctile(sortedOf(rows, (x) => x.a / x.na, (x) => x.na >= MIN_RATE_ATTACKS));
  const pAvgD = pctile(sortedOf(rows, (x) => x.d / x.nd, (x) => x.nd >= MIN_RATE_ATTACKS));
  const shards = new Map();
  for (const [rawTag, p] of entries) {
    const tag = normTag(rawTag);
    // most-used army of the season (raw army link) so the bot can show it later; stays small
    let best = null, bci = -1;
    for (const [ci, v] of Object.entries(p.arm || {})) if (!best || v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) { best = v; bci = +ci; }
    const code = best && agg.codes ? agg.codes[bci] : null;
    const rec = {
      n: p.n || 'Unknown', r: p.r || 0, r0: p.r0 || 0,
      a: p.a, d: p.d, na: p.na, nd: p.nd, s3: p.s3, dz: p.dz || 0, dy: p.dy || 0, pf: p.pf || 0, fu: p.fu || 0, st: p.st || 0,
      pc: [
        pNet(p.a - p.d),
        pOff(p.a),
        p.na >= MIN_RATE_ATTACKS ? pRate(p.s3 / p.na) : null,
        p.na >= MIN_RATE_ATTACKS ? pAvgA(p.a / p.na) : null,
        p.nd >= MIN_RATE_ATTACKS ? pAvgD(p.d / p.nd, false) : null,
      ], // top-% for: net, offense, 3-star rate, avg attack, avg defense (lower is better)
      fav: code ? [code, best[0], best[1], best[2]] : null, // [army link, attacks, stars, triples]
    };
    const key = tag.slice(0, 2).padEnd(2, '_');
    if (!shards.has(key)) shards.set(key, {});
    shards.get(key)[tag] = rec;
  }
  return { shards, count: entries.length };
}

const sigOf = (agg) => `${agg.generatedAt ?? ''}|${(agg.days || []).length}|${Object.keys(agg.players || {}).length}`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const keys = seasonKeys(), built = [];
  let changed = false;
  for (const key of keys) {
    const dir = path.join(OUT, key), metaFile = path.join(dir, 'meta.json');
    const buf = await fetchBuf(`${RAW}/archive-s${key}/season.json.gz`);
    if (!buf) { console.log(`season ${key}: no season.json.gz yet, skipping`); continue; }
    const agg = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
    const sig = sigOf(agg);
    let old = null; try { old = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* first run */ }
    built.push(key);
    if (old && old.sig === sig) { console.log(`season ${key}: unchanged (${sig})`); continue; }
    const { shards, count } = buildShards(agg);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const head = { season: agg.season, days: (agg.days || []).length, lengthDays: agg.lengthDays || SEASON_DAYS, generatedAt: agg.generatedAt || null, players: undefined };
    for (const [k, players] of shards) fs.writeFileSync(path.join(dir, `${k}.json`), JSON.stringify({ ...head, players }));
    fs.writeFileSync(metaFile, JSON.stringify({ sig, season: agg.season, days: head.days, lengthDays: head.lengthDays, generatedAt: head.generatedAt, players: count, shards: shards.size, built: new Date().toISOString() }));
    console.log(`season ${key}: ${count} players in ${shards.size} shards`);
    changed = true;
  }
  // drop seasons that are no longer current/previous
  for (const d of fs.readdirSync(OUT)) {
    if (/^\d{4}-\d\d-\d\d$/.test(d) && !keys.includes(d)) { fs.rmSync(path.join(OUT, d), { recursive: true, force: true }); changed = true; console.log(`removed old season ${d}`); }
  }
  if (changed) fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ keys: built, updated: new Date().toISOString() }));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  console.log(changed ? 'done: changes written' : 'done: nothing to publish');
}
main().catch((e) => { console.error(e); process.exit(1); });
