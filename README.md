# Cult of the Lamb Planner

A browser-based layout planner for your cult's base in *Cult of the Lamb*. Pick a
building, drop it on the grid, share the layout as a link.

- The real base grid (1,222 cells, Shrine plaza and landmarks), extracted from the
  game files, drawn over the base's own art with the game's camera angle
- Buildings drawn with their real in-game sprites and exact footprints, standing on the
  grid back to front like in-game
- 220+ buildings and decorations, grouped as on the wiki, with their grid footprints
- Overlap and buildable-ground checks, rotate, move, delete
- The whole layout lives in the URL — "Copy link" is your save file
- Export to PNG

No build step, no backend: static files only.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly from disk won't work,
because browsers block `fetch()` of the data file over `file://`.)

## Controls

| Action | How |
|---|---|
| Place | pick a building in the sidebar, click the grid (keeps painting) |
| Move | click a placed building, then click its new spot |
| Delete | right-click a placed building |
| Rotate | `R` or the Rotate button while placing |
| Cancel | `Esc` |

## Building data

`data/buildings.json` is generated from the
[Cult of the Lamb fandom wiki](https://cult-of-the-lamb.fandom.com/wiki/Buildings):

```bash
python3 tools/scrape_wiki.py > data/buildings.json
```

The planner then overrides sizes with the game's own footprints from `data/game.json`
(see below) for every building it can match, about 180 of them. For the rest, sizes
come from each wiki page's infobox (`size = WxH`); an upgrade takes its base tier's size,
and anything else gets **1×1 marked as a guess** (shown as `1×1?` in the sidebar).
Known real footprints for those can go in `data/overrides.json`, for example
`{"Hay Wall": {"w": 1, "h": 1}}`, then rerun the scraper.

## Base grid

`data/base.json` holds the buildable cells and landmark positions of the cult base,
derived from the game's `Base Biome 1` scene. The game flood-fills integer points
inside the placement region's polygon collider, and `tools/extract_base.py` repeats
that. To regenerate it from your own copy of the game, export the scene with
[AssetRipper](https://github.com/AssetRipper/AssetRipper) (see the script's
docstring), then run:

```bash
python3 tools/extract_base.py path/to/ExportedProject > data/base.json
```

Rubble, trees and weeds are randomised in each save, so they aren't part of the grid.

## Game data and building sprites

`tools/background/build_sprites.py` reads the game's own build list (the base scene's
`TypeAndPlacementObjects`): each structure type, its placement prefab (exact footprint)
and its building prefab (the in-game sprites). It writes `data/game.json` (type, English
name from the game's localisation, footprint, and the wiki-name to type mapping) and a
draw list that `compose_sprites.html` renders into one atlas, `data/sprites.webp` +
`data/sprites.json`. Each sprite stores its anchor, the centre of the footprint's first
cell, which is where the game places the prefab. Spine-animated parts and UI gauges are
not drawn, and buildings without plain sprites fall back to the wiki icon. In-game
"rotate" mirrors a building, and so does the planner's Flip.

## Background art

`data/background.webp` is composited from the same scene: every active sprite and
SpriteShape ground fill around the base, projected with the game's camera (orthographic,
pitched 45°), sorted by sorting layer, order and depth. Shader effects (lighting, grass
sway, outlines), Spine-animated props and winter snow variants are left out, so it looks
flatter than the game. To rebuild it, see the docstring in
`tools/background/build_drawlist.py`.

## Tests

```bash
node tools/test.mjs
```

## Not done yet

- Land expansions (purchased land, Woolhaven) and the DLC shrine room
- Spine-animated building parts; about 40 decorations still use wiki icons and sizes
- Follower reach areas (farmer station, propaganda speakers)

## Legal

Code is MIT licensed (see `LICENSE`). Building names and sizes come from the
fandom wiki (CC BY-SA); the base grid coordinates are derived from the game's scene data.
`data/background.webp` and `data/sprites.webp` are rendered from the game's own art and
are included here for this fan tool only. Building icons are loaded from the wiki's CDN and are not included. *Cult of the Lamb* and its art belong to Massive Monster
and Devolver Digital. This is an unofficial fan project, not affiliated with them.
