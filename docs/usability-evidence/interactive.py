#!/usr/bin/env python3
"""Test the interactive journeys: does chat actually work, and what does the
user see when things go wrong (no network, no account, unknown page)?"""
import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path("/tmp/opencode/usability")
S = OUT / "interactive"; S.mkdir(parents=True, exist_ok=True)
R = []

def snap(p, n):
    q = S / f"{n}.png"
    try: p.screenshot(path=str(q), full_page=True); return str(q)
    except Exception as e: return f"ERR {e}"

with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])

    # ── 1. Does chat actually answer? ────────────────────────────────
    rec = {"id": "I1", "test": "Send a real chat message end-to-end"}
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    try:
        pg.goto("https://hivv.org/chat/", wait_until="domcontentloaded", timeout=30000)
        pg.wait_for_timeout(2000)
        ta = pg.query_selector("textarea")
        if not ta:
            rec.update(result="NO INPUT", ok=False)
        else:
            ta.fill("Say hello in exactly five words.")
            pg.wait_for_timeout(400)
            # find send button
            send = pg.query_selector("button[aria-label*='end' i], button[title*='end' i]")
            if send: send.click()
            else: pg.keyboard.press("Enter")
            t0 = time.time()
            # wait for any response text to appear
            responded = False
            first_text = ""
            while time.time() - t0 < 45:
                pg.wait_for_timeout(1000)
                body = pg.inner_text("body")
                # crude: look for text beyond the placeholder/suggestions
                if "Say hello in exactly five words." in body:
                    tail = body.split("Say hello in exactly five words.")[-1][:400].strip()
                    if len(tail) > 20 and "Ask HIVV" not in tail[:60]:
                        responded = True; first_text = tail; break
            rec.update(ok=responded, seconds=round(time.time()-t0, 1),
                       reply=first_text[:300], shot=snap(pg, "I1-chat-reply"))
            if not responded:
                rec["diag"] = pg.inner_text("body")[-600:]
    except Exception as e:
        rec.update(ok=False, error=str(e)[:200])
    R.append(rec); print(json.dumps(rec, indent=2)[:900], flush=True)

    # ── 2. What does a 404 look like? ────────────────────────────────
    rec = {"id": "I2", "test": "Hit a page that doesn't exist"}
    try:
        pg.goto("https://hivv.org/this-page-does-not-exist-xyz",
                wait_until="domcontentloaded", timeout=30000)
        pg.wait_for_timeout(1500)
        t = pg.inner_text("body")
        rec.update(status=pg.url, text=t[:500], shot=snap(pg, "I2-404"),
                   has_home_link=bool(pg.query_selector("a[href='/'],a[href='/index.html']")),
                   has_search=bool(pg.query_selector("input[type=search]")),
                   ok="not found" in t.lower() or "404" in t)
    except Exception as e:
        rec.update(error=str(e)[:200])
    R.append(rec); print(json.dumps(rec, indent=2)[:700], flush=True)

    # ── 3. What happens if the network drops mid-page? ───────────────
    rec = {"id": "I3", "test": "Simulate network failure (offline)"}
    try:
        ctx2 = b.new_context(viewport={"width": 1440, "height": 900})
        pg2 = ctx2.new_page()
        pg2.goto("https://hivv.org/", wait_until="domcontentloaded", timeout=30000)
        pg2.wait_for_timeout(1200)
        ctx2.set_offline(True)
        # click a nav link while offline
        clicked = None
        for sel in ["a[href='/nodes.html']", "a[href='/status.html']", "a[href='/chat/']"]:
            el = pg2.query_selector(sel)
            if el:
                try:
                    el.click(timeout=4000); clicked = sel; break
                except Exception: pass
        pg2.wait_for_timeout(2500)
        t = pg2.inner_text("body")
        rec.update(clicked=clicked, url=pg2.url,
                   shows_error=("ERR_INTERNET_DISCONNECTED" in pg2.content()
                                or "offline" in t.lower() or "failed" in t.lower()
                                or "cannot" in t.lower() or "unable" in t.lower()),
                   shot=snap(pg2, "I3-offline"), text=t[:350])
        ctx2.close()
    except Exception as e:
        rec.update(error=str(e)[:200])
    R.append(rec); print(json.dumps(rec, indent=2)[:700], flush=True)

    # ── 4. Signed-out: can a guest do anything? ──────────────────────
    rec = {"id": "I4", "test": "Guest tries to approve a MAYBE permission"}
    try:
        pg.goto("https://hivv.org/hivv-dashboard.html", wait_until="domcontentloaded", timeout=30000)
        pg.wait_for_timeout(2200)
        t = pg.inner_text("body").lower()
        rec.update(
            spectator="spectator" in t or "guest" in t,
            signin_cta=bool(pg.query_selector("a[href*='account'],button:has-text('Sign In')")),
            approve_buttons=pg.eval_on_selector_all(
                "button", "els=>els.map(e=>(e.innerText||'').trim())"
                          ".filter(t=>/approve|deny|allow|reject|revoke/i.test(t))"),
            shot=snap(pg, "I4-guest"),
            banner=[x for x in pg.inner_text("body").split("\n")
                    if "sign in" in x.lower() or "spectator" in x.lower()][:4])
    except Exception as e:
        rec.update(error=str(e)[:200])
    R.append(rec); print(json.dumps(rec, indent=2)[:800], flush=True)

    # ── 5. Is there ANY help for a lost user? ────────────────────────
    rec = {"id": "I5", "test": "Find onboarding/help affordances sitewide"}
    helps = {}
    for site, base, pages in [("hivv", "https://hivv.org", ["index.html","chat/index.html","nodes.html","hivv-dashboard.html"]),
                              ("blnq", "https://blnq.org", ["index.html","run.html","submit.html"])]:
        for p in pages:
            try:
                pg.goto(f"{base}/{p}", wait_until="domcontentloaded", timeout=30000)
                pg.wait_for_timeout(1200)
                body = pg.inner_text("body").lower()
                helps[f"{site}/{p}"] = {
                    "tour": any(k in body for k in ["take a tour","guided tour","start tour","walkthrough","get started"]),
                    "tooltip_help": bool(pg.query_selector("[data-tooltip],[title*='?' i]")),
                    "faq": "faq" in body or "frequently asked" in body,
                    "first_run_hint": any(k in body for k in ["first time","new here","start here","welcome"]),
                    "undo": any(k in body for k in ["undo","revert","roll back","restore"]),
                }
            except Exception as e:
                helps[f"{site}/{p}"] = {"error": str(e)[:80]}
    rec["pages"] = helps
    R.append(rec)
    print(json.dumps(rec, indent=2)[:1400], flush=True)

    ctx.close(); b.close()

(OUT / "interactive.json").write_text(json.dumps(R, indent=2))
print(f"\nsaved {len(R)} -> {OUT/'interactive.json'}")
