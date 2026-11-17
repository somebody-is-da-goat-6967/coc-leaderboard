#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error('Usage: node scripts/sync-site-sources.mjs <website-checkout> <crawler-checkout>');
const source = path.resolve(sourceArg), target = path.resolve(targetArg);
const copies = {
  '.': ['armyids.js', 'army.js', 'legend.js', 'stats.js'],
  scanner: ['armyids.js', 'army.js', 'stats.js'],
  'site-compute': ['armyids.js', 'army.js', 'legend.js', 'stats.js', 'season.js', 'townhall.js'],
};
for (const [dir, files] of Object.entries(copies)) {
  const outDir = path.join(target, dir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const from = path.join(source, file), to = path.join(outDir, file);
    if (!fs.existsSync(from)) throw new Error(`Website source is missing ${file}`);
    fs.copyFileSync(from, to);
    console.log(`[site-sync] ${path.relative(target, to)}`);
  }
}
