#!/usr/bin/env python3
"""Contrast check by SAMPLING RENDERED PIXELS.

Why not computed styles? Because `background: linear-gradient(...)` is invisible
to getComputedStyle().backgroundColor, and the walker falls through to a dark
fallback — which produced a bogus "1.03:1 invisible link" reading. Ground truth
is the actual rendered image.

  text colour = getComputedStyle(a).color        (reliable: it IS the text)
  bg colour   = MODE of rendered pixels in the link's box (handles gradients,
                overlays, opacity, images)
"""
import json, sys
from collections import Counter
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

OUT = Path("/tmp/opencode/usability")

def lin(v):
    v /= 255.0
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

def lum(rgb):
    r, g, b = rgb[:3]
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

def contrast(a, b):
    x, y = lum(a), lum(b)
    hi, lo = (x, y) if x > y else (y, x)
    return (hi + 0.05) / (lo + 0.05)

def parse_css_color(s):
    nums = [float(n) for n in __import__("re").findall(r"[\d.]+", s)][:3]
    return tuple(int(n) for n in nums) if len(nums) == 3 else None

def mode_color(img, box):
    """Most common colour inside box — the background."""
    x0, y0, x1, y1 = [int(v) for v in box]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(img.width, x1), min(img.height, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    px = list(crop.getdata())
    if not px:
        return None
    # quantise slightly so anti-aliasing noise doesn't fragment the count
    q = [(r // 8 * 8, g // 8 * 8, b // 8 * 8) for r, g, b in px]
    (colour, n), = Counter(q).most_common(1)
    return colour, n / len(px)

PAGES = [
    ("hivv", "https://hivv.org/"),
    ("hivv", "https://hivv.org/purpose.html"),
    ("hivv", "https://hivv.org/privacy.html"),
    ("hivv", "https://hivv.org/cli.html"),
    ("hivv", "https://hivv.org/nodes.html"),
    ("hivv", "https://hivv.org/chat/"),
    ("blnq", "https://blnq.org/"),
    ("blnq", "https://blnq.org/run.html"),
    ("blnq", "https://blnq.org/jobs.html"),
    ("blnq", "https://blnq.org/trust.html"),
]

results = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
    ctx = b.new_context(viewport={"width": 1440, "height": 1200}, device_scale_factor=1)
    pg = ctx.new_page()

    for site, url in PAGES:
        try:
            pg.goto(url, wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_timeout(1600)
            pg.screenshot(path=str(OUT / "_contrast.png"), full_page=True)
            img = Image.open(OUT / "_contrast.png").convert("RGB")

            links = pg.evaluate("""() => [...document.querySelectorAll('a[href]')]
                .map(a => { const r = a.getBoundingClientRect();
                  return { text:(a.innerText||'').trim().slice(0,40),
                           color:getComputedStyle(a).color,
                           size:parseFloat(getComputedStyle(a).fontSize),
                           weight:getComputedStyle(a).fontWeight,
                           x:r.x+scrollX, y:r.y+scrollY, w:r.width, h:r.height };
                })
                .filter(l => l.w > 4 && l.h > 8 && l.text)""")

            seen = set()
            for l in links:
                key = (l["color"], round(l["size"]), l["text"][:20])
                if key in seen:
                    continue
                seen.add(key)
                fg = parse_css_color(l["color"])
                if not fg:
                    continue
                # sample a band around the text, inset to skip neighbouring blocks
                box = (l["x"] + 2, l["y"] + 1, l["x"] + l["w"] - 2, l["y"] + l["h"] - 1)
                mc = mode_color(img, box)
                if not mc:
                    continue
                bg, share = mc
                # if the background share is tiny the crop is mostly text/other
                if share < 0.25:
                    continue
                cr = contrast(fg, bg)
                large = l["size"] >= 24 or (l["size"] >= 18.66 and int(l["weight"]) >= 700)
                results.append({
                    "site": site, "url": url, "text": l["text"],
                    "fg": fg, "bg": bg, "bg_share": round(share, 2),
                    "size": l["size"], "ratio": round(cr, 2),
                    "pass_AA": cr >= 4.5,
                    "pass_AA_large": cr >= 3.0 if large else None,
                })
        except Exception as e:
            print(f"{url}: ERROR {str(e)[:100]}", file=sys.stderr)

    b.close()

results.sort(key=lambda r: r["ratio"])
(OUT / "contrast.json").write_text(json.dumps(results, indent=2))

print("=" * 100)
print("CONTRAST — measured from rendered pixels (handles gradients)")
print("=" * 100)
print(f"{'site':5} {'ratio':>6} {'AA':>5}  {'text':30} {'fg':16} {'bg':16} px")
print("-" * 100)
for r in results[:26]:
    print(f"{r['site']:5} {r['ratio']:>6.2f} {'ok' if r['pass_AA'] else 'FAIL':>5}  "
          f"{r['text'][:30]:30} {str(r['fg']):16} {str(r['bg']):16} {r['size']:.0f}")

fails = [r for r in results if not r["pass_AA"]]
print()
print(f"MEASURED: {len(fails)}/{len(results)} unique links below WCAG AA 4.5:1")
print(f"          {len([r for r in results if r['ratio'] < 3.0])} below 3.0 (fails even for large text)")
if results:
    print(f"          worst = {results[0]['ratio']:.2f}:1 on {results[0]['text']!r} ({results[0]['site']})")
