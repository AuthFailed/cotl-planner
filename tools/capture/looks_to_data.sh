#!/usr/bin/env bash
# Turn a capture with Looks set into public/data/looks/<look>/ and list the looks in
# public/data/background.json. Each backdrop (from landN.png, 4096 wide) becomes background-N.avif,
# background-N.webp (for browsers without AVIF) and background-N.small.webp (512 wide, drawn while
# the full one loads). Pack each look's buildings first with pack_sprites.html?look=<look>: its
# sprites.png, sprites-2.png and sprites.json are encoded here the same way.
# Usage: tools/capture/looks_to_data.sh <capture dir>   (needs cwebp and avifenc)
set -euo pipefail
CAP=$1
DATA=$(cd "$(dirname "$0")/../../public/data" && pwd)
looks=()
for dir in "$CAP"/*/; do
  look=$(basename "$dir")
  [ -f "$dir/land0.png" ] || continue
  looks+=("$look")
  out="$DATA/looks/$look"
  mkdir -p "$out"
  for png in "$dir"/land[0-9].png; do
    n=${png##*land}; n=${n%.png}
    cwebp -quiet -q 80 -resize 4096 0 "$png" -o "$out/background-$n.webp"
    cwebp -quiet -q 60 -resize 512 0 "$png" -o "$out/background-$n.small.webp"
    # avifenc can't resize: scale losslessly through cwebp first
    cwebp -quiet -lossless -z 0 -resize 4096 0 "$png" -o "$out/tmp.webp" && dwebp -quiet "$out/tmp.webp" -o "$out/tmp.png"
    avifenc -q 60 -s 6 -j all "$out/tmp.png" "$out/background-$n.avif" >/dev/null
    rm "$out/tmp.webp" "$out/tmp.png"
  done
  for png in "$dir"/sprites*.png; do
    [ -f "$png" ] || continue
    name=$(basename "$png" .png)
    cwebp -quiet -q 85 -alpha_q 90 "$png" -o "$out/$name.webp"
    avifenc -q 55 --qalpha 80 -s 6 -j all "$png" "$out/$name.avif" >/dev/null
  done
  [ -f "$dir/sprites.json" ] && cp "$dir/sprites.json" "$out/"
  echo "$look: $(du -ch "$out"/*.avif | tail -1 | cut -f1) avif, $(du -ch "$out"/*.webp | tail -1 | cut -f1) webp"
done
python3 - "$DATA/background.json" "${looks[@]}" <<'PY'
import json, sys
path, found = sys.argv[1], set(sys.argv[2:])
ORDER = ["day", "dusk", "night", "rain", "bloodmoon", "winter", "blizzard"]  # the picker's order; day first
bg = json.load(open(path))
bg["looks"] = [l for l in ORDER if l in found] + sorted(found - set(ORDER))
bg["images"] = [f"background-{n}" for n in range(4)]  # + .avif / .webp / .small.webp
# the game's weather tint (WeatherSystemController presets in the base scene), laid over the screen
bg["tint"] = {"rain": [0.0081, 0, 0.517, 0.0392], "winter": [0.1113, 0.3239, 1, 0.1569], "blizzard": [0.2019, 0.3928, 1, 0.1804]}
bg["source"] = "in-game capture (tools/capture), looks/<look>/background-N.{avif,webp,small.webp}, N = land upgrades bought"
json.dump(bg, open(path, "w"))
print("looks:", ", ".join(bg["looks"]))
PY
