// Shared helpers for index.html and player.html
const BUILD = 'build 16 (season page)';
const CONFIG = {
  DATA_URL: 'https://raw.githubusercontent.com/somebody-is-da-goat-6967/coc-leaderboard/data',
  REPO_RAW: 'https://raw.githubusercontent.com/somebody-is-da-goat-6967/coc-leaderboard', // season data lives on branches archive-sYYYY-MM-DD/season.json.gz
  SEASON_ANCHOR: '2026-10-05T05:00:00Z', SEASON_DAYS: 28, // keep in sync with scanner/archive.mjs
  API: '/api', // Pages Function -> RoyaleAPI proxy (see functions/api). Only used when a player is opened.
  PAGE_SIZE: 50, REFRESH_MS: 5 * 60 * 1000, DAY: 864e5, LIVE_TTL: 2 * 60 * 1000,
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normTag = (t) => String(t || '').replace(/^#/, '').toUpperCase();
const isTag = (s) => /^#?[0289PYLQGRJCUV]{3,15}$/i.test(s.trim());

async function getJson(name) {
  const r = await fetch(`${CONFIG.DATA_URL}/${name}?t=${Date.now()}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}
async function getGz(name, bust) {
  const r = await fetch(`${CONFIG.DATA_URL}/${name}${bust ? `?t=${Date.now()}` : ''}`);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return JSON.parse(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onFile = typeof location !== 'undefined' && location.protocol === 'file:';
async function api(path, tries = 3) {
  if (onFile) throw new Error('Live lookups need the hosted site (this page is opened as a file), so only the crawler’s data in the GitHub repo is available.');
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(CONFIG.API + path); }
    catch { if (i >= tries - 1) throw new Error('Network error, try again'); await sleep(700 * (i + 1)); continue; }
    if (r.ok) return r.json();
    if (r.status === 404) throw new Error('Player not found');
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep((r.status === 429 ? 2000 : 700) * (i + 1)); continue; }
    throw new Error(r.status === 429 ? 'Rate limited, try again in a minute' : `API error ${r.status}`);
  }
}
const playerPath = (tag) => `/players/${encodeURIComponent('#' + normTag(tag))}`;

// ---- Legend Day maths (day resets at 5:00 UTC) ----
function resetStart(now) {
  const d = new Date(now), t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5);
  return t > now ? t - CONFIG.DAY : t;
}
function parseTs(s) {
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)/.exec(s || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
// Legend League scale: 0★ 1 per full 10%; 1★ 5 + 1 per 9% above 1%; 2★ 16 + 1 per 3% above 50%; 3★ 40
// If your bot's H.computeTrophyGain differs, port it here.
function trophyGain(stars, pct) {
  pct = Math.floor(pct || 0);
  if (stars >= 3) return 40;
  if (stars === 2) return Math.min(32, Math.max(16, 16 + Math.floor((pct - 50) / 3)));
  if (stars === 1) return Math.min(15, Math.max(5, 5 + Math.floor((pct - 1) / 9)));
  return Math.floor(pct / 10);
}
function summarize(attacks, defenses) {
  attacks = attacks.slice(0, 8); defenses = defenses.slice(0, 8);
  const sum = (l) => l.reduce((s, h) => s + h.t, 0);
  return { attacks, defenses, a: sum(attacks), d: sum(defenses), net: sum(attacks) - sum(defenses) };
}
// From a live API battlelog (used only for the player that was just opened).
function buildDay(items, start, end) {
  const day = items.filter((b) => b.battleType === 'legend')
    .map((b) => ({ ts: parseTs(b.battleTimestamp), b }))
    .filter((x) => x.ts >= start && x.ts < end).sort((a, b) => a.ts - b.ts)
    .map(({ b, ts }) => ({ ts, time: b.battleTime, attack: b.attack, tag: b.opponentPlayerTag || '', name: b.opponentName || 'Unknown', code: b.armyShareCode || '', stars: b.stars || 0, pct: b.destructionPercentage || 0, t: trophyGain(b.stars, b.destructionPercentage) }));
  return summarize(day.filter((h) => h.attack), day.filter((h) => !h.attack));
}

// ---- Crawler battlelog data (battlelogs/live.json.gz = current Legend Day, battlelogs/<date>.json.gz = finished days) ----
// One file holds every tracked player's attacks/defenses, so the leaderboard needs no per-player API calls.
const dataCache = new Map();
function memo(key, ttl, fn) {
  const c = dataCache.get(key);
  if (c && (ttl === Infinity || Date.now() - c.at < ttl)) return c.p;
  const p = fn(); dataCache.set(key, { at: Date.now(), p });
  p.catch(() => { if (dataCache.get(key)?.p === p) dataCache.delete(key); });
  return p;
}
const getIndex = () => memo('index', CONFIG.LIVE_TTL, () => getJson('battlelogs/index.json'));
function packDay(raw) {
  const players = new Map();
  for (const [tag, v] of Object.entries(raw.players || {})) {
    players.set(normTag(tag), v);
  }
  return { start: Date.parse(raw.dayStart), end: Date.parse(raw.dayEnd), generatedAt: raw.generatedAt, players };
}
// back = 0 -> current Legend Day, 1 -> yesterday, ...
async function getDayData(back = 0) {
  if (!back) return memo('live', CONFIG.LIVE_TTL, async () => packDay(await getGz('battlelogs/live.json.gz', true)));
  const idx = await getIndex();
  // Archive files are named after the UTC date on which their day ended.
  const date = new Date(Date.parse(idx.live.dayStart) - (back - 1) * CONFIG.DAY).toISOString().slice(0, 10);
  if (!(idx.archives || []).some((a) => a.date === date)) throw new Error('No archived battle data for that day');
  return memo('arch' + date, Infinity, async () => packDay(await getGz(`battlelogs/${date}.json.gz`)));
}
function dayFromData(dd, tag) {
  const e = dd.players.get(normTag(tag)) || {};
  const conv = (l) => (l || []).map((b) => ({ ts: Date.parse(b.time), time: b.duration, tag: b.opponentTag || '', name: b.opponentName || 'Unknown', code: b.armyShareCode || '', stars: b.stars || 0, pct: b.destruction || 0, t: trophyGain(b.stars, b.destruction) }))
    .sort((a, b) => a.ts - b.ts);
  return summarize(conv(e.attacks), conv(e.defenses));
}
const getDay = (tag, back = 0) => getDayData(back).then((dd) => dayFromData(dd, tag));

const fmt = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString();
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const nameLink = (h) => h.tag
  ? `<a class="pl" href="player.html?tag=${esc(normTag(h.tag))}" data-tag="${esc(normTag(h.tag))}">${esc(h.name)}</a>` : esc(h.name);
const dur = (s) => { const n = s == null || s === '' ? NaN : Number(s); return Number.isFinite(n) ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : '–'; };
const ago = (ts) => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (!(m >= 0)) return '';
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''} ago` : `${Math.floor(h / 24)}d ago`;
};
// One battle as a vertical card: opponent + trophies, result line, then the full army (see army.js).
const eodTag = (ranks, tag) => { const r = ranks && ranks.get(normTag(tag)); return r ? `<span class="eod">eod: #${r.toLocaleString()}</span>` : ''; };
const hits = (list, sign, ranks) => list.length
  ? list.map((h) => `<div class="hit ${sign > 0 ? 'att' : 'def'}${h.stars === 3 ? ' tri' : ''}">
    <div class="top"><span class="hn"><span class="nl">${nameLink(h)}${eodTag(ranks, h.tag)}</span><small class="perf" data-tag="${esc(normTag(h.tag))}" data-side="${sign > 0 ? 'd' : 'a'}"></small></span><b class="${sign > 0 ? 'pos' : 'neg'}">${sign > 0 ? '+' : '−'}${h.t}</b></div>
    <div class="meta"><span class="st">${'★'.repeat(h.stars)}<s>${'★'.repeat(3 - h.stars)}</s></span><span class="pc">${h.pct}%</span><span class="tm" title="Battle time">${dur(h.time)}</span><span class="ago">${ago(h.ts)}</span></div>
    ${armyHTML(h.code)}</div>`).join('')
  : '<div class="hit none"><span class="hn">None yet</span></div>';

function dayHTML(day, ranks) {
  return `<div class="sum">
    <div><small>Attacks ${day.attacks.length}/8</small><b class="pos">+${day.a}</b></div>
    <div><small>Defenses ${day.defenses.length}/8</small><b class="neg">−${day.d}</b></div>
    <div><small>Net today</small><b class="${cls(day.net)}">${fmt(day.net)}</b></div></div>
    <div class="cols"><div class="sec"><h3 class="hb att"><span>Attacks (${day.attacks.length})</span><b>+${day.a}</b></h3><div class="grid">${hits(day.attacks, 1, ranks)}</div></div>
    <div class="sec"><h3 class="hb def"><span>Defenses (${day.defenses.length})</span><b>−${day.d}</b></h3><div class="grid">${hits(day.defenses, -1, ranks)}</div></div></div>`;
}

// Opened player: fresh profile + battlelog straight from the API (the only API calls the site makes).
// If the live battlelog call fails we fall back to the crawler data; for past days the archive is used first.
async function apiDay(tag, back) {
  const start = resetStart(Date.now()) - back * CONFIG.DAY;
  return buildDay((await api(playerPath(tag) + '/battlelog')).items || [], start, start + CONFIG.DAY);
}
// Repo first: the crawler's battlelog files in the GitHub repo. The live API is only called when the repo has nothing for that player.
async function repoDay(tag, back) {
  const dd = await getDayData(back);
  return { day: dayFromData(dd, tag), known: dd.players.has(normTag(tag)), generatedAt: dd.generatedAt };
}
async function dayFor(tag, back) {
  let repo = null;
  try { repo = await repoDay(tag, back); } catch { /* no crawler data for that day */ }
  if (repo && repo.known) return { day: repo.day, fromRepo: true, generatedAt: repo.generatedAt };
  try { return { day: await apiDay(tag, back) }; }
  catch (e) { if (repo) return { day: repo.day, fallback: true, empty: true, generatedAt: repo.generatedAt }; throw e; }
}
// Player name / trophies / TH / clan from the repo (leaderboard.json, then the latest end-of-day board, then the battlelog file). null = repo doesn't know the player.
async function repoPlayer(tag) {
  const t = normTag(tag), find = (l) => (l || []).find((x) => normTag(x.tag) === t);
  const from = (x) => ({ name: x.name || 'Unknown', tag: '#' + t, trophies: x.trophies, townHallLevel: x.townHallLevel ?? x.th ?? x.townhall,
    clan: x.clan && typeof x.clan === 'object' ? x.clan : (x.clanName || x.clan) ? { name: x.clanName || x.clan } : null, _repo: true });
  try { const x = find((await memo('lbfile', CONFIG.LIVE_TTL, () => getJson('leaderboard.json'))).players); if (x && x.name) return from(x); } catch { /* try next source */ }
  try { const dates = (await getMeta()).endOfDayDates || []; if (dates.length) { const x = find((await getEodRaw(dates[dates.length - 1])).players); if (x && x.name) return from(x); } } catch { /* try next source */ }
  try { const e = (await getDayData(0)).players.get(t); if (e && e.name) return from({ name: e.name, trophies: e.trophies }); } catch { /* repo doesn't know them */ }
  return null;
}
const getPlayerInfo = async (tag) => (await repoPlayer(tag)) || api(playerPath(tag));
// ---- End-of-day (eod) rank: eod/<date>.json.gz is the board at that date's 05:00 UTC reset, i.e. the end of the Legend Day
// that started the day before. A day that hasn't ended yet falls back to the latest snapshot.
const getMeta = () => memo('meta', CONFIG.LIVE_TTL, () => getJson('meta.json'));
const getEodRaw = (date) => memo('eod' + date, Infinity, () => getGz(`eod/${date}.json.gz`));
const eodRanks = (date) => memo('eodrank' + date, Infinity, async () =>
  new Map(((await getEodRaw(date)).players || []).map((p, i) => [normTag(p.tag), p.rank || i + 1])));
async function getEodInfo(start) { // { date, ranks: Map(tag -> eod rank) } for the Legend Day starting at `start`, or null
  const dates = (await getMeta()).endOfDayDates || [], end = start + CONFIG.DAY, want = new Date(end).toISOString().slice(0, 10);
  const date = dates.includes(want) ? want : end > Date.now() ? dates[dates.length - 1] : null;
  return date ? { date, ranks: await eodRanks(date) } : null;
}
async function getEodRank(tag, start) {
  const info = await getEodInfo(start), rank = info && info.ranks.get(normTag(tag));
  return rank ? { rank, date: info.date } : null;
}
const eodTitle = (e) => `Rank on the board at the ${new Date(e.date + 'T05:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} 05:00 UTC reset`;

// Profile = GitHub data first (instant, works without the proxy). The live API is only asked afterwards, in the background:
// when it answers, `onUpdate(html)` hands over the fresher profile; when it fails or doesn't exist (file:// / no proxy) nothing changes.
// Only a player the repo knows nothing about waits for the API.
async function profileHTML(tag, { back = 0, rank, note, onUpdate } = {}) {
  const start = resetStart(Date.now()) - back * CONFIG.DAY;
  const [rp, rd, eodInfo] = await Promise.all([repoPlayer(tag).catch(() => null), repoDay(tag, back).catch(() => null), getEodInfo(start).catch(() => null)]);
  const ranks = eodInfo && eodInfo.ranks, own = ranks && ranks.get(normTag(tag)), eod = own ? { rank: own, date: eodInfo.date } : null;
  const render = (p, day, nt) => {
    const pid = registerProfile({ p, day, back, rank, eod, ranks, start }); // for "Download image"
    return `<div class="ph"><h2>${esc(p.name)}${eod ? ` <span class="eod" title="${esc(eodTitle(eod))}">eod: #${eod.rank.toLocaleString()}</span>` : ''}</h2>
    <p>#${esc(normTag(p.tag))} · ${(p.trophies ?? 0).toLocaleString()} 🏆${rank ? ` · global rank #${rank}` : ''}${p._repo && !p.townHallLevel ? '' : ` · TH${p.townHallLevel ?? '?'}`}</p>
    ${p._repo && !p.clan ? '' : `<p>${esc(p.clan?.name || 'No clan')}</p>`}
    <p><button class="btn dl" data-pid="${pid}" title="Save this Legend Day as a PNG">⬇ Download image</button></p></div>${dayHTML(day, ranks)}${nt ? `<p class="sub">${nt}</p>` : ''}`;
  };
  if (rp || (rd && rd.known)) { // 1) from the repo
    const p = rp || { name: '#' + normTag(tag), tag: '#' + normTag(tag), _repo: true }, day = rd ? rd.day : summarize([], []);
    const canLive = !onFile && !back && typeof onUpdate === 'function';
    let nt = note || '';
    if (rd && rd.known && !back) { const m = rd.generatedAt ? Math.max(0, Math.round((Date.now() - rd.generatedAt) / 60000)) : null; nt = [nt, `Battles come from the crawler’s data in the GitHub repo${m === null ? '' : `, ${m} min old`}.`].filter(Boolean).join(' '); }
    else if (!back && !(rd && rd.known)) nt = [nt, 'No battles for this player are in the crawler data yet.'].filter(Boolean).join(' ');
    if (canLive) setTimeout(async () => { // 2) live API, after the repo version is already on screen
      const [pr, dr] = await Promise.allSettled([api(playerPath(tag), 2), apiDay(tag, 0)]);
      if (pr.status !== 'fulfilled' && dr.status !== 'fulfilled') return; // no proxy / API down: keep the repo version as is
      try { onUpdate(render(pr.status === 'fulfilled' ? pr.value : p, dr.status === 'fulfilled' ? dr.value : day, dr.status === 'fulfilled' ? '' : nt)); } catch { /* page moved on */ }
    }, 0);
    return render(p, day, nt);
  }
  const [p, day] = await Promise.all([api(playerPath(tag)), apiDay(tag, back)]); // 3) the repo knows nothing about this player
  return render(p, day, note);
}

// Opponent legend performance, read from the crawler data (no API calls): for each opponent we hit, their
// defenses that day (total/count); for each opponent who hit us, their attacks that day.
function fillPerf(root, back, skip) {
  const els = [...root.querySelectorAll('.perf[data-tag]')].filter((el) => el.dataset.tag);
  els.forEach((el) => { el.textContent = `Opp. ${el.dataset.side === 'd' ? 'defenses' : 'attacks'}: …`; });
  getDayData(back).then((dd) => {
    if (skip && skip()) return;
    els.forEach((el) => {
      if (!el.isConnected) return;
      const defSide = el.dataset.side === 'd', d = dayFromData(dd, el.dataset.tag);
      const total = defSide ? -d.d : d.a, n = (defSide ? d.defenses : d.attacks).length;
      el.innerHTML = `Opp. ${defSide ? 'defenses' : 'attacks'}: <span class="${cls(total)}">${fmt(total)}</span> / ${n}`;
    });
  }).catch(() => els.forEach((el) => { el.textContent = ''; }));
}
