#!/usr/bin/env bash
# Turn a capture with Looks set into the planner's looks, public/data/looks/<look>/, and list the looks
# and their backdrop tiles in public/data/background.json.
#
# Backdrops: the capture's tiles (landN/<col>_<row>.png, capture.json "tiles", each with a border of its
# neighbours' pixels) are cut into square tiles background-N/<col>_<row> with the same border, at full
# detail and at ½ and ⅓ (@2, @3); lit/landN the same into lit-background-N/ for looks where lamps light
# the ground. Pack each look first with pack_sprites.html (?look=<look>, &set=lights, &set=floors and
# &set=small, with the same &scale): every sheet it writes to <look>/packed/ (sprites*.png, floors*.png,
# lights/*.png, anim/*.png, with @2 and @3) is encoded here to the same place in public/data/looks/<look>/,
# packed/small/landN.png becomes background-N.small.webp (shown while the tiles load), and its
# sprites.json, lights.json and floors.json are copied. <ppu> sets the backdrops' detail (the capture's,
# 200 px per unit, without it): the site keeps everything in the repo, under GitHub Pages' 1 GB, at 128.
# Every picture comes as AVIF; the ⅓ ones also as WebP, which browsers without AVIF get.
# Usage: tools/capture/looks_to_data.sh <capture dir> [ppu]   (needs cwebp, dwebp, avifenc)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

# one job, run in parallel below: <png> <out without extension> [crop x y w h] [resize w h]
if [ "${1:-}" = --encode ]; then
  png=$2 out=$3 crop=${4:-} resize=${5:-}
  args=()
  [ -n "$crop" ] && args+=(-crop $crop)
  [ -n "$resize" ] && args+=(-resize $resize)
  mkdir -p "$(dirname "$out")"
  case $out in *@3) cwebp -quiet -q 85 -alpha_q 90 ${args[@]+"${args[@]}"} "$png" -o "$out.webp";; esac
  if [ ${#args[@]} -gt 0 ]; then # avifenc can't crop or resize: through a lossless WebP first
    cwebp -quiet -lossless -z 0 "${args[@]}" "$png" -o "$out.tmp.webp" && dwebp -quiet "$out.tmp.webp" -o "$out.tmp.png"
    avifenc -q 60 --qalpha 80 -s 8 -j 2 "$out.tmp.png" "$out.avif" >/dev/null
    rm "$out.tmp.webp" "$out.tmp.png"
  else
    avifenc -q 60 --qalpha 80 -s 8 -j 2 "$png" "$out.avif" >/dev/null
  fi
  exit
fi

CAP=$1
DATA=$(cd "$here/../../public/data" && pwd)
read -r TW TH B CW CH PPU < <(python3 -c "import json,sys; t=json.load(open(sys.argv[1]))['tiles']; print(*t['tile'], t['border'], t['w'], t['h'], t['ppu'])" "$CAP/capture.json")
OUT_PPU=${2:-$PPU}
S=$TH # square web tiles, as high as the capture's
cols=$(( (CW + S - 1) / S )) rows=$(( (CH + S - 1) / S )) P=$(( S + 2 * B ))
# a tile's picture at full detail, ½ and ⅓: P capture pixels at OUT_PPU / PPU
read -r P1 P2 P3 < <(python3 -c "import sys; p, k = int(sys.argv[1]), float(sys.argv[2]) / float(sys.argv[3]); print(*(round(p * k / l) for l in (1, 2, 3)))" "$P" "$OUT_PPU" "$PPU")
jobs=$(mktemp)
looks=() lit=()
for dir in "$CAP"/*/; do
  look=$(basename "$dir")
  [ -d "$dir/land0" ] || [ -d "$dir/packed" ] || continue
  [ -d "$dir/land0" ] && looks+=("$look") # a capture without Backgrounds only brings sheets
  out="$DATA/looks/$look"
  mkdir -p "$out"
  for n in 0 1 2 3; do
    for kind in "" lit/; do
      src="$dir/${kind}land$n"
      [ -d "$src" ] || continue
      name=${kind:+lit-}background-$n
      for (( c = 0; c < cols; c++ )); do
        for (( r = 0; r < rows; r++ )); do
          png="$src/$(( c * S / TW ))_$r.png" x=$(( c * S % TW ))
          echo "--encode $png $out/$name/${c}_$r '$x 0 $P $P' '$P1 $P1'" >> "$jobs"
          echo "--encode $png $out/$name/${c}_$r@2 '$x 0 $P $P' '$P2 $P2'" >> "$jobs"
          echo "--encode $png $out/$name/${c}_$r@3 '$x 0 $P $P' '$P3 $P3'" >> "$jobs"
        done
      done
    done
    [ -f "$dir/packed/small/land$n.png" ] && cwebp -quiet -q 60 "$dir/packed/small/land$n.png" -o "$out/background-$n.small.webp"
  done
  [ -d "$dir/lit/land0" ] && lit+=("$look")
  for png in "$dir"/packed/*.png "$dir"/packed/lights/*.png "$dir"/packed/anim/*.png; do
    [ -f "$png" ] || continue
    name=${png#"$dir/packed/"}; name=${name%.png}
    echo "--encode $png $out/$name" >> "$jobs"
  done
  for f in sprites.json lights.json floors.json; do [ -f "$dir/packed/$f" ] && cp "$dir/packed/$f" "$out/"; done
done
echo "encoding $(wc -l < "$jobs") pictures…"
xargs -P "$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -L 1 "$0" < "$jobs"
rm "$jobs"
[ ${#looks[@]} -gt 0 ] || exit 0 # background.json lists the looks with backdrops
for look in "${looks[@]}"; do echo "$look: $(du -sh "$DATA/looks/$look" | cut -f1)"; done
python3 - "$DATA/background.json" "$CW" "$CH" "$PPU" "$OUT_PPU" "$S" "$B" "$cols" "$rows" "${lit[*]:-}" "${looks[@]}" <<'PY'
import json, sys
path, w, h, ppu, out_ppu, size, border, cols, rows, lit = sys.argv[1:11]
found = set(sys.argv[11:])
k = float(out_ppu) / float(ppu)  # the backdrop's pixels at the detail kept
ORDER = ["day", "dusk", "night", "rain", "bloodmoon", "winter", "blizzard"]  # the picker's order; day first
bg = json.load(open(path))
bg["looks"] = [l for l in ORDER if l in found] + sorted(found - set(ORDER))
bg["images"] = [f"background-{n}" for n in range(4)]  # + /<col>_<row>[@2|@3].{avif,webp}, .small.webp
bg["w"], bg["h"], bg["ppu"] = round(int(w) * k, 3), round(int(h) * k, 3), float(out_ppu)
bg["tile"] = {"size": round(int(size) * k, 3), "border": round(int(border) * k, 3), "cols": int(cols), "rows": int(rows)}
# looks where placed lamps light the ground: lit-<image> is the backdrop graded as inside lamp light
bg["lit"] = [l for l in bg["looks"] if l in lit.split()]
# the game's weather tint (WeatherSystemController presets in the base scene), laid over the screen
bg["tint"] = {"rain": [0.0081, 0, 0.517, 0.0392], "winter": [0.1113, 0.3239, 1, 0.1569], "blizzard": [0.2019, 0.3928, 1, 0.1804]}
bg["source"] = f"in-game capture (tools/capture) at {ppu} px per unit, kept at {out_ppu}; looks/<look>/background-N/<col>_<row>, N = land upgrades bought"
json.dump(bg, open(path, "w"))
print("looks:", ", ".join(bg["looks"]))
PY
