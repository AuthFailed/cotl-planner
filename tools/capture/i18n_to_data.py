#!/usr/bin/env python3
"""Turn the capture plugin's i18n.json (every term the game ships) into public/data/i18n/: index.json
lists the languages, and <code>.json holds one language's
  names  structure type -> name           (Structures/<TYPE>)
  desc   structure type -> description    (Structures/<TYPE>/Description, as plain text)
  terms  build-menu tab and section titles (the term keys in public/data/game.json "menu")
  ui     the planner's own strings         (tools/i18n/ui.json, written by hand)
Empty values are left out; the page falls back to English for them. Columns that are translator
notes, not languages (Description, Comments, VO, ...), are dropped.
Usage: python3 tools/capture/i18n_to_data.py <i18n.json>
"""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
RTL = {"ar"}
LIST_SEP = {"ja": "、", "zh-CN": "、", "zh-TW": "、", "ar": "، "}
# Inline icons the game draws in descriptions. Most follow the word they picture ("Devotion <icon>")
# and are dropped; a few stand in for the word ("will generate <icon>"), so they become the item's name.
ICON_TERMS = {
    "icon_stone": "Inventory/STONE", "icon_wood": "Inventory/LOG", "icon_LogRefined": "Inventory/LOG_REFINED",
    "icon_StoneRefined": "Inventory/STONE_REFINED", "icon_GoldRefined": "Inventory/GOLD_REFINED",
    "icon_MagmaStone": "Inventory/MAGMA_STONE", "icon_spirits": "Inventory/SOUL",
    "icon_LightningShard": "Inventory/LIGHTNING_SHARD", "icon_meat": "Inventory/MEAT",
}
SPRITE = re.compile(r'<sprite name="?([^">]+)"?>')
COLOR = re.compile(r"</?color[^>]*>")

src = json.load(open(sys.argv[1]))
game = json.load(open(os.path.join(ROOT, "public", "data", "game.json")))
ui = json.load(open(os.path.join(ROOT, "tools", "i18n", "ui.json")))
terms = src["terms"]
columns = [(i, l) for i, l in enumerate(src["languages"]) if l["code"] and l["code"] != "vo"]
EN = next(i for i, l in columns if l["code"] == "en")


def value(key, col):
    row = terms.get(key) or []
    return row[col].strip() if col < len(row) else ""


def standalone(en):
    """For each inline icon in the English text: does it stand in for a word (vs. follow one)?"""
    flags, last = [], 0
    for m in SPRITE.finditer(en):
        before = COLOR.sub("", en[:m.start()]).rstrip(" ")
        follows_icon = bool(flags) and flags[-1] and en[last:m.start()].strip() == ""
        flags.append(before.endswith(("generate", ":")) or follows_icon)
        last = m.end()
    return flags


def plain(text, col, flags, sep):
    icons = iter(flags)

    def icon(m):
        stands, term = next(icons, False), ICON_TERMS.get(m.group(1), "")
        name = value(term, col) or value(term, EN)
        return f"\x00{name}\x01" if stands and name else ""

    out = SPRITE.sub(icon, COLOR.sub("", text))
    out = re.sub(r"\x01[ \t]*\x00", sep, out)  # item names side by side become a list
    out = out.replace("\x00", "").replace("\x01", "")
    out = re.sub(r"\s*<br\s*/?>\s*", "\n", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return re.sub(r" +([.,!?;。、])", r"\1", out).strip()


menu_terms = {tab["term"] for tab in game["menu"]} | {s["term"] for tab in game["menu"] for s in tab["sections"]}
out_dir = os.path.join(ROOT, "public", "data", "i18n")
os.makedirs(out_dir, exist_ok=True)
index = []
for col, lang in columns:
    code = lang["code"]
    names, desc = {}, {}
    for T in game["types"]:
        if n := value(f"Structures/{T}", col):
            names[T] = n
        en, d = value(f"Structures/{T}/Description", EN), value(f"Structures/{T}/Description", col)
        if d:  # icons are matched to the English ones by position, so only when the counts agree
            desc[T] = plain(d, col, standalone(en) if len(SPRITE.findall(d)) == len(SPRITE.findall(en)) else [],
                            LIST_SEP.get(code, ", "))
    data = {"ui": ui.get(code, {}), "terms": {k: v for k in sorted(menu_terms) if (v := value(k, col))},
            "names": names, "desc": desc}
    json.dump(data, open(os.path.join(out_dir, f"{code}.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    index.append({"code": code, "name": lang["name"], **({"dir": "rtl"} if code in RTL else {})})
    print(f"{code:6} {len(names)} names, {len(desc)} descriptions, {len(data['terms'])} menu terms, {len(data['ui'])} ui strings")
json.dump(index, open(os.path.join(out_dir, "index.json"), "w"), ensure_ascii=False, separators=(",", ":"))
