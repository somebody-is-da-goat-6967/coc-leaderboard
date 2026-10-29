// Ranked-week crawler: reads the Clashspot tag list, pulls each player's battle log from the CoC API
// (via the RoyaleAPI proxy by default) and stores ranked battles per tournament week.
//
// Layout written into DATA_DIR (the checked-out `ranked-data` branch):
//   ranked/current.json                      summary of the latest run
//   ranked/<weekStart YYYY-MM-DD>/state.json crawl cursor
//   ranked/<weekStart>/shards/<xx>.json.gz   { "#TAG": { th, b: [[t,atk,stars,pct,opp,armyCode,type,firstSeen], ...] } }
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const env = process.env;
const API_BASE = (env.COC_API_BASE || 'https://cocproxy.royaleapi.dev/v1').replace(/\/$/, '');
const API_KEY = env.COC_API_KEY;
const SEED_FILE = env.SEED_FILE || 'seeds/clashspot-townhall-tags.json';
const OUT = env.DATA_DIR || 'data-out';
const CONCURRENCY = Number(env.CONCURRENCY) || 25;
const MAX_MINUTES = Number(env.MAX_MINUTES) || 100;
const LIMIT = Number(env.LIMIT) || 0; // >0 = only crawl the first N tags (test runs)
const BATTLE_TYPES = (env.BATTLE_TYPES || 'ranked,legend').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Tournament week window (UTC). dow: 0=Sunday ... 6=Saturday.
const START_DOW = Number(env.WEEK_START_DOW ?? 1), START_HOUR = Number(env.WEEK_START_HOUR ?? 17); // Monday 17:00
const END_DOW = Number(env.WEEK_END_DOW ?? 0), END_HOUR = Number(env.WEEK_END_HOUR ?? 5);          // Sunday 05:00

if (!API_KEY) { console.error('COC_API_KEY is not set'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = t => '#' + String(t).trim().replace(/^#/, '').toUpperCase();
const shardOf = tag => crypto.createHash('sha1').update(tag).digest('hex').slice(0, 2);

// ---------- week window ----------
function weekStartOf(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), START_HOUR));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - START_DOW + 7) % 7));
  if (d > now) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}
const now = new Date();
const start = weekStartOf(now);
const end = new Date(start);
end.setUTCDate(end.getUTCDate() + (((END_DOW - START_DOW + 7) % 7) || 7));
end.setUTCHours(END_HOUR, 0, 0, 0);
const weekKey = start.toISOString().slice(0, 10);

function parseTime(s) { // 20261028T123456.000Z
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/.exec(s || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// ---------- seeds ----------
// Accepts the flat array ["#TAG", ...] or the detailed { "17": { "2026-10-26": [...] } } file.
function loadSeeds() {
  const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const map = new Map(); // tag -> town hall (or null)
  if (Array.isArray(raw)) {
    raw.forEach(t => map.set(norm(t), null));
  } else {
    const rows = [];
    for (const th of Object.keys(raw)) for (const wk of Object.keys(raw[th])) for (const t of raw[th][wk]) rows.push([wk, +th, norm(t)]);
    rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)); // newest week first, so the latest TH wins
    for (const [, th, tag] of rows) if (!map.has(tag)) map.set(tag, th);
  }
  return map;
}

// ---------- storage ----------
const weekDir = path.join(OUT, 'ranked', weekKey);
const shardDir = path.join(weekDir, 'shards');

function loadShards() {
  const players = new Map();
  if (!fs.existsSync(shardDir)) return players;
  for (const f of fs.readdirSync(shardDir)) {
    if (!f.endsWith('.json.gz')) continue;
    const obj = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(shardDir, f))));
    for (const [tag, v] of Object.entries(obj)) players.set(tag, v);
  }
  return players;
}

function saveShards(players) {
  fs.mkdirSync(shardDir, { recursive: true });
  const groups = {};
  for (const [tag, v] of players) (groups[shardOf(tag)] ||= {})[tag] = v;
  for (const [name, obj] of Object.entries(groups)) {
    fs.writeFileSync(path.join(shardDir, name + '.json.gz'), zlib.gzipSync(JSON.stringify(obj)));
  }
}

// ---------- API ----------
let forbidden = 0;
async function api(pathname) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(API_BASE + pathname, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } });
    } catch { await sleep(1000 * 2 ** attempt); continue; }
    if (res.status === 200) return res.json();
    if (res.status === 404) return null;          // player no longer exists
    if (res.status === 403) {                      // bad key / IP not whitelisted
      if (++forbidden > 20) throw new Error('Too many 403s: check COC_API_KEY and that the key allows the proxy IP 45.79.218.79');
      await sleep(1000); continue;
    }
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra ? ra * 1000 : 1500 * 2 ** attempt); // 429 / 5xx / maintenance
  }
  return undefined; // gave up on this player this run
}

// ---------- battles ----------
const keyOf = r => r[0]
  ? `${r[0]}|${r[1]}|${r[4]}`                       // time known: time + direction + opponent
  : `${r[1]}|${r[4]}|${r[2]}|${r[3]}|${r[5]}`;      // no battleTime in the log: best-effort identity
const typeCounts = {};

function mergeLog(rec, log, nowSec) {
  const seen = new Set(rec.b.map(keyOf));
  let added = 0;
  for (const e of log.items || log || []) {
    const type = String(e.battleType || '').toLowerCase();
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (!BATTLE_TYPES.includes(type)) continue;
    const t = parseTime(e.battleTime);
    if (t !== null && (t < start.getTime() || t >= end.getTime())) continue;
    const r = [t ? Math.floor(t / 1000) : 0, e.attack ? 1 : 0, e.stars ?? 0, e.destructionPercentage ?? 0,
               e.opponentPlayerTag || '', e.armyShareCode || '', type, nowSec];
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k); rec.b.push(r); added++;
  }
  return added;
}

// ---------- main ----------
const seeds = loadSeeds();
let tags = [...seeds.keys()].sort();
if (LIMIT) tags = tags.slice(0, LIMIT);

const players = loadShards();
const statePath = path.join(weekDir, 'state.json');
let cursor = 0;
try { cursor = JSON.parse(fs.readFileSync(statePath, 'utf8')).cursor || 0; } catch { /* first run of the week */ }
cursor %= Math.max(tags.length, 1);
const order = tags.slice(cursor).concat(tags.slice(0, cursor));

console.log(`week ${weekKey} (${start.toISOString()} -> ${end.toISOString()}), ${tags.length} tags, start index ${cursor}, types=${BATTLE_TYPES}`);

const deadline = Date.now() + MAX_MINUTES * 60000;
const nowSec = Math.floor(Date.now() / 1000);
let next = 0, done = 0, failed = 0, newBattles = 0, fatal = null;

async function worker() {
  while (!fatal && next < order.length && Date.now() < deadline) {
    const tag = order[next++];
    try {
      const log = await api(`/players/${encodeURIComponent(tag)}/battlelog`);
      if (log === undefined) { failed++; continue; }
      if (log === null) continue;
      const rec = players.get(tag) || { th: null, b: [] };
      if (seeds.get(tag) != null) rec.th = seeds.get(tag);
      const added = mergeLog(rec, log, nowSec);
      newBattles += added;
      if (rec.b.length) players.set(tag, rec);
    } catch (e) { fatal = e; }
    if (++done % 2000 === 0) console.log(`  ${done}/${order.length} players, +${newBattles} battles, ${failed} failed`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// every index below `next` was dispatched; resume from there next run (wraps)
const processed = Math.min(next, order.length);
const newCursor = tags.length ? (cursor + (processed >= order.length ? 0 : processed)) % tags.length : 0;

saveShards(players);
fs.mkdirSync(weekDir, { recursive: true });
fs.writeFileSync(statePath, JSON.stringify({ cursor: newCursor }));
let totalBattles = 0; for (const v of players.values()) totalBattles += v.b.length;
fs.writeFileSync(path.join(OUT, 'ranked', 'current.json'), JSON.stringify({
  weekKey, start: start.toISOString(), end: end.toISOString(), updatedAt: new Date().toISOString(),
  tagsInSeed: tags.length, crawledThisRun: processed, failedThisRun: failed,
  playersWithBattles: players.size, battles: totalBattles, battleTypesSeen: typeCounts,
}, null, 1));

console.log(`done: ${processed}/${order.length} crawled, ${failed} failed, +${newBattles} new battles, ${totalBattles} total`);
console.log('battleType counts seen in logs:', typeCounts);
if (fatal) { console.error(fatal.message); process.exit(1); }
