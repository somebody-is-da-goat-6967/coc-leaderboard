// Builds small per-player season stat shards so the Discord bot never has to download or analyze the big files.
//
// Inputs (all public, read over raw.githubusercontent.com):
//   archive-s<key>/season.json.gz        season totals per player (scanner/Seasonagg.mjs)
//   archive-s<key>/days/<date>.json.gz   one battlelog file per finished Legend Day  -> per-day offense / defense
//   data/eod/<date>.json.gz              end-of-day leaderboard                       -> per-day rank
//   army.js / armyids.js / season.js     the website's own code, loaded here so army + strategy names match the site
//
// Output (orphan 'season-cards' branch):
//   <key>/<XX>.json         shard per first 2 chars of the tag: { season, days, dayList, generatedAt, players: { TAG: {...} } }
//   <key>/hist/<date>.json.gz   per-day history, kept so each day is only downloaded once   { TAG: [rank, off, def, na, nd] }
//   <key>/meta.json, index.json
//
// Player record:  n name, r/r0 last/first eod rank, a/d trophies, na/nd attacks/defenses, s3, dz, dy, pf, fu, st,
//   pc  [top% net, offense, 3-star rate, avg attack, avg defense],
//   h   per finished day: [rank, off, def, na, nd] or null,
//   fav { s strategy, n/st/s3 attacks/stars/triples with it, atk attacks with an army link, tr [[icon, count]...], hr [[hero, icon]...] }
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';

const REPO = process.env.GITHUB_REPOSITORY || 'somebody-is-da-goat-6967/coc-leaderboard';
const RAW = process.env.RAW_BASE || `https://raw.githubusercontent.com/${REPO}`; // RAW_BASE only for local testing
const OUT = process.env.OUT_DIR || 'cards-out';
const SEASON_ANCHOR = Date.parse('2026-10-05T05:00:00Z'); // keep in sync with legend.js CONFIG and scanner/archive.mjs
const SEASON_DAYS = 28, DAY = 864e5;
const MIN_RATE_ATTACKS = 8;   // percentiles for rates / averages need at least this many attacks (defenses)
const SCHEMA = 3;             // rebuild shards after validating all per-day battle history
const T0 = Date.now(), BUDGET_MS = (+process.env.TIME_BUDGET_MIN || 25) * 60000; // stop downloading new days after this; next run continues
const CK_BASE = 'https://assets.clashk.ing/';

const normTag = (t) => String(t || '').replace(/^#/, '').toUpperCase();
const seasonKeys = (now = Date.now()) => {
  const cur = Math.floor((now - SEASON_ANCHOR) / (SEASON_DAYS * DAY));
  return [cur, cur - 1].filter((i) => i >= 0).map((i) => new Date(SEASON_ANCHOR + i * SEASON_DAYS * DAY).toISOString().slice(0, 10));
};
// same scale as the website (legend.js trophyGain) and scanner/Seasonagg.mjs
function trophyGain(stars, pct) {
  pct = Math.floor(pct || 0);
  if (stars >= 3) return 40;
  if (stars === 2) return Math.min(32, Math.max(16, 16 + Math.floor((pct - 50) / 3)));
  if (stars === 1) return Math.min(15, Math.max(5, 5 + Math.floor((pct - 1) / 9)));
  return Math.floor(pct / 10);
}
const gunzipMaybe = (buf) => (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
const readGz = (file) => { try { return JSON.parse(gunzipMaybe(fs.readFileSync(file))); } catch { return null; } };
const writeGz = (file, data) => fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(data), { level: 9 }));

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

// ---------- the website's army code (armyids.js, army.js, season.js) ----------
function findFile(names, root = process.cwd(), depth = 4) {
  const want = names.map((n) => n.toLowerCase());
  const skip = new Set(['node_modules', '.git', 'cards-out', 'data-out']);
  const walk = (dir, d) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const n of want) for (const e of ents) if (e.isFile() && e.name.toLowerCase() === n) return path.join(dir, e.name);
    if (d <= 0) return null;
    for (const e of ents) if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) { const f = walk(path.join(dir, e.name), d - 1); if (f) return f; }
    return null;
  };
  return walk(root, depth);
}
function loadSite() {
  const files = [findFile(['armyids.js']), findFile(['army.js']), findFile(['season.js', 'stats.js'])];
  if (files.some((f) => !f)) { console.warn('site army code not found (armyids.js / army.js / season.js); favourite army + heroes are skipped'); return null; }
  const noop = () => {};
  const el = () => ({ style: {}, append: noop, setAttribute: noop, classList: { toggle: noop, add: noop } });
  const sandbox = { console, document: { addEventListener: noop, getElementById: () => null, createElement: el, body: { append: noop }, documentElement: {} },
    location: { search: '', host: '', protocol: 'https:' }, sessionStorage: { getItem: () => null, setItem: noop }, innerWidth: 1000 };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  try {
    for (const f of files) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
    const api = vm.runInContext('({ infoOf, mainTroops, heroIconUrl, ARMY_IDS })', ctx);
    console.log(`site army code loaded from ${files.join(', ')}`);
    return api;
  } catch (e) { console.warn('could not load the site army code:', e.message); return null; }
}
const stripBase = (u) => String(u || '').replace(CK_BASE, '');

// Favourite strategy, top heroes and main troops for one player (same logic as season.js playerData).
function favOf(p, codes, site) {
  const strat = new Map(), hero = new Map(); let atk = 0;
  for (const [ci, v] of Object.entries(p.arm || {})) {
    const code = codes[+ci]; if (!code) continue;
    let inf; try { inf = site.infoOf(code); } catch { continue; }
    atk += v[0];
    const name = inf.cls.strategy;
    let s = strat.get(name); if (!s) strat.set(name, (s = { name, n: 0, st: 0, s3: 0, codes: new Map() }));
    s.n += v[0]; s.st += v[1]; s.s3 += v[2]; s.codes.set(code, (s.codes.get(code) || 0) + v[0]);
    for (const h of new Set(inf.heroes.map((x) => x.name))) { let x = hero.get(h); if (!x) hero.set(h, (x = { n: 0 })); x.n += v[0]; }
  }
  const top = [...strat.values()].sort((a, b) => b.n - a.n)[0];
  if (!top) return null;
  let bestCode = '', bn = -1; for (const [c, n] of top.codes) if (n > bn) { bestCode = c; bn = n; }
  let troops = []; try { troops = site.mainTroops(bestCode, 6).map(([id, n]) => [stripBase((site.ARMY_IDS.troop[id] || [])[1]), n]); } catch { /* no icons */ }
  const heroes = [...hero].sort((a, b) => b[1].n - a[1].n).slice(0, 4).map(([n]) => [n, stripBase(site.heroIconUrl(n))]);
  return { s: top.name, n: top.n, st: top.st, s3: top.s3, atk, tr: troops, hr: heroes };
}

// ---------- per-day history (each finished day is downloaded once, then kept in <key>/hist) ----------
async function buildDayHist(key, date) {
  const dayBuf = await fetchBuf(`${RAW}/archive-s${key}/days/${date}.json.gz`);
  if (!dayBuf) { console.warn(`  day ${date}: no day file`); return null; }
  const day = JSON.parse(gunzipMaybe(dayBuf));
  let ranks = null;
  try {
    const eb = await fetchBuf(`${RAW}/data/eod/${date}.json.gz`);
    if (eb) ranks = new Map(((JSON.parse(gunzipMaybe(eb)).players) || []).map((p, i) => [normTag(p.tag), p.rank || i + 1]));
  } catch (e) { console.warn(`  day ${date}: eod ranks unavailable (${e.message})`); }
  if (!ranks) console.warn(`  day ${date}: no end-of-day ranks, rank chart will have a gap`);
  const ts = (r) => Date.parse(r.time), out = {};
  for (const [rawTag, e] of Object.entries(day.players || {})) {
    const at = [...(e.attacks || [])].sort((a, b) => ts(a) - ts(b)).slice(0, 8);
    const df = [...(e.defenses || [])].sort((a, b) => ts(a) - ts(b)).slice(0, 8);
    if (!at.length && !df.length) continue;
    const tag = normTag(rawTag);
    out[tag] = [(ranks && ranks.get(tag)) || 0, at.reduce((s, h) => s + trophyGain(h.stars, h.destruction), 0), df.reduce((s, h) => s + trophyGain(h.stars, h.destruction), 0), at.length, df.length];
  }
  return out;
}

function historyCounts(history) {
  return Object.values(history || {}).reduce((sum, row) => {
    if (Array.isArray(row)) { sum.att += +row[3] || 0; sum.def += +row[4] || 0; }
    return sum;
  }, { att: 0, def: 0 });
}

// ---------- percentiles with sorted arrays ----------
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

function buildShards(agg, hists, site) {
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
    const rec = {
      n: p.n || 'Unknown', r: p.r || 0, r0: p.r0 || 0,
      a: p.a, d: p.d, na: p.na, nd: p.nd, s3: p.s3, dz: p.dz || 0, dy: p.dy || 0, pf: p.pf || 0, fu: p.fu || 0, st: p.st || 0,
      pc: [pNet(p.a - p.d), pOff(p.a), p.na >= MIN_RATE_ATTACKS ? pRate(p.s3 / p.na) : null, p.na >= MIN_RATE_ATTACKS ? pAvgA(p.a / p.na) : null,
        p.nd >= MIN_RATE_ATTACKS ? pAvgD(p.d / p.nd, false) : null],
      h: hists.map((h) => (h && h[tag]) || null),
      fav: site ? favOf(p, agg.codes || [], site) : null,
    };
    const key = tag.slice(0, 2).padEnd(2, '_');
    if (!shards.has(key)) shards.set(key, {});
    shards.get(key)[tag] = rec;
  }
  return { shards, count: entries.length };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const keys = seasonKeys(), built = [], site = loadSite();
  let changed = false;
  for (const key of keys) {
    const dir = path.join(OUT, key), histDir = path.join(dir, 'hist'), metaFile = path.join(dir, 'meta.json');
    const buf = await fetchBuf(`${RAW}/archive-s${key}/season.json.gz`);
    if (!buf) { console.log(`season ${key}: no season.json.gz yet, skipping`); continue; }
    const agg = JSON.parse(gunzipMaybe(buf)), days = [...(agg.days || [])].sort();
    built.push(key);
    fs.mkdirSync(histDir, { recursive: true });

    const expectedByDay = new Map((agg.dayStats || []).map(d => [d.date, d]));
    // Download missing history and repair cached days that don't contain all the battles
    // counted by the season aggregate. A missing source file is never cached as an empty day.
    let fetched = 0;
    for (const date of days) {
      const f = path.join(histDir, `${date}.json.gz`);
      const expected = expectedByDay.get(date);
      const cached = fs.existsSync(f) ? readGz(f, null) : null;
      const counts = historyCounts(cached);
      if (cached && (!expected || (counts.att === expected.att && counts.def === expected.def))) continue;
      if (Date.now() - T0 > BUDGET_MS) { console.log(`season ${key}: time budget used, remaining days continue next run`); break; }
      const t = Date.now(), fresh = await buildDayHist(key, date);
      if (fresh) {
        const actual = historyCounts(fresh);
        if (!expected || (actual.att === expected.att && actual.def === expected.def)) {
          writeGz(f, fresh); fetched++;
          console.log(`  day ${date}: history built in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        } else {
          fs.rmSync(f, { force: true });
          console.warn(`  day ${date}: source history is incomplete (${actual.att}/${expected.att} attacks, ${actual.def}/${expected.def} defenses); will retry`);
        }
      } else {
        fs.rmSync(f, { force: true });
        console.warn(`  day ${date}: source history unavailable; will retry`);
      }
    }
    const histDays = days.filter((d) => {
      const h = readGz(path.join(histDir, `${d}.json.gz`), null), expected = expectedByDay.get(d);
      if (!h) return false;
      if (!expected) return true;
      const c = historyCounts(h); return c.att === expected.att && c.def === expected.def;
    });
    const sig = `${SCHEMA}|${site ? 'a' : 'n'}|${agg.generatedAt ?? ''}|${days.length}|${Object.keys(agg.players || {}).length}|${histDays.length}`;
    let old = null; try { old = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* first run */ }
    if (old && old.sig === sig && !fetched) { console.log(`season ${key}: unchanged (${sig})`); continue; }

    const hists = days.map((d) => (histDays.includes(d) ? readGz(path.join(histDir, `${d}.json.gz`)) : null));
    const { shards, count } = buildShards(agg, hists, site);
    for (const f of fs.readdirSync(dir)) if (/^[0-9A-Z_]{2}\.json$/.test(f)) fs.rmSync(path.join(dir, f)); // old shards only; keep hist/
    const head = { season: agg.season, days: days.length, dayList: days, lengthDays: agg.lengthDays || SEASON_DAYS, generatedAt: agg.generatedAt || null };
    for (const [k, players] of shards) fs.writeFileSync(path.join(dir, `${k}.json`), JSON.stringify({ ...head, players }));
    fs.writeFileSync(metaFile, JSON.stringify({ sig, season: agg.season, days: days.length, histDays: histDays.length, lengthDays: head.lengthDays, generatedAt: head.generatedAt, players: count, shards: shards.size, built: new Date().toISOString() }));
    console.log(`season ${key}: ${count} players in ${shards.size} shards (${histDays.length}/${days.length} days of history)`);
    changed = true;
  }
  for (const d of fs.readdirSync(OUT)) { // drop seasons that are no longer current/previous
    if (/^\d{4}-\d\d-\d\d$/.test(d) && !keys.includes(d)) { fs.rmSync(path.join(OUT, d), { recursive: true, force: true }); changed = true; console.log(`removed old season ${d}`); }
  }
  if (changed) fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ keys: built, updated: new Date().toISOString() }));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  console.log(changed ? 'done: changes written' : 'done: nothing to publish');
}
main().catch((e) => { console.error(e); process.exit(1); });
