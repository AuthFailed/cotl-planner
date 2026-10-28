# Cult of the Lamb Planner

A browser-based layout planner for your cult's base in *Cult of the Lamb*. Pick a
building, drop it on the grid, share the layout as a link. Live at https://map.cotl.info.

- The game's own build grid (1,223 cells), drawn like build mode over the base as the
  game renders it, from the game's camera angle
- Woolhaven land upgrades as an option: 1 upgrade (south), 2 (south + west), 3 (south +
  west + east), the order the game sells them, each with its own background; saved in the
  share link
- Weather and time of day: day, night, rain, blood moon, winter and blizzard, each
  rendered by the game (ground and buildings, with its lighting, snow and colour grading),
  with the game's weather tint and falling rain or snow on top
- Buildings rendered by the game itself (shaders, Spine art, lighting), with exact
  footprints, standing on the grid back to front like in-game
- Lamps, torches and furnaces light their surroundings as the game does: inside each one's
  light the scene is graded with the game's second, lit colour grading
- Fires, flags and other animated buildings play their idle loop (still with reduced motion
  and in PNG exports)
- Captured at the game art's own resolution (200 px per world unit) and served at 128, twice
  the earlier detail; backdrops come in tiles at the detail the zoom needs. "Picture quality"
  lowers the textures, the animations or both to ½ or ⅓ for slower devices
- The game's build rules: one-per-base buildings (moving the existing one if you place
  another), upgrade levels picked on the map, and the Temple placed by default, movable but
  not removable
- The game's build menu: 266 buildings and decorations in the game's own tabs and sections,
  each with its in-game description
- Fully translated into the 15 languages the game ships (Arabic right to left): building
  names, descriptions and menu titles come from the game's own translations, the planner's
  interface text from `tools/i18n/ui.json`
- Works on phones: the building list is a bottom sheet, one finger places or pans, two
  fingers pinch to zoom
- Overlap and buildable-ground checks, rotate, move, delete
- The whole layout lives in the URL — "Copy link" is your save file
- Import your real base from the game's save file (⋯ menu → Import save): buildings with their
  levels and flips, and the land you've bought; the file is read in the browser, never uploaded
- Export to PNG

TypeScript, built with [Vite](https://vite.dev); no backend, the build is static files.

## Develop

```bash
npm install
npm run dev      # dev server with hot reload
npm test         # layout logic and data checks (Node 22.6+, runs the TypeScript directly)
npm run check    # type-check (strict)
npm run build    # type-check + production build into dist/
```

- `src/core.ts`: pure layout logic (footprints, fit checks, the share-link format), shared with the tests
- `src/save.ts`: reads the game's save files (below), shared with the tests
- `src/app.ts`: the page: map drawing, input, palette, translations
- `src/types.ts`: shapes of the data files
- `public/data/`: game data, translations and art, copied into the build as is
- `tools/`: the pipelines that produce `public/data/` (below)

Pushing to `main` builds and deploys to GitHub Pages (`.github/workflows/pages.yml`); in the
repository settings, Pages' source must be set to **GitHub Actions** and its custom domain to
`map.cotl.info` (DNS: a CNAME record `map` → `authfailed.github.io`, not proxied, so GitHub can
issue the HTTPS certificate).

## Controls

| Action | How |
|---|---|
| Place | pick a building in the sidebar, click the grid (keeps painting); on a phone, drag it into place and lift your finger |
| Change level | click (tap) a placed building, pick I, II, III... |
| Move | drag a placed building, or click it and choose Move |
| Delete | right-click a placed building, or select it and choose Delete |
| Flip | `R` or the Flip button (the game mirrors buildings) |
| Zoom | scroll or pinch; `F` fits the base |
| Cancel | `Esc`, or the × next to the building you're holding |

## Building data

`public/data/buildings.json` is generated from the
[Cult of the Lamb fandom wiki](https://cult-of-the-lamb.fandom.com/wiki/Buildings):

```bash
python3 tools/scrape_wiki.py > public/data/buildings.json
node tools/vendor_icons.mjs   # copies the icons still shown into public/data/icons/ (needs cwebp)
```

Sizes, names and the building list now come from the game (`public/data/game.json`, below). The
wiki data is still used for two things: build-menu icons for the few buildings without a
game render, and reading share links made before layouts were keyed by the game's type
names (they named buildings by their wiki names).

## Base grid

`public/data/base.json` holds the buildable cells: `tiles` for the base, and `expansions[N]` for
the cells each Woolhaven land purchase adds. They come from the game itself: the capture
plugin (below) rebuilds `PlacementRegion`'s grid for every land level and dumps it, and
`python3 tools/capture/grid_to_base.py grid.json` writes it into `base.json`, leaving out
the 18-cell bridge strip the game reserves.

`tools/extract_base.py` derives the same grid from an [AssetRipper](https://github.com/AssetRipper/AssetRipper)
export of the `Base Biome 1` scene (flood fill over the placement polygon, land slots
from `DLCLandController`). It also provides the region origin (`world`, `rotation`), and
matches the game's dump except for one edge cell.

Rubble, trees and weeds are randomised in each save, so they aren't part of the grid.

## Game data, rules and translations

`tools/background/build_sprites.py` also parses the game's build rules from
`StructuresData`: `GetBuildOnlyOne` (one per base, counting every level of an upgrade
chain), `GetUpgradePath` (the levels) and `isDeletable` (the Temple can be moved but never
removed). They land in `public/data/game.json` as `once`, `chains` and `fixed`, next to `menu`: the
build menu's tabs and sections as the game's `FollowerCategory`, `FaithCategory`,
`AestheticCategory` and `MajorDLCCategory` list them, with the localisation term of each
title. Wiki entries are matched to game types by the game's own English names.
`public/data/base.json` `defaults` holds the Temple's usual spot.

`public/data/i18n/<code>.json` holds one language: building names (`Structures/<TYPE>`),
descriptions (`Structures/<TYPE>/Description`, as plain text: colour tags dropped, inline
item icons dropped or, where they stand in for a word, replaced by the item's name), the
menu titles, and the planner's own strings from `tools/i18n/ui.json`, which are written by
hand for every language. `public/data/i18n/index.json` lists the languages. The capture plugin's
Translations job dumps every term of the game's I2 Localization data, and
`python3 tools/capture/i18n_to_data.py i18n.json` writes these files. Anything missing in a
language falls back to English in the page.

## Building sprites (older pipeline)

`tools/background/build_sprites.py` reads the game's own build list (the base scene's
`TypeAndPlacementObjects`): each structure type, its placement prefab (exact footprint)
and its building prefab (the in-game sprites). It writes `public/data/game.json` (type, English
name from the game's localisation, footprint, and the wiki-name to type mapping) and a
draw list that `compose_sprites.html` renders into one atlas, `public/data/sprites.webp` +
`public/data/sprites.json`. Each sprite stores its anchor, the centre of the footprint's first
cell, which is where the game places the prefab. Spine-animated parts and UI gauges are
not drawn, and buildings without plain sprites fall back to the wiki icon. In-game
"rotate" mirrors a building, and so does the planner's Flip.

## Building renders

`public/data/looks/<look>/sprites.json` and its sheets hold every buildable structure as the game draws it: the capture
plugin's Buildings job loads each building prefab through Addressables, strips its gameplay
scripts (keeping Spine and the scripts that set up its lights, switching off range
indicators and particles), places it on open ground in the base, and renders it alone over
black and over white to recover exact transparency, at `Ppu` pixels per world unit (200, the
art's own resolution: the plugin's Density job measures it). `tools/capture/pack_sprites.html` packs
the results into the atlas; each sprite keeps its anchor, the centre of the footprint's first cell.
The atlas has two sheets: `sprites` with the build menu's buildings and the Temple (what a first
visit draws) and `sprites-2` with the upgrade levels, which the page fetches only once one is on screen.
Every sheet also comes at ½ and ⅓ (`@2`, `@3`), with sizes and places in steps of 6 so the same
coordinates, divided by 2 or 3, fit them exactly.

- **Animation**: a building with an idle loop (Spine, an Animator, or a shader that moves it,
  like flags in the wind) is rendered once per frame over exactly one loop of its longest part,
  the game's clock stepped by `Time.captureDeltaTime` so all of it moves together. This game's
  Spine only animates skeletons its camera shows, so the game's camera looks at the building
  meanwhile. The atlas keeps the first frame; the packer cuts out the part that moves and puts
  that part of every frame on a sheet of its own (`anim/<TYPE>`), which the page fetches once
  that building is on the map. `sprites.json` `anim` says where it goes and how fast it plays.
  The packer warns about loops that end standing still (the game's clock stopped mid-loop).
- **Lamp light**: the game grades the screen with two LUTs and blends between them by a light
  mask, which its lighting camera draws mid-frame from each light's decals and volumes (layer
  20) against the camera's depth texture. The plugin draws that mask the same way for its own
  frames (`LightMask`: a command buffer inside a near-orthographic perspective render, which
  the decal shaders need). For each building that casts light it saves the mask it casts on
  open ground (`lights/<TYPE>`, `mask:<TYPE>` in `lights.json`, alpha = how lit), and for looks whose
  lit LUT differs (`lut-lit.png`) every sheet graded with it (`<sheet>-lit`, same layout). Its
  additive light (halos, light shafts) is `glow:<TYPE>`, added on top. The planner draws the
  scene again from the lit art, cuts it to the placed buildings' masks added up, and lays it
  over: normal × (1 − light) + lit × light, as the game's shader does.

The plugin switches off the game's performance mode (in memory) before loading the base: that
option changes how the game draws lamp light and stops some animations. The game also opens
menus on its own (tutorials, the pause menu) that stop its clock; the plugin closes them.

## Background art

`public/data/looks/<look>/background-N` (N = land upgrades bought) is rendered by the game itself. `tools/capture/PlannerCapture.cs`
is a BepInEx 5 plugin that continues a save, switches saving off, hides the UI, player,
followers, placed buildings and obstacles, and renders the base with the game's own
camera, shaders and colour grading, looking down at 45° without perspective (the
planner's projection). Focus blur, vignette and grain are switched off for the capture.
For each land level (switched in memory with the game's own `DLCLandController`) it
writes the backdrop as tiles, `landN/<col>_<row>.png` (4096 x 2048 at `Ppu`, each with a 4 px
border of its neighbours' pixels so they join without seams), the grid dump `grid.json`, and
`gridN.png` with the game's build-mode tiles on every cell, plus `capture.json`, then quits.
Each tile is cut from the middle of a frame the size of the game's own view (about 29.5 x 16.6
units), so screen-wide effects like bloom reach as far as in the game, and all of a backdrop's
tiles are rendered within one game frame. The dappled-sunlight overlay is drawn in screen space
and would repeat in every tile, so it stays off.

To redo it: install BepInEx 5 in the game, build with
`tools/capture/build.sh "<game>/Cult Of The Lamb_Data/Managed" "<game>/BepInEx/core"`
(needs the .NET SDK), copy `PlannerCapture.dll` into `BepInEx/plugins`, start the game,
then **remove the DLL**: while installed it blocks all saving. `public/data/background.json` holds the
backdrop's placement (`u0 = u_left - world.x`, `v0 = v_top - 0.7071 * world.y`, with `world`
from `public/data/base.json`).

### Weather and time of day

With `Looks = day,night,rain,bloodmoon,winter,blizzard` in the plugin's config
(`BepInEx/config/chrsnv.cotlplanner.capture.cfg`, section `[Jobs]`), the Buildings and
Backgrounds jobs run once per look, each into its own folder. Before each one the plugin
switches the game in memory: the clock (the game's light follows the day phase, and its clock
only runs forward, so afternoon looks go first), the season (winter, with what the game fires on
a season change), the weather (the base scene's presets: heavy rain, heavy snow, extreme snow for
the blizzard) and the blood moon lighting (the base turns that off again unless the game's own
blood moon timer says one is on, so the plugin sets that too). Snow and rain are shader settings,
so buildings are rendered again for each look, with their winter-only parts on in winter. The
look's colour grading (Amplify Color LUTs and exposure, a post-processing pass the black/white
cutout can't go through) is measured by rendering an identity colour chart through it, saved as
`lut.png`, and applied to each building render. Lamps grade their surroundings with a second
LUT and clouds cast moving shadows, so the chart is drawn small, far from the base's lights,
with the cloud overlay off, at five spots, and each entry is the median. The same chart with
the light mask forced on gives the lit LUT (`lut-lit.png`); where it differs, the backdrops
are also rendered all lit (`lit/landN.png`, for the planner to show through placed lamps). The plugin also
supports `dusk`, but the base lights dusk exactly like day, so the planner leaves it out.

Snow shows trails (whatever walked through it) from two render textures the game fills around
its camera and the player. Past their edge the snow samples the edge, so a footprint there runs
on as a stripe across the backdrop, which the game's own camera never sees. The plugin sets both
to black, their cleared state, so the backdrops show untrodden snow.
Then, with the capture folder served by `tools/background/serve.py` copied into it (so `save()`
writes into it) and `data/game.json` and `data/base.json` next to it, pack each look:
`pack_sprites.html?look=<look>&scale=0.64` (the buildings: `save()` in the console writes
`<look>/packed/sprites.png`, `sprites-2.png`, their `-lit` copies, `anim/<TYPE>.png`, all at ½ and
⅓ too, and `sprites.json`), `&set=lights` (each building's light, `lights/<TYPE>.png`, and
`lights.json`) and `&set=small` (`small/landN.png`, each backdrop 512 wide, drawn while its tiles
load), then:

```bash
tools/capture/looks_to_data.sh <capture dir> 128   # -> public/data/looks/<look>/, looks and tiles in background.json
```

It cuts the backdrops into square tiles of 2048 capture pixels (plus the border) at full detail, ½ and ⅓, and encodes
every picture as AVIF; the ⅓ ones also as WebP, which browsers without AVIF get for everything. It
needs `cwebp`, `dwebp` and `avifenc`. The site keeps everything in this repository and GitHub Pages
allows 1 GB, so the capture's 200 px per unit is kept at 128 (`scale=0.64`, `128`): about 130 MB per
look. Every new capture adds that much to the repository's history. The game's weather tint (a colour it lays over
the screen) is listed in `background.json` and drawn by the planner, which also animates the
falling rain and snow (left out of captures, where they'd freeze into dots).

`tools/background/compose.html` is an older fallback that composites the scene's sprites
straight from an AssetRipper export; it lacks the game's shaders and lighting.

## Save files

`src/save.ts` reads `saves/slot_N.mp` (and `slot_N.json` from older versions) in the browser. Both
start with `E`, then a 16-byte AES key and a 16-byte IV; the rest is AES-128-CBC. Inside, the JSON
saves name their fields; the `.mp` ones are MessagePack-CSharp, LZ4-compressed (ext 98, block
array), with every object an array indexed by its `[Key(n)]` numbers: `DataManager[1117]` is
`BaseStructures`, `[1013]` `LandPurchased`; in each `StructuresData`, `[0]` is `Type`, `[30]`
`Location`, `[43]` `GridTilePosition` (the planner's cell) and `[51]` `Direction` (-1 = flipped).
`Type` is the game's `StructureBrain.TYPES` number, stored in `public/data/game.json` as each
type's `id`. The keys come from the game's `Assembly-CSharp.dll`; if an update moves them, the
importer needs the new numbers.

The save folder: Windows `%USERPROFILE%\AppData\LocalLow\Massive Monster\Cult Of The Lamb\saves`;
macOS `~/Library/Application Support/Massive Monster/Cult Of The Lamb/saves`; Steam Deck and
Linux (Proton) `~/.local/share/Steam/steamapps/compatdata/1313140/pfx/drive_c/users/steamuser/AppData/LocalLow/Massive Monster/Cult Of The Lamb/saves`.

## Tests

```bash
node tools/test.mjs
```

## Not done yet

- The DLC shrine room
- 16 menu entries (mostly paths) still use wiki icons
- Follower reach areas (farmer station, propaganda speakers)

## Legal

Code is MIT licensed (see `LICENSE`). Building names and sizes come from the
fandom wiki (CC BY-SA); the base grid coordinates are derived from the game's scene data.
`public/data/looks/` is rendered from the game's own art, and
`public/data/i18n/` holds the game's building names and descriptions; they're included here for this fan tool only. The fallback building icons in `public/data/icons/` are from the [fandom wiki](https://cult-of-the-lamb.fandom.com/wiki/Buildings) (CC BY-SA 3.0), downscaled to WebP. *Cult of the Lamb* and its art belong to Massive Monster
and Devolver Digital. This is an unofficial fan project, not affiliated with them.
