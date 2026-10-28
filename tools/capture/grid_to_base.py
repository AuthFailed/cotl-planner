#!/usr/bin/env python3
"""Replace the cells in public/data/base.json with the game's own runtime grid.

grid.json comes from the capture plugin: per land level (0 = no expansion bought .. 3 = all),
the PlacementRegion grid as [x, y, occupied] cells. Occupied cells (the bridge strip the game
reserves once land is bought) are left out, since nothing can be built there.
With the plugin's structures.json as a second argument it also records "defaults": buildings
every base starts with. Only the Temple qualifies (it can't be deleted, only moved, and every
save has one); its spot comes from the save, as the first tier.
Usage: python3 tools/capture/grid_to_base.py <grid.json> [structures.json]
"""
import json
import os
import sys

levels = json.load(open(sys.argv[1]))
path = os.path.join(os.path.dirname(__file__), "..", "..", "public", "data", "base.json")
base = json.load(open(path))

blocked = {(x, y) for level in levels for x, y, occupied in level if occupied}
sets = [{(x, y) for x, y, _ in level} - blocked for level in levels]
base["tiles"] = sorted(sets[0])
base["expansions"] = [sorted(sets[i] - sets[i - 1]) for i in range(1, len(sets))]
if len(sys.argv) > 2:
    temple = [r for r in json.load(open(sys.argv[2])) if r["type"] in ("TEMPLE", "TEMPLE_II", "TEMPLE_III", "TEMPLE_IV")]
    base["defaults"] = [{"type": "TEMPLE", "x": r["x"], "y": r["y"]} for r in temple[:1]]
json.dump(base, open(path, "w"), separators=(",", ":"))
print(f"{len(base['tiles'])} cells, expansions add {[len(e) for e in base['expansions']]}, {len(blocked)} bridge cells left out")
