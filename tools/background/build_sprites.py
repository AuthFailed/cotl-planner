"""Exact footprints and in-game sprites for every buildable structure.

The base scene's TypeAndPlacementObjects lists each structure type with its placement
prefab (an Addressables GUID). The placement prefab holds the footprint (Bounds) and the
path of the real building prefab, whose SpriteRenderers are the in-game look. The game
instantiates that prefab unrotated at the centre of the footprint's first cell, so its art
goes through the same camera projection as the background.

Usage: python3 tools/background/build_sprites.py <ExportedProject> <Game_Data dir>
Writes data/game.json and tools/background/sprites_drawlist.json; render the sprites with
compose_sprites.html (see compose.html instructions) and copy sprites.webp/json into data/.
"""
import base64, json, os, re, struct, sys

sys.path.insert(0, os.path.dirname(__file__))
from unityyaml import Doc, Sprites, guid_index, sorting_layers, sprite_item, trs

E, GAME = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "data")

guid_path = guid_index(E)
layers = sorting_layers(E)
sprites = Sprites(E, guid_path)

# structure type enum
src = open(os.path.join(E, "Assets/Scripts/Assembly-CSharp/StructureBrain.cs")).read()
enum = src[src.index("public enum TYPES"):]
enum = enum[enum.index("{") + 1:enum.index("}")]
types, i = {}, 0
for item in filter(None, (s.strip() for s in enum.split(","))):
    if "=" in item:
        item, v = (s.strip() for s in item.split("="))
        i = int(v)
    types[i] = item
    i += 1

# Addressables catalog: asset GUID -> internal path
cat = json.load(open(os.path.join(GAME, "StreamingAssets/aa/catalog.json")))
ids = cat["m_InternalIds"]
e = base64.b64decode(cat["m_EntryDataString"])
entries = [struct.unpack_from("<7i", e, 4 + n * 28) for n in range(struct.unpack_from("<i", e, 0)[0])]
b = base64.b64decode(cat["m_BucketDataString"])
buckets, o = [], 4
for _ in range(struct.unpack_from("<i", b, 0)[0]):
    off, cnt = struct.unpack_from("<ii", b, o); o += 8
    buckets.append((off, struct.unpack_from(f"<{cnt}i", b, o))); o += 4 * cnt
kd = base64.b64decode(cat["m_KeyDataString"])
def key_at(off):
    if kd[off] == 0:
        n = struct.unpack_from("<i", kd, off + 1)[0]
        return kd[off + 5:off + 5 + n].decode("ascii", "replace")
guid_to_internal = {}
for off, ents in buckets:
    k = key_at(off)
    if k and re.fullmatch(r"[0-9a-f]{32}", k) and ents:
        guid_to_internal[k] = ids[entries[ents[0]][0]]

# English names from the localization table in resources.assets ("Structures/<TYPE>")
res = open(os.path.join(GAME, "resources.assets"), "rb").read()
def english(t):
    m = re.search(re.escape(("Structures/" + t).encode()) + b"(?=\x00)", res)
    if not m:
        return None
    i, prev = m.end() + (-m.end()) % 4, None
    for _ in range(80):
        n = struct.unpack_from("<i", res, i)[0]
        if not 0 <= n < 400:
            i += 4; continue
        s = res[i + 4:i + 4 + n]; i += 4 + n; i += (-i) % 4
        if prev == b"25":  # the English entry follows this marker in I2's term layout
            return s.decode("utf-8", "replace")
        prev = s

scene = Doc(os.path.join(E, "Assets/Scenes/Base Biome 1.unity"))
tpo = next(b for c, b in scene.docs.values() if c == 114 and "TypeAndPlacementObject:" in b)
building_files = {}
for root, _, files in os.walk(os.path.join(E, "Assets")):
    for f in files:
        if f.endswith(".prefab"):
            building_files.setdefault(f[:-7], os.path.join(root, f))

game, draw = {}, {}
for t, g in re.findall(r"- Type: (\d+)\s+Category: \d+\s+Addr_PlacementObject:\s+m_AssetGUID: (\w*)", tpo):
    T = types[int(t)]
    internal = guid_to_internal.get(g)
    pf = os.path.join(E, internal) if internal else None
    if not pf or not os.path.exists(pf) or T in game:
        continue
    ptxt = open(pf).read()
    bounds = re.search(r"Bounds: \{x: (\d+), y: (\d+)\}", ptxt)
    build = re.search(r"ToBuildAsset: (.*)", ptxt)
    entry = {"name": english(T), "w": int(bounds.group(1)) if bounds else 1, "h": int(bounds.group(2)) if bounds else 1}
    game[T] = entry
    bf = building_files.get(build.group(1).strip().split("/")[-1]) if build else None
    if not bf:
        continue
    doc = Doc(bf)
    root = next(k for k, (c, body) in doc.docs.items() if c in (4, 224) and doc.father(k) is None)
    doc.root_override = (root, trs(doc.docs[root][1], keep_position=False, keep_rotation=False))  # instantiated at the cell, unrotated
    items = []
    for k, (c, body) in doc.docs.items():
        if c == 212:
            it = sprite_item(doc, body, sprites, layers)
            if it:
                del it["pos"]
                items.append(it)
    if items:
        draw[T] = sorted(items, key=lambda i: i["key"])
        entry["sprite"] = True

# Match the wiki list (data/buildings.json) to game types: wiki id, then game name, then enum/prefab name.
norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
strip = lambda s: re.sub(r"^(building|decoration|deco|structure)s?", "", norm(s))
by = {}
for T, v in game.items():
    for k in (norm(v["name"]), strip(T.replace("_", " ")), norm(T)):
        if k:
            by.setdefault(k, T)
wiki = {}
for w in json.load(open(os.path.join(DATA, "buildings.json"))):
    T = w["id"] if w["id"] in game else by.get(norm(w["name"])) or by.get(strip(w["name"]))
    if T:
        wiki[w["name"]] = T

json.dump({"types": game, "wiki": wiki}, open(os.path.join(DATA, "game.json"), "w"), indent=0, ensure_ascii=False)
json.dump({"sprites": {g: s for g, s in sprites.cache.items() if s}, "buildings": draw},
          open(os.path.join(HERE, "sprites_drawlist.json"), "w"))
print(f"{len(game)} types, {len(draw)} with sprites, {len(wiki)} wiki entries matched", file=sys.stderr)
