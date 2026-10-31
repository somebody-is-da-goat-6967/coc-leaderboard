#!/usr/bin/env node
'use strict';
// analyze-ranked.js - turns the crawl-ranked-week shards into small, ready-to-read stats files.
// Runs in a GitHub Action (no dependencies, Node 18+). Needs the site's armyids.js, army.js and stats.js (found under --src, or set SITE_DIR). The bot then downloads ONE tiny player file
// instead of whole town hall shards.
//
// Input  (ranked-data branch):  ranked/<week>/shards/th<N>.json.gz   (same format townhallStats.js reads)
// Output (ranked-data branch):  ranked/<week>/stats/
//     meta.json              week, thresholds, definitions, id -> name table, input hash
//     summary.json           G totals for every scope (all + each town hall)
//     scopes/th<N>.json      G totals + top lists for one town hall      (scopes/all.json = everyone)
//     armies/th<N>.json      armies, hero line-ups, openers, strategies (+ top performers), Dragon Duke, siege, troop/spell/pet/equipment usage
//     players/<xx>.json.gz   one file per last-two-characters-of-tag; tag -> full player record with ranks
//   ranked/stats-current.json  pointer to the newest week that has stats
//
// Usage: node scanner/analyze-ranked.js --data <ranked-data checkout> [--src <repo root>] [--week auto|YYYY-MM-DD]
//                                       [--archive <dir with shards/>] [--force]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const crypto = require('crypto');

// ---------- config ----------
const SCHEMA = 1;
const MIN_TH = 7, MAX_TH = 17;
const MIN_ATK = 10, MIN_DEF = 10;          // attacks / defenses needed to be "qualified" for attack / defense ranks
const DEFAULT_MAX_ATK = 30;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_N = 10;                          // rows in each top list
const MAX_GROUPS = 100, MAX_BEST_GROUPS = 40, MAX_VARIANTS = 10;
const PLAYER_ARMIES = 3, PLAYER_OPENERS = 3;
const STRAT_SHOW = 12, STRAT_ROWS = 10, MIN_STRAT_ATK = 10;   // same as the site's Top performers by strategy

// Lowest town hall that can bring each thing (same table townhallStats.js uses). An attack that holds something its
// town hall can't have was made after an upgrade, so it belongs to a higher town hall and is dropped.
const MIN_TH_HERO = { 0: 7, 1: 8, 2: 11, 4: 13 };
const MIN_TH_PET = { 10: 16, 11: 16, 16: 17 };
const MIN_TH_UNIT = { 132: 16, 135: 16 };
const MIN_TH_SPELL = { 98: 17, 120: 18 };
const ATK_BY_LEAGUE = [[/^(skeleton|barbarian)/, 6], [/^(archer|wizard)/, 8], [/^(valkyrie|witch)/, 10], [/^(golem|pekka|titan)/, 12], [/^dragon/, 14], [/^electro/, 18]];

// ---------- args ----------
function parseArgs(argv) {
  const o = { data: 'data', src: '.', week: 'auto', archive: '', force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}

// ---------- helpers ----------
const normTag = t => { const s = String(t ?? '').trim().toUpperCase(); return s.startsWith('#') ? s : `#${s}`; };
const cleanName = (s, fb) => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, '').replace(/\s+/g, ' ').trim() || fb;
const dateKey = ms => new Date(ms).toISOString().slice(0, 10);
const r1 = v => Math.round(v * 10) / 10;
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

function wilson(k, n) { // lower bound of the 95% Wilson interval: a 3-star rate that accounts for sample size
  if (!n) return 0;
  const z = 1.96, p = k / n;
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
}
function maxAttacks(leagueName) {
  const n = String(leagueName || '').trim().toLowerCase().replace(/\./g, '');
  if (n.startsWith('legend')) return /(iii|3)\s*$/.test(n) ? 24 : 30;
  for (const [re, v] of ATK_BY_LEAGUE) if (re.test(n)) return v;
  return DEFAULT_MAX_ATK;
}
const readGz = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); }
function writeGz(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(obj), { level: 9 })); }

// ---------- the website's own army decoder ----------
// armyids.js + army.js + stats.js (from the site in this repo) are run headless, so armies, hero line-ups, openers and
// strategy names are decoded EXACTLY like the Legend Day / Town Hall pages do it. Nothing is duplicated here.
function findFile(root, name, depth = 4) {
  let found = null;
  (function walk(dir, d) {
    if (found || d > depth) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isFile() && e.name === name) { found = path.join(dir, e.name); return; }
    for (const e of ents) if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') walk(path.join(dir, e.name), d + 1);
  })(root, 0);
  return found;
}
let SITE = null;
function loadSite(srcDir) {
  const names = ['armyids.js', 'army.js', 'stats.js'];
  // each file: explicit env path, then SITE_DIR, then anywhere in the checkout
  const files = names.map(n => process.env['SITE_' + n.replace('.js', '').toUpperCase()]
    || (process.env.SITE_DIR && findFile(process.env.SITE_DIR, n, 6)) || findFile(srcDir, n, 8));
  const miss = names.filter((n, i) => !files[i]);
  if (miss.length) throw new Error(`site files not found in ${srcDir}: ${miss.join(', ')}. They must be on the branch the workflow checks out (set SITE_DIR if they sit in an unusual place).`);
  const stub = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : stub()), apply: () => stub(), construct: () => stub(), set: () => true });
  const ctx = vm.createContext({ console, document: stub(), window: stub(), navigator: stub(), location: stub(), localStorage: stub(), sessionStorage: stub(), innerWidth: 1000, setTimeout, clearTimeout, URL });
  for (const f of files) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f, timeout: 10000 });
  const api = vm.runInContext('({ canonCode, infoOf, tallyArmyStats, noteStratPlayer, ARMY_IDS, topCode })', ctx);
  const hash = sha1(files.map(f => fs.readFileSync(f)).reduce((x, y) => Buffer.concat([x, y]), Buffer.alloc(0)));
  return { ...api, files: files.map(f => path.relative(srcDir, f)), hash };
}

// ---------- army helpers ----------

const minThCache = new Map();
function armyMinTh(code) {
  if (!code) return 0;
  if (minThCache.has(code)) return minThCache.get(code);
  let m = 0;
  const up = t => { if (t > m) m = t; };
  const heroSec = /^h([\dpem_-]*)/.exec(code)?.[1] || '';
  for (const e of heroSec.split('-')) {
    const x = /^(\d+)(?:m\d+)?(?:p(\d+))?/.exec(e);
    if (!x) continue;
    up(MIN_TH_HERO[+x[1]] || 0);
    if (x[2] != null) up(MIN_TH_PET[+x[2]] || 0);
  }
  const pairs = re => (re.exec(code)?.[1] || '').split('-').map(p => /^(\d+)x(\d+)$/.exec(p)).filter(Boolean).map(p => +p[2]);
  for (const id of pairs(/u([\dx-]*)/)) up(MIN_TH_UNIT[id] || 0);
  for (const id of pairs(/s([\dx-]*)/)) up(MIN_TH_SPELL[id] || 0);
  if (minThCache.size > 20000) minThCache.clear();
  minThCache.set(code, m);
  return m;
}

const infoCache = new Map(); // raw code -> { cd (canonical code), inf (site info) }
function infoOf(code) {
  let h = infoCache.get(code);
  if (!h) {
    const cd = SITE.canonCode(code);
    h = { cd, inf: SITE.infoOf(cd) };
    if (infoCache.size > 50000) infoCache.clear();
    infoCache.set(code, h);
  }
  return h;
}
const idName = (cat, id) => (SITE.ARMY_IDS[cat][id] || [`#${id}`])[0];
const groupLabel = key => (key ? key.split(',').map(id => idName('troop', id)).join(' + ') : 'No troops');

// ---------- accumulators ----------
const mkG = () => ({ tracked: 0, players: 0, active: 0, att: 0, st: 0, s3: 0, pct: 0, def: 0, dz: 0, dst: 0, dur: 0, durN: 0, locked: 0, astars: [0, 0, 0, 0], dstars: [0, 0, 0, 0] });
const mkScope = () => ({
  G: mkG(), withCode: 0, noCode: 0, groups: new Map(), siege: new Map(),
  noSiege: { n: 0, st: 0, s3: 0, pct: 0 }, hero: new Map(), opener: new Map(), strat: new Map(),   // hero / opener / strat are filled by the site's tallyArmyStats
  duke: [0, 1].map(() => ({ n: 0, st: 0, s3: 0, pct: 0 })),
  comp: { troop: new Map(), spell: new Map(), pet: new Map(), equip: new Map() },
});
const cnt = (m, k, st, s3, pc) => { let c = m.get(k); if (!c) m.set(k, (c = { n: 0, st: 0, s3: 0, pct: 0 })); c.n++; c.st += st; c.s3 += s3; c.pct += pc; };

// ---------- week handling ----------
function weekList(dataDir, which) {
  if (which && which !== 'auto') return [which];
  let start = null;
  try { start = Date.parse(JSON.parse(fs.readFileSync(path.join(dataDir, 'ranked', 'current.json'), 'utf8')).start); } catch { /* fall through */ }
  if (!Number.isFinite(start)) { const anchor = 1791781200 * 1000, now = Date.now(); start = anchor + Math.floor((now - anchor) / WEEK_MS) * WEEK_MS; }
  return [dateKey(start), dateKey(start - WEEK_MS)];
}
function readCurrent(dataDir) { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'ranked', 'current.json'), 'utf8')); } catch { return null; } }

// ---------- ranking ----------
// Every metric: has = player has the data at all, qual = enough games to be ranked "officially", cmp = better first.
// Unqualified players still get a rank: where they would land among the qualified ones, flagged q = 0.
const METRICS = {
  global:  { has: r => r.hasLg, qual: r => r.hasLg, cmp: (a, b) => b.lid - a.lid || b.tr - a.tr },
  league:  { has: r => r.hasLg, qual: r => r.hasLg, cmp: (a, b) => b.tr - a.tr, sub: r => r.lid },
  attack:  { has: r => r.na > 0, qual: r => r.na >= MIN_ATK, cmp: (a, b) => b.w3 - a.w3 || b.na - a.na },
  stars:   { has: r => r.na > 0, qual: r => r.na >= MIN_ATK, cmp: (a, b) => b.st / b.na - a.st / a.na || b.na - a.na },
  most3:   { has: r => r.na > 0, qual: r => r.na > 0, cmp: (a, b) => b.s3 - a.s3 || b.na - a.na },
  defense: { has: r => r.nd > 0, qual: r => r.nd >= MIN_DEF, cmp: (a, b) => a.dst / a.nd - b.dst / b.nd || b.nd - a.nd },
  zero:    { has: r => r.nd > 0, qual: r => r.nd > 0, cmp: (a, b) => b.dz - a.dz || b.nd - a.nd },
  fastest: { has: r => r.fast != null, qual: r => r.fast != null, cmp: (a, b) => a.fast - b.fast },
};
const tieCmp = (a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);

// rows: array; groupFn: which pool a row belongs to (town hall, or everyone). Returns { ranks: Map(tag -> {metric: [rank,total,q]}), lists: Map(pool -> {metric: sortedRows}) }
function rankPools(rows, groupFn) {
  const pools = new Map();
  for (const r of rows) { const g = groupFn(r); if (g == null) continue; (pools.get(g) || pools.set(g, []).get(g)).push(r); }
  const ranks = new Map(), lists = new Map();
  for (const [g, pool] of pools) {
    const L = {};
    for (const [name, M] of Object.entries(METRICS)) {
      // sub-pools (league rank is within one league)
      const subs = new Map();
      for (const r of pool) { if (!M.has(r)) continue; const k = M.sub ? M.sub(r) : 0; (subs.get(k) || subs.set(k, []).get(k)).push(r); }
      for (const [, members] of subs) {
        const qual = members.filter(M.qual).sort((a, b) => M.cmp(a, b) || tieCmp(a, b));
        const pos = new Map(); qual.forEach((r, i) => pos.set(r.tag, i));
        for (const r of members) {
          let rank, q = 1;
          if (pos.has(r.tag)) rank = pos.get(r.tag) + 1;
          else { // binary search: first qualified row that is not better than r
            q = 0; let lo = 0, hi = qual.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (M.cmp(qual[mid], r) < 0) lo = mid + 1; else hi = mid; }
            rank = lo + 1;
          }
          const o = ranks.get(r.tag) || ranks.set(r.tag, {}).get(r.tag);
          o[name] = [rank, qual.length, q];
        }
        if (!M.sub) L[name] = qual;
      }
    }
    lists.set(g, L);
  }
  return { ranks, lists };
}

const topRow = r => ({ tag: r.tag, name: r.name, th: r.th, na: r.na, nd: r.nd, st: r.st, s3: r.s3, pct: r.pct, dz: r.dz, d3: r.d3, dst: r.dst, fast: r.fast, tr: r.tr, ln: r.ln });
const tops = L => ({
  attack: (L.attack || []).slice(0, TOP_N).map(topRow), stars: (L.stars || []).slice(0, TOP_N).map(topRow),
  most3: (L.most3 || []).slice(0, TOP_N).map(topRow), defense: (L.defense || []).slice(0, TOP_N).map(topRow),
  zero: (L.zero || []).slice(0, TOP_N).map(topRow), fastest: (L.fastest || []).slice(0, TOP_N).map(topRow),
});

// ---------- one week ----------
function processWeek(opts, key) {
  const root = path.join(opts.data, 'ranked', key);
  let shardDir = path.join(root, 'shards');
  if (!fs.existsSync(shardDir) && opts.archive && fs.existsSync(path.join(opts.archive, 'shards'))) shardDir = path.join(opts.archive, 'shards');
  if (!fs.existsSync(shardDir)) { console.log(`[analyze] ${key}: no shards, skipping`); return null; }
  const files = fs.readdirSync(shardDir).map(f => /^th(\d+)\.json\.gz$/.exec(f)).filter(Boolean).map(m => ({ th: +m[1], file: path.join(shardDir, m[0]) }))
    .sort((a, b) => (a.th === 0) - (b.th === 0) || a.th - b.th); // th0 (unknown town hall) last so a real town hall wins on duplicates
  if (!files.length) { console.log(`[analyze] ${key}: shard folder is empty, skipping`); return null; }

  if (!SITE) SITE = loadSite(opts.src);
  const bufs = files.map(f => ({ ...f, hash: sha1(fs.readFileSync(f.file)) }));
  const inputHash = sha1(JSON.stringify([SCHEMA, bufs.map(b => [b.th, b.hash]), SITE.hash]));
  const statsDir = path.join(root, 'stats');
  try {
    const old = JSON.parse(fs.readFileSync(path.join(statsDir, 'meta.json'), 'utf8'));
    if (!opts.force && old.inputHash === inputHash) { console.log(`[analyze] ${key}: inputs unchanged, skipping`); return { key, skipped: true }; }
  } catch { /* no previous stats */ }

  const cur = readCurrent(opts.data);
  const start = cur && dateKey(Date.parse(cur.start)) === key ? Date.parse(cur.start) : Date.parse(key + 'T05:00:00Z');
  const week = { key, start, end: cur && dateKey(Date.parse(cur.start)) === key ? Date.parse(cur.end) : start + WEEK_MS };

  const SC = { all: mkScope() };
  for (let t = MIN_TH; t <= MAX_TH; t++) SC['th' + t] = mkScope();
  const rows = [], extra = new Map(); // extra: tag -> { ah, dh, armies, openers }
  const seen = new Set();

  for (const { th, file } of bufs) {
    const raw = readGz(file);
    for (const [tag0, rec] of Object.entries(raw)) {
      const tag = normTag(tag0);
      if (seen.has(tag)) continue;
      seen.add(tag);
      const pth = rec.th || th;
      const targets = [SC.all]; if (pth >= MIN_TH && pth <= MAX_TH) targets.push(SC['th' + pth]);

      const att = [], def = [];
      let ix = 0;
      for (const r of rec.b || []) {
        const h = { ix: ix++, ts: r[0] || r[7] || 0, stars: Math.max(0, Math.min(3, r[2] || 0)), pct: r[3] || 0, time: r[8] || 0, code: r[5] || '' };
        (r[1] ? att : def).push(h);
      }
      let locked = 0;
      if (pth) for (let i = att.length - 1; i >= 0; i--) if (att[i].code && armyMinTh(att[i].code) > pth) { att.splice(i, 1); locked++; }
      const mx = rec.lg ? maxAttacks(rec.lg[1]) : DEFAULT_MAX_ATK;
      att.sort((x, y) => x.ts - y.ts || y.ix - x.ix);
      if (att.length > mx) att.splice(0, att.length - mx);

      const row = {
        tag, name: cleanName(rec.n, tag), th: pth,
        lid: rec.lg ? rec.lg[0] || 0 : 0, ln: rec.lg ? rec.lg[1] || 'Unranked' : null, hasLg: !!rec.lg, tr: rec.tr || 0,
        mx, ga: rec.gw ? rec.gw[0] + rec.gw[1] : null,
        na: att.length, nd: def.length, st: 0, s3: 0, pct: 0, dz: 0, dst: 0, d3: 0, dur: 0, durN: 0, fast: null,
        ah: [0, 0, 0, 0], dh: [0, 0, 0, 0],
      };
      for (const t of targets) { t.G.tracked++; t.G.locked += locked; }

      const myArmy = new Map(); // code -> [uses, stars, 3stars, destruction, seconds]
      const myOpen = new Map(), myStrat = new Map(); // opener / strategy name -> [n, stars, 3stars]
      for (const h of att) {
        const s3 = h.stars === 3 ? 1 : 0;
        row.st += h.stars; row.s3 += s3; row.pct += h.pct; row.ah[h.stars]++;
        if (h.time > 0) { row.dur += h.time; row.durN++; if (s3 && (row.fast == null || h.time < row.fast)) row.fast = h.time; }
        for (const t of targets) {
          const G = t.G;
          G.att++; G.st += h.stars; G.pct += h.pct; G.s3 += s3; G.astars[h.stars]++;
          if (h.time > 0) { G.dur += h.time; G.durN++; }
        }
        if (!h.code) { for (const t of targets) t.noCode++; continue; }
        const { cd, inf } = infoOf(h.code);
        for (const t of targets) {
          t.withCode++;
          const x = t.duke[inf.duke ? 1 : 0]; x.n++; x.st += h.stars; x.s3 += s3; x.pct += h.pct;
          SITE.tallyArmyStats(t, inf, cd, 1, h.stars, s3); SITE.noteStratPlayer(t, inf, tag, row.name, 0, 1, h.stars, s3, h.pct);
          if (inf.siege.length) for (const id of inf.siege) cnt(t.siege, id, h.stars, s3, h.pct);
          else { t.noSiege.n++; t.noSiege.st += h.stars; t.noSiege.s3 += s3; t.noSiege.pct += h.pct; }
          const parts = inf.key.split('|').map(x => (x ? x.split(',').map(Number) : []));
          for (const id of parts[0]) cnt(t.comp.troop, id, h.stars, s3, h.pct);
          for (const id of parts[1]) cnt(t.comp.spell, id, h.stars, s3, h.pct);
          for (const nme of inf.pets) cnt(t.comp.pet, nme, h.stars, s3, h.pct);
          for (const nme of inf.eq) cnt(t.comp.equip, nme, h.stars, s3, h.pct);
        }
        const a = myArmy.get(cd) || myArmy.set(cd, [0, 0, 0, 0, 0]).get(cd);
        a[0]++; a[1] += h.stars; a[2] += s3; a[3] += h.pct; a[4] += h.time || 0;
        for (const [m, k] of [[myOpen, inf.cls.openerRaw], [myStrat, inf.cls.strategy]]) { const o = m.get(k) || m.set(k, [0, 0, 0]).get(k); o[0]++; o[1] += h.stars; o[2] += s3; }
      }
      for (const h of def) {
        row.dst += h.stars; row.dh[h.stars]++; if (h.stars === 0) row.dz++; if (h.stars === 3) row.d3++;
        for (const t of targets) { t.G.def++; t.G.dst += h.stars; t.G.dstars[h.stars]++; if (h.stars === 0) t.G.dz++; }
      }
      if (row.na || row.nd) for (const t of targets) t.G.players++;
      if (row.na >= MIN_ATK) for (const t of targets) t.G.active++;
      row.w3 = wilson(row.s3, row.na);

      // armies: group similar codes (same main-army troop types); the player's most used group is "their army"
      const groups = new Map();
      for (const [code, x] of myArmy) {
        const k = SITE.infoOf(code).group;
        let g = groups.get(k); if (!g) groups.set(k, (g = { key: k, v: [0, 0, 0, 0, 0], codes: [] }));
        x.forEach((n, i) => { g.v[i] += n; }); g.codes.push([code, x]);
      }
      const gl = [...groups.values()].sort((p, q) => q.v[0] - p.v[0] || q.v[1] - p.v[1]);
      for (const g of gl) g.codes.sort((p, q) => q[1][0] - p[1][0] || q[1][1] - p[1][1]);
      if (gl.length) {
        const best = gl[0];
        for (const t of targets) {
          let g = t.groups.get(best.key); if (!g) t.groups.set(best.key, (g = { key: best.key, players: 0, uses: 0, st: 0, s3: 0, pc: 0, dur: 0, vars: new Map() }));
          g.players++; g.uses += best.v[0]; g.st += best.v[1]; g.s3 += best.v[2]; g.pc += best.v[3]; g.dur += best.v[4];
          for (const [code, x] of best.codes) {
            let v = g.vars.get(code); if (!v) g.vars.set(code, (v = { code, players: 0, uses: 0, st: 0, s3: 0, pc: 0, dur: 0 }));
            v.players++; v.uses += x[0]; v.st += x[1]; v.s3 += x[2]; v.pc += x[3]; v.dur += x[4];
          }
        }
      }
      extra.set(tag, {
        armies: gl.slice(0, PLAYER_ARMIES).map(g => ({ key: g.key, label: groupLabel(g.key), code: g.codes[0][0], uses: g.v[0], st: g.v[1], s3: g.v[2], pct: g.v[3], dur: g.v[4] })),
        openers: [...myOpen].sort((p, q) => q[1][0] - p[1][0] || q[1][1] - p[1][1]).slice(0, PLAYER_OPENERS).map(([k, x]) => ({ name: k, n: x[0], st: x[1], s3: x[2] })),
        strategies: [...myStrat].sort((p, q) => q[1][0] - p[1][0] || q[1][1] - p[1][1]).slice(0, PLAYER_OPENERS).map(([k, x]) => ({ name: k, n: x[0], st: x[1], s3: x[2] })),
      });
      rows.push(row);
    }
  }

  // ----- ranks -----
  const thPool = rankPools(rows, r => (r.th >= MIN_TH && r.th <= MAX_TH ? r.th : null));
  const allPool = rankPools(rows, () => 'all');

  // ----- write -----
  fs.rmSync(statsDir, { recursive: true, force: true });
  const generatedAt = new Date().toISOString();
  const pack = x => ({ n: x.n, st: x.st, s3: x.s3, pct: x.pct });
  const gSummary = {};
  for (const [k, t] of Object.entries(SC)) gSummary[k] = t.G;
  writeJson(path.join(statsDir, 'summary.json'), { schema: SCHEMA, week, generatedAt, scopes: gSummary });

  for (const [k, t] of Object.entries(SC)) {
    const L = k === 'all' ? allPool.lists.get('all') : thPool.lists.get(+k.slice(2));
    if (!t.G.tracked) continue;
    writeJson(path.join(statsDir, 'scopes', `${k}.json`), { schema: SCHEMA, scope: k, week, generatedAt, G: t.G, tops: L ? tops(L) : tops({}) });

    // armies: top by players + best 3★ rate (min players / attacks), so "best armies" lists have material too
    const minP = Math.max(2, Math.min(5, Math.round(t.withCode / 100)));
    const all = [...t.groups.values()];
    const byUse = [...all].sort((a, b) => b.players - a.players || b.uses - a.uses).slice(0, MAX_GROUPS);
    const byRate = all.filter(g => g.players >= minP && g.uses >= 10).sort((a, b) => wilson(b.s3, b.uses) - wilson(a.s3, a.uses) || b.uses - a.uses).slice(0, MAX_BEST_GROUPS);
    const chosen = [...new Set([...byUse, ...byRate])];
    const grp = g => ({
      key: g.key, label: groupLabel(g.key), ids: g.key ? g.key.split(',').map(Number) : [], players: g.players, uses: g.uses, st: g.st, s3: g.s3, pct: g.pc, dur: g.dur,
      code: [...g.vars.values()].sort((a, b) => b.players - a.players || b.uses - a.uses)[0].code, variations: g.vars.size,
      variants: [...g.vars.values()].sort((a, b) => b.players - a.players || b.uses - a.uses).slice(0, MAX_VARIANTS).map(v => ({ code: v.code, players: v.players, uses: v.uses, st: v.st, s3: v.s3, pct: v.pc, dur: v.dur })),
    });
    const list = (m, labeler, key) => [...m].map(([id, x]) => ({ [key]: id, label: labeler(id), ...pack(x) })).sort((a, b) => b.n - a.n);
    const topFor = e => [...e.players.values()].filter(p => p.n >= MIN_STRAT_ATK).sort((a, b) => wilson(b.s3, b.n) - wilson(a.s3, a.n) || b.st / b.n - a.st / a.n || b.n - a.n)
      .slice(0, STRAT_ROWS).map(p => ({ tag: p.tag, name: p.name, n: p.n, st: p.st, s3: p.s3, pct: p.t }));
    const named = m => [...m].map(([name, e]) => ({ name, n: e.n, st: e.st, s3: e.s3, code: SITE.topCode(e.codes) })).sort((a, b) => b.n - a.n);
    writeJson(path.join(statsDir, 'armies', `${k}.json`), {
      schema: SCHEMA, scope: k, week, generatedAt, withCode: t.withCode, noCode: t.noCode, groupsTotal: all.length, minPlayersForRate: minP,
      groups: chosen.map(grp),
      heroes: [...t.hero].map(([name, e]) => ({ name, n: e.n, st: e.st, s3: e.s3, equip: [...(e.eq || [])].map(([q, x]) => ({ name: q, n: x.n, st: x.st, s3: x.s3 })).sort((a, b) => b.n - a.n) })).sort((a, b) => b.n - a.n),
      openers: named(t.opener),
      strategies: [...t.strat].map(([name, e]) => ({ name, n: e.n, st: e.st, s3: e.s3, players: e.players ? e.players.size : 0, code: SITE.topCode(e.codes), top: e.players ? topFor(e) : [] })).sort((a, b) => b.n - a.n).slice(0, STRAT_SHOW),
      duke: { without: t.duke[0], with: t.duke[1] },
      siege: list(t.siege, id => idName('siege', id), 'id'), noSiege: pack(t.noSiege),
      comp: {
        troop: list(t.comp.troop, id => idName('troop', id), 'id'), spell: list(t.comp.spell, id => idName('spell', id), 'id'),
        pet: list(t.comp.pet, x => x, 'name'), equip: list(t.comp.equip, x => x, 'name'),
      },
    });
  }

  // players: one file per last two characters of the tag
  const shards = new Map();
  for (const r of rows) {
    const rk = {};
    const a = allPool.ranks.get(r.tag); if (a) rk.all = a;
    const th = thPool.ranks.get(r.tag); if (th) rk.th = th;
    const e = extra.get(r.tag) || { armies: [], openers: [], strategies: [] };
    const { w3, ...rec } = r;
    const id = r.tag.slice(1), sk = id.slice(-2).padStart(2, '_');
    let s = shards.get(sk); if (!s) shards.set(sk, (s = {}));
    s[r.tag] = { ...rec, rank: rk, armies: e.armies, openers: e.openers, strategies: e.strategies };
  }
  for (const [sk, s] of shards) writeGz(path.join(statsDir, 'players', `${sk}.json.gz`), s);

  writeJson(path.join(statsDir, 'meta.json'), {
    schema: SCHEMA, week, generatedAt, inputHash, players: rows.length, playerShards: shards.size,
    thresholds: { minAttacks: MIN_ATK, minDefenses: MIN_DEF },
    siteFiles: SITE.files,
    ranks: 'rank = [position, qualifiedTotal, qualified(1|0)]. Unqualified players (fewer than the minimum attacks/defenses) get the position they would hold among the qualified ones, flagged 0.',
    playerFile: 'players/<last two characters of the tag, "_" padded>.json.gz -> { "#TAG": record }',
    army: 'army group, opener and strategy come from the site (stats.js canonCode / infoOf / deduceStrategyName); player army = group used most this week',
  });
  console.log(`[analyze] ${key}: ${rows.length} players, ${shards.size} player files, site decoder from ${SITE.files.join(', ')}`);
  return { key, skipped: false, generatedAt, players: rows.length };
}

// ---------- main ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const keys = weekList(opts.data, opts.week);
  const done = [];
  for (const key of keys) { const r = processWeek(opts, key); if (r) done.push(r); }
  const cur = readCurrent(opts.data);
  const curKey = cur && cur.start ? dateKey(Date.parse(cur.start)) : keys[0];
  const ok = done.find(d => d.key === curKey);
  if (ok) {
    let gen = ok.generatedAt;
    if (!gen) { try { gen = JSON.parse(fs.readFileSync(path.join(opts.data, 'ranked', curKey, 'stats', 'meta.json'), 'utf8')).generatedAt; } catch { gen = new Date().toISOString(); } }
    writeJson(path.join(opts.data, 'ranked', 'stats-current.json'), { schema: SCHEMA, week: curKey, generatedAt: gen });
  }
  if (!done.length) console.log('[analyze] nothing to do');
}
main();
