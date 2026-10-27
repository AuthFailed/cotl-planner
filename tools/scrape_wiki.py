#!/usr/bin/env python3
"""Regenerate data/buildings.json from the Cult of the Lamb fandom wiki.

Names, categories and icons come from the "Buildings" page tables; footprint
size comes from each building page's {{Infobox structure|size=WxH}}.
Usage: python3 tools/scrape_wiki.py > data/buildings.json
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

API = "https://cult-of-the-lamb.fandom.com/api.php"
SKIP_SECTIONS = {"Unused Buildings"}
OVERRIDES = os.path.join(os.path.dirname(__file__), "..", "data", "overrides.json")


def api(**params):
    params["format"] = "json"
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": "cotl-planner"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def infobox_field(text, name):
    m = re.search(r"\|\s*" + name + r"\s*=\s*([^|}\n]*)", text)
    return m.group(1).strip() if m else ""


def main():
    text = api(action="parse", page="Buildings", prop="wikitext")["parse"]["wikitext"]["*"]
    rows, group, sub, row_start = [], "", "", False
    for line in text.splitlines():
        h = re.match(r"^(=+)\s*(.*?)\s*=+\s*$", line)
        if h:
            if len(h.group(1)) == 2:
                group, sub = h.group(2), ""
            else:
                sub = h.group(2)
            continue
        if line.startswith("|-"):
            row_start = True
            continue
        # first cell after "|-" is the [[Name]] link, the next is its [[File:icon]]
        m = re.match(r"^\|\s*\[\[(?!File:)([^\]|#]+)(?:\|[^\]]*)?\]\]", line)
        if row_start and m and group and sub not in SKIP_SECTIONS:
            rows.append({"name": m.group(1).strip(), "group": group, "category": sub or group})
            row_start = False
            continue
        icon = re.search(r"\[\[File:([^|\]]+)", line)
        if icon and rows and "icon" not in rows[-1]:
            rows[-1]["icon"] = icon.group(1).strip()
        row_start = False

    # dedupe by name, keep first occurrence
    seen, buildings = set(), []
    for r in rows:
        if r["name"] not in seen:
            seen.add(r["name"])
            buildings.append(r)

    pages = {}
    names = [b["name"] for b in buildings]
    for i in range(0, len(names), 50):
        res = api(action="query", prop="revisions", rvprop="content", rvslots="main", redirects=1, titles="|".join(names[i:i + 50]))
        redirects = {r["to"]: r["from"] for r in res["query"].get("redirects", [])}
        for p in res["query"]["pages"].values():
            if "revisions" in p:
                pages[redirects.get(p["title"], p["title"])] = p["revisions"][0]["slots"]["main"]["*"]

    for b in buildings:
        page = pages.get(b["name"], "")
        size = re.match(r"(\d+)\s*x\s*(\d+)", infobox_field(page, "size"))
        b["w"], b["h"] = (int(size.group(1)), int(size.group(2))) if size else (None, None)
        b["id"] = infobox_field(page, "id") or None
        b["once"] = infobox_field(page, "built_once") == "1"

    # Direct CDN URLs: the Special:FilePath redirect doesn't load as an <img> on other sites.
    files = sorted({b["icon"] for b in buildings if b.get("icon")})
    urls = {}
    for i in range(0, len(files), 50):
        res = api(action="query", prop="imageinfo", iiprop="url", titles="|".join("File:" + f for f in files[i:i + 50]))
        norm = {n["to"]: n["from"] for n in res["query"].get("normalized", [])}
        for p in res["query"]["pages"].values():
            if "imageinfo" in p:
                urls[norm.get(p["title"], p["title"])[5:]] = p["imageinfo"][0]["url"]
    for b in buildings:
        b["icon"] = urls.get(b.get("icon"))

    # Fill gaps: hand-verified overrides first, then an upgrade inherits its base
    # tier's size ("Morgue II" <- "Morgue"), else 1x1 flagged as a guess.
    overrides = json.load(open(OVERRIDES)) if os.path.exists(OVERRIDES) else {}
    by_name = {b["name"]: b for b in buildings}
    for b in buildings:
        if b["name"] in overrides:
            b.update(overrides[b["name"]])
        if b["w"] is None:
            base = by_name.get(re.sub(r"\s+I+$", "", b["name"]))
            if base and base["w"]:
                b["w"], b["h"] = base["w"], base["h"]
            else:
                b["w"], b["h"], b["guess"] = 1, 1, True

    json.dump(buildings, sys.stdout, indent=1, ensure_ascii=False)
    print(f"{len(buildings)} buildings, {sum(b.get('guess', False) for b in buildings)} with guessed size", file=sys.stderr)


if __name__ == "__main__":
    main()
