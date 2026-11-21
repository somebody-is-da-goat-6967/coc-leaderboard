#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';

const args = Object.fromEntries(process.argv.slice(2).map((x, i, a) => x.startsWith('--') ? [x.slice(2), a[i + 1]] : null).filter(Boolean));
const mode = args.mode, dataDir = path.resolve(args.data || 'data'), rankedDir = path.resolve(args.ranked || dataDir), siteDir = path.resolve(args.site || '.'), outDir = path.resolve(args.out || 'out');
if (!['daily', 'season', 'wintraders', 'townhall'].includes(mode)) throw new Error('--mode must be daily, season, wintraders, or townhall');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readGz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const norm = (s) => String(s || '').replace(/^#/, '').toUpperCase();
const isoNow = () => new Date().toISOString();

function encode(v) {
  return JSON.stringify(v, (_, x) => {
    const tag = Object.prototype.toString.call(x);
    if (tag === '[object Map]') return { __computedType: 'Map', entries: [...x.entries()] };
    if (tag === '[object Set]') return { __computedType: 'Set', values: [...x.values()] };
    return x;
  });
}
function writeGz(rel, payload) {
  const file = path.join(outDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(encode(payload), { level: 9 }));
  console.log(`[precompute:${mode}] ${rel} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}
function writeJson(rel, payload) {
  const file = path.join(outDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload));
  console.log(`[precompute:${mode}] ${rel} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}
const fmtN = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const avgOf = (n, d, places = 2) => d ? fmtN(n / d, places) : '–';
const pctOf = (n, d) => d ? `${fmtN(100 * n / d, 1)}%` : '–';
const signed = n => `${n > 0 ? '+' : ''}${fmtN(n)}`;
const rankOrder = (a, b) => (a.rank || 1e9) - (b.rank || 1e9);
const SEASON_BOARD_KEEP = 100;

function seasonLeaderboards(S) {
  const rows = S.rows || [], by = (arr, cmp, value, detail) => [...arr].sort(cmp).slice(0, SEASON_BOARD_KEEP).map(r => ({
    tag: r.tag, name: r.name || r.tag, value: value(r), detail: detail(r),
  }));
  const moved = rows.filter(r => r.delta && Math.min(r.rank, r.r0) <= 2500);
  return {
    top_offense: by(rows, (a, b) => b.a - a.a || rankOrder(a, b),
      r => `+${fmtN(r.a)} trophies`, r => `+${avgOf(r.a, r.dy)} trophies/day · ${fmtN(r.na)} attacks · ${fmtN(r.s3)}×3★ · ${fmtN(r.dy)} days`),
    avg_offense: by(rows.filter(r => r.na >= 8 && r.dy > 0), (a, b) => b.a / b.dy - a.a / a.dy || rankOrder(a, b),
      r => `+${avgOf(r.a, r.dy)} trophies/day`, r => `${fmtN(r.dy)} days · ${fmtN(r.na)} attacks`),
    avg_defense: by(rows.filter(r => r.nd >= 8), (a, b) => a.d / a.nd - b.d / b.nd || rankOrder(a, b),
      r => `−${avgOf(r.d, r.nd)} per defense`, r => `${fmtN(r.nd)} defenses · ${fmtN(r.d)} trophies lost`),
    best_net: by(rows, (a, b) => b.net - a.net || rankOrder(a, b),
      r => `${signed(r.net)} trophies`, r => `+${fmtN(r.a)} offense · −${fmtN(r.d)} defense`),
    triples: by(rows, (a, b) => b.s3 - a.s3 || rankOrder(a, b),
      r => `${fmtN(r.s3)} triples`, r => `${fmtN(r.na)} attacks · ${pctOf(r.s3, r.na)} 3★`),
    triple_rate: by(rows.filter(r => r.na >= 8), (a, b) => b.s3 / b.na - a.s3 / a.na || rankOrder(a, b),
      r => `${pctOf(r.s3, r.na)} 3★`, r => `${fmtN(r.s3)} triples of ${fmtN(r.na)} attacks`),
    perfect_days: by(rows.filter(r => r.pf > 0), (a, b) => b.pf - a.pf || rankOrder(a, b),
      r => `${fmtN(r.pf)} perfect days`, r => `${fmtN(r.fu)} days with all 8 attacks`),
    zero_defenses: by(rows, (a, b) => b.dz - a.dz || b.nd - a.nd || rankOrder(a, b),
      r => `${fmtN(r.dz)} × 0★`, r => `${fmtN(r.nd)} defenses · −${fmtN(r.d)} trophies`),
    climbers: by(moved, (a, b) => b.delta - a.delta || rankOrder(a, b),
      r => `▲ ${fmtN(Math.abs(r.delta))} places`, r => `#${fmtN(r.r0)} → #${fmtN(r.rank)} · net ${signed(r.net)}`),
    drops: by(moved, (a, b) => a.delta - b.delta || rankOrder(a, b),
      r => `▼ ${fmtN(Math.abs(r.delta))} places`, r => `#${fmtN(r.r0)} → #${fmtN(r.rank)} · net ${signed(r.net)}`),
    fastest_triples: by(S.fast || [], (a, b) => a.time - b.time || rankOrder(a, b),
      r => `${Math.floor(r.time / 60)}:${String(r.time % 60).padStart(2, '0')}`,
      r => `3★ vs ${r.opp || 'Unknown'} · ${r.date || 'date unavailable'}${r.rank ? ` · #${fmtN(r.rank)}` : ''}`),
    giant_killers: by(S.upsets || [], (a, b) => (b.rank - b.oppRank) - (a.rank - a.oppRank) || rankOrder(a, b),
      r => `+${fmtN(r.rank - r.oppRank)} rank gap`,
      r => `3★ vs ${r.opp || 'Unknown'} (#${fmtN(r.oppRank)}) · attacker #${fmtN(r.rank)} · ${r.date || 'date unavailable'}`),
  };
}
function makeContext(files, th19 = false) {
  const stub = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ setAttribute() {}, append() {}, classList: { add() {}, remove() {}, toggle() {} } }), addEventListener() {}, body: { append() {} }, head: { append() {} } };
  const context = vm.createContext({ window: { TH19_MODE: th19 }, document: stub, location: { protocol: 'https:', search: '' }, navigator: {}, setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0), console });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(siteDir, file), 'utf8'), context, { filename: file, timeout: 120000 });
  return context;
}
async function call(context, expression, input) {
  context.__input = input;
  return await vm.runInContext(expression, context, { timeout: 120000 });
}
function eodRanks(data) {
  if (!data?.players) return null;
  return new Map(data.players.map((p, i) => [norm(p.tag), p.rank || i + 1]));
}
function sameSeason(dateA, dateB, anchor, seasonDays) {
  const idx = (d) => Math.floor((Date.parse(`${d}T05:00:00Z`) - 86400000 - anchor) / (seasonDays * 86400000));
  return dateA && dateB && idx(dateA) === idx(dateB);
}

function installArmyDaySummarizer(context) {
  vm.runInContext(`globalThis.__summarizeArmyDay = function(date, players) {
    const armies = {}, openers = {}, equipment = {}, byCode = new Map(); let codedAttacks = 0;
    const add = (map, key, code, triple) => {
      const x = map[key] || (map[key] = { uses: 0, triples: 0, variants: {} });
      x.uses++; if (triple) x.triples++;
      if (code) x.variants[code] = (x.variants[code] || 0) + 1;
    };
    for (const player of Object.values(players || {})) for (const hit of player.attacks || []) {
      const code = hit.armyShareCode; if (!code) continue;
      const info = infoOf(code), triple = Number(hit.stars) === 3; codedAttacks++;
      add(armies, info.group, code, triple);
      add(openers, info.cls.openerRaw || info.cls.opener || 'Unknown Opener', code, triple);
      const t = byCode.get(code) || (byCode.set(code, [0, 0]), byCode.get(code)); t[0]++; if (triple) t[1]++;
    }
    // Equipment is resolved once per distinct army code of the day (not once per attack), then weighted by how often the code was used.
    for (const [code, t] of byCode) {
      const seen = new Set();
      for (const hero of infoOf(code).heroes || []) for (const gear of hero.equip || []) {
        const name = typeof gear === 'string' ? gear : gear && gear.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const e = equipment[name] || (equipment[name] = { uses: 0, triples: 0, hero: hero.name || '' });
        e.uses += t[0]; e.triples += t[1];
      }
    }
    return { date: String(date).slice(0, 10), codedAttacks, armies, openers, equipment };
  };`, context);
}

// Army strategy of the highest avg-offense players + best performers per strategy (feeds /legendstats).
// Strategy names follow the community naming: 15+ Balloons = LaLo, LaLo with a few Dragons = Drag LaLo.
// Everything else keeps the site's own strategy name = opener + army, like the website's "Top performers by strategy" (e.g. 'Zap Backpack + Super Bowler Smash').
const LALO_MIN_BALLOONS = 15, DRAG_LALO_MIN_DRAGONS = 2;
function installArmyPerformers(context) {
  vm.runInContext(`globalThis.__armyPerformers = function(agg, cfg) {
    const { minAttacks, keepPlayers, keepStrategies, keepPerformers, performerMinAttacks, laloBalloons, dragLaloDragons, eligible } = cfg;
    // Only players from the season rows the leaderboards are built from can appear here, and their season totals are read from those
    // same rows, so a performer shown below can always be found (with identical numbers) on the Best avg offense / Average triple rate boards.
    const nt = (t) => String(t || '').replace(/^#/, '').toUpperCase();
    const season = new Map((eligible || []).map((e) => [nt(e[0]), e]));
    const useSeason = season.size > 0 && Object.keys(agg.players || {}).some((t) => season.has(nt(t)));
    const labels = new Map();
    const labelOf = (code) => {
      let hit = labels.get(code); if (hit) return hit;
      const inf = infoOf(code), cls = inf.cls || {}, counts = new Map();
      for (const [id, n] of armyCounts(secOf(code, /u([\\dx-]*)/))) {
        if (isSiegeId(id)) continue;
        const name = (ARMY_IDS.troop[id] || [])[0]; if (name) counts.set(name, (counts.get(name) || 0) + n);
      }
      const balloons = counts.get('Balloon') || 0, dragons = counts.get('Dragon') || 0;
      let label = cls.strategy || 'Unknown Build';
      if (balloons >= laloBalloons) {
        const core = dragons >= dragLaloDragons ? 'Drag LaLo' : 'LaLo', opener = cls.openerRaw || 'Spam Opener';
        label = opener === 'Spam' ? 'Totem Spam + ' + core : opener === 'Spam Opener' ? core : cls.opener + ' + ' + core;
      }
      if (labels.size > 400000) labels.clear();
      labels.set(code, label); return label;
    };
    // Minion Prince's Portal Pendant (hero 6, equipment id 61 in the share codes; the id is not in armyids.js yet).
    const PORTAL_PENDANT_ID = 61;
    const hasPortal = (code) => {
      const m = /^h([\\dmpe_-]+)/.exec(code); if (!m) return false;
      for (const entry of m[1].split('-')) {
        const e = /^6(?:m\\d+)?(?:p\\d+)?(?:e(\\d+)(?:_(\\d+))?)?$/.exec(entry);
        if (e && (+e[1] === PORTAL_PENDANT_ID || +e[2] === PORTAL_PENDANT_ID)) return true;
      }
      return false;
    };
    const SKIP = new Set(['Farming Army', 'Unknown Build', 'Unknown']);
    const strategies = new Map(), rows = [];
    for (const [tag, p] of Object.entries(agg.players || {})) {
      if (!(p.na || p.nd)) continue;
      const srow = useSeason ? season.get(nt(tag)) : null;
      if (useSeason && !srow) continue;
      const sv = srow
        ? { attacks: srow[3] || 0, triples: srow[4] || 0, days: srow[2] || 0, perDay: srow[2] ? +(srow[1] / srow[2]).toFixed(1) : null, rank: srow[5] || 0 }
        : { attacks: p.na || 0, triples: p.s3 || 0, days: p.dy || 0, perDay: p.dy ? +(p.a / p.dy).toFixed(1) : null, rank: p.r || 0 };
      const mine = new Map(); let coded = 0;
      for (const [ci, v] of Object.entries(p.arm || {})) {
        const code = agg.codes[+ci]; if (!code) continue;
        const label = labelOf(code); coded += v[0];
        let m = mine.get(label); if (!m) mine.set(label, (m = { label, n: 0, st: 0, s3: 0, t: 0, code: '', codeN: -1, portal: false }));
        m.n += v[0]; m.st += v[1]; m.s3 += v[2]; m.t += v[3];
        if (v[0] > m.codeN) { m.codeN = v[0]; m.code = code; }
        if (!m.portal && hasPortal(code)) m.portal = true;
        let g = strategies.get(label); if (!g) strategies.set(label, (g = { label, n: 0, st: 0, s3: 0, t: 0, players: new Map(), codes: new Map() }));
        g.n += v[0]; g.st += v[1]; g.s3 += v[2]; g.t += v[3];
        if (g.codes.has(code) || g.codes.size < 300) g.codes.set(code, (g.codes.get(code) || 0) + v[0]);
      }
      for (const m of mine.values()) strategies.get(m.label).players.set(tag, { tag, name: p.n, rank: sv.rank, season: sv, n: m.n, st: m.st, s3: m.s3, t: m.t, code: m.code, portal: m.portal });
      if (p.na >= minAttacks && p.dy > 0) rows.push({ tag, p, mine: [...mine.values()].sort((a, b) => b.n - a.n || b.st - a.st), coded });
    }
    rows.sort((a, b) => b.p.a / b.p.dy - a.p.a / a.p.dy || (a.p.r || 1e9) - (b.p.r || 1e9));
    const avgOffense = rows.slice(0, keepPlayers).map(({ tag, p, mine, coded }) => {
      const top = mine[0] || null;
      return { tag, name: p.n || tag, rank: p.r || 0, perDay: +(p.a / p.dy).toFixed(2), days: p.dy, attacks: p.na, triples: p.s3,
        strategy: top ? top.label : null, strategyAttacks: top ? top.n : 0, share: top && coded ? +(top.n / coded).toFixed(3) : 0,
        tripleRate: top && top.n ? +(100 * top.s3 / top.n).toFixed(1) : null, code: top ? top.code : '', portal: !!(top && top.portal),
        mix: mine.slice(0, 3).map((m) => ({ label: m.label, attacks: m.n })) };
    });
    const mixMap = new Map();
    for (const r of avgOffense) { const k = r.strategy || 'Unknown'; let x = mixMap.get(k); if (!x) mixMap.set(k, (x = { label: k, players: 0, perDay: 0 })); x.players++; x.perDay += r.perDay; }
    const mix = [...mixMap.values()].map((x) => ({ label: x.label, players: x.players, avgPerDay: +(x.perDay / x.players).toFixed(2) })).sort((a, b) => b.players - a.players || b.avgPerDay - a.avgPerDay);
    const topCode = (codes) => { let best = '', bn = -1; for (const [c, n] of codes) if (n > bn) { best = c; bn = n; } return best; };
    const cards = [...strategies.values()].filter((g) => !SKIP.has(g.label)).sort((a, b) => b.n - a.n).slice(0, keepStrategies).map((g) => ({
      label: g.label, players: g.players.size, attacks: g.n, triples: g.s3, tripleRate: +(100 * g.s3 / g.n).toFixed(1), avgStars: +(g.st / g.n).toFixed(2), code: topCode(g.codes),
      performers: [...g.players.values()].filter((x) => x.n >= performerMinAttacks)
        .sort((a, b) => wilson(b.s3, b.n) - wilson(a.s3, a.n) || b.st / b.n - a.st / a.n || b.n - a.n).slice(0, keepPerformers)
        .map((x) => ({ tag: x.tag, name: x.name || x.tag, rank: x.rank, code: x.code, portal: !!x.portal, attacks: x.n, triples: x.s3, tripleRate: +(100 * x.s3 / x.n).toFixed(1), avgStars: +(x.st / x.n).toFixed(2), avgTrophies: +(x.t / x.n).toFixed(1), season: x.season })),
    }));
    const codedAttacks = [...strategies.values()].reduce((n, g) => n + g.n, 0);
    return { minAttacks, performerMinAttacks, laloBalloons, dragLaloDragons, codedAttacks, avgOffense, mix, strategies: cards };
  };`, context);
}

// Triple rate per Legend Day for everyone and for the top 10 / 100 / 1,000 / 5,000 / 10,000 players (feeds /legendstats "Triple rate per day").
// A player belongs to a tier when their season rank (agg.players[tag].r) is within the top N; tiers are cumulative.
const TRIPLE_TIERS = [10, 100, 1000, 5000, 10000];
function summarizeTripleDay(players, rankByTag) {
  const out = { all: [0, 0] };
  for (const t of TRIPLE_TIERS) out[t] = [0, 0];
  for (const [tag, p] of Object.entries(players || {})) {
    const rank = rankByTag.get(norm(tag)) || 0;
    for (const hit of p.attacks || []) {
      const triple = Number(hit.stars) === 3 ? 1 : 0;
      out.all[0]++; out.all[1] += triple;
      if (rank > 0) for (const t of TRIPLE_TIERS) if (rank <= t) { out[t][0]++; out[t][1] += triple; }
    }
  }
  return out;
}
function buildTripleDaily(dates, perDay) {
  const tiers = {};
  for (const key of ['all', ...TRIPLE_TIERS.map(String)]) {
    tiers[key] = { attacks: perDay.map((d) => d[key][0]), triples: perDay.map((d) => d[key][1]) };
  }
  return { dates, tiers };
}

// Display name of an army family key ('family:super bowlers' -> 'Super Bowlers'). Openers never take part in a family.
const FAMILY_NAMES = { throwers: 'Throwers', 'super bowlers': 'Super Bowlers', 'super witches': 'Super Witches', 'super yetis': 'Super Yetis', 'super dragons': 'Super Dragons', 'root riders': 'Root Riders', 'dragon riders': 'Dragon Riders', 'meteor golems': 'Meteor Golems', 'rocket balloons': 'Rocket Balloons', lalo: 'LaLo' };
function familyLabel(key) {
  const family = String(key).replace(/^family:/, '');
  return FAMILY_NAMES[family] || family.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ───── Average offense / defense around every rank (feeds /legendstats "Avg offense & defense by rank") ─────
// For a centre rank R the window is every player ranked R-5 … R+5 (season rank). Offense is the trophies those players gained per 8 attacks
// (a full Legend Day), defense the trophies they lost per 8 defenses, e.g. "+235 / 8" and "−200 / 8" at rank 1,000.
// Centres: rank 1, every 5th rank up to 100, then every 25th rank to the end of the ladder (~14k players -> ~580 points).
const RANK_WINDOW = 5;
const RANK_LADDER_FIELDS = ['rank', 'players', 'attacks', 'defenses', 'off8', 'def8', 'triple'];
function rankLadderCenters(maxRank) {
  const centers = [1];
  for (let r = 5; r <= Math.min(100, maxRank); r += 5) centers.push(r);
  for (let r = 125; r <= maxRank; r += 25) centers.push(r);
  return centers;
}
function computeRankLadder(agg) {
  const rows = Object.entries(agg.players || {}).filter(([, p]) => p.r > 0 && (p.na || p.nd)).map(([tag, p]) => ({ ...p, tag })).sort((a, b) => a.r - b.r);
  if (!rows.length) return null;
  const prefix = (pick) => { const out = [0]; for (const p of rows) out.push(out.at(-1) + (Number(pick(p)) || 0)); return out; };
  const A = prefix((p) => p.a), D = prefix((p) => p.d), NA = prefix((p) => p.na), ND = prefix((p) => p.nd), S3 = prefix((p) => p.s3);
  const firstAtLeast = (rank) => { let lo = 0, hi = rows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].r >= rank) hi = mid; else lo = mid + 1; } return lo; };
  const maxRank = rows.at(-1).r, points = [];
  for (const center of rankLadderCenters(maxRank)) {
    const lo = firstAtLeast(Math.max(1, center - RANK_WINDOW)), hi = firstAtLeast(center + RANK_WINDOW + 1), n = hi - lo;
    const na = NA[hi] - NA[lo], nd = ND[hi] - ND[lo];
    if (!n || na < 8) continue;
    points.push([center, n, na, nd, +(8 * (A[hi] - A[lo]) / na).toFixed(1), nd ? +(8 * (D[hi] - D[lo]) / nd).toFixed(1) : null, +(100 * (S3[hi] - S3[lo]) / na).toFixed(1)]);
  }
  return points.length ? { window: RANK_WINDOW, maxRank, rankedPlayers: rows.length, fields: RANK_LADDER_FIELDS, points, outliers: rankLadderOutliers(points, rows, firstAtLeast) } : null;
}

// ───── Outlier windows: who is behind the spikes and dips on the rank ladder ─────
// A window is an outlier when its offense / defense / triple rate sits far from the local trend. NOTE: ladderOutliers() and
// thinLadderRows() are the same detection the bot (legendstats.js) uses to draw the hollow dots - keep the two copies identical.
// For the 8 biggest outliers the players of the window are stored (name, rank, attacks, per-8 offense / defense, triple rate), so
// the chart can name them instead of just guessing why a point is off.
const medianOf = (arr) => { const s = arr.filter(Number.isFinite).sort((a, b) => a - b), m = s.length >> 1; return !s.length ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function localMedian(rows, i, key) {
  const lo = Math.max(0, i - 6);
  return medianOf(rows.slice(lo, i + 7).filter((_, j) => lo + j !== i).map((r) => Number(r[key])));
}
function thinLadderRows(rows) {
  return new Set(rows.filter((r, i) => {
    const tp = localMedian(rows, i, 'players'), ta = localMedian(rows, i, 'attacks');
    return (tp && r.players < tp * 0.75) || (ta && r.attacks < ta * 0.5);
  }));
}
function ladderOutliers(rows, get, minDev, thin = new Set(), k = 8) {
  const out = new Map();
  rows.forEach((r, i) => {
    const v = Number(get(r));
    if (get(r) == null || !Number.isFinite(v)) return;
    const near = [], pos = (row) => Math.log10(Math.max(1, row.rank));
    for (let j = Math.max(0, i - k); j <= Math.min(rows.length - 1, i + k); j++) {
      const w = j === i ? null : get(rows[j]);
      if (w != null && Number.isFinite(Number(w))) near.push([pos(rows[j]), Number(w)]);
    }
    if (near.length < 5) return;
    const slopes = [];
    for (let a = 0; a < near.length; a++) for (let b = a + 1; b < near.length; b++) { const dq = near[b][0] - near[a][0]; if (dq) slopes.push((near[b][1] - near[a][1]) / dq); }
    const slope = medianOf(slopes), icpt = medianOf(near.map(([q, w]) => w - slope * q));
    const spread = 1.4826 * medianOf(near.map(([q, w]) => Math.abs(w - (slope * q + icpt)))), dev = v - (slope * pos(r) + icpt);
    if (Math.abs(dev) > Math.max(minDev, (thin.has(r) ? 2.5 : 5) * spread)) out.set(r, dev);
  });
  return out;
}
function rankLadderOutliers(points, rows, firstAtLeast) {
  const objs = points.map((p) => Object.fromEntries(RANK_LADDER_FIELDS.map((f, i) => [f, p[i]]))), thin = thinLadderRows(objs);
  const minDev = { off8: 15, def8: 15, triple: 8 };
  const flags = { off8: ladderOutliers(objs, (r) => r.off8, minDev.off8, thin), def8: ladderOutliers(objs, (r) => r.def8, minDev.def8, thin), triple: ladderOutliers(objs, (r) => r.triple, minDev.triple, thin) };
  const sev = new Map();
  for (const [metric, map] of Object.entries(flags)) for (const [r, dev] of map) {
    const score = Math.abs(dev) / minDev[metric], cur = sev.get(r);
    if (!cur || score > cur.score) sev.set(r, { score, metric, dev });
  }
  return [...sev.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 8).map(([r, { metric, dev }]) => {
    const lo = firstAtLeast(Math.max(1, r.rank - RANK_WINDOW)), hi = firstAtLeast(r.rank + RANK_WINDOW + 1);
    const players = rows.slice(lo, hi).map((p) => ({
      tag: p.tag, name: p.n || p.tag, rank: p.r, attacks: p.na || 0, defenses: p.nd || 0,
      off8: p.na ? +(8 * p.a / p.na).toFixed(1) : null, def8: p.nd ? +(8 * p.d / p.nd).toFixed(1) : null, triple: p.na ? +(100 * p.s3 / p.na).toFixed(1) : null,
    }));
    return { rank: r.rank, metric, dev: +dev.toFixed(1), players };
  });
}

// ───── Armies and triple rates inside exact rank bands (feeds /legendstats "Armies by rank range") ─────
// Only players whose season rank lies inside the band count: nothing above or below it. Armies are opener-free army families
// (infoOf(code).group), so Duke Charge and Queen Charge Super Bowlers are one "Super Bowlers" row.
const ARMY_BANDS = [[1, 10], [11, 100], [101, 500], [501, 1000], [1001, 2500], [2501, 5000], [5001, 10000], [10001, Infinity]];
const BAND_TOP_ARMIES = 8;
const bandLabel = (min, max) => (min === 1 ? `Top ${fmtN(max)}` : max === Infinity ? `${fmtN(min)}+` : `${fmtN(min)}–${fmtN(max)}`);
function computeArmyBands(agg, infoOf) {
  const bands = ARMY_BANDS.map(([min, max]) => ({ min, max, players: 0, attacks: 0, defenses: 0, triples: 0, stars: 0, gained: 0, lost: 0, coded: 0, fam: new Map() }));
  const familyOf = new Map();
  const family = (code) => {
    let key = familyOf.get(code);
    if (key === undefined) { try { key = infoOf(code).group; } catch { key = null; } familyOf.set(code, key); }
    return key;
  };
  for (const p of Object.values(agg.players || {})) {
    if (!(p.r > 0) || !(p.na || p.nd)) continue;
    const band = bands.find((b) => p.r >= b.min && p.r <= b.max);
    if (!band) continue;
    band.players++; band.attacks += p.na || 0; band.defenses += p.nd || 0; band.triples += p.s3 || 0; band.stars += p.st || 0; band.gained += p.a || 0; band.lost += p.d || 0;
    const seen = new Set();
    for (const [ci, v] of Object.entries(p.arm || {})) {
      const code = agg.codes[+ci], key = code && family(code);
      if (!key) continue;
      band.coded += v[0];
      let f = band.fam.get(key); if (!f) band.fam.set(key, (f = { key, uses: 0, st: 0, s3: 0, t: 0, players: 0, variants: new Map() }));
      f.uses += v[0]; f.st += v[1]; f.s3 += v[2]; f.t += v[3];
      if (!seen.has(key)) { seen.add(key); f.players++; }
      if (f.variants.has(code) || f.variants.size < 300) f.variants.set(code, (f.variants.get(code) || 0) + v[0]);
    }
  }
  return {
    schema: 1,
    bands: bands.map((b) => {
      const ranked = [...b.fam.values()].sort((x, y) => y.uses - x.uses), top = ranked.slice(0, BAND_TOP_ARMIES), rest = ranked.slice(BAND_TOP_ARMIES);
      return {
        key: `${b.min}-${b.max === Infinity ? 'up' : b.max}`, label: bandLabel(b.min, b.max), min: b.min, max: b.max === Infinity ? null : b.max,
        players: b.players, attacks: b.attacks, defenses: b.defenses, coded: b.coded, triples: b.triples,
        tripleRate: b.attacks ? +(100 * b.triples / b.attacks).toFixed(1) : null, avgStars: b.attacks ? +(b.stars / b.attacks).toFixed(2) : null,
        off8: b.attacks ? +(8 * b.gained / b.attacks).toFixed(1) : null, def8: b.defenses ? +(8 * b.lost / b.defenses).toFixed(1) : null,
        armies: top.map((f) => ({
          key: f.key, label: familyLabel(f.key), uses: f.uses, usageRate: b.coded ? +(100 * f.uses / b.coded).toFixed(1) : 0, players: f.players,
          triples: f.s3, tripleRate: f.uses ? +(100 * f.s3 / f.uses).toFixed(1) : null, avgStars: f.uses ? +(f.st / f.uses).toFixed(2) : null,
          avgTrophies: f.uses ? +(f.t / f.uses).toFixed(1) : null, code: [...f.variants].sort((x, y) => y[1] - x[1])[0]?.[0] || '',
        })),
        otherUses: rest.reduce((n, f) => n + f.uses, 0), otherTriples: rest.reduce((n, f) => n + f.s3, 0), otherArmies: rest.length,
      };
    }),
  };
}

function precomputeArmyTrend(dayRows, { infoOf, OPENER_PARTS }) {
  const dates = dayRows.map((d) => d.date), codedAttacks = dayRows.map((d) => d.codedAttacks || 0), codedTotal = codedAttacks.reduce((a, b) => a + b, 0), armies = new Map(), openers = new Map();
  dayRows.forEach((day, di) => {
    for (const [map, values] of [[armies, day.armies || {}], [openers, day.openers || {}]]) for (const [key, v] of Object.entries(values)) {
      let x = map.get(key); if (!x) map.set(key, (x = { key, uses: 0, triples: 0, variants: new Map(), daily: Array.from({ length: dayRows.length }, () => ({ uses: 0, triples: 0 })) }));
      x.uses += v.uses || 0; x.triples += v.triples || 0; x.daily[di].uses = v.uses || 0; x.daily[di].triples = v.triples || 0;
      for (const [code, n] of Object.entries(v.variants || {})) x.variants.set(code, (x.variants.get(code) || 0) + n);
    }
  });
  const pct = (n, d) => d ? 100 * n / d : 0;
  const armyRows = [...armies.values()].map((x) => {
    const code = [...x.variants].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return { key: x.key, code, label: familyLabel(x.key), uses: x.uses, usageRate: pct(x.uses, codedTotal), triples: x.triples, tripleRate: pct(x.triples, x.uses),
      daily: x.daily.map((v, i) => ({ uses: v.uses, usageRate: pct(v.uses, codedAttacks[i]), triples: v.triples, tripleRate: v.uses ? pct(v.triples, v.uses) : null })) };
  }).sort((a, b) => b.uses - a.uses);
  const openerRows = [...openers.values()].map((x) => {
    const code = [...x.variants].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const info = code ? infoOf(code) : null;
    const iconParts = (OPENER_PARTS[x.key] || []).flatMap(([category, name]) => {
      if (name === '@queen' || name === '@duke' || name === '@rc') {
        const heroName = name === '@queen' ? 'Archer Queen' : name === '@duke' ? 'Dragon Duke' : 'Royal Champion';
        const hero = info?.heroes.find((h) => h.name === heroName);
        return [{ category: 'hero', name: heroName }, ...(hero?.pet ? [{ category: 'pet', name: hero.pet }] : [])];
      }
      if (name === '@revenge') {
        const equip = info?.heroes.find((h) => h.name === 'Dragon Duke')?.equip.find((g) => /revenge/i.test(g));
        return equip ? [{ category: 'equipment', name: equip }] : [];
      }
      return [{ category: category === 'equip' ? 'equipment' : category, name }];
    });
    return { key: x.key, label: x.key, code, iconParts, uses: x.uses, triples: x.triples, tripleRate: pct(x.triples, x.uses), usageRate: pct(x.uses, codedTotal),
      daily: x.daily.map((v, i) => ({ uses: v.uses, triples: v.triples, usageRate: pct(v.uses, codedAttacks[i]), tripleRate: v.uses ? pct(v.triples, v.uses) : null })) };
  }).sort((a, b) => b.uses - a.uses);
  return { dates, codedAttacks, codedAttackTotal: codedTotal, armies: armyRows, openers: openerRows };
}

// Hero equipment usage per Legend Day (feeds /legendstats "Equipment usage"). An attack counts once for every distinct piece it carried,
// so the usage rates (share of attacks with a known army) add up to more than 100%.
const EQUIPMENT_KEEP = 12;
function precomputeEquipmentTrend(dayRows) {
  const dates = dayRows.map((d) => d.date), coded = dayRows.map((d) => d.codedAttacks || 0), total = coded.reduce((a, b) => a + b, 0), map = new Map();
  dayRows.forEach((day, di) => {
    for (const [name, v] of Object.entries(day.equipment || {})) {
      let x = map.get(name); if (!x) map.set(name, (x = { name, hero: v.hero || '', uses: 0, triples: 0, daily: Array.from({ length: dayRows.length }, () => ({ uses: 0, triples: 0 })) }));
      x.uses += v.uses || 0; x.triples += v.triples || 0; x.daily[di].uses = v.uses || 0; x.daily[di].triples = v.triples || 0;
    }
  });
  const pct = (n, d) => d ? +(100 * n / d).toFixed(2) : 0;
  const equipment = [...map.values()].sort((a, b) => b.uses - a.uses).slice(0, EQUIPMENT_KEEP).map((x) => ({
    name: x.name, hero: x.hero, uses: x.uses, triples: x.triples, usageRate: pct(x.uses, total), tripleRate: x.uses ? pct(x.triples, x.uses) : null,
    daily: x.daily.map((v, i) => ({ uses: v.uses, triples: v.triples, usageRate: pct(v.uses, coded[i]), tripleRate: v.uses ? pct(v.triples, v.uses) : null })),
  }));
  return { schema: 1, dates, codedAttacks: coded, codedAttackTotal: total, equipment };
}

async function daily() {
  const idx = readJson(path.join(dataDir, 'battlelogs', 'index.json'));
  const meta = readJson(path.join(dataDir, 'meta.json'));
  const eodDates = meta.endOfDayDates || [], ranksByDate = new Map();
  for (const date of eodDates) {
    const f = path.join(dataDir, 'eod', `${date}.json.gz`);
    if (exists(f)) ranksByDate.set(date, eodRanks(readGz(f)));
  }
  const context = makeContext(['armyids.js', 'army.js', 'legend.js', 'stats.js']);
  const run = async (file, key) => {
    if (!exists(file)) return;
    const raw = readGz(file), start = Date.parse(raw.dayStart), end = Date.parse(raw.dayEnd), wanted = new Date(end).toISOString().slice(0, 10);
    const eodDate = eodDates.includes(wanted) ? wanted : (end > Date.now() ? eodDates.at(-1) : null);
    const ranks = eodDate ? ranksByDate.get(eodDate) || null : null, pi = eodDate ? eodDates.indexOf(eodDate) : -1;
    const prevDate = pi > 0 && sameSeason(eodDate, eodDates[pi - 1], Date.parse('2026-10-05T05:00:00Z'), 28) ? eodDates[pi - 1] : null;
    const prev = prevDate ? ranksByDate.get(prevDate) || null : null;
    const dd = { start, end, generatedAt: raw.generatedAt, players: new Map(Object.entries(raw.players || {}).map(([tag, v]) => [norm(tag), v])) };
    const S = await call(context, 'computeStats(__input.dd, __input.ranks, __input.prev, () => {}, () => false)', { dd, ranks, prev });
    writeGz(`${key}.json.gz`, { schema: 1, kind: 'daily', key, computedAt: isoNow(), sourceGeneratedAt: raw.generatedAt || null, rankDate: eodDate, S });
  };
  await run(path.join(dataDir, 'battlelogs', 'live.json.gz'), 'live');
  for (const a of idx.archives || []) await run(path.join(dataDir, 'battlelogs', `${a.date}.json.gz`), a.date);
}

async function fetchRemoteJson(url, gzip = false) {
  const response = await fetch(`${url}?t=${Date.now()}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const raw = gzip || (bytes[0] === 0x1f && bytes[1] === 0x8b)
    ? zlib.gunzipSync(bytes).toString('utf8')
    : bytes.toString('utf8');
  return JSON.parse(raw);
}

function buildSeasonWintraders(key, dayRows, daysExpected) {
  const battles = new Map(), playerTotals = new Map();
  for (const { date, day } of dayRows) {
    for (const [defenderRaw, player] of Object.entries(day.players || {})) {
      const defenderTag = defenderRaw.startsWith('#') ? defenderRaw : `#${defenderRaw}`;
      for (const h of player.defenses || []) {
        if (Number(h.stars) !== 0) continue;
        const count = playerTotals.get(defenderTag) || { tag: defenderTag, name: player.name || defenderTag, count: 0 };
        count.count++; playerTotals.set(defenderTag, count);
        const attackerTag = String(h.opponentTag || '');
        if (!attackerTag) continue;
        const time = String(h.time || '');
        const id = `${time}|${defenderTag}|${attackerTag}`;
        const battle = battles.get(id) || {
          time, duration: 0, suspicious: false,
          defender: { tag: defenderTag, name: player.name || defenderTag, th: 0 },
          attacker: { tag: attackerTag, name: h.opponentName || attackerTag, th: Number(h.opponentTownHall) || 0 },
          types: ['legend'],
        };
        const duration = Number(h.duration) || 0;
        if (duration > battle.duration) battle.duration = duration;
        battle.suspicious = battle.duration > 0 && battle.duration < 180;
        if (!battle.time) battle.time = `${date}T00:00:00.000Z`;
        battles.set(id, battle);
      }
    }
  }

  const pairs = new Map();
  for (const battle of battles.values()) {
    const key = `${battle.defender.tag}|${battle.attacker.tag}`;
    const pair = pairs.get(key) || { defender: battle.defender, attacker: battle.attacker, battles: [], suspiciousCount: 0 };
    pair.battles.push(battle);
    if (battle.suspicious) pair.suspiciousCount++;
    pairs.set(key, pair);
  }
  const connections = [...pairs.values()].map((pair) => {
    pair.battles.sort((a, b) => a.time.localeCompare(b.time));
    const durations = pair.battles.map((battle) => battle.duration).filter((duration) => duration > 0);
    return {
      defender: pair.defender, attacker: pair.attacker,
      count: pair.battles.length, suspiciousCount: pair.suspiciousCount,
      minDuration: durations.length ? Math.min(...durations) : 0,
      avgDuration: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      first: pair.battles[0].time, last: pair.battles.at(-1).time, battles: pair.battles,
    };
  }).sort((a, b) => b.count - a.count || a.defender.tag.localeCompare(b.defender.tag) || a.attacker.tag.localeCompare(b.attacker.tag));
  const leaders = [...playerTotals.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 100);
  return {
    schema: 1, kind: 'season-wintraders', season: key,
    generatedAt: new Date().toISOString(), days: dayRows.map(({ date }) => date).sort(), daysIncluded: dayRows.length, daysExpected,
    zeroStarDefenses: [...playerTotals.values()].reduce((sum, player) => sum + player.count, 0),
    suspiciousDefenses: connections.reduce((sum, pair) => sum + pair.suspiciousCount, 0),
    leaders, connections,
  };
}

function mergeSeasonWintraders(key, previous, addition, dates, daysExpected) {
  const grouped = new Map();
  for (const battle of [
    ...(previous?.connections || []).flatMap((edge) => edge.battles || []),
    ...addition.connections.flatMap((edge) => edge.battles || []),
  ]) {
    const pairKey = `${battle.defender.tag}|${battle.attacker.tag}`;
    const pair = grouped.get(pairKey) || { defender: battle.defender, attacker: battle.attacker, battles: [], suspiciousCount: 0 };
    pair.battles.push(battle);
    if (battle.suspicious) pair.suspiciousCount++;
    grouped.set(pairKey, pair);
  }
  const connections = [...grouped.values()].map((pair) => {
    pair.battles.sort((a, b) => a.time.localeCompare(b.time));
    const durations = pair.battles.map((battle) => battle.duration).filter((duration) => duration > 0);
    return {
      defender: pair.defender, attacker: pair.attacker,
      count: pair.battles.length, suspiciousCount: pair.suspiciousCount,
      minDuration: durations.length ? Math.min(...durations) : 0,
      avgDuration: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      first: pair.battles[0].time, last: pair.battles.at(-1).time, battles: pair.battles,
    };
  }).sort((a, b) => b.count - a.count || a.defender.tag.localeCompare(b.defender.tag) || a.attacker.tag.localeCompare(b.attacker.tag));
  return {
    schema: 1, kind: 'season-wintraders', season: key,
    generatedAt: new Date().toISOString(), days: dates, daysIncluded: dates.length, daysExpected,
    zeroStarDefenses: (previous?.zeroStarDefenses || 0) + addition.zeroStarDefenses,
    suspiciousDefenses: connections.reduce((sum, pair) => sum + pair.suspiciousCount, 0),
    leaders: [], connections,
  };
}

function seasonWintraderFlow(report) {
  const connections = (report.connections || []).map(({ battles, ...edge }) => edge);
  return {
    schema: report.schema, mapSchema: 2, kind: 'season-wintrader-flow', season: report.season,
    daysIncluded: report.daysIncluded, daysExpected: report.daysExpected,
    zeroStarDefenses: report.zeroStarDefenses, suspiciousDefenses: report.suspiciousDefenses,
    recipients: new Set(connections.map((edge) => edge.defender.tag)).size,
    links: connections.length, connections,
  };
}

async function wintraders() {
  const anchor = Date.parse('2026-10-05T05:00:00Z'), span = 28 * 86400000, current = Math.floor((Date.now() - anchor) / span);
  const repo = 'https://raw.githubusercontent.com/somebody-is-da-goat-6967/coc-leaderboard';
  const keys = [current, current - 1].filter((n) => n >= 0).map((n) => new Date(anchor + n * span).toISOString().slice(0, 10));
  const available = new Set();
  const outDirForReports = path.join(outDir, 'wintraders');
  for (const key of keys) {
    const base = `${repo}/archive-s${key}`;
    const index = await fetchRemoteJson(`${base}/index.json`);
    const dates = [...new Set(index?.days || [])].sort();
    if (!dates.length) { console.log(`[precompute:wintraders] no archived days for ${key}`); continue; }

    const reportPath = path.join(outDirForReports, `${key}.json.gz`);
    const previous = exists(reportPath) ? readGz(reportPath) : null;
    const previousDays = previous?.days || [];
    const missing = previousDays.length ? dates.filter((date) => !previousDays.includes(date))
      : previous?.daysIncluded === dates.length ? [] : dates;
    if (previous && !missing.length && previous.daysIncluded === dates.length) {
      if (!previous.days?.length) {
        previous.days = dates;
        writeGz(`wintraders/${key}.json.gz`, previous);
        const leaderPath = path.join(outDirForReports, `${key}-leaders.json.gz`);
        if (exists(leaderPath)) {
          const leaders = readGz(leaderPath);
          leaders.days = dates;
          writeGz(`wintraders/${key}-leaders.json.gz`, leaders);
        }
      }
      const flowPath = path.join(outDirForReports, `${key}-flow.json.gz`);
      const compact = exists(flowPath) ? readGz(flowPath) : null;
      if (compact?.mapSchema !== 2) writeGz(`wintraders/${key}-flow.json.gz`, seasonWintraderFlow(previous));
      console.log(`[precompute:wintraders] ${key}: unchanged (${dates.length} days)`);
      available.add(key); continue;
    }

    const raw = await fetchRemoteJson(`${base}/season.json.gz`, true);
    if (!raw) { console.log(`[precompute:wintraders] missing season aggregate ${key}`); continue; }
    const dayRows = [];
    for (let i = 0; i < missing.length; i += 6) {
      const batch = missing.slice(i, i + 6);
      const rows = await Promise.all(batch.map(async (date) => {
        const day = await fetchRemoteJson(`${base}/days/${date}.json.gz`, true);
        return day ? { date, day } : null;
      }));
      dayRows.push(...rows.filter(Boolean));
    }
    let flow;
    if (previous?.days?.length) {
      const addition = buildSeasonWintraders(key, dayRows, raw.lengthDays || 28);
      flow = mergeSeasonWintraders(key, previous, addition, [...new Set([...previous.days, ...addition.days])].sort(), raw.lengthDays || 28);
    } else {
      const allRows = dayRows.length === dates.length ? dayRows : (await Promise.all(dates.map(async (date) => {
        const existing = dayRows.find((row) => row.date === date);
        if (existing) return existing;
        const day = await fetchRemoteJson(`${base}/days/${date}.json.gz`, true);
        return day ? { date, day } : null;
      }))).filter(Boolean);
      flow = buildSeasonWintraders(key, allRows, raw.lengthDays || 28);
    }
    flow.leaders = Object.entries(raw.players || {}).map(([tag, player]) => ({
      tag: tag.startsWith('#') ? tag : `#${tag}`, name: player.n || tag, count: Number(player.dz) || 0,
    })).filter((player) => player.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 100);
    writeGz(`wintraders/${key}-leaders.json.gz`, { ...flow, connections: undefined });
    writeGz(`wintraders/${key}.json.gz`, flow);
    writeGz(`wintraders/${key}-flow.json.gz`, seasonWintraderFlow(flow));
    console.log(`[precompute:wintraders] ${key}: processed ${flow.daysIncluded}/${flow.daysExpected} archived days (${missing.length} new)`);
    available.add(key);
  }
  if (exists(outDirForReports)) {
    for (const file of fs.readdirSync(outDirForReports)) {
      const match = file.match(/^(\d{4}-\d\d-\d\d)\.json\.gz$/);
      if (!match) continue;
      available.add(match[1]);
      const flowPath = path.join(outDirForReports, `${match[1]}-flow.json.gz`);
      const compact = exists(flowPath) ? readGz(flowPath) : null;
      if (compact?.mapSchema !== 2) writeGz(`wintraders/${match[1]}-flow.json.gz`, seasonWintraderFlow(readGz(path.join(outDirForReports, file))));
    }
  }
  const seasons = [...available].sort().reverse();
  const manifestPath = path.join(outDirForReports, 'index.json');
  const previousManifest = exists(manifestPath) ? readJson(manifestPath) : null;
  if (!previousManifest || JSON.stringify(previousManifest.seasons || []) !== JSON.stringify(seasons)) {
    writeJson('wintraders/index.json', { schema: 1, kind: 'season-wintraders-index', seasons });
  }
}

async function season() {
  const anchor = Date.parse('2026-10-05T05:00:00Z'), span = 28 * 86400000, current = Math.floor((Date.now() - anchor) / span);
  const repo = 'https://raw.githubusercontent.com/somebody-is-da-goat-6967/coc-leaderboard';
  for (const n of [current, current - 1]) {
    const key = new Date(anchor + n * span).toISOString().slice(0, 10), url = `${repo}/archive-s${key}/season.json.gz`;
    const raw = await fetchRemoteJson(url, true);
    if (!raw) { console.log(`[precompute:season] missing season ${key}`); continue; }
    // A fresh VM per season: the army decoder caches every share code it sees, and two seasons in one VM exhausted the heap.
    const context = makeContext(['armyids.js', 'army.js', 'legend.js', 'season.js']);
    installArmyDaySummarizer(context);
    installArmyPerformers(context);
    const S = await call(context, 'computeSeason(__input.agg, () => {}, () => false)', { agg: raw });
    const archiveBase = `${repo}/archive-s${key}`;
    const archiveDates = (raw.days || []).map((d) => String(d).slice(0, 10)).sort();
    const rankByTag = new Map(Object.entries(raw.players || {}).map(([tag, p]) => [norm(tag), Number(p.r) || 0]));
    const dayRows = [], tripleDays = [];
    for (const date of archiveDates) {
      const local = path.join(dataDir, `archive-s${key}`, 'days', `${date}.json.gz`);
      let dayRaw;
      if (exists(local)) dayRaw = readGz(local);
      else dayRaw = await fetchRemoteJson(`${archiveBase}/days/${date}.json.gz`, true);
      if (!dayRaw) throw new Error(`Could not load archived season battlelog ${date}.`);
      dayRows.push(await call(context, '__summarizeArmyDay(__input.date, __input.players)', { date, players: dayRaw.players || {} }));
      tripleDays.push(summarizeTripleDay(dayRaw.players || {}, rankByTag));
    }
    if (!dayRows.length) throw new Error(`No saved battlelog days found for season ${key}.`);
    S.armyTrend = precomputeArmyTrend(dayRows, vm.runInContext('({ infoOf, OPENER_PARTS })', context));
    const equipmentTrend = precomputeEquipmentTrend(dayRows);
    const tripleDaily = buildTripleDaily(dayRows.map((d) => d.date), tripleDays);
    const rankLadder = computeRankLadder(raw);
    const armyBands = computeArmyBands(raw, vm.runInContext('infoOf', context));
    const armyPerformers = await call(context, '__armyPerformers(__input.agg, __input.cfg)', { agg: raw, cfg: { minAttacks: 8, keepPlayers: 50, keepStrategies: 12, keepPerformers: 3, performerMinAttacks: 10, laloBalloons: LALO_MIN_BALLOONS, dragLaloDragons: DRAG_LALO_MIN_DRAGONS,
      eligible: (S.rows || []).map((r) => [r.tag, r.a, r.dy, r.na, r.s3, r.rank]) } });
    console.log(`[precompute:season] ${key}: ${dayRows.length} days, ${S.armyTrend.armies.length} armies, ${S.armyTrend.openers.length} openers`);
    writeGz(`${key}.json.gz`, { schema: 2, kind: 'season', key, computedAt: isoNow(), sourceGeneratedAt: raw.generatedAt || null, S });
    writeJson(`leaderboards/${key}.json`, {
      schema: 1, kind: 'season-leaderboards', key, season: S.agg?.season || key,
      days: S.agg?.days?.length || 0, lengthDays: S.agg?.lengthDays || 28,
      computedAt: isoNow(), sourceGeneratedAt: raw.generatedAt || null,
      leaderboards: seasonLeaderboards(S),
      armyTrend: S.armyTrend,
      equipmentTrend,
      armyPerformers,
      tripleDaily,
      rankLadder,
      armyBands,
    });

  }
}

async function townhall() {
  const ranked = path.join(rankedDir, 'ranked'), current = readJson(path.join(ranked, 'current.json'));
  const base = 'https://raw.githubusercontent.com/somebody-is-da-goat-6967/coc-leaderboard';
  const now = Date.now(), currStart = Date.parse(current.start), currLen = Date.parse(current.end) - currStart;
  for (const th19 of [false, true]) {
    const max = th19 ? 19 : 17, rkn = max - 7 + 1, context = makeContext(['armyids.js', 'army.js', 'legend.js', 'stats.js', 'townhall.js'], th19);
    for (let wi = 0; wi < 2; wi++) {
      const start = currStart - wi * 7 * 86400000, week = { key: new Date(start).toISOString().slice(0, 10), start, end: start + currLen, cur: wi === 0 };
      const weekDir = path.join(ranked, week.key, 'shards'), metaFile = path.join(ranked, week.key, 'stats', 'meta.json');
      const sourceMeta = exists(metaFile) ? readJson(metaFile) : current;
      const getShard = async (th) => {
        const local = path.join(weekDir, `th${th}.json.gz`);
        if (exists(local)) return readGz(local);
        const paths = [`${base}/ranked-data/ranked/${week.key}/shards/th${th}.json.gz`, `${base}/ranked-archive-${week.key}/shards/th${th}.json.gz`];
        for (const url of paths) { const r = await fetch(url); if (r.status === 404) continue; if (!r.ok) throw new Error(`TH${th} ${week.key}: HTTP ${r.status}`); return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8')); }
        return null;
      };
      const shards = new Map();
      for (const th of [0, ...Array.from({ length: rkn }, (_, i) => i + 7)]) shards.set(th, await getShard(th));
      for (const sel of ['all', ...Array.from({ length: rkn }, (_, i) => String(i + 7))]) {
        const requested = sel === 'all' ? [0, ...Array.from({ length: rkn }, (_, i) => i + 7)] : [+sel], sets = requested.map((th) => ({ th, raw: shards.get(th) })).filter((x) => x.raw);
        if (!sets.length) continue;
        const S = await call(context, 'rkCompute(__input.sets, __input.week, () => {}, () => false)', { sets, week });
        const sourceGeneratedAt = week.cur ? (current.updatedAt || sourceMeta.generatedAt || new Date(now).toISOString()) : new Date(week.end).toISOString(), key = `${week.key}/${th19 ? 'th19' : 'th17'}-${sel}.json.gz`;
        writeGz(key, { schema: 1, kind: 'townhall', week: week.key, scope: sel, mode: th19 ? 'th19' : 'th17', computedAt: isoNow(), sourceGeneratedAt, S });
      }
    }
  }
}

if (mode === 'daily') await daily();
else if (mode === 'season') await season();
else if (mode === 'wintraders') await wintraders();
else await townhall();
