#!/usr/bin/env python3
"""Regenerate data/base.json (buildable cells + landmarks) from the game's base scene.

1. Export the game with AssetRipper (File > Export > Unity Project). Load only the
   base scene's bundles: AssetRipper 2.0.0 crashes on a sprite-atlas clash if you
   load the whole game.
2. python3 tools/extract_base.py <ExportedProject> > data/base.json

How the game builds the grid (PlacementRegion.FloodFillCreateTiles): integer
points in the region's local space, flood-filled from (0,0), kept while inside
the region's PolygonCollider2D. Building footprints extend +x/+y from their tile.
"""
import json
import math
import os
import re
import sys

E = sys.argv[1]
SCENE = os.path.join(E, "Assets/Scenes/Base Biome 1.unity")
LANDMARKS = {"SHRINE_BASE": "Shrine", "COLLECTED_RESOURCES_CHEST": "Resource Chest", "MISSION_SHRINE": "Mission Shrine"}

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
tiles, stack = set(), [(0, 0)]
while stack:
    x, y = stack.pop()
    if (x, y) in tiles or len(tiles) >= max_tiles or not inside(x, y, polys):
        continue
    tiles.add((x, y))
    stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]

# Landmarks, converted from world space into the region's grid space.
enum = open(os.path.join(E, "Assets/Scripts/Assembly-CSharp/StructureBrain.cs")).read()
enum = enum[enum.index("public enum TYPES"):]
enum = enum[enum.index("{") + 1:enum.index("}")]
types, i = {}, 0
for item in filter(None, (s.strip() for s in enum.split(","))):
    if "=" in item:
        item, v = (s.strip() for s in item.split("="))
        i = int(v)
    types[i] = item
    i += 1

rx, ry = world(region_go)
_, _, ra = local(transform(region_go))
landmarks = []
for c, b in docs.values():
    if c == 114 and script(b) == "Structure":
        t = types.get(int(re.search(r"Type: (\d+)", b).group(1)))
        if t in LANDMARKS:
            wx, wy = world(game_object(b))
            gx, gy = rotate(wx - rx, wy - ry, -ra)
            landmarks.append({"name": LANDMARKS[t], "x": round(gx, 2), "y": round(gy, 2)})

json.dump({"rotation": round(math.degrees(ra)), "tiles": sorted(tiles), "landmarks": sorted(landmarks, key=lambda l: l["name"])},
          sys.stdout, separators=(",", ":"))
print(f"{len(tiles)} tiles, {len(landmarks)} landmarks", file=sys.stderr)
