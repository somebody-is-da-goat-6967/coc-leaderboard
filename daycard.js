// daycard.js - the daily Legend Day recap image, drawn on a canvas (same look as the season card).
// Needs (loaded before it): armyids.js, army.js, legend.js, stats.js (computeStats + its helpers). Exposes window.DayCard = { draw }.
// draw(canvas, S, meta) -> summary object (the same facts as JSON, handy for a Discord caption).
//   S    = result of computeStats(dd, ranks, prevRanks)
//   meta = { start, end, eodDate }   (start/end = Legend Day bounds in ms)
(function () {
'use strict';
const GOLD = '#e0a526', GREEN = '#3ddc84', RED = '#ff6b6b', ACC = '#8b6cf6', LIME = '#9be564';
const W = 1080, PAD = 56, IW = W - 2 * PAD;
const FC = '"Barlow Condensed", "Arial Narrow", system-ui, sans-serif', FB = 'Barlow, system-ui, -apple-system, "Segoe UI", sans-serif';
const font = (w, s, fam = FB) => `${w} ${s}px ${fam}`;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (ms) => { const d = new Date(ms); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };

// ---------- small canvas helpers ----------
const imgCache = new Map();
const loadImg = (url) => {
  if (!url) return Promise.resolve(null);
  if (!imgCache.has(url)) imgCache.set(url, new Promise((res) => {
    const im = new Image(); im.crossOrigin = 'anonymous'; const t = setTimeout(() => res(null), 12000);
    im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); }; im.src = url;
  }));
  return imgCache.get(url);
};
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function star(c, cx, cy, R, r = R * 0.45) { c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? r : R; c[i ? 'lineTo' : 'moveTo'](cx + rad * Math.cos(a), cy + rad * Math.sin(a)); } c.closePath(); }
const spacing = (c, px) => { if ('letterSpacing' in c) c.letterSpacing = px + 'px'; };
function fitText(c, s, maxW) { // ellipsis when too long (code points, so emoji don't get cut in half)
  s = String(s ?? ''); if (c.measureText(s).width <= maxW) return s;
  const a = Array.from(s); while (a.length > 1 && c.measureText(a.join('') + '…').width > maxW) a.pop(); return a.join('') + '…';
}
function text(c, s, x, y, f, color, o = {}) { // o: align, maxW, shrink (shrink the font instead of cutting), ls
  let size = +/(\d+)px/.exec(f)[1]; c.font = f; c.fillStyle = color; c.textAlign = o.align || 'left'; spacing(c, o.ls || 0);
  if (o.maxW && o.shrink) while (c.measureText(s).width > o.maxW && size > (o.min || 20)) { size -= 2; c.font = f.replace(/\d+px/, size + 'px'); }
  c.fillText(o.maxW && !o.shrink ? fitText(c, s, o.maxW) : s, x, y); spacing(c, 0); c.textAlign = 'left';
}
function panel(c, x, y, w, h, fill = 'rgba(255,255,255,.07)', line = 'rgba(255,255,255,.16)', r = 26) { rr(c, x, y, w, h, r); c.fillStyle = fill; c.fill(); c.lineWidth = 1.5; c.strokeStyle = line; c.stroke(); }
function icon(c, im, x, y, w, h, r = 12, bg = 'rgba(255,255,255,.08)') { rr(c, x, y, w, h, r); c.save(); c.clip(); c.fillStyle = bg; c.fillRect(x, y, w, h); if (im) { const s = Math.min(w / im.width, h / im.height); c.drawImage(im, x + (w - im.width * s) / 2, y + (h - im.height * s) / 2, im.width * s, im.height * s); } c.restore(); }
function badge(c, s, x, y) { c.font = font(700, 17); const w = c.measureText(s).width + 10; c.fillStyle = 'rgba(8,6,24,.82)'; rr(c, x, y, w, 21, 7); c.fill(); c.fillStyle = '#fff'; c.textAlign = 'left'; c.fillText(s, x + 5, y + 16); }

// ---------- the facts of the day ----------
function facts(S, meta) {
  const { G, B, rows } = S, A = B[ALL], rk = (a, b) => tieRank(a.rank) - tieRank(b.rank);
  const pick = (arr, cmp, key) => { if (!arr.length) return null; const s = [...arr].sort(cmp), r = s[0]; return { r, tied: arr.filter((x) => key(x) === key(r)).length - 1 }; };
  // a player is on the records only with a full day: 8 attacks AND 8 defenses (the fastest triple is the one record without this rule)
  const full = rows.filter((r) => r.na >= 8 && r.nd >= 8), okTags = new Set(full.map((r) => r.tag));
  const net = pick(full, (a, b) => b.net - a.net || rk(a, b), (r) => r.net);
  const off = pick(full, (a, b) => a.a - b.a || rk(a, b), (r) => r.a); // lowest offense
  const wall = pick(full, (a, b) => a.d - b.d || b.dz - a.dz || rk(a, b), (r) => r.d);
  const zero = pick(full.filter((r) => r.dz > 0), (a, b) => b.dz - a.dz || b.nd - a.nd || a.d - b.d || rk(a, b), (r) => r.dz);
  const fast = pick(S.fast, (a, b) => a.time - b.time || rk(a, b), (r) => r.time);
  const moved = full.filter((r) => r.delta > 0 && Math.min(r.rank, r.prev) <= 2500);
  const climb = pick(moved, (a, b) => b.delta - a.delta || rk(a, b), (r) => r.delta);
  const giant = pick(S.upsets.filter((u) => okTags.has(u.tag)), (a, b) => (b.rank - b.oppRank) - (a.rank - a.oppRank) || rk(a, b), (r) => r.rank - r.oppRank);
  // golden hour: hour of the day (UTC) with the highest 3★ rate, only hours with a fair number of attacks
  const minN = Math.max(30, G.att * 0.01); let gh = -1;
  for (let h = 0; h < 24; h++) if (G.hours[h] >= minN && (gh < 0 || G.hours3[h] / G.hours[h] > G.hours3[gh] / G.hours[gh])) gh = h;
  // army of the day: best 3★ rate (adjusted for sample size) among armies a real number of players used
  const list = [...A.armies.values()], mp0 = Math.max(5, Math.round(A.withCode * 0.004));
  let aod = null;
  for (const [mp, mu] of [[mp0, mp0 * 4], [3, 15], [2, 8], [1, 1]]) {
    const c = list.filter((g) => g.players >= mp && g.uses >= mu);
    if (c.length) { aod = c.sort((a, b) => wilson(b.s3, b.uses) - wilson(a.s3, a.uses) || b.players - a.players)[0]; aod.minPlayers = mp; break; }
  }
  const pop = [...list].sort((a, b) => b.players - a.players || b.uses - a.uses)[0] || null;
  return { G, A, net, off, wall, zero, fast, climb, giant, gh, aod, pop };
}
function armyView(code) { // everything the card draws for one army link
  const cc = canonCode(code), merge = (arr) => { const m = new Map(); for (const [id, n] of arr) m.set(id, (m.get(id) || 0) + n); return [...m]; };
  const unit = ([id, n]) => { const [name, ic] = (isSiegeId(id) ? ARMY_IDS.siege[id] : ARMY_IDS.troop[id]) || ARMY_IDS.siege[id] || [`#${id}`, '']; return { name, n, url: ckUrl(ic) }; };
  const spell = ([id, n]) => { const [name, ic] = ARMY_IDS.spell[id] || [`#${id}`, '']; return { name, n, url: ckUrl(ic) }; };
  const sg = (a, b) => isSiegeId(a[0]) - isSiegeId(b[0]);
  const v = { troops: merge(armyCounts(secOf(cc, /u([\dx-]*)/))).sort(sg).map(unit), spells: merge(armyCounts(secOf(cc, /s([\dx-]*)/))).map(spell),
    ccUnits: merge(armyCounts(secLetter(cc, CC_UNITS))).sort(sg).map(unit), ccSpells: merge(armyCounts(secLetter(cc, CC_SPELLS))).map(spell), heroes: [] };
  try {
    v.heroes = decodeHeroes(code).map((hh) => { const nm = heroNameOf(hh);
      return { name: nm, url: heroIconUrl(nm), gear: [hh.pet ? { name: hh.pet.name, url: ckUrl(hh.pet.icon) } : null, ...(hh.equip || []).map((e) => ({ name: e.name, url: ckUrl(e.icon) }))].filter(Boolean) }; });
  } catch { /* no hero data in this link */ }
  return v;
}

// ---------- drawing ----------
async function draw(cv, S, meta) {
  try { await Promise.all([font(500, 40, FC), font(700, 40, FC), font(800, 40, FC), font(400, 20), font(500, 20), font(600, 20), font(700, 20)].map((f) => document.fonts.load(f))); await document.fonts.ready; } catch { /* fall back to system fonts */ }
  const F = facts(S, meta), { G, A } = F, c = cv.getContext('2d');
  const aodCode = F.aod ? repOf(F.aod).code : '', popCode = F.pop ? repOf(F.pop).code : '';
  const av = aodCode ? armyView(aodCode) : null, aodName = aodCode ? infoOf(aodCode).cls.strategy : '', popName = popCode ? infoOf(popCode).cls.strategy : '';
  const maxTroops = 7, maxSpells = 7, troops = av ? av.troops.slice(0, maxTroops) : [], spells = av ? av.spells.slice(0, maxSpells) : [];
  const ccAll = av ? av.ccUnits.concat(av.ccSpells).slice(0, 8) : [], heroes = av ? av.heroes.slice(0, 4) : [];
  // load every picture first, in parallel
  const pics = new Map(); const want = new Set();
  [...troops, ...spells, ...ccAll].forEach((u) => want.add(u.url)); heroes.forEach((h) => { want.add(h.url); h.gear.forEach((g) => want.add(g.url)); });
  await Promise.all([...want].map(async (u) => pics.set(u, await loadImg(u))));
  const im = (u) => pics.get(u) || null;

  // ----- layout (all heights are known up front so the canvas can be sized) -----
  const HEAD = 330, TILE_H = 150, HERO_Y_GAP = 28;
  const heroRowH = Math.max(heroes.length ? 80 + 6 + 25 : 0, 62 + 12 + 50), ccH = ccAll.length ? 56 : 0;
  const HERO_H = 314 + heroRowH + (ccH ? ccH + 14 : 0) + 30;
  const AW_H = 124, AW_GAP = 16, AW_ROWS = 4, AW_TOTAL = AW_ROWS * AW_H + (AW_ROWS - 1) * AW_GAP, CH_H = 250, FOOT = 96;
  const H = HEAD + TILE_H + HERO_Y_GAP + HERO_H + HERO_Y_GAP + 56 + AW_TOTAL + HERO_Y_GAP + CH_H + FOOT;
  cv.width = W; cv.height = H; c.clearRect(0, 0, W, H); c.textBaseline = 'alphabetic';

  // ----- background -----
  let g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1f1850'); g.addColorStop(0.55, '#130f32'); g.addColorStop(1, '#0a0822'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.9, 120, 0, W * 0.9, 120, 620); g.addColorStop(0, 'rgba(139,108,246,.42)'); g.addColorStop(1, 'rgba(139,108,246,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.05, H * 0.55, 0, W * 0.05, H * 0.55, 560); g.addColorStop(0, 'rgba(139,108,246,.16)'); g.addColorStop(1, 'rgba(139,108,246,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.12, H, 0, W * 0.12, H, 560); g.addColorStop(0, 'rgba(224,165,38,.24)'); g.addColorStop(1, 'rgba(224,165,38,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(224,165,38,.06)'; star(c, W - 150, 150, 210); c.fill(); star(c, W - 40, 330, 90); c.fill(); star(c, W - 300, 60, 60); c.fill();
  rr(c, 22, 22, W - 44, H - 44, 38); c.lineWidth = 3; c.strokeStyle = 'rgba(224,165,38,.55)'; c.stroke();

  // ----- header -----
  text(c, 'LEGEND DAY RECAP', PAD, 96, font(700, 28), GOLD, { ls: 8 });
  text(c, dmy(meta.start), PAD - 4, 230, font(800, 150, FC), '#fff');
  const sd = ((Math.floor((meta.start - Date.parse(CONFIG.SEASON_ANCHOR)) / CONFIG.DAY) % CONFIG.SEASON_DAYS) + CONFIG.SEASON_DAYS) % CONFIG.SEASON_DAYS + 1;
  const pill = `DAY ${sd} / ${CONFIG.SEASON_DAYS}`; c.font = font(700, 26); spacing(c, 3); const pw = c.measureText(pill).width + 44; spacing(c, 0);
  rr(c, W - PAD - pw, 66, pw, 50, 25); c.fillStyle = 'rgba(224,165,38,.16)'; c.fill(); c.lineWidth = 2; c.strokeStyle = 'rgba(224,165,38,.7)'; c.stroke();
  text(c, pill, W - PAD - pw / 2, 100, font(700, 26), GOLD, { align: 'center', ls: 3 });
  text(c, `${dmy(meta.start)} 05:00 UTC → ${dmy(meta.end)} 05:00 UTC`, PAD, 278, font(500, 26), 'rgba(255,255,255,.62)');
  text(c, `${fmtN(G.players)} players · ${fmtN(G.att)} attacks · ${fmtN(G.def)} defenses`, PAD, 314, font(600, 26), 'rgba(255,255,255,.88)');

  // ----- 4 headline tiles -----
  const pending = S.checkAt > Date.now(), trk = A.players + A.shield;
  const tiles = [
    ['PERFECT DAYS', fmtN(G.perfect), GOLD, `8 attacks, all 3★`],
    ['0★ DEFENSES', fmtN(G.dstars[0]), RED, `${pctOf(G.dstars[0], G.def)} of all defenses`],
    ['3★ RATE', pctOf(G.astars[3], G.att), GREEN, `${avgOf(G.astars[1] + 2 * G.astars[2] + 3 * G.astars[3], G.att, 2)} stars per attack`],
    ['SHIELDED', pending ? '–' : fmtN(A.shield), '#7fd4ff', pending ? 'check not done yet' : `${pctOf(A.shield, trk)} of ${fmtN(trk)} players`]];
  const tw = (IW - 3 * 16) / 4;
  tiles.forEach(([lab, val, col, sub], i) => {
    const x = PAD + i * (tw + 16), y = HEAD; panel(c, x, y, tw, TILE_H, 'rgba(255,255,255,.07)', 'rgba(255,255,255,.16)', 24);
    c.save(); rr(c, x, y, tw, TILE_H, 24); c.clip(); c.fillStyle = col; c.globalAlpha = 0.9; c.fillRect(x, y, tw, 5); c.restore();
    text(c, lab, x + 20, y + 40, font(700, 19), 'rgba(255,255,255,.6)', { ls: 1.5 });
    text(c, val, x + 20, y + 100, font(800, 68, FC), col, { maxW: tw - 40, shrink: true, min: 34 });
    text(c, sub, x + 20, y + 130, font(500, 18), 'rgba(255,255,255,.55)', { maxW: tw - 36 });
  });

  // ----- army of the day -----
  let y = HEAD + TILE_H + HERO_Y_GAP; const hx = PAD, hw = IW;
  panel(c, hx, y, hw, HERO_H, 'rgba(139,108,246,.17)', 'rgba(139,108,246,.6)', 30);
  text(c, 'ARMY OF THE DAY', hx + 30, y + 46, font(700, 22), GOLD, { ls: 4 });
  if (F.aod) {
    const a = F.aod;
    text(c, aodName, hx + 30, y + 112, font(800, 66, FC), '#fff', { maxW: hw - 60, shrink: true, min: 36 });
    text(c, `Best 3★ rate among armies used by ${a.minPlayers}+ players`, hx + 30, y + 146, font(500, 21), 'rgba(255,255,255,.62)');
    if (F.pop && popName) text(c, F.pop === a ? `Also the most used army · ${pctOf(a.players, A.withCode)} of players` : `Most used: ${popName} · ${pctOf(F.pop.players, A.withCode)} of players`, hx + 30, y + 182, font(600, 21), 'rgba(255,255,255,.78)', { maxW: hw - 60, shrink: true, min: 14 });
    const st = [['PLAYERS', fmtN(a.players), '#fff'], ['3★ RATE', pctOf(a.s3, a.uses), GREEN], ['AVG STARS', avgOf(a.st, a.uses, 2), '#fff'], ['AVG ATTACK', '+' + avgOf(a.t, a.uses), GREEN], ['AVG TIME', a.dur ? dur(Math.round(a.dur / a.uses)) : '–', '#fff']];
    const sw = (hw - 60) / st.length;
    st.forEach(([lab, val, col], i) => { const x = hx + 30 + i * sw; text(c, val, x, y + 246, font(800, 50, FC), col, { maxW: sw - 14, shrink: true, min: 30 }); text(c, lab, x, y + 272, font(700, 16), 'rgba(255,255,255,.5)', { ls: 1.5 }); });
    c.strokeStyle = 'rgba(255,255,255,.14)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(hx + 30, y + 294); c.lineTo(hx + hw - 30, y + 294); c.stroke();
    // heroes (icon + pet + equipment underneath)
    const ry = y + 316; let x = hx + 30;
    heroes.forEach((h) => {
      icon(c, im(h.url), x, ry, 80, 80, 18); rr(c, x, ry, 80, 80, 18); c.lineWidth = 2.5; c.strokeStyle = GOLD; c.stroke();
      h.gear.slice(0, 3).forEach((gr, i) => icon(c, im(gr.url), x + i * 27.5, ry + 86, 25, 25, 7));
      x += 80 + 16;
    });
    // troops + siege, then spells
    const rx = Math.max(x + 14, hx + 30 + 4 * 96 + 14);
    troops.forEach((u, i) => { const ux = rx + i * 72; icon(c, im(u.url), ux, ry, 64, 64, 12, 'rgba(255,255,255,.1)'); rr(c, ux, ry, 64, 64, 12); c.lineWidth = 2; c.strokeStyle = 'rgba(201,162,74,.9)'; c.stroke(); if (u.n > 1) badge(c, 'x' + u.n, ux + 2, ry + 2); });
    spells.forEach((u, i) => { const ux = rx + i * 60, uy = ry + 64 + 12; icon(c, im(u.url), ux, uy, 52, 52, 10, 'rgba(255,255,255,.1)'); rr(c, ux, uy, 52, 52, 10); c.lineWidth = 2; c.strokeStyle = 'rgba(138,99,210,.95)'; c.stroke(); if (u.n > 1) badge(c, 'x' + u.n, ux + 2, uy + 2); });
    if (ccAll.length) {
      const cy = ry + heroRowH + 14; text(c, 'CLAN CASTLE', hx + 30, cy + 34, font(700, 17), 'rgba(255,255,255,.55)', { ls: 2 });
      ccAll.forEach((u, i) => { const ux = hx + 30 + 150 + i * 52; icon(c, im(u.url), ux, cy, 44, 44, 9, 'rgba(255,255,255,.1)'); if (u.n > 1) badge(c, 'x' + u.n, ux, cy); });
    }
  } else text(c, 'No army links recorded for this day', hx + 30, y + 130, font(600, 28), 'rgba(255,255,255,.6)');

  // ----- records -----
  y += HERO_H + HERO_Y_GAP;
  text(c, 'RECORDS OF THE DAY', PAD, y + 38, font(700, 22), GOLD, { ls: 5 }); y += 56;
  const nm = (o) => (o ? o.r.name : ''), more = (o) => (o && o.tied ? ` · +${fmtN(o.tied)} tied` : '');
  const aw = [
    { lab: 'MOST NET GAIN', o: F.net, col: GREEN, val: (r) => '+' + fmtN(r.net), sub: (o) => `+${o.r.a} / −${o.r.d}${more(o)}` },
    { lab: 'FASTEST TRIPLE', o: F.fast, col: GOLD, val: (r) => dur(r.time), sub: (o) => `${o.r.pct}% vs ${o.r.opp}${more(o)}` },
    { lab: 'BEST DEFENSE', o: F.wall, col: '#7fd4ff', val: (r) => '−' + fmtN(r.d), sub: (o) => `8/8 defenses · ${o.r.dz}×0★${more(o)}` },
    { lab: 'MOST 0★ DEFENSES', o: F.zero, col: RED, val: (r) => r.dz + '×0★', sub: (o) => `${o.r.nd} defenses · −${o.r.d}${more(o)}` },
    { lab: 'BIGGEST CLIMBER', o: F.climb, col: LIME, val: (r) => '▲ ' + fmtN(r.delta), sub: (o) => `#${fmtN(o.r.prev)} → #${fmtN(o.r.rank)}${more(o)}` },
    { lab: 'GIANT KILLER', o: F.giant, col: '#ff9f43', val: (r) => '+' + fmtN(r.rank - r.oppRank), sub: (o) => `3★ vs ${o.r.opp} (eod #${fmtN(o.r.oppRank)})${more(o)}` },
    { lab: 'LOWEST OFFENSE', o: F.off, col: RED, val: (r) => '+' + fmtN(r.a), sub: (o) => `${o.r.s3}×3★ out of ${o.r.na}${more(o)}` },
    { lab: 'GOLDEN HOUR', gold: true }];
  const cw = (IW - 16) / 2;
  const summary = { date: new Date(meta.start).toISOString().slice(0, 10), players: G.players, attacks: G.att, defenses: G.def, perfectDays: G.perfect, zeroStarDefenses: G.dstars[0], tripleRate: G.att ? G.astars[3] / G.att : 0, shielded: pending ? null : A.shield, records: [] };
  for (let i = 0; i < aw.length; i++) {
    const a = aw[i], x = PAD + (i % 2) * (cw + 16), yy = y + Math.floor(i / 2) * (AW_H + AW_GAP);
    panel(c, x, yy, cw, AW_H, 'rgba(255,255,255,.07)', 'rgba(255,255,255,.16)', 22);
    c.save(); rr(c, x, yy, cw, AW_H, 22); c.clip(); c.fillStyle = a.col || GOLD; c.fillRect(x, yy, 6, AW_H); c.restore();
    let val = '–', name = 'Nothing yet', sub = '', col = 'rgba(255,255,255,.35)';
    if (a.gold) {
      if (F.gh >= 0) { const h = F.gh; col = GOLD; val = String(h).padStart(2, '0') + ':00'; name = `${Math.round((100 * G.hours3[h]) / G.hours[h])}% were 3★`; sub = `UTC · ${fmtN(G.hours[h])} attacks`; summary.records.push({ label: a.lab, value: val + ' UTC' }); }
    } else if (a.o) { col = a.col; val = a.val(a.o.r); name = a.nameFn ? a.nameFn(a.o) : nm(a.o); sub = a.sub(a.o); summary.records.push(a.noName ? { label: a.lab, value: val, players: a.o.tied + 1 } : { label: a.lab, value: val, name: a.o.r.name, tag: a.o.r.tag, tied: a.o.tied }); }
    text(c, a.lab, x + 26, yy + 38, font(700, 19), 'rgba(255,255,255,.6)', { ls: 1.5 });
    c.font = font(800, 62, FC); const vw = Math.min(c.measureText(val).width, cw * 0.5);
    text(c, val, x + 26, yy + 98, font(800, 62, FC), col, { maxW: cw * 0.5, shrink: true, min: 30 });
    const tx = x + 26 + vw + 22, tmax = x + cw - 18 - tx;
    text(c, name, tx, yy + 76, font(700, 26), '#fff', { maxW: tmax }); text(c, sub, tx, yy + 106, font(500, 19), 'rgba(255,255,255,.58)', { maxW: tmax });
  }
  y += AW_TOTAL + HERO_Y_GAP;

  // ----- charts -----
  const lw = 548, rw = IW - lw - 16;
  panel(c, PAD, y, lw, CH_H, 'rgba(255,255,255,.06)', 'rgba(255,255,255,.16)', 26);
  text(c, '3★ RATE BY HOUR (UTC)', PAD + 26, y + 40, font(700, 20), GOLD, { ls: 2 });
  const hrs = Array.from({ length: 24 }, (_, i) => (5 + i) % 24), rate3 = hrs.map((h) => (G.hours[h] ? G.hours3[h] / G.hours[h] : 0)), mx = Math.max(0.01, ...rate3);
  const bx0 = PAD + 26, bw = (lw - 52) / 24, top = y + 76, base = y + CH_H - 40;
  hrs.forEach((h, i) => { const bh = Math.max(2, ((base - top) * rate3[i]) / mx), isG = h === F.gh; c.fillStyle = isG ? GOLD : 'rgba(139,108,246,.85)'; rr(c, bx0 + i * bw + 2, base - bh, bw - 4, bh, 4); c.fill();
    if (i % 3 === 0) text(c, String(h).padStart(2, '0'), bx0 + i * bw + bw / 2, base + 24, font(500, 16), 'rgba(255,255,255,.5)', { align: 'center' });
    if (isG) text(c, Math.round(rate3[i] * 100) + '%', bx0 + i * bw + bw / 2, base - bh - 8, font(700, 18), GOLD, { align: 'center' }); });
  const rx0 = PAD + lw + 16; panel(c, rx0, y, rw, CH_H, 'rgba(255,255,255,.06)', 'rgba(255,255,255,.16)', 26);
  text(c, 'HOW ATTACKS ENDED', rx0 + 26, y + 40, font(700, 20), GOLD, { ls: 2 });
  const sc = [[3, GREEN], [2, LIME], [1, GOLD], [0, RED]], smax = Math.max(1, ...G.astars);
  sc.forEach(([s, col], i) => { const ry2 = y + 66 + i * 44, n = G.astars[s], bwid = rw - 52 - 170;
    text(c, s + '★', rx0 + 26, ry2 + 26, font(700, 24), '#fff'); c.fillStyle = 'rgba(255,255,255,.1)'; rr(c, rx0 + 80, ry2 + 8, bwid, 18, 9); c.fill();
    c.fillStyle = col; rr(c, rx0 + 80, ry2 + 8, Math.max(8, (bwid * n) / smax), 18, 9); c.fill();
    text(c, pctOf(n, G.att), rx0 + rw - 26, ry2 + 26, font(700, 22), '#fff', { align: 'right' }); });

  // ----- footer -----
  text(c, `legendstats.pages.dev · icons by ClashKing`, W / 2, H - 52, font(500, 19), 'rgba(255,255,255,.4)', { align: 'center' });
  summary.army = F.aod ? { name: aodName, players: F.aod.players, attacks: F.aod.uses, tripleRate: F.aod.s3 / F.aod.uses, avgStars: F.aod.st / F.aod.uses, code: aodCode } : null;
  summary.mostUsed = F.pop ? { name: popName, players: F.pop.players, share: A.withCode ? F.pop.players / A.withCode : 0 } : null;
  return summary;
}
window.DayCard = { draw };
})();
