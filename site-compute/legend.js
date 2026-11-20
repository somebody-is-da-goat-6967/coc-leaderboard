const {
  SlashCommandBuilder, EmbedBuilder, AttachmentBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
} = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const siteData = require('../legendStatsData');
const { decodeArmyShareCode } = require('../armyDecoder');
const { resolveFont, fontString } = require('../legendsDayImage');
const { createEmojiResolver, ensureApplicationEmojisLoaded } = require('../emojiAssets');
// Troop / siege / hero / pet / equipment / spell / league icons come from ClashKing's asset host.
// Every image footer carries the ClashKing credit their README asks for.
const assets = require('../clashkingAssets');

const GOLD = 0xe0a526;
const PERIODS = [
  { name: 'Daily (in progress)', value: 'daily' },
  { name: 'Current season', value: 'current' },
  { name: 'Previous season', value: 'previous' },
];
const STATS = [
  { name: 'Overview', value: 'overview' },
  { name: 'Attack performance', value: 'attacks' },
  { name: 'Triple rate per day (graph)', value: 'triple_trend' },
  { name: 'Top players (net trophies)', value: 'players' },
  { name: 'Armies', value: 'armies' },
  { name: 'Army trends graph', value: 'army_trends' },
  { name: 'Top offense', value: 'top_offense' },
  { name: 'Best avg offense', value: 'avg_offense' },
  { name: 'Best avg offense · armies used', value: 'offense_armies' },
  { name: 'Top performers by strategy', value: 'strategy_top' },
  { name: 'Lowest avg defense', value: 'avg_defense' },
  { name: 'Most 3★ attacks', value: 'triples' },
  { name: 'Average triple rate', value: 'triple_rate' },
  { name: 'Perfect days', value: 'perfect_days' },
  { name: 'Most 0★ defenses', value: 'zero_defenses' },
  { name: 'Fastest 3★ attacks', value: 'fastest_triples' },
];
const SEASON_STATS = new Set(['top_offense', 'avg_offense', 'offense_armies', 'strategy_top', 'avg_defense', 'triples', 'triple_rate', 'triple_trend', 'perfect_days', 'zero_defenses', 'fastest_triples', 'army_trends']);
const PAGE_SIZE = 10;
const IMAGE_NAME = 'legend-stats.png';
const statLabel = value => STATS.find(entry => entry.value === value)?.name || 'Legend stats';

const fmt = n => Number(n || 0).toLocaleString('en-US');
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '—';
const signed = n => `${n > 0 ? '+' : ''}${fmt(n)}`;
const signedPp = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)} pp`;
const cleanName = value => String(value || 'Unknown').replace(/[\r\n]/g, ' ').replace(/@/g, '@\u200b')
  .replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, '\\$1').slice(0, 64);
const starCounts = stats => [0, 1, 2, 3].map(i => Number(stats?.stars?.[i] || 0));
const dayLabel = iso => {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso) : `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`;
};

// ───────────────────────────── canvas toolkit ─────────────────────────────
// Everything that draws text goes through drawText(): it shrinks the font to fit the box and, if it still
// doesn't fit at the minimum size, cuts the text with an ellipsis. Nothing can run off the image any more.

const C = {
  bgTop: '#21194e', bgBottom: '#100d28',
  gold: '#e0a526', goldLight: '#ffdc74',
  text: '#ffffff', dim: 'rgba(255,255,255,.62)', faint: 'rgba(255,255,255,.12)',
  panel: 'rgba(255,255,255,.065)', panelEdge: 'rgba(255,255,255,.09)',
  green: '#70db8b', red: '#ff6f91', blue: '#45c2ff',
};
const SERIES_COLORS = ['#45c2ff', '#ffbc42', '#70db8b', '#ff6f91', '#b695ff', '#44d5c4', '#f47ac2', '#d5df63'];
const seriesColor = i => SERIES_COLORS[i % SERIES_COLORS.length];

function newCanvas(W, H) {
  resolveFont();
  const canvas = createCanvas(W, H), c = canvas.getContext('2d');
  const bg = c.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, C.bgTop); bg.addColorStop(1, C.bgBottom);
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W * 0.85, 0, 0, W * 0.85, 0, W * 0.55);
  glow.addColorStop(0, 'rgba(224,165,38,.16)'); glow.addColorStop(1, 'rgba(224,165,38,0)');
  c.fillStyle = glow; c.fillRect(0, 0, W, H);
  c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  return { canvas, c };
}

function setFont(c, size) { c.font = fontString(size); }

function rr(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

function panel(c, x, y, w, h, r = 14) {
  rr(c, x, y, w, h, r); c.fillStyle = C.panel; c.fill();
  c.strokeStyle = C.panelEdge; c.lineWidth = 1; c.stroke();
}

function ellipsize(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(`${chars.slice(0, mid).join('')}…`).width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo ? `${chars.slice(0, lo).join('').trimEnd()}…` : '…';
}

/** Largest font size (<= size, >= min) at which the text fits in maxW. */
function fitSize(c, text, maxW, size, min = 11) {
  const str = String(text ?? '').replace(/[\r\n]+/g, ' ');
  let s = size; setFont(c, s);
  while (s > min && c.measureText(str).width > maxW) { s -= 1; setFont(c, s); }
  return s;
}

/** Draws one line of text that is guaranteed to stay inside maxW. Returns the drawn width. */
function drawText(c, text, x, y, maxW, size, { min = 11, align = 'left', color } = {}) {
  const str = String(text ?? '').replace(/[\r\n]+/g, ' ');
  setFont(c, fitSize(c, str, maxW, size, min));
  const out = ellipsize(c, str, maxW);
  if (color) c.fillStyle = color;
  c.textAlign = align; c.fillText(out, x, y); c.textAlign = 'left';
  return c.measureText(out).width;
}

function textWidth(c, text, size) { setFont(c, size); return c.measureText(String(text ?? '')).width; }

function drawIcon(c, img, x, y, size) {
  const scale = Math.min(size / img.width, size / img.height);
  const w = img.width * scale, h = img.height * scale;
  c.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
}

/** Small count pill in the bottom-right corner of an icon. */
function drawCount(c, count, x, y, size) {
  if (!(count > 1)) return;
  const label = fmt(count);
  const tw = textWidth(c, label, 13), bw = tw + 10, bh = 18;
  const bx = x + size - bw + 3, by = y + size - bh + 3;
  rr(c, bx, by, bw, bh, 6); c.fillStyle = 'rgba(16,13,40,.92)'; c.fill();
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.fillText(label, bx + bw / 2, by + 13.5); c.textAlign = 'left';
}

/** Draws loaded icons ([{ img, count }]) in a row. Returns the width used. */
function drawIconRow(c, icons, x, y, size, gap = 6) {
  icons.forEach((icon, i) => {
    const ix = x + i * (size + gap);
    drawIcon(c, icon.img, ix, y, size); drawCount(c, icon.count, ix, y, size);
  });
  return icons.length ? icons.length * (size + gap) - gap : 0;
}

function drawStar(c, cx, cy, r, filled) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r * 0.46 : r;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i) c.lineTo(px, py); else c.moveTo(px, py);
  }
  c.closePath();
  if (filled) { c.fillStyle = C.gold; c.fill(); }
  c.strokeStyle = filled ? C.goldLight : 'rgba(255,255,255,.28)'; c.lineWidth = 1.5; c.stroke();
}

async function loadParts(parts) {
  const imgs = await Promise.all(parts.map(p => assets.getUnitIcon(p.category, p.name).catch(() => null)));
  return parts.map((p, i) => ({ ...p, img: imgs[i] })).filter(p => p.img);
}

async function drawHeader(c, W, title, subtitle) {
  const icon = await assets.getLeagueIcon('Legend League');
  let x = 48;
  if (icon) { drawIcon(c, icon, 42, 26, 80); x = 142; }
  c.fillStyle = C.gold; drawText(c, String(title).toUpperCase(), x, 70, W - x - 48, 38, { min: 20 });
  c.fillStyle = C.dim; drawText(c, subtitle, x, 106, W - x - 48, 20, { min: 12 });
  return 150; // y where the content starts
}

function drawFooter(c, W, H, note = '') {
  const credit = 'Icons: ClashKing · assets.clashk.ing';
  const cw = textWidth(c, credit, 14);
  c.fillStyle = 'rgba(255,255,255,.45)'; c.textAlign = 'right'; c.fillText(credit, W - 48, H - 24); c.textAlign = 'left';
  if (note) { c.fillStyle = 'rgba(255,255,255,.55)'; drawText(c, note, 48, H - 24, W - 96 - cw - 30, 14, { min: 10 }); }
}

function drawCard(c, x, y, w, h, label, value, { color = C.text, sub } = {}) {
  panel(c, x, y, w, h, 14);
  c.fillStyle = C.dim; drawText(c, String(label).toUpperCase(), x + 18, y + 28, w - 36, 14, { min: 10 });
  c.fillStyle = color; drawText(c, value, x + 18, y + h - (sub ? 36 : 22), w - 36, 34, { min: 16 });
  if (sub) { c.fillStyle = C.dim; drawText(c, sub, x + 18, y + h - 14, w - 36, 14, { min: 10 }); }
}

const xAt = (i, n, x, w) => x + (n < 2 ? w / 2 : w * i / (n - 1));

/**
 * Generic line chart. series: [{ values, color, width, dashed: [a, b], dots, area: 'r,g,b' }]; null values break the line.
 * Date labels are thinned automatically so they never overlap. Returns the px / py mappers for annotations.
 */
function drawLineChart(c, o) {
  const { x, y, w, h, dates, series, yMin, yMax, yStep, unit = '%', refLines = [], inset = 0 } = o;
  const n = dates.length, range = Math.max(1e-9, yMax - yMin);
  const px = i => xAt(i, n, x + inset, w - 2 * inset);
  const py = v => y + h - h * (Math.min(yMax, Math.max(yMin, v)) - yMin) / range;

  c.lineWidth = 1; setFont(c, 13); c.textAlign = 'right';
  for (let v = yMin; v <= yMax + 1e-9; v += yStep) {
    const yy = py(v);
    c.strokeStyle = C.faint; c.beginPath(); c.moveTo(x, yy); c.lineTo(x + w, yy); c.stroke();
    c.fillStyle = C.dim; c.fillText(`${Number.isInteger(+v.toFixed(2)) ? v.toFixed(0) : v.toFixed(1)}${unit}`, x - 12, yy + 5);
  }
  c.textAlign = 'left';

  setFont(c, 12);
  const labels = dates.map(dayLabel);
  const labelW = Math.max(0, ...labels.map(l => c.measureText(l).width)) + 18;
  const step = Math.max(1, Math.ceil(labelW / (n < 2 ? w : (w - 2 * inset) / (n - 1))));
  c.fillStyle = C.dim; c.textAlign = 'center';
  for (let i = n - 1; i >= 0; i -= step) c.fillText(labels[i], px(i), y + h + 26); // anchored on the latest day
  c.textAlign = 'left';

  for (const ref of refLines) {
    c.save(); c.setLineDash([8, 6]); c.strokeStyle = ref.color; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, py(ref.value)); c.lineTo(x + w, py(ref.value)); c.stroke(); c.restore();
  }

  for (const s of series) {
    const runs = []; let cur = null;
    s.values.forEach((v, i) => {
      const num = Number(v);
      if (v == null || !Number.isFinite(num)) { cur = null; return; }
      if (!cur) { cur = []; runs.push(cur); }
      cur.push([px(i), py(num)]);
    });
    for (const run of runs) {
      if (s.area && run.length > 1) {
        const g = c.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, `rgba(${s.area},.32)`); g.addColorStop(1, `rgba(${s.area},0)`);
        c.beginPath(); c.moveTo(run[0][0], run[0][1]); run.forEach(([a, b]) => c.lineTo(a, b));
        c.lineTo(run.at(-1)[0], y + h); c.lineTo(run[0][0], y + h); c.closePath(); c.fillStyle = g; c.fill();
      }
      c.save(); if (s.dashed) c.setLineDash(s.dashed);
      c.strokeStyle = s.color; c.lineWidth = s.width || 3; c.lineJoin = 'round';
      c.beginPath(); run.forEach(([a, b], k) => (k ? c.lineTo(a, b) : c.moveTo(a, b))); c.stroke(); c.restore();
    }
    if (s.dots) {
      for (const run of runs) for (const [a, b] of run) {
        c.beginPath(); c.arc(a, b, s.dotRadius || 4, 0, Math.PI * 2);
        c.fillStyle = s.color; c.fill(); c.strokeStyle = '#17123a'; c.lineWidth = 2; c.stroke();
      }
    }
  }
  return { px, py };
}

/** A row of legend chips above a chart. items: [{ label, color, dashed, bar }]. */
function drawChartLegend(c, x, y, maxW, items) {
  let cx = x;
  for (const item of items) {
    const tw = textWidth(c, item.label, 15), need = 34 + tw + 26;
    if (cx + need > x + maxW) break;
    if (item.bar) { c.fillStyle = item.color; c.fillRect(cx, y - 11, 22, 12); }
    else {
      c.save(); if (item.dashed) c.setLineDash([6, 4]);
      c.strokeStyle = item.color; c.lineWidth = 3; c.beginPath(); c.moveTo(cx, y - 5); c.lineTo(cx + 22, y - 5); c.stroke(); c.restore();
    }
    c.fillStyle = C.dim; setFont(c, 15); c.fillText(item.label, cx + 30, y);
    cx += need;
  }
}

// ───────────────────── triple rate per day: data + drawing ─────────────────────
// legendStatsData isn't something this file controls, so the per-day series is looked up defensively:
//  1) any array / date-keyed object of days that carries a triple rate (or stars[3] / triples + attacks),
//  2) otherwise it is estimated from the army-trend data (usage-weighted triple rate of the tracked armies).

const DATE_KEYS = ['date', 'day', 'dayStart', 'key', 'd'];
const RATE_KEYS = ['tripleRate', 'threeStarRate', 'triple_rate', 'triplePct', 'triplePercent', 'rate3'];
const ATTACK_KEYS = ['attacks', 'attackCount', 'totalAttacks'];
const TRIPLE_KEYS = ['triples', 'threeStars', 'three_stars', 'stars3', 'tripleCount'];
const firstNumber = (obj, keys) => {
  for (const k of keys) { const v = obj?.[k]; if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v); }
  return null;
};

function normalizeDay(p, fallbackDate) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const raw = DATE_KEYS.map(k => p[k]).find(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) ?? fallbackDate;
  if (!raw) return null;
  let attacks = firstNumber(p, ATTACK_KEYS);
  if (attacks == null && Array.isArray(p.stars)) attacks = p.stars.reduce((a, b) => a + Number(b || 0), 0);
  let rate = firstNumber(p, RATE_KEYS), explicit = rate != null;
  if (rate == null) {
    const triples = Array.isArray(p.stars) ? Number(p.stars[3]) : firstNumber(p, TRIPLE_KEYS);
    if (Number.isFinite(triples) && attacks > 0) rate = 100 * triples / attacks;
  }
  if (!Number.isFinite(rate)) return null;
  return { date: String(raw).slice(0, 10), rate, attacks: attacks > 0 ? attacks : null, explicit };
}

function seriesFromPoints(points) {
  if (points.length < 2) return null;
  points.sort((a, b) => a.date.localeCompare(b.date));
  const uniq = [...new Map(points.map(p => [p.date, p])).values()];
  const explicit = uniq.filter(p => p.explicit);
  const asFraction = explicit.length && explicit.every(p => p.rate <= 1); // 0.34 -> 34 %
  const rates = uniq.map(p => (p.explicit && asFraction ? p.rate * 100 : p.rate));
  const attackList = uniq.map(p => p.attacks);
  return { dates: uniq.map(p => p.date), rates, attacks: attackList.filter(Number.isFinite).length >= uniq.length / 2 ? attackList : null, approx: false };
}

function findTripleSeries(root, depth = 0, seen = new Set()) {
  if (!root || typeof root !== 'object' || depth > 3 || seen.has(root)) return null;
  seen.add(root);
  if (Array.isArray(root)) {
    if (!root.length || typeof root[0] !== 'object') return null;
    const pts = root.map(p => normalizeDay(p)).filter(Boolean);
    return pts.length >= 2 && pts.length >= root.length * 0.8 ? seriesFromPoints(pts) : null;
  }
  const entries = Object.entries(root);
  const dated = entries.filter(([k]) => /^\d{4}-\d{2}-\d{2}/.test(k));
  if (dated.length >= 2) {
    const found = seriesFromPoints(dated.map(([k, v]) => normalizeDay(v, k.slice(0, 10))).filter(Boolean));
    if (found) return found;
  }
  for (const [key, value] of entries) {
    if (key === 'leaderboards') continue;
    const found = findTripleSeries(value, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function tripleSeriesFromArmyTrend(trend) {
  const dates = trend?.dates || [], armies = trend?.armies || [];
  if (dates.length < 2 || !armies.length) return null;
  const rates = dates.map((_, i) => {
    let weight = 0, sum = 0;
    for (const army of armies) {
      const usage = Number(army.daily?.[i]?.usageRate), triple = Number(army.daily?.[i]?.tripleRate);
      if (Number.isFinite(usage) && Number.isFinite(triple) && usage > 0) { weight += usage; sum += usage * triple; }
    }
    return weight > 0 ? sum / weight : null;
  });
  return rates.filter(Number.isFinite).length >= 2 ? { dates, rates, attacks: null, approx: true } : null;
}

async function resolveTripleSeries(packed, period) {
  let series = findTripleSeries(packed);
  if (!series) series = findTripleSeries(await siteData.getSeasonData(period).catch(() => null));
  return series || tripleSeriesFromArmyTrend(packed?.armyTrend);
}

function movingAverage(values, win) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - win + 1), i + 1).filter(Number.isFinite);
    return slice.length >= 3 ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
  });
}

function tripleStats(series) {
  const pts = series.rates.map((rate, i) => ({ i, rate, date: series.dates[i], attacks: series.attacks?.[i] ?? null })).filter(p => Number.isFinite(p.rate));
  if (!pts.length) return null;
  const volume = pts.reduce((n, p) => n + (p.attacks || 0), 0);
  const avg = series.attacks && volume ? pts.reduce((n, p) => n + p.rate * (p.attacks || 0), 0) / volume : pts.reduce((n, p) => n + p.rate, 0) / pts.length;
  const best = pts.reduce((a, b) => (b.rate > a.rate ? b : a)), worst = pts.reduce((a, b) => (b.rate < a.rate ? b : a));
  const k = Math.min(7, Math.floor(pts.length / 2));
  const mean = list => list.reduce((n, p) => n + p.rate, 0) / list.length;
  const trend = k >= 2 ? mean(pts.slice(-k)) - mean(pts.slice(-2 * k, -k)) : null;
  return { pts, avg, best, worst, latest: pts.at(-1), trend, k };
}

/** The daily triple-rate chart: attack-volume bars, rate line + area, 7-day average, season average, best / worst day. */
function drawTripleChart(c, rect, series, st) {
  const { x, y, w, h } = rect, n = series.dates.length;
  const ma = movingAverage(series.rates, 7);
  const all = [...series.rates.filter(Number.isFinite), ...ma.filter(Number.isFinite)];
  let yMin = Math.max(0, Math.floor((Math.min(...all) - 4) / 5) * 5), yMax = Math.min(100, Math.ceil((Math.max(...all) + 4) / 5) * 5);
  if (yMax - yMin < 10) yMax = Math.min(100, yMin + 10);
  const yStep = yMax - yMin > 40 ? 10 : 5;
  yMin = Math.floor(yMin / yStep) * yStep; yMax = Math.ceil(yMax / yStep) * yStep;

  const hasBars = !!series.attacks;
  if (hasBars) {
    const maxA = Math.max(1, ...series.attacks.filter(Number.isFinite));
    const inset = 18, bw = Math.max(4, Math.min(28, (n < 2 ? w : (w - 2 * inset) / (n - 1)) * 0.55));
    series.attacks.forEach((a, i) => {
      if (!Number.isFinite(a)) return;
      const bh = h * 0.22 * a / maxA;
      c.fillStyle = 'rgba(69,194,255,.20)'; c.fillRect(xAt(i, n, x + inset, w - 2 * inset) - bw / 2, y + h - bh, bw, bh);
    });
  }
  const { px, py } = drawLineChart(c, {
    x, y, w, h, dates: series.dates, yMin, yMax, yStep, inset: 18,
    refLines: [{ value: st.avg, color: C.blue }],
    series: [
      { values: ma, color: 'rgba(255,255,255,.8)', width: 2 },
      { values: series.rates, color: C.gold, width: 3.5, dots: true, dotRadius: n > 20 ? 3.5 : 5, area: '224,165,38' },
    ],
  });
  // best / worst day callouts
  for (const [pt, color, above] of [[st.best, C.green, true], [st.worst, C.red, false]]) {
    const cx = px(pt.i), cy = py(pt.rate);
    c.beginPath(); c.arc(cx, cy, 8, 0, Math.PI * 2); c.strokeStyle = color; c.lineWidth = 3; c.stroke();
    const label = `${pt.rate.toFixed(1)}%`, tw = textWidth(c, label, 15) + 14;
    const lx = Math.max(x, Math.min(x + w - tw, cx - tw / 2)), ly = above ? Math.max(y - 2, cy - 42) : Math.min(y + h - 22, cy + 16);
    rr(c, lx, ly, tw, 24, 8); c.fillStyle = 'rgba(16,13,40,.9)'; c.fill(); c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = color; c.textAlign = 'center'; c.fillText(label, lx + tw / 2, ly + 17); c.textAlign = 'left';
  }
  return hasBars;
}

function tripleLegendItems(hasBars) {
  return [
    { label: 'Daily triple rate', color: C.gold },
    { label: '7-day average', color: 'rgba(255,255,255,.8)' },
    { label: 'Season average', color: C.blue, dashed: true },
    ...(hasBars ? [{ label: 'Attacks per day', color: 'rgba(69,194,255,.45)', bar: true }] : []),
  ];
}

async function renderTripleTrendImage(series, packed, title) {
  const st = tripleStats(series);
  if (!st) return null;
  const W = 1400, H = 836, M = 48, { canvas, c } = newCanvas(W, H);
  const lengthDays = packed?.lengthDays || 28;
  let y = await drawHeader(c, W, 'Triple rate per day', `Season ${title} · ${series.dates.length}/${lengthDays} Legend Days`);

  const cw = (W - M * 2 - 16 * 4) / 5;
  const cards = [
    ['Season average', `${st.avg.toFixed(1)}%`, { color: C.gold, sub: series.attacks ? 'weighted by attacks' : 'mean of daily rates' }],
    ['Best day', `${st.best.rate.toFixed(1)}%`, { color: C.green, sub: dayLabel(st.best.date) }],
    ['Worst day', `${st.worst.rate.toFixed(1)}%`, { color: C.red, sub: dayLabel(st.worst.date) }],
    ['Latest day', `${st.latest.rate.toFixed(1)}%`, { sub: dayLabel(st.latest.date) }],
    ['Trend', st.trend == null ? '—' : signedPp(st.trend), { color: st.trend == null ? C.text : st.trend >= 0 ? C.green : C.red, sub: st.trend == null ? 'not enough days yet' : `last ${st.k}d vs previous ${st.k}d` }],
  ];
  cards.forEach(([label, value, opts], i) => drawCard(c, M + i * (cw + 16), y, cw, 104, label, value, opts));
  y += 104 + 22;

  const panelH = H - y - 66;
  panel(c, M, y, W - M * 2, panelH, 16);
  c.fillStyle = C.text; drawText(c, 'Triple rate by Legend Day', M + 24, y + 40, 420, 24, { min: 14 });
  const hasBars = !!series.attacks;
  drawChartLegend(c, M + 24, y + 76, W - M * 2 - 48, tripleLegendItems(hasBars));
  drawTripleChart(c, { x: M + 84, y: y + 104, w: W - M * 2 - 84 - 44, h: panelH - 104 - 52 }, series, st);
  drawFooter(c, W, H, series.approx ? 'Estimated from the most-used army families, weighted by usage' : 'All Legend League attacks counted for each day');
  return canvas.encode('png');
}

function tripleTrendEmbed(series, st, packed, title) {
  const lengthDays = packed?.lengthDays || 28;
  return new EmbedBuilder().setColor(GOLD).setTitle(`📈 Legend season · Triple rate per day · ${title}`)
    .addFields(
      { name: 'Season average', value: `${st.avg.toFixed(1)}%`, inline: true },
      { name: 'Best day', value: `${st.best.rate.toFixed(1)}% · ${dayLabel(st.best.date)}`, inline: true },
      { name: 'Worst day', value: `${st.worst.rate.toFixed(1)}% · ${dayLabel(st.worst.date)}`, inline: true },
      { name: 'Latest day', value: `${st.latest.rate.toFixed(1)}% · ${dayLabel(st.latest.date)}`, inline: true },
      { name: st.trend == null ? 'Trend' : `Last ${st.k} days vs previous ${st.k}`, value: st.trend == null ? 'Not enough days yet' : signedPp(st.trend), inline: true },
    )
    .setImage('attachment://triple-trend.png')
    .setFooter({ text: `${series.dates.length}/${lengthDays} Legend Days · ${series.approx ? 'estimated from the most-used army families' : 'all attacks counted'}` });
}

// ───────────────────────────── leaderboard images ─────────────────────────────

async function renderBoardImage({ title, subtitle, rows, startRank = 1, goldTop = false }) {
  if (!rows.length) return null;
  const W = 1400, M = 48, rowH = 86, H = 150 + rows.length * rowH + 70, { canvas, c } = newCanvas(W, H);
  await drawHeader(c, W, title, subtitle);
  const right = W - M - 26, nameX = M + 86;
  rows.forEach((row, i) => {
    const y = 150 + i * rowH, rank = startRank + i, top = goldTop && i < 3;
    panel(c, M, y, W - M * 2, rowH - 10, 14);
    const medal = top ? ['#e0a526', '#c9cfdc', '#c98b57'][i] : null;
    c.beginPath(); c.arc(M + 42, y + 33, 23, 0, Math.PI * 2);
    c.fillStyle = medal || 'rgba(255,255,255,.10)'; c.fill();
    c.fillStyle = medal ? '#1a1440' : C.dim; drawText(c, rank, M + 42, y + 42, 38, 24, { min: 12, align: 'center' });
    const valueText = String(row.value ?? ''), valueSize = 28;
    const valueW = Math.min(380, textWidth(c, valueText, valueSize));
    c.fillStyle = C.gold; drawText(c, valueText, right, y + 42, 380, valueSize, { min: 14, align: 'right' });
    c.fillStyle = C.text; drawText(c, row.name || 'Unknown', nameX, y + 40, right - nameX - valueW - 28, 26, { min: 13 });
    c.fillStyle = C.dim; drawText(c, row.detail || '', nameX, y + 64, right - nameX, 18, { min: 11 });
  });
  drawFooter(c, W, H);
  return canvas.encode('png');
}

function seasonLeaderboardEmbed(packed, stat, page = 0) {
  const all = packed.leaderboards?.[stat] || [];
  const start = page * PAGE_SIZE, list = all.slice(start, start + PAGE_SIZE);
  const lines = list.map((row, i) => `**${start + i + 1}. ${cleanName(row.name)}** — ${row.value}\n${row.detail}`);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const range = all.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, all.length)} of ${fmt(all.length)}` : '0 results';
  return new EmbedBuilder().setColor(GOLD).setTitle(`🏆 Legend season · ${statLabel(stat)} · ${packed.season || packed.key || ''}`)
    .setDescription(lines.join('\n\n') || 'No players match this leaderboard yet.')
    .setFooter({ text: `${range} · page ${page + 1}/${pages} · ${packed.days || 0}/${packed.lengthDays || 28} Legend Days` });
}

function seasonLeaderboardView(packed, stat) {
  const all = packed.leaderboards?.[stat] || [];
  return {
    pages: Math.ceil(all.length / PAGE_SIZE),
    embed: page => seasonLeaderboardEmbed(packed, stat, page),
    graphicLabel: 'Generate image',
    render: page => renderBoardImage({
      title: `Legend season · ${statLabel(stat)}`,
      subtitle: `Season ${packed.season || packed.key || ''} · page ${page + 1} · ${packed.days || 0}/${packed.lengthDays || 28} Legend Days`,
      rows: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), startRank: page * PAGE_SIZE + 1, goldTop: page === 0,
    }),
  };
}

// ───────────────────────────── summary (daily / season totals) ─────────────────────────────

function fromSummary(data) {
  return { ...data, rows: data.topPlayers || [], armies: new Map((data.armies || []).map(a => [a.code, a])) };
}

function summaryEmbed(stats, title, kind) {
  const e = new EmbedBuilder().setColor(GOLD).setTitle(`🏆 Legend ${kind} · ${title}`)
    .addFields(
      { name: 'Players with battles', value: fmt(stats.players), inline: true },
      { name: 'Attacks', value: fmt(stats.attacks), inline: true },
      { name: 'Defenses', value: fmt(stats.defenses), inline: true },
      { name: 'Average triple rate', value: pct(stats.stars?.[3] || 0, stats.attacks), inline: true },
      { name: 'Trophies won on offense', value: `+${fmt(stats.trophies)}`, inline: true },
      { name: 'Trophies lost on defense', value: `−${fmt(stats.defenseTrophies)}`, inline: true },
      { name: 'Net trophies', value: signed(stats.trophies - stats.defenseTrophies), inline: true },
    );
  if (kind === 'Daily') e.setFooter({ text: 'Daily stats are for the current Legend Day · reset at 05:00 UTC' });
  else e.setFooter({ text: `${stats.days || 0}/${stats.lengthDays || 28} Legend Days · season totals` });
  return e;
}

function attacksEmbed(stats, title, kind) {
  const stars = starCounts(stats), total = stars.reduce((a, b) => a + b, 0);
  return new EmbedBuilder().setColor(GOLD).setTitle(`⚔️ Legend ${kind} attack performance · ${title}`)
    .addFields(
      { name: 'Attacks', value: fmt(stats.attacks), inline: true },
      { name: '3-star attacks', value: `${fmt(stars[3])} (${pct(stars[3], total)})`, inline: true },
      { name: 'Average stars', value: total ? (stars.reduce((n, s, i) => n + i * s, 0) / total).toFixed(2) : '—', inline: true },
      { name: '0 stars', value: fmt(stars[0]), inline: true },
      { name: '1 star', value: fmt(stars[1]), inline: true },
      { name: '2 stars', value: fmt(stars[2]), inline: true },
      { name: '3 stars', value: fmt(stars[3]), inline: true },
      { name: 'Average trophies per attack', value: stats.attacks ? (stats.trophies / stats.attacks).toFixed(2) : '—', inline: true },
    ).setFooter({ text: 'Daily or season attack totals' });
}

const sortedPlayers = stats => stats.rows.slice().sort((a, b) => b.trophies - a.trophies || b.attacks - a.attacks);
const playerDetail = p => `${fmt(p.attacks)} attacks${p.rank ? ` · EOD #${fmt(p.rank)}` : ''}`;

function playersEmbed(stats, title, kind, page = 0) {
  const rows = sortedPlayers(stats), start = page * PAGE_SIZE, top = rows.slice(start, start + PAGE_SIZE);
  const lines = top.map((p, i) => `**${start + i + 1}.** ${cleanName(p.name)} · ${signed(p.trophies)} trophies · ${playerDetail(p)}`);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  return new EmbedBuilder().setColor(GOLD).setTitle(`📈 Legend ${kind} top players · ${title}`)
    .setDescription(lines.join('\n') || 'No battle data is available yet.')
    .setFooter({ text: `${rows.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${fmt(rows.length)} · ` : ''}page ${page + 1}/${pages} · sorted by net trophies` });
}

function playersView(stats, title, kind) {
  const rows = sortedPlayers(stats);
  return {
    pages: Math.ceil(rows.length / PAGE_SIZE),
    embed: page => playersEmbed(stats, title, kind, page),
    graphicLabel: 'Generate image',
    render: page => renderBoardImage({
      title: `Legend ${kind.toLowerCase()} · top players`,
      subtitle: `${title} · page ${page + 1} · sorted by net trophies`,
      rows: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(p => ({ name: p.name, value: `${signed(p.trophies)} trophies`, detail: playerDetail(p) })),
      startRank: page * PAGE_SIZE + 1, goldTop: page === 0,
    }),
  };
}

/** Overview / attack performance dashboard (season dashboards also get the triple-rate-per-day chart). */
async function renderDashboard({ stats, title, kind, series }) {
  const W = 1280, M = 48, inner = W - M * 2;
  const st = series ? tripleStats(series) : null;
  const stars = starCounts(stats), starTotal = stars.reduce((a, b) => a + b, 0);
  const net = (stats.trophies || 0) - (stats.defenseTrophies || 0);
  const players = sortedPlayers(stats).slice(0, 6);
  const trendH = st ? 390 : 0, panelH = 330;
  const H = 150 + 2 * 96 + 16 + 24 + panelH + (st ? 24 + trendH : 0) + 70;
  const { canvas, c } = newCanvas(W, H);
  const sub = kind === 'Season' ? `${title} · ${stats.days || 0}/${stats.lengthDays || 28} Legend Days` : `${title} · resets at 05:00 UTC`;
  let y = await drawHeader(c, W, `Legend ${kind.toLowerCase()} overview`, sub);

  const cw = (inner - 16 * 3) / 4;
  const cards = [
    ['Players with battles', fmt(stats.players)], ['Attacks', fmt(stats.attacks)], ['Defenses', fmt(stats.defenses)],
    ['Triple rate', pct(stars[3], stats.attacks), { color: C.gold }],
    ['Trophies won', `+${fmt(stats.trophies)}`, { color: C.green }], ['Trophies lost', `−${fmt(stats.defenseTrophies)}`, { color: C.red }],
    ['Net trophies', signed(net), { color: net >= 0 ? C.green : C.red }],
    ['Average stars', starTotal ? (stars.reduce((n, s, i) => n + i * s, 0) / starTotal).toFixed(2) : '—'],
  ];
  cards.forEach(([label, value, opts], i) => drawCard(c, M + (i % 4) * (cw + 16), y + Math.floor(i / 4) * 112, cw, 96, label, value, opts));
  y += 2 * 96 + 16 + 24;

  // attack results
  const lw = 560;
  panel(c, M, y, lw, panelH, 16);
  c.fillStyle = C.text; drawText(c, 'Attack results', M + 24, y + 42, lw - 48, 24, { min: 14 });
  const barColors = [C.gold, C.green, C.blue, C.red];
  [3, 2, 1, 0].forEach((s, k) => {
    const ry = y + 66 + k * 54, count = stars[s];
    for (let j = 0; j < 3; j++) drawStar(c, M + 36 + j * 26, ry + 12, 10, j < s);
    c.fillStyle = C.text; drawText(c, `${fmt(count)} · ${pct(count, starTotal)}`, M + lw - 24, ry + 18, lw - 48 - 100, 20, { min: 11, align: 'right' });
    rr(c, M + 24, ry + 30, lw - 48, 10, 5); c.fillStyle = C.faint; c.fill();
    if (count) { rr(c, M + 24, ry + 30, Math.max(8, (lw - 48) * count / Math.max(1, ...stars)), 10, 5); c.fillStyle = barColors[3 - s]; c.fill(); }
  });
  c.fillStyle = C.dim; drawText(c, `Average trophies per attack: ${stats.attacks ? (stats.trophies / stats.attacks).toFixed(2) : '—'}`, M + 24, y + panelH - 20, lw - 48, 16, { min: 10 });

  // top players
  const rx = M + lw + 20, rw = inner - lw - 20;
  panel(c, rx, y, rw, panelH, 16);
  c.fillStyle = C.text; drawText(c, 'Top players · net trophies', rx + 24, y + 42, rw - 48, 24, { min: 14 });
  if (!players.length) { c.fillStyle = C.dim; drawText(c, 'No player data yet.', rx + 24, y + 100, rw - 48, 18); }
  players.forEach((p, i) => {
    const ry = y + 62 + i * 43, value = signed(p.trophies), vw = Math.min(150, textWidth(c, value, 22));
    c.fillStyle = i < 3 ? C.gold : C.dim; drawText(c, i + 1, rx + 24, ry + 22, 30, 20, { min: 11 });
    c.fillStyle = p.trophies >= 0 ? C.green : C.red; drawText(c, value, rx + rw - 24, ry + 22, 150, 22, { min: 12, align: 'right' });
    c.fillStyle = C.text; drawText(c, p.name || 'Unknown', rx + 60, ry + 20, rw - 60 - 24 - vw - 16, 20, { min: 11 });
    c.fillStyle = C.dim; drawText(c, playerDetail(p), rx + 60, ry + 38, rw - 84, 13, { min: 9 });
  });
  y += panelH + 24;

  // triple rate per day (seasons only)
  if (st) {
    panel(c, M, y, inner, trendH, 16);
    c.fillStyle = C.text; drawText(c, 'Triple rate per day', M + 24, y + 42, 420, 24, { min: 14 });
    c.fillStyle = C.gold; drawText(c, `Season average ${st.avg.toFixed(1)}%`, M + inner - 24, y + 42, 360, 20, { min: 11, align: 'right' });
    drawChartLegend(c, M + 24, y + 76, inner - 48, tripleLegendItems(!!series.attacks));
    drawTripleChart(c, { x: M + 84, y: y + 104, w: inner - 84 - 44, h: trendH - 104 - 52 }, series, st);
  }
  drawFooter(c, W, H, kind === 'Daily' ? 'Totals for the current Legend Day so far' : series?.approx ? 'Daily triple rate estimated from the most-used army families' : '');
  return canvas.encode('png');
}

// ───────────────────────────── armies ─────────────────────────────

const armyCache = new Map();
async function armyParts(code) {
  if (armyCache.has(code)) return armyCache.get(code);
  try {
    const army = await decodeArmyShareCode(code);
    const parts = [...(army?.troops || []).map(t => ({ category: 'troop', name: t.name, count: t.count || 1 })), ...(army?.siege || []).map(t => ({ category: 'siege', name: t.name, count: t.count || 1 }))]
      .sort((a, b) => b.count - a.count);
    const result = { parts, label: parts.slice(0, 4).map(t => `${t.count}× ${t.name}`).join(', ') || 'Army composition' };
    if (armyCache.size > 300) armyCache.clear();
    armyCache.set(code, result); // failures are not cached, so a decoder hiccup doesn't stick
    return result;
  } catch { return { parts: [], label: 'Army composition' }; }
}

async function renderArmyChart(items, title, kind) {
  try {
    const W = 1280, M = 48, rowH = 108, H = 150 + items.length * rowH + 60, { canvas, c } = newCanvas(W, H);
    await drawHeader(c, W, `Legend ${kind.toLowerCase()} armies`, `${title} · top ${items.length} army share codes by usage`);
    const icons = await Promise.all(items.map(item => loadParts(item.parts.slice(0, 5))));
    const anyIcons = icons.some(list => list.length), iconSize = 48, iconCol = anyIcons ? 5 * (iconSize + 6) : 0;
    const max = Math.max(1, ...items.map(x => x.uses));
    const right = W - M - 24, statW = 250, contentX = M + 84 + iconCol + (anyIcons ? 14 : 0), contentW = right - statW - 24 - contentX;
    const labelSize = Math.min(22, ...items.map(it => fitSize(c, it.label, contentW, 22, 12))); // same size on every row
    items.forEach((item, i) => {
      const y = 150 + i * rowH;
      panel(c, M, y, W - M * 2, rowH - 12, 14);
      c.fillStyle = i < 3 ? C.gold : C.dim; drawText(c, `#${i + 1}`, M + 24, y + 58, 52, 30, { min: 14 });
      drawIconRow(c, icons[i], M + 84, y + 20, iconSize);
      c.fillStyle = C.text; drawText(c, item.label, contentX, y + 40, contentW, labelSize, { min: 12 });
      rr(c, contentX, y + 58, contentW, 14, 7); c.fillStyle = C.faint; c.fill();
      const bar = c.createLinearGradient(contentX, 0, contentX + contentW, 0);
      bar.addColorStop(0, C.gold); bar.addColorStop(1, C.goldLight);
      rr(c, contentX, y + 58, Math.max(10, contentW * item.uses / max), 14, 7); c.fillStyle = bar; c.fill();
      c.fillStyle = C.text; drawText(c, `${fmt(item.uses)} attacks`, right, y + 40, statW, 22, { min: 11, align: 'right' });
      c.fillStyle = C.gold; drawText(c, `${pct(item.triples, item.uses)} 3★`, right, y + 70, statW, 22, { min: 11, align: 'right' });
    });
    drawFooter(c, W, H);
    return await canvas.encode('png');
  } catch (err) {
    console.warn('[legendstats] army chart unavailable:', err.message);
    return null;
  }
}

async function armiesView(stats, title, kind) {
  const items = await Promise.all([...stats.armies.entries()].map(async ([code, value]) => ({ code, ...value, ...(await armyParts(code)) })));
  items.sort((a, b) => b.uses - a.uses);
  items.splice(5);
  if (!items.length) {
    return { pages: 1, embed: () => new EmbedBuilder().setColor(GOLD).setTitle(`🏹 Legend ${kind} armies · ${title}`).setDescription('No army share codes are available in this data yet.') };
  }
  const image = await renderArmyChart(items, title, kind);
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(`🏹 Legend ${kind} armies · ${title}`)
    .setDescription(items.map((x, i) => `**${i + 1}. ${x.label}**\n${fmt(x.uses)} attacks · ${pct(x.triples, x.uses)} 3★`).join('\n\n'))
    .setFooter({ text: 'Top five army share codes by usage' });
  if (image) embed.setImage('attachment://legend-armies.png');
  return { pages: 1, embed: () => embed, files: () => (image ? [new AttachmentBuilder(image, { name: 'legend-armies.png' })] : []) };
}

async function renderArmyTrendImage(trend, title) {
  const armies = (trend?.armies || []).slice(0, 5), openers = (trend?.openers || []).slice(0, 5), dates = trend?.dates || [];
  if (!dates.length) return null;
  const W = 1440, M = 40, pw = W - M * 2, plotX = M + 62, plotW = 800, legX = plotX + plotW + 40, legW = M + pw - 24 - legX;
  const panelH = 300, H = 150 + 3 * (panelH + 20) + 40, { canvas, c } = newCanvas(W, H);
  await drawHeader(c, W, 'Legend army trends', `Season ${title} · ${dates.length} saved Legend Days · top army families and openers`);

  // legend icons for every row up front
  const armyIcons = await Promise.all(armies.map(async a => loadParts((await armyParts(a.code)).parts.slice(0, 3))));
  const openerIcons = await Promise.all(openers.map(o => loadParts((o.iconParts || []).slice(0, 3))));
  const peak = (rows) => Math.max(10, ...rows.flatMap(r => (r.daily || []).map(d => Number(d.usageRate || 0))));
  const usageCap = Math.min(100, Math.max(10, Math.ceil(Math.max(peak(armies), peak(openers)) / 10) * 10));

  const drawPanel = (label, rows, field, py, cap, { dashed = false, icons = null, rightText }) => {
    panel(c, M, py, pw, panelH, 16);
    c.fillStyle = C.text; drawText(c, label, M + 24, py + 38, pw - 48, 22, { min: 14 });
    drawLineChart(c, {
      x: plotX, y: py + 62, w: plotW, h: panelH - 62 - 56, dates, yMin: 0, yMax: cap, yStep: cap / 5,
      series: rows.map((row, i) => ({ values: (row.daily || []).map(p => p?.[field]), color: seriesColor(i), width: 3, dashed: dashed ? [8, 6] : null, dots: dates.length <= 16 })),
    });
    rows.forEach((row, i) => {
      const ry = py + 62 + i * 44, iconSize = 30;
      c.fillStyle = seriesColor(i); c.fillRect(legX, ry + 12, 14, 6);
      const used = icons?.[i]?.length ? drawIconRow(c, icons[i], legX + 22, ry, iconSize, 4) + 8 : 0;
      const rt = rightText(row), rtW = Math.min(110, textWidth(c, rt, 15));
      c.fillStyle = C.text; drawText(c, row.label, legX + 22 + used, ry + 21, legW - 22 - used - rtW - 10, 16, { min: 10 });
      c.fillStyle = C.dim; drawText(c, rt, legX + legW, ry + 21, 110, 15, { min: 10, align: 'right' });
    });
  };
  const top = 150;
  drawPanel('Army usage rate', armies, 'usageRate', top, usageCap, { icons: armyIcons, rightText: r => `${Number(r.usageRate || 0).toFixed(1)}%` });
  drawPanel('Army triple rate', armies, 'tripleRate', top + panelH + 20, 100, { rightText: r => `${Number(r.tripleRate || 0).toFixed(1)}% 3★` });
  drawPanel('Opener usage rate (dashed)', openers, 'usageRate', top + 2 * (panelH + 20), usageCap, { dashed: true, icons: openerIcons, rightText: r => `${Number(r.usageRate || 0).toFixed(1)}%` });
  drawFooter(c, W, H, 'Solid: army families · dashed: openers · one point per saved Legend Day');
  return canvas.encode('png');
}

async function armyTrendEmbed(trend, title, getEmoji) {
  const armies = (trend?.armies || []).slice(0, 5), openers = (trend?.openers || []).slice(0, 8);
  const armyLines = await Promise.all(armies.map(async (row, i) => {
    const { parts } = await armyParts(row.code);
    const icons = parts.slice(0, 3).map(p => getEmoji(p.category, p.name)).filter(Boolean).join('') || '⚔️';
    return `${icons} **${i + 1}. ${cleanName(row.label)}** — ${Number(row.usageRate || 0).toFixed(1)}% usage · ${Number(row.tripleRate || 0).toFixed(1)}% 3★ · ${fmt(row.uses)} attacks`;
  }));
  const openerLines = openers.map((row, i) => {
    const icons = (row.iconParts || []).map(part => getEmoji(part.category, part.name)).filter(Boolean).join('') || '⚔️';
    return `${icons} **${i + 1}. ${cleanName(row.label)}** — ${Number(row.usageRate || 0).toFixed(1)}% usage · ${fmt(row.uses)} attacks`;
  });
  const image = await renderArmyTrendImage(trend, title);
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(`🏹 Legend season army trends · ${title}`)
    .setDescription(`**Army families** (openers combined)\n${armyLines.join('\n') || 'No army data available.'}\n\n**Openers and their parts**\n${openerLines.join('\n') || 'No opener data available.'}`)
    .setFooter({ text: 'Solid: army families · dashed: openers · all lines show each saved Legend Day' });
  if (image) embed.setImage('attachment://army-trends.png');
  return { embed, image };
}

// ───────────────────────────── armies of the top avg-offense players + top performers per strategy ─────────────────────────────
// Data comes from packed.armyPerformers (written by site-compute/precompute-site-stats.mjs): who the players are + their most-used army code.
// Strategy + opener names come from wararmies' deduceStrategyName, so they match /wararmies exactly ("<opener> + <army>").
// Naming override: 15+ Balloons = LaLo, LaLo with a few Dragons = Drag LaLo.

const LALO_MIN_BALLOONS = 15, DRAG_LALO_MIN_DRAGONS = 2;
// Icon parts of each opener (same table as the website's Openers list). '@queen' / '@duke' / '@rc' = that hero + its pet, '@revenge' = the Duke's Revenge equipment.
const OPENER_PARTS = {
  'Spam': [['spell', 'Totem']],
  'Fireball + Backpack Arrow (Blower)': [['equip', 'Fireball'], ['equip', 'Rocket Backpack'], ['equip', 'Flame Blower'], ['equip', 'Giant Arrow']],
  'Fireball + Backpack Blower': [['equip', 'Fireball'], ['equip', 'Rocket Backpack'], ['equip', 'Flame Blower']],
  'Blower Backpack': [['equip', 'Flame Blower'], ['equip', 'Rocket Backpack'], ['spell', 'Earthquake']],
  'Fireball + Zap Backpack': [['equip', 'Fireball'], ['equip', 'Rocket Backpack'], ['spell', 'Lightning']],
  'Zap Backpack': [['equip', 'Rocket Backpack'], ['spell', 'Lightning']],
  'Ice Block Revenge Deck': [['equip', '@revenge'], ['spell', 'Ice Block']],
  'Queen Charge': [['equip', 'Monolith Arrow'], ['pet', '@queen']],
  'RC Charge': [['pet', '@rc'], ['equip', 'Electro Boots'], ['spell', 'Invisibility']],
  'Super Archer + Super Wizard Blimp': [['troop', 'Super Archer'], ['troop', 'Super Wizard'], ['troop', 'Battle Blimp']],
  'Blizzard': [['troop', 'Super Wizard'], ['troop', 'Battle Blimp'], ['spell', 'Invisibility']],
  'Super Archer Blimp': [['troop', 'Super Archer'], ['troop', 'Battle Blimp'], ['spell', 'Invisibility']],
  'Duke Charge (Fox)': [['pet', 'Spirit Fox'], ['equip', 'Electro Fangs'], ['spell', 'Invisibility']],
  'Duke Charge (Stun)': [['pet', 'Spirit Fox'], ['equip', 'Electro Fangs'], ['equip', 'Stun Blaster'], ['spell', 'Invisibility']],
  'Duke Backpack Snapping': [['pet', '@duke'], ['equip', 'Rocket Backpack'], ['spell', 'Invisibility']],
  'Duke Charge Opener': [['pet', '@duke'], ['spell', 'Invisibility']],
  'Duke Charge (Jelly)': [['pet', 'Angry Jelly'], ['equip', 'Electro Fangs']],
  'Rocket Backpack + Arrow, Fireball': [['equip', 'Rocket Backpack'], ['equip', 'Giant Arrow'], ['equip', 'Fireball']],
  'Backpack Arrow Combo': [['equip', 'Rocket Backpack'], ['equip', 'Giant Arrow'], ['spell', 'Earthquake']],
  'Backpack Arrow (Air Def Snipe)': [['equip', 'Rocket Backpack'], ['equip', 'Giant Arrow']],
  'Warden Fireball Opener': [['equip', 'Fireball'], ['spell', 'Earthquake']],
  'RC Charge Opener': [['troop', 'Root Rider'], ['spell', 'Invisibility']],
};
const OPENER_PARTS_LC = new Map(Object.entries(OPENER_PARTS).map(([name, parts]) => [name.toLowerCase(), parts]));
const HERO_OF = { '@queen': 'Archer Queen', '@duke': 'Dragon Duke', '@rc': 'Royal Champion' };

const profileCache = new Map();
/** { strategy: 'Opener + Army', core, opener|null, openerParts, troopParts } for an army share code (wararmies' classifier). */
async function armyProfile(code) {
  if (!code) return null;
  if (profileCache.has(code)) return profileCache.get(code);
  try {
    const army = await decodeArmyShareCode(code);
    if (!army) return null;
    const { deduceStrategyName } = require('./wararmies'); // lazy: keeps command load order independent
    const result = deduceStrategyName(army, 18);
    const opener = result.opener || 'Spam Opener', hasOpener = opener !== 'Spam Opener';
    let strategy = result.strategy || 'Unknown Build', core = strategy;
    for (const prefix of [`${opener} + `, 'Totem Spam + ']) if (strategy.startsWith(prefix)) { core = strategy.slice(prefix.length); break; }
    const troopCount = name => (army.troops || []).find(t => t.name === name)?.count || 0;
    if (troopCount('Balloon') >= LALO_MIN_BALLOONS) {
      core = troopCount('Dragon') >= DRAG_LALO_MIN_DRAGONS ? 'Drag LaLo' : 'LaLo';
      strategy = opener === 'Spam' ? `Totem Spam + ${core}` : hasOpener ? `${opener} + ${core}` : core;
    }
    const heroes = army.heroes || [];
    const openerParts = !hasOpener ? [] : (OPENER_PARTS_LC.get(opener.toLowerCase()) || []).flatMap(([category, name]) => {
      if (HERO_OF[name]) {
        const hero = heroes.find(h => h.name === HERO_OF[name]);
        return [{ category: 'hero', name: HERO_OF[name] }, ...(hero?.pet ? [{ category: 'pet', name: hero.pet }] : [])];
      }
      if (name === '@revenge') {
        const duke = heroes.find(h => h.name === 'Dragon Duke'), gear = [duke?.equip1, duke?.equip2].find(g => /revenge/i.test(String(g || '')));
        return gear ? [{ category: 'equipment', name: gear }] : [];
      }
      return [{ category: category === 'equip' ? 'equipment' : category, name }];
    });
    const out = { strategy, core, opener: hasOpener ? opener : null, openerParts, troopParts: (await armyParts(code)).parts };
    if (profileCache.size > 600) profileCache.clear();
    profileCache.set(code, out);
    return out;
  } catch (err) {
    console.warn('[legendstats] army profile unavailable:', err.message);
    return null; // failures are not cached
  }
}

const emojiRow = (parts, getEmoji) => parts.map(p => getEmoji(p.category, p.name)).filter(Boolean).join('');
const strategyColorMap = labels => new Map(labels.map((label, i) => [label, seriesColor(i)]));
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
/** Opener icons, a thin divider, then the top troops — one icon strip per army. */
const STRIP_ICON = 40, STRIP_W = 4 * (STRIP_ICON + 6) + 18 + 3 * (STRIP_ICON + 6);
async function loadStrip(profile) {
  const [opener, troops] = await Promise.all([loadParts((profile?.openerParts || []).slice(0, 4)), loadParts((profile?.troopParts || []).slice(0, 3))]);
  return { opener, troops };
}
function drawStrip(c, strip, x, y) {
  const w = drawIconRow(c, strip.opener, x, y, STRIP_ICON);
  const tx = x + 4 * (STRIP_ICON + 6) + 18;
  if (strip.opener.length) { c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(tx - 12, y + 4, 2, STRIP_ICON - 8); }
  drawIconRow(c, strip.troops, tx, y, STRIP_ICON);
  return w;
}

async function renderOffenseArmiesImage({ perf, rows, page, season, colors, packed, mix, total }) {
  if (!rows.length) return null;
  const W = 1400, M = 48, rowH = 104, mixH = 168;
  const H = 150 + mixH + 20 + rows.length * rowH + 70, { canvas, c } = newCanvas(W, H);
  await drawHeader(c, W, 'Highest avg offense · armies', `Season ${season} · top ${total} players by trophies per day (${perf.minAttacks}+ attacks) · page ${page + 1} · ${packed.days || 0}/${packed.lengthDays || 28} Legend Days`);

  // army mix of the whole top list
  let y = 150;
  panel(c, M, y, W - M * 2, mixH, 16);
  c.fillStyle = C.text; drawText(c, `Army mix · top ${total}`, M + 24, y + 38, 500, 22, { min: 14 });
  const barX = M + 24, barW = W - M * 2 - 48, sum = mix.reduce((n, m) => n + m.players, 0) || 1;
  let bx = barX;
  mix.forEach(m => {
    const w = barW * m.players / sum;
    rr(c, bx, y + 56, Math.max(2, w - 3), 18, 5); c.fillStyle = colors.get(m.label) || C.dim; c.fill(); bx += w;
  });
  let lx = M + 24, ly = y + 106;
  for (const m of mix.slice(0, 8)) {
    const text = `${m.label} · ${m.players}`, need = 30 + textWidth(c, text, 16) + 26;
    if (lx + need > W - M - 24) { lx = M + 24; ly += 30; if (ly > y + mixH - 12) break; }
    c.fillStyle = colors.get(m.label) || C.dim; c.fillRect(lx, ly - 11, 16, 12);
    c.fillStyle = C.text; drawText(c, text, lx + 24, ly, need, 16, { min: 11 }); lx += need;
  }
  y += mixH + 20;

  const strips = await Promise.all(rows.map(r => loadStrip(r.profile)));
  const right = W - M - 26, nameX = M + 86 + STRIP_W + 14;
  rows.forEach((r, i) => {
    const ry = y + i * rowH, rank = page * PAGE_SIZE + i + 1, medal = page === 0 && i < 3 ? ['#e0a526', '#c9cfdc', '#c98b57'][i] : null;
    panel(c, M, ry, W - M * 2, rowH - 10, 14);
    c.beginPath(); c.arc(M + 42, ry + 42, 23, 0, Math.PI * 2); c.fillStyle = medal || 'rgba(255,255,255,.10)'; c.fill();
    c.fillStyle = medal ? '#1a1440' : C.dim; drawText(c, rank, M + 42, ry + 51, 38, 24, { min: 12, align: 'center' });
    drawStrip(c, strips[i], M + 86, ry + 27);
    const value = `+${r.perDay.toFixed(2)}/day`, vw = Math.min(300, textWidth(c, value, 28));
    c.fillStyle = C.gold; drawText(c, value, right, ry + 44, 300, 28, { min: 14, align: 'right' });
    c.fillStyle = C.dim; drawText(c, `${plural(r.days, 'day')} · ${fmt(r.attacks)} attacks`, right, ry + 68, 300, 16, { min: 10, align: 'right' });
    c.fillStyle = C.text; drawText(c, r.name || 'Unknown', nameX, ry + 34, right - nameX - vw - 24, 26, { min: 13 });
    c.fillStyle = colors.get(r.core) || C.dim; c.fillRect(nameX, ry + 49, 14, 10);
    c.fillStyle = C.text; drawText(c, r.label, nameX + 22, ry + 59, right - nameX - 22 - 230, 19, { min: 11 });
    const stats = `${r.share ? `${Math.round(r.share * 100)}% of attacks` : ''}${r.tripleRate != null ? `${r.share ? ' · ' : ''}${r.tripleRate.toFixed(1)}% 3★ with it` : ''}`;
    c.fillStyle = C.dim; drawText(c, stats, nameX + 22, ry + 81, right - nameX - 22 - 20, 16, { min: 10 });
  });
  drawFooter(c, W, H, 'Army = wararmies strategy (opener + army) of each player’s most-used army · 15+ Balloons = LaLo');
  return canvas.encode('png');
}

async function offenseArmiesView(packed, getEmoji) {
  const perf = packed.armyPerformers, season = packed.season || packed.key || '';
  const prepared = await Promise.all(perf.avgOffense.map(async r => {
    const profile = await armyProfile(r.code);
    return { ...r, profile, label: profile?.strategy || r.strategy || 'Unknown army', core: profile?.core || r.strategy || 'Unknown army' };
  }));
  const mixMap = new Map();
  for (const r of prepared) { const x = mixMap.get(r.core) || { label: r.core, players: 0, perDay: 0 }; x.players++; x.perDay += r.perDay; mixMap.set(r.core, x); }
  const mix = [...mixMap.values()].sort((a, b) => b.players - a.players || b.perDay / b.players - a.perDay / a.players);
  const colors = strategyColorMap(mix.map(m => m.label));
  const mixLine = mix.slice(0, 8).map(m => `**${m.label}** ${m.players}`).join(' · ');
  const embed = page => {
    const start = page * PAGE_SIZE, slice = prepared.slice(start, start + PAGE_SIZE);
    const lines = slice.map((r, i) => {
      const icons = r.profile ? [emojiRow(r.profile.openerParts.slice(0, 4), getEmoji), emojiRow(r.profile.troopParts.slice(0, 3), getEmoji)].filter(Boolean).join(' ┃ ') : '';
      const stats = [r.share ? `${Math.round(r.share * 100)}% of attacks` : '', r.tripleRate != null ? `${r.tripleRate.toFixed(1)}% 3★` : '', plural(r.days, 'day'), `${fmt(r.attacks)} attacks`].filter(Boolean).join(' · ');
      return `**${start + i + 1}. ${cleanName(r.name)}** — +${r.perDay.toFixed(2)}/day\n${icons ? `${icons} ` : ''}**${r.label}**\n${stats}`;
    });
    return new EmbedBuilder().setColor(GOLD).setTitle(`🏹 Legend season · Avg offense armies · ${season}`)
      .setDescription(lines.join('\n\n') || 'No players match yet.')
      .addFields({ name: `Army mix · top ${prepared.length}`, value: (mixLine || '—').slice(0, 1024) })
      .setFooter({ text: `${start + 1}–${Math.min(start + PAGE_SIZE, prepared.length)} of ${prepared.length} · page ${page + 1}/${Math.ceil(prepared.length / PAGE_SIZE)} · ${packed.days || 0}/${packed.lengthDays || 28} Legend Days · opener + army · 15+ Balloons = LaLo` });
  };
  return {
    pages: Math.ceil(prepared.length / PAGE_SIZE), embed, graphicLabel: 'Generate image',
    render: page => renderOffenseArmiesImage({ perf, rows: prepared.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), page, season, colors, packed, mix, total: prepared.length }),
  };
}

async function renderStrategyImage({ perf, strat, index, total, season, packed }) {
  const rows = strat.performers || [];
  const W = 1400, M = 48, rowH = 100, panelH = 96;
  const H = 150 + panelH + 20 + Math.max(1, rows.length) * rowH + 70, { canvas, c } = newCanvas(W, H);
  await drawHeader(c, W, `Top performers · ${strat.label}`, `Season ${season} · strategy ${index + 1}/${total} · ${perf.performerMinAttacks}+ attacks with it to qualify · ${packed.days || 0}/${packed.lengthDays || 28} Legend Days`);

  let y = 150;
  const icons = await loadParts((strat.parts || []).slice(0, 4));
  const iconW = icons.length ? icons.length * 54 + 26 : 0, gapW = icons.length ? 16 : 0, cw = (W - M * 2 - iconW - gapW - 16 * 3) / 4;
  if (icons.length) { panel(c, M, y, iconW, panelH, 14); drawIconRow(c, icons, M + 16, y + 24, 48); }
  [['Players', fmt(strat.players), C.text], ['Attacks', fmt(strat.attacks), C.text], ['Triple rate', `${strat.tripleRate.toFixed(1)}%`, C.gold], ['Average stars', strat.avgStars.toFixed(2), C.text]]
    .forEach(([label, value, color], i) => drawCard(c, M + iconW + gapW + i * (cw + 16), y, cw, panelH, label, value, { color }));
  y += panelH + 20;

  if (!rows.length) { c.fillStyle = C.dim; drawText(c, 'Not enough attacks with this strategy yet.', M + 24, y + 40, W - M * 2 - 48, 22); }
  const strips = await Promise.all(rows.map(r => loadStrip(r.profile)));
  const right = W - M - 26, nameX = M + 86 + STRIP_W + 14;
  rows.forEach((r, i) => {
    const ry = y + i * rowH, medal = i < 3 ? ['#e0a526', '#c9cfdc', '#c98b57'][i] : null;
    panel(c, M, ry, W - M * 2, rowH - 10, 14);
    c.beginPath(); c.arc(M + 42, ry + 40, 23, 0, Math.PI * 2); c.fillStyle = medal || 'rgba(255,255,255,.10)'; c.fill();
    c.fillStyle = medal ? '#1a1440' : C.dim; drawText(c, i + 1, M + 42, ry + 49, 38, 24, { min: 12, align: 'center' });
    drawStrip(c, strips[i], M + 86, ry + 25);
    const value = `${r.tripleRate.toFixed(1)}% 3★`, vw = Math.min(300, textWidth(c, value, 28));
    c.fillStyle = C.gold; drawText(c, value, right, ry + 44, 300, 28, { min: 14, align: 'right' });
    c.fillStyle = C.text; drawText(c, r.name || 'Unknown', nameX, ry + 34, right - nameX - vw - 24, 26, { min: 13 });
    c.fillStyle = C.text; drawText(c, r.profile?.strategy || strat.label, nameX, ry + 58, right - nameX - 200, 19, { min: 11 });
    c.fillStyle = C.dim; drawText(c, `${r.avgStars.toFixed(2)}★ avg · +${r.avgTrophies.toFixed(1)} per attack · ${fmt(r.attacks)} attacks${r.rank ? ` · EOD #${fmt(r.rank)}` : ''}`, nameX, ry + 80, right - nameX - 20, 16, { min: 10 });
  });
  drawFooter(c, W, H, 'Ranked by 3★ rate adjusted for sample size · army = opener + strategy (wararmies) · 15+ Balloons = LaLo');
  return canvas.encode('png');
}

async function strategyTopView(packed, getEmoji) {
  const perf = packed.armyPerformers, strategies = perf.strategies || [], season = packed.season || packed.key || '';
  const prepared = await Promise.all(strategies.map(async s => ({
    ...s,
    parts: s.code ? (await armyParts(s.code)).parts : [],
    performers: await Promise.all((s.performers || []).map(async p => ({ ...p, profile: await armyProfile(p.code) }))),
  })));
  const embed = page => {
    const s = prepared[page], icon = emojiRow((s.parts || []).slice(0, 4), getEmoji);
    const lines = s.performers.map((p, i) => {
      const icons = p.profile ? [emojiRow(p.profile.openerParts.slice(0, 4), getEmoji), emojiRow(p.profile.troopParts.slice(0, 3), getEmoji)].filter(Boolean).join(' ┃ ') : '';
      return `**${i + 1}. ${cleanName(p.name)}** — ${p.tripleRate.toFixed(1)}% 3★\n${icons ? `${icons} ` : ''}**${p.profile?.strategy || s.label}**\n${p.avgStars.toFixed(2)}★ avg · +${p.avgTrophies.toFixed(1)} per attack · ${fmt(p.attacks)} attacks${p.rank ? ` · EOD #${fmt(p.rank)}` : ''}`;
    });
    return new EmbedBuilder().setColor(GOLD).setTitle(`🏆 Legend season · Top performers · ${s.label} · ${season}`)
      .setDescription(`${icon ? `${icon}\n` : ''}${fmt(s.players)} players · ${fmt(s.attacks)} attacks · ${s.tripleRate.toFixed(1)}% 3★ · ${s.avgStars.toFixed(2)}★ avg\n\n${lines.join('\n\n') || 'Not enough attacks with this strategy yet.'}`)
      .setFooter({ text: `Strategy ${page + 1}/${prepared.length} · ${perf.performerMinAttacks}+ attacks to qualify · ranked by 3★ rate adjusted for sample size` });
  };
  return {
    pages: prepared.length, embed, graphicLabel: 'Generate image',
    render: page => renderStrategyImage({ perf, strat: prepared[page], index: page, total: prepared.length, season, packed }),
  };
}

// ───────────────────────────── EOD cutoffs ─────────────────────────────

function cutoffEmbed(snapshot) {
  const thresholds = [1, 10, 50, 100, 1000, 5000, 10000];
  const board = snapshot.players.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const lines = thresholds.map((target) => {
    // Use the last player whose rank is within the requested top-N so a tie
    // that skips a rank still reports the shared trophy cutoff for that rank.
    const player = board.filter(p => Number(p.rank) > 0 && Number(p.rank) <= target).at(-1)
      || board.find(p => Number(p.rank) >= target);
    return `**Top ${fmt(target)}:** ${player ? `${fmt(player.trophies)} trophies` : 'not in this snapshot'}${player?.rank && player.rank !== target ? ` (nearest rank #${fmt(player.rank)})` : ''}`;
  });
  return new EmbedBuilder().setColor(GOLD).setTitle(`🏁 End-of-day trophy cutoffs · ${snapshot.date}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Latest end-of-day board · snapshot at 05:00 UTC' });
}

// ───────────────────────────── interactive view runner ─────────────────────────────
// One runner for every paged / graphic-toggle message. view = {
//   pages, embed(page), files?(), render?(page) -> PNG buffer | null, graphicLabel?, eod? }

function viewComponents(view, state, pages) {
  const row = new ActionRowBuilder();
  if (pages > 1) {
    row.addComponents(
      new ButtonBuilder().setCustomId('legendstats:prev').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(state.page <= 0),
      new ButtonBuilder().setCustomId('legendstats:next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(state.page >= pages - 1),
    );
  }
  if (view.render) {
    row.addComponents(new ButtonBuilder().setCustomId('legendstats:graphic')
      .setLabel(state.graphic ? 'Show text' : (view.graphicLabel || 'Generate image')).setEmoji(state.graphic ? '📝' : '🖼️').setStyle(ButtonStyle.Primary));
  }
  if (view.eod !== false) row.addComponents(new ButtonBuilder().setCustomId('legendstats:eod').setLabel('EOD Cutoffs').setEmoji('🏁').setStyle(ButtonStyle.Secondary));
  return row.components.length ? [row] : [];
}

async function runView(interaction, view) {
  const pages = Math.max(1, view.pages || 1), state = { page: 0, graphic: false, busy: false };
  const build = async () => {
    let embed = view.embed(state.page), files = view.files ? view.files() : [];
    if (state.graphic && view.render) {
      const png = await view.render(state.page);
      if (!png) throw new Error('There are no results on this page to render.');
      embed = EmbedBuilder.from(embed).setDescription(null).setFields([]).setImage(`attachment://${IMAGE_NAME}`);
      files = [new AttachmentBuilder(png, { name: IMAGE_NAME })];
    }
    return { embeds: [embed], files, attachments: [], components: viewComponents(view, state, pages) };
  };

  const message = await interaction.editReply(await build());
  if (!viewComponents(view, state, pages).length) return;
  const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 15 * 60 * 1000 });
  collector.on('collect', async press => {
    const id = press.customId;
    if (id === 'legendstats:eod') { // private to whoever pressed it, so it never replaces the stats message
      await press.deferReply({ ephemeral: true }).catch(() => null);
      try { await press.editReply({ embeds: [cutoffEmbed(await siteData.getLatestEod())] }); }
      catch (err) { await press.editReply({ content: `Could not load EOD cutoffs: ${err.message}` }).catch(() => null); }
      return;
    }
    if (press.user.id !== interaction.user.id) {
      await press.reply({ content: 'Only the person who ran this command can use these buttons. Run `/legendstats` to get your own.', ephemeral: true }).catch(() => null);
      return;
    }
    await press.deferUpdate().catch(() => null);
    if (state.busy) return; // ignore clicks while an image is still rendering
    state.busy = true;
    const before = { page: state.page, graphic: state.graphic };
    try {
      if (id === 'legendstats:prev') state.page = Math.max(0, state.page - 1);
      else if (id === 'legendstats:next') state.page = Math.min(pages - 1, state.page + 1);
      else if (id === 'legendstats:graphic') state.graphic = !state.graphic;
      await message.edit(await build());
    } catch (err) {
      Object.assign(state, before);
      await press.followUp({ content: `Couldn’t update this view: ${err.message}`, ephemeral: true }).catch(() => null);
    } finally { state.busy = false; }
  });
  collector.on('end', () => message.edit({ components: [] }).catch(() => null));
}

// ───────────────────────────── command ─────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('legendstats')
    .setDescription('View public Legend League statistics')
    .addStringOption(option => option.setName('stat').setDescription('Choose a statistic or graphic; defaults to overview').setRequired(false).addChoices(...STATS))
    .addStringOption(option => option.setName('period').setDescription('Defaults to current season; choose daily or previous season').setRequired(false).addChoices(...PERIODS)),
  async execute(interaction) {
    await interaction.deferReply();
    const period = interaction.options.getString('period') || 'current';
    const stat = interaction.options.getString('stat') || 'overview';
    try {
      if (SEASON_STATS.has(stat) || (stat === 'armies' && period !== 'daily')) {
        if (period === 'daily') {
          await interaction.editReply({ content: 'These leaderboards use season data. Choose **Current season** or **Previous season** for this stat.' });
          return;
        }
        const packed = await siteData.getPrecomputedSeasonData(period);
        const season = packed.season || packed.key || '';
        if (stat === 'offense_armies' || stat === 'strategy_top') {
          if (!packed.armyPerformers?.avgOffense?.length) {
            await interaction.editReply({ content: 'Army data for this season hasn’t been built yet. It is added on the next stats update, so try again in a little while.' });
            return;
          }
          await ensureApplicationEmojisLoaded(interaction.client).catch(() => null);
          const getEmoji = createEmojiResolver(interaction.client);
          await runView(interaction, stat === 'offense_armies' ? await offenseArmiesView(packed, getEmoji) : await strategyTopView(packed, getEmoji));
          return;
        }
        if (stat === 'army_trends' || stat === 'armies') {
          await ensureApplicationEmojisLoaded(interaction.client).catch(() => null);
          const result = await armyTrendEmbed(packed.armyTrend, season, createEmojiResolver(interaction.client));
          await interaction.editReply({ embeds: [result.embed], files: result.image ? [new AttachmentBuilder(result.image, { name: 'army-trends.png' })] : [] });
          return;
        }
        if (stat === 'triple_trend') {
          const series = await resolveTripleSeries(packed, period), st = series && tripleStats(series);
          if (!st) {
            await interaction.editReply({ content: 'There isn’t enough per-day data for this season yet — at least two saved Legend Days are needed to draw the triple rate graph.' });
            return;
          }
          const png = await renderTripleTrendImage(series, packed, season);
          await interaction.editReply({ embeds: [tripleTrendEmbed(series, st, packed, season)], files: [new AttachmentBuilder(png, { name: 'triple-trend.png' })] });
          return;
        }
        await runView(interaction, seasonLeaderboardView(packed, stat));
        return;
      }

      const daily = period === 'daily';
      const data = daily ? await siteData.getDailyData() : await siteData.getSeasonData(period);
      const title = daily ? `Legend Day ${data.dayStart?.slice(0, 10) || data.date || 'current'}` : `Season ${data.season || ''}`;
      const kind = daily ? 'Daily' : 'Season', stats = fromSummary(data);
      const seasonSeries = async () => resolveTripleSeries(await siteData.getPrecomputedSeasonData(period).catch(() => null), period).catch(() => null);
      const dashboard = async () => renderDashboard({ stats, title, kind, series: daily ? null : await seasonSeries() });

      let view;
      if (stat === 'attacks') view = { pages: 1, embed: () => attacksEmbed(stats, title, kind), render: dashboard, graphicLabel: 'Generate graphic' };
      else if (stat === 'players') view = playersView(stats, title, kind);
      else if (stat === 'armies') view = await armiesView(stats, title, kind);
      else view = { pages: 1, embed: () => summaryEmbed(stats, title, kind), render: dashboard, graphicLabel: 'Generate graphic' };
      await runView(interaction, view);
    } catch (err) {
      console.error('[legendstats]', err);
      await interaction.editReply({ content: `Couldn’t load Legend stats: ${err.message}`, embeds: [], components: [], files: [], attachments: [] }).catch(() => null);
    }
  },
};
