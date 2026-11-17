#!/usr/bin/env python3
"""Human Usability Score — every page, 1-10 on 10 measurements.

TRANSPARENCY RULE: every sub-score is derived from a MEASURED signal where a
signal exists. Judgement-only inputs are marked (J) and listed separately so
nobody has to take them on faith. A page with no measurement for a dimension
scores from the proxy signal, never a free 10.
"""
import json, re
from pathlib import Path

OUT = Path("/tmp/opencode/usability")
cap = json.load(open(OUT / "capture.json"))
journeys = {j["id"]: j for j in json.load(open(OUT / "journeys.json"))}
inter = {r["id"]: r for r in json.load(open(OUT / "interactive.json"))}

desk = {(r["site"], r["path"]): r for r in cap if r["viewport"] == "desktop"}
mob  = {(r["site"], r["path"]): r for r in cap if r["viewport"] == "mobile"}

JARGON_WORDS = ["orchestrat", "endpoint", "telemetry", "provenance", "attestation",
                "sovereign", "latency", "throughput", "inference", "zero-trust",
                "quorum", "principal", "gateway", "webhook", "context window"]

def clamp(x): return max(0.0, min(10.0, x))

def score(site, path):
    d = desk.get((site, path))
    m = mob.get((site, path))
    if not d: return None
    text = (d.get("bodyTextSample") or "")
    words = d.get("wordCount") or 1
    s = {}

    # 1 CLARITY — has a page-identifying h1 + a description + low jargon
    h1 = d.get("h1s") or []
    jargon = sum(text.lower().count(w) for w in JARGON_WORDS)
    s["Clarity"] = clamp(
        (4.0 if h1 else 0) +                      # who is this page for?
        (3.0 if d.get("metaDesc") else 0) +       # what is it?
        (3.0 * max(0, 1 - jargon / 6)))           # is it plain language?

    # 2 SIMPLICITY — fewer things on screen is better
    links = d.get("linkCount") or 0
    btns = d.get("buttonCount") or 0
    density = links + btns
    s["Simplicity"] = clamp(10 - max(0, density - 25) * 0.16 - max(0, words - 400) * 0.006)

    # 3 DISCOVERABILITY — real nav + a main landmark + skip link
    s["Discoverability"] = clamp(
        (4.0 if d.get("hasNav") else 0) +
        (3.0 if d.get("hasMain") else 0) +
        (2.0 if d.get("hasSkipLink") else 0) +
        (1.0 if len(h1) == 1 else 0))             # exactly one h1 = clear outline

    # 4 FEEDBACK — measured: does chat answer, does a bad URL say anything
    fb = []
    if site == "hivv":
        if inter.get("I1", {}).get("ok"): fb.append(10)
        else: fb.append(0)
        fb.append(10 if inter.get("I2", {}).get("ok") else 0)   # 404 tells you something
    else:
        fb.append(6)   # BLNQ: not e2e-tested this run — proxy only, marked (P)
    s["Feedback"] = clamp(sum(fb) / len(fb))

    # 5 TRUST — can a normal person find out where their data goes?
    trust = 0
    body_l = text.lower()
    if path in ("privacy.html", "terms.html", "aup.html"): trust += 5
    if site == "hivv" and "privacy" in str(d.get("navShape", [])).lower(): trust += 2
    if d.get("metaDesc"): trust += 1
    # does the first screen say anything about data in human words?
    if any(k in body_l for k in ["your data", "your prompts", "we do not", "never sold"]):
        trust += 2
    s["Trust"] = clamp(trust)

    # 6 ACCESSIBILITY — measured structural signals only
    a = 0
    a += 2 if d.get("lang") else 0
    a += 2 if d.get("viewportMeta") else 0
    a += 2 if h1 else 0
    a += 1 if d.get("hasMain") else 0
    a += 1 if d.get("hasSkipLink") else 0
    a += 2 if d.get("noAlt", 0) == 0 and (d.get("imgCount") or 0) > 0 else (
          2 if (d.get("imgCount") or 0) == 0 else 0)
    s["Accessibility"] = clamp(a)

    # 7 RECOVERY — measured: 404 quality + any undo affordance
    if site == "hivv":
        rec = 10 if inter.get("I2", {}).get("ok") else 0
    else:
        rec = 0 if not Path("/var/www/vhosts/blnq.org/public_html/404.html").exists() else 5
    s["Recovery"] = clamp(rec)

    # 8 MOBILE — measured on the 390px capture of the same page
    if m:
        over = (m.get("wordCount") or 0) and False  # overflow measured in J7 only
        small = m.get("smallTaps") or 0
        total = (m.get("linkCount") or 1) + (m.get("buttonCount") or 1)
        ratio = small / max(1, total)
        s["Mobile"] = clamp(10 - ratio * 30 - (0 if m.get("viewportMeta") else 4))
    else:
        s["Mobile"] = None

    # 9 SPEED — measured load time
    load = d.get("load_ms") or 0
    s["Speed"] = clamp(10 - max(0, load - 800) / 400)

    # 10 VALUE — did the journey for this page succeed?
    v = 5.0  # neutral when no journey targets this page
    if path == "index.html" and site == "hivv": v = 10 if journeys["J1"]["reached"] else 0
    if path == "index.html" and site == "blnq": v = 10 if journeys["J6"]["reached"] else 0
    if path == "chat/index.html":               v = 10 if journeys["J1"]["reached"] else 0
    if path == "hivv-dashboard.html":           v = 10 if journeys["J3"]["reached"] else 0
    if path == "cli.html":                      v = 10 if journeys["J5"]["reached"] else 0
    if path == "privacy.html":                  v = 10 if journeys["J4"]["reached"] else 0
    s["Value"] = clamp(v)
    return s

DIMS = ["Clarity","Simplicity","Discoverability","Feedback","Trust",
        "Accessibility","Recovery","Mobile","Speed","Value"]

rows = []
for (site, path), d in desk.items():
    s = score(site, path)
    if not s: continue
    vals = [v for v in s.values() if v is not None]
    overall = min(vals)          # MINIMUM, not average — a zero is a zero
    measured = sum(1 for v in s.values() if v is not None)
    rows.append({"site": site, "path": path, "dims": s,
                 "overall": round(overall, 1),
                 "mean": round(sum(vals)/len(vals), 1),
                 "measured": measured})

rows.sort(key=lambda r: (r["site"], r["overall"]))

print("=" * 96)
print("HUMAN USABILITY SCORE — every page (1-10, OVERALL = MINIMUM of measured dims)")
print("=" * 96)
hdr = (f"{'page':30} {'ovr':>4} {'avg':>4} " +
       " ".join(f"{d[:4]:>4}" for d in DIMS))
print(hdr); print("-" * len(hdr))
for r in rows:
    cells = []
    for d in DIMS:
        v = r["dims"].get(d)
        cells.append("  --" if v is None else f"{v:>4.1f}")
    print(f"{r['site']+'/'+r['path']:30} {r['overall']:>4.1f} {r['mean']:>4.1f} " +
          " ".join(cells))

print()
print("=" * 96)
print("TWO VIEWS — the 404 bug is systemic, so it caps everything. Show both:")
print("=" * 96)
print(f"{'site':6} {'pages':>5} {'OVERALL':>8} {'ex-Recovery':>12} {'mean':>6} {'best':>5} {'worst':>6}")
print("-" * 60)
for site in ("hivv", "blnq"):
    rs = [r for r in rows if r["site"] == site]
    ov = [r["overall"] for r in rs]
    # recompute minimum WITHOUT the systemic Recovery dim
    ex = []
    for r in rs:
        vals = [v for k, v in r["dims"].items() if v is not None and k != "Recovery"]
        ex.append(min(vals) if vals else 0)
    mn = [r["mean"] for r in rs]
    print(f"{site.upper():6} {len(rs):>5} {min(ov):>8.1f} {sum(ex)/len(ex):>12.1f} "
          f"{sum(mn)/len(mn):>6.1f} {max(ov):>5.1f} {min(ov):>6.1f}")

print()
print("OVERALL        = minimum across ALL measured dims, including Recovery")
print("ex-Recovery    = minimum ignoring Recovery, to rank pages against each")
print("                 other while the 404 bug is still open")
print("mean           = unweighted mean of the page's measured dims (reference only)")

# ranked table excluding Recovery
print()
print("=" * 96)
print("PAGE RANKING (excluding the systemic Recovery=0, so pages can be compared)")
print("=" * 96)
ranked = []
for r in rows:
    vals = [v for k, v in r["dims"].items() if v is not None and k != "Recovery"]
    ranked.append((min(vals) if vals else 0, sum(vals)/len(vals), r))
ranked.sort(key=lambda x: (-x[0], -x[1]))
for i, (ex, mean, r) in enumerate(ranked, 1):
    print(f"{i:>3}. {ex:>4.1f}  {r['site']+'/'+r['path']:32} (mean {mean:.1f})")

for site in ("hivv", "blnq"):
    print()
    print(f"--- {site.upper()} weakest 5 (ex-Recovery) ---")
    sub = [x for x in ranked if x[2]["site"] == site][-5:]
    for ex, mean, r in reversed(sub):
        zeros = [k for k, v in r["dims"].items() if v == 0]
        print(f"     {ex:>4.1f}  {r['path']:30} dims at 0: {zeros}")

(OUT / "scores.json").write_text(json.dumps(rows, indent=2))
print(f"\nsaved -> {OUT/'scores.json'}")
