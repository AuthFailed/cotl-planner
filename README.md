# Cult of the Lamb Planner

A browser-based layout planner for your cult's base in *Cult of the Lamb*. Pick a
building, drop it on the grid, share the layout as a link.

- The real base grid (1,222 cells, Shrine plaza and landmarks), extracted from the
  game files and drawn rotated 45° like in-game
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

Sizes come from each building page's infobox (`size = WxH`). When a page has no
size, an upgrade takes its base tier's size, and anything else gets **1×1 marked
as a guess** (shown as `1×1?` in the sidebar).

**Help wanted:** if you know a real footprint, add it to `data/overrides.json`,
for example `{"Shrine": {"w": 5, "h": 5}}`, then rerun the scraper. Even better,
also fix the wiki infobox so everyone benefits.

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

## Tests

```bash
node tools/test.mjs
```

## Not done yet

- Land expansions (purchased land, Woolhaven) and the DLC shrine room
- Background art of the base
- Follower reach areas (farmer station, propaganda speakers)

## Legal

Code is MIT licensed (see `LICENSE`). Building names and sizes come from the
fandom wiki (CC BY-SA); the base grid coordinates are derived from the game's scene data.
No game files or art are included. Icons are loaded from the wiki's CDN and are **not**
included in this repo. *Cult of the Lamb* and its art belong to Massive Monster
and Devolver Digital. This is an unofficial fan project, not affiliated with them.
