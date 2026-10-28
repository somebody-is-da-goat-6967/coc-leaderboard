// Legend I leaderboard crawler - port of leaderboardScanner.js to run in GitHub Actions.
// Talks to the CoC API through the RoyaleAPI proxy (whitelist 45.79.218.79 on the key).
// Node 18+, no dependencies.
//
// State file shape deliberately matches your bot's data/leaderboard.json ({clans, players, meta}),
// plus a `queue` array, so you can bootstrap by copying that file to scanner/bootstrap.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const BASE = process.env.COC_BASE || 'https://cocproxy.royaleapi.dev/v1';
const KEY = process.env.COC_API_KEY;
if (!KEY) { console.error('COC_API_KEY missing'); process.exit(1); }
const OUT_DIR = process.env.OUT_DIR || 'data-out';
const MODE = process.env.MODE || 'auto'; // auto | refresh | discover | restart-dictionary
const CONCURRENCY = +process.env.CONCURRENCY || 15;
const MAX_RPS = +process.env.MAX_RPS || 15;                 // be polite: the proxy is shared
const SOFT_MS = (+process.env.BUDGET_MIN || 22) * 60_000;   // stop starting optional work
const HARD_MS = (+process.env.HARD_MIN || 27) * 60_000;     // stop everything, save, publish

const LEGEND_I_ID = 105000036;
// A player only counts as Legend I while they are in the Legend I tier AND have at least this many
// trophies. Dropping below it means they fell out of Legend I and get removed on the next scan.
const LEGEND_MIN_TROPHIES = +process.env.LEGEND_MIN_TROPHIES || 2000;
const DAY_MS = 86_400_000;
const DAILY_RESET_UTC_HOUR = 5;
const NAME_QUERIES_PER_CHUNK = 50;
const DICT_RERUN_MS = 7 * DAY_MS;
const DISCOVERY_EVERY_MS = DAY_MS;
const HISTORY_MAX = 730;
// how many daily end-of-day boards to keep (each is ~150-250 KB gzipped). 0 = keep everything.
const EOD_KEEP_DAYS = process.env.EOD_KEEP_DAYS !== undefined ? +process.env.EOD_KEEP_DAYS : 90;

const started = Date.now();
const softDeadline = started + SOFT_MS;
const hardDeadline = started + HARD_MS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const normalizeTag = raw => { const v = String(raw || '').trim().toUpperCase(); return v.startsWith('#') ? v : '#' + v; };
const enc = tag => encodeURIComponent(tag);

// ---------- rate limiting (sliding window, adaptive on 429) ----------
let rps = MAX_RPS, lastHit = 0, stamps = [], gate = Promise.resolve();
function slot() {
  const mine = gate.then(async () => {
    for (;;) {
      const now = Date.now();
      stamps = stamps.filter(t => now - t < 1000);
      if (stamps.length < rps) break;
      await sleep(Math.max(1, stamps[0] + 1000 - now));
    }
    stamps.push(Date.now());
  });
  gate = mine.catch(() => {});
  return mine;
}
setInterval(() => { if (rps < MAX_RPS && Date.now() - lastHit > 5000) rps++; }, 5000).unref();

async function api(p, attempt = 1) {
  await slot();
  let res;
  try { res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${KEY}` } }); }
  catch (e) { if (attempt <= 3) { await sleep(1000 * attempt); return api(p, attempt + 1); } throw e; }
  if (res.ok) return res.json();
  if (res.status === 429 && attempt <= 5) {
    lastHit = Date.now(); rps = Math.max(3, Math.floor(rps * 0.7));
    console.warn(`429 on ${p.split('?')[0]} - ceiling now ${rps}/s`);
    await sleep(500 * attempt); return api(p, attempt + 1);
  }
  if (res.status >= 500 && attempt <= 3) { await sleep(1000 * attempt); return api(p, attempt + 1); }
  let body = {}; try { body = await res.json(); } catch {}
  const err = new Error([body.reason, body.message].filter(Boolean).join(': ') || `HTTP ${res.status}`);
  err.notFound = res.status === 404 || body.reason === 'notFound';
  if (res.status === 403) {
    console.error('403 from API: check the key and that 45.79.218.79 is whitelisted on it.', err.message);
    process.exit(1);
  }
  throw err;
}

// run fn over items with n workers, stopping early at deadline
async function pool(items, n, fn, deadline = hardDeadline) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) || 0 }, async () => {
    while (i < items.length && Date.now() < deadline) await fn(items[i++]);
  }));
}

// ---------- state ----------
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function loadState() {
  try { return JSON.parse((await gunzip(await fs.readFile(path.join(OUT_DIR, 'state.json.gz')))).toString()); } catch {}
  const boot = await readJson('scanner/bootstrap.json', null);
  if (boot) console.log('bootstrapping from scanner/bootstrap.json');
  return boot || {};
}
await fs.mkdir(OUT_DIR, { recursive: true });
const store = await loadState();
store.clans ||= {}; store.players ||= {}; store.meta ||= {}; store.queue ||= [];
store.meta.legendCountHistory ||= [];
store.meta.checkedSeeds ||= {};
delete store.meta.endOfDaySnapshot; // legacy field from the old on-disk store

// drop anything the old scanner left behind that is not useful (wrong tier, or fell under the trophy floor)
for (const [t, p] of Object.entries(store.players)) {
  if (p.leagueId !== LEGEND_I_ID || (p.trophies || 0) < LEGEND_MIN_TROPHIES) delete store.players[t];
}
for (const [t, c] of Object.entries(store.clans)) if (!c.lastScanned) delete store.clans[t];

// ---------- queue (cursor-based so big backlogs stay fast) ----------
let queue = store.queue;
let qi = 0;
const queued = new Set(queue);
function queueCandidate(raw) {
  if (!raw) return false;
  const tag = normalizeTag(raw);
  if (store.clans[tag] || queued.has(tag)) return false;
  queued.add(tag); queue.push(tag); return true;
}
const claim = () => { if (qi >= queue.length) return null; const t = queue[qi++]; queued.delete(t); return t; };
const remaining = () => queue.length - qi;

// ---------- core: same Legend I rule as the bot ----------
function savePlayer(p, clanTagFallback) {
  if (!p || !p.tag) return false;
  const tier = p.leagueTier || p.league || {};
  const clan = p.clan || {};
  // Not in Legend I (wrong tier, or under the trophy floor) -> make sure they are NOT on the board.
  // Newly qualifying players fall through and get added; this runs for every member of every scanned clan.
  if (tier.id !== LEGEND_I_ID || (p.trophies || 0) < LEGEND_MIN_TROPHIES) {
    delete store.players[p.tag];
    return false;
  }
  store.players[p.tag] = {
    name: p.name,
    trophies: p.trophies || 0,
    leagueId: tier.id,
    leagueName: tier.name || null,
    clanName: clan.name || clanTagFallback || null,
    clanTag: (clan.tag || clanTagFallback) ? normalizeTag(clan.tag || clanTagFallback) : null,
    updated: Date.now(),
  };
  return true;
}

async function scanClan(tag) {
  let data;
  try { data = await api(`/clans/${enc(tag)}/members`); }
  catch (e) { if (e.notFound) { delete store.clans[tag]; return; } throw e; }
  let hasLegend = false;
  for (const m of data.items || []) if (savePlayer(m, tag)) hasLegend = true;
  if (hasLegend) store.clans[tag] = { name: tag, lastScanned: Date.now() };
  else delete store.clans[tag];
}

async function fetchPlayer(tag) {
  try {
    const full = await api(`/players/${enc(tag)}`);
    if (savePlayer(full) && full.clan?.tag) queueCandidate(full.clan.tag); // pick up the clan they moved to
  } catch (e) {
    if (e.notFound) delete store.players[tag];
    else console.error(`player ${tag} failed: ${e.message}`);
  }
}

const sortedPlayers = () => {
  const list = Object.entries(store.players).map(([tag, p]) => ({ tag, ...p })).sort((a, b) => b.trophies - a.trophies);
  list.forEach((p, i) => { p.rank = i > 0 && p.trophies === list[i - 1].trophies ? list[i - 1].rank : i + 1; });
  return list;
};

// ---------- steps ----------
function endOfDayIfDue() {
  const now = new Date();
  const todayReset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DAILY_RESET_UTC_HOUR);
  const latestReset = Date.now() >= todayReset ? todayReset : todayReset - DAY_MS;
  const dateKey = new Date(latestReset).toISOString().slice(0, 10);
  if (store.meta.lastEodDate === dateKey) return null;
  store.meta.lastEodDate = dateKey;
  // Only snapshot if the previous board was produced BEFORE this reset (otherwise it already mixes in new-day trophies).
  if (!store.meta.lastBoardAt || store.meta.lastBoardAt >= latestReset) {
    console.log(`no pre-reset board available for ${dateKey}; skipping end-of-day snapshot`);
    return null;
  }
  const players = sortedPlayers();
  const entry = { date: dateKey, count: players.length, recordedAt: latestReset };
  const hist = store.meta.legendCountHistory;
  const idx = hist.findIndex(h => h.date === dateKey);
  if (idx >= 0) hist[idx] = entry; else hist.push(entry);
  if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
  return {
    date: dateKey, recordedAt: latestReset,
    scannedClans: Object.keys(store.clans).length, knownClans: Object.keys(store.clans).length,
    players,
  };
}

async function discover() {
  console.log('discovery: global + regional clan rankings, regional player rankings');
  let added = 0;
  const top = await api('/locations/global/rankings/clans?limit=200');
  for (const c of top.items || []) if (queueCandidate(c.tag)) added++;
  const locs = ((await api('/locations')).items || []).filter(l => l.id);
  await pool(locs, 8, async loc => {
    for (const [suffix, pick] of [['/rankings/clans', i => i.tag], ['/rankings/players', i => i.clan?.tag]]) {
      try {
        const r = await api(`/locations/${loc.id}${suffix}?limit=200`);
        for (const item of r.items || []) if (queueCandidate(pick(item))) added++;
      } catch (e) { console.error(`location ${loc.id}${suffix}: ${e.message}`); }
    }
  });
  store.meta.lastDiscoveryAt = Date.now();
  console.log(`discovery queued ${added} new clan(s)`);
}

async function drainQueue(deadline) {
  let scanned = 0, failed = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    let tag;
    while (Date.now() < deadline && (tag = claim())) {
      try { await scanClan(tag); scanned++; } catch (e) { failed++; console.error(`clan ${tag}: ${e.message}`); }
    }
  }));
  return { scanned, failed };
}

async function dictionaryChunk(words, prog) {
  const slice = words.slice(prog.index, prog.index + NAME_QUERIES_PER_CHUNK);
  await pool(slice, 10, async w => {
    try {
      const d = await api(`/clans?name=${encodeURIComponent(w)}&minMembers=2&limit=100`);
      for (const c of d.items || []) queueCandidate(c.tag);
    } catch (e) { console.error(`name search "${w}": ${e.message}`); }
  }, softDeadline);
  prog.index = Math.min(prog.index + slice.length, words.length);
  if (prog.index >= words.length) { prog.complete = true; prog.completedAt = Date.now(); }
}

// ---------- battle-log discovery ----------
// A known Legend player's battle log lists everyone they attacked or were attacked by. Any opponent we have
// not indexed is looked up; if they turn out to be Legend I they join the board and their own log is read
// next (breadth-first), so one known player can pull in a whole chain of unknown ones.
// Time-boxed per run; known players are read oldest-scan-first so every log gets its turn across runs.
//   BATTLE_DISCOVERY=0        turn it off
//   BATTLE_BUDGET_SEC=150     max seconds per run spent on it
//   BATTLE_SKIP_TYPES=homeVillage   comma list of battleType values to ignore (random home-village opponents)
const BATTLE_DISCOVERY = process.env.BATTLE_DISCOVERY !== '0';
const BATTLE_BUDGET_MS = (+process.env.BATTLE_BUDGET_SEC || 150) * 1000;
const BATTLE_SKIP_TYPES = new Set((process.env.BATTLE_SKIP_TYPES ?? 'homeVillage')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const MISS_TTL_MS = 7 * DAY_MS; // an opponent who is not Legend I is not looked up again for a week
const MISS_MAX = 100_000;

async function battleDiscovery() {
  if (!BATTLE_DISCOVERY) return;
  const t0 = Date.now();
  const n = new Date(t0);
  let nextReset = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), DAILY_RESET_UTC_HOUR);
  if (nextReset <= t0) nextReset += DAY_MS;
  // never run in the 10 min before the daily reset, so the end-of-day board stays clean
  const deadline = Math.min(t0 + BATTLE_BUDGET_MS, nextReset - 10 * 60_000, softDeadline);
  if (deadline <= t0) { console.log('battle discovery: skipped (too close to the daily reset)'); return; }

  const scanned = store.meta.battleScanned ||= {};   // tag -> when its battle log was last read
  const misses = store.meta.opponentMisses ||= {};   // tag -> when we last found they are not Legend I
  for (const [t, ts] of Object.entries(misses)) if (t0 - ts > MISS_TTL_MS) delete misses[t];

  const frontier = Object.keys(store.players).sort((a, b) =>
    (scanned[a] || 0) - (scanned[b] || 0) || (store.players[b].trophies || 0) - (store.players[a].trophies || 0));
  let fi = 0;
  const fresh = []; // players just added this run: their logs are read before the rest of the frontier
  const nextTag = () => fresh.length ? fresh.shift() : (fi < frontier.length ? frontier[fi++] : null);

  const seen = new Set();
  const types = {};
  let logs = 0, checked = 0, added = 0, failed = 0;

  async function lookUp(tag) {
    checked++;
    try {
      const full = await api(`/players/${enc(tag)}`);
      if (savePlayer(full)) {
        added++;
        if (full.clan?.tag) queueCandidate(full.clan.tag);
        fresh.push(tag);
      } else misses[tag] = Date.now();
    } catch (e) {
      if (e.notFound) misses[tag] = Date.now();
      else { failed++; if (failed <= 5) console.error(`battle discovery: player ${tag}: ${e.message}`); }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    let tag;
    while (Date.now() < deadline && (tag = nextTag())) {
      if (!store.players[tag]) continue;
      let log;
      try { log = await api(`/players/${enc(tag)}/battlelog`); }
      catch (e) {
        if (!e.notFound) { failed++; if (failed <= 5) console.error(`battle discovery: log ${tag}: ${e.message}`); }
        scanned[tag] = Date.now();
        continue;
      }
      scanned[tag] = Date.now(); logs++;
      for (const b of (Array.isArray(log) ? log : log.items) || []) {
        const type = String(b.battleType || 'unknown');
        types[type] = (types[type] || 0) + 1;
        if (BATTLE_SKIP_TYPES.has(type.toLowerCase()) || !b.opponentPlayerTag) continue;
        const opp = normalizeTag(b.opponentPlayerTag);
        if (store.players[opp] || misses[opp] || seen.has(opp)) continue;
        seen.add(opp);
        await lookUp(opp);
      }
    }
  }));

  for (const t of Object.keys(scanned)) if (!store.players[t]) delete scanned[t];
  const missKeys = Object.keys(misses);
  if (missKeys.length > MISS_MAX) {
    missKeys.sort((a, b) => misses[a] - misses[b]).slice(0, missKeys.length - MISS_MAX).forEach(t => delete misses[t]);
  }
  const waiting = (frontier.length - fi) + fresh.length;
  console.log(`battle discovery: read ${logs} log(s), checked ${checked} unknown opponent(s), added ${added} Legend I player(s), `
    + `${waiting} known player(s) still waiting for a scan, ${failed} error(s) in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`battle types seen: ${JSON.stringify(types)}`);
}

// ---------- run ----------
const eod = endOfDayIfDue();

if (MODE === 'restart-dictionary') store.meta.nameSearchDictionary = null;

// player seeds (e.g. imported tag lists): fetch any tag we have not already checked
const playerSeeds = (await readJson('scanner/player-seeds.json', [])).map(normalizeTag)
  .filter(t => !store.players[t] && !store.meta.checkedSeeds[t]);
if (playerSeeds.length) {
  console.log(`checking ${playerSeeds.length} seeded player tag(s)`);
  await pool(playerSeeds, CONCURRENCY, async t => { await fetchPlayer(t); store.meta.checkedSeeds[t] = 1; });
}


// clan seeds
for (const t of await readJson('scanner/seeds.json', [])) queueCandidate(t);

// discovery (daily, or on demand)
if (MODE === 'discover' || (MODE === 'auto' && Date.now() - (store.meta.lastDiscoveryAt || 0) > DISCOVERY_EVERY_MS)) {
  await discover();
}

// refresh every known Legend clan, then individually fetch players that fell outside those clans
const refreshStart = Date.now();
await pool(Object.keys(store.clans), CONCURRENCY, async t => {
  try { await scanClan(t); } catch (e) { console.error(`refresh ${t}: ${e.message}`); }
});
const stragglers = Object.keys(store.players).filter(t => (store.players[t].updated || 0) < refreshStart);
console.log(`refresh: ${Object.keys(store.clans).length} clan(s), ${stragglers.length} straggler(s)`);
await pool(stragglers, CONCURRENCY, fetchPlayer);

await battleDiscovery();

// work through discovered clans + dictionary name search with whatever time is left
let words = await readJson('scanner/dictionary.json', []);
if (!Array.isArray(words)) words = [];
let prog = store.meta.nameSearchDictionary;
if (!prog || prog.total !== words.length || (prog.complete && Date.now() - (prog.completedAt || 0) > DICT_RERUN_MS)) {
  prog = store.meta.nameSearchDictionary = { index: 0, total: words.length, complete: !words.length };
}
if (MODE !== 'refresh') {
  while (Date.now() < softDeadline) {
    await drainQueue(softDeadline);
    if (Date.now() >= softDeadline) break;
    if (!prog.complete) { await dictionaryChunk(words, prog); continue; }
    if (!remaining()) break;
  }
}

// ---------- write outputs ----------
store.queue = queue.slice(qi);
store.meta.lastBoardAt = started;
const players = sortedPlayers();
const nClans = Object.keys(store.clans).length;

const write = (f, data) => fs.writeFile(path.join(OUT_DIR, f), typeof data === 'string' ? data : JSON.stringify(data));
const eodDir = path.join(OUT_DIR, 'eod');
await fs.mkdir(eodDir, { recursive: true });
// one-time import of the snapshots your old scanner saved (upload them to scanner/ in the repo)
for (const f of ['scanner/endOfDaySnapshot.json', 'scanner/endOfDaySnapshot.prev.json']) {
  const snap = await readJson(f, null);
  if (!snap || !snap.date || !Array.isArray(snap.players)) continue;
  const out = path.join(eodDir, `${snap.date}.json.gz`);
  try { await fs.access(out); continue; } catch {} // already archived
  snap.players.sort((a, b) => b.trophies - a.trophies)
    .forEach((p, i, a) => { p.rank = i > 0 && p.trophies === a[i - 1].trophies ? a[i - 1].rank : i + 1; });
  await fs.writeFile(out, await gzip(JSON.stringify(snap)));
  console.log(`imported ${f} as ${snap.date} (${snap.players.length} players)`);
}
if (eod) {
  await fs.writeFile(path.join(eodDir, `${eod.date}.json.gz`), await gzip(JSON.stringify(eod)));
  console.log(`end-of-day snapshot archived for ${eod.date} (${eod.players.length} players)`);
}
let eodDates = (await fs.readdir(eodDir)).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).map(f => f.slice(0, 10)).sort();
if (EOD_KEEP_DAYS > 0 && eodDates.length > EOD_KEEP_DAYS) {
  for (const d of eodDates.slice(0, -EOD_KEEP_DAYS)) await fs.unlink(path.join(eodDir, `${d}.json.gz`));
  eodDates = eodDates.slice(-EOD_KEEP_DAYS);
}

await write('leaderboard.json', { generatedAt: Date.now(), players });
await write('meta.json', {
  generatedAt: Date.now(),
  legendPlayers: players.length,
  knownClans: nClans, scannedClans: nClans,
  queuedJobs: store.queue.length,
  nameSearchDictionary: prog, dictionarySize: words.length,
  countHistory: store.meta.legendCountHistory,
  lastDiscoveryAt: store.meta.lastDiscoveryAt || null,
  endOfDayDates: eodDates,
  endOfDayDate: eodDates.at(-1) || null,
  endOfDayPrevDate: eodDates.at(-2) || null,
});
await fs.writeFile(path.join(OUT_DIR, 'state.json.gz'), await gzip(JSON.stringify(store)));
console.log(`done in ${Math.round((Date.now() - started) / 1000)}s: ${players.length} Legend I players, ${nClans} clans, ${store.queue.length} queued, dictionary ${prog.index}/${prog.total}`);
process.exit(0);
