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
  const context = makeContext(['armyids.js', 'army.js', 'legend.js', 'season.js']);
  const anchor = Date.parse('2026-10-05T05:00:00Z'), span = 28 * 86400000, current = Math.floor((Date.now() - anchor) / span);
  const repo = 'https://raw.githubusercontent.com/somebody-is-da-goat-6967/coc-leaderboard';
  for (const n of [current, current - 1]) {
    const key = new Date(anchor + n * span).toISOString().slice(0, 10), url = `${repo}/archive-s${key}/season.json.gz`;
    const raw = await fetchRemoteJson(url, true);
    if (!raw) { console.log(`[precompute:season] missing season ${key}`); continue; }
    const S = await call(context, 'computeSeason(__input.agg, () => {}, () => false)', { agg: raw });
    writeGz(`${key}.json.gz`, { schema: 1, kind: 'season', key, computedAt: isoNow(), sourceGeneratedAt: raw.generatedAt || null, S });
    writeJson(`leaderboards/${key}.json`, {
      schema: 1, kind: 'season-leaderboards', key, season: S.agg?.season || key,
      days: S.agg?.days?.length || 0, lengthDays: S.agg?.lengthDays || 28,
      computedAt: isoNow(), sourceGeneratedAt: raw.generatedAt || null,
      leaderboards: seasonLeaderboards(S),
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
