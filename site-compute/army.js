// Army share-code decoder + army display (browser port of armyDecoder.js, using the generated ARMY_IDS table).
// Icons are hosted by ClashKing (https://assets.clashk.ing) - credit them somewhere on the site.
const ICON_BASE = 'https://assets.clashk.ing/';

function armyPairs(section) {
  const out = [];
  for (const part of (section || '').split('-')) {
    const m = /^(\d+)x(\d+)$/.exec(part);
    if (m) out.push({ count: +m[1], id: +m[2] });
  }
  return out;
}
// Troop and siege ids share one number space (game id - 4000000), so a lookup in either table is unambiguous.
function resolveTroop(p) {
  const t = ARMY_IDS.troop[p.id], s = ARMY_IDS.siege[p.id];
  return { cat: s ? 'siege' : 'troop', count: p.count, id: p.id, name: (t || s || [`Troop #${p.id}`])[0], icon: (t || s || [])[1] || '' };
}
function resolveSpell(p) {
  const s = ARMY_IDS.spell[p.id];
  return { cat: 'spell', count: p.count, id: p.id, name: s ? s[0] : `Spell #${p.id}`, icon: s ? s[1] : '' };
}
const lookup = (cat, id) => { const e = id == null ? null : ARMY_IDS[cat][id]; return e ? { name: e[0], icon: e[1] } : id == null ? null : { name: `#${id}`, icon: '' }; };

// Heroes: "<hero>[m<mode>][p<pet>][e<equip1>[_<equip2>]]" entries separated by "-", the whole section prefixed with "h".
function decodeHeroes(code) {
  const sec = /^h([\dpem_-]*)/.exec(code)?.[1] || '';
  return sec.split('-').flatMap((e) => {
    const m = /^(\d+)(?:m\d+)?(?:p(\d+))?(?:e(\d+)(?:_(\d+))?)?$/.exec(e);
    if (!m) return [];
    return [{ hero: lookup('hero', +m[1]), pet: lookup('pet', m[2] == null ? null : +m[2]),
      equip: [m[3], m[4]].filter((x) => x != null).map((x) => lookup('equip', +x)) }];
  });
}
const armyCache = new Map();
function decodeArmy(code) {
  if (!code) return null;
  if (armyCache.has(code)) return armyCache.get(code);
  const sec = (re) => re.exec(code)?.[1] || '';
  const army = {
    heroes: decodeHeroes(code),
    troops: armyPairs(sec(/u([\dx-]*)/)).map(resolveTroop),   // main army (incl. its siege machine)
    spells: armyPairs(sec(/s([\dx-]*)/)).map(resolveSpell),
    cc: [...armyPairs(sec(/i([\dx-]*)/)).map(resolveTroop), ...armyPairs(sec(/d([\dx-]*)/)).map(resolveSpell)], // Clan Castle troops, siege, spells
  };
  armyCache.set(code, army);
  return army;
}

// ---- rendering ----
const iconUrl = (p) => ICON_BASE + p.split('/').map(encodeURIComponent).join('/');
const abbr = (n) => esc(String(n).replace(/[^A-Za-z0-9]/g, '').slice(0, 2));
function iconTile(cat, name, icon, count, size = '') {
  const label = count != null ? `${count}x ${name}` : name;
  return `<span class="ic ${cat}${size ? ' ' + size : ''}" tabindex="0" role="img" data-tip="${esc(label)}" aria-label="${esc(label)}" data-abbr="${abbr(name)}">${icon
    ? `<img src="${esc(iconUrl(icon))}" alt="" loading="lazy" decoding="async" draggable="false" onerror="this.remove()">` : ''}${count != null ? `<i>x${count}</i>` : ''}</span>`;
}
// The whole army, always visible: each hero as a big tile with its pet + two equipment pieces in a column beside it,
// then every troop / siege machine / spell, then the Clan Castle. Names show on hover / tap / keyboard focus.
function armyHTML(code) {
  const a = decodeArmy(code);
  if (!a) return '<div class="army none">No army data</div>';
  const slot = (cat, x) => x ? iconTile(cat, x.name, x.icon, null, 'sm') : '<span class="ic sm empty"></span>';
  const heroes = a.heroes.map((h) => `<div class="hc">${iconTile('hero', h.hero.name, h.hero.icon, null, 'lg')}<div class="hs">${
    slot('pet', h.pet)}${slot('equip', h.equip[0])}${slot('equip', h.equip[1])}</div></div>`).join('');
  const bar = [...a.troops, ...a.spells].map((t) => iconTile(t.cat, t.name, t.icon, t.count)).join('');
  const cc = a.cc.map((t) => iconTile(t.cat, t.name, t.icon, t.count, 'cc')).join('');
  return `<div class="army">${heroes ? `<div class="heroes">${heroes}</div>` : ''}${bar ? `<div class="troops">${bar}</div>` : ''}${
    cc ? `<div class="troops ccrow"><span class="cl" title="Clan Castle">CC</span>${cc}</div>` : ''}</div>`;
}

// ---- tooltip (delegated, set up once) ----
let tipEl = null;
function showTip(el) {
  if (!el.dataset.tip) return;
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'army-tip'; tipEl.setAttribute('role', 'tooltip'); }
  (el.closest('dialog') || document.body).append(tipEl); // a modal <dialog> covers everything outside it
  tipEl.textContent = el.dataset.tip; tipEl.hidden = false;
  const r = el.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.max(6, Math.min(innerWidth - t.width - 6, r.left + r.width / 2 - t.width / 2))}px`;
  tipEl.style.top = `${r.top - t.height - 6 < 6 ? r.bottom + 6 : r.top - t.height - 6}px`;
  tipEl._for = el;
}
const hideTip = () => { if (tipEl) { tipEl.hidden = true; tipEl._for = null; } };
function initArmyUI() {
  if (initArmyUI.done) return; initArmyUI.done = true;
  document.addEventListener('pointerover', (e) => { const t = e.target.closest?.('.ic'); if (t && e.pointerType === 'mouse') showTip(t); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('.ic') && e.pointerType === 'mouse') hideTip(); });
  document.addEventListener('focusin', (e) => { const t = e.target.closest?.('.ic'); if (t) showTip(t); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('scroll', hideTip, true);
  // Touch: tap an icon to see its name, tap again or elsewhere to hide.
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('.ic');
    if (t && (!tipEl || tipEl.hidden || tipEl._for !== t)) showTip(t); else hideTip();
  }, true);
}
initArmyUI();
