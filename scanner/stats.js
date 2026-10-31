// Stats page: everything is computed in the browser from the crawler's battlelog file for one Legend Day
// (battlelogs/live.json.gz or battlelogs/<date>.json.gz) plus that day's end-of-day (eod) ranks. No API calls.
const BUCKETS = [[1, 10, 'Top 10'], [11, 50, '11–50'], [51, 100, '51–100'], [101, 500, '101–500'], [501, 1000, '501–1,000'],
  [1001, 2500, '1,001–2,500'], [2501, 5000, '2,501–5,000'], [5001, 1e9, '5,001+']];
const ALL = BUCKETS.length; // index of the "everyone" bucket (includes unranked players)
const bucketName = (i) => (i === ALL ? 'Everyone' : BUCKETS[i][2]);
const iconOf = new Map(); // pet / equipment name -> icon path

const armyIds = (sec) => (sec || '').split('-').map((p) => p.split('x')[1]).filter(Boolean).map(Number);
const secOf = (code, re) => re.exec(code)?.[1] || '';
// Troop and siege ids overlap in the army link (e.g. 8 = Dragon and Battle Drill), so an id counts as a siege machine only when it is not a troop — same rule as the bot's armyDecoder.
const isSiegeId = (id) => !!ARMY_IDS.siege[id] && !ARMY_IDS.troop[id];
// Armies are grouped as the "same army" by their main-army troops only (see groupKey). Ignored: troop counts, heroes, pets,
// equipment, spells, siege machines (main army or Clan Castle) and troops that only fill a small part of the army.
// similarKey below is NOT used for grouping any more: it lists a single attack's ingredients (troops, spells, siege) for the per-ingredient stats.
const TROOP_HOUSING = {
  'Barbarian': 1, 'Archer': 1, 'Goblin': 1, 'Giant': 5, 'Wall Breaker': 2,
  'Balloon': 5, 'Wizard': 4, 'Healer': 14, 'Dragon': 20, 'P.E.K.K.A': 25,
  'Minion': 2, 'Hog Rider': 5, 'Valkyrie': 8, 'Golem': 30, 'Witch': 12,
  'Lava Hound': 30, 'Bowler': 6, 'Baby Dragon': 10, 'Miner': 6, 'Electro Dragon': 30,
  'Yeti': 18, 'Dragon Rider': 25, 'Electro Titan': 32, 'Apprentice Warden': 20,
  'Root Rider': 20, 'Druid': 16, 'Thrower': 16, 'Super Barbarian': 5, 'Super Archer': 12,
  'Super Wall Breaker': 8, 'Super Giant': 10, 'Sneaky Goblin': 3, 'Super Miner': 10,
  'Rocket Balloon': 8, 'Ice Golem': 15, 'Inferno Dragon': 15, 'Super Valkyrie': 20,
  'Super Witch': 40, 'Ice Hound': 40, 'Super Bowler': 30, 'Super Dragon': 40,
  'Headhunter': 6, 'Super Wizard': 8, 'Super Minion': 12, 'Super Hog': 12,
  'Ruin Witch': 12, 'Super Yeti': 35, 'Furnace': 10, 'Meteor Golem': 30
};
// A troop type only defines the army if it takes up at least this share of the army's total troop housing space.
// Raise it to merge more aggressively, lower it to keep armies apart more.
const MIN_TROOP_SHARE = 0.10;
// Clan Castle sections of the army link (CC troops/siege, CC spells). Their spells and siege machines are merged with the main army's.
const CC_UNITS = 'i', CC_SPELLS = 'd';

const armyCounts = (sec) => (sec || '').split('-').map((p) => p.split('x')).filter((p) => p[1]).map(([n, id]) => [Number(id), Number(n) || 1]);
const secLetter = (code, l) => secOf(code, new RegExp(l + '([\\dx-]*)'));
const sortedNums = (it) => [...new Set(it)].sort((x, y) => x - y);
const infoCache = new Map();
// Canonical form of an army link: the main-army troop list is merged (same troop listed twice) and ordered by housing space
// (biggest first, siege machines last) and spells by id, so the same army in a different order is one version, not two.
const canonCache = new Map();
function canonCode(code) {
  let c = canonCache.get(code); if (c !== undefined) return c;
  const housing = (id) => TROOP_HOUSING[(ARMY_IDS.troop[id] || [])[0]] ?? 0;
  const merge = (sec) => { const m = new Map(); for (const [id, n] of armyCounts(sec)) m.set(id, (m.get(id) || 0) + n); return [...m]; };
  const join = (a) => a.map(([id, n]) => `${n}x${id}`).join('-');
  c = code
    .replace(/u([\dx-]*)/, (all, sec) => 'u' + join(merge(sec).sort(([a], [b]) => (isSiegeId(a) - isSiegeId(b)) || housing(b) - housing(a) || a - b)))
    .replace(/s([\dx-]*)/, (all, sec) => 's' + join(merge(sec).sort((x, y) => x[0] - y[0])));
  canonCache.set(code, c); return c;
}
function similarKey(code) {
  const main = armyCounts(secOf(code, /u([\dx-]*)/)), cc = armyCounts(secLetter(code, CC_UNITS));
  const isSiege = isSiegeId;
  const nameOf = (id) => (ARMY_IDS.troop[id] || ARMY_IDS.siege[id] || [])[0];
  const cnt = new Map(); // main-army troops only (not siege): id -> count
  for (const [id, n] of main) if (!isSiege(id)) cnt.set(id, (cnt.get(id) || 0) + n);
  const space = (id) => (TROOP_HOUSING[nameOf(id)] ?? null) === null ? null : TROOP_HOUSING[nameOf(id)] * cnt.get(id);
  let total = 0; for (const id of cnt.keys()) total += space(id) || 0;
  let troops = [...cnt.keys()].filter((id) => space(id) === null || space(id) >= MIN_TROOP_SHARE * total); // unknown troops are always kept
  if (!troops.length && cnt.size) troops = [[...cnt.keys()].sort((a, b) => space(b) - space(a))[0]]; // never end up with an empty army
  const siege = main.concat(cc).map(([id]) => id).filter(isSiege);
  const spells = armyIds(secOf(code, /s([\dx-]*)/)).concat(armyIds(secLetter(code, CC_SPELLS)));
  return sortedNums(troops).join(',') + '|' + sortedNums(spells).join(',') + '|' + sortedNums(siege).join(',');
}
// Grouping key for "same army, different variation". ONLY the main-army troops decide it (Clan Castle contents, siege machines
// and, unless GROUP_BY_SPELLS is on, spells never matter). A troop type is ignored when it fills less than MIN_TROOP_SPACE
// housing space in the main army (a few wizards / wall breakers / archers) or less than MIN_TROOP_SHARE of the troop space.
const MIN_TROOP_SPACE = 6;
const GROUP_BY_SPELLS = false;
function groupKey(code) {
  const cnt = new Map(); // main-army troops only (siege machines excluded): id -> count
  for (const [id, n] of armyCounts(secOf(code, /u([\dx-]*)/))) if (!isSiegeId(id)) cnt.set(id, (cnt.get(id) || 0) + n);
  const space = (id) => { const h = TROOP_HOUSING[(ARMY_IDS.troop[id] || [])[0]]; return h == null ? null : h * cnt.get(id); };
  let total = 0; for (const id of cnt.keys()) total += space(id) || 0;
  let troops = [...cnt.keys()].filter((id) => { const s = space(id); return s === null || (s >= MIN_TROOP_SPACE && s >= MIN_TROOP_SHARE * total); }); // unknown troops are always kept
  if (!troops.length && cnt.size) troops = [[...cnt.keys()].sort((a, b) => (space(b) || 0) - (space(a) || 0))[0]]; // never end up with an empty army
  const spells = GROUP_BY_SPELLS ? '|' + sortedNums(armyIds(secOf(code, /s([\dx-]*)/))).join(',') : '';
  return sortedNums(troops).join(',') + spells;
}
const siegeOf = (code) => sortedNums(armyIds(secOf(code, /u([\dx-]*)/)).concat(armyIds(secLetter(code, CC_UNITS))).filter(isSiegeId)); // main + Clan Castle, each machine once
// ---------- heroes, openers and armies ----------
// Opener / army names come from wararmies.js (deduceStrategyName, copied as is so both always name armies the same way).
const HERO_NAMES = ['Barbarian King', 'Archer Queen', 'Grand Warden', 'Royal Champion', 'Minion Prince', 'Dragon Duke'];
const HERO_HINT = [[/barbarian king|\bking\b/, 0], [/archer queen|\bqueen\b/, 1], [/grand warden|\bwarden\b/, 2], [/royal champion|\bchampion\b/, 3], [/minion prince|\bprince\b/, 4], [/dragon duke|\bduke\b/, 5]];
function heroNameOf(hh) {
  for (const c of [hh.name, hh.hero, hh.heroName, hh.type]) if (typeof c === 'string') { const f = HERO_NAMES.find((n) => n.toLowerCase() === c.toLowerCase()); if (f) return f; }
  let blob = ''; try { blob = JSON.stringify({ ...hh, pet: undefined, equip: undefined }).toLowerCase(); } catch { /* ignore */ }
  const m = HERO_HINT.find(([re]) => re.test(blob));
  return m ? HERO_NAMES[m[1]] : (typeof hh.name === 'string' && hh.name) || 'Unknown hero';
}

function isFarmingArmy(parsedArmy, townHall) {
  if (!parsedArmy || !parsedArmy.troops) return false;
  const troops = parsedArmy.troops;
  let total = 0, sneaky = 0, valk = 0, superBarbCount = 0, electroDragonCount = 0;
  troops.forEach(t => {
    const space = TROOP_HOUSING[t.name] || 1;
    const weight = (t.count || 0) * space;
    total += weight;
    if (t.name === 'Sneaky Goblin') sneaky += weight;
    if (t.name === 'Valkyrie') valk += weight;
    if (t.name === 'Super Barbarian') superBarbCount += (t.count || 0);
    if (t.name === 'Electro Dragon') electroDragonCount += (t.count || 0);
  });
  if (superBarbCount > 30) return true;
  if (townHall >= 16 && electroDragonCount > 5) return true;
  if (total === 0) return false;
  return (sneaky / total > 0.65) || (valk / total > 0.75);
}

function capitalizeWords(str) {
  if (!str) return '';
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function deduceStrategyName(army, townHall) {
  if (!army) return { strategy: 'Unknown Build', opener: 'Spam Opener', openerRaw: 'Spam Opener', core: 'Unknown' };

  const troopsMain = army.troops || [];
  const troops  = new Set(troopsMain.map(t => t.name));
  const spells  = new Set((army.spells || []).map(s => s.name));
  const heroes  = new Set((army.heroes || []).map(h => h.name));

  // Includes spells parked in the clan castle, not just the main spell
  // factory — a common trick for Duke/RC Charge is to stash an extra
  // Invisibility in the CC, and that should count the same as one carried
  // in the main army when checking charge thresholds.
  const spellCount  = (name) => {
    const mainCount = (army.spells || []).find(s => s.name === name)?.count || 0;
    const ccCount = (army.ccSpells || []).find(s => s.name === name)?.count || 0;
    return mainCount + ccCount;
  };
  const invisCount  = spellCount('Invisibility');
  const totemCount  = spellCount('Totem');
  const eqCount     = spellCount('Earthquake');
  const lightningCount = spellCount('Lightning');
  const cloneCount  = spellCount('Clone');
  // Counts spells (main + clan castle) whose name matches a pattern, so a slightly
  // different in-data name ("Ice Block" / "Ice Block Spell") still counts.
  const spellMatchCount = (re) => [...(army.spells || []), ...(army.ccSpells || [])]
    .filter(sp => re.test(sp.name || ''))
    .reduce((n, sp) => n + (sp.count || 1), 0);
  const iceBlockCount = spellMatchCount(/ice block/i);

  if (isFarmingArmy(army, townHall)) {
    return { strategy: 'Farming Army', opener: 'Spam Opener', openerRaw: 'Spam Opener', core: 'Farming Army' };
  }

  const throwerCount = troopsMain.find(t => t.name === 'Thrower')?.count || 0;
  const dragonRiderCount = troopsMain.find(t => t.name === 'Dragon Rider')?.count || 0;
  const dragonCount = troopsMain.find(t => t.name === 'Dragon')?.count || 0;
  const electroDragonCount = troopsMain.find(t => t.name === 'Electro Dragon')?.count || 0;
  const rootRiderCount = troopsMain.find(t => t.name === 'Root Rider')?.count || 0;
  const rocketBalloonCount = troopsMain.find(t => t.name === 'Rocket Balloon')?.count || 0;
  const superMinionCount = troopsMain.find(t => t.name === 'Super Minion')?.count || 0;
  const balloonCount = troopsMain.find(t => t.name === 'Balloon' || t.name === 'Rocket Balloon')?.count || 0;
  const totalBalloonCount = troopsMain.reduce((sum, t) => (t.name === 'Balloon' || t.name === 'Rocket Balloon') ? sum + (t.count || 0) : sum, 0);
  const superYetiCount = troopsMain.find(t => t.name === 'Super Yeti')?.count || 0;
  const superWitchCount = troopsMain.find(t => t.name === 'Super Witch')?.count || 0;
  const superDragonCount = troopsMain.find(t => t.name === 'Super Dragon')?.count || 0;
  const lavaHoundCount = troopsMain.reduce((sum, t) => (t.name === 'Lava Hound' || t.name === 'Ice Hound') ? sum + (t.count || 0) : sum, 0);

  let queen = (army.heroes || []).find(h => h.name === 'Archer Queen');
  const rc = (army.heroes || []).find(h => h.name === 'Royal Champion');
  const duke = (army.heroes || []).find(h => h.name === 'Dragon Duke');

  if (!queen) {
    const queenEquip = ['Giant Arrow', 'Monolith Arrow', 'Healer Puppet', 'Invisibility Vial', 'Archer Puppet', 'Frozen Arrow'];
    for (const h of (army.heroes || [])) {
      if ((h.equip1 && queenEquip.includes(h.equip1)) || (h.equip2 && queenEquip.includes(h.equip2))) {
        queen = h;
        if (h.name !== 'Archer Queen') h.name = 'Archer Queen';
        break;
      }
    }
  }

  const rcPet = rc?.pet || null;
  const dukePet = duke?.pet || null;

  const heroGear = (hero) => new Set([hero?.equip1, hero?.equip2].filter(Boolean));
  const allGear = new Set();
  (army.heroes || []).forEach(h => {
    if (h.equip1) allGear.add(h.equip1);
    if (h.equip2) allGear.add(h.equip2);
  });
  const dukeGear = heroGear(duke);
  const rcGear = heroGear(rc);
  // A Fireball army spends its Invisibility spells on the Fireball opener, so
  // none of the Duke Charge variants can apply when Fireball is equipped.
  const hasFireball = allGear.has('Fireball');
  const queenGear = heroGear(queen);

  const ccTroops = new Set((army.ccTroops || []).map(t => t.name));
  const siegeMachines = new Set((army.siege || []).map(s => s.name));
  const hasBattleBlimp = siegeMachines.has('Battle Blimp');
  const hasSuperWizardCC = ccTroops.has('Super Wizard');
  const hasSuperArcherCC = ccTroops.has('Super Archer');
  const hasSuperYetiCC = ccTroops.has('Super Yeti');

  // Troop with the most housing space inside the Battle Blimp (i.e. among
  // the CC troops it carries) — used as a generic fallback opener name
  // below whenever the Blimp is present but none of the more specific
  // named CC-troop combos (Super Archer/Super Wizard Blizzard, Super Yeti
  // Clone Blimp, etc.) matched.
  let maxBlimpTroop = null;
  let maxBlimpHousing = 0;
  (army.ccTroops || []).forEach(t => {
    const space = TROOP_HOUSING[t.name] || 1;
    const totalSpace = (t.count || 0) * space;
    if (totalSpace > maxBlimpHousing) {
      maxBlimpHousing = totalSpace;
      maxBlimpTroop = t.name;
    }
  });

  // Monolith Arrow on the queen, paired with one of the three pets that
  // support a Queen Charge (Unicorn, Greedy Raven, Angry Jelly) — no longer
  // locked to Angry Jelly specifically.
  const hasQueenCharge = queen && queenGear.has('Monolith Arrow') && ['Unicorn', 'Greedy Raven', 'Angry Jelly'].includes(queen.pet);
  // 2+ invis (not >4) — a typical charge army carries 2-4 Invisibility
  // spells, not 5+. The old >4 threshold was inconsistent with the Stun
  // variant and RC Charge Opener below (both use >=2), and was silently
  // missing most real charge armies.
  // RC Charge: Spirit Fox + 2+ invis, OR Electro Boots + 5+ invis (no fox needed).
  const hasRCCharge = rc && ((rcPet === 'Spirit Fox' && invisCount >= 2) || (rcGear.has('Electro Boots') && invisCount >= 5));
  const hasDukeCharge = duke && !hasFireball && (dukePet === 'Spirit Fox' || dukePet === 'Angry Jelly') && invisCount >= 2;
  // Spirit Fox + Electro Fangs with 5+ invis (checked ahead of the Stun variant).
  const hasDukeChargeFox = duke && !hasFireball && dukePet === 'Spirit Fox' && dukeGear.has('Electro Fangs') && invisCount >= 5;
  // Relaxed variant: Angry Jelly + Electro Fangs on the Duke qualifies as a
  // Duke Charge on its own, without needing the invis-count threshold.
  const hasDukeChargeJelly = duke && !hasFireball && dukePet === 'Angry Jelly' && dukeGear.has('Electro Fangs');
  // Spirit Fox + Electro Fangs + Stun Blaster (both Duke epic gear slots used
  // for the stun combo) with 2+ Invisibility spells to cover the charge in.
  const hasDukeChargeStun = duke && !hasFireball && dukePet === 'Spirit Fox' && dukeGear.has('Electro Fangs') && dukeGear.has('Stun Blaster') && invisCount >= 2;
  // Now keyed on Warden Fireball rather than Earthquake count — the Duke
  // brings Rocket Backpack + Flame Blower, the Warden brings Fireball.
  const hasDukeBlowerCombo = duke && dukeGear.has('Rocket Backpack') && dukeGear.has('Flame Blower') && allGear.has('Fireball');
  const queenHasGiantArrow = queen && queenGear.has('Giant Arrow');
  // Distinct from hasDukeBlowerCombo above: this doesn't require the Warden's
  // Fireball, just the Duke running both Flame Blower + Rocket Backpack gear
  // together with at least one Earthquake spell in the army, and — to keep it
  // from overlapping with the Giant-Arrow-driven combos below — no Giant
  // Arrow equipped on the queen.
  const hasBlowerBackpackCombo = duke && dukeGear.has('Flame Blower') && dukeGear.has('Rocket Backpack') && eqCount >= 1 && !queenHasGiantArrow;
  // Warden Fireball + Duke Rocket Backpack (no Flame Blower needed here), with
  // no Giant Arrow on the queen (or no queen at all), backed by 2+ Lightning
  // spells instead of Earthquake.
  const hasFireballZapBackpack = allGear.has('Fireball') && dukeGear.has('Rocket Backpack') && (!queen || !queenHasGiantArrow) && lightningCount >= 2;
  // Simpler/broader variant: just Duke Rocket Backpack + at least 1 Lightning
  // spell, no Fireball or queen-gear requirement. Checked after the more
  // specific Fireball+Zap combo above so that stronger match still wins when
  // both would otherwise qualify.
  const hasZapBackpack = duke && dukeGear.has('Rocket Backpack') && lightningCount >= 1;
  // Duke carrying the Revenge Deck with at least 3 Ice Blocks. Any gear whose name contains
  // "revenge" counts. The Rocket Backpack openers above/below take priority over it (see the
  // `!dukeGear.has('Rocket Backpack')` check in the opener chain).
  const hasIceBlockRevenge = duke && [...dukeGear].some(g => /revenge/i.test(String(g))) && iceBlockCount >= 3;
  const isTotemSpam = totemCount > 8;
  // Duke Rocket Backpack + Queen Giant Arrow with 3+ Earthquakes.
  const hasBackpackArrow = duke && dukeGear.has('Rocket Backpack') && queenHasGiantArrow && eqCount >= 3;
  const hasBackpackArrowFireball = duke && dukeGear.has('Rocket Backpack') && queenHasGiantArrow && hasFireball && eqCount >= 2;

  // CC-troop + invis "blimp" openers — all three require Battle Blimp as the siege machine.
  const isSuperArcherWizardBlimp = hasSuperWizardCC && hasSuperArcherCC && hasBattleBlimp;
  const isBlizzard = hasSuperWizardCC && !hasSuperArcherCC && invisCount > 4 && hasBattleBlimp;
  const isSuperArcherBlimp = hasSuperArcherCC && !hasSuperWizardCC && invisCount >= 4 && hasBattleBlimp;

  let openerName = 'Spam Opener';

  if (isTotemSpam) openerName = 'Spam';
  else if (hasDukeBlowerCombo && queenHasGiantArrow) openerName = 'Fireball + Backpack Arrow (Blower)';
  else if (hasDukeBlowerCombo) openerName = 'Fireball + Backpack Blower';
  else if (hasBlowerBackpackCombo) openerName = 'Blower Backpack';
  else if (hasBackpackArrowFireball) openerName = 'Rocket Backpack + Arrow, Fireball';
  else if (hasBackpackArrow) openerName = 'Backpack Arrow Combo';
  else if (hasFireballZapBackpack) openerName = 'Fireball + Zap Backpack';
  else if (hasZapBackpack) openerName = 'Zap Backpack';
  else if (hasIceBlockRevenge && !dukeGear.has('Rocket Backpack')) openerName = 'Ice Block Revenge Deck';
  else if (hasQueenCharge) openerName = 'Queen Charge';
  else if (hasRCCharge) openerName = 'RC Charge';
  else if (isSuperArcherWizardBlimp) openerName = 'Super Archer + Super Wizard Blimp';
  else if (isBlizzard) openerName = 'Blizzard';
  else if (isSuperArcherBlimp) openerName = 'Super Archer Blimp';
  else if (hasDukeChargeFox) openerName = 'Duke Charge (Fox)';
  else if (hasDukeChargeStun) openerName = 'Duke Charge (Stun)';
  else if (hasDukeCharge && allGear.has('Rocket Backpack')) openerName = 'Duke Backpack Snapping';
  else if (hasDukeCharge) openerName = 'Duke Charge Opener';
  else if (hasDukeChargeJelly) openerName = 'Duke Charge (Jelly)';
  else if (allGear.has('Fireball') && eqCount >= 2) openerName = 'Warden Fireball Opener';
  else if (troops.has('Root Rider') && heroes.has('Royal Champion') && invisCount >= 2) openerName = 'RC Charge Opener';

  let mainCore = 'Mixed Army Smash';

  const supportTroops = new Set(['Healer', 'Baby Dragon', 'Drop Ship']);
  let maxHousingTroop = null;
  let maxHousing = 0;

  troopsMain.forEach(t => {
    if (supportTroops.has(t.name)) return;
    const space = TROOP_HOUSING[t.name] || 1;
    const totalSpace = (t.count || 0) * space;
    if (totalSpace > maxHousing) {
      maxHousing = totalSpace;
      maxHousingTroop = t.name;
    }
  });

  if (troops.has('Super Bowler')) mainCore = 'Super Bowler Smash';
  else if (throwerCount > 8) mainCore = 'Throwers';
  else if (allGear.has('Fireball') && superMinionCount >= 4 && rocketBalloonCount >= 4) mainCore = 'Super Minions + Rocket Balloons (Norman)';
  else if (allGear.has('Fireball') && rocketBalloonCount >= 15) mainCore = 'Fireball Rocketballoons';
  else if (allGear.has('Fireball') && troops.has('Rocket Balloon')) mainCore = 'Rocket Balloon Snipe';
  else if (rootRiderCount >= 3) mainCore = 'Root Riders';
  else if (dragonCount >= 5 && totalBalloonCount >= 10) mainCore = 'Drag LaLo';
  else if ((hasDukeCharge || hasDukeChargeFox || hasDukeChargeJelly) && troops.has('Dragon Rider')) mainCore = 'Dragon Riders';
  else if ((hasDukeCharge || hasDukeChargeFox || hasDukeChargeJelly) && troops.has('Hog Rider') && troops.has('Miner')) mainCore = 'Duke Charge Hybrid';
  else if (throwerCount >= 7) mainCore = 'Thrower Totem Spam';
  else if (troops.has('Meteor Golem')) mainCore = 'Meteor Golem Smash';
  else if (troops.has('Hog Rider') && troops.has('Miner')) mainCore = 'Queen Charge Hybrid';
  else if (electroDragonCount >= 6) mainCore = 'Mass E-Drag Chain Spam';
  else if (superDragonCount > 5) mainCore = 'Super Dragon Smash';
  else if (Math.abs(dragonRiderCount - dragonCount) <= 7 && (dragonRiderCount + dragonCount) >= 8) mainCore = 'Hydra Air Smash';
  else if (dragonRiderCount >= 6) mainCore = 'Dragon Riders';
  else if (superWitchCount >= 3) mainCore = 'Super Witch Smash';
  else if (superYetiCount >= 5) mainCore = 'Super Yeti Revive';
  else if (troops.has('Dragon')) mainCore = 'Hydra Air Smash';
  else if (troops.has('Super Yeti') || spells.has('Revive')) mainCore = 'Super Yeti Revive';
  else if (balloonCount >= 18 && lavaHoundCount >= 2) mainCore = 'LaLo Precision Dive';
  else if (troops.has('Lava Hound') || troops.has('Ice Hound')) mainCore = 'LaLo Precision Dive';
  else if (maxHousingTroop) mainCore = `${maxHousingTroop} Smash`;

  let finalStrategy = mainCore;
  if (isTotemSpam) finalStrategy = `Totem Spam + ${mainCore}`;
  else if (openerName === 'Fireball + Backpack Arrow (Blower)' || openerName === 'Fireball + Backpack Blower') finalStrategy = `${openerName} + ${mainCore}`;
  else if (openerName === 'RC Charge' && allGear.has('Rocket Backpack') && allGear.has('Giant Arrow')) finalStrategy = 'RC Charge Arrow Backpack Root Riders';
  else if (openerName === 'Backpack Arrow Combo' && troops.has('Root Rider')) finalStrategy = 'RC Charge Backpack Arrow Root Riders';
  else if (openerName === 'Warden Fireball Opener' && mainCore === 'Fireball Rocketballoons') finalStrategy = 'Fireball Rocketballoons';
  else if (openerName !== 'Spam Opener') finalStrategy = `${openerName} + ${mainCore}`;

  return { strategy: capitalizeWords(finalStrategy), opener: capitalizeWords(openerName), openerRaw: openerName, core: mainCore };
}

// Builds the army object deduceStrategyName expects (main troops, Clan Castle troops, siege, spells, heroes with pet + 2 equipment).
function warArmyOf(code, heroes) {
  const nameOf = (id) => (ARMY_IDS.troop[id] || ARMY_IDS.siege[id] || [])[0];
  const merged = (sec, nm) => { const m = new Map(); for (const [id, n] of armyCounts(sec)) m.set(id, (m.get(id) || 0) + n); return [...m].map(([id, count]) => ({ id, name: nm(id), count })).filter((x) => x.name); };
  const units = (sec) => merged(sec, nameOf), spl = (sec) => merged(sec, (id) => { const n = (ARMY_IDS.spell[id] || [])[0]; return n && String(n).replace(/ Spell$/, ''); });
  const main = units(secOf(code, /u([\dx-]*)/)), cc = units(secLetter(code, CC_UNITS)), isSg = (x) => isSiegeId(x.id);
  return { troops: main.filter((x) => !isSg(x)), ccTroops: cc.filter((x) => !isSg(x)), siege: main.filter(isSg),
    spells: spl(secOf(code, /s([\dx-]*)/)), ccSpells: spl(secLetter(code, CC_SPELLS)),
    heroes: heroes.map((h) => ({ name: h.name, pet: h.pet, equip1: h.equip[0] || null, equip2: h.equip[1] || null })) };
}
function classifyArmy(code, heroes) {
  try { return deduceStrategyName(warArmyOf(code, heroes), 18); } catch { return { strategy: 'Unknown Build', opener: 'Spam Opener', openerRaw: 'Spam Opener', core: 'Unknown' }; }
}

// ---- per-hero / opener / army tallies (shared by the daily and the season page) ----
const tl = (m, k) => { let x = m.get(k); if (!x) m.set(k, (x = { n: 0, st: 0, s3: 0 })); return x; };
const noteCode = (m, code, w) => { if (m.has(code) || m.size < 40) m.set(code, (m.get(code) || 0) + w); }; // a few example codes per opener / army, for the icons
function tallyArmyStats(t, inf, code, w, st, s3) { // w attacks that used this army, with st stars in total and s3 triples
  const add = (x) => { x.n += w; x.st += st; x.s3 += s3; };
  const seen = new Set();
  for (const hh of inf.heroes) {
    if (seen.has(hh.name)) continue; seen.add(hh.name);
    const e = tl(t.hero, hh.name); add(e); if (!e.eq) e.eq = new Map();
    for (const q of new Set(hh.equip)) add(tl(e.eq, q));
  }
  const o = tl(t.opener, inf.cls.openerRaw); add(o); if (!o.codes) o.codes = new Map(); noteCode(o.codes, code, w);
  const a = tl(t.strat, inf.cls.strategy); add(a); if (!a.codes) a.codes = new Map(); noteCode(a.codes, code, w);
}

// ---- icons: main troops of an army, key parts of an opener ----
const SUPPORT_TROOPS = new Set(['Healer', 'Baby Dragon', 'Drop Ship']);
function mainTroops(code, max = 4) { // [[id, count], ...] biggest housing share first, support troops and tiny shares left out
  const cnt = new Map(); for (const [id, n] of armyCounts(secOf(code, /u([\dx-]*)/))) if (!isSiegeId(id)) cnt.set(id, (cnt.get(id) || 0) + n);
  const sp = (id) => (TROOP_HOUSING[(ARMY_IDS.troop[id] || [])[0]] ?? 1) * cnt.get(id);
  let total = 0; for (const id of cnt.keys()) total += sp(id);
  const ids = [...cnt.keys()].sort((a, b) => sp(b) - sp(a)), real = ids.filter((id) => !SUPPORT_TROOPS.has((ARMY_IDS.troop[id] || [])[0]) && sp(id) >= 0.1 * total);
  return (real.length ? real : ids).slice(0, max).map((id) => [id, cnt.get(id)]);
}
const mainTroopIds = (code, max = 4) => mainTroops(code, max).map(([id]) => id);
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
  'Warden Fireball Opener': [['equip', 'Fireball'], ['spell', 'Earthquake']],
  'RC Charge Opener': [['troop', 'Root Rider'], ['spell', 'Invisibility']],
};
const partIconCache = new Map();
function partIcon(cat, name) {
  const key = cat + '|' + name; if (partIconCache.has(key) && partIconCache.get(key)) return partIconCache.get(key);
  let icon = '';
  if (cat === 'equip' || cat === 'pet') icon = iconOf.get(name) || '';
  else {
    const tbls = cat === 'spell' ? [ARMY_IDS.spell] : [ARMY_IDS.troop, ARMY_IDS.siege], low = name.toLowerCase();
    for (const tb of tbls) for (const k in tb) if (tb[k][0] === name) { icon = tb[k][1]; break; }
    if (!icon) for (const tb of tbls) for (const k in tb) { const n2 = String(tb[k][0]).toLowerCase(); if (n2.includes(low) || low.includes(n2)) { icon = tb[k][1]; break; } }
  }
  partIconCache.set(key, icon); return icon;
}
const topCode = (codes) => { let best = '', bn = -1; for (const [c, n] of codes || []) if (n > bn) { best = c; bn = n; } return best; };
function openerIcons(raw, code) {
  const inf = code ? infoOf(code) : null, petOf = (hero) => inf?.heroes.find((h) => h.name === hero)?.pet || null;
  const parts = (OPENER_PARTS[raw] || []).map(([cat, name]) => {
    if (name === '@duke') return ['pet', petOf('Dragon Duke')];
    if (name === '@queen') return ['pet', petOf('Archer Queen')];
    if (name === '@rc') return ['pet', petOf('Royal Champion')];
    if (name === '@revenge') return ['equip', inf?.heroes.find((h) => h.name === 'Dragon Duke')?.equip.find((g) => /revenge/i.test(g)) || null];
    return [cat, name];
  }).filter(([, name]) => name);
  return parts.map(([cat, name]) => ckTile(cat, name, partIcon(cat, name))).join('');
}
const armyIcons = (code) => (code ? mainTroops(code, 6).map(([id, n]) => { const [name, icon] = ARMY_IDS.troop[id] || [`#${id}`, '']; return ckTile('troop', name, icon, 30, n); }).join('') : '');

// ---- rendering (own row layout: icons + name on one line, bar + numbers on the next, so nothing overflows or hides behind an icon) ----
// ClashKing assets. Every icon below is a plain <img> with its size set inline, so no stylesheet rule (or a missing one) can blow it up
// or pull it out of the row. Hero icons come from ARMY_IDS.hero (paths checked by scripts/build_army_ids.py), then from the icon the decoder gave, then a guessed path.
const CK_BASE = 'https://assets.clashk.ing/';
const ckUrl = (p) => (!p ? '' : /^(https?:)?\/\//.test(p) ? p : CK_BASE + String(p).replace(/^\/+/, ''));
// Same name cleaning as scripts/build_army_ids.py (clean): lower-case, spaces -> _, drop . ? \q ’
const ckClean = (s) => String(s).toLowerCase().replace(/ /g, '_').replace(/\./g, '').replace(/\?/g, '').replace(/\\q/g, '').replace(/’/g, '');
function heroIconUrl(name) {
  const low = String(name).toLowerCase();
  for (const k in (ARMY_IDS.hero || {})) { const [n, p] = ARMY_IDS.hero[k]; if (p && String(n).toLowerCase() === low) return ckUrl(p); }
  if (iconOf.get(name)) return ckUrl(iconOf.get(name));
  return `${CK_BASE}heroes/${ckClean(name)}/icon.webp`;
}
const ckImg = (src, alt, s, cls = '') => `<img${cls ? ` class="${cls}"` : ''} src="${esc(src)}" alt="${esc(alt)}" width="${s}" height="${s}" loading="lazy" style="width:${s}px;height:${s}px;max-width:${s}px;max-height:${s}px;object-fit:contain;display:block;position:static" onerror="this.style.visibility='hidden'">`;
const ckTile = (cat, name, icon, s = 28, count = 0) => { const u = ckUrl(icon);
  return `<span class="ic" style="width:${s}px;height:${s}px">${u ? ckImg(u, '', s) : ''}${count > 1 ? `<span class="cnt">${count > 99 ? '99+' : count}</span>` : ''}</span>`; };
const heroImg = (name) => ckImg(heroIconUrl(name), '', 40, 'himg');
// Own renderer for an army card (heroes + pet + gear, troops with counts, spells, Clan Castle): icons only, no letters on them.
const ckUnit = (icon, name, n, kind, s = 32) => `<span class="ic u ${kind}" style="width:${s}px;height:${s}px" data-tt="${esc(name)}${n > 1 ? ' ×' + n : ''}">${ckUrl(icon) ? ckImg(ckUrl(icon), '', s) : ''}${n ? `<span class="cnt tl">x${n}</span>` : ''}</span>`;
const ckMini = (icon, name, s = 20) => `<span class="ic u mini" style="width:${s}px;height:${s}px" data-tt="${esc(name)}">${ckUrl(icon) ? ckImg(ckUrl(icon), '', s) : ''}</span>`;
function ckArmy(code) {
  const mergeC = (arr) => { const m = new Map(); for (const [id, n] of arr) m.set(id, (m.get(id) || 0) + n); return [...m]; };
  const units = (arr) => arr.map(([id, n]) => { const [name, icon] = (isSiegeId(id) ? ARMY_IDS.siege[id] : ARMY_IDS.troop[id]) || ARMY_IDS.siege[id] || [`#${id}`, '']; return ckUnit(icon, name, n, 'tr'); }).join('');
  const spells = (arr) => arr.map(([id, n]) => { const [name, icon] = ARMY_IDS.spell[id] || [`#${id}`, '']; return ckUnit(icon, name, n, 'sp'); }).join('');
  const bySiegeLast = (a, b) => isSiegeId(a[0]) - isSiegeId(b[0]);
  const main = mergeC(armyCounts(secOf(code, /u([\dx-]*)/))).sort(bySiegeLast), sp = mergeC(armyCounts(secOf(code, /s([\dx-]*)/)));
  const ccU = mergeC(armyCounts(secLetter(code, CC_UNITS))).sort(bySiegeLast), ccS = mergeC(armyCounts(secLetter(code, CC_SPELLS)));
  let heroes = '';
  try {
    heroes = decodeHeroes(code).map((hh) => { const nm = heroNameOf(hh), gear = [hh.pet ? ckMini(hh.pet.icon, hh.pet.name) : '', ...(hh.equip || []).map((e) => ckMini(e.icon, e.name))].join('');
      return `<div class="hero">${ckUnit(heroIconUrl(nm), nm, 0, 'hr', 44)}<div class="hs">${gear}</div></div>`; }).join('');
  } catch { /* no hero data */ }
  const row = (cls, label, html) => (html ? `<div class="crow ${cls}">${label ? `<span class="lbl">${label}</span>` : ''}${html}</div>` : '');
  return `<div class="ca">${row('heroes', '', heroes)}${row('', '', units(main))}${row('', '', spells(sp))}${row('cc', 'CC', units(ccU) + spells(ccS))}</div>`;
}
function statRow(i, icons, name, n, s3, st, base, withText) {
  const tipTxt = `${name} · ${pctOf(n, base)} ${withText} · ${pctOf(s3, n)} 3★ · ${avgOf(st, n, 2)} ★ · ${fmtN(n)} attacks`;
  return `<div class="srow${i >= 10 ? ' more' : ''}" data-tt="${esc(tipTxt)}"><div class="sr1">${icons ? `<span class="icons">${icons}</span>` : ''}<span class="sn">${esc(name)}</span></div><div class="sr2"><span class="sbar"><i style="width:${base ? (100 * n / base).toFixed(1) : 0}%"></i></span><em>${pctOf(n, base)} used · ${pctOf(s3, n)} 3★</em></div></div>`;
}
function heroHTML(t, base) {
  const list = [...t.hero].sort((a, b) => b[1].n - a[1].n);
  if (!list.length || !base) return '';
  const cards = list.map(([name, e]) => {
    const eq = [...(e.eq || [])].sort((a, b) => b[1].n - a[1].n);
    return `<div class="hcard xp"><div class="hh">${heroImg(name)}<div class="ht"><b>${esc(name)}</b><span>${pctOf(e.n, base)} of attacks · ${pctOf(e.s3, e.n)} 3★ · ${avgOf(e.st, e.n, 2)} ★</span></div></div>
      <div class="sl">${eq.map(([q, x], i) => statRow(i, ckTile('equip', q, iconOf.get(q) || ''), q, x.n, x.s3, x.st, e.n, `of ${name} attacks`).replace('data-tt="', `data-tt="on ${esc(name)}: `)).join('') || '<div class="msg">No equipment data</div>'}</div>${expandBtn(eq.length, 'all equipment', 10)}</div>`;
  }).join('');
  return `<h4 class="mh">Heroes <small>(share of attacks that brought the hero and their 3★ rate; equipment: share of that hero’s attacks)</small></h4><div class="hgrid">${cards}</div>`;
}
function openerHTML(t, base) {
  if (!base || (!t.opener.size && !t.strat.size)) return '';
  const col = (title, map, icons, withText) => { const all = [...map].sort((a, b) => b[1].n - a[1].n);
    return `<div class="scol xp"><h4>${title}</h4><div class="sl">${all.map(([name, e], i) => statRow(i, icons(name, topCode(e.codes)), name, e.n, e.s3, e.st, base, withText)).join('') || '<div class="msg">–</div>'}</div>${expandBtn(all.length, 'all')}</div>`; };
  return `<h4 class="mh">Openers &amp; armies <small>(named as in /wararmies; share of attacks with an army link · 3★ rate; icons show the main troops / key parts)</small></h4><div class="sgrid">
    ${col('Openers', t.opener, (name, code) => openerIcons(name, code), 'of attacks')}${col('Armies', t.strat, (name, code) => armyIcons(code), 'of attacks')}</div>`;
}

// Attacks whose army link contains the Dragon Duke hero. Matches any text of the decoded hero (name / icon path).
const DUKE_RE = /duke/i;
function infoOf(code) {
  let c = infoCache.get(code); if (c) return c;
  const u = armyIds(secOf(code, /u([\dx-]*)/)), s = armyIds(secOf(code, /s([\dx-]*)/)), pets = new Set(), eq = new Set();
  let duke = false;
  const heroes = [];
  for (const hh of decodeHeroes(code)) {
    try { if (DUKE_RE.test(JSON.stringify(hh))) duke = true; } catch { /* ignore */ }
    if (hh.pet) { pets.add(hh.pet.name); iconOf.set(hh.pet.name, hh.pet.icon); }
    for (const e of hh.equip) { eq.add(e.name); iconOf.set(e.name, e.icon); }
    const hn = heroNameOf(hh); if (hh.icon && !iconOf.has(hn)) iconOf.set(hn, hh.icon);
    heroes.push({ name: hn, pet: hh.pet ? hh.pet.name : null, equip: (hh.equip || []).map((e) => e.name) });
  }
  c = { u, s, pets: [...pets], eq: [...eq], key: similarKey(code), group: groupKey(code), siege: siegeOf(code), duke, heroes, cls: classifyArmy(code, heroes) };
  infoCache.set(code, c); return c;
}

async function computeStats(dd, ranks, prevRanks, onProg = () => {}, cancelled = () => false) {
  const mk = () => ({ players: 0, att: 0, def: 0, aT: 0, dT: 0, st: 0, s3: 0, dz: 0, dsum: 0, dur: 0, withCode: 0,
    duke: [0, 1].map(() => ({ n: 0, st: 0, s3: 0, pct: 0, t: 0 })), comp: new Map(), hero: new Map(), opener: new Map(), strat: new Map(), shield: 0, shieldBroke: 0, noCode: 0, siege: new Map(), noSiege: { n: 0, st: 0, s3: 0 },
    armies: new Map(), troop: new Map(), spell: new Map(), pet: new Map(), equip: new Map() });
  const B = Array.from({ length: ALL + 1 }, mk);
  const G = { shield: 0, shieldBroke: 0, players: 0, att: 0, def: 0, aT: 0, dT: 0, astars: [0, 0, 0, 0], dstars: [0, 0, 0, 0], dur: 0, durN: 0, pct: 0, full: 0, perfect: 0, hours: Array(24).fill(0), hours3: Array(24).fill(0),
    dur6: Array.from({ length: 6 }, () => [0, 0]), nth: Array.from({ length: 8 }, () => ({ n: 0, st: 0, s3: 0 })),
    vsB: Array.from({ length: BUCKETS.length + 1 }, () => ({ n: 0, s3: 0 })), net: Array(11).fill(0) };
  const checkAt = new Date(dd.start).getTime() + SHIELD_CHECK_MIN * 60000, live = new Date(dd.end).getTime() > Date.now();
  const rows = [], fast = [], upsets = [];
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let pi = 0; const total = dd.players.size || 1, seen = new Set();
  for (const [tag, entry] of dd.players) {
    seen.add(tag);
    if (++pi % 150 === 0) { onProg(pi / total); await new Promise((r) => setTimeout(r, 0)); if (cancelled()) return null; }
    const d = dayFromData(dd, tag);
    const r0 = (ranks && ranks.get(tag)) || 0, b0 = r0 ? BUCKETS.findIndex(([a, b]) => r0 >= a && r0 <= b) : -1;
    if (!d.attacks.length && !d.defenses.length) { // nothing all Legend Day = shielded (quiet at the check and never battled afterwards)
      G.shield++; B[ALL].shield++; if (b0 >= 0) B[b0].shield++;
      continue;
    }
    const evTs = d.attacks.concat(d.defenses).map((h) => h.ts).filter(Number.isFinite);
    if (evTs.length === d.attacks.length + d.defenses.length && Math.min(...evTs) >= checkAt) { // quiet at the check, battled later: broke the shield rule, not counted
      G.shieldBroke++; B[ALL].shieldBroke++; if (b0 >= 0) B[b0].shieldBroke++;
    }
    const rank = (ranks && ranks.get(tag)) || 0, bi = rank ? BUCKETS.findIndex(([a, b]) => rank >= a && rank <= b) : -1;
    const targets = bi >= 0 ? [B[bi], B[ALL]] : [B[ALL]];
    const prev = (prevRanks && prevRanks.get(tag)) || 0;
    const row = { tag, name: entry.name || 'Unknown', rank, prev, delta: rank && prev ? prev - rank : 0, a: d.a, d: d.d, net: d.net, na: d.attacks.length, nd: d.defenses.length, s3: 0, dz: 0, d3: 0 };
    G.players++; targets.forEach((t) => t.players++);
    if (row.na === 8) { G.full++; }
    const myArmy = new Map(); // this player's armies today: code -> [uses, stars, 3stars, trophies, seconds]
    for (const [ai, h] of [...d.attacks].sort((x, y) => x.ts - y.ts).entries()) {
      G.att++; G.aT += h.t; G.astars[h.stars]++; G.pct += h.pct; if (h.time > 0) { G.dur += h.time; G.durN++; }
      const hr = new Date(h.ts).getUTCHours(); G.hours[hr]++;
      if (h.stars === 3) G.hours3[hr]++;
      if (h.time > 0) G.dur6[Math.min(5, Math.floor(h.time / 30))][h.stars === 3 ? 0 : 1]++;
      const nth = G.nth[Math.min(7, ai)]; nth.n++; nth.st += h.stars; if (h.stars === 3) nth.s3++;
      const oq = ranks && h.tag ? ranks.get(normTag(h.tag)) || 0 : 0, vi = oq ? BUCKETS.findIndex(([a, b]) => oq >= a && oq <= b) : BUCKETS.length;
      G.vsB[vi].n++; if (h.stars === 3) G.vsB[vi].s3++;
      if (h.code) { // per-attack stats by army ingredient (meaningful troops, siege, spells, pets, equipment) and Duke vs no Duke
        const inf = infoOf(canonCode(h.code)), parts = inf.key.split('|').map((x) => (x ? x.split(',') : []));
        const ids = [...parts[0], ...parts[2]].map((x) => 't' + x).concat(parts[1].map((x) => 's' + x), inf.pets.map((x) => 'p' + x), inf.eq.map((x) => 'e' + x));
        for (const t of targets) {
          const x = t.duke[inf.duke ? 1 : 0]; x.n++; x.st += h.stars; x.pct += h.pct; x.t += h.t; if (h.stars === 3) x.s3++;
          if (inf.siege.length) for (const id of inf.siege) { let c = t.siege.get(id); if (!c) t.siege.set(id, (c = { n: 0, s3: 0, st: 0 })); c.n++; c.st += h.stars; if (h.stars === 3) c.s3++; }
          else { t.noSiege.n++; t.noSiege.st += h.stars; if (h.stars === 3) t.noSiege.s3++; }
          tallyArmyStats(t, inf, canonCode(h.code), 1, h.stars, h.stars === 3 ? 1 : 0); noteStratPlayer(t, inf, tag, row.name, rank, 1, h.stars, h.stars === 3 ? 1 : 0, h.t);
          for (const id of ids) { let c = t.comp.get(id); if (!c) t.comp.set(id, (c = { n: 0, s3: 0, st: 0 })); c.n++; c.st += h.stars; if (h.stars === 3) c.s3++; }
        }
      } else for (const t of targets) t.noCode++;
      if (h.stars === 3) row.s3++;
      for (const t of targets) { t.att++; t.aT += h.t; t.st += h.stars; if (h.stars === 3) t.s3++; t.dur += h.time || 0; }
      if (h.stars === 3 && h.time > 0) fast.push({ tag, name: row.name, rank, opp: h.name, oppTag: h.tag, time: h.time, pct: h.pct });
      if (h.stars === 3 && rank && h.tag) {
        const dr = ranks.get(normTag(h.tag));
        if (dr && dr <= 100 && rank > dr) upsets.push({ tag, name: row.name, rank, opp: h.name, oppTag: h.tag, oppRank: dr, time: h.time, pct: h.pct });
      }
      if (h.code) { const cd = canonCode(h.code), a = myArmy.get(cd) || myArmy.set(cd, [0, 0, 0, 0, 0]).get(cd); a[0]++; a[1] += h.stars; if (h.stars === 3) a[2]++; a[3] += h.t; a[4] += h.time || 0; }
    }
    // ONE army per player: the army (group of similar codes) they used most today (ties: more stars). All their attacks with
    // that army count, even when the exact code differed a bit between attacks.
    const mine = new Map(); // similarity key -> { v: [uses, stars, 3stars, trophies, seconds], codes: Map(code -> same array) }
    for (const [code, x] of myArmy) {
      const k = infoOf(code).group; let m = mine.get(k); if (!m) mine.set(k, (m = { key: k, v: [0, 0, 0, 0, 0], codes: new Map() }));
      x.forEach((n, i) => { m.v[i] += n; }); m.codes.set(code, x);
    }
    let best = null;
    for (const m of mine.values()) if (!best || m.v[0] > best.v[0] || (m.v[0] === best.v[0] && m.v[1] > best.v[1])) best = m;
    if (best) {
      const rep = [...best.codes].sort((p, q) => q[1][0] - p[1][0] || q[1][1] - p[1][1])[0][0], info = infoOf(rep);
      for (const t of targets) {
        t.withCode++;
        let g = t.armies.get(best.key); if (!g) t.armies.set(best.key, (g = { players: 0, uses: 0, st: 0, s3: 0, t: 0, dur: 0, vars: new Map() }));
        g.players++; g.uses += best.v[0]; g.st += best.v[1]; g.s3 += best.v[2]; g.t += best.v[3]; g.dur += best.v[4];
        for (const [code, x] of best.codes) { // each exact version this player used
          let v = g.vars.get(code); if (!v) g.vars.set(code, (v = { code, players: 0, uses: 0, st: 0, s3: 0, t: 0, dur: 0 }));
          v.players++; v.uses += x[0]; v.st += x[1]; v.s3 += x[2]; v.t += x[3]; v.dur += x[4];
        }
        info.u.forEach((x) => inc(t.troop, x)); info.s.forEach((x) => inc(t.spell, x));
        info.pets.forEach((x) => inc(t.pet, x)); info.eq.forEach((x) => inc(t.equip, x));
      }
    }
    for (const h of d.defenses) {
      G.def++; G.dT += h.t; G.dstars[h.stars]++;
      if (h.stars === 0) row.dz++; if (h.stars === 3) row.d3++;
      for (const t of targets) { t.def++; t.dT += h.t; t.dsum += h.stars; if (h.stars === 0) t.dz++; }
    }
    if (row.na === 8 && row.s3 === 8) G.perfect++;
    G.net[Math.max(0, Math.min(10, Math.floor(row.net / 50) + 4))]++;
    rows.push(row);
  }
  // The crawler only stores players who battled, so a shielded player is simply missing from dd.players: anyone on the end-of-day leaderboard with no Legend battle at all today is shielded.
  if (ranks) for (const [tag, rk] of ranks) {
    if (seen.has(tag) || !rk) continue;
    const bi = BUCKETS.findIndex(([a, b]) => rk >= a && rk <= b);
    G.shield++; B[ALL].shield++; if (bi >= 0) B[bi].shield++;
  }
  G.ranked = ranks ? ranks.size : 0;
  return { B, G, rows, fast, upsets, checkAt, live };
}

// ---------- rendering (all functions return HTML strings) ----------
const fmtN = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const avgOf = (a, b, d = 1) => (b ? fmtN(a / b, d) : '–');
const pctOf = (a, b) => (!b ? '–' : a > 0 && a / b < 0.001 ? '<0.1%' : `${fmtN((100 * a) / b, 1)}%`);
const rankTag = (r) => (r ? `<small class="eod">eod: #${fmtN(r)}</small>` : '');
const who = (tag, name, rank) => `<span class="who"><a class="pl" href="player.html?tag=${esc(normTag(tag))}">${esc(name)}</a>${rankTag(rank)}</span>`;
const tieRank = (r) => r || 1e9;

function kpi(label, value, sub, c = '') { return `<div class="kpi"><small>${label}</small><b class="${c}">${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`; }
function lb(title, note, list) {
  return `<section class="panel xp"><h3>${title}</h3>${note ? `<p class="sub">${note}</p>` : ''}<div class="lb">${list.length ? list.map((r, i) => `
    <div class="lbr${i >= 10 ? ' more' : ''}"><span class="n">${i + 1}</span>${r.html || who(r.tag, r.name, r.rank)}<b class="${r.cls || ''}">${r.val}</b><small class="ex">${r.ex || ''}</small></div>`).join('')
    : '<div class="msg">Not enough data yet.</div>'}</div>${expandBtn(list.length, 'all')}</section>`;
}
const LB_MAX = 100, ARMY_SHOW = 6, ARMY_MAX = 30; // rows shown when a box is expanded (collapsed: 10 rows / 6 armies)
const expandBtn = (n, what, min = 10) => (n > min ? `<button class="btn xbtn" data-label="Show ${what} (${n})">Show ${what} (${n})</button>` : '');
const topN = (arr, cmp, n = LB_MAX) => [...arr].sort(cmp).slice(0, n);
const tied = (rows, k) => { const m = Math.max(...rows.map((r) => r[k])), n = rows.filter((r) => r[k] === m).length; return n > 10 ? ` · ${fmtN(n)} players tied at +${m}, ordered by eod rank` : ''; };

function overviewHTML(S) {
  const { G } = S, tot = G.att || 1, dtot = G.def || 1;
  const starBars = (a, label, color) => `<div class="starbars"><h4>${label}</h4>${a.map((n, s) =>
    `<div class="sb" data-tt="${esc(`${s}★ · ${fmtN(n)} ${label.startsWith('Attack') ? 'attacks' : 'defenses'} (${pctOf(n, a.reduce((x, y) => x + y, 0))})`)}"><span>${s}★</span><i style="width:${(100 * n / (a.reduce((x, y) => x + y, 0) || 1)).toFixed(1)}%;background:${color[s]}"></i><em>${pctOf(n, a.reduce((x, y) => x + y, 0))}</em></div>`).join('')}</div>`;
  const hrs = Array.from({ length: 24 }, (_, i) => (5 + i) % 24), mx = Math.max(1, ...G.hours);
  return `<section class="panel"><h3>Overview</h3><div class="kpis">
    ${kpi('Players with battles', fmtN(G.players), `${fmtN(G.full)} used all 8 attacks`)}
    ${kpi('Attacks · defenses', `${fmtN(G.att)}`, `${fmtN(G.def)} defenses logged`)}
    ${kpi('Avg attack', `+${avgOf(G.aT, G.att)}`, 'trophies per attack', 'pos')}
    ${kpi('Avg defense', `−${avgOf(G.dT, G.def)}`, 'trophies lost per defense', 'neg')}
    ${kpi('Avg stars per attack', avgOf(G.astars[1] + 2 * G.astars[2] + 3 * G.astars[3], G.att, 2), `${pctOf(G.astars[3], G.att)} are 3★`)}
    ${kpi('0★ defenses', pctOf(G.dstars[0], G.def), `${fmtN(G.dstars[0])} attacks failed`)}
    ${kpi('Avg destruction', `${avgOf(G.pct, G.att, 1)}%`, 'per attack')}
    ${kpi('Avg battle time', G.durN ? dur(Math.round(G.dur / G.durN)) : '–', 'minutes:seconds')}
    ${kpi('Perfect days', fmtN(G.perfect), '8 attacks, all 3★ (+320)', 'pos')}
  </div>
  <div class="two">${starBars(G.astars, 'Attack results', ['#c2362f', '#e0a526', '#8bc34a', '#1a8f4c'])}${starBars(G.dstars, 'Defense results (attacker’s stars)', ['#1a8f4c', '#8bc34a', '#e0a526', '#c2362f'])}</div>
  <h4>Attacks by hour (UTC, starting at the 05:00 reset)</h4>
  <div class="hours">${hrs.map((h) => `<div class="hcol" data-tt="${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00 UTC · ${fmtN(G.hours[h])} attacks (${pctOf(G.hours[h], G.att)})"><i style="height:${(100 * G.hours[h] / mx).toFixed(1)}%"></i><span>${h}</span></div>`).join('')}</div></section>`;
}

function placementHTML(S) {
  const line = (i) => { const t = S.B[i]; return `<tr><td>${bucketName(i)}</td><td>${fmtN(t.players)}</td><td class="pos">+${avgOf(t.aT, t.att)}</td><td class="neg">−${avgOf(t.dT, t.def)}</td>
    <td class="${t.players && t.aT - t.dT >= 0 ? 'pos' : 'neg'}">${t.players ? fmt(Math.round((t.aT - t.dT) / t.players)) : '–'}</td><td>${avgOf(t.st, t.att, 2)}</td><td>${pctOf(t.s3, t.att)}</td><td>${pctOf(t.dz, t.def)}</td><td>${avgOf(t.dsum, t.def, 2)}</td></tr>`; };
  return `<section class="panel"><h3>By ranking placement</h3><p class="sub">Players grouped by their end-of-day rank. “Net” is the average trophies gained minus lost per player. Across everyone the attack and defense averages match, because every battle is one player’s attack and another’s defense. Placement is where they differ.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Rank</th><th>Players</th><th>Avg attack</th><th>Avg defense</th><th>Avg net</th><th>★ / attack</th><th>3★ attacks</th><th>0★ defenses</th><th>★ conceded</th></tr></thead>
    <tbody>${[...BUCKETS.keys()].map(line).join('')}${line(ALL)}</tbody></table></div></section>`;
}

function leaderboardsHTML(S) {
  const R = S.rows, rk = (a, b) => tieRank(a.rank) - tieRank(b.rank);
  const offense = topN(R, (a, b) => b.a - a.a || rk(a, b)).map((r) => ({ ...r, val: `+${r.a}`, cls: 'pos', ex: `${r.na}/8 attacks · ${r.s3}×3★` }));
  const defense = topN(R.filter((r) => r.nd >= 8), (a, b) => a.d - b.d || b.dz - a.dz || rk(a, b)).map((r) => ({ ...r, val: `−${r.d}`, cls: 'neg', ex: `${r.nd}/8 defenses · ${r.dz}×0★` }));
  const zero = topN(R, (a, b) => b.dz - a.dz || b.nd - a.nd || a.d - b.d || rk(a, b)).map((r) => ({ ...r, val: `${r.dz}×0★`, ex: `${r.nd} defenses · −${r.d}` }));
  const net = topN(R, (a, b) => b.net - a.net || rk(a, b)).map((r) => ({ ...r, val: fmt(r.net), cls: cls(r.net), ex: `+${r.a} / −${r.d}` }));
  const mv = (r) => ({ ...r, val: `${r.delta > 0 ? '▲' : '▼'} ${fmtN(Math.abs(r.delta))}`, cls: r.delta > 0 ? 'pos' : 'neg', ex: `#${fmtN(r.prev)} → #${fmtN(r.rank)} · net ${fmt(r.net)}` });
  const moved = R.filter((r) => r.delta && Math.min(r.rank, r.prev) <= 2500);
  const climbers = topN(moved, (a, b) => b.delta - a.delta).map(mv), drops = topN(moved, (a, b) => a.delta - b.delta).map(mv);
  const climbNote = moved.length ? 'Rank change since the previous end of day, for players in the top 2,500 on either day' : 'Needs two end-of-day snapshots';
  const fastest = topN(S.fast, (a, b) => a.time - b.time || rk(a, b)).map((r) => ({ ...r, val: dur(r.time), ex: `${r.pct}% vs ${esc(r.opp)}` }));
  const up = topN(S.upsets, (a, b) => b.rank - a.rank).map((r) => ({ ...r, val: `+${fmtN(r.rank - r.oppRank)}`, ex: `3★ vs ${esc(r.opp)} (eod #${r.oppRank})` }));
  return `<h2 class="sh">Leaderboards</h2><div class="lbs xl">
    ${lb('Top offense', `Most trophies gained from attacks${tied(R, 'a')}`, offense)}
    ${lb('Top defense', 'Fewest trophies lost, players with 8/8 defenses', defense)}
    ${lb('Most 0★ defenses', 'Attackers who got no stars at all', zero)}
    ${lb('Best net', 'Attack trophies minus defense trophies', net)}
    ${lb('Biggest climbers', climbNote, climbers)}
    ${lb('Biggest drops', climbNote, drops)}
    ${lb('Fastest 3★ attacks', 'Shortest battles that ended in a triple', fastest)}
    ${lb('Giant killers', '3★ attacks on a top-100 defender, biggest rank gap first (value = places between them)', up)}
  </div>`;
}

function bucketTabs(sel) {
  return `<div class="seg wrapseg" id="bseg" role="group" aria-label="Rank placement">${[...BUCKETS.keys(), ALL].map((i) =>
    `<button data-b="${i}" aria-pressed="${i === sel}">${bucketName(i)}</button>`).join('')}</div>`;
}
const SORTS = { used: 'Most used', s3: 'Best 3★ rate', trophies: 'Best avg trophies' };
const statsLine = (g) => `<span>★ ${avgOf(g.st, g.uses, 2)}</span><span>3★ ${pctOf(g.s3, g.uses)}</span><span class="pos">+${avgOf(g.t, g.uses)}</span><span>${g.uses ? dur(Math.round(g.dur / g.uses)) : '–'}</span>`;
const repOf = (g) => [...g.vars.values()].sort((a, b) => b.players - a.players || b.uses - a.uses)[0];
function armiesHTML(S, sel, sort) {
  const t = S.B[sel], minP = sort === 'used' ? 1 : Math.max(2, Math.min(5, Math.round(t.withCode / 100)));
  const val = { used: (g) => g.players, s3: (g) => g.s3 / g.uses, trophies: (g) => g.t / g.uses }[sort];
  const list = [...t.armies.values()].filter((g) => g.players >= minP && g.uses >= (sort === 'used' ? 1 : 10))
    .sort((a, b) => val(b) - val(a) || b.players - a.players || b.uses - a.uses).slice(0, ARMY_MAX);
  state.list = list;
  const cards = list.map((g, i) => `<div class="acard${i >= ARMY_SHOW ? ' more' : ''}"><div class="ah"><b>#${i + 1}</b><span><em>${fmtN(g.players)}</em> player${g.players === 1 ? '' : 's'} · ${pctOf(g.players, t.withCode)} of ${bucketName(sel)} · ${fmtN(g.uses)} attack${g.uses === 1 ? '' : 's'}</span></div>
      <div class="am">${statsLine(g)}</div>${ckArmy(repOf(g).code)}
      ${g.vars.size > 1 ? `<button class="btn vbtn" data-g="${i}" aria-expanded="false">▸ ${fmtN(g.vars.size)} variations</button>` : '<small class="sub">Only one version used</small>'}
      <div class="vars" id="vars${i}"></div></div>`).join('');
  return `<h2 class="sh">Top armies by placement</h2><section class="panel">
    <div class="controls">${bucketTabs(sel)}<div class="seg" id="sseg" role="group" aria-label="Sort armies">${Object.entries(SORTS).map(([k, v]) =>
      `<button data-s="${k}" aria-pressed="${k === sort}">${v}</button>`).join('')}</div></div>
    <p class="sub">${fmtN(t.withCode)} ${bucketName(sel)} players, one army each: the one they used most today. Armies are grouped by their main-army troops only: troop counts, minor troops (under ${MIN_TROOP_SPACE} housing space), spells, siege machines (main army or Clan Castle), heroes, pets and equipment don’t split an army. The card shows the most popular version; click “variations” to see the others.${sort === 'used' ? '' : ' Needs a minimum number of players and 10+ attacks.'}</p>
    <div class="xp"><div class="acards">${cards || '<div class="msg">Not enough armies in this group yet.</div>'}</div>${expandBtn(list.length, 'more armies', ARMY_SHOW)}</div>
    ${metaHTML(t)}${compHTML(t)}${siegeHTML(t)}${heroHTML(t, t.duke[0].n + t.duke[1].n)}${openerHTML(t, t.duke[0].n + t.duke[1].n)}</section>${strategyTopHTML(t, 3)}`;
}
function variantsHTML(g) {
  const vs = [...g.vars.values()].sort((a, b) => b.players - a.players || b.uses - a.uses), shown = vs.slice(0, 40);
  return shown.map((v) => `<div class="var"><div class="am"><b>${fmtN(v.players)} player${v.players === 1 ? '' : 's'}</b>${statsLine(v)}<span>${fmtN(v.uses)} attack${v.uses === 1 ? '' : 's'}</span></div>${ckArmy(v.code)}</div>`).join('')
    + (vs.length > shown.length ? `<small class="sub">Showing the ${shown.length} most popular of ${fmtN(vs.length)} variations.</small>` : '');
}
function metaHTML(t) {
  const n = t.withCode || 1;
  const col = (title, map, resolve, cat) => { const all = [...map.entries()].sort((a, b) => b[1] - a[1]);
    return `<div class="mcol xp"><h4>${title}</h4><div class="mlist">${all.map(([k, c], i) => {
    const [name, icon] = resolve(k);
    return `<div class="mrow${i >= 10 ? ' more' : ''}" data-tt="${esc(name)} · ${fmtN(c)} players (${pctOf(c, n)})">${ckTile(cat, name, icon)}<span class="mn">${esc(name)}</span><span class="mb"><i style="width:${(100 * c / n).toFixed(1)}%"></i></span><em>${pctOf(c, n)}</em></div>`;
  }).join('') || '<div class="msg">–</div>'}</div>${expandBtn(all.length, 'all')}</div>`; };
  const idn = (tbl) => (id) => tbl[id] || [`#${id}`, ''];
  return `<h4 class="mh">What they bring <small>(share of players whose army includes it)</small></h4><div class="meta4">
    ${col('Troops & siege', t.troop, (id) => ARMY_IDS.troop[id] || ARMY_IDS.siege[id] || [`#${id}`, ''], 'troop')}
    ${col('Spells', t.spell, idn(ARMY_IDS.spell), 'spell')}
    ${col('Pets', t.pet, (n) => [n, iconOf.get(n) || ''], 'pet')}
    ${col('Hero equipment', t.equip, (n) => [n, iconOf.get(n) || ''], 'equip')}</div>`;
}

// ---------- extra stats: Dragon Duke, charts, ingredient performance ----------
const GREEN = '#1a8f4c', RED = '#c2362f', GOLD = '#e0a526', GREY = '#8a9a9c';
const rate = (a, b) => (b ? (100 * a) / b : 0);
const pp = (x) => `${x >= 0 ? '+' : '−'}${fmtN(Math.abs(x), 1)} pp`;
function vcols(items, max) { // vertical bar chart; each item: { label, top, segs: [[value, color]...], tt }
  const mx = max || Math.max(1, ...items.map((it) => it.segs.reduce((a, s) => a + s[0], 0)));
  return `<div class="vc">${items.map((it) => `<div class="vcc" data-tt="${esc(it.tt)}"><small>${it.top ?? ''}</small><div class="vcb">${it.segs.map(([v, c]) =>
    `<i style="height:${Math.min(100, (100 * v) / mx).toFixed(1)}%;background:${c}"></i>`).join('')}</div><span>${it.label}</span></div>`).join('')}</div>`;
}
const hbars = (items) => items.map((it) => `<div class="hb" data-tt="${esc(it.tt)}"><span>${it.label}</span><div><i style="width:${Math.min(100, it.v).toFixed(1)}%"></i></div><em>${it.text}</em></div>`).join('');

function shieldHTML(S) {
  const rows = [...BUCKETS.keys(), ALL].map((i) => { const b = S.B[i], sh = b.shield, br = b.shieldBroke || 0; return { i, sh, br, q: sh + br, n: b.players + sh }; }), A = rows[rows.length - 1];
  if (!A.n) return '';
  const hh = new Date(S.checkAt), at = `${String(hh.getUTCHours()).padStart(2, '0')}:${String(hh.getUTCMinutes()).padStart(2, '0')} UTC`;
  const pending = S.checkAt > Date.now();
  const bar = (label, v, base, color) => `<div class="fn"><span>${label}</span><div><i style="width:${base ? (100 * v / base).toFixed(1) : 0}%;background:${color}"></i></div><em>${fmtN(v)} · ${pctOf(v, base)}</em></div>`;
  const line = (r) => `<tr><td>${bucketName(r.i)}</td><td>${fmtN(r.n)}</td><td>${fmtN(r.q)}</td><td>${fmtN(r.br)}</td><td><b>${fmtN(r.sh)}</b></td><td>${pctOf(r.sh, r.n)}</td></tr>`;
  if (pending) return `<section class="panel"><h3>Shield watch</h3><p class="shield-note">The shield check runs at ${at}, ${SHIELD_CHECK_MIN} minutes after the reset. Come back after that.</p></section>`;
  return `<section class="panel"><h3>Shield watch</h3><div class="kpis">
    ${kpi('Shielded today', fmtN(A.sh), `${pctOf(A.sh, A.n)} of ${fmtN(A.n)} tracked players`, 'pos')}
    ${kpi(`Quiet at ${at}`, fmtN(A.q), 'no Legend battle yet')}
    ${kpi('Broke the shield', fmtN(A.br), 'had a Legend battle later — removed', A.br ? 'neg' : '')}
    ${kpi('Played the day', fmtN(S.G.players), 'at least one attack or defense')}</div>
    <div class="funnel">${bar('Tracked players', A.n, A.n, 'var(--ck-accent)')}${bar(`Quiet at ${at}`, A.q, A.n, '#e0a526')}${bar('Still shielded (final)', A.sh, A.n, '#1a8f4c')}</div>
    <p class="shield-note">A Legend shield means no Legend League battles that day (shielded players can still attack and be attacked in normal mode, which isn’t tracked here). Checked ${SHIELD_CHECK_MIN} minutes after the 05:00 UTC reset: everyone without a battle by then is a candidate, and anyone who then has a Legend attack or defense during the rest of the day broke the rule and is removed.${S.live ? ' The day is still running, so this count can only go down.' : ''} Players are counted from the end-of-day leaderboard: ranked, but with no Legend battle at all. Rank rows use end-of-day rank.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Rank</th><th>Tracked</th><th>Quiet at check</th><th>Removed</th><th>Shielded</th><th>Share</th></tr></thead><tbody>${rows.map(line).join('')}</tbody></table></div></section>`;
}
function dukeHTML(S) {
  const rows = [...BUCKETS.keys(), ALL].map((i) => { const [no, yes] = S.B[i].duke; return { i, no, yes }; }), A = rows[rows.length - 1];
  if (!A.yes.n) return `<section class="panel"><h3>Dragon Duke</h3><p class="sub">No attacks with the Dragon Duke found among ${fmtN(A.no.n)} attacks that have an army link. If you expect some, check that the hero decodes with “Duke” in its name (DUKE_RE in stats.js).</p></section>`;
  const r3 = (x) => rate(x.s3, x.n), diff = (y, n) => (y.n && n.n ? pp(r3(y) - r3(n)) : '–');
  const cls2 = (y, n) => (y.n && n.n ? (r3(y) >= r3(n) ? 'pos' : 'neg') : '');
  const line = ({ i, no, yes }) => `<tr><td>${bucketName(i)}</td><td>${pctOf(yes.n, yes.n + no.n)} <small>(${fmtN(yes.n)})</small></td><td>${pctOf(yes.s3, yes.n)}</td><td>${pctOf(no.s3, no.n)}</td>
    <td class="${cls2(yes, no)}">${diff(yes, no)}</td><td>${avgOf(yes.st, yes.n, 2)}</td><td>${avgOf(no.st, no.n, 2)}</td><td>${avgOf(yes.pct, yes.n, 1)}%</td><td>${avgOf(no.pct, no.n, 1)}%</td><td>+${avgOf(yes.t, yes.n)}</td><td>+${avgOf(no.t, no.n)}</td></tr>`;
  const pairs = rows.filter((r) => r.yes.n >= 5 && r.no.n >= 5).map((r) => `<div class="hb2" data-tt="${esc(`${bucketName(r.i)} · with Duke ${pctOf(r.yes.s3, r.yes.n)} (${fmtN(r.yes.n)} attacks) · without ${pctOf(r.no.s3, r.no.n)} (${fmtN(r.no.n)} attacks)`)}"><span>${bucketName(r.i)}</span>
    <div class="bw"><div class="a"><i style="width:${r3(r.yes).toFixed(1)}%"></i></div><div class="b"><i style="width:${r3(r.no).toFixed(1)}%"></i></div></div><em>${fmtN(r3(r.yes), 1)}% vs ${fmtN(r3(r.no), 1)}%</em></div>`).join('');
  return `<section class="panel"><h3>Dragon Duke vs no Duke</h3><div class="kpis">
    ${kpi('Duke usage', pctOf(A.yes.n, A.yes.n + A.no.n), `${fmtN(A.yes.n)} of ${fmtN(A.yes.n + A.no.n)} attacks`)}
    ${kpi('3★ with Duke', pctOf(A.yes.s3, A.yes.n), `${avgOf(A.yes.st, A.yes.n, 2)} ★ per attack`, 'pos')}
    ${kpi('3★ without Duke', pctOf(A.no.s3, A.no.n), `${avgOf(A.no.st, A.no.n, 2)} ★ per attack`)}
    ${kpi('Difference', diff(A.yes, A.no), 'in 3★ rate (percentage points)', cls2(A.yes, A.no))}</div>
    <p class="sub">Per attack, using the army link of each attack (attacks without an army link are left out). Players who pick the Duke may simply be better players, so this shows what happened, not what the Duke causes.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Rank</th><th>Duke usage</th><th>3★ with</th><th>3★ without</th><th>Difference</th><th>★ with</th><th>★ without</th><th>Destruction with</th><th>Destruction without</th><th>Trophies with</th><th>Trophies without</th></tr></thead>
    <tbody>${rows.map(line).join('')}</tbody></table></div>
    ${pairs ? `<h4>3★ rate by placement <small class="lg"><i class="a"></i>with Duke <i class="b"></i>without Duke</small></h4>${pairs}` : ''}</section>`;
}

function chartsHTML(S) {
  const { G } = S, pad = (h) => String(h).padStart(2, '0'), hrs = Array.from({ length: 24 }, (_, i) => (5 + i) % 24);
  const t30 = (i) => `${Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`;
  const hourly = vcols(hrs.map((h) => ({ label: h, top: G.hours[h] ? Math.round(rate(G.hours3[h], G.hours[h])) : '', segs: [[rate(G.hours3[h], G.hours[h]), GREEN]],
    tt: `${pad(h)}:00–${pad((h + 1) % 24)}:00 UTC · ${pctOf(G.hours3[h], G.hours[h])} 3★ (${fmtN(G.hours3[h])} of ${fmtN(G.hours[h])} attacks)` })));
  const lens = vcols(G.dur6.map((v, i) => ({ label: t30(i), top: v[0] + v[1] ? fmtN(v[0] + v[1]) : '', segs: [[v[0], GREEN], [v[1], GREY]],
    tt: `${t30(i)}–${t30(i + 1)} · ${fmtN(v[0] + v[1])} battles, ${fmtN(v[0])} were 3★ (${pctOf(v[0], v[0] + v[1])})` })));
  const nth = vcols(G.nth.map((v, i) => ({ label: `#${i + 1}`, top: v.n ? Math.round(rate(v.s3, v.n)) : '', segs: [[rate(v.s3, v.n), GOLD]],
    tt: `Attack #${i + 1} of the day · ${pctOf(v.s3, v.n)} 3★ · ${avgOf(v.st, v.n, 2)} ★ (${fmtN(v.n)} attacks)` })));
  const net = vcols(G.net.map((n, b) => { const lo = (b - 4) * 50, lab = b === 0 ? '<−150' : b === 10 ? '300+' : `${lo < 0 ? '−' : ''}${Math.abs(lo)}`;
    return { label: lab, top: n ? fmtN(n) : '', segs: [[n, lo < 0 ? RED : GREEN]], tt: `${b === 0 ? 'Below −150' : b === 10 ? '+300 or more' : `${lo < 0 ? '−' : '+'}${Math.abs(lo)} to ${lo + 49 < 0 ? '−' : '+'}${Math.abs(lo + 49)}`} net · ${fmtN(n)} players` }; }));
  const vs = G.vsB.map((v, i) => ({ v, i })).filter((x) => x.v.n).map(({ v, i }) => ({ label: i === BUCKETS.length ? 'Unranked' : bucketName(i), v: rate(v.s3, v.n), text: pctOf(v.s3, v.n),
    tt: `Defender ${i === BUCKETS.length ? 'unranked at end of day' : 'in ' + bucketName(i)} · ${pctOf(v.s3, v.n)} 3★ (${fmtN(v.s3)} of ${fmtN(v.n)} attacks)` }));
  const cp = (title, note, body) => `<div class="cp"><h4>${title}</h4><p class="sub">${note}</p>${body}</div>`;
  return `<section class="panel"><h3>Trends &amp; distributions</h3><div class="cgrid">
    ${cp('3★ rate by hour (UTC)', 'Share of attacks that were triples, hour by hour from the 05:00 reset', hourly)}
    ${cp('Battle length', 'Attacks by time used; green = 3★, grey = not', lens)}
    ${cp('3★ rate by attack number', 'Each player’s 1st, 2nd … 8th attack of the day', nth)}
    ${cp('Net trophies per player', 'Players by net trophies today (bins of 50; red = lost trophies)', net)}
    ${vs.length > 1 ? cp('3★ rate by defender placement', 'How often attackers triple defenders from each end-of-day rank group', hbars(vs)) : ''}</div></section>`;
}

// Siege machines: how often each one is brought (main army or Clan Castle, one count per attack) and how often it triples.
function siegeHTML(t) {
  const base = t.duke[0].n + t.duke[1].n, ns = t.noSiege, minN = Math.max(10, Math.round(base * 0.01));
  const list = [...t.siege].map(([id, v]) => ({ id, ...v }));
  if (!list.length) return '';
  const nm = (id) => ARMY_IDS.siege[id] || [`#${id}`, ''];
  const used = [...list].sort((a, b) => b.n - a.n || b.s3 - a.s3);
  const best = list.filter((r) => r.n >= minN).sort((a, b) => rate(b.s3, b.n) - rate(a.s3, a.n) || b.n - a.n);
  const col = (title, arr, width, text) => `<div class="mcol xp"><h4>${title}</h4><div class="mlist">${arr.map((r, i) => { const [name, icon] = nm(r.id);
    return `<div class="mrow${i >= 10 ? ' more' : ''}" data-tt="${esc(name)} · ${pctOf(r.n, base)} of attacks · ${pctOf(r.s3, r.n)} 3★ · ${avgOf(r.st, r.n, 2)} ★ · ${fmtN(r.n)} attacks">${ckTile('troop', name, icon)}<span class="mn">${esc(name)}</span><span class="mb"><i style="width:${width(r).toFixed(1)}%"></i></span><em>${text(r)}</em></div>`; }).join('') || '<div class="msg">–</div>'}</div>${expandBtn(arr.length, 'all')}</div>`;
  const top = (r, v) => (r ? kpi(v[0], esc(nm(r.id)[0]), v[1]) : kpi(v[0], '–', ''));
  return `<h4 class="mh">Siege machines <small>(per attack; main army and Clan Castle count the same, a machine is counted once per attack)</small></h4><div class="kpis">
    ${top(used[0], ['Most used siege', `${pctOf(used[0].n, base)} of attacks`])}
    ${top(best[0], ['Highest 3★ rate', best[0] ? `${pctOf(best[0].s3, best[0].n)} 3★ · ${fmtN(best[0].n)} attacks` : ''])}
    ${kpi('No siege machine', pctOf(ns.s3, ns.n), `3★ rate · ${fmtN(ns.n)} attacks`)}</div>
  <div class="meta4">${col('Most used', used, (r) => (base ? (100 * r.n) / base : 0), (r) => pctOf(r.n, base))}${col('Highest 3★ rate', best, (r) => rate(r.s3, r.n), (r) => pctOf(r.s3, r.n))}</div>
  <p class="sub">The 3★ list needs at least ${fmtN(minN)} attacks with the machine.</p>`;
}

function compHTML(t) {
  const base = t.duke[0].n + t.duke[1].n, minN = Math.max(10, Math.round(base * 0.01));
  const col = (title, pre, resolve, cat) => {
    const all = [...t.comp].filter(([k, v]) => k[0] === pre && v.n >= minN).sort((a, b) => rate(b[1].s3, b[1].n) - rate(a[1].s3, a[1].n) || b[1].n - a[1].n);
    return `<div class="mcol xp"><h4>${title}</h4><div class="mlist">${all.map(([k, v], i) => { const [name, icon] = resolve(k.slice(1));
      return `<div class="mrow${i >= 10 ? ' more' : ''}" data-tt="${esc(name)} · ${pctOf(v.s3, v.n)} 3★ · ${avgOf(v.st, v.n, 2)} ★ · ${fmtN(v.n)} attacks (${pctOf(v.n, base)} of attacks)">${ckTile(cat, name, icon)}<span class="mn">${esc(name)}</span><span class="mb"><i style="width:${rate(v.s3, v.n).toFixed(1)}%"></i></span><em>${pctOf(v.s3, v.n)}</em></div>`; }).join('') || '<div class="msg">–</div>'}</div>${expandBtn(all.length, 'all')}</div>`;
  };
  const byId = (...tbls) => (id) => { for (const tb of tbls) if (tb[id]) return tb[id]; return [`#${id}`, '']; };
  return `<h4 class="mh">How each one performs <small>(3★ rate of attacks that used it, at least ${fmtN(minN)} attacks; minor troops are left out)</small></h4><div class="meta4">
    ${col('Troops & siege', 't', byId(ARMY_IDS.troop, ARMY_IDS.siege), 'troop')}${col('Spells', 's', byId(ARMY_IDS.spell), 'spell')}
    ${col('Pets', 'p', (n) => [n, iconOf.get(n) || ''], 'pet')}${col('Hero equipment', 'e', (n) => [n, iconOf.get(n) || ''], 'equip')}</div>`;
}

// ---------- v2 layout: chapters + sticky nav, top performers per strategy ----------
const SHIELD_CHECK_MIN = 90; // shield check: 90 min after the 05:00 UTC reset (inside the 1-2 h window)
const wilson = (k, n, z = 1.64) => { if (!n) return 0; const p = k / n, d = 1 + (z * z) / n; return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / d; }; // 3★ rate, adjusted for sample size
function noteStratPlayer(t, inf, tag, name, rank, w, st, s3, tr) { // per-player tally for each strategy (feeds "Top performers")
  const e = tl(t.strat, inf.cls.strategy); if (!e.players) e.players = new Map();
  let p = e.players.get(tag); if (!p) e.players.set(tag, (p = { tag, name, rank, n: 0, st: 0, s3: 0, t: 0 }));
  p.n += w; p.st += st; p.s3 += s3; p.t += tr;
}
const STRAT_SHOW = 12, STRAT_ROWS = 10;
function strategyTopHTML(t, minN) {
  const strats = [...t.strat].filter(([, e]) => e.players && e.players.size).sort((a, b) => b[1].n - a[1].n).slice(0, STRAT_SHOW);
  const cards = strats.map(([name, e]) => {
    const ps = [...e.players.values()].filter((p) => p.n >= minN).sort((a, b) => wilson(b.s3, b.n) - wilson(a.s3, a.n) || b.st / b.n - a.st / a.n || b.n - a.n).slice(0, STRAT_ROWS);
    if (!ps.length) return '';
    const rows = ps.map((p, i) => `<div class="lbr${i >= 3 ? ' more' : ''}"><span class="n">${i + 1}</span>${who(p.tag, p.name, p.rank)}<b class="pos">${pctOf(p.s3, p.n)} 3★</b><small class="ex">${avgOf(p.st, p.n, 2)} ★ · +${avgOf(p.t, p.n)} · ${fmtN(p.n)} atk</small></div>`).join('');
    return `<div class="scard xp"><div class="sch"><span class="icons">${armyIcons(topCode(e.codes))}</span><div><b>${esc(name)}</b><small>${fmtN(e.players.size)} players · ${fmtN(e.n)} attacks · ${pctOf(e.s3, e.n)} 3★</small></div></div><div class="lb">${rows}</div>${expandBtn(ps.length, `top ${ps.length}`, 3)}</div>`;
  }).join('');
  return `<div id="ch-strats" class="strats"><h2 class="sh">Top performers by strategy</h2><section class="panel"><p class="sub">The best players for each strategy, ranked by 3★ rate adjusted for sample size (so 8 lucky attacks don’t beat a long streak). At least ${minN} attacks with the strategy are needed to be listed. Follows the rank tab above.</p>${cards ? `<div class="sgrid2">${cards}</div>` : '<div class="msg">Not enough attacks per strategy yet.</div>'}</section></div>`;
}
function chapter(id, num, title, blurb, html) {
  return `<div class="chapter" id="ch-${id}"><header class="chead"><span class="cnum">${num}</span><div><h2>${title}</h2><p>${blurb}</p></div></header>${html}</div>`;
}
function buildPage(chs, extra = []) {
  const used = chs.filter((c) => c[3] && c[3].trim());
  const nav = used.map((c) => [`ch-${c[0]}`, c[1]]).concat(extra);
  return `<nav class="cnav" aria-label="Sections">${nav.map(([id, label]) => `<a href="#${id}" data-t="${id}">${label}</a>`).join('')}</nav>`
    + used.map((c, i) => chapter(c[0], String(i + 1).padStart(2, '0'), c[1], c[2], c[3])).join('');
}
let navBound = false;
function initNav() { // scroll-spy for the section chips + back-to-top button (bound once)
  if (navBound) return; navBound = true;
  const top = document.createElement('a'); top.id = 'ck-top'; top.href = '#'; top.textContent = '↑'; top.setAttribute('aria-label', 'Back to top'); document.body.appendChild(top);
  const spy = () => {
    top.classList.toggle('show', window.scrollY > 700);
    let cur = ''; for (const a of document.querySelectorAll('.cnav a')) { const el = document.getElementById(a.dataset.t); if (el && el.getBoundingClientRect().top <= 120) cur = a.dataset.t; }
    for (const a of document.querySelectorAll('.cnav a')) a.classList.toggle('on', a.dataset.t === cur);
  };
  window.addEventListener('scroll', spy, { passive: true }); spy();
}
const STYLES = `.hgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:12px;margin:8px 0}.sgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:14px;margin:8px 0}.hgrid>*,.sgrid>*{min-width:0}.hcard{border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:10px;overflow:hidden}.hcard .hh{display:flex;align-items:center;gap:10px;margin-bottom:6px;min-width:0}.hcard .ht{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.hcard .ht span{font-size:.85em;opacity:.8;overflow-wrap:anywhere}.himg{flex:none;width:40px;height:40px;object-fit:contain;display:block}.srow{padding:6px 0;border-bottom:1px solid rgba(128,128,128,.15);min-width:0}.sr1{display:flex;align-items:center;gap:8px;min-width:0}.sn{flex:1 1 0;min-width:0;overflow-wrap:anywhere;line-height:1.25}.icons{display:flex;flex:none;flex-wrap:wrap;gap:3px;max-width:50%}.icons>*{flex:none;width:30px;height:30px;overflow:hidden;position:static}.icons img{width:100%;height:100%;object-fit:contain;display:block}.sr2{display:flex;align-items:center;gap:8px;margin-top:4px;min-width:0}.sbar{flex:1;min-width:0;height:6px;border-radius:3px;background:rgba(128,128,128,.2);overflow:hidden}.sbar i{display:block;height:100%;background:#1a8f4c;opacity:.7}.sr2 em{flex:none;font-style:normal;font-size:.85em;white-space:nowrap}.xp:not(.open) .srow.more{display:none}.prog{max-width:520px;margin:40px auto;text-align:center}.progbar{height:10px;border-radius:6px;background:rgba(128,128,128,.25);overflow:hidden;margin:10px 0 6px}
.progbar i{display:block;height:100%;width:0;background:${GREEN};border-radius:6px;transition:width .25s ease}.prog em{font-style:normal;opacity:.7;font-size:.85em}
.cgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:22px}.cp h4{margin:0 0 2px}.cp .sub{margin:0 0 6px;font-size:.85em}
.vc{display:flex;gap:3px;align-items:flex-end;margin-top:8px}.vcc{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px}
.vcc small{font-size:.62em;opacity:.75;height:1.1em;white-space:nowrap}.vcb{width:100%;height:110px;display:flex;flex-direction:column-reverse}.vcb i{display:block;width:100%}
.vcc span{font-size:.68em;opacity:.7;white-space:nowrap}.hb{display:grid;grid-template-columns:90px 1fr 56px;gap:8px;align-items:center;font-size:.85em;margin:5px 0}
.hb div,.hb2 .bw div{height:10px;background:rgba(128,128,128,.2);border-radius:5px;overflow:hidden}.hb i{display:block;height:100%;background:${GREEN}}.hb em,.hb2 em{font-style:normal;text-align:right}
.hb2{display:grid;grid-template-columns:90px 1fr 110px;gap:8px;align-items:center;font-size:.85em;margin:7px 0}.hb2 .bw div{height:8px;margin:2px 0}.hb2 i{display:block;height:100%}
.hb2 .a i,.lg .a{background:${GOLD}}.hb2 .b i,.lg .b{background:${GREY}}.lg{font-weight:400;margin-left:8px}.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 8px}
.ic,.icons>.ic{flex:none;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;border-radius:6px;background:rgba(128,128,128,.15);position:relative;line-height:1}.ic .cnt{position:absolute;right:0;bottom:0;padding:0 3px;border-radius:5px 0 5px 0;background:rgba(0,0,0,.72);color:#fff;font-size:10px;font-weight:700;line-height:14px;white-space:nowrap}.ic img,.himg{position:static;transform:none}
.mlist .mrow{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 0;border-bottom:1px solid rgba(128,128,128,.15)}.mlist .mrow .mn{flex:1 1 0;min-width:0;overflow-wrap:anywhere;line-height:1.25}
.mlist .mrow .mb{flex:0 0 56px;display:block;height:6px;border-radius:3px;background:rgba(128,128,128,.2);overflow:hidden}.mlist .mrow .mb i{display:block;height:100%;background:#1a8f4c;opacity:.7}
.mlist .mrow em,.mlist .mrow .mc{flex:none;font-style:normal;white-space:nowrap;font-size:.9em;text-align:right;min-width:3.2em}
.meta4{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:14px}.meta4>*,.mcol,.scol,.kpi,.panel{min-width:0}.kpi b{overflow-wrap:anywhere}.mh small{display:block;font-weight:400;opacity:.75;overflow-wrap:anywhere}
.sr2{flex-wrap:wrap}.sr2 .sbar{flex:1 1 60px}
.ca{display:flex;flex-direction:column;gap:6px;margin:6px 0}.ca .crow{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}.ca .hero{display:flex;gap:2px;align-items:flex-start;margin-right:6px}.ca .hs{display:flex;flex-direction:column;gap:2px}.ca .lbl{font-weight:700;opacity:.65;font-size:.8em;margin-right:2px}
.ic.u{border:2px solid #c9a24a;border-radius:8px;background:rgba(128,128,128,.12)}.ic.u.sp{border-color:#8a63d2}.ic.u.hr{border-color:#e0a526;border-radius:10px}.ic.u.mini{border-width:1px;border-radius:5px}
.ic .cnt.tl{right:auto;bottom:auto;left:0;top:0;border-radius:6px 0 6px 0}
:root{--ck-accent:#8b6cf6;--ck-gold:#e0a526;--ck-line:rgba(128,128,128,.24)}html{scroll-behavior:smooth}@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.chapter{animation:none!important}}
.cnav{position:sticky;top:0;z-index:30;display:flex;gap:6px;overflow-x:auto;padding:8px 10px;margin:4px 0 8px;border:1px solid var(--ck-line);border-radius:14px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:rgba(128,128,128,.16);scrollbar-width:none}.cnav::-webkit-scrollbar{display:none}
.cnav a{flex:none;padding:6px 13px;border-radius:999px;text-decoration:none;color:inherit;font-weight:600;font-size:.9rem;opacity:.78;border:1px solid transparent;transition:background .15s,opacity .15s}.cnav a:hover,.cnav a.on{opacity:1;background:rgba(139,108,246,.24);border-color:rgba(139,108,246,.55)}
.chapter{margin:36px 0 8px;scroll-margin-top:70px;animation:ckin .45s ease both}@keyframes ckin{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.chead{display:flex;gap:14px;align-items:center;margin:0 0 14px;padding:0 2px;border-bottom:1px solid var(--ck-line);padding-bottom:12px}.chead h2{margin:0;font-size:1.6rem;letter-spacing:-.01em;line-height:1.15}.chead p{margin:3px 0 0;opacity:.7;font-size:.93rem}
.cnum{flex:none;width:42px;height:42px;border-radius:13px;display:grid;place-items:center;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--ck-accent),#c76cf6 70%,var(--ck-gold));box-shadow:0 8px 20px -8px var(--ck-accent)}
.panel{border-radius:16px}.kpi{position:relative;overflow:hidden;border-radius:14px}.kpi::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--ck-accent),var(--ck-gold));opacity:.85}.kpi b{letter-spacing:-.02em}
.lb .lbr:nth-child(-n+3) .n{display:inline-grid;place-items:center;width:1.7em;height:1.7em;border-radius:50%;font-weight:800;color:#1c1400}.lb .lbr:nth-child(1) .n{background:#f0c14b}.lb .lbr:nth-child(2) .n{background:#c9d1d9}.lb .lbr:nth-child(3) .n{background:#d49a6a}
.sgrid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:12px;margin-top:10px}.scard{border:1px solid var(--ck-line);border-radius:14px;padding:12px;background:rgba(128,128,128,.07);min-width:0}.sch{display:flex;gap:10px;align-items:center;margin-bottom:8px;min-width:0}.sch>div{min-width:0}.sch b{display:block;overflow-wrap:anywhere}.sch small{opacity:.7;display:block}.sch .icons{max-width:55%}
.funnel{display:grid;gap:8px;margin:12px 0}.fn{display:grid;grid-template-columns:minmax(120px,190px) 1fr auto;gap:10px;align-items:center;min-width:0}.fn span{overflow-wrap:anywhere}.fn div{height:14px;border-radius:7px;background:rgba(128,128,128,.2);overflow:hidden}.fn i{display:block;height:100%;border-radius:7px}.fn em{font-style:normal;font-weight:700;white-space:nowrap}
.shield-note{margin:6px 0 0;padding:10px 12px;border-left:3px solid var(--ck-accent);border-radius:0 10px 10px 0;background:rgba(139,108,246,.1);font-size:.92rem}
#ck-top{position:fixed;right:16px;bottom:16px;z-index:40;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;text-decoration:none;color:#fff;font-size:1.2rem;background:linear-gradient(135deg,var(--ck-accent),#c76cf6);box-shadow:0 8px 22px -6px rgba(0,0,0,.5);opacity:0;pointer-events:none;transform:translateY(8px);transition:.2s}#ck-top.show{opacity:1;pointer-events:auto;transform:none}
@media (max-width:560px){.fn{grid-template-columns:1fr auto}.fn div{grid-column:1/-1;order:3}.chead h2{font-size:1.3rem}}
`;
function injectStyles() { if (document.getElementById('stats-extra-css')) return; const st = document.createElement('style'); st.id = 'stats-extra-css'; st.textContent = STYLES; document.head.append(st); }

// ---------- loading progress bar ----------
const prog = { cur: 0 };
function setProgress(p, label) {
  if (!document.getElementById('progfill')) $('out').innerHTML = '<div class="msg"><div class="prog"><div id="proglabel"></div><div class="progbar" id="progbar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i id="progfill"></i></div><em id="progpct"></em></div></div>';
  prog.cur = Math.max(0, Math.min(100, p));
  $('progfill').style.width = `${prog.cur.toFixed(1)}%`; $('progbar').setAttribute('aria-valuenow', Math.round(prog.cur)); $('progpct').textContent = `${Math.round(prog.cur)}%`;
  if (label) $('proglabel').textContent = label;
}

// ---------- hover tooltips for charts (mouse hover; tap on touch) ----------
let ttEl = null;
function ttShow(el, x, y) {
  if (!ttEl) { ttEl = document.createElement('div'); ttEl.className = 'army-tip'; ttEl.setAttribute('role', 'tooltip'); document.body.append(ttEl); }
  ttEl.textContent = el.dataset.tt; ttEl.hidden = false;
  const r = ttEl.getBoundingClientRect();
  ttEl.style.left = `${Math.max(6, Math.min(innerWidth - r.width - 6, x - r.width / 2))}px`;
  ttEl.style.top = `${y - r.height - 14 < 6 ? y + 16 : y - r.height - 14}px`;
}
const ttHide = () => { if (ttEl) ttEl.hidden = true; };
function initTips() {
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tt]'); if (el) ttShow(el, e.clientX, e.clientY); else ttHide();
  });
  document.addEventListener('click', (e) => { const el = e.target.closest?.('[data-tt]'); if (el && e.pointerType !== 'mouse') ttShow(el, e.clientX, e.clientY); else if (!el) ttHide(); });
  document.addEventListener('scroll', ttHide, true);
}

// ---------- page ----------
const state = { list: [], S: null, bucket: ALL, sort: 'used', dd: null, eod: null };
let loadId = 0;
function draw() {
  const { S } = state; if (!S) return;
  $('out').innerHTML = !S.G.players ? '<div class="msg">No battle data for this day yet.</div>'
    : buildPage([
      ['glance', 'At a glance', 'Totals, results and when everyone attacks — plus who sat the day out behind a shield.', overviewHTML(S) + shieldHTML(S)],
      ['charts', 'The day in charts', 'Stars, trophies and how army choices play out.', chartsHTML(S)],
      ['players', 'Placement &amp; leaderboards', 'Who climbed, who dropped and who played best.', placementHTML(S) + leaderboardsHTML(S)],
      ['armies', 'Armies &amp; strategies', 'What the best players bring, and who performs best with each strategy.', dukeHTML(S) + `<div id="armies">${armiesHTML(S, state.bucket, state.sort)}</div>`]], [['ch-strats', 'Top performers']]);
}
function drawArmies() { // only the armies block changes when the tabs are clicked
  const holder = document.getElementById('armies'); if (!holder) return draw();
  holder.innerHTML = armiesHTML(state.S, state.bucket, state.sort);
}
async function load(value) {
  const id = ++loadId; prog.cur = 0; $('out').innerHTML = ''; setProgress(2, 'Crunching the battle logs… finding the day');
  try {
    const idx = await getIndex(), back = value === 'live' ? 0 : Math.round((Date.parse(idx.live.dayStart) - Date.parse(value + 'T05:00:00Z')) / CONFIG.DAY) + 1;
    setProgress(6, 'Crunching the battle logs… downloading battles');
    let dd; const creep = setInterval(() => { if (prog.cur < 54) setProgress(prog.cur + (54 - prog.cur) * 0.07); }, 250); // download size is unknown: ease towards 54%
    try { dd = await getDayData(back); } finally { clearInterval(creep); }
    if (id !== loadId) return;
    setProgress(56, 'Crunching the battle logs… loading end-of-day ranks');
    const eod = await getEodInfo(dd.start).catch(() => null);
    if (id !== loadId) return;
    let prev = null;
    setProgress(63, 'Crunching the battle logs… comparing with the previous day');
    try { const dates = (await getMeta()).endOfDayDates || [], i = eod ? dates.indexOf(eod.date) : -1; if (i > 0) prev = await eodRanks(dates[i - 1]); } catch { /* optional */ }
    if (id !== loadId) return;
    setProgress(68, 'Crunching the battle logs… analysing attacks');
    const S = await computeStats(dd, eod && eod.ranks, prev, (f) => { if (id === loadId) setProgress(68 + 31 * f); }, () => id !== loadId);
    if (!S || id !== loadId) return;
    setProgress(100, 'Done');
    state.S = S; state.dd = dd; state.eod = eod;
    draw();
    const age = dd.generatedAt ? Math.max(0, Math.round((Date.now() - dd.generatedAt) / 60000)) : null;
    $('foot').innerHTML = `Legend Day ${new Date(dd.start).toISOString().slice(0, 10)} 05:00 UTC → ${new Date(dd.end).toISOString().slice(0, 10)} 05:00 UTC${age === null ? '' : ` · battle data ${age} min old`
      } · ${eod ? `ranks from the ${esc(eod.date)} reset` : 'no end-of-day ranks for this day'} · stats cover players the crawler tracks · ${BUILD} · icons by <a href="https://assets.clashk.ing" target="_blank" rel="noopener">ClashKing</a>`;
  } catch (e) { if (id === loadId) $('out').innerHTML = `<div class="msg">Couldn’t load stats: ${esc(e.message)}</div>`; }
}
async function initStats() {
  injectStyles(); initTips(); initNav();
  const sel = $('dsel');
  try {
    const idx = await getIndex(), dates = (idx.archives || []).map((a) => a.date).sort().reverse();
    const md = (d) => new Date(d + 'T05:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    sel.innerHTML = `<option value="live">Today (in progress)</option>` + dates.map((d) => `<option value="${d}">Day ended ${md(d)} 05:00 UTC</option>`).join('');
  } catch { sel.innerHTML = '<option value="live">Today (in progress)</option>'; }
  sel.onchange = () => load(sel.value);
  document.addEventListener('click', (e) => {
    const x = e.target.closest?.('.xbtn');
    if (x) { const open = x.closest('.xp').classList.toggle('open'); x.textContent = open ? 'Show less' : x.dataset.label; return; }
    const v = e.target.closest?.('.vbtn');
    if (v) {
      const box = document.getElementById('vars' + v.dataset.g), g = state.list[+v.dataset.g], open = v.getAttribute('aria-expanded') !== 'true';
      if (open && !box.innerHTML) box.innerHTML = variantsHTML(g);
      box.hidden = !open; box.style.display = open ? '' : 'none'; v.setAttribute('aria-expanded', open); v.textContent = `${open ? '▾' : '▸'} ${fmtN(g.vars.size)} variations`; return;
    }
    const b = e.target.closest?.('#bseg button, #sseg button'); if (!b) return;
    if (b.dataset.b != null) state.bucket = +b.dataset.b; if (b.dataset.s) state.sort = b.dataset.s;
    drawArmies();
  });
  load(sel.value);
}
