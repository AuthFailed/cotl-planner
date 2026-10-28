"""Write the buildings' range indicators into public/data/game.json ("ranges").

Usage: python3 tools/capture/ranges_to_data.py <capture dir>/ranges.json

The capture plugin's Ranges job lists each structure's range indicator as its prefab has it. They are all
the same sliced square outline, turned with the grid, so a range is a square of `size` cells, centred `at`
cells along the grid's diagonal from the building's first cell (the prefab sits there; world up is +x +y).
Most scripts resize the sprite as they wake up; those sizes, read from the game's code, win over the prefab's.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
K = 0.70710678

# SpriteRenderer.size the scripts set (both sides the same)
CODE = {
    "SCARECROW": 9, "SCARECROW_2": 11,  # Scarecrow.EFFECTIVE_DISTANCE
    "SHRINE_PASSIVE": 4, "SHRINE_PASSIVE_II": 6, "SHRINE_PASSIVE_III": 8,  # Structures_Shrine_Passive.Range
    "WOLF_TRAP": 7,  # Interaction_WolfTrap.OnEnableInteraction
    "FURNACE_1": 3, "FURNACE_2": 6, "FURNACE_3": 10,  # Interaction_DLCFurnace.GetCurrentRange
}
# The crop grower's square sits 3.5 cells out towards the way it faces, which the planner doesn't have.
SKIP = {"FARM_CROP_GROWER"}

ranges = {}
for T, found in json.load(open(sys.argv[1])).items():
    if T in SKIP:
        continue
    r = next((f for f in found if f["prefab"] == "building"), found[0])
    w, h = r["size"]
    assert r["mode"] == "Sliced" and w == h and abs(r["right"][0] - K) < 1e-3, f"{T}: not a square turned with the grid"
    ranges[T] = {"size": CODE.get(T, w), "at": round(r["pos"][1] * K, 2)}

path = os.path.join(ROOT, "public", "data", "game.json")
game = json.load(open(path))
game["ranges"] = dict(sorted(ranges.items()))
json.dump(game, open(path, "w"), ensure_ascii=False, indent=0)
print(f"{len(ranges)} ranges")
