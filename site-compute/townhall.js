// Town Hall stats page (ranked weeks). Same look and same army / hero / opener logic as stats.js, which must be loaded first
// (page order: armyids.js, army.js, legend.js, stats.js, townhall.js). Data comes from the crawl-ranked-week Action:
//   ranked-data/ranked/current.json                      latest run summary (week start/end, updatedAt)
//   ranked-data/ranked/<YYYY-MM-DD>/shards/th<N>.json.gz  one file per town hall (current + previous week)
//   ranked-archive-<YYYY-MM-DD>/shards/th<N>.json.gz      finished older weeks
// All names here start with rk / RK so nothing collides with stats.js (which owns `state`, `load`, `draw`, `initStats`, ...).
const RK = { BRANCH: 'ranked-data', WEEKS: 6, MIN: 7, MAX: window.TH19_MODE ? 19 : 17, MIN_ATK: 10, MIN_DEF: 10, MAX_ATK: 30, LIVE_MS: 5 * 60 * 1000 };
const RKN = RK.MAX - RK.MIN + 1;                // group index of "everyone"
const rkIdx = (th) => th - RK.MIN;
const RKS = { weeks: [], cur: null, week: null, sel: String(RK.MAX), S: null, group: RKN, sort: 'used', lgGroup: RKN, lgPage: 0, lgQ: '' };
const PER_BINS = [[1, 4], [5, 9], [10, 14], [15, 19], [20, 24], [25, 29], [30, 30]]; // a ranked week allows at most RK.MAX_ATK attacks

// Lowest town hall that can bring each thing in the MAIN army / heroes (lower-case names). An attack whose army contains something its
// town hall can't have yet is dropped: the player upgraded after the crawl listed them, so the attack belongs to a higher town hall.
// Clan Castle troops / spells / siege are NOT checked (a CC can hold things your own town hall hasn't unlocked). Things not listed here
// are never filtered, so add more entries as you verify them (spell names without the trailing " Spell").
const RK_MIN_TH = {
  hero:  { 'barbarian king': 7, 'archer queen': 8, 'grand warden': 11, 'royal champion': 13 },
  pet:   { 'spirit fox': 16, 'angry jelly': 16, 'sneezy': 17 },
  unit:  { 'thrower': 16, 'troop launcher': 16 },   // main-army troops and siege machines
  spell: { 'revive': 17, 'totem': 18 },
};
function rkMinTh(inf) { // highest town hall requirement among the army's heroes, pets, main troops/siege and main spells (cached on the info object)
  if (inf._rkMin !== undefined) return inf._rkMin;
  const lo = (x) => String(x || '').toLowerCase().replace(/ spell$/, '');
  let m = 0; const up = (t) => { if (t > m) m = t; };
  for (const h of inf.heroes || []) { up(RK_MIN_TH.hero[lo(h.name)] || 0); if (h.pet) up(RK_MIN_TH.pet[lo(h.pet)] || 0); }
  for (const id of inf.u || []) up(RK_MIN_TH.unit[lo((ARMY_IDS.troop[id] || ARMY_IDS.siege[id] || [])[0])] || 0);
  for (const id of inf.s || []) up(RK_MIN_TH.spell[lo((ARMY_IDS.spell[id] || [])[0])] || 0);
  return (inf._rkMin = m);
}

// ClashKing town hall icons (level_7 ... level_17.webp); an icon that fails to load simply disappears.
const rkThIcon = (th, h = 22) => `<img class="thi" src="https://assets.clashk.ing/buildings/home-village/town_hall/level_${th}.webp" alt="" loading="lazy" style="height:${h}px;width:auto;vertical-align:middle;margin-right:4px" onerror="this.remove()">`;

// ClashKing league icons live at leagues/league-tier/<name>_<number>.png, e.g. skeleton_league_1.png, legend_league_3.png.
// The file name is built from the league name the API gave us; add exceptions to RK_LEAGUE_ICON (league name -> file name without .png).
const RK_LEAGUE_ICON = {};
const rkLeagueIcon = (name, h = 40) => {
  if (!name || /^unranked$/i.test(name)) return '';
  const n = String(name).toLowerCase().replace(/\./g, '').trim(), lg = /^legend(?:\s+league)?\s*(iii|ii|i|[123])?$/.exec(n), rom = { i: 1, ii: 2, iii: 3 };
  const f = RK_LEAGUE_ICON[name] || (lg ? 'legend_league' + (lg[1] ? '_' + (rom[lg[1]] || lg[1]) : '') : n.replace(/\s+/g, '_').replace(/_(i{1,3})$/, (m, r) => '_' + r.length));
  return `<img class="lgi" src="https://assets.clashk.ing/leagues/league-tier/${encodeURIComponent(f)}.png" alt="" loading="lazy" style="height:${h}px;width:auto;vertical-align:middle;margin-right:6px" onerror="this.remove()">`;
};
// Ranked battles (attacks) per week by league group; Legend III = 24, Legend II = 30 (Legend I assumed 30 too).
const RK_ATK = [[/^(skeleton|barbarian)/, 6], [/^(archer|wizard)/, 8], [/^(valkyrie|witch)/, 10], [/^(golem|pekka|titan)/, 12], [/^dragon/, 14], [/^electro/, 18]];
function rkMaxAtk(name) {
  const n = String(name || '').trim().toLowerCase().replace(/\./g, '');
  if (n.startsWith('legend')) return /(iii|3)\s*$/.test(n) ? 24 : 30;
  for (const [re, v] of RK_ATK) if (re.test(n)) return v;
  return RK.MAX_ATK;
}
const RK_LG_PAGE = 100;

// ---------- data ----------
async function rkFetch(url, gz) {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} (${url.split('/').slice(-2).join('/')})`);
  return gz ? JSON.parse(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text()) : r.json();
}
// One town hall's players for one week: { "#TAG": { th, n, b: [[time, atk, stars, pct, oppTag, code, type, firstSeen, duration], ...] } } or null
const rkTh = (week, th) => memo(`rk|${week.key}|${th}`, week.cur ? RK.LIVE_MS : Infinity, async () => {
  const bust = week.cur ? `?t=${Date.now()}` : '';
  for (const base of [`${RK.BRANCH}/ranked/${week.key}`, `ranked-archive-${week.key}`]) {
    const raw = await rkFetch(`${CONFIG.REPO_RAW}/${base}/shards/th${th}.json.gz${bust}`, true);
    if (raw) return raw;
  }
  return null;
});
const rkWeekLabel = (w) => `Week of ${new Date(w.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}${w.cur ? ' (current)' : ''}`;
const rkGroupHtml = (i, h = 22) => { const n = i === RKN ? (RKS.S && !RKS.S.multi ? +RKS.sel : 0) : i + RK.MIN; return (n ? rkThIcon(n, h) : '') + rkGroupName(i); };
const rkGroupName = (i) => (i === RKN ? (RKS.S && !RKS.S.multi ? `TH${RKS.sel}` : 'Everyone') : `TH${i + RK.MIN}`);

// Ranked trophies per battle (game rules). Attacker: 3★ = 40; 2★ = 16 + 1 per 3% above 50 (max 32); 1★ = 5 + 1 per 9% above 1 (max 15);
// 0★ = 1 per 10% (none under 10%). Defender: 40 minus what the attacker got, 0 after a 3★, the full 40 after a 0★.
const atkTrophies = (stars, pct) => { const p = Math.max(0, +pct || 0); return stars >= 3 ? 40 : stars === 2 ? 16 + Math.min(16, Math.floor(Math.max(0, p - 50) / 3)) : stars === 1 ? 5 + Math.min(10, Math.floor(Math.max(0, p - 1) / 9)) : Math.min(4, Math.floor(p / 10)); };
const defTrophies = (stars, pct) => (stars >= 3 ? 0 : stars <= 0 ? 40 : 40 - atkTrophies(stars, pct));

// ---------- statistics ----------
async function rkCompute(sets, week, onProg, cancelled) {
  const mk = () => ({ players: 0, att: 0, def: 0, st: 0, s3: 0, pct: 0, dz: 0, dsum: 0, dur: 0, durN: 0, withCode: 0, noCode: 0,
    duke: [0, 1].map(() => ({ n: 0, st: 0, s3: 0, pct: 0 })), comp: new Map(), hero: new Map(), opener: new Map(), strat: new Map(),
    siege: new Map(), noSiege: { n: 0, st: 0, s3: 0 }, armies: new Map(), troop: new Map(), spell: new Map(), pet: new Map(), equip: new Map() });
  const B = Array.from({ length: RKN + 1 }, mk);
  const G = { locked: 0, players: 0, active: 0, att: 0, def: 0, st: 0, pct: 0, dur: 0, durN: 0, astars: [0, 0, 0, 0], dstars: [0, 0, 0, 0],
    days: Array.from({ length: 7 }, () => ({ n: 0, st: 0, s3: 0 })),
    dur6: Array.from({ length: 6 }, () => [0, 0]), per: Array(PER_BINS.length).fill(0) };
  const rows = [], fast = [], lgRows = [], leagueProfiles = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  // Ranked logs carry no battleTime, so a battle's time is when the crawler first saw it. Battles first seen during the crawler's very first pass
  // (the initial dump of each log) can't be dated; only later ones count for the per-day chart.
  let first = Infinity;
  for (const { raw } of sets) for (const rec of Object.values(raw)) for (const r of rec.b || []) if (r[7] && r[7] < first) first = r[7];
  const dayFrom = (first + 7200) * 1000;
  const total = sets.reduce((s, x) => s + Object.keys(x.raw).length, 0) || 1; let pi = 0;
  for (const { th, raw } of sets) {
    const gi = th >= RK.MIN && th <= RK.MAX ? rkIdx(th) : -1, targets = gi >= 0 ? [B[gi], B[RKN]] : [B[RKN]];
    for (const [tag0, rec] of Object.entries(raw)) {
      if (++pi % 150 === 0) { onProg(pi / total); await new Promise((r) => setTimeout(r, 0)); if (cancelled()) return null; }
      const tag = normTag(tag0), name = rec.n || '#' + tag, att = [], def = [];
      // Town hall image counts use every tracked profile with a league, whether or not they joined this ranked week.
      // Keep lgRows separate: the in-page ranked league leaderboard still requires this week's league group (rec.gf).
      if (rec.lg && rec.lg[1]) leagueProfiles.set(tag, { tag, th: rec.th || th, lid: rec.lg[0] || 0, ln: rec.lg[1] });
      let ix = 0;
      for (const r of rec.b || []) {
        const h = { ix: ix++, ts: (r[0] || r[7] || 0) * 1000, hasTime: !!r[0], time: r[8] || 0, tag: r[4] || '', code: r[5] || '', stars: r[2] || 0, pct: r[3] || 0 };
        (r[1] ? att : def).push(h);
      }
      // A ranked week allows only a fixed number of attacks (6–30 depending on league), so anything beyond that is left over from an earlier week's log. Keep the newest
      // (oldest first-seen time first; inside one crawl pass the log lists newest battles first, hence the reversed index tiebreak).
      // Drop attacks whose army has something this town hall can't have (see RK_MIN_TH); they were made after an upgrade.
      for (let i = att.length - 1; i >= 0; i--) if (att[i].code && rkMinTh(infoOf(canonCode(att[i].code))) > th) { att.splice(i, 1); G.locked++; }
      const mxA = rec.lg ? rkMaxAtk(rec.lg[1]) : RK.MAX_ATK; // attacks a week allows in this player's league
      // Ranked logs carry no battleTime, so last week's battles still sitting in a log look like this week's. The league group (rec.gw = attack wins/losses,
      // defense wins/losses, reset by the game every week) is the exact count: keep at most that many of the NEWEST battles, and none when the group hasn't been read yet.
      const gwA = rec.gw ? Math.min(mxA, (+rec.gw[0] || 0) + (+rec.gw[1] || 0)) : 0, gwD = rec.gw ? Math.min(mxA, (+rec.gw[2] || 0) + (+rec.gw[3] || 0)) : 0;
      att.sort((x, y) => x.ts - y.ts || y.ix - x.ix);
      if (att.length > gwA) att.splice(0, att.length - gwA);
      def.sort((x, y) => x.ts - y.ts || y.ix - x.ix);
      if (def.length > gwD) def.splice(0, def.length - gwD);
      if (rec.lg && rec.gf) lgRows.push({ tag, name, th: rec.th || th, lid: rec.lg[0] || 0, ln: rec.lg[1] || 'Unranked', tr: rec.tr || 0, na: att.length, mx: mxA, ga: rec.gw ? rec.gw[0] + rec.gw[1] : null, gr: rec.gr || 0 }); // trophies only count once this week's league group was read
      if (!att.length && !def.length) continue;
      const row = { tag, name, th: rec.th || th, na: att.length, nd: def.length, st: 0, s3: 0, pct: 0, dz: 0, dst: 0, d3: 0, ot: 0, dt: 0 };
      G.players++; targets.forEach((t) => t.players++);
      if (att.length >= RK.MIN_ATK) G.active++;
      if (att.length) G.per[PER_BINS.findIndex(([a, b]) => att.length >= a && att.length <= b)]++;
      const myArmy = new Map(); // code -> [uses, stars, 3stars, destruction, seconds]
      const myOp = new Map();   // opener name -> uses (for the player card)
      for (const h of att) {
        const s3 = h.stars === 3 ? 1 : 0;
        G.att++; G.st += h.stars; G.pct += h.pct; G.astars[h.stars]++;
        if (h.time > 0) { G.dur += h.time; G.durN++; G.dur6[Math.min(5, Math.floor(h.time / 30))][s3 ? 0 : 1]++; }
        if (h.hasTime || h.ts > dayFrom) {
          const d = G.days[Math.max(0, Math.min(6, Math.floor((h.ts - week.start) / 864e5)))]; d.n++; d.st += h.stars; d.s3 += s3;
        }
        row.st += h.stars; row.s3 += s3; row.pct += h.pct; row.ot += atkTrophies(h.stars, h.pct);
        for (const t of targets) { t.att++; t.st += h.stars; t.s3 += s3; t.pct += h.pct; if (h.time > 0) { t.dur += h.time; t.durN++; } }
        if (s3 && h.time > 0) fast.push({ tag, name, th: row.th, time: h.time, pct: h.pct, opp: h.tag });
        if (h.code) {
          const cd = canonCode(h.code), inf = infoOf(cd), parts = inf.key.split('|').map((x) => (x ? x.split(',') : []));
          const ids = [...parts[0], ...parts[2]].map((x) => 't' + x).concat(parts[1].map((x) => 's' + x), inf.pets.map((x) => 'p' + x), inf.eq.map((x) => 'e' + x));
          for (const t of targets) {
            const x = t.duke[inf.duke ? 1 : 0]; x.n++; x.st += h.stars; x.pct += h.pct; x.s3 += s3;
            if (inf.siege.length) for (const id of inf.siege) { let c = t.siege.get(id); if (!c) t.siege.set(id, (c = { n: 0, s3: 0, st: 0 })); c.n++; c.st += h.stars; c.s3 += s3; }
            else { t.noSiege.n++; t.noSiege.st += h.stars; t.noSiege.s3 += s3; }
            tallyArmyStats(t, inf, cd, 1, h.stars, s3); noteStratPlayer(t, inf, tag, name, 0, 1, h.stars, s3, h.pct);
            for (const id of ids) { let c = t.comp.get(id); if (!c) t.comp.set(id, (c = { n: 0, s3: 0, st: 0 })); c.n++; c.st += h.stars; c.s3 += s3; }
          }
          { const on = inf.cls && inf.cls.openerRaw; if (on) myOp.set(on, (myOp.get(on) || 0) + 1); }
          const a = myArmy.get(cd) || myArmy.set(cd, [0, 0, 0, 0, 0]).get(cd); a[0]++; a[1] += h.stars; a[2] += s3; a[3] += h.pct; a[4] += h.time || 0;
        } else for (const t of targets) t.noCode++;
      }
      // ONE army per player: the army (group of similar codes) they used most this week; all their attacks with it count.
      const mine = new Map();
      for (const [code, x] of myArmy) {
        const k = infoOf(code).group; let m = mine.get(k); if (!m) mine.set(k, (m = { key: k, v: [0, 0, 0, 0, 0], codes: new Map() }));
        x.forEach((n, i) => { m.v[i] += n; }); m.codes.set(code, x);
      }
      let best = null;
      for (const m of mine.values()) if (!best || m.v[0] > best.v[0] || (m.v[0] === best.v[0] && m.v[1] > best.v[1])) best = m;
      row.op = [...myOp].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      row.army = best ? best.key : null;
      if (best) {
        const rep = [...best.codes].sort((p, q) => q[1][0] - p[1][0] || q[1][1] - p[1][1])[0][0], info = infoOf(rep);
        for (const t of targets) {
          t.withCode++;
          let g = t.armies.get(best.key); if (!g) t.armies.set(best.key, (g = { players: 0, uses: 0, st: 0, s3: 0, pc: 0, dur: 0, vars: new Map() }));
          g.players++; g.uses += best.v[0]; g.st += best.v[1]; g.s3 += best.v[2]; g.pc += best.v[3]; g.dur += best.v[4];
          for (const [code, x] of best.codes) {
            let v = g.vars.get(code); if (!v) g.vars.set(code, (v = { code, players: 0, uses: 0, st: 0, s3: 0, pc: 0, dur: 0 }));
            v.players++; v.uses += x[0]; v.st += x[1]; v.s3 += x[2]; v.pc += x[3]; v.dur += x[4];
          }
          info.u.forEach((x) => inc(t.troop, x)); info.s.forEach((x) => inc(t.spell, x));
          info.pets.forEach((x) => inc(t.pet, x)); info.eq.forEach((x) => inc(t.equip, x));
        }
      }
      for (const h of def) {
        G.def++; G.dstars[h.stars]++; row.dst += h.stars; row.dt += defTrophies(h.stars, h.pct); if (h.stars === 0) row.dz++; if (h.stars === 3) row.d3++;
        for (const t of targets) { t.def++; t.dsum += h.stars; if (h.stars === 0) t.dz++; }
      }
      rows.push(row);
    }
  }
  return { B, G, rows, fast, lg: lgRows, leagueProfiles: [...leagueProfiles.values()], week, multi: sets.filter((s) => s.th >= RK.MIN && s.th <= RK.MAX).length > 1,
    names: new Map(rows.map((r) => [r.tag, r.name])) };
}

// ---------- rendering ----------
const rkWho = (r, showTh) => ({ html: `<span class="who">${esc(r.name)}${crown(r.tag)}${showTh && r.th ? `<small class="eod">${rkThIcon(r.th, 16)}TH${r.th}</small>` : ''}</span>` });

function rkOverview(S) {
  const { G } = S, tot = G.att || 1;
  const starBars = (a, label, color) => { const sum = a.reduce((x, y) => x + y, 0) || 1; return `<div class="starbars"><h4>${label}</h4>${a.map((n, s) =>
    `<div class="sb" data-tt="${esc(`${s}★ · ${fmtN(n)} ${label.startsWith('Attack') ? 'attacks' : 'defenses'} (${pctOf(n, sum)})`)}"><span>${s}★</span><i style="width:${(100 * n / sum).toFixed(1)}%;background:${color[s]}"></i><em>${pctOf(n, sum)}</em></div>`).join('')}</div>`; };
  return `<section class="panel"><h3>Overview</h3><div class="kpis">
    ${kpi('Players with battles', fmtN(G.players), `${fmtN(G.active)} with ${RK.MIN_ATK}+ attacks`)}
    ${kpi('Attacks · defenses', fmtN(G.att), `${fmtN(G.def)} defenses logged`)}
    ${kpi('Attacks per player', avgOf(G.att, G.players, 1), 'average this week')}
    ${kpi('Avg stars per attack', avgOf(G.st, tot, 2), `${pctOf(G.astars[3], G.att)} are 3★`, 'pos')}
    ${kpi('0★ defenses', pctOf(G.dstars[0], G.def), `${fmtN(G.dstars[0])} attacks failed`)}
    ${kpi('Avg destruction', `${avgOf(G.pct, G.att, 1)}%`, 'per attack')}
    ${kpi('Avg battle time', G.durN ? dur(Math.round(G.dur / G.durN)) : '–', G.durN ? 'minutes:seconds' : 'not in the battle logs')}
  </div>
  <div class="two">${starBars(G.astars, 'Attack results', ['#c2362f', '#e0a526', '#8bc34a', '#1a8f4c'])}${starBars(G.dstars, 'Defense results (attacker’s stars)', ['#1a8f4c', '#8bc34a', '#e0a526', '#c2362f'])}</div>
  <p class="shield-note">Stats cover the players the crawler tracks (from the Clashspot town hall rankings) and only battles it saw before they scrolled out of each player’s battle log. It checks every 4 hours, so the busiest players can be missing a few attacks.</p></section>`;
}

function rkCharts(S) {
  const { G, week } = S, pad = (h) => String(h).padStart(2, '0');
  const t30 = (i) => `${Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`;
  const wd = (i) => new Date(week.start + i * 864e5).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const days = vcols(G.days.map((v, i) => ({ label: wd(i), top: v.n ? Math.round(rate(v.s3, v.n)) : '', segs: [[rate(v.s3, v.n), GOLD]],
    tt: `Tournament day ${i + 1} (from ${wd(i)} ${pad(new Date(week.start).getUTCHours())}:00 UTC) · ${pctOf(v.s3, v.n)} 3★ · ${avgOf(v.st, v.n, 2)} ★ (${fmtN(v.n)} attacks)` })));
  const lens = vcols(G.dur6.map((v, i) => ({ label: t30(i), top: v[0] + v[1] ? fmtN(v[0] + v[1]) : '', segs: [[v[0], GREEN], [v[1], GREY]],
    tt: `${t30(i)}–${t30(i + 1)} · ${fmtN(v[0] + v[1])} battles, ${fmtN(v[0])} were 3★ (${pctOf(v[0], v[0] + v[1])})` })));
  const binLabel = ([a, b]) => (b >= 1e9 ? `${a}+` : a === b ? `${a}` : `${a}–${b}`);
  const per = vcols(G.per.map((n, i) => ({ label: binLabel(PER_BINS[i]), top: n ? fmtN(n) : '', segs: [[n, 'var(--ck-accent)']],
    tt: `${fmtN(n)} players made ${binLabel(PER_BINS[i])} attacks this week` })));
  const byTh = S.multi ? [...Array(RKN).keys()].filter((i) => S.B[i].att).map((i) => ({ label: `TH${i + RK.MIN}`, v: rate(S.B[i].s3, S.B[i].att), text: pctOf(S.B[i].s3, S.B[i].att),
    tt: `TH${i + RK.MIN} · ${pctOf(S.B[i].s3, S.B[i].att)} 3★ (${fmtN(S.B[i].s3)} of ${fmtN(S.B[i].att)} attacks)` })) : [];
  const cp = (title, note, body) => `<div class="cp"><h4>${title}</h4><p class="sub">${note}</p>${body}</div>`;
  return `<section class="panel"><h3>Trends &amp; distributions</h3><div class="cgrid">
    ${G.days.some((v) => v.n) ? cp('3★ rate by tournament day', 'Day 1 starts when the tournament week opens. Battles are dated by when the crawler first saw them; those it found on its very first pass can’t be dated, so early days can be thin', days) : ''}
    ${G.durN ? cp('Battle length', 'Attacks by time used; green = 3★, grey = not', lens) : ''}
    ${cp('Attacks per player', 'Players by how many attacks the crawler saw this week', per)}
    ${byTh.length > 1 ? cp('3★ rate by town hall', 'How often attacks at each town hall ended in a triple', hbars(byTh)) : ''}</div></section>`;
}

function rkByTh(S) {
  if (!S.multi) return '';
  const line = (i) => { const t = S.B[i]; return `<tr><td>${rkGroupHtml(i)}</td><td>${fmtN(t.players)}</td><td>${fmtN(t.att)}</td><td>${avgOf(t.st, t.att, 2)}</td><td>${pctOf(t.s3, t.att)}</td>
    <td>${avgOf(t.pct, t.att, 1)}%</td><td>${pctOf(t.dz, t.def)}</td><td>${avgOf(t.dsum, t.def, 2)}</td><td>${t.durN ? dur(Math.round(t.dur / t.durN)) : '–'}</td></tr>`; };
  const idx = [...Array(RKN).keys()].filter((i) => S.B[i].players).reverse();
  return `<section class="panel"><h3>By town hall</h3><p class="sub">Every town hall side by side. “★ conceded” is the average stars attackers took per defense; across everyone, attacks and defenses average out because each battle is one player’s attack and another’s defense.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Town hall</th><th>Players</th><th>Attacks</th><th>★ / attack</th><th>3★ attacks</th><th>Avg destruction</th><th>0★ defenses</th><th>★ conceded</th><th>Avg battle time</th></tr></thead>
    <tbody>${idx.map(line).join('')}${line(RKN)}</tbody></table></div></section>`;
}

// League leaderboard: league first (highest league id), trophies break ties. Data = profile fields the crawler stores (lg, tr).
function rkLeagueBody(S) {
  const g = RKS.lgGroup, ranked = (S.lgSorted ||= {})[g] ||= S.lg.filter((r) => g === RKN || r.th === g + RK.MIN)
    .sort((a, b) => b.lid - a.lid || b.tr - a.tr || (a.name < b.name ? -1 : 1)).map((r, i) => ({ r, k: i + 1 }));
  if (!ranked.length) return '<div class="msg">No league data for this town hall yet.</div>';
  const q = RKS.lgQ.trim(), nq = q.replace(/^#/, '').toLowerCase(), NQ = nq.toUpperCase();
  const all = q ? ranked.filter(({ r }) => r.name.toLowerCase().includes(nq) || normTag(r.tag).includes(NQ)) : ranked;
  if (!all.length) return `<div class="msg">No tracked player matching “${esc(q)}” (checked name and tag).</div>`;
  const pages = Math.ceil(all.length / RK_LG_PAGE); RKS.lgPage = Math.min(Math.max(0, RKS.lgPage), pages - 1);
  const start = RKS.lgPage * RK_LG_PAGE, rows = all.slice(start, start + RK_LG_PAGE), showTh = g === RKN && S.multi;
  return `<div class="scroll"><table class="tbl"><thead><tr><th>#</th><th>Player</th>${showTh ? '<th>TH</th>' : ''}<th>League</th><th>Trophies</th><th>Attacks</th></tr></thead>
    <tbody>${rows.map(({ r, k }) => `<tr><td>${fmtN(k)}</td><td>${rkWho(r, false).html}</td>${showTh ? `<td>${rkThIcon(r.th, 20)}TH${r.th}</td>` : ''}<td>${rkLeagueIcon(r.ln)}${esc(r.ln)}</td><td>${fmtN(r.tr)} 🏆</td><td>${fmtN(r.ga ?? r.na)}/${r.mx}</td></tr>`).join('')}</tbody></table></div>
    <div class="pager" id="lpg"><button data-p="first" aria-label="First page"${RKS.lgPage ? '' : ' disabled'}>⏮</button><button data-p="prev" aria-label="Previous page"${RKS.lgPage ? '' : ' disabled'}>◀</button>
    <span>${fmtN(start + 1)}–${fmtN(start + rows.length)} of ${fmtN(all.length)} ${q ? 'matches' : 'players'} · page ${fmtN(RKS.lgPage + 1)}/${fmtN(pages)}</span>
    <button data-p="next" aria-label="Next page"${RKS.lgPage < pages - 1 ? '' : ' disabled'}>▶</button><button data-p="last" aria-label="Last page"${RKS.lgPage < pages - 1 ? '' : ' disabled'}>⏭</button></div>`;
}
function rkLeague(S) {
  if (!S.lg.length) return '';
  const ids = [...Array(RKN).keys()].filter((i) => S.lg.some((r) => r.th === i + RK.MIN)).reverse();
  const tabs = S.multi ? `<div class="seg wrapseg" id="lseg" role="group" aria-label="League leaderboard town hall">${[...ids, RKN].map((i) => `<button data-l="${i}" aria-pressed="${i === RKS.lgGroup}">${rkGroupHtml(i, 20)}</button>`).join('')}</div>` : '';
  return `<h2 class="sh">League leaderboard</h2><section class="panel"><p class="sub">Every tracked player, ranked by current league, then trophies, as of the crawler’s last profile check. “Attacks” is the game’s own count out of the most the player’s league allows per week; Trophies are this week’s ranked trophies from the league group. This is the live league, not the one at the end of the ranked week.</p>
    <div class="controls">${tabs}<div class="sbox"><input id="lsq" type="search" placeholder="Search player name or tag" aria-label="Search league leaderboard by player name or tag" autocomplete="off" value="${esc(RKS.lgQ)}"></div></div><div id="lgbox">${rkLeagueBody(S)}</div></section>`;
}

function rkLeaderboards(S) {
  const R = S.rows, M = RK.MIN_ATK, D = RK.MIN_DEF, showTh = S.multi;
  const byName = (a, b) => (a.name < b.name ? -1 : 1);
  const mk = (r, val, cls2, ex) => ({ ...r, ...rkWho(r, showTh), val, cls: cls2, ex });
  const rated = R.filter((r) => r.na >= M);
  const best3 = topN(rated, (a, b) => wilson(b.s3, b.na) - wilson(a.s3, a.na) || b.na - a.na || byName(a, b)).map((r) => mk(r, pctOf(r.s3, r.na), 'pos', `${fmtN(r.na)} attacks · ${avgOf(r.st, r.na, 2)} ★`));
  const most3 = topN(R, (a, b) => b.s3 - a.s3 || b.na - a.na || byName(a, b)).map((r) => mk(r, `${fmtN(r.s3)}×3★`, 'pos', `${fmtN(r.na)} attacks · ${pctOf(r.s3, r.na)}`));
  const stars = topN(rated, (a, b) => b.st / b.na - a.st / a.na || b.na - a.na || byName(a, b)).map((r) => mk(r, `${avgOf(r.st, r.na, 2)} ★`, '', `${fmtN(r.na)} attacks · ${avgOf(r.pct, r.na, 1)}% destruction`));
  const busy = topN(R, (a, b) => b.na - a.na || b.s3 - a.s3 || byName(a, b)).map((r) => mk(r, fmtN(r.na), '', `${fmtN(r.s3)}×3★ · ${fmtN(r.nd)} defenses`));
  const rd = R.filter((r) => r.nd >= D);
  const defense = topN(rd, (a, b) => a.dst / a.nd - b.dst / b.nd || b.nd - a.nd || byName(a, b)).map((r) => mk(r, `${avgOf(r.dst, r.nd, 2)} ★`, 'pos', `${fmtN(r.nd)} defenses · ${fmtN(r.dz)}×0★`));
  const zero = topN(R, (a, b) => b.dz - a.dz || b.nd - a.nd || byName(a, b)).map((r) => mk(r, `${fmtN(r.dz)}×0★`, '', `${fmtN(r.nd)} defenses received | ${fmtN(r.nd - r.d3)} non-3★`));
  const offtr = topN(R, (a, b) => b.ot - a.ot || b.na - a.na || byName(a, b)).map((r) => mk(r, fmtN(r.ot), 'pos', `${fmtN(r.na)} attacks · ${avgOf(r.ot, r.na, 1)} per attack`));
  const deftr = topN(R, (a, b) => b.dt - a.dt || b.nd - a.nd || byName(a, b)).map((r) => mk(r, fmtN(r.dt), '', `${fmtN(r.nd)} defenses · ${avgOf(r.dt, r.nd, 1)} per defense`));
  const fastest = topN(S.fast, (a, b) => a.time - b.time || byName(a, b)).map((r) => mk(r, dur(r.time), '', `${r.pct}% vs ${esc(S.names.get(normTag(r.opp)) || r.opp || 'unknown')}`));
  return `<h2 class="sh">Leaderboards</h2><div class="lbs xl">
    ${lb('Best 3★ rate', `Players with ${M}+ attacks, ranked by 3★ rate adjusted for sample size`, best3)}
    ${lb('Most 3★ attacks', 'Triples this week', most3)}
    ${lb('Best average stars', `Players with ${M}+ attacks`, stars)}
    ${lb('Most offense trophies', 'Trophies won attacking, worked out from each logged attack’s stars and destruction', offtr)}
    ${lb('Most defense trophies', 'Trophies won defending (40 minus what the attacker earned)', deftr)}
    ${lb('Most attacks', 'Attacks the crawler saw', busy)}
    ${lb('Best defense', `Fewest stars conceded per defense, players with ${D}+ defenses`, defense)}
    ${lb('Most 0★ defenses', 'Attackers who got no stars at all', zero)}
    ${S.fast.length ? lb('Fastest 3★ attacks', 'Shortest battles that ended in a triple', fastest) : ''}
  </div>`;
}

function rkDuke(S) {
  const allSelection = RKS.sel === 'all';
  const selectedHall = allSelection ? null : +RKS.sel;
  if (selectedHall !== null && selectedHall < 15) return '';
  const eligible = allSelection
    ? [...Array(RKN).keys()].filter((i) => i + RK.MIN >= 15 && S.B[i].players).reverse()
    : [];
  const sumSide = (side) => eligible.reduce((sum, i) => {
    const x = S.B[i].duke[side]; sum.n += x.n; sum.st += x.st; sum.s3 += x.s3; sum.pct += x.pct; return sum;
  }, { n: 0, st: 0, s3: 0, pct: 0 });
  const aggregate = allSelection ? [sumSide(0), sumSide(1)] : S.B[RKN].duke;
  const rows = (allSelection ? eligible.map((i) => ({ i, no: S.B[i].duke[0], yes: S.B[i].duke[1] })) : [])
    .concat([{ i: RKN, no: aggregate[0], yes: aggregate[1] }]);
  const A = rows[rows.length - 1];
  if (!A.yes.n) return `<section class="panel"><h3>Dragon Duke</h3><p class="sub">No attacks with the Dragon Duke found among ${fmtN(A.no.n)} attacks that have an army link.</p></section>`;
  const pp = (v) => `${v > 0 ? '+' : ''}${fmtN(v, 1)} pp`;
  const r3 = (x) => rate(x.s3, x.n), diff = (y, n) => (y.n && n.n ? pp(r3(y) - r3(n)) : '–'), cls2 = (y, n) => (y.n && n.n ? (r3(y) >= r3(n) ? 'pos' : 'neg') : '');
  const line = ({ i, no, yes }) => `<tr><td>${rkGroupHtml(i)}</td><td>${pctOf(yes.n, yes.n + no.n)} <small>(${fmtN(yes.n)})</small></td><td>${pctOf(yes.s3, yes.n)}</td><td>${pctOf(no.s3, no.n)}</td>
    <td class="${cls2(yes, no)}">${diff(yes, no)}</td><td>${avgOf(yes.st, yes.n, 2)}</td><td>${avgOf(no.st, no.n, 2)}</td><td>${avgOf(yes.pct, yes.n, 1)}%</td><td>${avgOf(no.pct, no.n, 1)}%</td></tr>`;
  return `<section class="panel"><h3>Dragon Duke vs no Duke</h3><div class="kpis">
    ${kpi('Duke usage', pctOf(A.yes.n, A.yes.n + A.no.n), `${fmtN(A.yes.n)} of ${fmtN(A.yes.n + A.no.n)} attacks`)}
    ${kpi('3★ with Duke', pctOf(A.yes.s3, A.yes.n), `${avgOf(A.yes.st, A.yes.n, 2)} ★ per attack`, 'pos')}
    ${kpi('3★ without Duke', pctOf(A.no.s3, A.no.n), `${avgOf(A.no.st, A.no.n, 2)} ★ per attack`)}
    ${kpi('Difference', diff(A.yes, A.no), 'in 3★ rate (percentage points)', cls2(A.yes, A.no))}</div>
    <p class="sub">TH15 and above, where the Dragon Duke is unlocked. Per attack, using the army link of each attack (attacks without an army link are left out). Players who pick the Duke may simply be better players, so this shows what happened, not what the Duke causes.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Town hall</th><th>Duke usage</th><th>3★ with</th><th>3★ without</th><th>Difference</th><th>★ with</th><th>★ without</th><th>Destruction with</th><th>Destruction without</th></tr></thead>
    <tbody>${rows.map(line).join('')}</tbody></table></div></section>`;
}

const RK_SORTS = { used: 'Most used', s3: 'Best 3★ rate', stars: 'Best avg stars' };
const rkStatsLine = (g) => `<span>★ ${avgOf(g.st, g.uses, 2)}</span><span>3★ ${pctOf(g.s3, g.uses)}</span><span>${avgOf(g.pc, g.uses, 0)}%</span><span>${g.uses && g.dur ? dur(Math.round(g.dur / g.uses)) : '–'}</span>`;
function rkTabs(S, sel) {
  if (!S.multi) return '';
  const ids = [...[...Array(RKN).keys()].filter((i) => S.B[i].players).reverse(), RKN];
  return `<div class="seg wrapseg" id="bseg" role="group" aria-label="Town hall">${ids.map((i) => `<button data-b="${i}" aria-pressed="${i === sel}">${rkGroupHtml(i, 20)}</button>`).join('')}</div>`;
}
function rkArmies(S, sel, sort) {
  const t = S.B[sel], gname = rkGroupName(sel), minP = sort === 'used' ? 1 : Math.max(2, Math.min(5, Math.round(t.withCode / 100)));
  const val = { used: (g) => g.players, s3: (g) => g.s3 / g.uses, stars: (g) => g.st / g.uses }[sort];
  const list = [...t.armies.values()].filter((g) => g.players >= minP && g.uses >= (sort === 'used' ? 1 : 10))
    .sort((a, b) => val(b) - val(a) || b.players - a.players || b.uses - a.uses).slice(0, ARMY_MAX);
  state.list = list; // stats.js's `state`, used by the "variations" buttons
  const cards = list.map((g, i) => { const rep = repOf(g), family = infoOf(rep.code).cls.core || infoOf(rep.code).cls.strategy || 'Army family'; return `<div class="acard${i >= ARMY_SHOW ? ' more' : ''}"><div class="ah"><b>#${i + 1}</b><span><em>${fmtN(g.players)}</em> player${g.players === 1 ? '' : 's'} · ${pctOf(g.players, t.withCode)} of ${gname} · ${fmtN(g.uses)} attack${g.uses === 1 ? '' : 's'}</span></div>
      <div class="army-family">${esc(family)}</div><div class="am">${rkStatsLine(g)}</div>${ckArmy(rep.code)}
      ${g.vars.size > 1 ? `<button class="btn vbtn" data-g="${i}" aria-expanded="false">▸ ${fmtN(g.vars.size)} variations</button>` : '<small class="sub">Only one version used</small>'}
      <div class="vars" id="vars${i}"></div></div>`; }).join('');
  const base = t.duke[0].n + t.duke[1].n;
  return `<h2 class="sh">Top armies by town hall</h2><section class="panel">
    <div class="controls">${rkTabs(S, sel)}<div class="seg" id="sseg" role="group" aria-label="Sort armies">${Object.entries(RK_SORTS).map(([k, v]) => `<button data-s="${k}" aria-pressed="${k === sort}">${v}</button>`).join('')}</div></div>
    <p class="sub">${fmtN(t.withCode)} ${gname} players, one preferred army family each. Similar troop recipes are grouped by strategic core; counts, support troops, siege, spells, heroes, pets and equipment variations stay together. Each card shows the most-used recipe, with other versions in its variations. Card numbers show average stars, 3★ rate, average destruction and battle time.${sort === 'used' ? '' : ' Performance sorts require a minimum player sample and 10+ attacks.'}</p>
    <div class="xp"><div class="acards">${cards || '<div class="msg">Not enough armies in this group yet.</div>'}</div>${expandBtn(list.length, 'more armies', ARMY_SHOW)}</div>
    ${metaHTML(t)}${compHTML(t)}${siegeHTML(t)}${heroHTML(t, base)}${openerHTML(t, base)}</section>${rkStrategyTop(t, 10)}`;
}
function rkVariants(g) {
  const vs = [...g.vars.values()].sort((a, b) => b.players - a.players || b.uses - a.uses), shown = vs.slice(0, 40);
  return shown.map((v) => `<div class="var"><div class="am"><b>${fmtN(v.players)} player${v.players === 1 ? '' : 's'}</b>${rkStatsLine(v)}<span>${fmtN(v.uses)} attack${v.uses === 1 ? '' : 's'}</span></div>${ckArmy(v.code)}</div>`).join('')
    + (vs.length > shown.length ? `<small class="sub">Showing the ${shown.length} most popular of ${fmtN(vs.length)} variations.</small>` : '');
}
function rkStrategyTop(t, minN) {
  const strats = [...t.strat].filter(([, e]) => e.players && e.players.size).sort((a, b) => b[1].n - a[1].n).slice(0, STRAT_SHOW);
  const cards = strats.map(([name, e]) => {
    const ps = [...e.players.values()].filter((p) => p.n >= minN).sort((a, b) => wilson(b.s3, b.n) - wilson(a.s3, a.n) || b.st / b.n - a.st / a.n || b.n - a.n).slice(0, STRAT_ROWS);
    if (!ps.length) return '';
    const rows = ps.map((p, i) => `<div class="lbr${i >= 3 ? ' more' : ''}"><span class="n">${i + 1}</span><span class="who">${esc(p.name)}</span><b class="pos">${pctOf(p.s3, p.n)} 3★</b><small class="ex">${avgOf(p.st, p.n, 2)} ★ · ${avgOf(p.t, p.n, 0)}% · ${fmtN(p.n)} atk</small></div>`).join('');
    return `<div class="scard xp"><div class="sch"><span class="icons">${armyIcons(topCode(e.codes))}</span><div><b>${esc(name)}</b><small>${fmtN(e.players.size)} players · ${fmtN(e.n)} attacks · ${pctOf(e.s3, e.n)} 3★</small></div></div><div class="lb">${rows}</div>${expandBtn(ps.length, `top ${ps.length}`, 3)}</div>`;
  }).join('');
  return `<div id="ch-strats" class="strats"><h2 class="sh">Top performers by strategy</h2><section class="panel"><p class="sub">The best players for each strategy, ranked by 3★ rate adjusted for sample size. At least ${minN} attacks with the strategy are needed to be listed. Follows the town hall tab above.</p>${cards ? `<div class="sgrid2">${cards}</div>` : '<div class="msg">Not enough attacks per strategy yet.</div>'}</section></div>`;
}

// ---------- page ----------
function rkDraw() {
  const S = RKS.S; if (!S) return;
  $('out').innerHTML = !S.G.players ? '<div class="msg">No ranked battles recorded for this selection yet.</div>'
    : buildPage([
      ['glance', 'At a glance', 'Totals, results and when everyone attacks this ranked week.', rkOverview(S)],
      ['charts', 'The week in charts', 'Stars, battle length and activity.', rkCharts(S)],
      ['townhalls', 'Town Hall comparison', 'Compare battle results across the halls in this selection.', rkByTh(S)],
      ['league', 'League leaderboard', 'Browse tracked players by league, trophies and Town Hall.', rkLeague(S)],
      ['cards', 'Shareable cards', 'Create a player or Town Hall ranked week card.', rkCardPanel() + rkThCardPanel()],
      ['players', 'Player leaderboards', 'Find the top weekly attackers and defenders.', rkLeaderboards(S)],
      ['armies', 'Armies &amp; strategies', 'What players bring, and who performs best with each strategy.', rkDuke(S) + `<div id="armies">${rkArmies(S, RKS.group, RKS.sort)}</div>`]], [['ch-strats', 'Top performers']]);
  if (S.G.players) { const th = RKS.sel === 'all' ? RK.MAX : +RKS.sel; requestAnimationFrame(() => rkThCardShow(th)); }
}
function rkDrawArmies() { const h = document.getElementById('armies'); if (!h) return rkDraw(); h.innerHTML = rkArmies(RKS.S, RKS.group, RKS.sort); }

let rkLoadId = 0;
async function rkLoad(forceLive = false) {
  const id = ++rkLoadId, week = RKS.week, sel = RKS.sel;
  prog.cur = 0; $('out').innerHTML = ''; setProgress(2, 'Loading ranked data… downloading');
  const refresh = $('refreshStats'); if (refresh) { refresh.disabled = true; refresh.textContent = forceLive ? 'Computing in browser…' : 'Loading stats…'; }
  try {
    if (!forceLive) {
      try {
        const mode = window.TH19_MODE ? 'th19' : 'th17', packed = await getComputed('townhall', `${week.key}/${mode}-${sel}.json.gz`);
        if (id !== rkLoadId) return;
        setProgress(100, 'Done'); RKS.S = packed.S; RKS.group = RKN; RKS.sort = 'used'; RKS.lgGroup = RKN; RKS.lgPage = 0; RKS.lgQ = '';
        rkDraw();
        const fmtD = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' '), age = packed.sourceGeneratedAt ? Math.max(0, Math.round((Date.now() - Date.parse(packed.sourceGeneratedAt)) / 60000)) : null;
        $('foot').innerHTML = `Ranked week ${fmtD(week.start)} → ${fmtD(week.end)} UTC${age === null ? '' : ` · crawler data updated ${age} min ago`} · stats precomputed ${esc(ageLabel(packed.computedAt))} · ${fmtN(RKS.S.G.players)} players with battles · stats cover the players the crawler tracks · ${BUILD} · icons by <a href="https://assets.clashk.ing" target="_blank" rel="noopener">ClashKing</a>`;
        return;
      } catch { /* calculate from ranked shards when there is no saved result */ }
    }
    const ths = sel === 'all' ? [0, ...Array.from({ length: RKN }, (_, i) => i + RK.MIN)] : [+sel];
    let done = 0;
    const got = await Promise.all(ths.map(async (th) => { const raw = await rkTh(week, th); done++; if (id === rkLoadId) setProgress(5 + 50 * done / ths.length); return { th, raw }; }));
    if (id !== rkLoadId) return;
    const sets = got.filter((x) => x.raw);
    if (!sets.length) {
      $('out').innerHTML = `<div class="msg">No ranked data for ${sel === 'all' ? 'any town hall' : 'TH' + sel} in the ${esc(rkWeekLabel(week).toLowerCase())} yet. The crawl-ranked-week Action fills this in as it runs.</div>`;
      $('foot').textContent = ''; return;
    }
    setProgress(58, 'Crunching the battle logs… analysing attacks');
    const S = await rkCompute(sets, week, (f) => { if (id === rkLoadId) setProgress(58 + 41 * f); }, () => id !== rkLoadId);
    if (!S || id !== rkLoadId) return;
    setProgress(100, 'Done');
    RKS.S = S; RKS.group = RKN; RKS.sort = 'used'; RKS.lgGroup = RKN; RKS.lgPage = 0; RKS.lgQ = '';
    rkDraw();
    const fmtD = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    const age = week.cur && RKS.cur && RKS.cur.updatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(RKS.cur.updatedAt)) / 60000)) : null;
    $('foot').innerHTML = `Ranked week ${fmtD(week.start)} → ${fmtD(week.end)} UTC${age === null ? '' : ` · crawler data updated ${age} min ago`} · computed in your browser now · ${fmtN(S.G.players)} players with battles · stats cover players the crawler tracks · ${BUILD} · icons by <a href="https://assets.clashk.ing" target="_blank" rel="noopener">ClashKing</a>`;
  } catch (e) { if (id === rkLoadId) $('out').innerHTML = `<div class="msg">Couldn’t load town hall stats: ${esc(e.message)}</div>`; }
  finally { if (refresh) { refresh.disabled = false; refresh.textContent = 'Refresh · compute live'; } }
}

async function rkInit() {
  injectStyles(); initTips(); initNav();
  const seg = $('thseg'), wsel = $('wsel');
  seg.innerHTML = [...Array.from({ length: RKN }, (_, i) => RK.MAX - i), 'all'].map((v) => `<button data-th="${v}" aria-pressed="${String(v) === RKS.sel}">${v === 'all' ? 'All town halls' : rkThIcon(v, 28) + 'TH' + v}</button>`).join('');
  try {
    const cur = await rkFetch(`${CONFIG.REPO_RAW}/${RK.BRANCH}/ranked/current.json?t=${Date.now()}`, false);
    if (!cur) throw new Error('no ranked data has been published yet');
    RKS.cur = cur;
    const s0 = Date.parse(cur.start), len = Date.parse(cur.end) - s0;
    RKS.weeks = Array.from({ length: RK.WEEKS }, (_, k) => { const start = s0 - k * 7 * CONFIG.DAY; return { key: new Date(start).toISOString().slice(0, 10), start, end: start + len, cur: k === 0 }; });
  } catch (e) {
    $('out').innerHTML = `<div class="msg">Ranked data isn’t available yet (${esc(e.message)}). Run the crawl-ranked-week Action once, then reload.</div>`; return;
  }
  RKS.week = RKS.weeks[0];
  wsel.innerHTML = RKS.weeks.map((w, i) => `<option value="${i}">${esc(rkWeekLabel(w))}</option>`).join('');
  wsel.onchange = () => { RKS.week = RKS.weeks[+wsel.value]; rkLoad(); };
  $('refreshStats').onclick = () => rkLoad(true);
  let lsqT; document.addEventListener('input', (e) => {
    if (e.target.id !== 'lsq') return;
    clearTimeout(lsqT); lsqT = setTimeout(() => { RKS.lgQ = e.target.value; RKS.lgPage = 0; const b = document.getElementById('lgbox'); if (b && RKS.S) b.innerHTML = rkLeagueBody(RKS.S); }, 150);
  });
  document.addEventListener('click', (e) => {
    const th = e.target.closest?.('#thseg button');
    if (th) { RKS.sel = th.dataset.th; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === th)); rkLoad(); return; }
    const x = e.target.closest?.('.xbtn');
    if (x) { const open = x.closest('.xp').classList.toggle('open'); x.textContent = open ? 'Show less' : x.dataset.label; return; }
    const v = e.target.closest?.('.vbtn');
    if (v) {
      const box = document.getElementById('vars' + v.dataset.g), g = state.list[+v.dataset.g], open = v.getAttribute('aria-expanded') !== 'true';
      if (open && !box.innerHTML) box.innerHTML = rkVariants(g);
      box.hidden = !open; box.style.display = open ? '' : 'none'; v.setAttribute('aria-expanded', open); v.textContent = `${open ? '▾' : '▸'} ${fmtN(g.vars.size)} variations`; return;
    }
    const pg = e.target.closest?.('#lpg button');
    if (pg && !pg.disabled) {
      const n = Math.ceil(RKS.S.lgSorted[RKS.lgGroup].length / RK_LG_PAGE) - 1;
      RKS.lgPage = { first: 0, prev: RKS.lgPage - 1, next: RKS.lgPage + 1, last: n }[pg.dataset.p];
      const box = document.getElementById('lgbox'); box.innerHTML = rkLeagueBody(RKS.S); box.scrollIntoView({ block: 'start' }); return;
    }
    const lb = e.target.closest?.('#lseg button');
    if (lb) { RKS.lgGroup = +lb.dataset.l; RKS.lgPage = 0; lb.parentNode.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === lb)); document.getElementById('lgbox').innerHTML = rkLeagueBody(RKS.S); return; }
    const b = e.target.closest?.('#bseg button, #sseg button'); if (!b) return;
    if (b.dataset.b != null) RKS.group = +b.dataset.b; if (b.dataset.s) RKS.sort = b.dataset.s;
    rkDrawArmies();
  });
  rkCardInit();
  rkLoad();
}

// ---------- player card (downloadable image) ----------
// Same 1600px card the Discord bot makes (townhallStats.js): rank tiles, your week vs the town hall average, town hall at a glance,
// top lists with the player pinned, and (when the data has them) the most popular armies and openers. Drawn on a canvas in the browser.
// The town hall's numbers come from the same crawl data this page already loaded, so no extra files are needed besides that town hall's shard
// (reused from the page's cache when the selected town hall matches).
// Icons are loaded with crossOrigin="anonymous": if the asset server doesn't allow cross-site images, those icons are skipped
// (the card still downloads) and the status line says how many were missing.
const RKC = { M: 44, GAP: 20, BASE_H: 1000, AH: 300, scopes: new Map(), last: null };
const RKC_COL = { gold: '#e0a526', green: '#3ddc84', red: '#ff6b6b', lime: '#9be564', blue: '#7fd4ff', orange: '#ff9f43', dim: 'rgba(255,255,255,.55)', soft: 'rgba(255,255,255,.82)' };
const rkcFont = (s) => `bold ${Math.max(8, Math.round(s))}px "Supercell-Magic", "Barlow", "Noto Sans", "Segoe UI", system-ui, sans-serif`;
const rkcPct = (a, b, d = 1) => (b ? `${(100 * a / b).toFixed(d)}%` : '–');
const rkcAvg = (a, b, d = 2) => (b ? (a / b).toFixed(d) : '–');
const rkcDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const rkcTop = ({ rank, total }) => { const p = 100 * rank / total; return `top ${p < 1 ? Math.max(0.1, p).toFixed(1) : Math.ceil(p)}%`; };

function rkcRR(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function rkcStar(c, cx, cy, R, r = R * 0.45) { c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? r : R; c[i ? 'lineTo' : 'moveTo'](cx + rad * Math.cos(a), cy + rad * Math.sin(a)); } c.closePath(); }
function rkcPanel(c, x, y, w, h, fill = 'rgba(255,255,255,.07)', line = 'rgba(255,255,255,.16)', r = 22) { rkcRR(c, x, y, w, h, r); c.fillStyle = fill; c.fill(); c.lineWidth = 1.5; c.strokeStyle = line; c.stroke(); }
// text that always fits: shrinks first (down to `min`), then is cut with an ellipsis
function rkcText(c, s, x, y, size, color, o = {}) {
  s = String(s ?? ''); c.font = rkcFont(size); c.fillStyle = color; c.textAlign = o.align || 'left';
  if (o.maxW) {
    const min = o.min || Math.max(11, Math.round(size * 0.7));
    while (c.measureText(s).width > o.maxW && size > min) { size -= 1; c.font = rkcFont(size); }
    if (c.measureText(s).width > o.maxW) { const a = Array.from(s); while (a.length > 1 && c.measureText(a.join('') + '…').width > o.maxW) a.pop(); s = a.join('') + '…'; }
  }
  c.fillText(s, x, y); c.textAlign = 'left';
}
// Canvas crown (drawn as a shape so it doesn't depend on an emoji font). (x, yb) = bottom-left corner, w = width.
function rkcCrown(c, x, yb, w) {
  const h = w * 0.78, P = [[0, 1], [0, 0.3], [0.25, 0.62], [0.5, 0], [0.75, 0.62], [1, 0.3], [1, 1]];
  c.save(); c.beginPath(); P.forEach(([px, py], i) => c[i ? 'lineTo' : 'moveTo'](x + px * w, yb - h + py * h)); c.closePath();
  c.fillStyle = '#f5c542'; c.fill(); c.lineWidth = Math.max(1, w / 16); c.strokeStyle = '#b8860b'; c.lineJoin = 'round'; c.stroke();
  c.fillStyle = '#fff3b0'; [[0, 0.3], [0.5, 0], [1, 0.3]].forEach(([px, py]) => { c.beginPath(); c.arc(x + px * w, yb - h + py * h, Math.max(1.5, w / 10), 0, Math.PI * 2); c.fill(); });
  c.restore();
}
const rkcMeasure = (c, s, size) => { c.font = rkcFont(size); return c.measureText(String(s)).width; };
function rkcImg(c, im, x, y, w, h) { if (!im) return; const k = Math.min(w / im.width, h / im.height); c.drawImage(im, x + (w - im.width * k) / 2, y + (h - im.height * k) / 2, im.width * k, im.height * k); }
const rkcClean = (s, fb) => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, '').replace(/\s+/g, ' ').trim() || fb;

// icon URLs of an opener's key parts (same parts as the Openers list above: OPENER_PARTS / openerIcons in stats.js)
function rkcOpenerUrls(raw, code) {
  const inf = code ? infoOf(code) : null, petOf = (hero) => inf?.heroes.find((h) => h.name === hero)?.pet || null;
  return (OPENER_PARTS[raw] || []).map(([cat, name]) => {
    if (name === '@duke') return ['pet', petOf('Dragon Duke')];
    if (name === '@queen') return ['pet', petOf('Archer Queen')];
    if (name === '@rc') return ['pet', petOf('Royal Champion')];
    if (name === '@revenge') return ['equip', inf?.heroes.find((h) => h.name === 'Dragon Duke')?.equip.find((g) => /revenge/i.test(g)) || null];
    return [cat, name];
  }).filter(([, name]) => name).map(([cat, name]) => ckUrl(partIcon(cat, name))).filter(Boolean).slice(0, 4);
}

// ---- data ----
// { th, T (stats of the player's town hall), row, lg, ranks, tops, ... } for one tag. Loads that town hall's shard when the page is showing another one.
async function rkCardScope(th) {
  const S = RKS.S, inRange = th >= RK.MIN && th <= RK.MAX;
  if (!inRange || (!S.multi && RKS.sel === String(th))) return S;
  const key = `${RKS.week.key}|${th}`; let T = RKC.scopes.get(key);
  if (!T) {
    const raw = await rkTh(RKS.week, th); if (!raw) return S;
    T = await rkCompute([{ th, raw }], RKS.week, () => {}, () => false); if (!T) return S;
    RKC.scopes.set(key, T); while (RKC.scopes.size > 3) RKC.scopes.delete(RKC.scopes.keys().next().value);
  }
  return T;
}
// lex(a, b) > 0 when a is better than b
const rkcLex = (...ks) => (a, b) => { for (const [f, dir] of ks) { const d = (f(a) - f(b)) * dir; if (d) return d; } return 0; };
const rkcDefs = () => ({
  attack: { has: (r) => r.na > 0, qual: (r) => r.na >= RK.MIN_ATK, cmp: rkcLex([(r) => wilson(r.s3, r.na), 1], [(r) => r.na, 1]) },
  most3: { has: (r) => r.na > 0, qual: (r) => r.na > 0, cmp: rkcLex([(r) => r.s3, 1], [(r) => r.na, 1]) },
  defense: { has: (r) => r.nd > 0, qual: (r) => r.nd >= RK.MIN_DEF, cmp: rkcLex([(r) => r.dst / r.nd, -1], [(r) => r.nd, 1]) },
  offtr: { has: (r) => r.na > 0, qual: (r) => r.na > 0, cmp: rkcLex([(r) => r.ot, 1], [(r) => r.na, 1]) },
  deftr: { has: (r) => r.nd > 0, qual: (r) => r.nd > 0, cmp: rkcLex([(r) => r.dt, 1], [(r) => r.nd, 1]) },
});
const rkcTops = (pool, defs, n = 6) => Object.fromEntries(Object.keys(defs).map((k) => [k, pool.filter((r) => defs[k].qual(r) && defs[k].has(r)).sort((a, b) => defs[k].cmp(b, a) || (a.name < b.name ? -1 : 1)).slice(0, n)]));
const rkcLeagueUrl = (name) => /src="([^"]+)"/.exec(rkLeagueIcon(name))?.[1] || '';
// top players by total trophies: highest league first, trophies break ties (same order as the global rank)
const rkcTrophyTop = (lgPool, n) => [...lgPool].sort((a, b) => b.lid - a.lid || b.tr - a.tr || (a.name < b.name ? -1 : 1)).slice(0, n);
// most popular armies / openers of one town hall's stats (T = rkCompute result, t = its group)
function rkcArmyData(t) {
  const armies = [...t.armies].sort((a, b) => b[1].players - a[1].players || b[1].uses - a[1].uses).slice(0, 5).map(([key, g]) => {
    const code = repOf(g).code; let label = 'Army';
    try { label = infoOf(code).cls.core || infoOf(code).cls.strategy || 'Army'; } catch { /* keep default */ }
    let ic = []; try { ic = mainTroops(code, 5).map(([id]) => ckUrl((ARMY_IDS.troop[id] || [])[1])).filter(Boolean); } catch { /* no icons */ }
    return { key, label, icons: ic, players: g.players, uses: g.uses, st: g.st, s3: g.s3, pc: g.pc };
  });
  const openers = [...t.opener].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([name, e]) => {
    let ic = []; try { ic = rkcOpenerUrls(name, topCode(e.codes)); } catch { /* no icons */ }
    return { name, n: e.n, s3: e.s3, st: e.st, icons: ic };
  });
  return { armies, openers, oTotal: [...t.opener.values()].reduce((a, e) => a + e.n, 0) };
}
// the 3 highest leagues that have players among a town hall's tracked players: [{ label, icon, n, lid }] (same rule as the bot's topLeagues)
function rkcLeagues(lgPool, max = 3) {
  const m = new Map();
  for (const r of lgPool) { if (!r.ln || /^unranked$/i.test(r.ln)) continue; const e = m.get(r.lid) || m.set(r.lid, { name: r.ln, lid: r.lid, n: 0 }).get(r.lid); e.n++; }
  const all = [...m.values()].sort((a, b) => b.lid - a.lid);
  return { top: all.slice(0, max).map((l) => ({ label: String(l.name).replace(/\s+league\b/i, '').trim(), icon: rkcLeagueUrl(l.name), n: l.n, lid: l.lid })), total: all.reduce((t, l) => t + l.n, 0) };
}

// Town hall card (no player): totals, top lists, players per league, most popular armies and openers. Same image as the bot's town hall stats.
async function rkCardBuildTh(th) {
  const S = RKS.S; if (!S) return null;
  const T = await rkCardScope(th); if (!T || !T.B[rkIdx(th)] || !T.B[rkIdx(th)].players) return null;
  const pool = T.rows.filter((r) => r.th === th), lgPool = T.lg.filter((r) => r.th === th), allLeaguePlayers = T.leagueProfiles.filter((r) => r.th === th);
  const t = T.B[rkIdx(th)], { armies, openers, oTotal } = rkcArmyData(t), lg = rkcLeagues(allLeaguePlayers);
  return { solo: true, th, inRange: true, S: T, G: T.G, me: { tag: null, na: 0, s3: 0, nd: 0, dst: 0, dz: 0, name: '' }, lgMe: null, atk: 0, ranks: {}, tops: { ...rkcTops(pool, rkcDefs(), 10), trophies: rkcTrophyTop(lgPool, 10) },
    gaOf: new Map(lgPool.map((r) => [r.tag, r.ga])), armies, openers, oTotal, withCode: t.withCode, myArmy: null, myOpener: null, lgTop: lg.top, lgTotal: lg.total, name: `Town Hall ${th}`, week: RKS.week };
}
async function rkCardBuild(tag0) {
  const S0 = RKS.S, tag = normTag(tag0), r0 = S0.rows.find((r) => r.tag === tag) || S0.rows.find((r) => normTag(r.tag) === tag);
  if (!r0) return null;
  const th = r0.th, inRange = th >= RK.MIN && th <= RK.MAX, T = await rkCardScope(th);
  const pool = T.rows.filter((r) => !inRange || r.th === th), me = pool.find((r) => r.tag === r0.tag) || r0;
  const lgPool = T.lg.filter((r) => !inRange || r.th === th), lgMe = lgPool.find((r) => r.tag === me.tag) || null;
  const gaOf = new Map(lgPool.map((r) => [r.tag, r.ga])), ga = lgMe?.ga ?? null, atk = Math.max(ga ?? 0, me.na);

  // ranking: lex(a, b) > 0 when a is better than b. Unqualified players still get a rank (q = false) = where they would land.
  const lex = rkcLex, defs = rkcDefs();
  const rankIn = (list, def, who) => {
    if (!def.has(who)) return null;
    const qs = list.filter((r) => def.qual(r) && r.tag !== who.tag), q = def.qual(who);
    return { rank: qs.filter((r) => def.cmp(r, who) > 0).length + 1, total: qs.length + 1, q };
  };
  const ranks = {}, tops = {};
  for (const k of Object.keys(defs)) {
    ranks[k] = rankIn(pool, defs[k], me);
  }
  Object.assign(tops, rkcTops(pool, defs, 6), { trophies: rkcTrophyTop(lgPool, 6) });
  if (lgMe) {
    const lgCmp = lex([(r) => r.lid, 1], [(r) => r.tr, 1]);
    ranks.global = { rank: lgPool.filter((r) => r.tag !== lgMe.tag && lgCmp(r, lgMe) > 0).length + 1, total: lgPool.length, q: true };
    const same = lgPool.filter((r) => r.lid === lgMe.lid);
    ranks.league = { rank: same.filter((r) => r.tag !== lgMe.tag && r.tr > lgMe.tr).length + 1, total: same.length, q: true };
  }

  // armies / openers of the player's town hall
  const t = T.B[inRange ? rkIdx(th) : RKN], G = T.G;
  const { armies, openers, oTotal } = rkcArmyData(t);
  return { th, inRange, S: T, G, me, lgMe, atk, ranks, tops, gaOf, armies, openers, oTotal, withCode: t.withCode, myArmy: me.army, myOpener: me.op,
    name: rkcClean(me.name, me.tag), week: RKS.week };
}

// ---- drawing ----
async function rkcLoad(url) {
  return new Promise((res) => { const im = new Image(); const t = setTimeout(() => res(null), 8000); im.crossOrigin = 'anonymous';
    im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); }; im.src = url; });
}
async function rkCardRender(d, cv, load = rkcLoad) {
  // solo card: the top lists grow from 5 to up to 10 rows (28px each) when there are that many players
  const ROWS = d.solo ? Math.max(5, Math.min(10, ...['trophies', 'offtr', 'deftr'].map((k) => (d.tops[k] || []).length))) : 5;
  const { M, GAP, AH } = RKC, solo = !!d.solo, BASE_H = solo ? 794 + (ROWS - 5) * 28 : RKC.BASE_H, LGH = 176, W = 1600, CW = W - 2 * M, hasArmies = d.armies.length > 0 || d.openers.length > 0,
    lgTop = d.lgTop || [], hasLg = lgTop.length > 0,
    hasChamp = isChamp(d.me.tag) || ['trophies', 'offtr', 'deftr'].some((k) => (d.tops[k] || []).slice(0, ROWS).some((r) => isChamp(r.tag))),
    H = BASE_H + (hasLg ? LGH + GAP : 0) + (hasArmies ? AH + GAP : 0) + (hasChamp || WORLD_CHAMPS[d.th] ? 30 : 0);
  cv.width = W; cv.height = H; const c = cv.getContext('2d'), { G, me, th } = d, atk = d.atk, logged = me.na, ranks = d.ranks, C = RKC_COL;
  c.textBaseline = 'alphabetic';
  const lgName = d.lgMe?.ln || '', lgUrl = lgName && /src="([^"]+)"/.exec(rkLeagueIcon(lgName))?.[1];
  const urls = new Set([d.inRange ? `https://assets.clashk.ing/buildings/home-village/town_hall/level_${th}.webp` : '', lgUrl || '',
    ...d.armies.flatMap((a) => a.icons), ...d.openers.flatMap((o) => o.icons), ...lgTop.map((l) => l.icon)].filter(Boolean));
  const imgs = new Map(await Promise.all([...urls].map(async (u) => [u, await load(u)])));
  const missing = [...imgs.values()].filter((x) => !x).length;
  const thIcon = imgs.get(`https://assets.clashk.ing/buildings/home-village/town_hall/level_${th}.webp`), lgIcon = lgUrl ? imgs.get(lgUrl) : null;
  const thLabel = d.inRange ? `TH${th}` : 'ALL', thName = d.inRange ? `TOWN HALL ${th}` : 'ALL TOWN HALLS';

  // background
  let g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1f1850'); g.addColorStop(0.55, '#130f32'); g.addColorStop(1, '#0a0822'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.92, 80, 0, W * 0.92, 80, 640); g.addColorStop(0, 'rgba(139,108,246,.42)'); g.addColorStop(1, 'rgba(139,108,246,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.08, H, 0, W * 0.08, H, 640); g.addColorStop(0, 'rgba(224,165,38,.24)'); g.addColorStop(1, 'rgba(224,165,38,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(224,165,38,.05)'; rkcStar(c, W - 220, 150, 200); c.fill(); rkcStar(c, W - 70, 330, 80); c.fill();
  rkcRR(c, 16, 16, W - 32, H - 32, 34); c.lineWidth = 3; c.strokeStyle = 'rgba(224,165,38,.55)'; c.stroke();

  // header
  const ICON = 120, rightEdge = W - M; if (thIcon) rkcImg(c, thIcon, rightEdge - ICON, 38, ICON, ICON);
  const pillRight = rightEdge - (thIcon ? ICON + 20 : 0); let pillLeft = pillRight;
  if (lgName) {
    const pad = 22, iconW = lgIcon ? 46 : 0, lw = Math.min(520, rkcMeasure(c, lgName, 24) + pad * 2 + iconW); pillLeft = pillRight - lw;
    rkcRR(c, pillLeft, 62, lw, 56, 28); c.fillStyle = 'rgba(224,165,38,.16)'; c.fill(); c.lineWidth = 2; c.strokeStyle = 'rgba(224,165,38,.7)'; c.stroke();
    if (lgIcon) rkcImg(c, lgIcon, pillLeft + 12, 66, 40, 48);
    rkcText(c, lgName, pillLeft + pad + iconW, 98, 24, C.gold, { maxW: lw - pad * 2 - iconW });
    rkcText(c, `${fmtN(d.lgMe.tr)} trophies`, pillRight, 150, 24, C.soft, { align: 'right', maxW: 420 });
  }
  const headW = Math.max(300, pillLeft - 40 - M);
  const wkLabel = new Date(d.week.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (solo) {
    rkcText(c, 'RANKED STATS', M, 72, 24, C.gold, { maxW: 600 });
    rkcText(c, d.name, M - 2, 150, 82, '#fff', { maxW: W - 2 * M - ICON - 40, min: 40 });
    rkcText(c, `Week of ${wkLabel}${d.week.cur ? ' (live)' : ''}  ·  tracking top ${fmtN(G.players)} ${thLabel} players  |  legendstats.pages.dev`, M, 190, 22, 'rgba(255,255,255,.65)', { maxW: W - 2 * M - ICON - 40 });
  } else {
  rkcText(c, `${thName} · RANKED STATS`, M, 72, 24, C.gold, { maxW: headW });
  { const ch = isChamp(d.me.tag); if (ch) rkcCrown(c, M, 142, 64); rkcText(c, d.name, M - 2 + (ch ? 80 : 0), 150, 82, '#fff', { maxW: headW - (ch ? 80 : 0), min: 40 }); }
  rkcText(c, `#${String(me.tag).replace(/^#/, '')}  ·  Week of ${new Date(d.week.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}${d.week.cur ? ' (live)' : ''}  ·  tracking top ${fmtN(G.players)} ${thLabel} players  |  legendstats.pages.dev`, M, 190, 22, 'rgba(255,255,255,.65)', { maxW: headW });
  }

  // rank tiles
  const unranked = (r) => ({ val: '–', l1: r, col: 'rgba(255,255,255,.35)' });
  const ranked = (r, col) => ({ val: `#${fmtN(r.rank)}`, l1: r.q === false ? `${fmtN(r.total)} ranked · below minimum` : `of ${fmtN(r.total)} · ${rkcTop(r)}`, col });
  const tiles = solo ? [] : [
    ['GLOBAL RANK', ranks.global ? ranked(ranks.global, C.gold) : unranked('No league data'), `${thLabel}, by league then trophies`],
    ['LEAGUE RANK', ranks.league ? ranked(ranks.league, C.lime) : unranked('No league data'), lgName ? `in ${lgName}` : ''],
    ['ATTACK RANK', ranks.attack ? ranked(ranks.attack, C.green) : unranked('No attacks yet'), `3★ rate ${rkcPct(me.s3, logged)} · ${fmtN(atk)} attack${atk === 1 ? '' : 's'}${atk > logged ? ` (${fmtN(logged)} logged)` : ''}`],
    ['DEFENSE RANK', ranks.defense ? ranked(ranks.defense, C.blue) : unranked('No defenses yet'), `${rkcAvg(me.dst, me.nd)} ★ conceded · ${fmtN(me.nd)} def`],
    ['MOST 3★ ATTACKS', ranks.most3 ? ranked(ranks.most3, C.orange) : unranked('No attacks yet'), `${fmtN(me.s3)}×3★ this week`],
  ];
  const TY = 220, TILE_H = solo ? 0 : 186, tw = (CW - 4 * GAP) / 5, tp = 24;
  tiles.forEach(([lab, t, l2], i) => {
    const x = M + i * (tw + GAP); rkcPanel(c, x, TY, tw, TILE_H);
    c.save(); rkcRR(c, x, TY, tw, TILE_H, 22); c.clip(); c.fillStyle = t.col; c.globalAlpha = 0.9; c.fillRect(x, TY, tw, 5); c.restore();
    rkcText(c, lab, x + tp, TY + 40, 18, C.dim, { maxW: tw - 2 * tp }); rkcText(c, t.val, x + tp, TY + 112, 82, t.col, { maxW: tw - 2 * tp, min: 44 });
    rkcText(c, t.l1, x + tp, TY + 148, 19, C.soft, { maxW: tw - 2 * tp }); rkcText(c, l2, x + tp, TY + 171, 16, C.dim, { maxW: tw - 2 * tp });
  });

  // you vs average
  const MY = solo ? TY : TY + TILE_H + GAP, MH = 288, LW = solo ? 0 : 840, RW = solo ? CW : CW - LW - GAP, pd = 28, gS3 = G.astars[3];
  if (!solo) {
  rkcPanel(c, M, MY, LW, MH, 'rgba(139,108,246,.14)', 'rgba(139,108,246,.55)', 24);
  rkcText(c, `YOUR WEEK VS ${thLabel} AVERAGE`, M + pd, MY + 42, 20, C.gold);
  const cYou = M + LW - pd - 330, cAvg = M + LW - pd - 170, cDiff = M + LW - pd, hy = MY + 78;
  rkcText(c, 'YOU', cYou, hy, 14, C.dim, { align: 'right' }); rkcText(c, `${thLabel} AVERAGE`, cAvg, hy, 14, C.dim, { align: 'right' }); rkcText(c, 'DIFFERENCE', cDiff, hy, 14, C.dim, { align: 'right' });
  c.strokeStyle = 'rgba(255,255,255,.14)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(M + pd, hy + 12); c.lineTo(M + LW - pd, hy + 12); c.stroke();
  const gDz = G.dstars[0], gDst = G.dstars.reduce((a, n, s) => a + n * s, 0);
  const rate = (a, b) => (b ? 100 * a / b : null), f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2), fp = (v) => `${v.toFixed(1)}%`;
  const lines = [
    ['Attacks', atk, G.players ? G.att / G.players : null, f1, 1], ['3★ rate', rate(me.s3, me.na), rate(gS3, G.att), fp, 1],
    ['Stars per attack', me.na ? me.st / me.na : null, G.att ? G.st / G.att : null, f2, 1], ['Avg destruction', me.na ? me.pct / me.na : null, G.att ? G.pct / G.att : null, fp, 1],
    ['Defenses', me.nd, G.players ? G.def / G.players : null, f1, 0], ['0★ defense rate', rate(me.dz, me.nd), rate(gDz, G.def), fp, 1],
    ['Stars conceded', me.nd ? me.dst / me.nd : null, G.def ? gDst / G.def : null, f2, -1],
  ];
  const r0 = hy + 18, rh = Math.min(30, (MY + MH - 14 - r0) / lines.length);
  lines.forEach(([lab, you, av, f, dir], i) => {
    const top = r0 + i * rh, y = top + rh * 0.68;
    if (i % 2 === 0) { rkcRR(c, M + pd - 10, top, LW - 2 * pd + 20, rh, 8); c.fillStyle = 'rgba(255,255,255,.045)'; c.fill(); }
    rkcText(c, lab, M + pd, y, 20, '#fff', { maxW: 250 }); rkcText(c, you == null ? '–' : f(you), cYou, y, 21, '#fff', { align: 'right' });
    rkcText(c, av == null ? '–' : f(av), cAvg, y, 21, 'rgba(255,255,255,.68)', { align: 'right' });
    if (you != null && av != null) {
      const df = you - av, col = dir === 0 || Math.abs(df) < 1e-9 ? C.soft : ((dir > 0) === (df > 0) ? C.green : C.red);
      rkcText(c, `${df >= 0 ? '+' : '−'}${f(Math.abs(df))}`, cDiff, y, 20, col, { align: 'right' });
    } else rkcText(c, '–', cDiff, y, 20, 'rgba(255,255,255,.3)', { align: 'right' });
  });
  }

  // at a glance
  const GX = solo ? M : M + LW + GAP; rkcPanel(c, GX, MY, RW, MH, 'rgba(255,255,255,.06)', 'rgba(255,255,255,.16)', 24);
  rkcText(c, `${thLabel} AT A GLANCE`, GX + pd, MY + 42, 20, C.gold);
  const kp = [[fmtN(G.players), 'PLAYERS', '#fff'], [fmtN(G.att), 'ATTACKS', '#fff'], [rkcPct(gS3, G.att), '3★ RATE', C.green], [rkcAvg(G.st, G.att), '★ / ATTACK', '#fff'], [`${rkcAvg(G.pct, G.att, 1)}%`, 'DESTRUCTION', '#fff']];
  const kw = (RW - 2 * pd) / kp.length;
  kp.forEach(([v, l, col], i) => { const x = GX + pd + i * kw; rkcText(c, v, x, MY + 96, 36, col, { maxW: kw - 18, min: 22 }); rkcText(c, l, x, MY + 120, 13, C.dim, { maxW: kw - 10 }); });
  c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(GX + pd, MY + 138); c.lineTo(GX + RW - pd, MY + 138); c.stroke();
  const dist = (title, arr, colors, x0, y0, w0) => {
    const sum = arr.reduce((a, b) => a + b, 0) || 1; rkcText(c, title, x0, y0, 14, C.dim, { maxW: w0 });
    for (let s = 3; s >= 0; s--) {
      const yy = y0 + 14 + (3 - s) * 27, bx = x0 + 36, bw = w0 - 36 - 64; rkcText(c, `${s}★`, x0, yy + 17, 17, '#fff');
      c.fillStyle = 'rgba(255,255,255,.1)'; rkcRR(c, bx, yy + 4, bw, 14, 7); c.fill(); c.fillStyle = colors[s]; rkcRR(c, bx, yy + 4, Math.max(8, bw * arr[s] / sum), 14, 7); c.fill();
      rkcText(c, rkcPct(arr[s], sum), x0 + w0, yy + 17, 16, '#fff', { align: 'right' });
    }
  };
  const dw = (RW - 2 * pd - 32) / 2;
  dist('ATTACK RESULTS', G.astars, [C.red, C.gold, C.lime, C.green], GX + pd, MY + 166, dw);
  dist('DEFENSE RESULTS (ATTACKER STARS)', G.dstars, [C.green, C.lime, C.gold, C.red], GX + pd + dw + 32, MY + 166, dw);

  // top lists (the player is pinned to the last row when outside the top)
  const LY = MY + MH + GAP, LH = BASE_H - 62 - LY, lw3 = (CW - 2 * GAP) / 3;
  const myRow = { tag: me.tag, name: me.name, s3: me.s3, na: logged, ga: atk, dst: me.dst, nd: me.nd, dz: me.dz, tr: d.lgMe?.tr || 0, ln: d.lgMe?.ln || '', ot: me.ot || 0, dt: me.dt || 0 };
  const gaOf = (r) => Math.max(d.gaOf.get(r.tag) ?? 0, r.na);
  const lists = [
    ['TOP TROPHIES', 'trophies', (r) => fmtN(r.tr), (r) => String(r.ln || '').replace(/\s+league\b/i, ''), C.gold, !!d.lgMe, 'global'],
    ['TOP OFFENSE TROPHIES', 'offtr', (r) => fmtN(r.ot), (r) => `${r.ga ?? gaOf(r)} atk`, C.orange, logged > 0],
    ['TOP DEFENSE TROPHIES', 'deftr', (r) => fmtN(r.dt), (r) => `${r.dz}×0★ · ${r.nd} def`, C.blue, me.nd > 0],
  ];
  lists.forEach(([title, key, val, sub, col, hasStats, rk = key], i) => {
    const full = d.tops[key], x = M + i * (lw3 + GAP), lp = 24; rkcPanel(c, x, LY, lw3, LH, 'rgba(255,255,255,.06)');
    rkcText(c, `${thLabel} · ${title}`, x + lp, LY + 38, 18, C.gold, { maxW: lw3 - 2 * lp });
    const idx = full.findIndex((r) => r.tag === me.tag), myRank = ranks[rk]?.rank ?? (idx >= 0 ? idx + 1 : null); let rows;
    if (idx >= 0 && idx < ROWS) rows = full.slice(0, ROWS).map((r, k) => ({ rank: k + 1, r, mine: r.tag === me.tag }));
    else if (hasStats && myRank != null) { rows = full.slice(0, ROWS - 1).map((r, k) => ({ rank: k + 1, r, mine: false })); rows.push({ rank: myRank, r: myRow, mine: true, gap: myRank > ROWS }); }
    else rows = full.slice(0, ROWS).map((r, k) => ({ rank: k + 1, r, mine: false }));
    const rankW = Math.max(18, ...rows.map((o) => rkcMeasure(c, String(o.rank), 17))) + 8, valW = Math.max(50, ...rows.map((o) => rkcMeasure(c, val(o.r), 19))) + 6;
    const subW = Math.max(0, ...rows.map((o) => rkcMeasure(c, sub(o.r), 14))) + 6, nameX = x + lp + rankW, nameMax = Math.max(60, lw3 - lp * 2 - rankW - valW - subW - 14);
    const rowTop = LY + 52, rh2 = (LH - 52 - 12) / ROWS;
    rows.forEach((o, k) => {
      const top = rowTop + k * rh2, y = top + rh2 * 0.68;
      if (o.mine) { rkcRR(c, x + 12, top, lw3 - 24, rh2, 8); c.fillStyle = 'rgba(224,165,38,.22)'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = 'rgba(224,165,38,.7)'; c.stroke(); }
      else if (k % 2 === 0) { rkcRR(c, x + 12, top, lw3 - 24, rh2, 8); c.fillStyle = 'rgba(255,255,255,.04)'; c.fill(); }
      if (o.gap) { c.save(); c.setLineDash([2, 5]); c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x + lp, top - 1); c.lineTo(x + lw3 - lp, top - 1); c.stroke(); c.restore(); }
      rkcText(c, fmtN(o.rank), x + lp, y, 17, o.mine ? C.gold : C.dim, { maxW: rankW - 4, min: 10 });
      const ch = isChamp(o.r.tag); if (ch) rkcCrown(c, nameX, y + 1, 20);
      rkcText(c, rkcClean(o.r.name, o.r.tag || '?'), nameX + (ch ? 25 : 0), y, 18, o.mine ? C.gold : '#fff', { maxW: nameMax - (ch ? 25 : 0), min: 12 });
      rkcText(c, sub(o.r), x + lw3 - lp - valW - 12, y, 14, C.dim, { align: 'right', maxW: subW }); rkcText(c, val(o.r), x + lw3 - lp, y, 19, col, { align: 'right', maxW: valW });
    });
    if (!rows.length) rkcText(c, 'Not enough data yet', x + lp, LY + 90, 18, C.dim);
  });

  // players per league (town hall card only)
  if (hasLg) {
    const LGY = LY + LH + GAP, pdl = 26, mxN = Math.max(...lgTop.map((l) => l.n), 1);
    rkcPanel(c, M, LGY, CW, LGH, 'rgba(255,255,255,.06)');
    rkcText(c, `${thLabel} · PLAYERS IN THE TOP ${lgTop.length} LEAGUES`, M + pdl, LGY + 38, 18, C.gold, { maxW: 560 });
    rkcText(c, `${fmtN(lgTop.reduce((t, l) => t + l.n, 0))} of ${fmtN(d.lgTotal)} tracked players with a league`, M + CW - pdl, LGY + 38, 14, C.dim, { align: 'right', maxW: CW - 2 * pdl - 570, min: 9 });
    const colW = (CW - 2 * pdl) / lgTop.length;
    lgTop.forEach((l, i) => {
      const cx = M + pdl + colW * i + colW / 2;
      rkcImg(c, imgs.get(l.icon), cx - 27, LGY + 52, 54, 54);
      rkcText(c, l.label, cx, LGY + 122, 17, C.soft, { align: 'center', maxW: colW - 12, min: 10 });
      rkcText(c, fmtN(l.n), cx, LGY + 150, 26, '#fff', { align: 'center', maxW: colW - 12, min: 12 });
      c.fillStyle = 'rgba(255,255,255,.1)'; rkcRR(c, cx - colW / 2 + 12, LGY + 160, colW - 24, 6, 3); c.fill();
      c.fillStyle = C.gold; rkcRR(c, cx - colW / 2 + 12, LGY + 160, Math.max(6, (colW - 24) * l.n / mxN), 6, 3); c.fill();
    });
  }

  // most popular armies + openers
  if (hasArmies) {
    const AY = LY + LH + GAP + (hasLg ? LGH + GAP : 0), pd2 = 26, AW = 900, OW = CW - AW - GAP, OX = M + AW + GAP, rowsN = 5, headY = AY + 72, rowTop0 = AY + 86, rowH = (AH - 86 - 14) / rowsN;
    const hl = (x, y, w, mine, k) => { if (mine) { rkcRR(c, x + 12, y, w - 24, rowH, 8); c.fillStyle = 'rgba(224,165,38,.22)'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = 'rgba(224,165,38,.7)'; c.stroke(); } else if (k % 2 === 0) { rkcRR(c, x + 12, y, w - 24, rowH, 8); c.fillStyle = 'rgba(255,255,255,.04)'; c.fill(); } };
    rkcPanel(c, M, AY, AW, AH, 'rgba(255,255,255,.06)'); rkcText(c, `${thLabel} · MOST POPULAR ARMIES`, M + pd2, AY + 38, 18, C.gold, { maxW: 420 });
    rkcText(c, `${fmtN(d.withCode)} players with an army link · one army each, the one they used most`, M + AW - pd2, AY + 38, 14, C.dim, { align: 'right', maxW: AW - 2 * pd2 - 430, min: 9 });
    const cUse = M + AW - pd2 - 270, c3 = M + AW - pd2 - 170, cSt = M + AW - pd2 - 84, cDe = M + AW - pd2;
    for (const [lab, x] of [['USED BY', cUse], ['3★ RATE', c3], ['★ / ATK', cSt], ['DEST.', cDe]]) rkcText(c, lab, x, headY, 13, C.dim, { align: 'right' });
    const IS = Math.min(36, rowH - 8), maxIc = Math.max(0, ...d.armies.map((a) => a.icons.length)), labX = M + pd2 + 30 + maxIc * (IS + 4) + 8;
    d.armies.forEach((a, k) => {
      const top = rowTop0 + k * rowH, y = top + rowH * 0.66, mine = a.key === d.myArmy; hl(M, top, AW, mine, k);
      rkcText(c, String(k + 1), M + pd2, y, 17, mine ? C.gold : C.dim); let ix = M + pd2 + 30;
      a.icons.forEach((u) => { rkcImg(c, imgs.get(u), ix, top + (rowH - IS) / 2, IS, IS); ix += IS + 4; });
      rkcText(c, a.label, labX, y, 18, mine ? C.gold : '#fff', { maxW: cUse - 90 - labX });
      rkcText(c, rkcPct(a.players, d.withCode), cUse, y, 19, '#fff', { align: 'right' }); rkcText(c, rkcPct(a.s3, a.uses), c3, y, 19, C.green, { align: 'right' });
      rkcText(c, rkcAvg(a.st, a.uses), cSt, y, 19, '#fff', { align: 'right' }); rkcText(c, `${rkcAvg(a.pc, a.uses, 0)}%`, cDe, y, 19, C.soft, { align: 'right' });
    });
    if (!d.armies.length) rkcText(c, 'No army data yet', M + pd2, AY + 110, 18, C.dim);

    rkcPanel(c, OX, AY, OW, AH, 'rgba(255,255,255,.06)'); rkcText(c, `${thLabel} · MOST POPULAR OPENERS`, OX + pd2, AY + 38, 18, C.gold, { maxW: OW - 2 * pd2 });
    const oUse = OX + OW - pd2 - 150, o3 = OX + OW - pd2 - 74, oSt = OX + OW - pd2;
    for (const [lab, x] of [['USED', oUse], ['3★ RATE', o3], ['★ / ATK', oSt]]) rkcText(c, lab, x, headY, 13, C.dim, { align: 'right' });
    const OIS = Math.min(30, rowH - 10), maxOp = Math.max(0, ...d.openers.map((o) => o.icons.length)), nameX = OX + pd2 + 28 + (maxOp ? maxOp * (OIS + 3) + 6 : 0);
    d.openers.forEach((o, k) => {
      const top = rowTop0 + k * rowH, y = top + rowH * 0.66, mine = !!d.myOpener && o.name === d.myOpener; hl(OX, top, OW, mine, k);
      rkcText(c, String(k + 1), OX + pd2, y, 17, mine ? C.gold : C.dim); let ox = OX + pd2 + 28;
      o.icons.forEach((u) => { rkcImg(c, imgs.get(u), ox, top + (rowH - OIS) / 2, OIS, OIS); ox += OIS + 3; });
      const nm = rkcClean(o.name, '?'), nmax = oUse - 62 - nameX, col = mine ? C.gold : '#fff';
      if (rkcMeasure(c, nm, 15) <= nmax) rkcText(c, nm, nameX, y, 18, col, { maxW: nmax, min: 15 });
      else { // long names (4 icons leave little room) wrap onto two lines
        const words = nm.split(' '); let l1 = words[0], i = 1;
        while (i < words.length && rkcMeasure(c, `${l1} ${words[i]}`, 14) <= nmax) l1 += ` ${words[i++]}`;
        rkcText(c, l1, nameX, y - 7, 14, col, { maxW: nmax, min: 10 });
        if (i < words.length) rkcText(c, words.slice(i).join(' '), nameX, y + 10, 14, col, { maxW: nmax, min: 10 });
      }
      rkcText(c, rkcPct(o.n, d.oTotal), oUse, y, 19, '#fff', { align: 'right' }); rkcText(c, rkcPct(o.s3, o.n), o3, y, 19, C.green, { align: 'right' }); rkcText(c, rkcAvg(o.st, o.n), oSt, y, 19, '#fff', { align: 'right' });
    });
    if (!d.openers.length) rkcText(c, 'No opener data yet', OX + pd2, AY + 110, 18, C.dim);
  }
  if (hasChamp || WORLD_CHAMPS[th]) { // cards of a town hall with champions always name them; other cards explain the crown only if one appears
    const msg = WORLD_CHAMPS[th] ? `TH${th} World Champions: ${WORLD_CHAMPS[th].names.join(', ')}` : 'Crown = World Champions (community recognition, not part of the ranked stats)', mw = Math.min(rkcMeasure(c, msg, 14), CW - 80), x0 = W / 2 - (mw + 28) / 2;
    rkcCrown(c, x0, H - 57, 20); rkcText(c, msg, x0 + 28, H - 58, 14, 'rgba(255,255,255,.6)', { maxW: CW - 80, min: 9 });
  }
  rkcText(c, `${thLabel} stats: legendstats.pages.dev  |  assets by ClashKing`, W / 2, H - 34, 14, 'rgba(255,255,255,.42)', { align: 'center', maxW: CW - 40, min: 9 });
  return { missing, total: imgs.size };
}

// ---- page section ----
const rkCardPanel = () => `<h2 class="sh">Player card</h2><section class="panel"><p class="sub">Search a tracked player by name or tag to make their ranked week card (the same image the Discord bot posts) and download it. Ranks and averages are for their town hall.</p>
  <div class="controls"><div class="sbox"><input id="cdq" type="search" placeholder="Player name or tag" aria-label="Player card: search by name or tag" autocomplete="off"></div><button class="btn" id="cdgo" type="button">Make card</button></div>
  <div id="cdpick"></div><div id="cdout"></div></section>`;

// ---- town hall card section ----
const rkThCardPanel = () => `<h2 class="sh">Town hall card</h2><section class="panel"><p class="sub">The selected town hall’s shareable ranked-week card appears automatically. Choose another town hall to update it, or download the image.</p>
  <div class="controls"><div class="seg wrapseg" id="tcseg" role="group" aria-label="Town hall card">${Array.from({ length: RKN }, (_, i) => RK.MAX - i).map((v) => `<button data-tc="${v}" aria-pressed="false">${rkThIcon(v, 24)}TH${v}</button>`).join('')}</div></div>
  <div id="tcout"></div></section>`;
async function rkThCardShow(th) {
  const out = document.getElementById('tcout'), seg = document.getElementById('tcseg'); if (!out || !RKS.S) return;
  seg?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tc === String(th)));
  out.innerHTML = '<div class="msg">Building the card…</div>';
  try {
    const key = RKS.week.key, d = await rkCardBuildTh(th);
    if (!d) { out.innerHTML = `<div class="msg">No ranked data for TH${th} in this week yet.</div>`; return; }
    try { await document.fonts.load('bold 20px "Supercell-Magic"'); } catch { /* font is optional */ }
    const cv = document.createElement('canvas'), info = await rkCardRender(d, cv);
    if (RKS.week.key !== key || !document.body.contains(out)) return;
    cv.style.cssText = 'width:100%;height:auto;border-radius:12px;display:block'; RKC.lastTh = { cv, th, week: key };
    out.innerHTML = ''; out.append(cv);
    const bar = document.createElement('div'); bar.className = 'controls'; bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="btn" id="tcdl" type="button">Download image</button><span class="sub" id="tcnote">${info.missing ? `${info.missing} of ${info.total} icons couldn’t be loaded (the icon server may block other sites), so they’re left out.` : ''}</span>`;
    out.append(bar);
  } catch (e) { out.innerHTML = `<div class="msg">Couldn’t make the card: ${esc(e.message)}</div>`; }
}

async function rkCardShow(tag) {
  const out = document.getElementById('cdout'), pick = document.getElementById('cdpick'); if (!out || !RKS.S) return;
  pick.innerHTML = ''; out.innerHTML = '<div class="msg">Building the card…</div>';
  try {
    const id = RKS.week.key, d = await rkCardBuild(tag);
    if (!d) { out.innerHTML = '<div class="msg">That player isn’t in this week’s data.</div>'; return; }
    try { await document.fonts.load('bold 20px "Supercell-Magic"'); } catch { /* font is optional */ }
    const cv = document.createElement('canvas'), info = await rkCardRender(d, cv);
    if (RKS.week.key !== id || !document.body.contains(out)) return;
    cv.style.cssText = 'width:100%;height:auto;border-radius:12px;display:block'; RKC.last = { cv, name: d.name, tag: d.me.tag };
    out.innerHTML = ''; out.append(cv);
    const bar = document.createElement('div'); bar.className = 'controls'; bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="btn" id="cddl" type="button">Download image</button><span class="sub" id="cdnote">${info.missing ? `${info.missing} of ${info.total} icons couldn’t be loaded (the icon server may block other sites), so they’re left out.` : ''}</span>`;
    out.append(bar);
  } catch (e) { out.innerHTML = `<div class="msg">Couldn’t make the card: ${esc(e.message)}</div>`; }
}
function rkCardSearch() {
  const q = (document.getElementById('cdq')?.value || '').trim(), pick = document.getElementById('cdpick'), out = document.getElementById('cdout'); if (!q || !RKS.S) return;
  const nq = q.replace(/^#/, '').toLowerCase(), NQ = nq.toUpperCase(), rows = RKS.S.rows;
  let hits = rows.filter((r) => normTag(r.tag) === NQ || normTag(r.tag) === normTag(q));
  if (!hits.length) hits = rows.filter((r) => r.name.toLowerCase() === nq);
  if (!hits.length) hits = rows.filter((r) => r.name.toLowerCase().includes(nq) || normTag(r.tag).includes(NQ)).sort((a, b) => b.na - a.na).slice(0, 8);
  if (!hits.length) { pick.innerHTML = ''; out.innerHTML = `<div class="msg">No tracked player matching “${esc(q)}”.</div>`; return; }
  if (hits.length === 1) { rkCardShow(hits[0].tag); return; }
  out.innerHTML = ''; pick.innerHTML = `<p class="sub">Several matches, pick one:</p><div class="controls">${hits.map((r) => `<button class="btn cdpick" type="button" data-t="${esc(r.tag)}">${esc(r.name)} <small>${r.th ? 'TH' + r.th + ' · ' : ''}${esc(r.tag)}</small></button>`).join('')}</div>`;
}
function rkCardInit() {
  document.addEventListener('click', (e) => {
    const tc = e.target.closest?.('#tcseg button'); if (tc) { rkThCardShow(+tc.dataset.tc); return; }
    if (e.target.closest?.('#tcdl') && RKC.lastTh) {
      const { cv, th, week } = RKC.lastTh, note = () => document.getElementById('tcnote');
      try { cv.toBlob((b) => { if (!b) { if (note()) note().textContent = 'The browser blocked the download because an icon came from another site. Try again after reloading.'; return; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `townhall-th${th}-${week}.png`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }, 'image/png'); } catch { if (note()) note().textContent = 'The browser blocked the download. Try again after reloading.'; }
      return;
    }
    if (e.target.closest?.('#cdgo')) { rkCardSearch(); return; }
    const p = e.target.closest?.('.cdpick'); if (p) { rkCardShow(p.dataset.t); return; }
    if (e.target.closest?.('#cddl') && RKC.last) {
      const { cv, name, tag } = RKC.last, safe = `${name}-${String(tag).replace(/^#/, '')}`.replace(/[^\p{L}\p{N}_-]+/gu, '_');
      try { cv.toBlob((b) => { if (!b) { const n = document.getElementById('cdnote'); if (n) n.textContent = 'The browser blocked the download because an icon came from another site. Try again after reloading.'; return; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `townhall-${safe}.png`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }, 'image/png'); } catch { const n = document.getElementById('cdnote'); if (n) n.textContent = 'The browser blocked the download. Try again after reloading.'; }
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'cdq') rkCardSearch(); });
}
