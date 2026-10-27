"""Build the background draw list: every visible SpriteRenderer and SpriteShape ground fill
around the base, projected like the game camera (see unityyaml.py).
Usage: python3 tools/background/build_drawlist.py <ExportedProject> tools/background/drawlist.json
Then: python3 tools/background/serve.py <ExportedProject>/Assets 8766, open
http://localhost:8766/bg/compose.html?ppu=36 and run `await save()` in the console; it writes
background.webp + background.json next to these files. Copy both into data/.
"""
import json, math, os, re, sys

sys.path.insert(0, os.path.dirname(__file__))
from unityyaml import K, Doc, Sprites, guid_index, sorting_layers, sprite_item

E, OUT = sys.argv[1], sys.argv[2]
guid_path = guid_index(E)
layers = sorting_layers(E)
sprites = Sprites(E, guid_path)
doc = Doc(os.path.join(E, "Assets/Scenes/Base Biome 1.unity"))
docs = doc.docs

# Region of interest: the base placement region's cells in world space, plus a margin.
base = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "data", "base.json")))
rx, ry = base["world"]
a = math.radians(base["rotation"])
wx = [rx + x * math.cos(a) - y * math.sin(a) for x, y in base["tiles"]]
wy = [ry + x * math.sin(a) + y * math.cos(a) for x, y in base["tiles"]]
M = 10
X0, X1, Y0, Y1 = min(wx) - M, max(wx) + M, min(wy) - M, max(wy) + M

items = []
for k, (cls, body) in docs.items():
    if cls == 212:
        it = sprite_item(doc, body, sprites, layers)
        if it and X0 <= it["pos"][0] <= X1 and Y0 <= it["pos"][1] <= Y1:
            del it["pos"]
            items.append(it)

# SpriteShapes: the ground. Fill polygon only (edge sprites are not drawn).
def bez(p0, p1, p2, p3, t):
    u = 1 - t
    return tuple(u*u*u*a + 3*u*u*t*b + 3*u*t*t*c + t*t*t*d for a, b, c, d in zip(p0, p1, p2, p3))

for k, (cls, body) in docs.items():
    if cls != 1971053207 or "m_Enabled: 1" not in body:
        continue
    go = re.search(r"m_GameObject: \{fileID: (-?\d+)", body).group(1)
    tid = doc.go_transform.get(go)
    name = doc.name(go)
    if not tid or not doc.active(tid) or name.lower().startswith("woodenfloor"):  # two stray floor tiles near the shrine
        continue
    comps = re.findall(r"component: \{fileID: (-?\d+)\}", docs[go][1])
    ctrl = next((docs[c][1] for c in comps if docs[c][0] == 114 and "m_Spline:" in docs[c][1]), None)
    tex = re.search(r"m_ShapeTexture: \{fileID: \d+, guid: (\w+)", body)
    if not ctrl or not tex or tex.group(1) not in guid_path:
        continue
    pts = [dict(p=tuple(map(float, m[0:3])), l=tuple(map(float, m[3:6])), r=tuple(map(float, m[6:9])), mode=int(m[9]))
           for m in re.findall(r"- position: \{x: (\S+), y: (\S+), z: (\S+)\}\s+leftTangent: \{x: (\S+), y: (\S+), z: (\S+)\}\s+rightTangent: \{x: (\S+), y: (\S+), z: (\S+)\}\s+mode: (\d+)", ctrl)]
    if len(pts) < 3:
        continue
    poly = []
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        if p["mode"] == 0 and q["mode"] == 0:
            poly.append(p["p"][:2])
        else:
            c1 = tuple(x + y for x, y in zip(p["p"], p["r"])); c2 = tuple(x + y for x, y in zip(q["p"], q["l"]))
            poly += [bez(p["p"], c1, c2, q["p"], t / 16)[:2] for t in range(16)]
    m = doc.world(tid)
    wxs = [m[0][0] * x + m[0][1] * y + m[0][3] for x, y in poly]
    wys = [m[1][0] * x + m[1][1] * y + m[1][3] for x, y in poly]
    if max(wxs) < X0 or min(wxs) > X1 or max(wys) < Y0 or min(wys) > Y1:
        continue
    lid = int(re.search(r"m_SortingLayerID: (-?\d+)", body).group(1)) & 0xFFFFFFFF
    li, lname = layers.get(lid, layers[0])
    col = re.search(r"m_Color: \{r: (\S+), g: (\S+), b: (\S+), a: (\S+)\}", body)
    aff = [m[0][0], K * (m[1][0] - m[2][0]), m[0][1], K * (m[1][1] - m[2][1]), m[0][3], K * (m[1][3] - m[2][3])]
    items.append({"shape": [[round(x, 3), round(y, 3)] for x, y in poly],
                  "fill": os.path.relpath(guid_path[tex.group(1)], os.path.join(E, "Assets")),
                  "ppu": float(re.search(r"m_FillPixelPerUnit: (\S+)", ctrl).group(1)),
                  "aff": [round(v, 5) for v in aff], "c": [round(float(v), 3) for v in col.groups()],
                  "key": [li, int(re.search(r"m_SortingOrder: (-?\d+)", body).group(1)), -round(K * (m[1][3] + m[2][3]), 4)],
                  "layer": lname, "name": name})

items.sort(key=lambda i: i["key"])
json.dump({"bounds": [X0, X1, Y0, Y1], "world": base["world"],
           "sprites": {g: s for g, s in sprites.cache.items() if s}, "items": items}, open(OUT, "w"))
print(len(items), "items", file=sys.stderr)
