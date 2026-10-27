"""Shared helpers for reading an AssetRipper Unity export (scenes and prefabs as YAML)
and turning SpriteRenderers into draw items projected like the game camera:
orthographic, pitched 45°, so u = x and v = cos45 * (y - z)."""
import math, os, re

K = math.sqrt(0.5)
SKIP_LAYERS = {"DepthFX", "Lighting", "VFX", "Ground UI"}


def guid_index(E):
    """guid -> asset path for every exported asset."""
    out = {}
    for root, _, files in os.walk(os.path.join(E, "Assets")):
        for f in files:
            if f.endswith(".meta"):
                with open(os.path.join(root, f), errors="ignore") as fh:
                    m = re.search(r"guid: (\w+)", fh.read(200))
                if m:
                    out[m.group(1)] = os.path.join(root, f[:-5])
    return out


def sorting_layers(E):
    tm = open(os.path.join(E, "ProjectSettings/TagManager.asset")).read()
    layers = re.findall(r"- name: (.*)\n\s+uniqueID: (\d+)", tm.split("m_SortingLayers:")[1])
    return {int(uid): (i, name) for i, (name, uid) in enumerate(layers)}


def f3(s, key):
    return tuple(map(float, re.search(key + r": \{x: (\S+), y: (\S+), z: (\S+)\}", s).groups()))


def trs(t, keep_position=True, keep_rotation=True):
    px, py, pz = f3(t, "m_LocalPosition") if keep_position else (0, 0, 0)
    x, y, z, w = map(float, re.search(r"m_LocalRotation: \{x: (\S+), y: (\S+), z: (\S+), w: (\S+)\}", t).groups()) if keep_rotation else (0, 0, 0, 1)
    sx, sy, sz = f3(t, "m_LocalScale")
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[0][0] * sx, r[0][1] * sy, r[0][2] * sz, px],
            [r[1][0] * sx, r[1][1] * sy, r[1][2] * sz, py],
            [r[2][0] * sx, r[2][1] * sy, r[2][2] * sz, pz]]


def mul(a, b):  # 3x4 affine matrices
    return [[sum(a[i][k] * b[k][j] for k in range(3)) + (a[i][3] if j == 3 else 0) for j in range(4)] for i in range(3)]


class Doc:
    """One scene or prefab file: objects by fileID, transform hierarchy, active flags."""

    def __init__(self, path):
        text = open(path).read()
        self.docs = {m.group(2): (int(m.group(1)), m.group(3))
                     for m in re.finditer(r"--- !u!(\d+) &(-?\d+)[^\n]*\n(.*?)(?=\n--- !u!|\Z)", text, re.S)}
        self.go_transform = {}
        for k, (cls, body) in self.docs.items():
            if cls in (4, 224):
                g = re.search(r"m_GameObject: \{fileID: (-?\d+)", body)
                if g:
                    self.go_transform[g.group(1)] = k
        self._world, self._active = {}, {}
        self.root_override = None  # (transform id, matrix) to replace the root's own transform

    def father(self, tid):
        f = re.search(r"m_Father: \{fileID: (-?\d+)", self.docs[tid][1]).group(1)
        return f if f != "0" and f in self.docs else None

    def world(self, tid):
        if tid not in self._world:
            body = self.docs[tid][1]
            m = self.root_override[1] if self.root_override and self.root_override[0] == tid else trs(body)
            f = self.father(tid)
            self._world[tid] = mul(self.world(f), m) if f else m
        return self._world[tid]

    def active(self, tid):
        if tid not in self._active:
            go = re.search(r"m_GameObject: \{fileID: (-?\d+)", self.docs[tid][1]).group(1)
            ok = go in self.docs and "m_IsActive: 1" in self.docs[go][1]
            f = self.father(tid)
            self._active[tid] = ok and (self.active(f) if f else True)
        return self._active[tid]

    def name(self, go):
        m = re.search(r"m_Name: (.*)", self.docs[go][1])
        return m.group(1) if m else ""


class Sprites:
    """Sprite assets by guid: atlas texture, rect, pivot, pixels-per-unit, packing flags."""

    def __init__(self, E, guid_path):
        self.E, self.guid_path, self.cache = E, guid_path, {}

    def get(self, guid):
        if guid in self.cache:
            return self.cache[guid]
        p, res = self.guid_path.get(guid), None
        if p and p.endswith(".asset"):
            s = open(p).read()
            rd = s.split("m_RD:")[1] if "m_RD:" in s else ""
            tex = re.search(r"texture: \{fileID: \d+, guid: (\w+)", rd)
            tr = re.search(r"textureRect:\s+serializedVersion: \d+\s+x: (\S+)\s+y: (\S+)\s+width: (\S+)\s+height: (\S+)", rd)
            if tex and tex.group(1) in self.guid_path and tr:
                rect = re.search(r"m_Rect:\s+serializedVersion: \d+\s+x: \S+\s+y: \S+\s+width: (\S+)\s+height: (\S+)", s)
                off = re.search(r"textureRectOffset: \{x: (\S+), y: (\S+)\}", rd)
                piv = re.search(r"m_Pivot: \{x: (\S+), y: (\S+)\}", s)
                raw = int(re.search(r"settingsRaw: (\d+)", rd).group(1))
                res = {"tex": os.path.relpath(self.guid_path[tex.group(1)], os.path.join(self.E, "Assets")),
                       "tr": [float(v) for v in tr.groups()], "rect": [float(v) for v in rect.groups()],
                       "off": [float(v) for v in off.groups()], "pivot": [float(v) for v in piv.groups()],
                       "ppu": float(re.search(r"m_PixelsToUnits: (\S+)", s).group(1)),
                       "rot": (raw >> 2) & 0xF, "name": re.search(r"m_Name: (.*)", s).group(1)}
        self.cache[guid] = res
        return res


PLACEHOLDERS = {"square32", "lightingsprite", "simple square", "rough_whitesquare", "glowing ring"}


def keep_sprite(name):
    """Leave out placeholder quads the game recolours with shaders, light glows,
    shader-drawn outlines and winter-only snow variants."""
    n = name.lower()
    return n not in PLACEHOLDERS and not n.endswith("light") and "outline" not in n and "snow" not in n


def sprite_item(doc, body, sprites, layers):
    """Draw item for an enabled, active SpriteRenderer, or None."""
    if "m_Enabled: 1" not in body:
        return None
    go = re.search(r"m_GameObject: \{fileID: (-?\d+)", body).group(1)
    tid = doc.go_transform.get(go)
    if not tid or not doc.active(tid):
        return None
    lid = int(re.search(r"m_SortingLayerID: (-?\d+)", body).group(1)) & 0xFFFFFFFF
    li, lname = layers.get(lid, layers[0])
    if lname in SKIP_LAYERS or "UI" in lname.split():  # Game UI layers hold progress bars and gauges
        return None
    sg = re.search(r"m_Sprite: \{fileID: \d+, guid: (\w+)", body)
    sp = sprites.get(sg.group(1)) if sg else None
    if not sp or not keep_sprite(sp["name"]):
        return None
    m = doc.world(tid)
    col = re.search(r"m_Color: \{r: (\S+), g: (\S+), b: (\S+), a: (\S+)\}", body)
    order = int(re.search(r"m_SortingOrder: (-?\d+)", body).group(1))
    aff = [m[0][0], K * (m[1][0] - m[2][0]), m[0][1], K * (m[1][1] - m[2][1]), m[0][3], K * (m[1][3] - m[2][3])]
    if "m_FlipX: 1" in body:
        aff[0], aff[1] = -aff[0], -aff[1]
    if "m_FlipY: 1" in body:
        aff[2], aff[3] = -aff[2], -aff[3]
    return {"s": sg.group(1), "aff": [round(v, 5) for v in aff], "c": [round(float(v), 3) for v in col.groups()],
            "key": [li, order, -round(K * (m[1][3] + m[2][3]), 4)], "layer": lname, "pos": (m[0][3], m[1][3])}
