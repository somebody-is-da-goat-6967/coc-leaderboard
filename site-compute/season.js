// Season page: reads ONE file, season.json.gz (written by scanner/seasonAgg.mjs), and shows stats for the whole
// 28-day Legend season. Nothing else is downloaded. Debug: season.html?src=<url or path of a season.json.gz>
const SEASON_DAYS = 28;
const LB_MAX = 100; // rows a leaderboard shows when expanded (collapsed: 10)
const BUCKETS = [[1, 10, 'Top 10'], [11, 50, '11–50'], [51, 100, '51–100'], [101, 500, '101–500'], [501, 1000, '501–1,000'],
  [1001, 2500, '1,001–2,500'], [2501, 5000, '2,501–5,000'], [5001, 1e9, '5,001+']];
const ALL = BUCKETS.length; // "everyone" bucket (includes players without a rank)
const bucketName = (i) => (i === ALL ? 'Everyone' : BUCKETS[i][2]);
const iconOf = new Map(); // pet / equipment name -> icon path

const fmtN = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const avgOf = (a, b, d = 1) => (b ? fmtN(a / b, d) : '–');
const pctOf = (a, b) => (!b ? '–' : a > 0 && a / b < 0.001 ? '<0.1%' : `${fmtN((100 * a) / b, 1)}%`);
const tt = (s) => ` data-tt="${esc(s)}"`;
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);

// ---------- army grouping ----------
// Preferred armies are grouped by classified strategic core (see armyFamilyKey). Counts, support troops, heroes, pets,
// equipment, spells and siege variations stay together. similarKey remains for compact comparison keys.
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
const MIN_TROOP_SHARE = 0.10;
const CC_UNITS = 'i', CC_SPELLS = 'd';
const armyIds = (sec) => (sec || '').split('-').map((p) => p.split('x')[1]).filter(Boolean).map(Number);
const secOf = (code, re) => re.exec(code)?.[1] || '';
// Troop and siege ids overlap in the army link (e.g. 8 = Dragon and Battle Drill), so an id counts as a siege machine only when it is not a troop — same rule as the bot's armyDecoder.
const isSiegeId = (id) => !!ARMY_IDS.siege[id] && !ARMY_IDS.troop[id];
const secLetter = (code, l) => secOf(code, new RegExp(l + '([\\dx-]*)'));
const armyCounts = (sec) => (sec || '').split('-').map((p) => p.split('x')).filter((p) => p[1]).map(([n, id]) => [Number(id), Number(n) || 1]);
const sortedNums = (it) => [...new Set(it)].sort((x, y) => x - y);
const infoCache = new Map();
function similarKey(code) {
  const main = armyCounts(secOf(code, /u([\dx-]*)/)), cc = armyCounts(secLetter(code, CC_UNITS));
  const isSiege = isSiegeId;
  const nameOf = (id) => (ARMY_IDS.troop[id] || ARMY_IDS.siege[id] || [])[0];
  const cnt = new Map();
  for (const [id, n] of main) if (!isSiege(id)) cnt.set(id, (cnt.get(id) || 0) + n);
  const space = (id) => (TROOP_HOUSING[nameOf(id)] ?? null) === null ? null : TROOP_HOUSING[nameOf(id)] * cnt.get(id);
  let total = 0; for (const id of cnt.keys()) total += space(id) || 0;
  let troops = [...cnt.keys()].filter((id) => space(id) === null || space(id) >= MIN_TROOP_SHARE * total);
  if (!troops.length && cnt.size) troops = [[...cnt.keys()].sort((a, b) => space(b) - space(a))[0]];
  const siege = main.concat(cc).map(([id]) => id).filter(isSiege);
  const spells = armyIds(secOf(code, /s([\dx-]*)/)).concat(armyIds(secLetter(code, CC_SPELLS)));
  return sortedNums(troops).join(',') + '|' + sortedNums(spells).join(',') + '|' + sortedNums(siege).join(',');
}
// Group strategically similar army links together, so small recipe variations share a useful sample.
const armyFamilyCache = new Map();
function armyFamilyKey(core) {
  const raw = String(core || 'Mixed Army Smash').trim().toLowerCase();
  const family = /root rider/.test(raw) ? 'root riders'
    : /dragon rider/.test(raw) ? 'dragon riders'
    : /lava hound|\blalo\b/.test(raw) ? 'lalo'
    : /rocket balloon/.test(raw) ? 'rocket balloons'
    : /super bowler/.test(raw) ? 'super bowlers'
    : /super witch/.test(raw) ? 'super witches'
    : /super yeti/.test(raw) ? 'super yetis'
    : /super dragon/.test(raw) ? 'super dragons'
    : /meteor golem/.test(raw) ? 'meteor golems'
    : /thrower/.test(raw) ? 'throwers'
    : /hybrid/.test(raw) ? 'hybrid'
    : raw.replace(/\s+/g, ' ');
  return `family:${family}`;
}
function groupKey(code) {
  if (armyFamilyCache.has(code)) return armyFamilyCache.get(code);
  const heroes = decodeHeroes(code).map((h) => ({ name: heroNameOf(h), pet: h.pet?.name || null, equip: (h.equip || []).map((e) => e.name) }));
  const key = armyFamilyKey(classifyArmy(code, heroes).core); armyFamilyCache.set(code, key); return key;
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
  const u = armyIds(secOf(code, /u([\dx-]*)/)), s = armyIds(secOf(code, /s([\dx-]*)/));
  const pets = new Set(), eq = new Set();
  let duke = false;
  const heroes = [];
  for (const hh of decodeHeroes(code)) {
    try { if (DUKE_RE.test(JSON.stringify(hh))) duke = true; } catch { /* ignore */ }
    if (hh.pet) { pets.add(hh.pet.name); iconOf.set(hh.pet.name, hh.pet.icon); }
    for (const e of hh.equip) { eq.add(e.name); iconOf.set(e.name, e.icon); }
    const hn = heroNameOf(hh); if (hh.icon && !iconOf.has(hn)) iconOf.set(hn, hh.icon);
    heroes.push({ name: hn, pet: hh.pet ? hh.pet.name : null, equip: (hh.equip || []).map((e) => e.name) });
  }
  const cls = classifyArmy(code, heroes);
  c = { u, s, pets: [...pets], eq: [...eq], key: similarKey(code), group: armyFamilyKey(cls.core), siege: siegeOf(code), duke, heroes, cls };
  infoCache.set(code, c); return c;
}

// ---------- compute ----------
async function computeSeason(agg, onProgress = () => {}, cancelled = () => false) {
  const mk = () => ({ players: 0, na: 0, nd: 0, a: 0, d: 0, dy: 0, st: 0, s3: 0, dz: 0, ds: 0, withCode: 0,
    groups: new Map(), attCode: 0, duke: [0, 1].map(() => ({ n: 0, st: 0, s3: 0, t: 0 })), comp: new Map(), hero: new Map(), opener: new Map(), strat: new Map(), siege: new Map(), noSiege: { n: 0, st: 0, s3: 0 }, troop: new Map(), spell: new Map(), pet: new Map(), equip: new Map() });
  const B = Array.from({ length: ALL + 1 }, mk), rows = [];
  const players = Object.entries(agg.players || {}).filter(([, p]) => p.na || p.nd); let processed = 0;
  for (const [tag, p] of players) {
    const rank = p.r || 0, bi = rank ? BUCKETS.findIndex(([a, b]) => rank >= a && rank <= b) : -1;
    const targets = bi >= 0 ? [B[bi], B[ALL]] : [B[ALL]];
    rows.push({ tag, name: p.n, rank, r0: p.r0 || 0, delta: p.r0 && p.r ? p.r0 - p.r : 0, a: p.a, d: p.d, net: p.a - p.d, na: p.na, nd: p.nd,
      s3: p.s3, dz: p.dz, d3: p.d3, dy: p.dy, pf: p.pf, fu: p.fu });
    if (++processed % 50 === 0) {
      onProgress(processed / Math.max(1, players.length));
      await nextFrame();
      if (cancelled()) return null;
    }
    for (const t of targets) { t.players++; t.na += p.na; t.nd += p.nd; t.a += p.a; t.d += p.d; t.dy += p.dy; t.st += p.st; t.s3 += p.s3; t.dz += p.dz; t.ds += p.ds; }
    // Per-attack stats by army ingredient: every army the player used this season counts (not just their favourite).
    // Siege machines, troops, spells, pets, equipment and Duke vs no Duke. A machine is counted once per attack.
    for (const [ci, v] of Object.entries(p.arm || {})) {
      const c = agg.codes[+ci]; if (!c) continue;
      const inf = infoOf(c), parts = inf.key.split('|').map((x) => (x ? x.split(',') : []));
      const ids = [...parts[0], ...parts[2]].map((x) => 't' + x).concat(parts[1].map((x) => 's' + x), inf.pets.map((x) => 'p' + x), inf.eq.map((x) => 'e' + x));
      for (const t of targets) {
        t.attCode += v[0];
        const dk = t.duke[inf.duke ? 1 : 0]; dk.n += v[0]; dk.st += v[1]; dk.s3 += v[2]; dk.t += v[3];
        for (const id of ids) { let x = t.comp.get(id); if (!x) t.comp.set(id, (x = { n: 0, s3: 0, st: 0 })); x.n += v[0]; x.st += v[1]; x.s3 += v[2]; }
        if (inf.siege.length) for (const id of inf.siege) { let x = t.siege.get(id); if (!x) t.siege.set(id, (x = { n: 0, st: 0, s3: 0 })); x.n += v[0]; x.st += v[1]; x.s3 += v[2]; }
        else { t.noSiege.n += v[0]; t.noSiege.st += v[1]; t.noSiege.s3 += v[2]; }
        tallyArmyStats(t, inf, c, v[0], v[1], v[2]); noteStratPlayer(t, inf, tag, p.n, p.r || 0, v[0], v[1], v[2], v[3]);
      }
    }
    // ONE army per player: the one they used most all season (ties: more stars).
    let best = null, bci = -1;
    for (const [ci, v] of Object.entries(p.arm || {})) if (!best || v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) { best = v; bci = +ci; }
    const code = best && agg.codes[bci]; if (!code) continue;
    const info = infoOf(code);
    for (const t of targets) {
      t.withCode++;
      let g = t.groups.get(info.group); if (!g) t.groups.set(info.group, (g = { players: 0, uses: 0, st: 0, s3: 0, t: 0, dur: 0, vars: new Map() }));
      g.players++; g.uses += best[0]; g.st += best[1]; g.s3 += best[2]; g.t += best[3]; g.dur += best[4];
      let v = g.vars.get(bci); if (!v) g.vars.set(bci, (v = { code, players: 0, uses: 0, st: 0, s3: 0, t: 0, dur: 0 }));
      v.players++; v.uses += best[0]; v.st += best[1]; v.s3 += best[2]; v.t += best[3]; v.dur += best[4];
      info.u.forEach((x) => inc(t.troop, x)); info.s.forEach((x) => inc(t.spell, x));
      info.pets.forEach((x) => inc(t.pet, x)); info.eq.forEach((x) => inc(t.equip, x));
    }
  }
  onProgress(1);
  return { agg, G: agg.G, B, rows, fast: agg.fast || [], upsets: agg.upsets || [] };
}

// ---------- rendering ----------
const who = (tag, name, rank) => `<span class="who"><a class="pl" href="player.html?tag=${esc(normTag(tag))}">${esc(name)}</a>${rank ? `<small class="eod">last: #${fmtN(rank)}</small>` : ''}${cardLink(tag)}</span>`;
const tieRank = (r) => r || 1e9;
const inRankPool = (rows) => state.rankScope ? rows.filter((r) => r.rank > 0 && r.rank <= state.rankScope) : rows;
const topN = (arr, cmp, n = state.lbLimit || LB_MAX) => [...arr].sort((a, b) => state.boardOrder === 'rank' ? (a.rank || 1e9) - (b.rank || 1e9) || cmp(a, b) : cmp(a, b)).slice(0, n);
const monthDay = (d) => new Date(d + 'T05:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const kpi = (label, value, sub, c = '') => `<div class="kpi"><small>${label}</small><b class="${c}">${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
const expandBtn = (n, what, min = 10) => (n > min ? `<button class="btn xbtn" data-label="Show ${what} (${n})">Show ${what} (${n})</button>` : '');

function lb(title, note, list) {
  return `<section class="panel xp"><h3>${title}</h3>${note ? `<p class="sub">${note}</p>` : ''}<div class="lb">${list.length ? list.map((r, i) => `
    <div class="lbr${i >= 10 ? ' more' : ''}"><span class="n">${i + 1}</span>${r.html || who(r.tag, r.name, r.rank)}<b class="${r.cls || ''}">${r.val}</b><small class="ex">${r.ex || ''}</small></div>`).join('')
    : '<div class="msg">Not enough data yet.</div>'}</div>${expandBtn(list.length, 'all')}</section>`;
}
function leaderboardLimitHTML() {
  const options = [10, 100, 1000, 5000, 10000];
  return `<div class="lb-controls"><label class="lb-limit">Global player pool <select id="rank-scope" aria-label="Choose global rank cohort"><option value="0"${state.rankScope === 0 ? ' selected' : ''}>All tracked players</option>${options.map((n) => `<option value="${n}"${state.rankScope === n ? ' selected' : ''}>Global top ${fmtN(n)}</option>`).join('')}</select></label><label class="lb-limit">Show top <select id="lb-limit" aria-label="Number of results in each metric leaderboard">${options.map((n) => `<option value="${n}"${state.lbLimit === n ? ' selected' : ''}>${fmtN(n)}</option>`).join('')}</select> results per leaderboard</label><label class="lb-limit">Order by <select id="lb-order" aria-label="Sort metric leaderboards by">${[['metric', 'Leaderboard stat'], ['rank', 'End-of-day rank']].map(([v, label]) => `<option value="${v}"${state.boardOrder === v ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div>`;
}
function overviewHTML(S) {
  const { G } = S, sum = (a) => a.reduce((x, y) => x + y, 0), players = S.rows.length;
  const starBars = (a, label, color) => `<div class="starbars"><h4>${label}</h4>${a.map((n, s) =>
    `<div class="sb"${tt(`${s}★ · ${fmtN(n)} ${label.startsWith('Attack') ? 'attacks' : 'defenses'} (${pctOf(n, sum(a))})`)}><span>${s}★</span><i style="width:${(100 * n / (sum(a) || 1)).toFixed(1)}%;background:${color[s]}"></i></div>`).join('')}</div>`;
  const hrs = Array.from({ length: 24 }, (_, i) => (5 + i) % 24), mx = Math.max(1, ...G.hours);
  const pad = (h) => String(h).padStart(2, '0');
  return `<section class="panel"><h3>Season overview</h3><div class="kpis">
    ${kpi('Players with battles', fmtN(players), `${fmtN(G.full)} player-days with all 8 attacks`)}
    ${kpi('Attacks', fmtN(G.att), `${fmtN(G.def)} defenses logged`)}
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
  <div class="hours">${hrs.map((h) => `<div class="hcol"${tt(`${pad(h)}:00–${pad((h + 1) % 24)}:00 UTC · ${fmtN(G.hours[h])} attacks (${pctOf(G.hours[h], G.att)})`)}><i style="height:${(100 * G.hours[h] / mx).toFixed(1)}%"></i></div>`).join('')}</div></section>`;
}
function seasonRecapHTML() {
  return `<section class="panel"><h3>Whole-season recap image</h3><p class="sub">A shareable image of the selected season, with its top openers, armies and player records.</p>
    <canvas id="srcv" width="1080" height="1460" aria-label="Whole-season recap image" style="display:block;width:100%;height:auto;border-radius:18px"></canvas>
    <div class="controls"><button class="btn" id="srdl" disabled>⬇ Download PNG</button><button class="btn" id="srcopy" disabled>Copy image</button></div><p class="sub" id="srmsg"></p></section>`;
}

// ---- per-day trend charts (dayStats) ----
function barChart(ds, val, label, unit) {
  const mx = Math.max(1, ...ds.map(val));
  return `<div class="chart"><h4>${label}</h4><div class="hours d28">${ds.map((d) => `<div class="hcol"${tt(`${monthDay(d.date)} · ${fmtN(val(d))} ${unit}`)}><i style="height:${(100 * val(d) / mx).toFixed(1)}%"></i></div>`).join('')}</div></div>`;
}
function lineChart(ds, val, label, fmtv, unit) {
  const W = 360, H = 150, L = 38, R = 8, T = 10, Bm = 20, v = ds.map(val);
  if (!v.length) return '';
  let lo = Math.min(...v), hi = Math.max(...v); const span = hi - lo || Math.max(1, hi * 0.1);
  lo = Math.max(0, lo - span * 0.2); hi += span * 0.2;
  const x = (i) => L + (ds.length < 2 ? (W - L - R) / 2 : (i * (W - L - R)) / (ds.length - 1)), y = (n) => T + (H - T - Bm) * (1 - (n - lo) / (hi - lo));
  const grid = [0, 1, 2].map((k) => { const n = lo + ((hi - lo) * k) / 2; return `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(n)}" y2="${y(n)}"/><text x="${L - 4}" y="${y(n) + 3}" text-anchor="end">${fmtv(n)}</text>`; }).join('');
  const xl = ds.map((d, i) => (i % 7 === 0 || i === ds.length - 1 ? `<text x="${x(i)}" y="${H - 5}" text-anchor="middle">${monthDay(d.date)}</text>` : '')).join('');
  const pts = ds.map((d, i) => `<g class="pt"${tt(`${monthDay(d.date)} · ${fmtv(v[i])} ${unit}`)}><circle class="zone" cx="${x(i)}" cy="${y(v[i])}" r="9"/><circle class="dot" cx="${x(i)}" cy="${y(v[i])}" r="4"/></g>`).join('');
  return `<div class="chart"><h4>${label}</h4><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${xl}<polyline class="ln" points="${v.map((n, i) => `${x(i)},${y(n)}`).join(' ')}"/>${pts}</svg></div>`;
}
const shieldKey = (S) => 'shieldHist:' + (S.agg.season || '');
function shieldHist(S) { if (state.shieldHist && state.shieldHist.key === shieldKey(S)) return state.shieldHist.data; try { const v = JSON.parse(sessionStorage.getItem(shieldKey(S)) || 'null'); if (v) { state.shieldHist = { key: shieldKey(S), data: v }; return v; } } catch { /* no cache */ } return null; }
async function loadShieldHistory(S) { // ranked players per Legend Day, from the end-of-day leaderboards (3 at a time)
  const key = shieldKey(S);
  if (shieldHist(S) || state.shieldLoading.has(key)) return;
  state.shieldLoading.add(key);
  const ds = (S.agg.dayStats || []).map((d) => d.date), data = {}; let done = 0, i = 0;
  const msg = (t) => { const el = state.S === S ? document.getElementById('shmsg') : null; if (el) el.textContent = t; };
  const button = document.getElementById('shload'); if (button) { button.disabled = true; button.textContent = 'Loading shield history…'; }
  msg(`Loading end-of-day leaderboards… 0/${ds.length}`);
  if (typeof getEodInfo !== 'function') { state.shieldLoading.delete(key); return msg('The rank loader isn’t available on this page.'); }
  const worker = async () => { while (i < ds.length) { const date = ds[i++]; try { const info = await getEodInfo(Date.parse(date + 'T05:00:00Z')); if (info && info.ranks) data[date] = info.ranks.size; } catch { /* day without ranks */ } msg(`Loading leaderboards… ${++done}/${ds.length}`); } };
  await Promise.all([worker(), worker(), worker()]);
  state.shieldHist = { key, data }; try { sessionStorage.setItem(key, JSON.stringify(data)); } catch { /* ignore */ }
  state.shieldLoading.delete(key);
  if (state.S === S) draw();
}
function shieldSeasonHTML(S) {
  const ds = (S.agg.dayStats || []).slice().sort((a, b) => new Date(a.date + 'T05:00:00Z') - new Date(b.date + 'T05:00:00Z'));
  if (!ds.length) return '';
  const hist = shieldHist(S), hasHist = hist && ds.some((d) => hist[d.date] != null);
  const rows = ds.map((d) => { const ranked = hasHist ? hist[d.date] : null, played = d.players || 0; const sh = ranked != null ? Math.max(0, ranked - played) : d.shield; return { date: d.date, ranked, played, sh, base: ranked != null ? ranked : played + (d.shield || 0) }; }).filter((x) => x.sh != null);
  const any = rows.some((x) => x.sh > 0);
  const loading = state.shieldLoading.has(shieldKey(S));
  const btn = hasHist ? '' : `<div class="pbtns"><button class="btn" id="shload"${loading ? ' disabled' : ''}>${loading ? 'Loading shield history…' : 'Retry shield history'}</button><span class="sub" id="shmsg">${loading ? 'Loading end-of-day leaderboards…' : `Reads the end-of-day leaderboard for each Legend Day (${ds.length} files).`}</span></div>`;
  if (!any) return `<section class="panel"><h3>Shield watch</h3><p class="shield-note">The crawler’s daily files don’t list shielded players (they only store players who battled), so day-by-day shields are worked out from the leaderboards: ranked players minus players with a Legend battle that day.</p>${btn}</section>`;
  const tot = rows.reduce((x, d) => x + d.sh, 0), base = rows.reduce((x, d) => x + d.base, 0);
  const hi = rows.reduce((m, d) => (d.sh > m.sh ? d : m), rows[0]), lo = rows.reduce((m, d) => (d.sh < m.sh ? d : m), rows[0]);
  const rate2 = (d) => (d.base ? (100 * d.sh) / d.base : 0);
  return `<section class="panel"><h3>Shield watch</h3><div class="kpis">
    ${kpi('Avg shielded per day', fmtN(tot / rows.length), `${pctOf(tot, base)} of ranked players`)}
    ${kpi('Most shielded', fmtN(hi.sh), monthDay(hi.date), 'neg')}
    ${kpi('Fewest shielded', fmtN(lo.sh), monthDay(lo.date), 'pos')}
    ${kpi('Shield-days', fmtN(tot), `across ${rows.length} Legend Day${rows.length === 1 ? '' : 's'}`)}</div>${btn}
    <div class="charts">${barChart(rows, (d) => d.sh, 'Shielded players per day', 'players with a shield')}${lineChart(rows, rate2, 'Share of ranked players with a shield', (n) => `${fmtN(n, 1)}%`, 'shielded')}</div>
    <div class="scroll"><table class="tbl"><thead><tr><th>Legend Day</th><th>Ranked</th><th>Battled</th><th>Shielded</th><th>Share</th></tr></thead><tbody>${rows.slice().reverse().map((d) => `<tr><td>${monthDay(d.date)}</td><td>${d.ranked != null ? fmtN(d.ranked) : '–'}</td><td>${fmtN(d.played)}</td><td><b>${fmtN(d.sh)}</b></td><td>${pctOf(d.sh, d.base)}</td></tr>`).join('')}</tbody></table></div>
    <p class="shield-note">A Legend shield means no Legend League battles that day: shielded players can still attack and be attacked in normal mode, which isn’t tracked here. Shielded = on that day’s end-of-day leaderboard but with no Legend battle at all (ranked players − players who battled). The daily stats page applies the timed 06:30 UTC check on top.</p></section>`;
}
function trendHTML(S) {
  const ds = [...(S.agg.dayStats || [])].sort((a, b) => new Date(a.date + 'T05:00:00Z') - new Date(b.date + 'T05:00:00Z'));
  if (!ds.length) return '';
  return `<section class="panel"><h3>Day by day</h3><p class="sub">One point per finished Legend Day (labelled by the date of the 05:00 UTC reset that closed it).</p><div class="charts">
    ${barChart(ds, (d) => d.att, 'Attacks per day', 'attacks')}
    ${lineChart(ds, (d) => (d.att ? (100 * d.a3) / d.att : 0), '3★ rate per day', (n) => `${fmtN(n, 1)}%`, '3★ attacks')}
    ${lineChart(ds, (d) => (d.att ? d.aT / d.att : 0), 'Avg trophies per attack', (n) => `+${fmtN(n, 1)}`, 'per attack')}
    ${barChart(ds, (d) => d.players, 'Players with battles per day', 'players')}
    ${barChart(ds, (d) => d.perfect, 'Perfect days (8 × 3★) per day', 'perfect players')}
    ${lineChart(ds, (d) => (d.def ? d.dT / d.def : 0), 'Avg trophies lost per defense', (n) => `−${fmtN(n, 1)}`, 'per defense')}
  </div></section>`;
}

function placementHTML(S) {
  const line = (i) => { const t = S.B[i];
    return `<tr><td>${bucketName(i)}</td><td>${fmtN(t.players)}</td><td class="pos">+${avgOf(t.a, t.na)}</td><td class="neg">−${avgOf(t.d, t.nd)}</td>
    <td class="${t.a - t.d >= 0 ? 'pos' : 'neg'}">${t.dy ? fmt(Math.round((t.a - t.d) / t.dy)) : '–'}</td><td>${avgOf(t.st, t.na, 2)}</td><td>${pctOf(t.s3, t.na)}</td><td>${pctOf(t.dz, t.nd)}</td><td>${pctOf(t.ds, t.nd)}</td></tr>`;
  };
  return `<section class="panel"><h3>By ranking placement</h3><p class="sub">Players grouped by their rank at the last end-of-day snapshot they appear in. “Net” is trophies gained minus lost per day.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Rank</th><th>Players</th><th>Avg attack</th><th>Avg defense</th><th>Avg net / day</th><th>★ / attack</th><th>3★ attacks</th><th>0★ defense</th><th>Avg 3★ / defense</th></tr></thead>
    <tbody>${[...BUCKETS.keys()].map(line).join('')}${line(ALL)}</tbody></table></div></section>`;
}

function leaderboardsHTML(S) {
  const R = inRankPool(S.rows), fastRows = inRankPool(S.fast), upsetRows = inRankPool(S.upsets), rk = (a, b) => tieRank(a.rank) - tieRank(b.rank);
  const scopeNote = state.rankScope ? `Metric lists are limited to players in the global top ${fmtN(state.rankScope)} by their last available end-of-day rank this season, then ranked by each stat.` : 'Choose a global rank pool to limit each stat leaderboard to those players.';
  const offense = topN(R, (a, b) => b.a - a.a || rk(a, b)).map((r) => ({ ...r, val: `+${fmtN(r.a)}`, cls: 'pos', ex: `+${avgOf(r.a, r.na, 2)} per attack · ${fmtN(r.na)} attacks · ${fmtN(r.s3)}×3★ · ${r.dy} days` }));
  const avgAtk = topN(R.filter((r) => r.na >= 8), (a, b) => b.a / b.na - a.a / a.na || rk(a, b)).map((r) => ({ ...r, val: `+${avgOf(r.a, r.na, 2)}`, cls: 'pos', ex: `per attack · ${fmtN(r.na)} attacks` }));
  const defense = topN(R.filter((r) => r.nd >= 8), (a, b) => a.d / a.nd - b.d / b.nd || rk(a, b)).map((r) => ({ ...r, val: `−${avgOf(r.d, r.nd, 2)}`, cls: 'neg', ex: `per defense · ${fmtN(r.nd)} defenses` }));
  const zero = topN(R, (a, b) => b.dz - a.dz || b.nd - a.nd || rk(a, b)).map((r) => ({ ...r, val: `${fmtN(r.dz)}×0★`, ex: `${fmtN(r.nd)} defenses · −${fmtN(r.d)}` }));
  const net = topN(R, (a, b) => b.net - a.net || rk(a, b)).map((r) => ({ ...r, val: fmt(r.net), cls: cls(r.net), ex: `+${fmtN(r.a)} / −${fmtN(r.d)}` }));
  const tri = topN(R, (a, b) => b.s3 - a.s3 || rk(a, b)).map((r) => ({ ...r, val: `${fmtN(r.s3)}×3★`, ex: `${fmtN(r.na)} attacks (${pctOf(r.s3, r.na)})` }));
  const perfect = topN(R.filter((r) => r.pf > 0), (a, b) => b.pf - a.pf || rk(a, b)).map((r) => ({ ...r, val: `${r.pf} days`, cls: 'pos', ex: `8 attacks, all 3★ · ${r.fu} days with 8 attacks` }));
  const rate = topN(R.filter((r) => r.na >= 8), (a, b) => b.s3 / b.na - a.s3 / a.na || rk(a, b)).map((r) => ({ ...r, val: pctOf(r.s3, r.na), ex: `${fmtN(r.s3)}×3★ of ${fmtN(r.na)} attacks` }));
  const mv = (r) => ({ ...r, val: `${r.delta > 0 ? '▲' : '▼'} ${fmtN(Math.abs(r.delta))}`, cls: r.delta > 0 ? 'pos' : 'neg', ex: `#${fmtN(r.r0)} → #${fmtN(r.rank)} · net ${fmt(r.net)}` });
  const moved = R.filter((r) => r.delta && Math.min(r.rank, r.r0) <= 2500);
  const climbers = topN(moved, (a, b) => b.delta - a.delta).map(mv), drops = topN(moved, (a, b) => a.delta - b.delta).map(mv);
  const climbNote = 'Rank at their first end of day this season → their last, for players in the top 2,500 on either';
  const fastest = topN(fastRows, (a, b) => a.time - b.time || rk(a, b)).map((r) => ({ ...r, val: dur(r.time), ex: `${r.pct}% vs ${esc(r.opp)} · ${r.date ? monthDay(r.date) : ''}` }));
  const up = topN(upsetRows, (a, b) => (b.rank - b.oppRank) - (a.rank - a.oppRank)).map((r) => ({ ...r, val: `+${fmtN(r.rank - r.oppRank)}`, ex: `3★ vs ${esc(r.opp)} (eod #${r.oppRank}) · ${r.date ? monthDay(r.date) : ''}` }));
  return `<div id="leaderboards"><h2 class="sh">Season leaderboards</h2>${leaderboardLimitHTML()}<p class="sub">${scopeNote}</p><div class="lbs xl">
    ${lb('Top offense', 'Most total trophies gained from attacks all season', offense)}
    ${lb('Highest avg attack', 'Most trophies gained per attack (8+ attacks)', avgAtk)}
    ${lb('Lowest avg defense', 'Fewest trophies lost per defense (8+ defenses)', defense)}
    ${lb('Best net', 'Attack trophies minus defense trophies', net)}
    ${lb('Most 3★ attacks', 'Triples landed over the season', tri)}
    ${lb('Best 3★ rate', 'Share of attacks that were triples (8+ attacks)', rate)}
    ${lb('Perfect days', 'Days with 8 attacks, all 3★', perfect)}
    ${lb('Most 0★ defenses', 'Attackers who got no stars at all', zero)}
    ${lb('Biggest climbers', climbNote, climbers)}
    ${lb('Biggest drops', climbNote, drops)}
    ${lb('Fastest 3★ attacks', 'Shortest battles that ended in a triple', fastest)}
    ${lb('Giant killers', '3★ attacks on a top-100 defender, biggest rank gap first (value = places between them)', up)}
  </div></div>`;
}

// ---- armies ----
function bucketTabs(sel) {
  return `<div class="seg wrapseg" id="bseg" role="group" aria-label="Rank placement">${[...BUCKETS.keys(), ALL].map((i) =>
    `<button data-b="${i}" aria-pressed="${i === sel}">${bucketName(i)}</button>`).join('')}</div>`;
}
const SORTS = { used: 'Most players', s3: 'Best 3★ rate', trophies: 'Best avg trophies' };
const ARMY_SHOW = 6, ARMY_MAX = 30, VAR_MAX = 40;
function groupList(t, sort) {
  const minP = sort === 'used' ? 1 : Math.max(2, Math.min(5, Math.round(t.withCode / 100)));
  const val = { used: (g) => g.players, s3: (g) => g.s3 / g.uses, trophies: (g) => g.t / g.uses }[sort];
  return [...t.groups.values()].filter((g) => g.players >= minP && g.uses >= (sort === 'used' ? 1 : 8))
    .sort((a, b) => val(b) - val(a) || b.players - a.players || b.uses - a.uses).slice(0, ARMY_MAX);
}
const statsLine = (g) => `<span>★ ${avgOf(g.st, g.uses, 2)}</span><span>3★ ${pctOf(g.s3, g.uses)}</span><span class="pos">+${avgOf(g.t, g.uses)}</span><span>${g.uses ? dur(Math.round(g.dur / g.uses)) : '–'}</span>`;
const repOf = (g) => [...g.vars.values()].sort((a, b) => b.players - a.players || b.uses - a.uses)[0];
function armiesHTML(S, sel, sort) {
  const t = S.B[sel], list = groupList(t, sort); state.list = list;
  const cards = list.map((g, i) => { const rep = repOf(g), family = infoOf(rep.code).cls.core || infoOf(rep.code).cls.strategy || 'Army family'; return `<div class="acard${i >= ARMY_SHOW ? ' more' : ''}"><div class="ah"><b>#${i + 1}</b><span><em>${fmtN(g.players)}</em> player${g.players === 1 ? '' : 's'} · ${fmtN(g.uses)} attack${g.uses === 1 ? '' : 's'}</span></div>
      <div class="army-family">${esc(family)}</div><div class="am">${statsLine(g)}</div>${ckArmy(rep.code)}
      ${g.vars.size > 1 ? `<button class="btn vbtn" data-g="${i}" aria-expanded="false">▸ ${fmtN(g.vars.size)} variations</button>` : '<small class="sub">Only one version used</small>'}
      <div class="vars" id="vars${i}"></div></div>`; }).join('');
  return `<h2 class="sh">Top armies by placement</h2><section class="panel">
    <div class="controls">${bucketTabs(sel)}<div class="seg" id="sseg" role="group" aria-label="Sort armies">${Object.entries(SORTS).map(([k, v]) =>
      `<button data-s="${k}" aria-pressed="${k === sort}">${v}</button>`).join('')}</div></div>
    <p class="sub">${fmtN(t.withCode)} ${bucketName(sel)} players, one preferred army family each. Similar troop recipes are grouped by strategic core; counts, support troops, siege, spells, heroes, pets and equipment variations stay together.</p>
    <div class="xp"><div class="acards">${cards || '<div class="msg">Not enough armies in this group yet.</div>'}</div>${expandBtn(list.length, 'more armies', ARMY_SHOW)}</div>
    ${metaHTML(t)}${compHTML(t)}${siegeHTML(t)}${heroHTML(t, t.attCode)}${openerHTML(t, t.attCode)}</section>${strategyTopHTML(t, 12)}`;
}
function siegeHTML(t) {
  const base = t.attCode, ns = t.noSiege, minN = Math.max(10, Math.round(base * 0.01));
  const list = [...t.siege].map(([id, v]) => ({ id, ...v }));
  if (!list.length) return '';
  const nm = (id) => ARMY_IDS.siege[id] || [`#${id}`, ''];
  const used = [...list].sort((a, b) => b.n - a.n || b.s3 - a.s3);
  const best = list.filter((r) => r.n >= minN).sort((a, b) => rate(b.s3, b.n) - rate(a.s3, a.n) || b.n - a.n);
  const col = (title, arr, text) => `<div class="mcol xp"><h4>${title}</h4><div class="mlist">${arr.map((r, i) => { const [name, icon] = nm(r.id);
    return `<div class="mrow${i >= 10 ? ' more' : ''}"${tt(`${name} · ${pctOf(r.n, base)} of attacks · ${pctOf(r.s3, r.n)} 3★ · ${avgOf(r.st, r.n, 2)} ★ · ${fmtN(r.n)} attacks`)}>${ckTile('troop', name, icon)}<span class="mn">${esc(name)}</span><span class="mc">${text(r)}</span></div>`; }).join('') || '<div class="msg">–</div>'}</div>${expandBtn(arr.length, 'all')}</div>`;
  return `<h4 class="mh">Siege machines <small>(per attack; main army and Clan Castle count the same, a machine is counted once per attack)</small></h4><div class="kpis">
    ${kpi('Most used siege', esc(nm(used[0].id)[0]), `${pctOf(used[0].n, base)} of attacks`)}
    ${best[0] ? kpi('Highest 3★ rate', esc(nm(best[0].id)[0]), `${pctOf(best[0].s3, best[0].n)} 3★ · ${fmtN(best[0].n)} attacks`) : ''}
    ${kpi('No siege machine', pctOf(ns.s3, ns.n), `3★ rate · ${fmtN(ns.n)} attacks`)}</div>
  <div class="meta4">${col('Most used', used, (r) => pctOf(r.n, base))}${col('Highest 3★ rate', best, (r) => pctOf(r.s3, r.n))}</div>
  <p class="sub">The 3★ list needs at least ${fmtN(minN)} attacks with the machine.</p>`;
}
// ---------- extra stats (same as the daily stats page): Dragon Duke, charts, ingredient performance ----------
const GREEN = '#1a8f4c', RED = '#c2362f', GOLD = '#e0a526', GREY = '#8a9a9c';
const rate = (a, b) => (b ? (100 * a) / b : 0);
const pp = (x) => `${x >= 0 ? '+' : '−'}${fmtN(Math.abs(x), 1)} pp`;
function vcols(items, max) { // vertical bar chart; each item: { label, top, segs: [[value, color]...], tt }
  const mx = max || Math.max(1, ...items.map((it) => it.segs.reduce((a, s) => a + s[0], 0)));
  return `<div class="vc">${items.map((it) => `<div class="vcc" data-tt="${esc(it.tt)}"><small>${it.top ?? ''}</small><div class="vcb">${it.segs.map(([v, c]) =>
    `<i style="height:${Math.min(100, (100 * v) / mx).toFixed(1)}%;background:${c}"></i>`).join('')}</div><span>${it.label}</span></div>`).join('')}</div>`;
}
const hbars = (items) => items.map((it) => `<div class="hb" data-tt="${esc(it.tt)}"><span>${it.label}</span><div><i style="width:${Math.min(100, it.v).toFixed(1)}%"></i></div><em>${it.text}</em></div>`).join('');

function dukeHTML(S) {
  const rows = [...BUCKETS.keys(), ALL].map((i) => { const [no, yes] = S.B[i].duke; return { i, no, yes }; }), A = rows[rows.length - 1];
  if (!A.yes.n) return `<section class="panel"><h3>Dragon Duke</h3><p class="sub">No attacks with the Dragon Duke found among ${fmtN(A.no.n)} attacks that have an army link. If you expect some, check that the hero decodes with “Duke” in its name (DUKE_RE in season.js).</p></section>`;
  const r3 = (x) => rate(x.s3, x.n), diff = (y, n) => (y.n && n.n ? pp(r3(y) - r3(n)) : '–');
  const cls2 = (y, n) => (y.n && n.n ? (r3(y) >= r3(n) ? 'pos' : 'neg') : '');
  const line = ({ i, no, yes }) => `<tr><td>${bucketName(i)}</td><td>${pctOf(yes.n, yes.n + no.n)} <small>(${fmtN(yes.n)})</small></td><td>${pctOf(yes.s3, yes.n)}</td><td>${pctOf(no.s3, no.n)}</td>
    <td class="${cls2(yes, no)}">${diff(yes, no)}</td><td>${avgOf(yes.st, yes.n, 2)}</td><td>${avgOf(no.st, no.n, 2)}</td><td>+${avgOf(yes.t, yes.n)}</td><td>+${avgOf(no.t, no.n)}</td></tr>`;
  const pairs = rows.filter((r) => r.yes.n >= 5 && r.no.n >= 5).map((r) => `<div class="hb2"${tt(`${bucketName(r.i)} · with Duke ${pctOf(r.yes.s3, r.yes.n)} (${fmtN(r.yes.n)} attacks) · without ${pctOf(r.no.s3, r.no.n)} (${fmtN(r.no.n)} attacks)`)}><span>${bucketName(r.i)}</span>
    <div class="bw"><div class="a"><i style="width:${r3(r.yes).toFixed(1)}%"></i></div><div class="b"><i style="width:${r3(r.no).toFixed(1)}%"></i></div></div><em>${fmtN(r3(r.yes), 1)}% vs ${fmtN(r3(r.no), 1)}%</em></div>`).join('');
  return `<section class="panel"><h3>Dragon Duke vs no Duke</h3><div class="kpis">
    ${kpi('Duke usage', pctOf(A.yes.n, A.yes.n + A.no.n), `${fmtN(A.yes.n)} of ${fmtN(A.yes.n + A.no.n)} attacks`)}
    ${kpi('3★ with Duke', pctOf(A.yes.s3, A.yes.n), `${avgOf(A.yes.st, A.yes.n, 2)} ★ per attack`, 'pos')}
    ${kpi('3★ without Duke', pctOf(A.no.s3, A.no.n), `${avgOf(A.no.st, A.no.n, 2)} ★ per attack`)}
    ${kpi('Difference', diff(A.yes, A.no), 'in 3★ rate (percentage points)', cls2(A.yes, A.no))}</div>
    <p class="sub">Per attack over the whole season, using the army link of each attack (attacks without an army link are left out). Players who pick the Duke may simply be better players, so this shows what happened, not what the Duke causes.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>Rank</th><th>Duke usage</th><th>3★ with</th><th>3★ without</th><th>Difference</th><th>★ with</th><th>★ without</th><th>Trophies with</th><th>Trophies without</th></tr></thead>
    <tbody>${rows.map(line).join('')}</tbody></table></div>
    ${pairs ? `<h4>3★ rate by placement <small class="lg"><i class="a"></i>with Duke <i class="b"></i>without Duke</small></h4>${pairs}` : ''}</section>`;
}

// Charts need the season file's G to carry the same arrays as a day's stats (hours3, dur6, nth, vsB, net). Each chart only shows when its data is there.
function chartsHTML(S) {
  const { G } = S, pad = (h) => String(h).padStart(2, '0'), hrs = Array.from({ length: 24 }, (_, i) => (5 + i) % 24);
  const t30 = (i) => `${Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`;
  const has = (a) => Array.isArray(a) && a.length;
  const hourly = has(G.hours) && has(G.hours3) ? vcols(hrs.map((h) => ({ label: h, top: G.hours[h] ? Math.round(rate(G.hours3[h], G.hours[h])) : '', segs: [[rate(G.hours3[h], G.hours[h]), GREEN]],
    tt: `${pad(h)}:00–${pad((h + 1) % 24)}:00 UTC · ${pctOf(G.hours3[h], G.hours[h])} 3★ (${fmtN(G.hours3[h])} of ${fmtN(G.hours[h])} attacks)` }))) : '';
  const lens = has(G.dur6) ? vcols(G.dur6.map((v, i) => ({ label: t30(i), top: v[0] + v[1] ? fmtN(v[0] + v[1]) : '', segs: [[v[0], GREEN], [v[1], GREY]],
    tt: `${t30(i)}–${t30(i + 1)} · ${fmtN(v[0] + v[1])} battles, ${fmtN(v[0])} were 3★ (${pctOf(v[0], v[0] + v[1])})` }))) : '';
  const nth = has(G.nth) ? vcols(G.nth.map((v, i) => ({ label: `#${i + 1}`, top: v.n ? Math.round(rate(v.s3, v.n)) : '', segs: [[rate(v.s3, v.n), GOLD]],
    tt: `Attack #${i + 1} of the day · ${pctOf(v.s3, v.n)} 3★ · ${avgOf(v.st, v.n, 2)} ★ (${fmtN(v.n)} attacks)` }))) : '';
  const net = has(G.net) ? vcols(G.net.map((n, b) => { const lo = (b - 4) * 50, lab = b === 0 ? '<−150' : b === 10 ? '300+' : `${lo < 0 ? '−' : ''}${Math.abs(lo)}`;
    return { label: lab, top: n ? fmtN(n) : '', segs: [[n, lo < 0 ? RED : GREEN]], tt: `${b === 0 ? 'Below −150' : b === 10 ? '+300 or more' : `${lo < 0 ? '−' : '+'}${Math.abs(lo)} to ${lo + 49 < 0 ? '−' : '+'}${Math.abs(lo + 49)}`} net · ${fmtN(n)} player-days` }; })) : '';
  const vs = has(G.vsB) ? G.vsB.map((v, i) => ({ v, i })).filter((x) => x.v.n).map(({ v, i }) => ({ label: i === BUCKETS.length ? 'Unranked' : bucketName(i), v: rate(v.s3, v.n), text: pctOf(v.s3, v.n),
    tt: `Defender ${i === BUCKETS.length ? 'unranked at end of day' : 'in ' + bucketName(i)} · ${pctOf(v.s3, v.n)} 3★ (${fmtN(v.s3)} of ${fmtN(v.n)} attacks)` })) : [];
  const cp = (title, note, body) => (body ? `<div class="cp"><h4>${title}</h4><p class="sub">${note}</p>${body}</div>` : '');
  const out = [
    cp('3★ rate by hour (UTC)', 'Share of attacks that were triples, hour by hour from the 05:00 reset', hourly),
    cp('Battle length', 'Attacks by time used; green = 3★, grey = not', lens),
    cp('3★ rate by attack number', 'Each player’s 1st, 2nd … 8th attack of the day', nth),
    cp('Net trophies per player-day', 'Player-days by net trophies (bins of 50; red = lost trophies)', net),
    vs.length > 1 ? cp('3★ rate by defender placement', 'How often attackers triple defenders from each end-of-day rank group', hbars(vs)) : '',
  ].join('');
  return out ? `<section class="panel"><h3>Trends &amp; distributions</h3><div class="cgrid">${out}</div></section>` : '';
}

function compHTML(t) {
  const base = t.attCode, minN = Math.max(10, Math.round(base * 0.01));
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
.pbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin:8px 0 4px}.pbt{opacity:.8}.psearch{display:flex;gap:6px;flex:1 1 260px;max-width:480px}.psearch input{flex:1;min-width:0;padding:9px 12px;border-radius:10px;border:1px solid var(--ck-line);background:rgba(128,128,128,.12);color:inherit;font:inherit}
.pcard{margin-left:6px;padding:0 8px;border-radius:999px;font-size:.7rem;font-weight:700;text-decoration:none;color:inherit;border:1px solid rgba(139,108,246,.6);background:rgba(139,108,246,.18);vertical-align:middle;white-space:nowrap}.pcard:hover{background:rgba(139,108,246,.4)}
.cardwrap{display:grid;grid-template-columns:minmax(0,1fr);gap:22px;align-items:start}.cardwrap canvas{width:100%;height:auto;border-radius:20px;box-shadow:0 20px 56px -18px rgba(0,0,0,.75);background:#130f32}.pbtns{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}@media (max-width:820px){.cardwrap{grid-template-columns:1fr}}
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

function metaHTML(t) {
  const n = t.withCode || 1;
  const col = (title, map, resolve, cat) => {
    const all = [...map.entries()].sort((a, b) => b[1] - a[1]);
    return `<div class="mcol xp"><h4>${title}</h4><div class="mlist">${all.map(([k, c], i) => {
      const [name, icon] = resolve(k);
      return `<div class="mrow${i >= 10 ? ' more' : ''}"${tt(`${name} · ${fmtN(c)} players (${pctOf(c, n)})`)}>${ckTile(cat, name, icon)}<span class="mn">${esc(name)}</span><span class="mc">${fmtN(c)}</span></div>`;
    }).join('') || '<div class="msg">–</div>'}</div>${expandBtn(all.length, 'all')}</div>`;
  };
  const idn = (tbl) => (id) => tbl[id] || [`#${id}`, ''];
  return `<h4 class="mh">What they bring <small>(share of players whose army includes it)</small></h4><div class="meta4">
    ${col('Troops & siege', t.troop, (id) => ARMY_IDS.troop[id] || ARMY_IDS.siege[id] || [`#${id}`, ''], 'troop')}
    ${col('Spells', t.spell, idn(ARMY_IDS.spell), 'spell')}
    ${col('Pets', t.pet, (n) => [n, iconOf.get(n) || ''], 'pet')}
    ${col('Hero equipment', t.equip, (n) => [n, iconOf.get(n) || ''], 'equip')}</div>`;
}
function variantsHTML(g) {
  const vs = [...g.vars.values()].sort((a, b) => b.players - a.players || b.uses - a.uses), shown = vs.slice(0, VAR_MAX);
  return shown.map((v) => `<div class="var"><div class="am"><b>${fmtN(v.players)} player${v.players === 1 ? '' : 's'}</b>${statsLine(v)}<span>${fmtN(v.uses)} attacks</span></div>${ckArmy(v.code)}</div>`).join('')
    + (vs.length > shown.length ? `<small class="sub">Showing the ${shown.length} most popular of ${fmtN(vs.length)} variations.</small>` : '');
}

// ---------- tooltip (hover on mouse, tap on touch) ----------
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
// ---------- player season page: season.html?player=<tag or name> ----------
const embedMode = () => new URLSearchParams(location.search).get('embed') === '1';
const playerQuery = () => (new URLSearchParams(location.search).get('player') || '').trim();
const urlWithPlayer = (v) => { const u = new URL(location.href); if (v) u.searchParams.set('player', v); else u.searchParams.delete('player'); return u.pathname + u.search; };
const cardLink = (tag) => `<a class="pcard" href="${esc(urlWithPlayer(normTag(tag)))}" data-pl title="Season card & stats">card</a>`;
const isTagLike = (q) => /^#?[0289PYLQGRJCUV]{3,12}$/i.test(q);
const sgn = (n, d = 0) => `${n >= 0 ? '+' : '−'}${fmtN(Math.abs(n), d)}`;
function searchBar(q, back) {
  return `<div class="pbar">${back ? `<a class="btn" href="${esc(urlWithPlayer(''))}" data-pl="">← Season stats</a>` : '<b class="pbt">Find a player’s season card</b>'}<div class="psearch"><input id="psi" type="search" placeholder="Player tag (#ABC123) or name" value="${esc(q)}" autocomplete="off"><button class="btn" id="psb">Find</button></div></div>`;
}
const tagKey = (S, q) => { if (!S.tagIdx) S.tagIdx = new Map(Object.keys(S.agg.players).map((k) => [normTag(k), k])); return S.tagIdx.get(normTag(q)); };
const topPct = (rows, val, mine, higher = true, ok = () => true) => { // "Top X%": share of players doing better
  const vs = rows.filter(ok).map(val).filter(Number.isFinite); if (!vs.length || !Number.isFinite(mine)) return null;
  const better = vs.filter((v) => (higher ? v > mine : v < mine)).length; return Math.max(1, Math.ceil((100 * (better + 1)) / vs.length));
};
function playerData(S, tag) {
  const agg = S.agg, p = agg.players[tag], r = S.rows.find((x) => normTag(x.tag) === normTag(tag));
  if (!p || !r) return null;
  const R = S.rows, e8 = (x) => x.na >= 8;
  const strat = new Map(), hero = new Map(), equip = new Map(), siege = new Map();
  const add = (m, k, v) => { let x = m.get(k); if (!x) m.set(k, (x = { n: 0, st: 0, s3: 0 })); x.n += v[0]; x.st += v[1]; x.s3 += v[2]; };
  for (const [ci, v] of Object.entries(p.arm || {})) {
    const code = agg.codes[+ci]; if (!code) continue;
    const inf = infoOf(code); let s = strat.get(inf.cls.strategy); if (!s) strat.set(inf.cls.strategy, (s = { name: inf.cls.strategy, n: 0, st: 0, s3: 0, t: 0, codes: new Map() }));
    s.n += v[0]; s.st += v[1]; s.s3 += v[2]; s.t += v[3]; s.codes.set(code, (s.codes.get(code) || 0) + v[0]);
    for (const h of new Set(inf.heroes.map((x) => x.name))) add(hero, h, v);
    for (const q of inf.eq) add(equip, q, v);
    for (const id of inf.siege) add(siege, id, v);
  }
  const atk = p.arm ? Object.values(p.arm).reduce((x, v) => x + v[0], 0) : 0;
  const pc = { net: topPct(R, (x) => x.net, r.net), off: topPct(R, (x) => x.a, r.a), rate: topPct(R, (x) => x.s3 / x.na, r.s3 / r.na, true, e8),
    avgA: topPct(R, (x) => x.a / x.na, r.a / r.na, true, e8), avgD: topPct(R, (x) => x.d / x.nd, r.d / r.nd, false, (x) => x.nd >= 8), pf: topPct(R, (x) => x.pf, r.pf) };
  return { tag, p, r, strat: [...strat.values()].sort((a, b) => b.n - a.n), hero: [...hero].sort((a, b) => b[1].n - a[1].n), equip: [...equip].sort((a, b) => b[1].n - a[1].n),
    siege: [...siege].sort((a, b) => b[1].n - a[1].n), atk: atk || r.na, pc, avgStars: r.na ? p.st / r.na : 0,
    fast: (S.fast || []).filter((x) => normTag(x.tag) === normTag(tag)).sort((a, b) => a.time - b.time), up: (S.upsets || []).filter((x) => normTag(x.tag) === normTag(tag)).sort((a, b) => (b.rank - b.oppRank) - (a.rank - a.oppRank)) };
}
const pcTxt = (x) => (x ? `Top ${x}%` : '');
function playerHTML(S, d) {
  const { r, p } = d, tot = d.atk || 1, a = S.agg;
  const journey = r.r0 || r.rank ? `${r.r0 ? '#' + fmtN(r.r0) : '–'} → ${r.rank ? '#' + fmtN(r.rank) : '–'}` : '–';
  const kpis = `<div class="kpis">
    ${kpi('Net trophies', sgn(r.net), `+${fmtN(r.a)} / −${fmtN(r.d)}`, r.net >= 0 ? 'pos' : 'neg')}
    ${kpi('Attacks', fmtN(r.na), `${fmtN(r.dy)} days · ${fmtN(r.fu)} with 8 attacks`)}
    ${kpi('3★ rate', pctOf(r.s3, r.na), `${fmtN(r.s3)} triples`, 'pos')}
    ${kpi('Avg stars', avgOf(p.st, r.na, 2), 'per attack')}
    ${kpi('Avg attack', `+${avgOf(r.a, r.na, 1)}`, 'trophies per attack', 'pos')}
    ${kpi('Avg defense', `−${avgOf(r.d, r.nd, 1)}`, `${fmtN(r.nd)} defenses`, 'neg')}
    ${kpi('0★ defenses', fmtN(r.dz), `${pctOf(r.dz, r.nd)} of defenses`)}
    ${kpi('Perfect days', fmtN(r.pf), '8 attacks, all 3★', 'pos')}
    ${kpi('Rank journey', journey, r.delta ? `${r.delta > 0 ? '▲' : '▼'} ${fmtN(Math.abs(r.delta))} places` : 'first → last end of day')}</div>`;
  const bar = (label, val, top) => `<div class="fn"><span>${label}</span><div><i style="width:${top ? Math.max(4, 100 - top + 1) : 0}%;background:linear-gradient(90deg,var(--ck-accent),var(--ck-gold))"></i></div><em>${val}${top ? ` · ${pcTxt(top)}` : ''}</em></div>`;
  const compare = `<section class="panel"><h3>How they compare</h3><p class="sub">Against all ${fmtN(S.rows.length)} players in this season’s data. Rate and average rows need 8+ attacks (defenses: 8+).</p><div class="funnel">
    ${bar('Net trophies', sgn(r.net), d.pc.net)}${bar('Offense', '+' + fmtN(r.a), d.pc.off)}${bar('3★ rate', pctOf(r.s3, r.na), d.pc.rate)}${bar('Avg trophies / attack', `+${avgOf(r.a, r.na, 1)}`, d.pc.avgA)}${bar('Avg trophies lost / defense', `−${avgOf(r.d, r.nd, 1)}`, d.pc.avgD)}${bar('Perfect days', fmtN(r.pf), d.pc.pf)}</div></section>`;
  const sl = (rows, tf) => rows.length ? rows.map(tf).join('') : '<div class="msg">No data</div>';
  const stratRows = d.strat.slice(0, 12).map((s, i) => `<div class="scard"><div class="sch"><span class="icons">${armyIcons(topCode(s.codes))}</span><div><b>${esc(s.name)}</b><small>${fmtN(s.n)} attacks (${pctOf(s.n, tot)}) · ${pctOf(s.s3, s.n)} 3★ · ${avgOf(s.st, s.n, 2)} ★ · +${avgOf(s.t, s.n, 1)}</small></div></div>${ckArmy(topCode(s.codes))}</div>`).join('');
  const style = `<h4 class="mh">Strategies <small>(every army they used this season, grouped as on the armies list; most-used army shown)</small></h4><div class="sgrid2">${stratRows || '<div class="msg">No army links recorded.</div>'}</div>
    <div class="meta4"><div class="mcol"><h4>Heroes</h4><div class="sl">${sl(d.hero.slice(0, 6), ([n, x], i) => statRow(i, ckTile('hero', n, heroIconUrl(n)), n, x.n, x.s3, x.st, tot, 'of attacks'))}</div></div>
    <div class="mcol"><h4>Hero equipment</h4><div class="sl">${sl(d.equip.slice(0, 8), ([n, x], i) => statRow(i, ckTile('equip', n, iconOf.get(n) || ''), n, x.n, x.s3, x.st, tot, 'of attacks'))}</div></div>
    <div class="mcol"><h4>Siege machines</h4><div class="sl">${sl(d.siege.slice(0, 6), ([id, x], i) => { const [n, ic] = ARMY_IDS.siege[id] || ARMY_IDS.troop[id] || [`#${id}`, '']; return statRow(i, ckTile('siege', n, ic), n, x.n, x.s3, x.st, tot, 'of attacks'); })}</div></div></div>`;
  const hl = (title, list, row) => `<div class="mcol"><h4>${title}</h4><div class="lb">${list.length ? list.slice(0, 5).map(row).join('') : '<div class="msg">None this season</div>'}</div></div>`;
  const moments = `<div class="meta4">${hl('Fastest 3★ attacks', d.fast, (x, i) => `<div class="lbr"><span class="n">${i + 1}</span><span class="who">${esc(x.opp)}</span><b>${dur(x.time)}</b><small class="ex">${x.pct}% · ${x.date ? monthDay(x.date) : ''}</small></div>`)}
    ${hl('Giant kills', d.up, (x, i) => `<div class="lbr"><span class="n">${i + 1}</span><span class="who">${esc(x.opp)}</span><b class="pos">+${fmtN(x.rank - x.oppRank)}</b><small class="ex">3★ on eod #${fmtN(x.oppRank)} · ${x.date ? monthDay(x.date) : ''}</small></div>`)}</div>
    <p class="sub"><a class="pl" href="player.html?tag=${esc(normTag(d.tag))}">Open the full player profile →</a></p>`;
  const card = `<div class="cardwrap"><canvas id="pcv" width="1920" height="1300" aria-label="Season card"></canvas><div><h3>Season card</h3><p class="sub">A shareable picture of ${esc(r.name)}’s ${esc(String(a.season || ''))} Legend season. Download it as a PNG or copy it straight to your clipboard.</p>
    <div class="pbtns"><button class="btn" id="dlcard">⬇ Download PNG</button><button class="btn" id="cpcard">Copy image</button></div><p class="sub" id="cardmsg"></p></div></div>`;
  return buildPage([
    ['card', 'Season card', 'One picture with the season’s highlights.', card],
    ['numbers', 'The numbers', 'Totals for the whole season, and how they stack up.', `<section class="panel"><h3>Season totals</h3>${kpis}</section>${compare}`],
    ['style', 'How they play', 'Armies, heroes and gear — with how well each worked.', `<section class="panel">${style}</section>`],
    ['moments', 'Highlights', 'The attacks worth remembering.', `<section class="panel">${moments}</section>`]]);
}
const rrect = (c, x, y, w, h, r) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
const loadImg = (url) => new Promise((res) => { if (!url) return res(null); const im = new Image(); im.crossOrigin = 'anonymous'; const t = setTimeout(() => res(null), 7000); im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); }; im.src = url; });
const recapIconUrls = (html) => [...String(html || '').matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
function seasonRecapRows(map, kind, total) {
  return [...map.entries()].sort((a, b) => b[1].n - a[1].n || b[1].s3 - a[1].s3).slice(0, 5).map(([name, e]) => {
    const code = topCode(e.codes), icons = kind === 'opener' ? recapIconUrls(openerIcons(name, code)) : [];
    return { name, attacks: e.n, share: total ? e.n / total : 0, tripleRate: e.n ? e.s3 / e.n : 0, code, icons };
  });
}
async function drawSeasonRecap(cv, S) {
  const W = 1080, H = 1460, M = 56, A = S.B[ALL], G = S.G;
  const codedAttacks = A.attCode || 0, openers = seasonRecapRows(A.opener, 'opener', codedAttacks), armies = seasonRecapRows(A.strat, 'army', codedAttacks);
  const rows = [...openers, ...armies], urls = [...new Set(rows.flatMap((r) => r.icons))];
  const imgs = new Map(await Promise.all(urls.map(async (u) => [u, await loadImg(u)])));
  const c = cv.getContext('2d'), family = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif', F = (w, sz) => `${w} ${sz}px ${family}`;
  const GOLD = '#e0a526', GREEN = '#3ddc84', RED = '#ff6b6b', DIM = 'rgba(255,255,255,.58)';
  cv.width = W; cv.height = H; c.clearRect(0, 0, W, H); c.textBaseline = 'alphabetic';
  const panel = (x, y, w, h, fill = 'rgba(255,255,255,.06)') => { rrect(c, x, y, w, h, 24); c.fillStyle = fill; c.fill(); c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,.16)'; c.stroke(); };
  const txt = (s, x, y, size, color, weight = 600, max = 0) => { c.font = F(weight, size); c.fillStyle = color; c.textAlign = 'left'; if (max && c.measureText(s).width > max) { while (s.length > 1 && c.measureText(s + '…').width > max) s = s.slice(0, -1); s += '…'; } c.fillText(s, x, y); };
  const tile = (x, y, val, label, color = '#fff') => { panel(x, y, 226, 138, 'rgba(255,255,255,.07)'); txt(label, x + 18, y + 34, 16, DIM, 700, 190); txt(val, x + 18, y + 91, 46, color, 800, 190); };
  const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1f1850'); g.addColorStop(.55, '#130f32'); g.addColorStop(1, '#0a0822'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(W * .88, 90, 0, W * .88, 90, 620); glow.addColorStop(0, 'rgba(139,108,246,.4)'); glow.addColorStop(1, 'rgba(139,108,246,0)'); c.fillStyle = glow; c.fillRect(0, 0, W, H);
  rrect(c, 22, 22, W - 44, H - 44, 38); c.lineWidth = 3; c.strokeStyle = 'rgba(224,165,38,.55)'; c.stroke();
  txt('LEGEND SEASON RECAP', M, 82, 25, GOLD, 700);
  txt(`Season ${S.agg.season || ''} · ${(S.agg.days || []).length}/${S.agg.lengthDays || CONFIG.SEASON_DAYS} Legend Days`, M, 116, 20, DIM, 500);
  txt('The whole season in one picture', M, 184, 60, '#fff', 800, W - M * 2);
  const tiles = [
    [fmtN(S.rows.length), 'PLAYERS', '#fff'], [fmtN(G.att), 'ATTACKS', '#fff'],
    [pctOf(G.astars[3], G.att), '3★ RATE', GREEN], [fmtN(G.perfect), 'PERFECT DAYS', GOLD]
  ];
  tiles.forEach(([v, l, col], i) => tile(M + i * 242, 220, v, l, col));
  const pw = 474, ph = 560, py = 394;
  const popPanel = (title, list, x) => {
    panel(x, py, pw, ph); txt(title.toUpperCase(), x + 22, py + 38, 19, GOLD, 700);
    if (!list.length) { txt('No army links recorded', x + 22, py + 88, 18, DIM, 500); return; }
    list.forEach((r, i) => {
      const y = py + 68 + i * 92, bx = x + 22;
      r.icons.slice(0, 4).forEach((u, j) => {
        const xx = bx + j * 37, im = imgs.get(u); rrect(c, xx, y, 31, 31, 8); c.save(); c.clip(); c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(xx, y, 31, 31); if (im) c.drawImage(im, xx, y, 31, 31); c.restore();
      });
      const tx = bx + (r.icons.length ? 158 : 0), max = pw - (r.icons.length ? 180 : 44);
      txt(`${i + 1}. ${r.name}`, tx, y + 14, 17, '#fff', 700, max);
      txt(`${fmtN(r.attacks)} attacks · ${pctOf(r.attacks, codedAttacks)} used`, tx, y + 39, 14, DIM, 500, max);
      txt(`${pctOf(r.tripleRate * r.attacks, r.attacks)} 3★`, tx, y + 60, 14, GREEN, 600, max);
    });
  };
  popPanel('Most popular openers', openers, M); popPanel('Most popular armies', armies, M + pw + 20);
  const leadersY = 982; panel(M, leadersY, W - 2 * M, 350);
  txt('SEASON RECORDS', M + 24, leadersY + 40, 20, GOLD, 700);
  const leaders = [
    ['MOST NET GAIN', [...S.rows].sort((a, b) => b.net - a.net)[0], (r) => `+${fmtN(r.net)}`, (r) => `${r.name} · ${fmtN(r.na)} attacks`],
    ['MOST ATTACKS', [...S.rows].sort((a, b) => b.na - a.na)[0], (r) => fmtN(r.na), (r) => `${r.name} · ${pctOf(r.s3, r.na)} 3★`],
    ['MOST TRIPLES', [...S.rows].sort((a, b) => b.s3 - a.s3)[0], (r) => fmtN(r.s3), (r) => `${r.name} · ${fmtN(r.na)} attacks`],
    ['MOST PERFECT DAYS', [...S.rows].sort((a, b) => b.pf - a.pf)[0], (r) => fmtN(r.pf), (r) => `${r.name} · ${fmtN(r.fu)} full days`]
  ];
  leaders.forEach(([lab, r, val, sub], i) => {
    const x = M + 24 + (i % 2) * 478, y = leadersY + 68 + Math.floor(i / 2) * 126;
    txt(lab, x, y + 24, 16, DIM, 700, 430); txt(r ? val(r) : '–', x, y + 72, 38, i === 0 ? GREEN : '#fff', 800, 430); if (r) txt(sub(r), x, y + 101, 16, DIM, 500, 430);
  });
  c.font = F(500, 15); c.fillStyle = 'rgba(255,255,255,.4)'; c.textAlign = 'center'; c.fillText('Legend League · army names and opener names match the stats page · icons by ClashKing', W / 2, H - 38); c.textAlign = 'left';
  return cv;
}
async function drawCard(cv, S, d, hist) { // landscape card. hist (optional): [{date, rank, off, def, na, nd}] per finished Legend Day -> fills the two charts + the day-by-day table (shown as "loading" while hist is undefined)
  const noHist = !hist, loading = noHist && typeof getMeta === 'function' && typeof getGz === 'function'; hist = hist || []; // loading = the history is on its way (player page); noHist alone = this page has no day-by-day files
  const L = Math.max((typeof CONFIG !== 'undefined' && CONFIG.SEASON_DAYS) || 28, hist.length, 1);
  const W = 1920, H = 1300, M = 60; cv.width = W; cv.height = H; const c = cv.getContext('2d'), { r, p } = d, FAM = (getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif');
  try { await document.fonts.ready; } catch { /* ignore */ }
  const F = (w, sz) => `${w} ${sz}px ${FAM}`, GOLD = '#e0a526', GREEN = '#3ddc84', RED = '#ff6b6b', ACC = '#8b6cf6', DIM = 'rgba(255,255,255,.5)';
  const heroNames = d.hero.slice(0, 4).map(([n]) => n), fav = d.strat[0], favCode = fav ? topCode(fav.codes) : '';
  const troopIcons = favCode ? mainTroops(favCode, 8).map(([id, n]) => ({ n, url: ckUrl((ARMY_IDS.troop[id] || [])[1]) })) : [];
  const [heroImgs, troopImgs] = await Promise.all([Promise.all(heroNames.map((n) => loadImg(heroIconUrl(n)))), Promise.all(troopIcons.map((t) => loadImg(t.url)))]);
  const fit = (t, maxW, wt, sz, min) => { c.font = F(wt, sz); while (sz > min && c.measureText(t).width > maxW) { sz -= 1; c.font = F(wt, sz); } return sz; };
  const wrap = (t, maxW) => { const out = []; let cur = ''; for (const w of String(t).split(' ')) { const n = cur ? cur + ' ' + w : w; if (cur && c.measureText(n).width > maxW) { out.push(cur); cur = w; } else cur = n; } if (cur) out.push(cur); return out; };
  const panel = (x, y, w, h, title, right, fill) => {
    rrect(c, x, y, w, h, 26); c.fillStyle = fill || 'rgba(255,255,255,.06)'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,.16)'; c.stroke();
    c.textAlign = 'left'; c.fillStyle = GOLD; c.font = F('700', 20); c.fillText(title, x + 24, y + 38);
    if (right) { c.textAlign = 'right'; c.fillStyle = 'rgba(255,255,255,.75)'; c.font = F('600', 20); c.fillText(right, x + w - 24, y + 38); c.textAlign = 'left'; }
  };
  // background
  c.clearRect(0, 0, W, H);
  let g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1f1850'); g.addColorStop(0.55, '#130f32'); g.addColorStop(1, '#0a0822'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.88, 90, 0, W * 0.88, 90, 700); g.addColorStop(0, 'rgba(139,108,246,.40)'); g.addColorStop(1, 'rgba(139,108,246,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(W * 0.1, H, 0, W * 0.1, H, 640); g.addColorStop(0, 'rgba(224,165,38,.22)'); g.addColorStop(1, 'rgba(224,165,38,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  rrect(c, 22, 22, W - 44, H - 44, 38); c.lineWidth = 3; c.strokeStyle = 'rgba(224,165,38,.55)'; c.stroke();
  // header: identity | rank journey | heroes
  c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  if ('letterSpacing' in c) c.letterSpacing = '8px'; c.fillStyle = GOLD; c.font = F('700', 26); c.fillText('LEGEND SEASON', M, 84); if ('letterSpacing' in c) c.letterSpacing = '0px';
  c.fillStyle = 'rgba(255,255,255,.6)'; c.font = F('500', 22); c.fillText(`Season ${S.agg.season || ''} · ${(S.agg.days || []).length}/${L} Legend Days`, M, 116);
  fit(r.name, 640, '800', 80, 36); c.fillStyle = '#fff'; c.fillText(r.name, M, 192);
  c.fillStyle = 'rgba(255,255,255,.55)'; c.font = F('500', 26); c.fillText('#' + normTag(d.tag), M, 230);
  const jx = 800;
  c.fillStyle = DIM; c.font = F('600', 18); if ('letterSpacing' in c) c.letterSpacing = '2px'; c.fillText('FIRST TO LAST END-OF-DAY RANK', jx, 116); if ('letterSpacing' in c) c.letterSpacing = '0px';
  const r0t = r.r0 ? '#' + fmtN(r.r0) : '–', r1t = r.rank ? '#' + fmtN(r.rank) : '–';
  c.font = F('800', 62); c.fillStyle = '#fff'; c.fillText(r0t, jx, 190);
  let x1 = jx + c.measureText(r0t).width + 22;
  c.strokeStyle = GOLD; c.lineWidth = 5; c.lineCap = 'round'; c.beginPath(); c.moveTo(x1, 168); c.lineTo(x1 + 52, 168); c.moveTo(x1 + 38, 154); c.lineTo(x1 + 52, 168); c.lineTo(x1 + 38, 182); c.stroke();
  x1 += 76; c.fillStyle = '#fff'; c.fillText(r1t, x1, 190); x1 += c.measureText(r1t).width + 26;
  if (r.delta) {
    const up = r.delta > 0; c.fillStyle = up ? GREEN : RED; c.beginPath();
    if (up) { c.moveTo(x1, 186); c.lineTo(x1 + 28, 186); c.lineTo(x1 + 14, 160); } else { c.moveTo(x1, 160); c.lineTo(x1 + 28, 160); c.lineTo(x1 + 14, 186); }
    c.closePath(); c.fill(); c.font = F('700', 36); c.fillText(fmtN(Math.abs(r.delta)), x1 + 40, 188);
  }
  heroImgs.forEach((im, i) => { const x = W - M - (heroImgs.length - i) * 120 + 16, y = 100; rrect(c, x, y, 104, 104, 24); c.save(); c.clip(); c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(x, y, 104, 104); if (im) c.drawImage(im, x, y, 104, 104); c.restore(); rrect(c, x, y, 104, 104, 24); c.lineWidth = 3; c.strokeStyle = GOLD; c.stroke(); });
  // left column: stat tiles
  const LW = 640, TOP = 262, BOT = 986, RX = M + LW + 24, RW = W - M - RX;
  const T = [
    ['NET TROPHIES', sgn(r.net), r.net >= 0 ? GREEN : RED, pcTxt(d.pc.net)],
    ['OFFENSE', '+' + fmtN(r.a), GREEN, pcTxt(d.pc.off)],
    ['DEFENSE', '−' + fmtN(r.d), RED, `${fmtN(r.nd)} defenses`],
    ['ATTACKS', fmtN(r.na), '#fff', `${fmtN(r.dy)} days played`],
    ['3★ RATE', pctOf(r.s3, r.na), GOLD, pcTxt(d.pc.rate)],
    ['AVG STARS', avgOf(p.st, r.na, 2), '#fff', `${fmtN(r.s3)} triples`],
    ['AVG ATTACK', '+' + avgOf(r.a, r.na, 1), GREEN, pcTxt(d.pc.avgA) || 'per attack'],
    ['AVG DEFENSE', '−' + avgOf(r.d, r.nd, 1), RED, pcTxt(d.pc.avgD) || `${fmtN(r.dz)} 0★ defenses`],
    ['PERFECT DAYS', fmtN(r.pf), GOLD, `${fmtN(r.fu)} full 8-attack days`]];
  const tw = (LW - 40) / 3, th = 118;
  T.forEach(([lab, val, col, sub], i) => {
    const x = M + (i % 3) * (tw + 20), y = TOP + Math.floor(i / 3) * (th + 20);
    rrect(c, x, y, tw, th, 22); c.fillStyle = 'rgba(255,255,255,.07)'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,.16)'; c.stroke();
    c.fillStyle = 'rgba(255,255,255,.58)'; c.font = F('700', 16); c.fillText(lab, x + 18, y + 30);
    fit(val, tw - 36, '800', 46, 24); c.fillStyle = col; c.fillText(val, x + 18, y + 78);
    if (sub) { fit(sub, tw - 36, '600', 16, 11); c.fillStyle = /^Top/.test(sub) ? GOLD : DIM; c.fillText(sub, x + 18, y + 104); }
  });
  // left column: favourite strategy
  const sy = TOP + 3 * (th + 20), sh = BOT - sy;
  panel(M, sy, LW, sh, 'FAVOURITE STRATEGY', '', 'rgba(139,108,246,.16)');
  c.strokeStyle = 'rgba(139,108,246,.55)'; rrect(c, M, sy, LW, sh, 26); c.stroke();
  if (fav) {
    let nf = 30, lines; for (; nf >= 20; nf -= 2) { c.font = F('800', nf); lines = wrap(fav.name, LW - 56); if (lines.length <= 3) break; }
    c.fillStyle = '#fff'; c.font = F('800', nf); lines.slice(0, 3).forEach((ln, i) => c.fillText(ln, M + 28, sy + 78 + i * (nf + 8)));
    const stats = [[pctOf(fav.n, d.atk || 1), 'OF ATTACKS'], [pctOf(fav.s3, fav.n), '3★ RATE'], [avgOf(fav.st, fav.n, 2), '★ / ATTACK']], sw = (LW - 56) / 3;
    stats.forEach(([v, l], i) => { const x = M + 28 + i * sw; c.fillStyle = GOLD; c.font = F('800', 30); c.fillText(v, x, sy + sh - 100); c.fillStyle = DIM; c.font = F('600', 14); c.fillText(l, x, sy + sh - 78); });
    const maxI = Math.floor((LW - 56 + 14) / 72);
    troopImgs.slice(0, maxI).forEach((im, i) => { const x = M + 28 + i * 72, y = sy + sh - 62; rrect(c, x, y, 58, 48, 10); c.save(); c.clip(); c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(x, y, 58, 48); if (im) c.drawImage(im, x + 5, y, 48, 48); c.restore(); const n = troopIcons[i].n; if (n > 1) { c.font = F('800', 15); c.fillStyle = '#fff'; c.fillText('x' + n, x + 4, y + 14); } });
  } else { c.fillStyle = 'rgba(255,255,255,.6)'; c.font = F('600', 24); c.fillText('No army links recorded this season', M + 28, sy + 110); }
  // right column: charts
  const CH = (BOT - TOP - 20) / 2, hasAny = hist.some((x) => x.rank > 0 || x.off || x.def);
  const gx0 = RX + 84, gx1 = RX + RW - 30, xAt = (i) => gx0 + ((gx1 - gx0) * (i + 0.5)) / L;
  const xAxis = (yb) => { c.font = F('500', 16); c.fillStyle = DIM; c.textAlign = 'center'; for (let i = 0; i < L; i++) if (L <= 14 || i % 2 === 0 || i === L - 1) c.fillText(String(i + 1), xAt(i), yb); c.textAlign = 'left'; c.fillText('day', RX + 24, yb); };
  const emptyMsg = (t) => (loading ? 'Loading day-by-day history…' : noHist ? 'Day-by-day charts are on the player page' : t);
  // 1) end-of-day rank
  const y1 = TOP, rk = hist.map((x) => x.rank || 0), okR = rk.filter((v) => v > 0);
  const best = okR.length ? Math.min(...okR) : 0, last = [...rk].reverse().find((v) => v > 0) || 0;
  panel(RX, y1, RW, CH, 'END-OF-DAY RANK', okR.length ? `best #${fmtN(best)} · last #${fmtN(last)}` : '');
  const t1 = y1 + 70, b1 = y1 + CH - 40;
  if (okR.length) {
    let lo = Math.min(...okR), hi = Math.max(...okR); if (hi === lo) { hi = lo + 10; lo = Math.max(1, lo - 10); } const pad = (hi - lo) * 0.15; lo = Math.max(1, lo - pad); hi += pad;
    const yAt = (v) => t1 + ((v - lo) / (hi - lo)) * (b1 - t1); // rank 1 is the top
    c.font = F('500', 16); c.textAlign = 'right';
    for (let gi = 0; gi <= 3; gi++) { const v = lo + ((hi - lo) * gi) / 3, y = yAt(v); c.strokeStyle = 'rgba(255,255,255,.1)'; c.lineWidth = 1; c.beginPath(); c.moveTo(gx0, y); c.lineTo(gx1, y); c.stroke(); c.fillStyle = DIM; c.fillText('#' + fmtN(Math.round(v)), gx0 - 10, y + 5); }
    c.textAlign = 'left';
    const pts = []; rk.forEach((v, i) => { if (v > 0) pts.push([xAt(i), yAt(v), v]); });
    if (pts.length > 1) {
      const gr = c.createLinearGradient(0, t1, 0, b1); gr.addColorStop(0, 'rgba(139,108,246,.35)'); gr.addColorStop(1, 'rgba(139,108,246,0)');
      c.beginPath(); c.moveTo(pts[0][0], b1); pts.forEach((q) => c.lineTo(q[0], q[1])); c.lineTo(pts[pts.length - 1][0], b1); c.closePath(); c.fillStyle = gr; c.fill();
      c.strokeStyle = ACC; c.lineWidth = 4; c.lineJoin = 'round'; c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.stroke();
    }
    pts.forEach((q) => { c.beginPath(); c.arc(q[0], q[1], q[2] === best ? 8 : 5, 0, Math.PI * 2); c.fillStyle = q[2] === best ? GOLD : '#fff'; c.fill(); });
    const lp = pts[pts.length - 1]; c.font = F('700', 16); c.fillStyle = '#fff'; c.textAlign = lp[0] > gx1 - 60 ? 'right' : 'center'; c.fillText('#' + fmtN(lp[2]), lp[0], lp[1] - 14); c.textAlign = 'left';
  } else { c.fillStyle = DIM; c.font = F('600', 22); c.fillText(emptyMsg('No end-of-day ranks recorded yet'), gx0, (t1 + b1) / 2); }
  xAxis(y1 + CH - 12);
  // 2) offense / defense / net per day
  const y2 = TOP + CH + 20, off = hist.map((x) => x.off || 0), def = hist.map((x) => x.def || 0), net = hist.map((x, i) => off[i] - def[i]), played = hist.filter((x) => x.na || x.nd);
  const avgOff = played.length ? off.reduce((a2, b2) => a2 + b2, 0) / played.length : 0, avgDef = played.length ? def.reduce((a2, b2) => a2 + b2, 0) / played.length : 0;
  panel(RX, y2, RW, CH, 'OFFENSE, DEFENSE & NET PER DAY', `avg attack +${avgOf(r.a, r.na, 1)} · avg defense −${avgOf(r.d, r.nd, 1)}`);
  let lx = RX + 400; c.font = F('600', 16);
  [['Offense', GREEN, 'sq'], ['Defense', RED, 'sq'], ['Net', GOLD, 'dot']].forEach(([t, col, k]) => { c.fillStyle = col; if (k === 'sq') { rrect(c, lx, y2 + 25, 14, 14, 3); c.fill(); } else { c.beginPath(); c.arc(lx + 7, y2 + 32, 6, 0, Math.PI * 2); c.fill(); } c.fillStyle = 'rgba(255,255,255,.7)'; c.fillText(t, lx + 22, y2 + 38); lx += 22 + c.measureText(t).width + 22; });
  const t2 = y2 + 66, b2 = y2 + CH - 40, zero = (t2 + b2) / 2, maxV = Math.max(1, ...off, ...def), sc = (zero - t2 - 6) / maxV, bw = Math.max(6, Math.min(30, ((gx1 - gx0) / L) * 0.6));
  c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(gx0, zero); c.lineTo(gx1, zero); c.stroke();
  c.font = F('500', 16); c.textAlign = 'right'; c.fillStyle = DIM; c.fillText('+' + fmtN(Math.round(maxV)), gx0 - 10, t2 + 10); c.fillText('0', gx0 - 10, zero + 5); c.fillText('−' + fmtN(Math.round(maxV)), gx0 - 10, b2 + 2); c.textAlign = 'left';
  hist.forEach((x, i) => { const cx = xAt(i); if (off[i]) { c.fillStyle = GREEN; rrect(c, cx - bw / 2, zero - off[i] * sc, bw, off[i] * sc, 4); c.fill(); } if (def[i]) { c.fillStyle = RED; rrect(c, cx - bw / 2, zero, bw, def[i] * sc, 4); c.fill(); } });
  if (played.length) {
    c.setLineDash([10, 8]); c.lineWidth = 2;
    c.strokeStyle = 'rgba(61,220,132,.8)'; c.beginPath(); c.moveTo(gx0, zero - avgOff * sc); c.lineTo(gx1, zero - avgOff * sc); c.stroke();
    c.strokeStyle = 'rgba(255,107,107,.8)'; c.beginPath(); c.moveTo(gx0, zero + avgDef * sc); c.lineTo(gx1, zero + avgDef * sc); c.stroke(); c.setLineDash([]);
    const pill = (txt, xr, y, col) => { c.font = F('700', 16); const w = c.measureText(txt).width + 16; c.fillStyle = 'rgba(14,11,36,.9)'; rrect(c, xr - w, y - 16, w, 23, 8); c.fill(); c.fillStyle = col; c.textAlign = 'right'; c.fillText(txt, xr - 8, y); c.textAlign = 'left'; };
    pill(`avg +${fmtN(Math.round(avgOff))}/day`, gx1, zero - avgOff * sc - 5, GREEN); pill(`avg −${fmtN(Math.round(avgDef))}/day`, gx1, zero + avgDef * sc + 24, RED);
    const np = []; hist.forEach((x, i) => { if (x.na || x.nd) np.push([xAt(i), zero - net[i] * sc]); });
    if (np.length > 1) { c.strokeStyle = GOLD; c.lineWidth = 3; c.lineJoin = 'round'; c.beginPath(); np.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.stroke(); }
    np.forEach((q) => { c.beginPath(); c.arc(q[0], q[1], 5, 0, Math.PI * 2); c.fillStyle = GOLD; c.fill(); c.lineWidth = 2; c.strokeStyle = '#130f32'; c.stroke(); });
  } else { c.fillStyle = DIM; c.font = F('600', 22); c.fillText(emptyMsg('No attacks or defenses recorded yet'), gx0 + 10, zero - 14); }
  xAxis(y2 + CH - 12);
  // bottom: day-by-day table
  const ty = BOT + 20, th2 = 228;
  panel(M, ty, W - 2 * M, th2, 'DAY-BY-DAY', loading ? 'loading…' : noHist ? 'open the player page for the day-by-day table' : hasAny ? `${played.length} day${played.length === 1 ? '' : 's'} played` : 'no days played yet');
  const cx0 = M + 150, cw = (W - 2 * M - 150 - 20) / L, rh = 26, ry = ty + 52, rows = ['DAY', 'RANK', 'OFFENSE', 'DEFENSE', 'NET', 'ATK / DEF'], lastIdx = hist.length - 1;
  if (lastIdx >= 0) { rrect(c, cx0 + cw * lastIdx + 1, ry - 2, cw - 2, rh * 6 + 4, 8); c.fillStyle = 'rgba(224,165,38,.12)'; c.fill(); }
  rows.forEach((lab, k) => {
    const y = ry + k * rh;
    if (k > 0 && k % 2 === 0) { rrect(c, M + 12, y, W - 2 * M - 24, rh, 6); c.fillStyle = 'rgba(255,255,255,.04)'; c.fill(); }
    c.textAlign = 'left'; c.font = F('700', 15); c.fillStyle = k === 0 ? GOLD : 'rgba(255,255,255,.6)'; c.fillText(lab, M + 24, y + 19); c.textAlign = 'center';
    for (let i = 0; i < L; i++) {
      const x = hist[i], cx = cx0 + cw * (i + 0.5); let t, col = '#fff';
      if (k === 0) { t = String(i + 1); col = x ? GOLD : 'rgba(255,255,255,.35)'; }
      else if (!x || !(x.rank || x.off || x.def || x.na || x.nd)) { t = '–'; col = 'rgba(255,255,255,.25)'; }
      else if (k === 1) t = x.rank ? '#' + fmtN(x.rank) : '–';
      else if (k === 2) { t = '+' + fmtN(x.off); col = GREEN; }
      else if (k === 3) { t = '−' + fmtN(x.def); col = RED; }
      else if (k === 4) { const n = x.off - x.def; t = sgn(n); col = n >= 0 ? GREEN : RED; }
      else { t = `${x.na}/${x.nd}`; col = 'rgba(255,255,255,.75)'; }
      fit(t, cw - 4, k === 0 ? '700' : '600', 15, 10); c.fillStyle = col; c.fillText(t, cx, y + 19);
    }
  });
  c.textAlign = 'center'; c.fillStyle = 'rgba(255,255,255,.4)'; c.font = F('500', 17);
  c.fillText(`${location.host || 'Legend stats'} · icons by ClashKing · Top % = rank among all tracked players · ${new Date().toISOString().slice(0, 10)}`, W / 2, H - 46);
  c.textAlign = 'left';
}
async function renderPlayerCard(S, d) {
  const cv = document.getElementById('pcv'); if (!cv) return;
  await drawCard(cv, S, d); state.card = { cv, name: d.r.name };
}
function cardBlob(cv) { return new Promise((res, rej) => { try { cv.toBlob((b) => (b ? res(b) : rej(new Error('empty image'))), 'image/png'); } catch (e) { rej(e); } }); }
function postHeight() { try { parent.postMessage({ ck: 'season-card-h', h: Math.ceil(document.documentElement.scrollHeight) }, '*'); } catch { /* not framed */ } }
function drawEmbedCard(S) {
  const q = playerQuery(), out = $('out'), key = tagKey(S, q), d = key ? playerData(S, key) : null;
  if (!document.getElementById('ck-embed')) { const st = document.createElement('style'); st.id = 'ck-embed'; st.textContent = '.wrap>*:not(#out),h1,nav,.controls,footer,#foot,#ck-top{display:none!important}body{background:transparent!important;margin:0!important}.wrap{padding:0!important;margin:0!important;max-width:none!important}.embedcard{padding:2px}'; document.head.appendChild(st); if (window.ResizeObserver) new ResizeObserver(postHeight).observe(document.body); }
  if (!d) { out.innerHTML = '<div class="msg">No season card yet: this player isn’t in the current or previous season data.</div>'; return postHeight(); }
  out.innerHTML = `<div class="embedcard"><div class="cardwrap"><canvas id="pcv" width="1920" height="1300" aria-label="Season card"></canvas><div><h3>Season card</h3><p class="sub">${esc(d.r.name)}’s ${esc(String(S.agg.season || ''))} Legend season: ${sgn(d.r.net)} trophies, ${pctOf(d.r.s3, d.r.na)} 3★ over ${fmtN(d.r.na)} attacks.</p>
    <div class="pbtns"><button class="btn" id="dlcard">⬇ Download PNG</button><button class="btn" id="cpcard">Copy image</button></div><p class="sub" id="cardmsg"></p>
    <p class="sub"><a class="pl" target="_top" href="${esc(location.pathname)}?player=${encodeURIComponent('#' + normTag(d.tag))}">Full season stats →</a></p></div></div></div>`;
  postHeight(); renderPlayerCard(S, d).then(postHeight);
}
function drawPlayerPage(S) {
  if (embedMode()) return drawEmbedCard(S);
  const q = playerQuery(), out = $('out'); state.card = null;
  let found = null, hits = null;
  const key = isTagLike(q) ? tagKey(S, q) : null;
  if (key) found = key;
  else { const low = q.toLowerCase(); hits = q ? S.rows.filter((x) => x.name && x.name.toLowerCase().includes(low)).sort((a, b) => b.a - a.a).slice(0, 25) : []; if (hits.length === 1) found = hits[0].tag; }
  if (found) { const d = playerData(S, found); if (d) { out.innerHTML = searchBar(q, true) + playerHTML(S, d); renderPlayerCard(S, d); return; } }
  out.innerHTML = searchBar(q, true) + (hits && hits.length ? `<section class="panel"><h3>Players matching “${esc(q)}”</h3><div class="lb">${hits.map((x, i) => `<div class="lbr"><span class="n">${i + 1}</span><a class="pl" href="${esc(urlWithPlayer(normTag(x.tag)))}" data-pl>${esc(x.name)}</a><b>${x.rank ? '#' + fmtN(x.rank) : '–'}</b><small class="ex">${fmtN(x.na)} attacks · ${sgn(x.net)} net</small></div>`).join('')}</div></section>`
    : `<div class="msg">${q ? `No player “${esc(q)}” in this season’s data.` : 'Type a player tag or name above.'}</div>`);
}
const pushUrl = (u) => { try { history.pushState(null, '', u); } catch { /* Chrome blocks pushState on file:// pages */ } };
let playerBound = false;
function bindPlayerUI() {
  if (playerBound) return; playerBound = true;
  const go = () => { const v = (document.getElementById('psi') || {}).value || ''; pushUrl(urlWithPlayer(v.trim())); draw(); window.scrollTo(0, 0); };
  document.addEventListener('click', async (e) => {
    const a = e.target.closest?.('a[data-pl]');
    if (a) { e.preventDefault(); pushUrl(a.getAttribute('href')); draw(); window.scrollTo(0, 0); return; }
    if (e.target.closest?.('#psb')) return go();
    if (e.target.closest?.('#shload') && state.S) { e.target.closest('#shload').disabled = true; return loadShieldHistory(state.S); }
    const msg = document.getElementById('cardmsg');
    if (e.target.closest?.('#dlcard') && state.card) {
      try { const b = await cardBlob(state.card.cv), l = document.createElement('a'); l.href = URL.createObjectURL(b); l.download = `${state.card.name.replace(/[^\w-]+/g, '_') || 'player'}-season.png`; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(l.href), 4000); if (msg) msg.textContent = 'Saved.'; }
      catch (err) { if (msg) msg.textContent = 'Couldn’t save the image: ' + err.message; }
    }
    if (e.target.closest?.('#cpcard') && state.card) {
      try { if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('this browser can’t copy images — use Download'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob(state.card.cv) })]); if (msg) msg.textContent = 'Copied to the clipboard.'; }
      catch (err) { if (msg) msg.textContent = 'Couldn’t copy: ' + err.message; }
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'psi') go(); });
  window.addEventListener('popstate', () => draw());
}
const state = { S: null, bucket: ALL, sort: 'used', list: [], seasonRecap: null, lbLimit: 100, boardOrder: 'metric', rankScope: 0, shieldLoading: new Set() };
let seasonRecapToken = 0;
async function renderSeasonRecapCard(S) {
  const cv = document.getElementById('srcv'); if (!cv) return;
  const token = ++seasonRecapToken, dl = document.getElementById('srdl'), cp = document.getElementById('srcopy');
  if (dl) dl.disabled = true; if (cp) cp.disabled = true; state.seasonRecap = null;
  try { await drawSeasonRecap(cv, S); if (token !== seasonRecapToken) return; state.seasonRecap = { cv, season: S.agg.season || 'season' }; if (dl) dl.disabled = false; if (cp) cp.disabled = false; }
  catch (e) { if (token === seasonRecapToken) { const msg = document.getElementById('srmsg'); if (msg) msg.textContent = 'Couldn’t draw the season image: ' + e.message; } }
}
function banner(agg) {
  const n = (agg.days || []).length;
  if (agg.lengthDays !== SEASON_DAYS) return `<div class="notice">This file describes a ${agg.lengthDays}-day season, not the expected ${SEASON_DAYS}.</div>`;
  return n === SEASON_DAYS ? '' : `<div class="notice">Season in progress: <b>${n} of ${SEASON_DAYS}</b> Legend Days finished so far. These stats cover those ${n} days only.</div>`;
}
function draw() {
  const { S } = state; if (!S) return;
  if (playerQuery() && S.rows.length) return drawPlayerPage(S);
  $('out').innerHTML = !S.rows.length ? '<div class="msg">No season data yet.</div>'
    : banner(S.agg) + searchBar('', false) + buildPage([
      ['glance', 'Season at a glance', 'The whole Legend season in numbers.', seasonRecapHTML() + overviewHTML(S)],
      ['trends', 'Day by day', 'How attacks, results and armies moved across the season.', trendHTML(S) + chartsHTML(S)],
      ['players', 'Placement &amp; leaderboards', 'Season records and player leaderboards.', placementHTML(S) + leaderboardsHTML(S)],
      ['armies', 'Armies &amp; strategies', 'What the best players bring, and who performs best with each strategy.', dukeHTML(S) + `<div id="armies">${armiesHTML(S, state.bucket, state.sort)}</div>`],
      ['shields', 'Shield watch', 'Day-by-day shield activity across the season.', shieldSeasonHTML(S)]], [['ch-strats', 'Top performers']]);
  if (S.rows.length) renderSeasonRecapCard(S);
  if (S.agg.dayStats && S.agg.dayStats.length) void loadShieldHistory(S);
}
function drawArmies() {
  const holder = document.getElementById('armies'); if (!holder) return draw();
  holder.innerHTML = armiesHTML(state.S, state.bucket, state.sort);
}
// Season branches are named archive-s<start date>; the schedule is ANCHOR + n * 28 days (same maths as scanner/archive.mjs).
const seasonKeys = () => {
  const len = CONFIG.SEASON_DAYS * CONFIG.DAY, a = Date.parse(CONFIG.SEASON_ANCHOR), cur = Math.floor((Date.now() - a) / len);
  return [cur, cur - 1].map((i) => new Date(a + i * len).toISOString().slice(0, 10)); // current, previous (the only ones kept)
};
// ---------- loading progress bar (same look as the stats page; .prog/.progbar styles are already in STYLES) ----------
const prog = { cur: 0 };
function setProgress(p, label) {
  if (!document.getElementById('progfill')) $('out').innerHTML = '<div class="msg"><div class="prog"><div id="proglabel"></div><div class="progbar" id="progbar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i id="progfill"></i></div><em id="progpct"></em></div></div>';
  prog.cur = Math.max(0, Math.min(100, p));
  $('progfill').style.width = `${prog.cur.toFixed(1)}%`; $('progbar').setAttribute('aria-valuenow', Math.round(prog.cur)); $('progpct').textContent = `${Math.round(prog.cur)}%`;
  if (label) $('proglabel').textContent = label;
}
const nextFrame = () => new Promise((r) => setTimeout(r, 0)); // lets the browser paint the bar between heavy steps
let loadId = 0;
async function fetchSeason(key, onProgress) { // onProgress(fraction 0..1 | null): null = size unknown
  const src = new URLSearchParams(location.search).get('src') || `${CONFIG.REPO_RAW}/archive-s${key}/season.json.gz`;
  const r = await fetch(src); if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0;
  let buf;
  if (r.body && r.body.getReader) { // stream the download so the bar can follow it
    const rd = r.body.getReader(), chunks = []; let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; if (onProgress) onProgress(total ? Math.min(1, got / total) : null); }
    buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  } else buf = new Uint8Array(await r.arrayBuffer());
  if (onProgress) onProgress(1);
  if (buf[0] === 0x1f && buf[1] === 0x8b) return JSON.parse(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  return JSON.parse(new TextDecoder().decode(buf)); // already decompressed by the server
}
async function loadSeason(key, fallbackKey, forceLive = false) {
  const id = ++loadId; prog.cur = 0; $('out').innerHTML = ''; setProgress(2, 'Crunching the season… downloading season data');
  const refresh = document.getElementById('refreshStats'); if (refresh) { refresh.disabled = true; refresh.textContent = forceLive ? 'Computing in browser…' : 'Loading stats…'; }
  try {
    if (!forceLive) {
      try {
        const packed = await getComputed('season', `${key}.json.gz`);
        if (id !== loadId) return;
        state.S = packed.S; state.bucket = ALL; setProgress(100, 'Done'); draw();
        const agg = packed.S.agg, day = (s) => String(s).slice(0, 10);
        $('foot').innerHTML = `Season ${esc(agg.season)} · ${day(agg.start)} 05:00 UTC → ${day(agg.end)} 05:00 UTC · ${(agg.days || []).length}/${agg.lengthDays} days · stats built ${esc(ageLabel(packed.computedAt))} · source data updated ${esc(ageLabel(packed.sourceGeneratedAt))} · ${agg.players ? fmtN(Object.keys(agg.players).length) : 0} players tracked`;
        return;
      } catch { /* calculate from the season aggregate if its saved result is unavailable */ }
    }
    // download = 2% → 70%. If the server doesn't report a size, ease towards 66% instead.
    let sized = false; const creep = setInterval(() => { if (!sized && prog.cur < 66) setProgress(prog.cur + (66 - prog.cur) * 0.07); }, 250);
    let agg; try { agg = await fetchSeason(key, (f) => { if (id !== loadId) return; if (f !== null) { sized = true; setProgress(2 + 68 * f); } }); } finally { clearInterval(creep); }
    if (id !== loadId) return;
    setProgress(70, 'Crunching the season… analysing attacks'); await nextFrame();
    const S = await computeSeason(agg, (f) => { if (id === loadId) setProgress(70 + 23 * f, `Crunching the season… analysing attacks (${Math.round(f * 100)}%)`); }, () => id !== loadId);
    if (!S) return;
    state.S = S; state.bucket = ALL;
    if (id !== loadId) return;
    if (fallbackKey && playerQuery() && !tagKey(state.S, playerQuery())) return loadSeason(fallbackKey, undefined, forceLive);
    setProgress(95, 'Crunching the season… drawing the page'); await nextFrame();
    if (id !== loadId) return;
    setProgress(100, 'Done');
    draw();
    const age = agg.generatedAt ? Math.max(0, Math.round((Date.now() - agg.generatedAt) / 60000)) : null, day = (s) => String(s).slice(0, 10);
    $('foot').innerHTML = `Season ${esc(agg.season)} · ${day(agg.start)} 05:00 UTC → ${day(agg.end)} 05:00 UTC · ${(agg.days || []).length}/${agg.lengthDays} days${age === null ? '' : ` · source data updated ${fmtN(age)} min ago`} · computed in your browser now · ${agg.players ? fmtN(Object.keys(agg.players).length) : 0} players tracked`;
  } catch (e) { if (id === loadId) $('out').innerHTML = `<div class="msg">No season data for ${esc(key)} yet (${esc(e.message)}). The first season file is written when the crawler archives a finished Legend Day.</div>`; }
  finally { if (refresh) { refresh.disabled = false; refresh.textContent = 'Refresh · compute live'; } }
}
async function initSeason() {
  injectStyles(); initTips(); initNav(); bindPlayerUI();
  document.addEventListener('click', async (e) => {
    const recapMsg = document.getElementById('srmsg');
    if (e.target.closest?.('#srdl') && state.seasonRecap) {
      try { const b = await cardBlob(state.seasonRecap.cv), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `legend-season-${String(state.seasonRecap.season).replace(/[^\w-]+/g, '_')}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); if (recapMsg) recapMsg.textContent = 'Saved.'; }
      catch (err) { if (recapMsg) recapMsg.textContent = 'Couldn’t save the image: ' + err.message; }
      return;
    }
    if (e.target.closest?.('#srcopy') && state.seasonRecap) {
      try { if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('this browser can’t copy images — use Download'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob(state.seasonRecap.cv) })]); if (recapMsg) recapMsg.textContent = 'Copied to the clipboard.'; }
      catch (err) { if (recapMsg) recapMsg.textContent = 'Couldn’t copy: ' + err.message; }
      return;
    }
    const b = e.target.closest?.('#bseg button, #sseg button');
    if (b) { if (b.dataset.b != null) state.bucket = +b.dataset.b; if (b.dataset.s) state.sort = b.dataset.s; return drawArmies(); }
    const x = e.target.closest?.('.xbtn');
    if (x) { const open = x.closest('.xp').classList.toggle('open'); x.textContent = open ? 'Show less' : x.dataset.label; return; }
    const v = e.target.closest?.('.vbtn');
    if (v) {
      const box = document.getElementById('vars' + v.dataset.g), g = state.list[+v.dataset.g], open = v.getAttribute('aria-expanded') !== 'true';
      if (open && !box.innerHTML) box.innerHTML = variantsHTML(g);
      box.hidden = !open; v.setAttribute('aria-expanded', open);
      v.textContent = `${open ? '▾' : '▸'} ${fmtN(g.vars.size)} variations`;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'rank-scope') {
      state.rankScope = Number(e.target.value);
      const holder = document.getElementById('leaderboards'); if (holder) holder.outerHTML = leaderboardsHTML(state.S);
      return;
    }
    if (e.target.id === 'lb-limit') {
      state.lbLimit = Number(e.target.value);
      const holder = document.getElementById('leaderboards'); if (holder) holder.outerHTML = leaderboardsHTML(state.S);
      return;
    }
    if (e.target.id === 'lb-order') {
      state.boardOrder = e.target.value;
      const holder = document.getElementById('leaderboards'); if (holder) holder.outerHTML = leaderboardsHTML(state.S);
      return;
    }
  });
  const sel = $('ssel'), keys = seasonKeys();
  sel.innerHTML = keys.map((k, i) => `<option value="${k}">${i ? 'Previous season' : 'Current season'} (started ${monthDay(k)})</option>`).join('');
  sel.onchange = () => loadSeason(sel.value);
  $('refreshStats').onclick = () => loadSeason(sel.value, undefined, true);
  loadSeason(keys[0], embedMode() ? keys[1] : undefined);
}
