"""Exact footprints and in-game sprites for every buildable structure.

The base scene's TypeAndPlacementObjects lists each structure type with its placement
prefab (an Addressables GUID). The placement prefab holds the footprint (Bounds) and the
path of the real building prefab, whose SpriteRenderers are the in-game look. The game
instantiates that prefab unrotated at the centre of the footprint's first cell, so its art
goes through the same camera projection as the background.

Build rules come from StructuresData: GetBuildOnlyOne (one per base, counting every tier of
its upgrade chain) and GetUpgradePath (the tiers of each chain), stored as "once" and "chains".

Usage: python3 tools/background/build_sprites.py <ExportedProject> <Game_Data dir>
Writes public/data/game.json and tools/background/sprites_drawlist.json; render the sprites with
compose_sprites.html (see compose.html instructions) and copy sprites.webp/json into public/data/.
"""
import base64, json, os, re, struct, sys

sys.path.insert(0, os.path.dirname(__file__))
from unityyaml import Doc, Sprites, guid_index, sorting_layers, sprite_item, trs

E, GAME = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "public", "data")

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

# Build rules, parsed from the decompiled StructuresData switch statements.
sd = open(os.path.join(E, "Assets/Scripts/Assembly-CSharp/StructuresData.cs")).read()
def method(name):
    start = sd.index(name)
    end = sd.index("\n\t}\n", start)
    return sd[start:end]
once = set(re.findall(r"case StructureBrain\.TYPES\.(\w+):", method("public static bool GetBuildOnlyOne(")))
chains = [re.findall(r"StructureBrain\.TYPES\.(\w+)", block)
          for block in re.findall(r"return new List<StructureBrain\.TYPES>\s*\{(.*?)\};", method("public static List<StructureBrain.TYPES> GetUpgradePath("), re.S)]
# "fixed": the game won't delete these (isDeletable = false in GetInfoByType), e.g. the Temple.
info = method("public static StructuresData GetInfoByType(")
fixed = set()
for cases, props in re.findall(r"((?:\s*case StructureBrain\.TYPES\.\w+:)+)\s*structuresData = new StructuresData\s*\{(.*?)\};", info, re.S):
    if "isDeletable = false" in props:
        fixed |= set(re.findall(r"TYPES\.(\w+)", cases))
for T, v in game.items():
    if T in once:
        v["once"] = True
    if T in fixed:
        v["fixed"] = True

# English names: the game's own translations (public/data/i18n.json, from the capture plugin) when present.
i18n_path = os.path.join(DATA, "i18n.json")
if os.path.exists(i18n_path):
    for T, row in json.load(open(i18n_path))["names"].items():
        if T in game:
            game[T]["name"] = row[0]

# Match the wiki list (public/data/buildings.json) to game types: the game's own name first (wiki ids
# have typos, e.g. "Healing Bay II" carries HEALING_BAY), then the wiki id, then enum-derived names.
norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
strip = lambda s: re.sub(r"^(building|decoration|deco|structure)s?", "", norm(s))
by_name, by_enum = {}, {}
for T, v in game.items():
    if v["name"]:
        by_name.setdefault(norm(v["name"]), T)
    for k in (strip(T.replace("_", " ")), norm(T)):
        by_enum.setdefault(k, T)
wiki = {}
for w in json.load(open(os.path.join(DATA, "buildings.json"))):
    T = by_name.get(norm(w["name"])) or (w["id"] if w["id"] in game else None) \
        or by_enum.get(norm(w["name"])) or by_enum.get(strip(w["name"]))
    if T:
        wiki[w["name"]] = T

# The game's build menu: its four tabs and their sections, in the game's order, with the
# localisation term for every header. Upgrade tiers above the first are left to the planner's
# level picker, and the Shrine is left out (it stands in the plaza, off the grid).
SCRIPTS = os.path.join(E, "Assets/Scripts/Assembly-CSharp")
def src(path):
    return open(os.path.join(SCRIPTS, path)).read()
def body(text, signature):
    start = text.index(signature)
    return text[start:text.index("\n\t}\n", start)] if "\n\t}\n" in text[start:] else text[start:]
def arms(text):  # "Enum.Value => new List<StructureBrain.TYPES> { ... }" switch arms
    return {m.group(1): re.findall(r"TYPES\.(\w+)", m.group(2))
            for m in re.finditer(r"\w+\.(\w+)\s*=>\s*new List<StructureBrain\.TYPES>\s*\{(.*?)\}", text, re.S)}
def first_list(text):
    return re.findall(r"TYPES\.(\w+)", re.search(r"new List<StructureBrain\.TYPES>\s*\{(.*?)\}", text, re.S).group(1))
follower = arms(src("Lamb/UI/Buildmenu/FollowerCategory.cs"))
faith_src = src("Lamb/UI/Buildmenu/FaithCategory.cs")
woolhaven = arms(src("Lamb/UI/Buildmenu/MajorDLCCategory.cs"))
dm = src("DataManager.cs")
decor = arms(body(dm, "public static List<StructureBrain.TYPES> DecorationsForType("))
decor_dlc = arms(body(dm, "public static List<StructureBrain.TYPES> MajorDLCDecorationsDisplay("))
heads = {c[0] for c in chains}
in_chain = {T for c in chains for T in c}
def section(sid, term, types):
    keep = [T for T in dict.fromkeys(types) if T in game and T != "SHRINE" and (T not in in_chain or T in heads)]
    return {"id": sid, "term": term, "types": keep}
menu = [
    {"id": "follower", "term": "UI/Generic/Follower", "sections": [
        section("misc", "UI/Generic/General", follower.get("Misc", [])),
        section("food", "UI/PauseScreen/Inventory/Food", follower.get("Food", [])),
        section("items", "UI/PauseScreen/Inventory/Items", follower.get("Items", []))]},
    {"id": "faith", "term": "UI/PrisonMenu/Faith", "sections": [
        section("general", "UI/Generic/General", first_list(body(faith_src, "public static List<StructureBrain.TYPES> AllStructures("))),
        section("sin", "UI/Sin", first_list(body(faith_src, "public static List<StructureBrain.TYPES> SinStructures(")))]},
    {"id": "decor", "term": "UI/Generic/Decorations", "sections": [  # AestheticCategory.Populate order
        section("misc", "UI/Generic/General", decor.get("All", [])),
        section("woolhaven-misc", "UI/DLC/BuildMenu/DecorationsMisc", decor_dlc.get("Major_DLC", [])),
        section("woolhaven-town", "UI/DLC/BuildMenu/DecorationsWoolhaven", decor_dlc.get("Woolhaven", [])),
        section("ewefall", "UI/DLC/BuildMenu/DecorationsEwefall", decor_dlc.get("Ewefall", [])),
        section("rot", "UI/DLC/BuildMenu/DecorationsRot", decor_dlc.get("Rot", [])),
        section("dlc", "UI/DLC", decor.get("DLC", [])),
        section("events", "UI/FollowerForms/SpecialEvents", decor.get("Special_Events", [])),
        section("paths", "UI/Paths", decor.get("Path", [])),
        section("darkwood", "NAMES/Places/Dungeon1_1", decor.get("Dungeon1", [])),
        section("anura", "NAMES/Places/Dungeon1_2", decor.get("Mushroom", [])),
        section("anchordeep", "NAMES/Places/Dungeon1_3", decor.get("Crystal", [])),
        section("silk-cradle", "NAMES/Places/Dungeon1_4", decor.get("Spider", []))]},
    {"id": "woolhaven", "term": "UI/DLC/Name", "sections": [
        section("misc", "UI/Generic/General", woolhaven.get("Misc", [])),
        section("winter", "UI/Generic/Winter", woolhaven.get("Winter", [])),
        section("ranching", "UI/Ranching", woolhaven.get("Ranching", []))]},
]
for tab in menu:
    tab["sections"] = [sec for sec in tab["sections"] if sec["types"]]

# "X II" / "X III" on the wiki is that tier of X's upgrade chain, even when the match landed on tier I.
tier_of = {T: (c, i) for c in chains for i, T in enumerate(c)}
for name, T in wiki.items():
    m = re.search(r" (II|III|IV)$", name)
    if m and T in tier_of:
        c, _ = tier_of[T]
        n = {"II": 1, "III": 2, "IV": 3}[m.group(1)]
        if n < len(c) and c[n] in game:
            wiki[name] = c[n]

json.dump({"types": game, "wiki": wiki, "chains": chains, "menu": menu}, open(os.path.join(DATA, "game.json"), "w"), indent=0, ensure_ascii=False)
json.dump({"sprites": {g: s for g, s in sprites.cache.items() if s}, "buildings": draw},
          open(os.path.join(HERE, "sprites_drawlist.json"), "w"))
print(f"{len(game)} types, {len(draw)} with sprites, {len(wiki)} wiki entries matched, "
      f"{sum('once' in v for v in game.values())} one-per-base, {len(chains)} upgrade chains", file=sys.stderr)
