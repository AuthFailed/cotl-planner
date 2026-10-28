"""Write what the buildings cost into public/data/game.json ("costs", "upgrades").

Usage: python3 tools/capture/costs_to_data.py <capture dir>/costs.json [<capture dir>/items]

The capture plugin's Costs job lists StructuresData.GetCost for every structure type (item type and quantity, as the
game charges for this save) and, for an upgrade done in place (StructuresData.IsUpgrade), the type it upgrades from.
With the Items job's folder, each listed item's text icon (the one the game puts in its cost lines) goes to
public/data/items/<ITEM>.webp at 36 px, twice the size the page shows it (needs sips and cwebp).
Run tools/capture/i18n_to_data.py afterwards: it takes the names of the items listed here.
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

path = os.path.join(ROOT, "public", "data", "game.json")
game = json.load(open(path))
costs, upgrades = {}, {}
for T, c in json.load(open(sys.argv[1])).items():
    if T not in game["types"]:
        continue
    if c["cost"]:
        costs[T] = [[i["CostItem"], int(i["CostValue"])] for i in c["cost"]]
    if c["from"] in game["types"]:
        upgrades[T] = c["from"]
game["costs"] = dict(sorted(costs.items()))
game["upgrades"] = dict(sorted(upgrades.items()))
json.dump(game, open(path, "w"), ensure_ascii=False, indent=0)
print(f"{len(costs)} costs, {len(upgrades)} upgrades")

if len(sys.argv) > 2:
    out = os.path.join(ROOT, "public", "data", "items")
    os.makedirs(out, exist_ok=True)
    items = sorted({i for c in costs.values() for i, _ in c})
    with tempfile.TemporaryDirectory() as tmp:
        for i in items:
            small = os.path.join(tmp, f"{i}.png")
            subprocess.run(["sips", "-Z", "36", os.path.join(sys.argv[2], f"text-{i}.png"), "--out", small], check=True, capture_output=True)
            subprocess.run(["cwebp", "-quiet", "-q", "90", "-alpha_q", "100", small, "-o", os.path.join(out, f"{i}.webp")], check=True)
    print(f"{len(items)} item icons")
