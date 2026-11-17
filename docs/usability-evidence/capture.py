#!/usr/bin/env python3
"""Capture every public page on both sites: screenshots + structure metrics.

Outputs:
  shots/{site}/{page}-{desktop|mobile}.png
  capture.json  — per-page metrics for scoring
"""
import json, re, time, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path("/tmp/opencode/usability")
SHOTS = OUT / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)

HIVV_PAGES = [
    "index.html", "chat/index.html", "command-center.html", "nodes.html",
    "status.html", "dashboard.html", "hivv-dashboard.html", "control.html",
    "aihub.html", "account.html", "admin.html", "database.html", "system.html",
    "connect.html", "bee.html", "donate.html", "docs.html", "api.html",
    "cli.html", "privacy.html", "terms.html", "aup.html", "404.html",
    "hivv-page.html", "hivv-agent-spec.html",
]
BLNQ_PAGES = [
    "index.html", "submit.html", "jobs.html", "runs.html", "run.html",
    "catalog.html", "leaderboard.html", "workers.html", "trust.html",
    "inspect.html", "tools.html", "docs.html", "cli.html", "love.html",
    "study.html", "terminal.html", "visualize.html", "graph/index.html",
    "space/index.html", "status/index.html",
]

SITES = {
    "hivv": ("https://hivv.org", HIVV_PAGES),
    "blnq": ("https://blnq.org", BLNQ_PAGES),
}

VIEWPORTS = {"desktop": (1440, 900), "mobile": (390, 844)}

JS_METRICS = r"""
() => {
  const txt = (el) => (el.innerText || el.getAttribute('aria-label') ||
                       el.getAttribute('title') || '').trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' &&
           s.display !== 'none' && s.opacity !== '0';
  };
  const links = [...document.querySelectorAll('a[href]')].filter(vis);
  const buttons = [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(vis);
  const imgs = [...document.querySelectorAll('img')];
  const forms = [...document.querySelectorAll('form')];
  const inputs = [...document.querySelectorAll('input:not([type=hidden]),textarea,select')].filter(vis);

  // headings outline
  const h = [...document.querySelectorAll('h1,h2,h3')].map(e => ({
    lvl: +e.tagName[1], t: (e.innerText||'').trim().slice(0,90)
  })).filter(x => x.t);

  // generic/meaningless link text
  const vague = links.filter(a => {
    const t = txt(a).toLowerCase();
    return !t || ['click here','here','more','read more','learn more','link','more info','details'].includes(t);
  }).map(a => (txt(a)||'(empty)').slice(0,40));

  // unlabelled form fields
  const unlabelled = inputs.filter(i => {
    if (i.getAttribute('aria-label') || i.getAttribute('placeholder') ||
        i.getAttribute('title') || i.id && document.querySelector(`label[for="${i.id}"]`) ||
        i.closest('label')) return false;
    return true;
  }).map(i => i.tagName + ':' + (i.type||''));

  const noAlt = imgs.filter(i => !i.hasAttribute('alt')).length;

  // tap target size on mobile
  const smallTaps = [...document.querySelectorAll('a,button')].filter(vis).filter(el => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.height < 24;
  }).length;

  const body = document.body.innerText || '';
  return {
    title: document.title,
    lang: document.documentElement.getAttribute('lang'),
    viewportMeta: !!document.querySelector('meta[name=viewport]'),
    metaDesc: (document.querySelector('meta[name=description]')||{}).content || '',
    h1s: [...document.querySelectorAll('h1')].map(e => (e.innerText||'').trim().slice(0,120)),
    headings: h,
    linkCount: links.length,
    buttonCount: buttons.length,
    imgCount: imgs.length,
    noAlt: noAlt,
    formCount: forms.length,
    inputCount: inputs.length,
    vagueLinks: vague.slice(0,10),
    unlabelledFields: unlabelled.slice(0,10),
    smallTaps: smallTaps,
    wordCount: (body.match(/\S+/g)||[]).length,
    hasSkipLink: !!document.querySelector('a[href^="#main"],a[href^="#content"],.skip-link'),
    hasNav: !!document.querySelector('nav,[role=navigation]'),
    hasMain: !!document.querySelector('main,[role=main]'),
    bodyTextSample: body.replace(/\s+/g,' ').slice(0, 400),
    // first 5 link texts = nav shape
    navShape: links.slice(0, 14).map(a => txt(a).slice(0,30)),
    buttonsShape: buttons.slice(0, 12).map(b => txt(b).slice(0,40)),
  };
}
"""

def main():
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        for site, (base, pages) in SITES.items():
            for vp_name, (w, h) in VIEWPORTS.items():
                ctx = browser.new_context(viewport={"width": w, "height": h},
                                          device_scale_factor=1,
                                          user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                                                       "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"))
                page = ctx.new_page()
                errors = []
                page.on("console", lambda m: errors.append(f"{m.type}: {m.text[:160]}")
                        if m.type == "error" else None)
                page.on("pageerror", lambda e: errors.append(f"pageerror: {str(e)[:160]}"))
                for path in pages:
                    url = f"{base}/{path}"
                    errors.clear()
                    t0 = time.time()
                    rec = {"site": site, "path": path, "url": url, "viewport": vp_name}
                    try:
                        resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                        rec["status"] = resp.status if resp else None
                        page.wait_for_timeout(1400)  # let JS settle
                        rec["load_ms"] = int((time.time() - t0) * 1000)
                        try:
                            rec.update(page.evaluate(JS_METRICS))
                        except Exception as e:
                            rec["metrics_error"] = str(e)[:200]
                        slug = path.replace("/", "_").replace(".html", "") or "root"
                        shot = SHOTS / site / f"{slug}-{vp_name}.png"
                        shot.parent.mkdir(parents=True, exist_ok=True)
                        try:
                            page.screenshot(path=str(shot), full_page=True)
                            rec["shot"] = str(shot)
                        except Exception as e:
                            rec["shot_error"] = str(e)[:120]
                        rec["console_errors"] = errors[:6]
                    except Exception as e:
                        rec["nav_error"] = str(e)[:200]
                    results.append(rec)
                    print(f"{site:5} {vp_name:8} {path:28} "
                          f"{rec.get('status','?'):>4} {rec.get('load_ms',0):>5}ms "
                          f"{'ERR' if rec.get('nav_error') or rec.get('metrics_error') else 'ok'}",
                          flush=True)
                ctx.close()
        browser.close()

    (OUT / "capture.json").write_text(json.dumps(results, indent=2))
    print(f"\n{len(results)} captures -> {OUT/'capture.json'}")

if __name__ == "__main__":
    main()
