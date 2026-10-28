#!/usr/bin/env python3
"""Add buildings captured on their own (Buildings with Types set) to the looks already in public/data.

For each look in the capture, the sheets pack_sprites.html wrote to <look>/packed/ (sprites.png, sprites-2.png,
their -lit, @2 and @3 copies) are renamed to the next free sprites-N in that look, and packed/sprites.json and
packed/lights.json are rewritten as the look's own files with the new items (and animations, lights) added, so
looks_to_data.sh then encodes and copies just those.
Usage: python3 tools/capture/add_buildings.py <capture dir>
"""
import json
import os
import re
import sys

cap = sys.argv[1]
data = os.path.join(os.path.dirname(__file__), "..", "..", "public", "data", "looks")
for look in sorted(os.listdir(cap)):
    packed = os.path.join(cap, look, "packed")
    if not os.path.isfile(os.path.join(packed, "sprites.json")):
        continue
    new, old = (json.load(open(os.path.join(d, "sprites.json"))) for d in (packed, os.path.join(data, look)))
    assert new["ppu"] == old["ppu"], f"{look}: packed at {new['ppu']} px per unit, the look has {old['ppu']}"
    used = [i for i, name in enumerate(new["sheets"]) if any((it[6] if len(it) > 6 else 0) == i for it in new["items"].values())]
    index = {}
    for i in used:
        n = 2
        while f"sprites-{n}" in old["sheets"]:
            n += 1
        name = f"sprites-{n}"
        index[i] = len(old["sheets"])
        old["sheets"].append(name)
        for f in os.listdir(packed):  # sprites[-2][-lit][@k].png -> sprites-N[-lit][@k].png
            m = re.fullmatch(re.escape(new["sheets"][i]) + r"((?:-lit)?(?:@\d)?)\.png", f)
            if m:
                os.rename(os.path.join(packed, f), os.path.join(packed, f"{name}{m[1]}.new"))
    for f in os.listdir(packed):
        if f.endswith(".new"):
            os.rename(os.path.join(packed, f), os.path.join(packed, f[:-4] + ".png"))
    for T, it in new["items"].items():
        old["items"][T] = it[:6] + [index[it[6] if len(it) > 6 else 0]]
    if new.get("anim"):
        anim = old.setdefault("anim", {"ppu": new["anim"]["ppu"], "frames": {}, "box": {}, "items": {}})
        for k in ("frames", "box", "items"):
            anim[k].update(new["anim"][k])
    json.dump(old, open(os.path.join(packed, "sprites.json"), "w"), separators=(",", ":"))
    if os.path.isfile(os.path.join(packed, "lights.json")):
        lights = json.load(open(os.path.join(data, look, "lights.json")))
        lights["items"].update(json.load(open(os.path.join(packed, "lights.json")))["items"])
        json.dump(lights, open(os.path.join(packed, "lights.json"), "w"), separators=(",", ":"))
    print(f"{look}: {len(new['items'])} buildings on {', '.join(old['sheets'][index[i]] for i in used)}")
