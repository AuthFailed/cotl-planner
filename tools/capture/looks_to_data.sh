#!/usr/bin/env bash
# Turn a capture with Looks set into public/data/looks/<look>/background-N.webp (4096 wide, from
# landN.png) and list the looks in public/data/background.json. The buildings' atlases are packed
# separately, per look, with pack_sprites.html?look=<look>.
# Usage: tools/capture/looks_to_data.sh <capture dir> [quality]   (needs cwebp)
set -euo pipefail
CAP=$1 Q=${2:-80}
DATA=$(cd "$(dirname "$0")/../../public/data" && pwd)
looks=()
for dir in "$CAP"/*/; do
  look=$(basename "$dir")
  [ -f "$dir/land0.png" ] || continue
  looks+=("$look")
  mkdir -p "$DATA/looks/$look"
  for png in "$dir"/land[0-9].png; do
    n=${png##*land}; n=${n%.png}
    cwebp -quiet -q "$Q" -resize 4096 0 "$png" -o "$DATA/looks/$look/background-$n.webp"
  done
  echo "$look: $(du -ch "$DATA/looks/$look"/background-*.webp | tail -1 | cut -f1)"
done
python3 - "$DATA/background.json" "${looks[@]}" <<'EOF'
import json, sys
path, found = sys.argv[1], set(sys.argv[2:])
ORDER = ["day", "dusk", "night", "rain", "bloodmoon", "winter", "blizzard"]  # the picker's order; day first
bg = json.load(open(path))
bg["looks"] = [l for l in ORDER if l in found] + sorted(found - set(ORDER))
bg["images"] = [f"background-{n}.webp" for n in range(4)]
# the game's weather tint (WeatherSystemController presets in the base scene), laid over the screen
bg["tint"] = {"rain": [0.0081, 0, 0.517, 0.0392], "winter": [0.1113, 0.3239, 1, 0.1569], "blizzard": [0.2019, 0.3928, 1, 0.1804]}
bg["source"] = "in-game capture (tools/capture), looks/<look>/background-N.webp, N = land upgrades bought"
json.dump(bg, open(path, "w"))
print("looks:", ", ".join(bg["looks"]))
EOF
