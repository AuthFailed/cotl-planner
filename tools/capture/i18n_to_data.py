#!/usr/bin/env python3
"""Turn the capture plugin's i18n.json into data/i18n.json: each structure type's name in
every language the game ships, as {"languages": [{code, name}], "names": {TYPE: [...]}} with
names in the same order as languages. Columns that are translator notes, not languages
(Description, Comments, VO, ...), are dropped.
Usage: python3 tools/capture/i18n_to_data.py <i18n.json>
"""
import json
import os
import sys

src = json.load(open(sys.argv[1]))
data = os.path.join(os.path.dirname(__file__), "..", "..", "data")
types = json.load(open(os.path.join(data, "game.json")))["types"]

columns = [(i, l) for i, l in enumerate(src["languages"]) if l["code"] and l["code"] != "vo"]
names = {}
for term, values in src["terms"].items():
    t = term.split("/")
    if len(t) == 2 and t[1] in types:
        row = [values[i].strip() if i < len(values) else "" for i, _ in columns]
        if row[0]:  # an English name is the minimum
            names[t[1]] = row

json.dump({"languages": [{"code": l["code"], "name": l["name"]} for _, l in columns], "names": names},
          open(os.path.join(data, "i18n.json"), "w"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(names)} names in {len(columns)} languages: {', '.join(l['code'] for _, l in columns)}")
