// Legend battlelog collector. Runs AFTER scanner/crawl.mjs in the same job and reads the
// leaderboard it just wrote (data-out/leaderboard.json).
//
// Outputs (all inside data-out/battlelogs/, published with the rest of the data branch):
//   live.json.gz        the current Legend day (since the latest 05:00 UTC reset), rewritten every run
//   YYYY-MM-DD.json.gz  one file per finished Legend day (05:00 -> 05:00 UTC), named after the reset that
//                       closed it, i.e. the same date as eod/YYYY-MM-DD.json.gz
//   index.json          small summary: live window, coverage, list of archived dates
//   state.json.gz       working state (per-player battles for the last ~2 days + last fetch time)
//
// Only battleType "legend" entries are kept. attack:true -> attacks[], attack:false -> defenses[].
// For a defense, stars/destruction are what the opponent got against this player, and armyShareCode is
// the opponent's army.
//
// The API only returns a short rolling log per player (about the last 2 Legend days), so every run
// merges new entries into the state (deduped) and the daily files are built from that state.
// Players are fetched least-recently-fetched first, so the whole list is rotated over a few runs
// when it is too big for one run's time budget.
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
const BL_DIR = path.join(OUT_DIR, 'battlelogs');
const CONCURRENCY = +process.env.CONCURRENCY || 15;
const MAX_RPS = +process.env.MAX_RPS || 15;
// time budget for this step: normal runs vs. runs where the just-finished day is not fully collected yet
const BUDGET_MS = (+process.env.BATTLELOG_MIN || 12) * 60_000;
const CATCHUP_MS = (+process.env.BATTLELOG_CATCHUP_MIN || 20) * 60_000;
// how many daily files to keep. 0 = keep everything.
const KEEP_DAYS = process.env.BATTLELOG_KEEP_DAYS !== undefined ? +process.env.BATTLELOG_KEEP_DAYS : 7;

const DAY_MS = 86_400_000;
const DAILY_RESET_UTC_HOUR = 5;
const GIVE_UP_AFTER_MS = 6 * 3_600_000; // stop re-writing a day's file this long after the reset even if a few players failed

const started = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = tag => encodeURIComponent(tag);
const dateKey = ms => new Date(ms).toISOString().slice(0, 10);

// ---------- rate limiting (same approach as crawl.mjs) ----------
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
    console.warn(`429 - ceiling now ${rps}/s`);
    await sleep(500 * attempt); return api(p, attempt + 1);
  }
  if (res.status >= 500 && attempt <= 3) { await sleep(1000 * attempt); return api(p, attempt + 1); }
  let body = {}; try { body = await res.json(); } catch {}
  const err = new Error([body.reason, body.message].filter(Boolean).join(': ') || `HTTP ${res.status}`);
  err.notFound = res.status === 404 || body.reason === 'notFound';
  err.fatal = res.status === 403; // bad key / proxy IP not whitelisted: stop this step, keep what we have
  throw err;
}

// ---------- helpers ----------
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function readGz(file, fallback) {
  try { return JSON.parse((await gunzip(await fs.readFile(file))).toString()); } catch { return fallback; }
}
const writeGz = async (file, data) => fs.writeFile(file, await gzip(JSON.stringify(data)));

// "20261023T051801.000Z" -> epoch ms
function parseCocTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
const msOf = r => Date.parse(r.time);

// most recent 05:00 UTC reset at or before `now`
function latestResetAt(now) {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAILY_RESET_UTC_HOUR);
  return now >= today ? today : today - DAY_MS;
}

// ---------- state ----------
const leaderboard = await readJson(path.join(OUT_DIR, 'leaderboard.json'), null);
if (!leaderboard?.players?.length) { console.log('battlelogs: no leaderboard.json yet, nothing to do'); process.exit(0); }
await fs.mkdir(BL_DIR, { recursive: true });

const state = await readGz(path.join(BL_DIR, 'state.json.gz'), {});
state.players ||= {}; state.meta ||= {}; state.meta.archives ||= {};

const now = started;
const reset = latestResetAt(now);          // start of the open Legend day
const closedKey = dateKey(reset);          // date label of the day that closed at `reset` (matches eod/<date>.json.gz)
const closedFile = path.join(BL_DIR, `${closedKey}.json.gz`);
const archiveFinal = async () => {
  if (!state.meta.archives[closedKey]?.final) return false;
  try { await fs.access(closedFile); return true; } catch { return false; }
};
const needCatchup = !(await archiveFinal());
const deadline = started + (needCatchup ? CATCHUP_MS : BUDGET_MS);

// ---------- fetch ----------
function toRecord(item, ts) {
  return {
    time: new Date(ts).toISOString(),
    opponentTag: item.opponentPlayerTag,
    opponentName: item.opponentName,
    opponentTownHall: item.opponentTownHallLevel,
    stars: item.stars,
    destruction: item.destructionPercentage,
    duration: item.battleTime,            // seconds
    armyShareCode: item.armyShareCode || null,
  };
}

function merge(entry, items) {
  const seen = new Set();
  for (const r of entry.attacks) seen.add(`a|${r.time}|${r.opponentTag}`);
  for (const r of entry.defenses) seen.add(`d|${r.time}|${r.opponentTag}`);
  let added = 0;
  for (const item of items) {
    if (item.battleType !== 'legend') continue;
    const ts = parseCocTime(item.battleTimestamp);
    if (Number.isNaN(ts)) continue;
    const rec = toRecord(item, ts);
    const list = item.attack ? entry.attacks : entry.defenses;
    const key = `${item.attack ? 'a' : 'd'}|${rec.time}|${rec.opponentTag}`;
    if (seen.has(key)) continue;
    seen.add(key); list.push(rec); added++;
  }
  if (added) {
    entry.attacks.sort((a, b) => msOf(a) - msOf(b));
    entry.defenses.sort((a, b) => msOf(a) - msOf(b));
  }
  return added;
}

const roster = leaderboard.players.map(p => ({ tag: p.tag, name: p.name }));
const rosterTags = new Set(roster.map(p => p.tag));
roster.sort((a, b) => (state.players[a.tag]?.fetchedAt || 0) - (state.players[b.tag]?.fetchedAt || 0)); // stalest first

let fetched = 0, failed = 0, added = 0, aborted = false;
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) || 0 }, async () => {
    while (i < items.length && Date.now() < deadline && !aborted) await fn(items[i++]);
  }));
}

console.log(`battlelogs: ${roster.length} players, ${needCatchup ? 'catch-up' : 'normal'} budget ${Math.round((deadline - started) / 60000)} min`);
try {
  await pool(roster, CONCURRENCY, async ({ tag, name }) => {
    const entry = state.players[tag] ||= { name, fetchedAt: 0, attacks: [], defenses: [] };
    entry.name = name;
    try {
      const data = await api(`/players/${enc(tag)}/battlelog`);
      added += merge(entry, data.items || []);
      entry.fetchedAt = Date.now();
      fetched++;
    } catch (e) {
      if (e.notFound) entry.fetchedAt = Date.now();
      else {
        failed++;
        if (e.fatal) { aborted = true; console.error('403 from API: check the key and that the proxy IP is whitelisted.', e.message); }
        else if (failed <= 20) console.error(`battlelog ${tag}: ${e.message}`);
      }
    }
  });
} catch (e) {
  console.error('battlelogs: unexpected error, saving what we have:', e);
  aborted = true;
}

// ---------- prune ----------
const keepFrom = reset - DAY_MS; // closed day + open day is all we ever need
for (const [tag, p] of Object.entries(state.players)) {
  p.attacks = p.attacks.filter(r => msOf(r) >= keepFrom);
  p.defenses = p.defenses.filter(r => msOf(r) >= keepFrom);
  if (!rosterTags.has(tag) && !p.attacks.length && !p.defenses.length) delete state.players[tag];
}

// ---------- build views ----------
function view(from, to) {
  const players = {};
  let attacks = 0, defenses = 0;
  for (const [tag, p] of Object.entries(state.players)) {
    const a = p.attacks.filter(r => msOf(r) >= from && msOf(r) < to);
    const d = p.defenses.filter(r => msOf(r) >= from && msOf(r) < to);
    if (!a.length && !d.length) continue;
    players[tag] = { name: p.name, attacks: a, defenses: d };
    attacks += a.length; defenses += d.length;
  }
  return { players, playersWithBattles: Object.keys(players).length, attacks, defenses };
}
const refreshedSince = t => roster.filter(p => (state.players[p.tag]?.fetchedAt || 0) >= t).length;
const generatedAt = Date.now();

// live: the open Legend day
const live = {
  generatedAt,
  date: dateKey(reset + DAY_MS), // label this day will get once archived
  dayStart: new Date(reset).toISOString(),
  dayEnd: new Date(reset + DAY_MS).toISOString(),
  playersTracked: roster.length,
  playersRefreshedThisDay: refreshedSince(reset),
  ...view(reset, reset + DAY_MS),
};
await writeGz(path.join(BL_DIR, 'live.json.gz'), live);

// daily copy: the Legend day that just closed. Re-written each run until every player has been fetched
// since the reset (or GIVE_UP_AFTER_MS has passed), so the file ends up built from fresh post-reset data.
let archiveInfo = state.meta.archives[closedKey] || null;
if (needCatchup) {
  const refreshed = refreshedSince(reset);
  const final = refreshed >= roster.length || now - reset >= GIVE_UP_AFTER_MS;
  const day = {
    generatedAt,
    date: closedKey,
    dayStart: new Date(reset - DAY_MS).toISOString(),
    dayEnd: new Date(reset).toISOString(),
    final,
    playersTracked: roster.length,
    playersRefreshedAfterReset: refreshed,
    ...view(reset - DAY_MS, reset),
  };
  await writeGz(closedFile, day);
  archiveInfo = state.meta.archives[closedKey] = { final, writtenAt: generatedAt, playersRefreshedAfterReset: refreshed };
  console.log(`battlelogs: wrote ${closedKey}.json.gz (${day.playersWithBattles} players, ${day.attacks} attacks, ${day.defenses} defenses, ${refreshed}/${roster.length} refreshed${final ? ', final' : ''})`);
}

// retention for daily files
let dates = (await fs.readdir(BL_DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).map(f => f.slice(0, 10)).sort();
if (KEEP_DAYS > 0 && dates.length > KEEP_DAYS) {
  for (const d of dates.slice(0, -KEEP_DAYS)) { await fs.unlink(path.join(BL_DIR, `${d}.json.gz`)); delete state.meta.archives[d]; }
  dates = dates.slice(-KEEP_DAYS);
}
for (const k of Object.keys(state.meta.archives)) if (!dates.includes(k)) delete state.meta.archives[k];

await fs.writeFile(path.join(BL_DIR, 'index.json'), JSON.stringify({
  generatedAt,
  live: { date: live.date, dayStart: live.dayStart, dayEnd: live.dayEnd, playersWithBattles: live.playersWithBattles, attacks: live.attacks, defenses: live.defenses, playersRefreshedThisDay: live.playersRefreshedThisDay },
  playersTracked: roster.length,
  archives: dates.map(d => ({ date: d, final: !!state.meta.archives[d]?.final })),
}));
await writeGz(path.join(BL_DIR, 'state.json.gz'), state);

console.log(`battlelogs: done in ${Math.round((Date.now() - started) / 1000)}s - fetched ${fetched}, failed ${failed}, new battles ${added}, live ${live.attacks} atk / ${live.defenses} def`);
process.exit(aborted && failed ? 1 : 0);
