// Folds finished Legend-day battlelog files into ONE compact summary per season (season.json.gz),
// so the stats page can show a whole 28-day season without downloading 28 big day files.
//
// Used by scanner/archive.mjs: whenever a day is archived into the season branch, it is folded in here.
// Folding is idempotent (a day already listed in agg.days is skipped), so re-runs are harmless.
//
// season.json.gz layout (all counts are per finished Legend Day, each player's first 8 attacks / 8 defenses):
//   season, start, end, lengthDays, days[] (day labels = date of the 05:00 reset that closed the day)
//   dayStats[]  per-day totals for the trend chart
//   G           season totals (stars, hours, durations ...)
//   codes[]     dictionary of army share codes; players[tag].arm refers to it by index
//   players{}   n name, r latest end-of-day rank, r0 first rank seen, dy days with battles,
//               na/nd attacks/defenses, a/d trophies gained/lost, st stars won, s3 3-star attacks,
//               ds stars conceded, dz 0-star defenses, d3 3-star defenses, pf perfect days, fu days with 8 attacks,
//               arm { codeIdx: [uses, stars, threeStars, trophies, durationSec] }
//   fast[] / upsets[]  best 100 of each (shortest 3-star battles / biggest rank gaps)
import fs from 'node:fs';
import zlib from 'node:zlib';

export const DAY_MS = 86_400_000;
const FAST_KEEP = 100, UPSET_KEEP = 100;

// Same scale as the website (legend.js trophyGain). Keep the two in sync.
export function trophyGain(stars, pct) {
  pct = Math.floor(pct || 0);
  if (stars >= 3) return 40;
  if (stars === 2) return Math.min(32, Math.max(16, 16 + Math.floor((pct - 50) / 3)));
  if (stars === 1) return Math.min(15, Math.max(5, 5 + Math.floor((pct - 1) / 9)));
  return Math.floor(pct / 10);
}

export const readGz = (file, fallback = null) => {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()); } catch { return fallback; }
};
export const writeGz = (file, data) => fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(data), { level: 9 }));

export function emptySeason(key, startMs, lengthDays) {
  return {
    v: 1, season: key, lengthDays,
    start: new Date(startMs).toISOString(), end: new Date(startMs + lengthDays * DAY_MS).toISOString(),
    generatedAt: 0, days: [], dayStats: [],
    G: { att: 0, def: 0, aT: 0, dT: 0, astars: [0, 0, 0, 0], dstars: [0, 0, 0, 0], pct: 0, dur: 0, durN: 0,
      hours: Array(24).fill(0), full: 0, perfect: 0 },
    codes: [], players: {}, fast: [], upsets: [],
  };
}

const normTag = (t) => String(t || '').replace(/^#/, '').toUpperCase();

// day: parsed battlelogs/<date>.json.gz   eodRanks: Map(tag -> rank) for that reset, or null
export function foldDay(agg, date, day, eodRanks) {
  if (agg.days.includes(date)) return false;
  // A season is exactly agg.lengthDays (28) Legend Days. Day label = date of the 05:00 reset that closed the day,
  // so day N (1..lengthDays) closes at start + N * DAY. Anything outside that window belongs to another season.
  const idx = Math.round((Date.parse(date + 'T05:00:00Z') - Date.parse(agg.start)) / DAY_MS);
  if (!(idx >= 1 && idx <= agg.lengthDays)) return false;
  const codeIdx = new Map(agg.codes.map((c, i) => [c, i]));
  const ds = { date, players: 0, att: 0, aT: 0, def: 0, dT: 0, a3: 0, perfect: 0, full: 0 };
  const G = agg.G;
  const ts = (r) => Date.parse(r.time);
  const rankOf = (tag) => (eodRanks && eodRanks.get(normTag(tag))) || 0;
  const fast = [], upsets = [];

  for (const [rawTag, e] of Object.entries(day.players || {})) {
    const tag = normTag(rawTag);
    const attacks = [...(e.attacks || [])].sort((a, b) => ts(a) - ts(b)).slice(0, 8);
    const defenses = [...(e.defenses || [])].sort((a, b) => ts(a) - ts(b)).slice(0, 8);
    if (!attacks.length && !defenses.length) continue;

    const p = agg.players[tag] ||= { n: e.name || 'Unknown', r: 0, r0: 0, dy: 0, na: 0, nd: 0, a: 0, d: 0, st: 0, s3: 0, ds: 0, dz: 0, d3: 0, pf: 0, fu: 0, arm: {} };
    p.n = e.name || p.n;
    const rank = rankOf(tag);
    if (rank) { p.r = rank; if (!p.r0) p.r0 = rank; }
    p.dy++; ds.players++;

    let s3 = 0;
    for (const h of attacks) {
      const t = trophyGain(h.stars, h.destruction), stars = h.stars || 0;
      p.na++; p.a += t; p.st += stars; if (stars === 3) { p.s3++; s3++; }
      G.att++; G.aT += t; G.astars[stars]++; G.pct += h.destruction || 0;
      ds.att++; ds.aT += t; if (stars === 3) ds.a3++;
      const time = Number(h.duration);
      if (time > 0) { G.dur += time; G.durN++; }
      G.hours[new Date(ts(h)).getUTCHours()]++;
      if (stars === 3 && time > 0) fast.push({ tag, name: p.n, rank, opp: h.opponentName || 'Unknown', oppTag: normTag(h.opponentTag), time, pct: h.destruction || 0, date });
      if (stars === 3 && rank && h.opponentTag) {
        const oppRank = rankOf(h.opponentTag);
        if (oppRank && oppRank <= 100 && rank > oppRank) upsets.push({ tag, name: p.n, rank, opp: h.opponentName || 'Unknown', oppTag: normTag(h.opponentTag), oppRank, time, pct: h.destruction || 0, date });
      }
      if (h.armyShareCode) {
        let ci = codeIdx.get(h.armyShareCode);
        if (ci === undefined) { ci = agg.codes.length; agg.codes.push(h.armyShareCode); codeIdx.set(h.armyShareCode, ci); }
        const a = p.arm[ci] ||= [0, 0, 0, 0, 0];
        a[0]++; a[1] += stars; if (stars === 3) a[2]++; a[3] += t; a[4] += time > 0 ? time : 0;
      }
    }
    for (const h of defenses) {
      const t = trophyGain(h.stars, h.destruction), stars = h.stars || 0;
      p.nd++; p.d += t; p.ds += stars; if (stars === 0) p.dz++; if (stars === 3) p.d3++;
      G.def++; G.dT += t; G.dstars[stars]++;
      ds.def++; ds.dT += t;
    }
    if (attacks.length === 8) { p.fu++; G.full++; ds.full++; if (s3 === 8) { p.pf++; G.perfect++; ds.perfect++; } }
  }

  agg.fast = [...agg.fast, ...fast].sort((a, b) => a.time - b.time || (a.rank || 1e9) - (b.rank || 1e9)).slice(0, FAST_KEEP);
  agg.upsets = [...agg.upsets, ...upsets].sort((a, b) => (b.rank - b.oppRank) - (a.rank - a.oppRank)).slice(0, UPSET_KEEP);
  agg.days.push(date); agg.days.sort();
  agg.dayStats.push(ds); agg.dayStats.sort((a, b) => (a.date < b.date ? -1 : 1));
  agg.generatedAt = Date.now();
  return true;
}

// ranks from eod/<date>.json.gz (same shape the website reads); returns Map(tag -> rank) or null
export function loadEodRanks(file) {
  const raw = readGz(file, null);
  if (!raw?.players) return null;
  return new Map(raw.players.map((p, i) => [normTag(p.tag), p.rank || i + 1]));
}
