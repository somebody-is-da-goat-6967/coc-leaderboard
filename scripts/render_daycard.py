#!/usr/bin/env python3
"""Renders the daily Legend Day recap PNG by opening daily.html in headless Chromium.

  python scripts/render_daycard.py --decide        # stdlib only: is there a finished day without an image yet? (writes todo/date to $GITHUB_OUTPUT)
  python scripts/render_daycard.py                 # renders it (needs: pip install playwright && playwright install chromium)

Layout it expects (see .github/workflows/daily-card.yml):
  --site  folder with the website files (daily.html, daycard.js, legend.js, ...)         default: .
  --data  checkout of the `data` branch (battlelogs/, eod/, meta.json)                    default: _data
  --out   checkout of the `daily-cards` branch, receives <date>.png/.json + latest.*      default: _cards
"""
import argparse, base64, functools, http.server, json, os, pathlib, shutil, sys, threading, time
from datetime import datetime, timezone, timedelta

WAIT_FOR_RANKS_H = 4  # the end-of-day rank file (eod/<date>.json.gz) is written by the crawler; wait this long for it before drawing without it


def archive_dates(data):
    idx = json.loads((data / 'battlelogs' / 'index.json').read_text())
    return sorted(a['date'] for a in idx.get('archives', []))


def decide(site, data, out, date, force):
    """-> (date or None, reason). date = archive date (UTC day on which the Legend Day ended)."""
    dates = archive_dates(data)
    d = date or (dates[-1] if dates else None)
    if not d: return None, 'no archived Legend Day yet'
    if d not in dates or not (data / 'battlelogs' / f'{d}.json.gz').exists(): return None, f'no battle log archive for {d} yet'
    if (out / f'{d}.png').exists() and not force: return None, f'{d}.png already exists'
    ended = datetime.fromisoformat(d + 'T05:00:00+00:00')
    if not (data / 'eod' / f'{d}.json.gz').exists() and not date and datetime.now(timezone.utc) < ended + timedelta(hours=WAIT_FOR_RANKS_H):
        return None, f'waiting for the end-of-day ranks of {d}'
    return d, 'ok'


class Handler(http.server.SimpleHTTPRequestHandler):
    site = data = None
    def translate_path(self, path):
        p = path.split('?', 1)[0].split('#', 1)[0]
        if p.startswith('/_data/'): return str(self.data / p[len('/_data/'):])
        return str(self.site / p.lstrip('/'))
    def log_message(self, *a): pass


def serve(site, data):
    h = type('H', (Handler,), {'site': site.resolve(), 'data': data.resolve()})
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def render(site, data, out, date, force=False, hook=None):
    from playwright.sync_api import sync_playwright
    srv = serve(site, data); port = srv.server_address[1]
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(args=['--no-sandbox'])
            page = b.new_page(viewport={'width': 1200, 'height': 900})
            if hook: hook(page)
            page.on('pageerror', lambda e: print('page error:', e, file=sys.stderr))
            page.goto(f'http://127.0.0.1:{port}/daily.html?render&date={date}&data=/_data', wait_until='load')
            page.wait_for_function('window.__card && window.__card.ready', timeout=240_000)
            res = page.evaluate('window.__card')
            if res.get('error') or res.get('empty'): raise SystemExit(f"card not drawn: {res.get('error') or 'no battle data'}")
            if not page.evaluate('document.fonts.check(\'700 20px "Barlow Condensed"\')'): print('warning: Barlow fonts did not load (no network?), the image uses fallback fonts', file=sys.stderr)
            png = base64.b64decode(page.evaluate("document.getElementById('card').toDataURL('image/png')").split(',', 1)[1])
            b.close()
    finally:
        srv.shutdown()
    out.mkdir(parents=True, exist_ok=True)
    (out / f'{date}.png').write_bytes(png)
    summary = res['summary']; (out / f'{date}.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    newest = archive_dates(data)[-1] == date
    cur = out / 'latest.json'
    if newest or not cur.exists():  # a backfilled older day must not replace latest
        shutil.copyfile(out / f'{date}.png', out / 'latest.png'); shutil.copyfile(out / f'{date}.json', cur)
    print(f'wrote {out / (date + ".png")} ({len(png) // 1024} KB)')
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='.'); ap.add_argument('--data', default='_data'); ap.add_argument('--out', default='_cards')
    ap.add_argument('--date', default=os.environ.get('DATE') or None, help='archive date YYYY-MM-DD (default: newest archive)')
    ap.add_argument('--force', action='store_true', default=os.environ.get('FORCE') == 'true'); ap.add_argument('--decide', action='store_true')
    a = ap.parse_args(); site, data, out = pathlib.Path(a.site), pathlib.Path(a.data), pathlib.Path(a.out)
    d, why = decide(site, data, out, a.date, a.force)
    if a.decide:
        print(f'{d or "-"}: {why}')
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as f: f.write(f'todo={"true" if d else "false"}\ndate={d or ""}\n')
        return
    if not d: print(why); return
    render(site, data, out, d, a.force)


if __name__ == '__main__':
    main()
