#!/usr/bin/env python3
"""Generate api/lib/place-tz-data.js from the system's IANA tzdata.

WHY THIS IS GENERATED, NOT HAND-WRITTEN
---------------------------------------
The hub has to answer "what time is it in Jinja, Uganda?" — which means
turning a PLACE the user typed into an IANA timezone the clock understands.
There are 249 countries and 418 zones. Hand-typing that table is exactly the
kind of thing that goes quietly wrong: one transposed country code and a
question about Uganda silently answers in the wrong hemisphere.

The canonical source already ships with tzdata itself:

    /usr/share/zoneinfo/iso3166.tab   "UG\tUganda"
    /usr/share/zoneinfo/zone.tab      "UG\t+00323+03234\tAfrica/Kampala"

so we read those and emit a committed JS module. Windows has no zone.tab —
that is fine: the OUTPUT is committed to the repo, so every platform reads the
same generated table and nobody needs tzdata at runtime.

    python3 scripts/gen-place-tz.py            # write the module
    python3 scripts/gen-place-tz.py --check    # exit 1 if it is out of date

WHAT IS NOT GENERATED
---------------------
Two things live in api/lib/place-tz.js instead, because they are JUDGEMENT,
not data:

  * country aliases  — tzdata says "Russian Federation"; people type "russia".
  * the primary zone — 31 countries span several zones (the US has 29!). A
    table can say "these29 zones belong to US"; only a human can say that a
    bare "the USA" most likely means America/New_York.

The output is deterministic (no timestamps) so `--check` is a byte compare.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, "api", "lib", "place-tz-data.js")

# NOTE: ZONE_TAB / ISO_TAB are defined below, next to the snapshot they
# default to — see the comment on _SNAPSHOT.


def die(msg):
    print(f"gen-place-tz: {msg}", file=sys.stderr)
    sys.exit(2)


# THE INPUTS ARE VENDORED (2026-11-28).
#
# These used to default to the SYSTEM's /usr/share/zoneinfo, so `--check`
# regenerated from WHATEVER tzdata the machine running it happened to have
# and byte-compared against the committed file. On any box whose tzdata
# differed from the generator's, it died with exit 2 — which is exactly what
# CI did, on BOTH ubuntu and macos. The data was not wrong; the INPUT was
# unpinned. A generated artifact must be reproducible from what the repo
# ships, or it is not reproducible at all.
#
# Refresh deliberately, so a tzdata update is a REVIEWED diff instead of a
# red build on somebody else's runner:
#     python3 scripts/gen-place-tz.py --refresh-tzdata
_SNAPSHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tzdata")
_SNAP_ZONE_TAB = os.path.join(_SNAPSHOT, "zone.tab")
_SNAP_ISO_TAB = os.path.join(_SNAPSHOT, "iso3166.tab")

# The SYSTEM copies --refresh-tzdata reads from.
SYSTEM_ZONE_TAB = "/usr/share/zoneinfo/zone.tab"
SYSTEM_ISO_TAB = "/usr/share/zoneinfo/iso3166.tab"

# Effective inputs: an explicit env override still wins (the test suite sets
# it), otherwise the snapshot the repo ships.
ZONE_TAB = os.environ.get("HIVV_ZONE_TAB", _SNAP_ZONE_TAB)
ISO_TAB = os.environ.get("HIVV_ISO_TAB", _SNAP_ISO_TAB)


def refresh_tzdata():
    """Copy the SYSTEM's tabs into the snapshot, then regenerate.

    Deliberate and human-run: a tzdata update becomes a reviewed change
    instead of a red build wherever the runner's tzdata happens to differ.
    """
    import shutil
    for src, dst in ((SYSTEM_ZONE_TAB, _SNAP_ZONE_TAB),
                     (SYSTEM_ISO_TAB, _SNAP_ISO_TAB)):
        if not os.path.exists(src):
            die(f"no system {src} to refresh from — install tzdata first")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
    # Regenerate from the snapshot we just wrote, whatever env was set.
    global ZONE_TAB, ISO_TAB
    ZONE_TAB, ISO_TAB = _SNAP_ZONE_TAB, _SNAP_ISO_TAB
    print(f"gen-place-tz: refreshed {os.path.dirname(SYSTEM_ZONE_TAB)} -> {_SNAPSHOT}")


def read_tab(path):
    """Yield non-comment, non-empty lines of a tzdata .tab file."""
    if not os.path.exists(path):
        die(f"missing {path} — set HIVV_ZONE_TAB/HIVV_ISO_TAB, or install tzdata")
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            yield line


def build():
    # iso3166.tab: "UG\tUganda"
    names = {}
    for line in read_tab(ISO_TAB):
        parts = line.split("\t")
        if len(parts) >= 2:
            names[parts[0]] = parts[1]

    # zone.tab: "UG\t+00323+03234\tAfrica/Kampala"
    countries = {}
    zone_city = {}
    zone_owner = {}
    seen_city = {}

    for line in read_tab(ZONE_TAB):
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        code, zone = parts[0], parts[2]
        countries.setdefault(code, []).append(zone)
        zone_owner.setdefault(zone, code)

        # The LAST segment of a zone name is a city people actually type:
        # "Asia/Karachi" -> "karachi", "Africa/Kampala" -> "kampala".
        # "America/Argentina/Buenos_Aires" -> "buenos_aires".
        city = zone.split("/")[-1].lower()
        seen_city.setdefault(city, []).append(zone)

    # Only keep a city key when it points at exactly ONE zone. "kolkata" and
    # "calcutta" both exist but "istanbul" appearing twice would be a guess.
    for city, zones in seen_city.items():
        if len(zones) == 1:
            zone_city[city] = zones[0]

    # Deterministic key order: countries by code, cities alphabetically.
    out_countries = {
        code: {"name": names.get(code, code), "zones": zones}
        for code, zones in sorted(countries.items())
    }
    out_cities = {k: zone_city[k] for k in sorted(zone_city)}

    # Every zone we reference must be one Intl will accept.
    all_zones = sorted({z for zs in out_countries.values() for z in zs["zones"]})
    return out_countries, out_cities, all_zones


def render(countries, cities, zones):
    def js(obj, indent=0):
        """Tiny deterministic JSON-ish renderer with 2-space indentation."""
        pad = "  " * indent
        if isinstance(obj, dict):
            if not obj:
                return "{}"
            items = []
            for k, v in obj.items():
                items.append(f"{pad}  {json_key(k)}: {js(v, indent + 1)}")
            return "{\n" + ",\n".join(items) + f"\n{pad}}}"
        if isinstance(obj, list):
            if not obj:
                return "[]"
            return "[" + ", ".join(json_key(x) if isinstance(x, str) else js(x, indent) for x in obj) + "]"
        if isinstance(obj, str):
            return json_str(obj)
        return str(obj)

    body = (
        "// GENERATED by scripts/gen-place-tz.py — do not edit by hand.\n"
        "// Source: scripts/tzdata/{iso3166.tab,zone.tab} — an IANA tzdata SNAPSHOT\n"
        "//         (public domain), vendored so this file reproduces on any machine.\n"
        "//         Refresh deliberately: python3 scripts/gen-place-tz.py --refresh-tzdata\n"
        "// Regenerate: python3 scripts/gen-place-tz.py   (--check to verify)\n"
        "//\n"
        "// This file is machine-written: reformatting it would only fight the\n"
        "// generator on the next run, so lint stands down for it.\n"
        "/* eslint-disable */\n"
        "//\n"
        "// COUNTRIES  ISO-3166 alpha-2 -> { name, zones[] }  (zones[] is EVERY zone the\n"
        "//            country spans — 31 countries span more than one, the US has 29).\n"
        "// ZONE_CITY  lower-cased last segment of a zone name -> that zone, kept only\n"
        "//            where it is unambiguous.\n"
        "// ZONES      every zone, for validation and for 'did you mean' hints.\n"
        "'use strict';\n\n"
        f"const COUNTRIES = {js(countries)};\n\n"
        f"const ZONE_CITY = {js(cities)};\n\n"
        f"const ZONES = {js(zones)};\n\n"
        "module.exports = { COUNTRIES, ZONE_CITY, ZONES };\n"
    )
    return body


def json_key(k):
    # ALWAYS quote. A key that happens to be a JS reserved word ("class",
    # "delete", …) is still a perfectly good city or country code — quoting
    # costs nothing and removes a whole class of silent breakage.
    return json_str(k)


def json_str(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def main(argv):
    if "--refresh-tzdata" in argv:
        refresh_tzdata()          # copy the system tabs in, then regenerate
    check = "--check" in argv
    countries, cities, zones = build()
    text = render(countries, cities, zones)

    if check:
        if not os.path.exists(OUT):
            die(f"{OUT} does not exist — run scripts/gen-place-tz.py")
        with open(OUT, "r", encoding="utf-8") as fh:
            current = fh.read()
        if current != text:
            die(f"{OUT} is out of date — run scripts/gen-place-tz.py")
        print(f"gen-place-tz: up to date ({len(countries)} countries, {len(cities)} cities, {len(zones)} zones)")
        return 0

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(text)
    multi = sum(1 for c in countries.values() if len(c["zones"]) > 1)
    print(f"gen-place-tz: wrote {OUT} — {len(countries)} countries ({multi} multi-zone), "
          f"{len(cities)} city keys, {len(zones)} zones")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
