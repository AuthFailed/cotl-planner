# Cult of the Lamb Planner

A browser-based layout planner for your cult's base in *Cult of the Lamb*. Pick a
building, drop it on the grid, share the layout as a link.

- The game's own build grid (1,223 cells), drawn like build mode over the base as the
  game renders it, from the game's camera angle
- Woolhaven land expansions as an option: south field, then west, then east (the order
  the game sells them), each with its own background; saved in the share link
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

`data/base.json` holds the buildable cells: `tiles` for the base, and `expansions[N]` for
the cells each Woolhaven land purchase adds. They come from the game itself: the capture
plugin (below) rebuilds `PlacementRegion`'s grid for every land level and dumps it, and
`python3 tools/capture/grid_to_base.py grid.json` writes it into `base.json`, leaving out
the 18-cell bridge strip the game reserves.

`tools/extract_base.py` derives the same grid from an [AssetRipper](https://github.com/AssetRipper/AssetRipper)
export of the `Base Biome 1` scene (flood fill over the placement polygon, land slots
from `DLCLandController`). It also provides the region origin (`world`, `rotation`), and
matches the game's dump except for one edge cell.

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

`data/background.webp` is rendered by the game itself. `tools/capture/PlannerCapture.cs`
is a BepInEx 5 plugin that continues a save, switches saving off, hides the UI, player,
followers, placed buildings and obstacles, and renders the base with the game's own
camera, shaders and colour grading, looking down at 45° without perspective (the
planner's projection). Focus blur, vignette and grain are switched off for the capture.
For each land level (switched in memory with the game's own `DLCLandController`) it
writes `landN.png`, the grid dump `grid.json`, and `gridN.png` with the game's build-mode
tiles on every cell, plus `capture.json`, then quits.

To redo it: install BepInEx 5 in the game, build with
`tools/capture/build.sh "<game>/Cult Of The Lamb_Data/Managed" "<game>/BepInEx/core"`
(needs the .NET SDK), copy `PlannerCapture.dll` into `BepInEx/plugins`, start the game,
then **remove the DLL**: while installed it blocks all saving. Convert each `landN.png` to
a 4096-wide `data/background-N.webp` and set `data/background.json`
(`u0 = u_left - world.x`, `v0 = v_top - 0.7071 * world.y`, with `world` from `data/base.json`).

`tools/background/compose.html` is an older fallback that composites the scene's sprites
straight from an AssetRipper export; it lacks the game's shaders and lighting.

## Tests

```bash
node tools/test.mjs
```

## Not done yet

- The DLC shrine room
- Spine-animated building parts; about 40 decorations still use wiki icons and sizes
- Follower reach areas (farmer station, propaganda speakers)

## Legal

Code is MIT licensed (see `LICENSE`). Building names and sizes come from the
fandom wiki (CC BY-SA); the base grid coordinates are derived from the game's scene data.
`data/background.webp` and `data/sprites.webp` are rendered from the game's own art and
are included here for this fan tool only. Building icons are loaded from the wiki's CDN and are not included. *Cult of the Lamb* and its art belong to Massive Monster
and Devolver Digital. This is an unofficial fan project, not affiliated with them.
