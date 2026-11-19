#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [targetArg = '.', sourceArg] = process.argv.slice(2);
const target = path.resolve(targetArg);
const source = path.resolve(sourceArg || path.join(target, 'site-source'));
const base = 'https://legendstats.pages.dev/';
const files = ['armyids.js', 'army.js', 'legend.js', 'stats.js', 'season.js', 'townhall.js'];
const downloaded = new Map();
for (const file of files) {
  const response = await fetch(new URL(file, base), { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not fetch ${file} from live site (HTTP ${response.status})`);
  const text = await response.text();
  if (!text.trim() || /^\s*<!doctype html/i.test(text)) throw new Error(`Live site did not return JavaScript for ${file}`);
  downloaded.set(file, text);
}
if (!downloaded.get('armyids.js').includes('const ARMY_IDS =')) throw new Error('Live armyids.js did not contain the expected ID table');

fs.mkdirSync(source, { recursive: true });
for (const [file, text] of downloaded) fs.writeFileSync(path.join(source, file), text);
const copies = {
  '.': ['armyids.js', 'army.js', 'legend.js', 'stats.js'],
  scanner: ['armyids.js', 'army.js', 'stats.js'],
};
for (const [dir, names] of Object.entries(copies)) {
  const outDir = path.join(target, dir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of names) {
    fs.copyFileSync(path.join(source, file), path.join(outDir, file));
    console.log(`[site-sync] ${path.relative(target, path.join(outDir, file))}`);
  }
}
console.log(`[site-sync] source ${base}`);
