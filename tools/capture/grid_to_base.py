#!/usr/bin/env python3
"""Replace the cells in data/base.json with the game's own runtime grid.

grid.json comes from the capture plugin: per land level (0 = no expansion bought .. 3 = all),
the PlacementRegion grid as [x, y, occupied] cells. Occupied cells (the bridge strip the game
reserves once land is bought) are left out, since nothing can be built there.
Usage: python3 tools/capture/grid_to_base.py <grid.json>
"""
import json
import os
import sys

levels = json.load(open(sys.argv[1]))
path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "base.json")
base = json.load(open(path))

blocked = {(x, y) for level in levels for x, y, occupied in level if occupied}
sets = [{(x, y) for x, y, _ in level} - blocked for level in levels]
base["tiles"] = sorted(sets[0])
base["expansions"] = [sorted(sets[i] - sets[i - 1]) for i in range(1, len(sets))]
json.dump(base, open(path, "w"), separators=(",", ":"))
print(f"{len(base['tiles'])} cells, expansions add {[len(e) for e in base['expansions']]}, {len(blocked)} bridge cells left out")
