#!/usr/bin/env python3
"""Walk real user journeys and record what a first-timer actually hits.

Each journey: click path, whether the goal was reached, dead ends, friction.
"""
import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path("/tmp/opencode/usability")
SHOTS = OUT / "journeys"
SHOTS.mkdir(parents=True, exist_ok=True)

def snap(page, name):
    p = SHOTS / f"{name}.png"
    try:
        page.screenshot(path=str(p), full_page=True)
        return str(p)
    except Exception as e:
        return f"ERR {e}"

def txt(page, sel="body"):
    try:
        return page.inner_text(sel, timeout=3000)
    except Exception:
        return ""

JOURNEYS = []

def journey(js_id, title, site):
    """Collects a journey record; steps/confusions are appended inline."""
    rec = {"id": js_id, "title": title, "site": site,
           "steps": [], "reached": False, "confusions": [], "help_needed": []}
    JOURNEYS.append(rec)
    return rec

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()

    # ── J1: First-time visitor, HIVV — can they START A CONVERSATION? ──
    r = journey("J1", "First-timer starts an AI conversation", "hivv")
    try:
        page.goto("https://hivv.org/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1500)
        r["steps"].append({"step": "land on hivv.org", "shot": snap(page, "J1-1-home"),
                           "h1": page.eval_on_selector_all("h1", "e=>e.map(x=>x.innerText)"),
                           "words": len(txt(page).split())})
        # can we find a clear path to chat?
        chat_links = page.eval_on_selector_all(
            "a[href*='chat']",
            "els=>els.map(e=>({t:(e.innerText||'').trim().slice(0,50), h:e.getAttribute('href')}))")
        r["steps"].append({"step": "links mentioning chat", "found": chat_links[:8]})
        if chat_links:
            page.click(f"a[href='{chat_links[0]['h']}']", timeout=8000)
            page.wait_for_timeout(2000)
            r["steps"].append({"step": "clicked first chat link", "url": page.url,
                               "shot": snap(page, "J1-2-chat")})
            # is there an input to type into?
            inputs = page.eval_on_selector_all(
                "textarea,input[type=text]",
                "els=>els.map(e=>({tag:e.tagName, ph:e.placeholder||'', vis:e.offsetParent!==null}))")
            r["steps"].append({"step": "inputs on chat page", "inputs": inputs[:6]})
            visible = [i for i in inputs if i["vis"]]
            r["reached"] = bool(visible)
            if not visible:
                r["confusions"].append("chat page has no visible text input")
        else:
            r["confusions"].append("NO link to chat found from homepage")
    except Exception as e:
        r["confusions"].append(f"journey error: {str(e)[:160]}")

    # ── J2: Understand the routing modes ──
    r = journey("J2", "Understand AI routing options (fast/cheap/private/smart)", "hivv")
    try:
        page.goto("https://hivv.org/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1200)
        body = txt(page).lower()
        modes = ["balanced", "quality", "fast", "cost", "private", "trusted",
                 "smart", "cheap", "auto"]
        found = [m for m in modes if m in body]
        r["steps"].append({"step": "homepage mentions modes", "found": found})
        # does the homepage EXPLAIN what a routing mode is?
        expl = any(k in body for k in ["routing mode", "how your request", "where your",
                                       "route your", "which ai", "picks the"])
        r["steps"].append({"step": "homepage explains routing in plain words", "found": expl})
        # check chat page
        page.goto("https://hivv.org/chat/index.html", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1800)
        cbody = txt(page).lower()
        r["steps"].append({"step": "chat page mode mentions",
                           "found": [m for m in modes if m in cbody]})
        # click the settings/gear to see if modes live there
        gear = page.query_selector("button[title*='ettings'], button[aria-label*='ettings']")
        if gear:
            gear.click(); page.wait_for_timeout(900)
            r["steps"].append({"step": "opened chat settings", "shot": snap(page, "J2-settings"),
                               "text": txt(page)[:700]})
        r["reached"] = bool([m for m in modes if m in cbody])
        if not r["reached"]:
            r["confusions"].append("no routing mode control visible on the chat page")
    except Exception as e:
        r["confusions"].append(f"journey error: {str(e)[:160]}")

    # ── J3: Find YES / MAYBE / NO permission controls ──
    r = journey("J3", "Find and understand YES/MAYBE/NO permissions", "hivv")
    try:
        # where does a normal user even look? try control.html and dashboard
        for path in ["control.html", "dashboard.html", "hivv-dashboard.html", "index.html"]:
            page.goto(f"https://hivv.org/{path}", wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1200)
            b = txt(page).lower()
            has = {k: (k in b) for k in ["maybe", "approve", "permission", "grant", "revoke"]}
            r["steps"].append({"step": f"scan /{path}", "keywords": has})
            if has["maybe"]:
                r["reached"] = True
                r["steps"].append({"step": "FOUND on this page", "shot": snap(page, f"J3-{path}")})
                break
        if not r["reached"]:
            r["confusions"].append("YES/MAYBE/NO language not found on any obvious page")
            r["help_needed"].append("user would have to know to run `hivv policy` in a terminal")
    except Exception as e:
        r["confusions"].append(f"journey error: {str(e)[:160]}")

    # ── J4: Understand where my information goes ──
    r = journey("J4", "Understand where my data goes", "hivv")
    try:
        page.goto("https://hivv.org/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1000)
        links = page.eval_on_selector_all(
            "a[href*='privacy'],a[href*='terms'],a[href*='aup']",
            "els=>els.map(e=>({t:(e.innerText||'').trim().slice(0,40),h:e.getAttribute('href')}))")
        r["steps"].append({"step": "privacy links on homepage", "found": links})
        if links:
            page.click(f"a[href='{links[0]['h']}']", timeout=8000)
            page.wait_for_timeout(1200)
            b = txt(page)
            r["steps"].append({"step": "privacy page", "shot": snap(page, "J4-privacy"),
                               "words": len(b.split()),
                               "first_400": b[:400]})
            # is it readable or legal boilerplate?
            simple = any(k in b.lower() for k in ["your prompts", "your data", "we do not",
                                                   "never sold", "where your data", "leaves your"])
            r["reached"] = simple
            if not simple:
                r["confusions"].append("privacy page does not plainly say where prompts go")
        else:
            r["confusions"].append("no privacy link visible on homepage")
    except Exception as e:
        r["confusions"].append(f"journey error: {str(e)[:160]}")

    # ── J5: Contribute a computer / join the network ──
    r = journey("J5", "Volunteer my computer to the network", "hivv")
    try:
        page.goto("https://hivv.org/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1200)
        body = txt(page)
        # is there an obvious "join" CTA?
        ctas = page.eval_on_selector_all(
            "a.btn,button,a[class*=cta],a[class*=hero] a",
            "els=>els.map(e=>(e.innerText||'').trim()).filter(t=>t).slice(0,20)")
        r["steps"].append({"step": "homepage CTAs", "ctas": ctas})
        low = body.lower()
        has_join = any(k in low for k in ["join the network", "volunteer", "contribute",
                                          "add your machine", "become a bee", "install cli"])
        r["steps"].append({"step": "homepage offers a join path", "found": has_join})
        # follow the most join-like link
        cand = page.eval_on_selector_all(
            "a[href]",
            """els=>els.map(e=>({t:(e.innerText||'').trim().slice(0,40),
                                h:e.getAttribute('href')}))
               .filter(x=>/install|join|volunteer|contribute|connect|bee/i.test(x.t+' '+x.h))
               .slice(0,8)""")
        r["steps"].append({"step": "join-ish links", "found": cand})
        r["reached"] = bool(cand)
        if cand:
            page.click(f"a[href='{cand[0]['h']}']", timeout=8000)
            page.wait_for_timeout(1400)
            r["steps"].append({"step": "followed", "url": page.url, "shot": snap(page, "J5-join")})
            jb = txt(page).lower()
            # does it give a copy-paste command?
            has_cmd = any(x in jb for x in ["hivv start", "curl ", "git clone", "install"])
            r["reached"] = bool(cand) and has_cmd
            r["steps"].append({"step": "shows an install command", "found": has_cmd})
        if not r["reached"]:
            r["confusions"].append("no obvious path from homepage to contributing a machine")
    except Exception as e:
        r["confusions"].append(f"journey error: {str(e)[:160]}")

    # ── J6: BLNQ — submit a job ──
    r = journey("J6", "BLNQ: submit my first job", "blnq")
    try:
        page.goto("https://blnq.org/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1500)
        r["steps"].append({"step": "land on blnq.org", "shot": snap(page, "J6-1-home"),
                           "h1": page.eval_on_selector_all("h1", "e=>e.map(x=>x.innerText)"),
                           "first_400": txt(page)[:400]})
        # find the run/submit path
        cand = page.eval_on_selector_all(
            "a[href]",
            """els=>els.map(e=>({t:(e.innerText||'').trim().slice(0,40),
                                h:e.getAttribute('href')}))
               .filter(x=>/submit|run|start|try/i.test(x.t+' '+x.h)).slice(0,8)""")
        r["steps"].append({"step": "submit-ish links", "found": cand})
        if cand:
            page.click(f"a[href='{cand[0]['h']}']", timeout=8000)
            page.wait_for_timeout(1600)
            r["steps"].append({"step": "followed", "url": page.url, "shot": snap(page, "J6-2-form")})
            inputs = page.eval_on_selector_all(
                "textarea,input[type=text],input[type=file],select",
                """els=>els.map(e=>({tag:e.tagName,type:e.type||'',ph:e.placeholder||'',
                                   lbl:(e.labels&&e.labels[0]&&e.labels[0].innerText||'').slice(0,40),
                                   vis:e.offsetParent!==null}))""")
            r["steps"].append({"step": "form fields", "fields": inputs[:8]})
            vis = [i for i in inputs if i["vis"]]
            r["reached"] = len(vis) > 0
            # is there help text telling them what to write?
            page_words = txt(page).lower()
            r["steps"].append({"step": "page explains what to submit",
                               "found": any(k in page_words for k in
                                            ["paste your", "your code", "what to run",
                                             "describe the job", "example"])})
        if not r["reached"]:
            r["confusions"].append("could not find a submit form from the homepage")
    except Exception as e:
        r["confusions"].append(f"journey error: {str(e)[:160]}")

    # ── J7: Mobile sanity — does the homepage work on a phone? ──
    r = journey("J7", "Mobile: read the homepage on a 390px phone", "hivv")
    try:
        mctx = browser.new_context(viewport={"width": 390, "height": 844},
                                   user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                                               "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"))
        mp = mctx.new_page()
        mp.goto("https://hivv.org/", wait_until="domcontentloaded", timeout=30000)
        mp.wait_for_timeout(1500)
        # horizontal overflow?
        overflow = mp.evaluate("""() => {
          const d=document.documentElement;
          return {scrollW:d.scrollWidth, clientW:d.clientWidth,
                  overflows:d.scrollWidth>d.clientWidth+2};
        }""")
        r["steps"].append({"step": "horizontal overflow", **overflow,
                           "shot": snap(mp, "J7-mobile-home")})
        # tap targets
        small = mp.evaluate("""() => {
          const els=[...document.querySelectorAll('a,button')].filter(e=>e.offsetParent!==null);
          const small=els.filter(e=>{const r=e.getBoundingClientRect();
            return r.height>0 && r.height<24;});
          return {total:els.length, tooSmall:small.length,
                  samples:small.slice(0,6).map(e=>(e.innerText||'').trim().slice(0,25))};
        }""")
        r["steps"].append({"step": "tap targets", **small})
        r["reached"] = not overflow["overflows"]
        if overflow["overflows"]:
            r["confusions"].append(f"homepage scrolls sideways on a phone ({overflow['scrollW']} > {overflow['clientW']})")
        if small["tooSmall"]:
            r["confusions"].append(f"{small['tooSmall']}/{small['total']} tap targets under 24px tall")
        mctx.close()
    except Exception as e:
        r["confusions"].append(f"journey error: {str(e)[:160]}")

    ctx.close()
    browser.close()

(OUT / "journeys.json").write_text(json.dumps(JOURNEYS, indent=2))

print("="*74)
for r in JOURNEYS:
    mark = "PASS" if r["reached"] else "FAIL"
    print(f"\n[{mark}] {r['id']} · {r['title']}  ({r['site']})")
    for c in r["confusions"]:
        print(f"      ✗ {c}")
    for h in r["help_needed"]:
        print(f"      ? {h}")
print(f"\n{sum(1 for r in JOURNEYS if r['reached'])}/{len(JOURNEYS)} journeys completed unaided")
