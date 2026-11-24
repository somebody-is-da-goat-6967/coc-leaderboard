#!/usr/bin/env node
// Squad fix for the Legend website's army decoding (army.js, stats.js, season.js).
//
// Why: share codes carry Squads as plain troop ids 195-206 ("5x199" = 5 Balloon Squads = 20 Balloons). stats.js / season.js
// classify armies (deduceStrategyName -> LaLo, Drag LaLo, Hog, ...) from the raw troop list, so squads were invisible to
// every "balloons >= 15", "lava hound + balloons", housing-space and icon rule. Result: LaLo built from Balloon Squads
// never showed up in Popular armies (most used / popular now / rising).
//
// Usage (run in the PRIVATE website repo that serves legendstats.pages.dev, then deploy it):
//   node apply-squad-fix.mjs [dir-with-army.js-stats.js-season.js]     (default: current dir)
// The crawler repo's sync-site-sources workflow copies those files from the live site every 6 h, so patching the crawler's
// copies alone would be overwritten. site-compute/ (used by the season precompute) has its own copies: point the script at it too.
// Safe to run twice: files that already contain the fix are skipped.

import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const MARK = 'expandSquads';

const ARMY_JS_ADDITION = `
// ---- Squads (TH8-19 update): one troop slot holding a fixed bundle of troops ----
// Share codes list them as ordinary "{count}x{id}" pairs with ids 195-206. For classification, housing space and icons they
// are expanded into the troops they contain: 5 Balloon Squads = 5 x 4 = 20 Balloons. (The Squad stats panel still uses the raw squad ids.)
const SQUAD_PARTS = {
  195: [['Barbarian', 15], ['Archer', 15]],      // Barch Squad
  196: [['Giant', 3], ['Wizard', 5]],            // Giant Wizard Squad
  197: [['Wall Breaker', 5]],                    // Wall Breaker Squad
  198: [['Minion', 8]],                          // Minion Squad
  199: [['Balloon', 4]],                         // Balloon Squad
  200: [['Golem', 1], ['Witch', 4]],             // Golem Witch Squad
  201: [['Hog Rider', 12]],                      // Hog Rider Squad
  202: [['Miner', 10]],                          // Miner Squad
  203: [['Balloon', 1], ['Healer', 5]],          // Healer Squad
  204: [['P.E.K.K.A', 1], ['Electro Titan', 1]], // P.E.K.K.A Titan Squad
  205: [['Dragon', 2], ['Dragon Rider', 2]],     // Dragons Squad
  206: [['Baby Dragon', 3]],                     // Baby Dragon Squad
};
let squadTroopIds = null; // troop name -> id (lowest id wins, e.g. Minion = 10 not 104), built on first use
function squadTroopId(name) {
  if (!squadTroopIds) {
    squadTroopIds = new Map();
    for (const [id, e] of Object.entries(ARMY_IDS.troop)) if (!SQUAD_PARTS[id] && !squadTroopIds.has(e[0])) squadTroopIds.set(e[0], Number(id));
  }
  return squadTroopIds.get(name);
}
/** [[id, count], ...] with every squad replaced by its troops; the same troop appearing twice is merged (loose + squad + other squad). */
function expandSquads(pairs) {
  const out = new Map();
  for (const [id, n] of pairs) {
    const parts = SQUAD_PARTS[id];
    if (!parts) { out.set(id, (out.get(id) || 0) + n); continue; }
    for (const [name, per] of parts) { const tid = squadTroopId(name); if (tid != null) out.set(tid, (out.get(tid) || 0) + n * per); }
  }
  return [...out];
}
`;

// [old, new] exact replacements (each must match exactly once per file that has it).
const EDITS = {
  'stats.js': [
    ["const merged = (sec, nm) => { const m = new Map(); for (const [id, n] of armyCounts(sec)) m.set(",
     "const merged = (sec, nm, ex) => { const m = new Map(); for (const [id, n] of (ex ? expandSquads(armyCounts(sec)) : armyCounts(sec))) m.set("],
    ["const units = (sec) => merged(sec, nameOf),", "const units = (sec) => merged(sec, nameOf, true),"],
    ["const cnt = new Map(); for (const [id, n] of armyCounts(secOf(code, /u([\\dx-]*)/))) if (!isSiegeId(id)) cnt.set(",
     "const cnt = new Map(); for (const [id, n] of expandSquads(armyCounts(secOf(code, /u([\\dx-]*)/)))) if (!isSiegeId(id)) cnt.set("],
  ],
};
EDITS['season.js'] = EDITS['stats.js'];

let failed = false;
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const write = (f, t) => fs.writeFileSync(path.join(dir, f), t);

// army.js: append the helper.
if (fs.existsSync(path.join(dir, 'army.js'))) {
  const text = read('army.js');
  if (text.includes('function expandSquads')) console.log('army.js: already patched');
  else { write('army.js', text.replace(/\s*$/, '\n') + ARMY_JS_ADDITION); console.log('army.js: added SQUAD_PARTS + expandSquads()'); }
} else { console.error(`army.js not found in ${dir}`); failed = true; }

for (const [file, edits] of Object.entries(EDITS)) {
  if (!fs.existsSync(path.join(dir, file))) { console.log(`${file}: not in this folder, skipped`); continue; }
  let text = read(file);
  if (text.includes(MARK + '(armyCounts')) { console.log(`${file}: already patched`); continue; }
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) { console.error(`${file}: expected 1 match, found ${hits} for: ${from.slice(0, 70)}...`); failed = true; continue; }
    text = text.replace(from, () => to);
  }
  if (!failed) { write(file, text); console.log(`${file}: patched (warArmyOf + mainTroops)`); }
}
if (failed) { console.error('Some edits did not apply; nothing half-written for failed files. Send me the file and I will adapt it.'); process.exit(1); }
