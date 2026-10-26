// Moves finished Legend-day battlelog files out of the `data` branch into one git branch per season,
// so the `data` branch (cloned every run) stays small.
//
//   data branch      : live.json.gz, state.json.gz, index.json, the last few daily files (see BATTLELOG_KEEP_DAYS)
//   archive-sYYYY-MM-DD : days/YYYY-MM-DD.json.gz for every finished day of the season that started on that date
//                         + index.json listing them + season.json.gz (all days folded together, see seasonAgg.mjs). Only the 2 newest seasons are kept (current + previous).
//
// Runs after scanner/battlelogs.mjs. Cheap on almost every run: it only touches git when a day became
// final and has not been archived yet (tracked in data-out/battlelogs/archived.json).
//
// Season schedule = SEASON_ANCHOR + n * SEASON_DAYS. If Supercell ever runs a longer/shorter season,
// change SEASON_ANCHOR to the newest season start (older branches keep their names).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { emptySeason, foldDay, readGz, writeGz, loadEodRanks } from './Seasonagg.mjs';

const OUT_DIR = process.env.OUT_DIR || 'data-out';
const BL_DIR = path.join(OUT_DIR, 'battlelogs');
const ANCHOR = Date.parse(process.env.SEASON_ANCHOR || '2026-10-05T05:00:00Z'); // season start (Legend resets at 05:00 UTC)
const DAY_MS = 86_400_000;
const SEASON_MS = (+process.env.SEASON_DAYS || 28) * DAY_MS;
const KEEP_SEASONS = +process.env.KEEP_SEASONS || 2;
const PREFIX = 'archive-s';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

const seasonIdx = ms => Math.floor((ms - ANCHOR) / SEASON_MS);
const seasonKey = idx => new Date(ANCHOR + idx * SEASON_MS).toISOString().slice(0, 10);
// daily file YYYY-MM-DD is named after the 05:00 reset that closed it, so the day began 24h before that
const dayStartOf = date => Date.parse(`${date}T05:00:00Z`) - DAY_MS;

function latestResetAt(now) {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5);
  return now >= today ? today : today - DAY_MS;
}

const index = readJson(path.join(BL_DIR, 'index.json'), null);
if (!index?.archives) { console.log('archive: no battlelogs/index.json yet'); process.exit(0); }

const archivedPath = path.join(BL_DIR, 'archived.json');
const archived = new Set(readJson(archivedPath, { dates: [] }).dates);

const currentIdx = seasonIdx(latestResetAt(Date.now()));
const keepIdx = new Set(Array.from({ length: KEEP_SEASONS }, (_, i) => currentIdx - i));

// finished, not yet archived, and belonging to a season we keep
const groups = new Map(); // season idx -> [dates]
for (const a of index.archives) {
  if (!a.final || archived.has(a.date)) continue;
  if (!fs.existsSync(path.join(BL_DIR, `${a.date}.json.gz`))) continue;
  const idx = seasonIdx(dayStartOf(a.date));
  if (!keepIdx.has(idx)) { archived.add(a.date); continue; } // too old to archive, don't retry forever
  (groups.get(idx) || groups.set(idx, []).get(idx)).push(a.date);
}

const remote = git(OUT_DIR, 'remote', 'get-url', 'origin');
let failures = 0;

for (const [idx, dates] of groups) {
  const key = seasonKey(idx);
  const branch = PREFIX + key;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  try {
    const exists = git(tmp, 'ls-remote', '--heads', remote, `refs/heads/${branch}`) !== '';
    if (exists) {
      fs.rmSync(tmp, { recursive: true, force: true });
      git(os.tmpdir(), 'clone', '-q', '--depth', '1', '--branch', branch, remote, tmp);
    } else {
      git(tmp, 'init', '-q', '-b', branch);
      git(tmp, 'remote', 'add', 'origin', remote);
    }
    fs.mkdirSync(path.join(tmp, 'days'), { recursive: true });
    for (const d of dates) fs.copyFileSync(path.join(BL_DIR, `${d}.json.gz`), path.join(tmp, 'days', `${d}.json.gz`));

    const all = fs.readdirSync(path.join(tmp, 'days')).filter(f => f.endsWith('.json.gz')).map(f => f.slice(0, 10)).sort();
    // Fold every day in the branch into ONE compact season.json.gz (the stats page reads only this file).
    // Idempotent: days already in agg.days are skipped, so this also backfills days archived before this existed.
    const sf = path.join(tmp, 'season.json.gz');
    const agg = readGz(sf, null) || emptySeason(key, ANCHOR + idx * SEASON_MS, SEASON_MS / DAY_MS);
    for (const d of all) {
      if (agg.days.includes(d)) continue;
      const day = readGz(path.join(tmp, 'days', `${d}.json.gz`), null);
      if (day) foldDay(agg, d, day, loadEodRanks(path.join(OUT_DIR, 'eod', `${d}.json.gz`)));
    }
    writeGz(sf, agg);

    fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({
      season: key,
      seasonStart: new Date(ANCHOR + idx * SEASON_MS).toISOString(),
      seasonEnd: new Date(ANCHOR + (idx + 1) * SEASON_MS).toISOString(),
      days: all,
      updatedAt: new Date().toISOString(),
    }));

    git(tmp, 'add', '-A');
    if (git(tmp, 'status', '--porcelain')) {
      git(tmp, '-c', 'user.name=crawler', '-c', 'user.email=crawler@users.noreply.github.com',
        'commit', '-q', '-m', `archive ${dates.join(', ')}`);
      git(tmp, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`); // normal push: only the new files are uploaded
    }
    for (const d of dates) archived.add(d);
    console.log(`archive: ${branch} <- ${dates.join(', ')}`);
  } catch (e) {
    failures++;
    console.error(`archive: ${branch} failed:`, String(e.stderr || e.message).replace(/x-access-token:[^@]+@/g, ''));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// drop season branches older than the newest KEEP_SEASONS
try {
  const heads = git(OUT_DIR, 'ls-remote', '--heads', 'origin', `refs/heads/${PREFIX}*`)
    .split('\n').filter(Boolean).map(l => l.split('\t')[1].replace('refs/heads/', ''));
  const keepKeys = new Set([...keepIdx].map(seasonKey));
  for (const h of heads) {
    if (keepKeys.has(h.slice(PREFIX.length))) continue;
    git(OUT_DIR, 'push', '-q', 'origin', '--delete', h);
    console.log(`archive: deleted old season branch ${h}`);
  }
} catch (e) {
  failures++;
  console.error('archive: prune failed:', String(e.stderr || e.message).replace(/x-access-token:[^@]+@/g, ''));
}

fs.writeFileSync(archivedPath, JSON.stringify({ dates: [...archived].sort() }));
process.exit(failures ? 1 : 0);
