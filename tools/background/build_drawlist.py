"""Build a draw list of every visible SpriteRenderer around the base, projected like the
game camera (orthographic, pitched 45°): u = x, v = cos45 * (y - z).
Usage: python3 tools/background/build_drawlist.py <ExportedProject> tools/background/drawlist.json
Then: python3 tools/background/serve.py <ExportedProject>/Assets 8766, open
http://localhost:8766/bg/compose.html?ppu=36 and run `await save()` in the console; it writes
background.webp + background.json next to these files. Copy both into data/.
"""
import json, math, os, re, sys

E, OUT = sys.argv[1], sys.argv[2]
K = math.sqrt(0.5)
SKIP_LAYERS = {"DepthFX", "Lighting", "VFX", "Ground UI"}

# guid -> asset path for every exported asset
guid_path = {}
for root, _, files in os.walk(os.path.join(E, "Assets")):
    for f in files:
        if f.endswith(".meta"):
            with open(os.path.join(root, f), errors="ignore") as fh:
                head = fh.read(200)
            m = re.search(r"guid: (\w+)", head)
            if m:
                guid_path[m.group(1)] = os.path.join(root, f[:-5])

tm = open(os.path.join(E, "ProjectSettings/TagManager.asset")).read()
layers = re.findall(r"- name: (.*)\n\s+uniqueID: (\d+)", tm.split("m_SortingLayers:")[1])
layer_index = {int(uid): (i, name) for i, (name, uid) in enumerate(layers)}

text = open(os.path.join(E, "Assets/Scenes/Base Biome 1.unity")).read()
docs = {m.group(2): (int(m.group(1)), m.group(3))
        for m in re.finditer(r"--- !u!(\d+) &(-?\d+)[^\n]*\n(.*?)(?=\n--- !u!|\Z)", text, re.S)}
print(len(docs), "docs", file=sys.stderr)

def f3(s, key):
    m = re.search(key + r": \{x: (\S+), y: (\S+), z: (\S+)\}", s)
    return tuple(map(float, m.groups()))

def quat(s):
    m = re.search(r"m_LocalRotation: \{x: (\S+), y: (\S+), z: (\S+), w: (\S+)\}", s)
    return tuple(map(float, m.groups()))

def trs(t):
    px, py, pz = f3(t, "m_LocalPosition")
    x, y, z, w = quat(t)
    sx, sy, sz = f3(t, "m_LocalScale")
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, px],
            [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, py],
            [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, pz]]

def mul(a, b):  # 3x4 affine matrices
    return [[sum(a[i][k] * b[k][j] for k in range(3)) + (a[i][3] if j == 3 else 0) for j in range(4)] for i in range(3)]

go_transform, world_cache = {}, {}
for k, (cls, body) in docs.items():
    if cls in (4, 224):
        g = re.search(r"m_GameObject: \{fileID: (-?\d+)", body)
        if g:
            go_transform[g.group(1)] = k

def world(tid):
    if tid in world_cache:
        return world_cache[tid]
    body = docs[tid][1]
    father = re.search(r"m_Father: \{fileID: (-?\d+)", body).group(1)
    m = trs(body)
    if father != "0" and father in docs:
        m = mul(world(father), m)
    world_cache[tid] = m
    return m

active_cache = {}
def active(tid):
    if tid in active_cache:
        return active_cache[tid]
    body = docs[tid][1]
    go = re.search(r"m_GameObject: \{fileID: (-?\d+)", body).group(1)
    ok = go in docs and re.search(r"m_IsActive: 1", docs[go][1]) is not None
    father = re.search(r"m_Father: \{fileID: (-?\d+)", body).group(1)
    if ok and father != "0" and father in docs:
        ok = active(father)
    active_cache[tid] = ok
    return ok

sprite_cache = {}
def sprite(guid):
    if guid in sprite_cache:
        return sprite_cache[guid]
    p = guid_path.get(guid)
    res = None
    if p and p.endswith(".asset"):
        s = open(p).read()
        rd = s.split("m_RD:")[1]
        tex = re.search(r"texture: \{fileID: \d+, guid: (\w+)", rd)
        tr = re.search(r"textureRect:\s+serializedVersion: \d+\s+x: (\S+)\s+y: (\S+)\s+width: (\S+)\s+height: (\S+)", rd)
        rect = re.search(r"m_Rect:\s+serializedVersion: \d+\s+x: \S+\s+y: \S+\s+width: (\S+)\s+height: (\S+)", s)
        off = re.search(r"textureRectOffset: \{x: (\S+), y: (\S+)\}", rd)
        piv = re.search(r"m_Pivot: \{x: (\S+), y: (\S+)\}", s)
        ppu = float(re.search(r"m_PixelsToUnits: (\S+)", s).group(1))
        raw = int(re.search(r"settingsRaw: (\d+)", rd).group(1))
        if tex and tex.group(1) in guid_path and tr:
            texpath = os.path.relpath(guid_path[tex.group(1)], os.path.join(E, "Assets"))
            res = {"tex": texpath, "tr": [float(v) for v in tr.groups()], "rect": [float(v) for v in rect.groups()],
                   "off": [float(v) for v in off.groups()], "pivot": [float(v) for v in piv.groups()], "ppu": ppu,
                   "rot": (raw >> 2) & 0xF, "tight": bool(raw & 2), "name": re.search(r"m_Name: (.*)", s).group(1)}
    sprite_cache[guid] = res
    return res

# Region of interest: the base placement region's cells in world space, plus a margin.
base = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "data", "base.json")))
reg = base["world"] + [base["rotation"]]  # region origin in world space, rotation in degrees
a = math.radians(reg[2])
wx = [reg[0] + x * math.cos(a) - y * math.sin(a) for x, y in base["tiles"]]
wy = [reg[1] + x * math.sin(a) + y * math.cos(a) for x, y in base["tiles"]]
M = 10
X0, X1, Y0, Y1 = min(wx) - M, max(wx) + M, min(wy) - M, max(wy) + M

items, skipped = [], {"inactive": 0, "outside": 0, "layer": 0, "nosprite": 0}
for k, (cls, body) in docs.items():
    if cls != 212 or "m_Enabled: 1" not in body:
        continue
    go = re.search(r"m_GameObject: \{fileID: (-?\d+)", body).group(1)
    tid = go_transform.get(go)
    if not tid or not active(tid):
        skipped["inactive"] += 1; continue
    m = world(tid)
    if not (X0 <= m[0][3] <= X1 and Y0 <= m[1][3] <= Y1):
        skipped["outside"] += 1; continue
    lid = int(re.search(r"m_SortingLayerID: (-?\d+)", body).group(1)) & 0xFFFFFFFF
    li, lname = layer_index.get(lid, (layer_index[0][0], "Default"))
    if lname in SKIP_LAYERS:
        skipped["layer"] += 1; continue
    sg = re.search(r"m_Sprite: \{fileID: \d+, guid: (\w+)", body)
    sp = sprite(sg.group(1)) if sg else None
    if not sp:
        skipped["nosprite"] += 1; continue
    col = re.search(r"m_Color: \{r: (\S+), g: (\S+), b: (\S+), a: (\S+)\}", body)
    flipx = "m_FlipX: 1" in body; flipy = "m_FlipY: 1" in body
    order = int(re.search(r"m_SortingOrder: (-?\d+)", body).group(1))
    # sprite-local units -> (u, v): u = x, v = K (y - z)
    aff = [m[0][0], K * (m[1][0] - m[2][0]), m[0][1], K * (m[1][1] - m[2][1]), m[0][3], K * (m[1][3] - m[2][3])]
    if flipx: aff[0], aff[1] = -aff[0], -aff[1]
    if flipy: aff[2], aff[3] = -aff[2], -aff[3]
    depth = K * (m[1][3] + m[2][3])
    items.append({"s": sg.group(1), "aff": [round(v, 5) for v in aff], "c": [round(float(v), 3) for v in col.groups()],
                  "key": [li, order, -round(depth, 4)], "layer": lname})

# SpriteShapes: the ground. Fill polygon only (edge sprites are not drawn).
go_comps = lambda go: re.findall(r"component: \{fileID: (-?\d+)\}", docs[go][1])
textures = {}
def bez(p0, p1, p2, p3, t):
    u = 1 - t
    return tuple(u*u*u*a + 3*u*u*t*b + 3*u*t*t*c + t*t*t*d for a, b, c, d in zip(p0, p1, p2, p3))
for k, (cls, body) in docs.items():
    if cls != 1971053207 or "m_Enabled: 1" not in body:
        continue
    go = re.search(r"m_GameObject: \{fileID: (-?\d+)", body).group(1)
    tid = go_transform.get(go)
    if not tid or not active(tid):
        continue
    ctrl = next((docs[c][1] for c in go_comps(go) if docs[c][0] == 114 and "m_Spline:" in docs[c][1]), None)
    tex = re.search(r"m_ShapeTexture: \{fileID: \d+, guid: (\w+)", body)
    if not ctrl or not tex or tex.group(1) not in guid_path:
        continue
    pts = [dict(p=tuple(map(float, m[0:3])), l=tuple(map(float, m[3:6])), r=tuple(map(float, m[6:9])), mode=int(m[9]))
           for m in re.findall(r"- position: \{x: (\S+), y: (\S+), z: (\S+)\}\s+leftTangent: \{x: (\S+), y: (\S+), z: (\S+)\}\s+rightTangent: \{x: (\S+), y: (\S+), z: (\S+)\}\s+mode: (\d+)", ctrl)]
    if len(pts) < 3:
        continue
    poly = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        if a["mode"] == 0 and b["mode"] == 0:
            poly.append(a["p"][:2])
        else:
            p1 = tuple(x + y for x, y in zip(a["p"], a["r"])); p2 = tuple(x + y for x, y in zip(b["p"], b["l"]))
            poly += [bez(a["p"], p1, p2, b["p"], t / 16)[:2] for t in range(16)]
    m = world(tid)
    lid = int(re.search(r"m_SortingLayerID: (-?\d+)", body).group(1)) & 0xFFFFFFFF
    li, lname = layer_index.get(lid, (layer_index[0][0], "Default"))
    order = int(re.search(r"m_SortingOrder: (-?\d+)", body).group(1))
    col = re.search(r"m_Color: \{r: (\S+), g: (\S+), b: (\S+), a: (\S+)\}", body)
    ppu = float(re.search(r"m_FillPixelPerUnit: (\S+)", ctrl).group(1))
    aff = [m[0][0], K * (m[1][0] - m[2][0]), m[0][1], K * (m[1][1] - m[2][1]), m[0][3], K * (m[1][3] - m[2][3])]
    # keep shapes that overlap the region at all
    wxs = [m[0][0] * x + m[0][1] * y + m[0][3] for x, y in poly]; wys = [m[1][0] * x + m[1][1] * y + m[1][3] for x, y in poly]
    if max(wxs) < X0 or min(wxs) > X1 or max(wys) < Y0 or min(wys) > Y1:
        continue
    items.append({"shape": [[round(x, 3), round(y, 3)] for x, y in poly], "fill": os.path.relpath(guid_path[tex.group(1)], os.path.join(E, "Assets")),
                  "ppu": ppu, "aff": [round(v, 5) for v in aff], "c": [round(float(v), 3) for v in col.groups()],
                  "key": [li, order, -round(K * (m[1][3] + m[2][3]), 4)], "layer": lname, "name": re.search(r"m_Name: (.*)", docs[go][1]).group(1)})

# placeholder quads the game recolours with shaders; drawn raw they are just white/black boxes
# Leave out: placeholder quads the game recolours with shaders, shader-drawn outlines,
# winter-only snow variants, and two stray wooden-floor tile shapes near the shrine.
def keep(i):
    n = (sprite_cache[i["s"]]["name"] if "s" in i else i["name"]).lower()
    return n not in ("square32", "lightingsprite") and "outline" not in n and "snow" not in n and not n.startswith("woodenfloor")
items = [i for i in items if keep(i)]
items.sort(key=lambda i: i["key"])
json.dump({"bounds": [X0, X1, Y0, Y1], "world": base["world"], "sprites": {g: s for g, s in sprite_cache.items() if s},
           "items": items}, open(OUT, "w"))
print(len(items), "items", skipped, file=sys.stderr)
