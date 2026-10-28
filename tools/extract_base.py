#!/usr/bin/env python3
"""Regenerate public/data/base.json (buildable cells, plus the Woolhaven land expansions) from the
game's base scene.

1. Export the game with AssetRipper (File > Export > Unity Project). Load only the
   base scene's bundles: AssetRipper 2.0.0 crashes on a sprite-atlas clash if you
   load the whole game.
2. python3 tools/extract_base.py <ExportedProject> > public/data/base.json

How the game builds the grid (PlacementRegion.FloodFillCreateTiles): integer
points in the region's local space, flood-filled from (0,0), kept while inside
the region's PolygonCollider2D. Building footprints extend +x/+y from their tile.

Land expansions (DLCLandController.landSlots, bought in a fixed order: south, then west,
then east): the game appends slot N's FullCollider to the placement polygon and floods
again from (-15,-15). Quirk kept here: it reads that collider's raw points as world
coordinates (GetPath without TransformPoint). "expansions"[N] lists only the cells slot N
adds on top of the previous level.
"""
import json
import math
import os
import re
import sys

E = sys.argv[1]
SCENE = os.path.join(E, "Assets/Scenes/Base Biome 1.unity")

guid_to_script = {}
for root, _, files in os.walk(os.path.join(E, "Assets/Scripts")):
    for f in files:
        if f.endswith(".cs.meta"):
            m = re.search(r"guid: (\w+)", open(os.path.join(root, f)).read())
            if m:
                guid_to_script[m.group(1)] = f[:-8]

text = open(SCENE).read()
docs = {m.group(2): (int(m.group(1)), m.group(3))
        for m in re.finditer(r"--- !u!(\d+) &(-?\d+)[^\n]*\n(.*?)(?=\n--- !u!|\Z)", text, re.S)}


def script(body):
    m = re.search(r"m_Script: \{fileID: \d+, guid: (\w+)", body)
    return guid_to_script.get(m.group(1)) if m else None


def game_object(body):
    return re.search(r"m_GameObject: \{fileID: (-?\d+)", body).group(1)


def transform(go):
    for c in re.findall(r"component: \{fileID: (-?\d+)\}", docs[go][1]):
        if docs.get(c, (0,))[0] in (4, 224):  # Transform / RectTransform
            return docs[c][1]


def local(t):
    p = re.search(r"m_LocalPosition: \{x: (\S+), y: (\S+), z", t).groups()
    q = re.search(r"m_LocalRotation: \{x: \S+, y: \S+, z: (\S+), w: (\S+)\}", t).groups()
    # z-rotation from the quaternion; m_LocalEulerAnglesHint has the wrong sign in this scene
    return float(p[0]), float(p[1]), 2 * math.atan2(float(q[0]), float(q[1]))


def rotate(x, y, a):
    return x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)


def world(go):
    x = y = 0.0
    t = transform(go)
    while t:
        px, py, a = local(t)
        x, y = rotate(x, y, a)
        x, y = x + px, y + py
        father = re.search(r"m_Father: \{fileID: (-?\d+)", t).group(1)
        t = docs[father][1] if father != "0" else None
    return x, y


def inside(x, y, polys):  # even-odd rule across all collider paths
    c = False
    for P in polys:
        for i in range(len(P)):
            (x1, y1), (x2, y2) = P[i], P[i - 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
    return c


# The main base region lives under "Room"; the other one is the DLC shrine room.
regions = [b for c, b in docs.values() if c == 114 and script(b) == "PlacementRegion"]
region = min(regions, key=lambda b: abs(world(game_object(b))[0]))
region_go = game_object(region)
collider = docs[re.search(r"polygonCollider2D: \{fileID: (-?\d+)", region).group(1)][1]
cx, cy, ca = local(transform(game_object(collider)))  # collider sits on a child of the region
ox, oy = map(float, re.search(r"m_Offset: \{x: (\S+), y: (\S+)\}", collider).groups())
polys = []
for path in re.split(r"\n\s*- - ", collider.split("m_Paths:")[1])[1:]:
    pts = [(float(a), float(b)) for a, b in re.findall(r"x: (\S+), y: (\S+)\}", path)]
    polys.append([(lambda p: (p[0] + cx, p[1] + cy))(rotate(x + ox, y + oy, ca)) for x, y in pts])

max_tiles = int(re.search(r"MaxTileCount: (\d+)", region).group(1))


def flood(seed, test, tiles):
    added, stack = 0, [seed]
    while stack:
        x, y = stack.pop()
        if (x, y) in tiles or added >= max_tiles or not test(x, y):
            continue
        tiles.add((x, y)); added += 1
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return tiles


main = flood((0, 0), lambda x, y: inside(x, y, polys), set())

rx, ry = world(region_go)
_, _, ra = local(transform(region_go))
controller = next(b for c, b in docs.values() if c == 114 and script(b) == "DLCLandController")
expansions, previous = [], main
for full in re.findall(r"FullCollider: \{fileID: (-?\d+)\}", controller):
    raw = [[(float(a), float(b)) for a, b in re.findall(r"x: (\S+), y: (\S+)\}", path)]
           for path in re.split(r"\n\s*- - ", docs[full][1].split("m_Paths:")[1])[1:]]
    land = [[rotate(wx - rx, wy - ry, -ra) for wx, wy in path] for path in raw]  # world -> region grid
    test = lambda x, y, land=land: inside(x, y, polys) or inside(x, y, land)
    level = flood((-15, -15), test, flood((0, 0), test, set()))
    expansions.append(sorted(level - previous))
    previous = level

json.dump({"rotation": round(math.degrees(ra)), "world": [round(rx, 4), round(ry, 4)], "tiles": sorted(main),
           "expansions": expansions}, sys.stdout, separators=(",", ":"))
print(f"{len(main)} tiles, expansions add {[len(e) for e in expansions]}", file=sys.stderr)
