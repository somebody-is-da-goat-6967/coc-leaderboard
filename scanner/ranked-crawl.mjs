// Ranked-week crawler: reads the Clashspot tag list, pulls each player's battle log from the CoC API
// (via the RoyaleAPI proxy by default) and stores ranked battles per tournament week.
//
// Layout written into DATA_DIR (the checked-out `ranked-data` branch):
//   ranked/current.json                      summary of the latest run
//   ranked/<weekStart YYYY-MM-DD>/state.json last run info
//   ranked/<weekStart>/shards/th<N>.json.gz  one file per town hall (th0 = town hall unknown):
//       { "#TAG": { th, n: name, b: [[time, atk, stars, pct, oppTag, armyCode, type, firstSeen, duration], ...] } }
//       time/firstSeen are unix seconds (time 0 = the log had no battleTime); atk 1 = attack, 0 = defense
//   Each player record also carries the profile data fetched from /players/<tag> (profile phase):
//       n = name, th = current town hall, lg = [leagueId, leagueName], tr = trophies, pt = unix seconds of the profile fetch
//   and scheduling data: lc = unix seconds of the last battle-log crawl, rt = recent battles per hour (smoothed).
//   Ranked tournament data comes from the league group (100 players per group), found via the profile:
//     /players/<tag>  ->  currentLeagueGroupTag + currentLeagueSeasonId (and the previous* pair)
//     /leaguegroup/<groupTag>/<seasonId>?playerTag=<a tracked member>  ->  every member's exact weekly totals
//       cg = [groupTag, seasonId], pg = previous week's pair, gw = [attackWins, attackLosses, defenseWins, defenseLosses] (exact, from the game),
//       tr = leagueTrophies (this week's ranked trophies), gr = rank inside the group, gf = unix seconds of the group fetch
//
// WHY SCHEDULING MATTERS: a battle log only holds the ~32 most recent ranked battles (attacks + defenses). A Legend III / Electro player
// makes 18-30 attacks a week and takes as many defenses, so crawling them too rarely silently loses their oldest attacks (that is the
// "stuck at 16 attacks" wall). Each run therefore crawls the players most likely to have overflowed their log first.
//
// MODE=trophies   short run (every 30 min): hottest battle logs, then the stalest league groups (trophies, exact attack counts), then profiles
// MODE=battlelogs long run (every 4 h):    mostly battle logs (most urgent first), small shares for groups and profiles
// MODE=catchup    manual run: finish everyone who is incomplete (no profile / never read / league group not fetched), groups first
// MAX_RPS         API requests per second this run may use (0 = unthrottled); MAX_MINUTES x MAX_RPS is the call budget
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const env = process.env;
const API_BASE = (env.COC_API_BASE || 'https://cocproxy.royaleapi.dev/v1').replace(/\/$/, '');
const API_KEY = env.COC_API_KEY_RANKED || env.COC_API_KEY; // the ranked crawl has its own key
const SEED_FILE = env.SEED_FILE || 'seeds/clashspot-townhall-tags.json';
const OUT = env.DATA_DIR || 'data-out';
const CONCURRENCY = Number(env.CONCURRENCY) || 25;
const MAX_MINUTES = Number(env.MAX_MINUTES) || 100;
const LIMIT = Number(env.LIMIT) || 0; // >0 = only crawl the first N tags (test runs)
const MODE = (env.MODE || 'battlelogs').toLowerCase();
const MAX_RPS = Number(env.MAX_RPS) || 0;
const RISK_BATTLES = Number(env.RISK_BATTLES) || 8;     // crawl a player once we expect this many unseen battles in their log
const MAX_AGE_H = Number(env.MAX_AGE_H) || 4;           // longest gap for players whose week can overflow the log (Electro / Legend)
const PROFILE_TTL_MIN = Number(env.PROFILE_TTL_MIN) || 360;   // league name / town hall / group tag only change at week rollover or on upgrade
const GROUP_TTL_MIN = Number(env.GROUP_TTL_MIN) || (MODE === 'battlelogs' ? 120 : 25); // don't refetch a league group younger than this
const envShare = (n) => (env[n] != null && env[n] !== '' ? Number(env[n]) : null);
const BATTLE_TYPES = (env.BATTLE_TYPES || 'ranked,legend').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Tournament week window (UTC). dow: 0=Sunday ... 6=Saturday.
const START_DOW = Number(env.WEEK_START_DOW ?? 1), START_HOUR = Number(env.WEEK_START_HOUR ?? 17); // Monday 17:00
const END_DOW = Number(env.WEEK_END_DOW ?? 0), END_HOUR = Number(env.WEEK_END_HOUR ?? 5);          // Sunday 05:00

if (!API_KEY) { console.error('COC_API_KEY_RANKED (or COC_API_KEY) is not set'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = t => '#' + String(t).trim().replace(/^#/, '').toUpperCase();
const shardOf = rec => 'th' + (rec.th || 0);

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
  for (const [tag, v] of players) (groups[shardOf(v)] ||= {})[tag] = v;
  for (const [name, obj] of Object.entries(groups)) {
    fs.writeFileSync(path.join(shardDir, name + '.json.gz'), zlib.gzipSync(JSON.stringify(obj)));
  }
  for (const f of fs.readdirSync(shardDir)) { // drop shard files from older layouts
    if (f.endsWith('.json.gz') && !groups[f.replace('.json.gz', '')]) fs.unlinkSync(path.join(shardDir, f));
  }
}

// ---------- API ----------
let forbidden = 0, slot = 0;
async function throttle() { // spread requests evenly: at most MAX_RPS per second
  if (!MAX_RPS) return;
  const now = Date.now(); slot = Math.max(slot, now); const wait = slot - now; slot += 1000 / MAX_RPS;
  if (wait > 0) await sleep(wait);
}
const apiErrors = {}, errSamples = {};
async function noteErr(kind, res) { // count errors by endpoint:status and keep the first message of each so the cause is visible in current.json
  const k = `${kind}:${res.status}`; apiErrors[k] = (apiErrors[k] || 0) + 1;
  if (!errSamples[k]) { let t = ''; try { t = (await res.text()).slice(0, 300); } catch {} errSamples[k] = t; console.warn(`API ${k}: ${t}`); }
}
async function api(pathname) {
  const kind = pathname.split('/')[1];
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    await throttle();
    try {
      res = await fetch(API_BASE + pathname, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } });
    } catch { apiErrors[kind + ':network'] = (apiErrors[kind + ':network'] || 0) + 1; await sleep(Math.min(1000 * 2 ** attempt, 8000)); continue; }
    if (res.status === 200) return res.json();
    if (res.status === 404) return null;          // player / group no longer exists
    await noteErr(kind, res);
    if (res.status === 403) {                      // bad key / IP not whitelisted
      if (++forbidden > 20) throw new Error(`Too many 403s: check the API key and that it allows the proxy IP 45.79.218.79. First message: ${errSamples[kind + ':403'] || ''}`);
      await sleep(1000); continue;
    }
    if (res.status === 429 || res.status === 408 || res.status >= 500) { // rate limit / server trouble: wait (capped) and retry
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Math.min(ra ? ra * 1000 : 1500 * 2 ** attempt, 15000)); continue;
    }
    return undefined; // any other 4xx (bad request ...) will not get better by retrying
  }
  return undefined; // gave up on this one this run
}

// ---------- profile (name, town hall, league, trophies) ----------
// The API reports the ranked league as `leagueTier` (newer) and/or `league` (older field); use whichever is present.
function applyProfile(rec, p, nowSec) {
  if (p.name) rec.n = p.name;
  if (p.townHallLevel) rec.th = p.townHallLevel;
  const lg = p.leagueTier || p.league;
  rec.lg = lg && lg.id != null ? [lg.id, lg.name || ''] : [0, 'Unranked'];
  if (!rec.gf) rec.tr = p.trophies ?? 0; // until the league group gives the real weekly ranked trophies
  if (p.currentLeagueGroupTag && p.currentLeagueSeasonId) rec.cg = [p.currentLeagueGroupTag, p.currentLeagueSeasonId];
  if (p.previousLeagueGroupTag && p.previousLeagueSeasonId) rec.pg = [p.previousLeagueGroupTag, p.previousLeagueSeasonId];
  rec.pt = nowSec;
}

// ---------- battles ----------
const keyOf = r => r[0]
  ? `${r[0]}|${r[1]}|${r[4]}`                       // time known: time + direction + opponent
  : `${r[1]}|${r[4]}|${r[2]}|${r[3]}|${r[5]}`;      // no battleTime in the log: best-effort identity
const typeCounts = {};
const names = new Map(); // tag -> name, collected from the opponent fields of every log

function mergeLog(rec, log, nowSec) {
  const seen = new Set(rec.b.map(keyOf));
  let added = 0, entries = 0;
  for (const e of log.items || log || []) {
    if (e.opponentPlayerTag && e.opponentName) names.set(norm(e.opponentPlayerTag), e.opponentName);
    const type = String(e.battleType || '').toLowerCase();
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (!BATTLE_TYPES.includes(type)) continue;
    const t = parseTime(e.battleTime);
    if (t !== null && (t < start.getTime() || t >= end.getTime())) continue;
    const r = [t ? Math.floor(t / 1000) : 0, e.attack ? 1 : 0, e.stars ?? 0, e.destructionPercentage ?? 0,
               e.opponentPlayerTag || '', e.armyShareCode || '', type, nowSec,
               Number(e.duration ?? e.battleDuration) || 0];
    entries++;
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k); rec.b.push(r); added++;
  }
  return { added, entries, overlap: entries - added }; // overlap 0 with a full log = battles probably fell out unseen
}

// A league season id is the unix time the tournament week opens; it belongs to this crawler week if it falls within a couple of days of it.
const isThisWeek = (season) => Math.abs(season * 1000 - start.getTime()) < 2 * 864e5;
const groupOk = (rec) => !!(rec && rec.cg && isThisWeek(rec.cg[1]));

// ---------- scheduling ----------
const ATK = [[/^(skeleton|barbarian)/, 6], [/^(archer|wizard)/, 8], [/^(valkyrie|witch)/, 10], [/^(golem|pekka|titan)/, 12], [/^dragon/, 14], [/^electro/, 18]];
function maxAtkOf(name) { // attacks a week allows in this league (Legend III 24, Legend II/I 30)
  const n = String(name || '').trim().toLowerCase().replace(/\./g, '');
  if (n.startsWith('legend')) return /(iii|3)\s*$/.test(n) ? 24 : 30;
  for (const [re, v] of ATK) if (re.test(n)) return v;
  return 30; // unknown league: assume the worst
}
// How soon a battle log must be read again. Leagues with <=14 attacks (<=28 entries incl. defenses) fit the log, so they can wait longer.
const ageLimitH = (rec) => { const mx = maxAtkOf(rec?.lg?.[1]); return MAX_AGE_H * (mx >= 17 ? 1 : mx >= 11 ? 2 : 3); };
// >= 1 means "due". Never-crawled players come first; otherwise the larger of (expected unseen battles / RISK) and (age / age limit).
function urgency(rec, nowSec) {
  if (!rec || !rec.lc) return 10;
  const h = (nowSec - rec.lc) / 3600;
  return Math.max(h * ((rec.rt ?? 1) + 0.3) / RISK_BATTLES, h / ageLimitH(rec));
}
function noteCrawl(rec, added, nowSec) { // smoothed battles-per-hour; the first crawl's dump is spread over a day
  const h = rec.lc ? Math.max((nowSec - rec.lc) / 3600, 0.25) : 24, r = added / h;
  rec.rt = rec.rt == null ? +r.toFixed(2) : +(0.5 * rec.rt + 0.5 * r).toFixed(2);
  rec.lc = nowSec;
}

// ---------- main ----------
const seeds = loadSeeds();
let tags = [...seeds.keys()].sort();
if (LIMIT) tags = tags.slice(0, LIMIT);

const players = loadShards();
const statePath = path.join(weekDir, 'state.json');
const nowSec = Math.floor(Date.now() / 1000);
const deadline = Date.now() + MAX_MINUTES * 60000;
const totalCalls = MAX_RPS ? Math.floor(MAX_RPS * MAX_MINUTES * 60 * 0.9) : Infinity;

// who needs a battle-log crawl (most urgent first; ties go to the leagues that overflow the log) and whose profile is stalest
const mxOf = (tag) => maxAtkOf(players.get(tag)?.lg?.[1]);
const logJobs = tags.map((tag) => ({ tag, u: urgency(players.get(tag), nowSec), mx: mxOf(tag) })).filter((j) => j.u >= 1)
  .sort((a, b) => b.u - a.u || b.mx - a.mx || (a.tag < b.tag ? -1 : 1));
// profiles: first anyone never profiled or still holding last week's group tag, then the stalest (players with no group tag just follow the TTL)
const profJobs = tags.map((tag) => { const r = players.get(tag); return { tag, need: !r?.pt || (r.cg && !isThisWeek(r.cg[1])) ? 1 : 0, age: nowSec - (r?.pt || 0), mx: mxOf(tag) }; })
  .filter((j) => j.need || j.age >= PROFILE_TTL_MIN * 60).sort((a, b) => b.need - a.need || b.age - a.age || b.mx - a.mx || (a.tag < b.tag ? -1 : 1));
// league groups of the tracked players (one call serves every tracked member of a group); never-fetched groups first, then stalest
function buildGroupJobs() {
  const m = new Map();
  for (const [tag, r] of players) {
    if (!groupOk(r)) continue;
    const key = r.cg[0] + '|' + r.cg[1]; let g = m.get(key);
    if (!g) m.set(key, (g = { tag: r.cg[0], season: r.cg[1], oldest: Infinity, mx: 0, tags: [] }));
    g.oldest = Math.min(g.oldest, r.gf || 0); g.mx = Math.max(g.mx, maxAtkOf(r.lg?.[1])); g.tags.push(tag);
  }
  return [...m.values()].filter((g) => nowSec - g.oldest >= GROUP_TTL_MIN * 60).sort((a, b) => a.oldest - b.oldest || b.mx - a.mx);
}
let groupJobs = buildGroupJobs();
// "complete" = profile read, battle log read at least once, and (if the player is in a league group this week) the group fetched
const incomplete = () => { let n = 0; for (const tag of tags) { const r = players.get(tag); if (!r || !r.pt || !r.lc || (groupOk(r) && !r.gf)) n++; } return n; };
const incompleteAtStart = incomplete();
const groupsNever = groupJobs.filter((g) => !g.oldest).length;
// shares of the call budget: [battle logs, league groups]; profiles for new players come first (20%), leftover profiles get the rest
const base = { trophies: [0.35, 0.45], battlelogs: [0.8, 0.1], catchup: [0.2, 0.6] }[MODE] || [0.5, 0.4];
let [LOG_SHARE, GROUP_SHARE] = base;
if (groupsNever && MODE !== 'catchup') { LOG_SHARE = Math.min(LOG_SHARE, MODE === 'trophies' ? 0.25 : 0.5); GROUP_SHARE = Math.max(GROUP_SHARE, MODE === 'trophies' ? 0.6 : 0.4); } // finish the groups first
if (envShare('LOG_SHARE') != null) LOG_SHARE = envShare('LOG_SHARE');
if (envShare('GROUP_SHARE') != null) GROUP_SHARE = envShare('GROUP_SHARE');
console.log(`week ${weekKey} (${start.toISOString()} -> ${end.toISOString()}), ${tags.length} tags, mode=${MODE}, rps=${MAX_RPS || 'unlimited'}, ${MAX_MINUTES} min, calls<=${totalCalls}, types=${BATTLE_TYPES}`);
console.log(`queued: ${logJobs.length} battle logs, ${groupJobs.length} league groups (${groupsNever} never fetched), ${profJobs.length} profiles due; ${incompleteAtStart} players incomplete (shares: logs ${LOG_SHARE}, groups ${GROUP_SHARE})`);

let failed = 0, newBattles = 0, gaps = 0, fatal = null, shapeLogged = false, logsDone = 0, groupsDone = 0, groupMembers = 0;
const profiled = new Set();

async function doLog({ tag }) {
  const log = await api(`/players/${encodeURIComponent(tag)}/battlelog`);
  if (log === undefined) { failed++; return false; }
  const rec = players.get(tag) || { th: null, b: [] };
  if (!rec.pt && seeds.get(tag) != null) rec.th = seeds.get(tag); // the seed's town hall only until a profile knows better
  if (log === null) { rec.lc = nowSec; rec.rt = 0; players.set(tag, rec); return; } // player no longer exists
  const had = rec.b.length > 0 && rec.lc;
  const m = mergeLog(rec, log, nowSec);
  newBattles += m.added; logsDone++;
  if (had && m.entries >= 20 && m.overlap === 0) gaps++;
  noteCrawl(rec, m.added, nowSec);
  players.set(tag, rec);
}
async function doProfile({ tag }) {
  const p = await api(`/players/${encodeURIComponent(tag)}`);
  if (p === undefined) { failed++; return false; }
  if (p === null) return;
  const rec = players.get(tag) || { th: null, b: [] };
  if (!shapeLogged) { shapeLogged = true; console.log('first profile:', JSON.stringify({ name: p.name, th: p.townHallLevel, trophies: p.trophies, leagueTier: p.leagueTier, league: p.league })); }
  applyProfile(rec, p, nowSec); profiled.add(tag);
  players.set(tag, rec);
}
// One league group call updates every tracked member: exact weekly attack / defense counts and ranked trophies.
async function doGroup(g) {
  // The endpoint needs a playerTag (it returns that one player's attack/defense logs next to the 100 members); any tracked member will do.
  const res = await api(`/leaguegroup/${encodeURIComponent(g.tag)}/${g.season}?playerTag=${encodeURIComponent(g.tags[0])}`);
  if (res === undefined) { failed++; return false; }
  groupsDone++;
  const seen = new Set();
  (res?.members || []).forEach((m, i) => {
    const tag = norm(m.playerTag);
    if (!seeds.has(tag)) return; // only players the crawler tracks
    seen.add(tag);
    const rec = players.get(tag) || { th: seeds.get(tag), b: [] };
    rec.gw = [m.attackWinCount || 0, m.attackLoseCount || 0, m.defenseWinCount || 0, m.defenseLoseCount || 0];
    rec.tr = m.leagueTrophies ?? rec.tr ?? 0; rec.gr = i + 1; rec.cg = [g.tag, g.season]; rec.gf = nowSec;
    if (m.playerName && !rec.n) rec.n = m.playerName;
    players.set(tag, rec); groupMembers++;
  });
  for (const t of g.tags) if (!seen.has(t)) { const r = players.get(t); if (r) r.gf = nowSec; } // group gone / member missing: don't ask again every run
}
// Workers pull jobs until the list, the call quota or the clock runs out; returns the calls spent.
async function runPhase(jobs, quota, fn, label) {
  let i = 0, used = 0, streak = 0, stop = false;
  async function worker() {
    while (!fatal && !stop && i < jobs.length && used < quota && Date.now() < deadline) {
      used++; const j = jobs[i++];
      try {
        if ((await fn(j)) === false) { if (++streak >= 40) { stop = true; console.warn(`${label}: 40 failures in a row, giving up on this phase for this run`); } } else streak = 0;
      } catch (e) { fatal = e; }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return used;
}

const T = totalCalls, inf = T === Infinity, groupsDueAtStart = groupJobs.length;
const needJobs = profJobs.filter((j) => j.need), restJobs = profJobs.filter((j) => !j.need);
const needQ = inf ? Infinity : Math.floor(T * 0.2);
const needUsed = await runPhase(needJobs, needQ, doProfile, 'profiles (new)');       // 1. never-profiled players: they unlock their league group
groupJobs = buildGroupJobs();                                                         //    (rebuild: profiles just revealed more groups)
const lq = inf ? Infinity : Math.floor(T * LOG_SHARE);
const logUsed = await runPhase(logJobs, lq, doLog, 'battle logs');                   // 2. most urgent battle logs
const groupUsed = await runPhase(groupJobs, inf ? Infinity : Math.floor(T * GROUP_SHARE) + Math.max(0, lq - logUsed), doGroup, 'league groups'); // 3. league groups
const restUsed = await runPhase(restJobs, inf ? Infinity : T - needUsed - logUsed - groupUsed, doProfile, 'profiles (refresh)');              // 4. stale profiles get the rest
const profUsed = needUsed + restUsed;

for (const [tag, rec] of players) if (!rec.n && names.has(tag)) rec.n = names.get(tag); // opponent names only fill gaps; profile names win
saveShards(players);
fs.mkdirSync(weekDir, { recursive: true });
fs.writeFileSync(statePath, JSON.stringify({ mode: MODE, ranAt: new Date().toISOString() }));
let totalBattles = 0, withBattles = 0, withLeague = 0, withGroup = 0;
for (const v of players.values()) { totalBattles += v.b.length; if (v.b.length) withBattles++; if (v.lg) withLeague++; if (v.gf) withGroup++; }
fs.writeFileSync(path.join(OUT, 'ranked', 'current.json'), JSON.stringify({
  weekKey, start: start.toISOString(), end: end.toISOString(), updatedAt: new Date().toISOString(), mode: MODE,
  tagsInSeed: tags.length, crawledThisRun: logsDone, failedThisRun: failed, logsDueAtStart: logJobs.length, groupsDueAtStart: groupsDueAtStart, groupsNeverFetchedAtStart: groupsNever, profilesDueAtStart: profJobs.length, incompleteAtStart, incompleteLeft: incomplete(), apiErrors, apiErrorSamples: errSamples,
  gapsThisRun: gaps, groupsThisRun: groupsDone, groupMembersUpdated: groupMembers, profilesThisRun: profiled.size, callsUsed: logUsed + groupUsed + profUsed, callBudget: totalCalls === Infinity ? null : totalCalls,
  playersTracked: players.size, playersWithBattles: withBattles, playersWithLeague: withLeague, playersWithGroupData: withGroup, battles: totalBattles, battleTypesSeen: typeCounts,
}, null, 1));

console.log(`incomplete players: ${incompleteAtStart} before, ${incomplete()} after; API errors:`, apiErrors);
console.log(`done: ${logsDone} logs + ${groupsDone} groups (${groupMembers} players) + ${profiled.size} profiles (${logUsed + groupUsed + profUsed} calls), ${failed} failed, +${newBattles} new battles, ${totalBattles} total`);
console.log(`possible gaps (full log, nothing already known in it): ${gaps}; battle logs still due after this run: ${logJobs.length - logsDone}`);
console.log('battleType counts seen in logs:', typeCounts);
if (fatal) { console.error(fatal.message); process.exit(1); }
