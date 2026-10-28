import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./icons/icons.css";
import { rect, fits, itemAt, encode, decode, cellsFor, reach, cellsBetween, type Placed, type Cell } from "./core.ts";
import { readSave } from "./save.ts";
import type { Atlas, Background, BaseData, Building, FloorRules, GameData, Language, MenuTab, Strings, WikiBuilding } from "./types.ts";

// The game rotates the base grid 45° (data/base.json "rotation") and its cameras look down
// at ~45°, which flattens the ground vertically by about cos 45°. So a cell (x, y) lands
// at K·(x − y, −V·(x + y)) before zoom and pan, and buildings stand upright on top.
const K = Math.SQRT1_2, V = Math.SQRT1_2;
const MIN_S = 6, MAX_S = 90;
const ROMAN = ["I", "II", "III", "IV", "V"];
const TAB_ICONS: Record<string, string> = { follower: "ph-users-three", faith: "ph-hands-praying", decor: "ph-flower-tulip", woolhaven: "ph-mountains" };

type View = { s: number; tx: number; ty: number };
type Size = { w: number; h: number; dpr: number };
type Mode = "normal" | "hover" | "erase" | "selected" | "ghost" | "blocked";
type Brush = { name: string; r: 0 | 1; from?: Placed; at?: number; grab?: CellXY };
type CellXY = { x: number; y: number };
type Tool = "select" | "erase" | "measure";
type Gesture =
  | { kind: "pan"; px: number; py: number; tx: number; ty: number; still: boolean }
  | { kind: "press"; p: Placed | undefined; px: number; py: number }
  | { kind: "pinch"; d: number; mx: number; my: number }
  | { kind: "paint" | "erase" | "drag" | "aim" | "measure" };

// Every id the script touches exists in index.html; the type parameter says what kind of element it is.
const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const canvas = $<HTMLCanvasElement>("map"), ctx = canvas.getContext("2d")!;
// Data URLs carry the data's version (git's hash of public/data, set by the build), so after a deploy the
// page never mixes new files with ones the browser cached from the last one (Pages caches for 10 minutes).
const DATA_VERSION = import.meta.env.VITE_DATA ? `?v=${import.meta.env.VITE_DATA}` : "";
const load = <T>(u: string): Promise<T | null> => fetch(u + DATA_VERSION).then(r => (r.ok ? r.json() : null)).catch(() => null);
const phone = matchMedia("(max-width: 767px)");

const [base, game, bg, atlas, dayFloors, floorRules, wiki, langs, en] = await Promise.all([
  load<BaseData>("data/base.json"), load<GameData>("data/game.json"), load<Background>("data/background.json"),
  load<Atlas>("data/looks/day/sprites.json"), load<Atlas>("data/looks/day/floors.json"), load<FloorRules>("data/floors.json"),
  load<WikiBuilding[]>("data/buildings.json"),
  load<Language[]>("data/i18n/index.json"), load<Strings>("data/i18n/en.json"),
]);
if (!base || !game) throw new Error("planner data missing");

// ---------- buildings, keyed by the game's structure type (BED, TEMPLE_II, ...) ----------
// A placed building is { name: type, x, y, r }. The build menu (game.menu, as the game groups it)
// lists each building's first level; the other levels of its upgrade chain are picked on the map.
const chainOf: Record<string, string[]> = {};
for (const chain of game.chains) for (const T of chain) chainOf[T] = chain;
const wikiOf: Record<string, WikiBuilding> = {}; // the wiki's entry for a type: an English name and a build-menu icon (fallback art)
for (const b of wiki ?? []) if (game.wiki[b.name]) wikiOf[game.wiki[b.name]] ??= b;
const byType: Record<string, Building> = {}, tabOf: Record<string, MenuTab> = {};
for (const tab of game.menu) for (const s of tab.sections) for (const head of s.types)
  for (const T of chainOf[head] ?? [head]) {
    // higher levels only when there's something to draw for them
    if (T !== head && !atlas?.items[T] && !wikiOf[T]?.icon) continue;
    const t = game.types[T];
    byType[T] ??= { type: T, w: t.w, h: t.h, once: !!t.once, fixed: !!t.fixed, icon: wikiOf[T]?.icon };
    tabOf[T] ??= tab;
  }
// one building per chain, whatever its level, counts against the limit
const chainKey = (T: string) => chainOf[T]?.[0] ?? T;
const tiersOf = (T: string) => (chainOf[T] ?? [T]).filter(X => byType[X]);
const limitOf = (T: string) => (byType[T].once ? 1 : Infinity);
const deletable = (p: Placed) => !byType[p.name].fixed;
// The Shrine in the middle of the base stands off the grid and never moves; the game upgrades it with the
// Temple (Cult II-IV), so it is drawn at the Temple's level.
const shrines = (chainOf.SHRINE ?? []).filter(T => atlas?.items[T]);
for (const T of shrines) byType[T] ??= { type: T, w: game.types[T].w, h: game.types[T].h, once: true, fixed: true };
function shrine(): Placed | null {
  const temple = [...placed, brush?.from].find(p => p && chainKey(p.name) === "TEMPLE"); // a Temple being moved still counts
  const T = shrines[temple ? chainOf.TEMPLE.indexOf(temple.name) : 0] ?? shrines.at(-1);
  return base!.shrine && T ? { name: T, x: base!.shrine.x, y: base!.shrine.y, r: 0 } : null;
}
// Paths and floors lie flat, drawn on the ground under everything that stands.
const isFloor = (T: string) => !!floorRules?.[T] || /^TILE_|_FLOOR$/.test(T);
// The tile the game's rule tile puts down for floor T at (x, y), given the floors around it (`ground`: "x,y" -> type).
function floorTile(T: string, x: number, y: number, ground: Map<string, string>) {
  const f = floorRules?.[T];
  if (!f) return null;
  for (const r of f.rules) {
    if (!r.need.every(([dx, dy, c]) => (ground.get(`${x + dx},${y + dy}`) === T) === (c === 1))) continue;
    if (!r.pick) return `${T}.${r.s}.${r.m}`;
    const i = (y - r.pick.y0) * r.pick.w + x - r.pick.x0; // the pick covers the base and all its land
    return `${T}.${r.pick.s[i] ?? r.pick.s[0]}.${r.pick.ms[r.pick.m[i] ?? 0]}`;
  }
  return f.default < 0 ? null : `${T}.${f.default}.1,0,0,1`;
}

// ---------- text: the game's own translations plus the planner's strings ----------
const english: Strings = en ?? { ui: {}, terms: {}, names: {}, desc: {} };
const languages: Language[] = langs ?? [{ code: "en", name: "English" }];
const native = (code: string) => {
  try { const s = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code; return s[0].toLocaleUpperCase(code) + s.slice(1); }
  catch { return code; }
};
const preferred = () => {
  for (const want of navigator.languages ?? []) {
    const hit = languages.find(l => l.code.toLowerCase() === want.toLowerCase()) ?? languages.find(l => l.code.split("-")[0] === want.split("-")[0]);
    if (hit) return hit.code;
  }
  return "en";
};

// Per-viewer conveniences and named copies of layouts; the layout on screen lives in the URL.
const store = {
  get<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }, // storage off: fine, except for layouts
};
let lang = store.get<string | null>("lang", null) ?? preferred();
if (!languages.some(l => l.code === lang)) lang = "en";
let L: Strings = (lang === "en" ? english : await load<Strings>(`data/i18n/${lang}.json`)) ?? english;
if (L === english) lang = "en";
const t = (key: string, vars: Record<string, string | number> = {}) =>
  (L.ui[key] ?? english.ui[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m));
const short = (s: string) => s.replace(/\s*\([^()]*\)$/, ""); // "Undo (Ctrl+Z)" → "Undo", for labels that show no shortcut
const term = (key: string) => L.terms[key] || english.terms[key] || key;
const nameOf = (T: string) => L.names[T] || english.names[T] || wikiOf[T]?.name || T;
const descOf = (T: string) => L.desc[T] || english.desc[T] || "";
const itemOf = (I: string) => L.items?.[I] || english.items?.[I] || I;

// What having a T costs: its own cost and, for an upgrade done in place, the level below's, down to a level in `free`.
function costOf(T: string, free?: Set<string>, into = new Map<string, number>()): Map<string, number> {
  if (free?.has(T)) return into;
  for (const [i, n] of game!.costs?.[T] ?? []) into.set(i, (into.get(i) ?? 0) + n);
  const from = game!.upgrades?.[T];
  return from ? costOf(from, free, into) : into;
}
// "15 Lumber": the item's icon (its name when the icon fails) and the quantity, the name as its label
function itemChip(I: string, n: number) {
  const img = el("img", { src: `data/items/${I}.webp${DATA_VERSION}`, alt: "", width: 18, height: 18 });
  img.onerror = () => img.replaceWith(el("span", {}, itemOf(I)));
  return el("span", { className: "item", title: itemOf(I) }, img, el("span", { className: "num" }, String(n)), el("span", { className: "sr" }, ` ${itemOf(I)}`));
}
const chips = (c: Iterable<[string, number]>) => el("span", { className: "items" }, ...[...c].map(([i, n]) => itemChip(i, n)));
// The lines of T's cost: "Cost: <list>", or for an upgrade "Upgrade: <list>" and "In all: <total>"
function costLines(T: string): [string, Record<string, Iterable<[string, number]>>][] {
  const own = game!.costs?.[T];
  if (!own?.length) return [];
  return game!.upgrades?.[T] ? [["costUpgrade", { list: own }], ["costTotal", { total: costOf(T) }]] : [["cost", { list: own }]];
}
// into `e`, the items as icons
function showCost(e: HTMLElement, T: string) {
  e.replaceChildren(...costLines(T).flatMap(([key, vars], n) => [
    ...(n ? [el("br", {})] : []),
    ...t(key).split(/\{(\w+)\}/).map((part, i) => (i % 2 ? (vars[part] ? chips(vars[part]) : "") : part)),
  ]));
}
// as plain text, for a tooltip: "Cost: 15 Lumber, 4 Stone"
const costText = (T: string) => costLines(T).map(([key, vars]) => t(key, Object.fromEntries(Object.entries(vars)
  .map(([k, c]) => [k, [...c].map(([i, n]) => `${n} ${itemOf(i)}`).join(", ")])))).join("\n");

// ---------- looks: the base as the game draws it by weather and time of day ----------
// looks/<look>/ holds a backdrop per number of land upgrades bought (background-N), the buildings'
// atlas (sprites.json and its sheets; each idle animation in a sheet of its own, anim/<TYPE>) and their
// lights (lights.json; each building's in a sheet of its own, lights/<TYPE>), all rendered by the game
// itself (tools/capture) at the art's own resolution. Where lamps light the ground (bg.lit), the backdrop
// and every sheet also come graded as inside lamp light (lit-background-N, <sheet>-lit).
// A look loads the first time it's picked; the palette always uses the day atlas. Each backdrop shows a
// small version first, then the tiles on screen at the detail the zoom needs; the rest (upgrade levels,
// lit art, animations, lights) loads only when it's needed. The viewer can cap the detail of the
// textures and the animations at ½ or ⅓ (quality).
const LOOK_ICONS: Record<string, string> = { day: "ph-sun", night: "ph-moon-stars", rain: "ph-cloud-rain", bloodmoon: "ph-moon", winter: "ph-snowflake", blizzard: "ph-cloud-snow" };
const GRID: Record<string, number> = { night: .4, bloodmoon: .4 }; // build-grid strength where the scene is dark
const looks = bg?.looks ?? ["day"];
let look = store.get("look", "day");
if (!looks.includes(look)) look = looks[0];
let shown = look; // the look on screen: a newly picked one takes over once its art has loaded
// 1: full detail, 2: half, 3: a third, for the textures (backdrops, buildings, lights) and the animations
const quality = { textures: store.get("textures", 1), animations: store.get("animations", 1) };
// Pictures are AVIF; the ⅓ ones also come as WebP, which a browser without AVIF gets for everything.
const avif = await new Promise<boolean>(res => Object.assign(new Image(), {
  onload: () => res(true), onerror: () => res(false),
  src: "data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZgAAAOltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAQ0AAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGhpcHJwAAAASWlwY28AAAAUaXNwZQAAAAAAAAABAAAAAQAAAA5waXhpAAAAAAEIAAAADGF2MUOBABwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAI21kYXQSAAoHGAAGmAhoNTIOGUYhh55oJJBBGibPQLU=",
}));
const detail = (level: number) => (avif ? level : 3);
const levelled = (name: string, level: number) => (level > 1 ? `${name}@${level}` : name);
type Scene = {
  name: string; atlas: Atlas | null; lights: Atlas | null; floors: Atlas | null; pictures: Map<string, Picture>; small: Map<string, Picture>;
};
const scenes = new Map<string, Scene>();
// A picture is decoded once, off the main thread, into a bitmap that stays decoded: drawn straight from an
// <img>, the browser drops big decoded pictures under memory pressure and decodes them again mid-frame.
// Bitmaps not drawn in the last SWEEP full redraws are freed and fetched again from the cache when next
// needed. (Redraws, not time: an animation frame draws the ground from its layer, not from its pictures.)
type Picture = { bitmap: ImageBitmap | null; loaded: Promise<ImageBitmap | null>; used: number };
function picture(src: string): Picture {
  const img = Object.assign(new Image(), { src }), p: Picture = { bitmap: null, loaded: Promise.resolve(null), used: redraws };
  p.loaded = new Promise((res, rej) => Object.assign(img, { onload: res, onerror: rej }))
    .then(() => createImageBitmap(img))
    .then(b => { p.bitmap = b; requestDraw(); return b; }, () => null);
  return p;
}
const use = (p?: Picture) => { if (p) p.used = redraws; return p?.bitmap ?? null; };
const SWEEP = 600;
let redraws = 0;
function sweep() {
  if (++redraws % (SWEEP / 4)) return;
  for (const sc of scenes.values()) for (const map of [sc.pictures, sc.small])
    for (const [name, p] of map) if (p.bitmap && redraws - p.used > SWEEP) { p.bitmap.close(); map.delete(name); }
}
function scene(name: string): Scene {
  let sc = scenes.get(name);
  if (!sc) {
    const s: Scene = { name, atlas: name === "day" ? atlas : null, lights: null, floors: name === "day" ? dayFloors : null, pictures: new Map(), small: new Map() };
    if (s.atlas) sheet(s, 0);
    else void load<Atlas>(`data/looks/${name}/sprites.json`).then(a => { s.atlas = a; if (a) sheet(s, 0); });
    void load<Atlas>(`data/looks/${name}/lights.json`).then(a => { s.lights = a; requestDraw(); });
    if (name !== "day") void load<Atlas>(`data/looks/${name}/floors.json`).then(a => { s.floors = a; requestDraw(); });
    scenes.set(name, sc = s);
  }
  return sc;
}
// A picture of a look (a sheet, lit art, an animation, the lights, a backdrop tile), fetched the first
// time it's asked for.
function pic(sc: Scene, name: string) {
  let img = sc.pictures.get(name);
  if (!img) sc.pictures.set(name, img = picture(`data/looks/${sc.name}/${name}.${avif ? "avif" : "webp"}${DATA_VERSION}`));
  return img;
}
const extra = (sc: Scene, name: string) => use(pic(sc, name));
// Sheet i of a look's atlas at the textures' detail.
const sheet = (sc: Scene, i: number) => pic(sc, levelled(sc.atlas!.sheets[i], detail(quality.textures)));
// A look's backdrop for a land level, while its tiles load (and with no tiles, the whole picture).
function smallBackdrop(name: string, level: number) {
  if (!bg) return null;
  const sc = scene(name), path = `data/looks/${name}/${bg.images[Math.min(level, bg.images.length - 1)]}`;
  let img = sc.small.get(path);
  if (!img) sc.small.set(path, img = picture(`${path}.small.webp${DATA_VERSION}`));
  return use(img);
}
// A building's render in the look on screen (as inside lamp light with `lit`), or the day one while
// that loads, at the textures' detail. At `time` (ms) an animated one also brings the part that moves as
// it is then (`patch`), at the animations' detail, once that's loaded.
function art(T: string, lit = false, time?: number) {
  for (const sc of [scene(shown), scene("day")]) {
    const full = sc.atlas?.items[T], i = full?.[6] ?? 0, k = detail(quality.textures);
    const image = full && (lit ? extra(sc, levelled(`${sc.atlas!.sheets[i]}-lit`, k)) : use(sheet(sc, i)));
    if (!full || !image) { if (lit) return null; continue; }
    const item = scaled(full, k);
    const anim = sc.atlas!.anim, frames = time === undefined ? undefined : anim?.frames[T], ka = detail(quality.animations);
    const moving = frames && anim!.items[`${T}#${Math.floor(time! / 1000 * frames[1]) % frames[0]}`];
    const movingImage = moving ? extra(sc, levelled(`anim/${T}${lit ? "-lit" : ""}`, ka)) : null;
    const patch = moving && movingImage
      ? { image: movingImage, item: scaled(moving, ka), ppu: anim!.ppu / ka, box: anim!.box[T].map(n => n / k) }
      : null;
    return { image, item, ppu: sc.atlas!.ppu / k, fps: frames?.[1] ?? 0, patch };
  }
  return null;
}
// An atlas item ([x, y, w, h, anchorX, anchorY]) in the same picture at 1/k of its size.
type Item6 = [number, number, number, number, number, number];
const scaled = (it: readonly (number | undefined)[], k: number) => it.slice(0, 6).map(n => n! / k) as Item6;
// A floor tile (a floorTile key) in the look on screen (as inside lamp light with `lit`), or the day one while
// that loads, at the textures' detail.
function floorArt(key: string, lit = false) {
  for (const sc of [scene(shown), scene("day")]) {
    const full = sc.floors?.items[key], k = detail(quality.textures);
    const image = full && extra(sc, levelled(lit ? "floors-lit" : "floors", k));
    if (!full || !image) { if (lit) return null; continue; }
    return { image, item: scaled(full, k), ppu: sc.floors!.ppu / k };
  }
  return null;
}
// The light a building casts ("mask") or adds ("glow") in the look on screen.
function lightOf(T: string, kind: "mask" | "glow") {
  const sc = scene(shown), item = sc.lights?.items[`${kind}:${T}`], k = detail(quality.textures), img = item && extra(sc, levelled(`lights/${T}`, k));
  return item && img ? { image: img, item: scaled(item, k), ppu: sc.lights!.ppu / k } : null;
}

// ---------- layout state ----------
// Links made before layouts were keyed by type named buildings by their English (wiki or game) name.
const aliases: Record<string, string> = {};
for (const [n, T] of Object.entries(game.wiki)) if (byType[T]) aliases[n] = T;
for (const T in byType) if (english.names[T]) { aliases[english.names[T]] ??= T; aliases[`${english.names[T]} (${T})`] = T; }
const maxLand = base.expansions?.length ?? 0;
// A layout from its link: buildings that no longer fit its land are dropped.
function fromHash(hash: string, landIfUnsaid: number) {
  const decoded = decode(hash, { ...aliases, ...byType });
  for (const p of decoded.placed) p.name = byType[p.name] ? p.name : aliases[p.name];
  const land = Math.min(maxLand, decoded.land ?? landIfUnsaid), { cells } = cellsFor(base!, land);
  const placed = decoded.placed.filter(p => fits(p, [], byType, cells));
  // Every base starts with its Temple, which the game won't delete: add it where it usually stands.
  for (const d of base!.defaults ?? []) {
    const p: Placed = { name: d.type, x: d.x, y: d.y, r: 0 };
    if (byType[d.type] && !placed.some(q => chainKey(q.name) === chainKey(d.type)) && fits(p, placed, byType, cells)) placed.unshift(p);
  }
  return { placed, land };
}
// a shared link says how much land it was planned on; otherwise use this viewer's last choice
let { placed, land } = fromHash(location.hash, location.hash.length > 1 ? 0 : store.get("land", 0));
let { tiles, cells } = cellsFor(base, land);
// Named layouts kept in this browser; the open one takes every change. A link that isn't the open
// layout's own (a shared one, say) opens unsaved.
type Layout = { name: string; hash: string };
let layouts = store.get<Layout[]>("layouts", []);
let current = store.get<string | null>("layout", null);
if (!layouts.some(l => l.name === current && l.hash === location.hash.slice(1))) current = null;
let tool: Tool = "select";
let ruler: { a: CellXY; b: CellXY } | null = null; // the measure tool's last box, corner cells a and b
let brush: Brush | null = null; // while holding a building; `from`/`at` = where a moved one came from, `grab` = the cell of it held
let selected: Placed | null = null; // placed building whose level picker is open
let hover: CellXY | null = null; // cell under the pointer
let view: View = { s: 20, tx: 0, ty: 0 }, fitScale = 20, userView = false; // userView: panned/zoomed by hand, so stop auto-fitting
let size: Size = { w: 0, h: 0, dpr: 1 };
let gesture: Gesture | null = null; // while a pointer is down
let spaceHeld = false;
const undoStack: string[] = [], redoStack: string[] = [];
let strokeBefore: string | null = null;
let recent = store.get<string[]>("recent", []).filter(T => byType[T]);
let showLabels = store.get("labels", false);
let showRanges = store.get("ranges", false);
let group = store.get<string | null>("group", null);
if (!game.menu.some(tab => tab.id === group)) group = game.menu[0].id;

// ---------- geometry ----------
function boundsOf(ts: Cell[]) {
  const corners = ts.flatMap(([x, y]) => [[x - .5, y - .5], [x + .5, y + .5], [x - .5, y + .5], [x + .5, y - .5]]);
  const isoX = corners.map(([x, y]) => K * (x - y)), isoY = corners.map(([x, y]) => -K * V * (x + y));
  return { x0: Math.min(...isoX), x1: Math.max(...isoX), y0: Math.min(...isoY), y1: Math.max(...isoY) };
}
let BOUNDS = boundsOf(tiles);
const toScreen = (x: number, y: number, v: View = view): [number, number] => [v.s * K * (x - y) + v.tx, -v.s * K * V * (x + y) + v.ty];
function cellAt(px: number, py: number): CellXY {
  const X = (px - view.tx) / (view.s * K), Y = (py - view.ty) / (view.s * K * V); // X = x − y, Y = −(x + y)
  return { x: Math.round((X - Y) / 2), y: Math.round((-X - Y) / 2) };
}
const fitView = (w: number, h: number, pad = 90): View => {
  const s = Math.min((w - 2 * pad) / (BOUNDS.x1 - BOUNDS.x0), (h - 2 * pad) / (BOUNDS.y1 - BOUNDS.y0));
  return { s, tx: w / 2 - s * (BOUNDS.x0 + BOUNDS.x1) / 2, ty: h / 2 - s * (BOUNDS.y0 + BOUNDS.y1) / 2 };
};

// The held footprint is centred on the hovered cell, or a dragged building keeps the cell it was grabbed by under it.
function anchored(b: Brush, c: CellXY): Placed {
  if (b.grab) return { name: b.name, r: b.r, x: c.x - b.grab.x, y: c.y - b.grab.y };
  const r = rect({ r: b.r, x: 0, y: 0 }, byType[b.name]);
  return { name: b.name, r: b.r, x: c.x - Math.floor((r.w - 1) / 2), y: c.y - Math.floor((r.h - 1) / 2) };
}

// ---------- art for the palette and panels ----------
// A building as the game draws it, shrunk into a square box (`size` CSS pixels, for resolution);
// the wiki's build-menu icon when the game render is missing.
function thumb(T: string, size = 44): HTMLElement {
  const tile = floorTile(T, 0, 0, new Map()), a = tile ? dayFloors?.items[tile] : atlas?.items[T]; // a floor: one tile alone
  if (a) {
    const d = detail(quality.textures), image = tile ? pic(scene("day"), levelled("floors", d)) : sheet(scene("day"), a[6] ?? 0); // the sheet at 1/d of full size
    const px = Math.round(size * Math.min(2, devicePixelRatio || 1));
    const c = el("canvas", { className: "thumb", width: px, height: px });
    const paint = (bitmap: ImageBitmap | null) => {
      const [x, y, w, h] = scaled(a, d), k = Math.min(px / w, px / h, (px / 40) * d);
      if (bitmap) c.getContext("2d")!.drawImage(bitmap, x, y, w, h, (px - w * k) / 2, (px - h * k) / 2, w * k, h * k);
    };
    if (image.bitmap) paint(image.bitmap); else void image.loaded.then(paint);
    return c;
  }
  const blank = () => el("i", { className: "thumb ph ph-image" });
  const src = byType[T].icon;
  if (!src) return blank();
  const img = el("img", { className: "thumb", loading: "lazy", alt: "", src });
  img.onerror = () => img.replaceWith(blank());
  return img;
}

// Wiki icons drawn on the map for buildings without a game render.
const images = new Map<string, HTMLImageElement>();
function icon(T: string) {
  let img = images.get(T);
  if (!img) {
    img = Object.assign(new Image(), { onload: requestDraw });
    if (byType[T].icon) img.src = byType[T].icon!;
    images.set(T, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

const hueOf = (T: string) => {
  let h = 0;
  for (const ch of tabOf[T]?.id ?? T) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};
const initials = (name: string) => name.split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();

// ---------- drawing ----------
type Ctx = CanvasRenderingContext2D;
let frame = 0, changed = true; // changed: something besides the animations' time since the last frame
function requestDraw() { changed = true; nextFrame(); }
function nextFrame() { frame ||= requestAnimationFrame(() => { frame = 0; draw(ctx, size, view, true); }); }

const gridSpace = (c: Ctx, sz: Size, v: View) => c.setTransform(sz.dpr * v.s * K, -sz.dpr * v.s * K * V, -sz.dpr * v.s * K, -sz.dpr * v.s * K * V, sz.dpr * v.tx, sz.dpr * v.ty);
const screenSpace = (c: Ctx, sz: Size) => c.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);

// Lamp light, as the game does it: inside the light a building casts, the scene is graded with the look's
// second LUT. The scene is drawn again from the lit art into `litLayer`, cut to the lamps' light (their
// masks added up in `maskLayer`) and laid over: normal × (1 − light) + lit × light.
const litLayer = document.createElement("canvas"), maskLayer = document.createElement("canvas");
// The ground (backdrop and grid) and the lamps' light change with the view, the layout, the look or a
// picture loading, never from one animation frame to the next: on screen they're drawn into layers of
// their own (plain and lit ground; maskLayer) and an animation frame copies them from there.
const groundLayers = [document.createElement("canvas"), document.createElement("canvas")], groundHasBg = [false, false];
let animTimer = 0;
const MAX_FPS = 30; // redraws per second at most while an animated building is on screen

function draw(c: Ctx, sz: Size, v: View, live: boolean) {
  const reuse = live ? !changed : undefined; // undefined: an export, drawn from scratch and leaving no layers
  changed = !live; // an export draws into maskLayer at its own size
  if (reuse === false) sweep();
  screenSpace(c, sz);
  c.fillStyle = "#141012";
  c.fillRect(0, 0, sz.w, sz.h);

  // footprints flat on the ground first, then sprites back-to-front so nearer ones overlap
  const hovered = live && !brush && hover ? itemAt(hover.x, hover.y, placed, byType) : null;
  const items: [Placed, Mode][] = placed.map(p => [p, live && p === selected ? "selected" : p === hovered ? (tool === "erase" ? "erase" : "hover") : "normal"]);
  const s = shrine();
  if (s) items.push([s, "normal"]);
  spots = live && brush ? spotsFor(brush) : null;
  if (live && brush && hover) {
    const g = anchored(brush, hover);
    items.push([g, fits(g, placed, byType, cells) ? "ghost" : "blocked"]);
  }
  const depth = (p: Placed) => p.x + p.y; // larger x + y sits further up the screen, i.e. further back
  items.sort((a, b) => depth(b[0]) - depth(a[0]));
  const time = live && !calm.matches ? performance.now() : undefined; // animations play on screen, not in exports
  const { area, fps } = drawScene(c, sz, v, items, false, time, undefined, reuse);

  // only where the lamps' light reaches (device pixels), so the second pass costs what's lit
  const lit = items.flatMap(([p]) => { const r = lightRect(sz, v, p); return r ? [r] : []; });
  if (lit.length && bg?.lit?.includes(shown)) {
    const W = Math.round(sz.w * sz.dpr), H = Math.round(sz.h * sz.dpr);
    const x0 = Math.max(0, Math.floor(Math.min(...lit.map(r => r[0])))), y0 = Math.max(0, Math.floor(Math.min(...lit.map(r => r[1]))));
    const x1 = Math.min(W, Math.ceil(Math.max(...lit.map(r => r[2])))), y1 = Math.min(H, Math.ceil(Math.max(...lit.map(r => r[3]))));
    if (x1 > x0 && y1 > y0) {
      for (const layer of [litLayer, maskLayer]) if (layer.width !== W || layer.height !== H) Object.assign(layer, { width: W, height: H });
      const lc = litLayer.getContext("2d")!, mc = maskLayer.getContext("2d")!;
      lc.save();
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(x0, y0, x1 - x0, y1 - y0);
      lc.beginPath();
      lc.rect(x0, y0, x1 - x0, y1 - y0);
      lc.clip();
      drawScene(lc, sz, v, items, true, time, [x0 / sz.dpr, y0 / sz.dpr, x1 / sz.dpr, y1 / sz.dpr], reuse);
      if (!reuse) {
        mc.setTransform(1, 0, 0, 1, 0, 0);
        mc.clearRect(x0, y0, x1 - x0, y1 - y0);
        mc.globalCompositeOperation = "lighter"; // the game adds its lights up in the mask
        for (const [p] of items) light(mc, sz, v, p, "mask");
        mc.globalCompositeOperation = "source-over";
      }
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.globalCompositeOperation = "destination-in";
      lc.drawImage(maskLayer, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      lc.restore();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(litLayer, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
  }

  // the game's weather tint, a colour it lays over the screen; here over the scene, not the empty margin
  const tint = bg?.tint?.[shown];
  if (tint && area) {
    screenSpace(c, sz);
    c.fillStyle = `rgb(${tint.slice(0, 3).map(x => Math.round(x * 255)).join(" ")} / ${tint[3]})`;
    c.fillRect(...area);
  }
  if (showLabels) for (const [p, mode] of items) if (mode !== "ghost" && mode !== "blocked") label(c, sz, v, p);
  if (live && ruler) measure(c, sz, v, ruler.a, ruler.b);
  if (reuse === false) placeSelectionCard();
  // next frame of the fastest animation on screen
  if (fps && live) animTimer ||= window.setTimeout(() => { animTimer = 0; nextFrame(); }, 1000 / Math.min(MAX_FPS, fps));
}

// While a building is held: every cell it can cover somewhere it fits (not just where the pointer may go,
// which leaves a gap around everything as wide as half the building), worked out again only when the
// building, its turn, the land or the layout change.
let spots: Cell[] | null = null, spotsKey = "", spotsCache: Cell[] = [];
function spotsFor(b: Brush): Cell[] {
  const key = `${b.name}|${b.r}|${cells.size}|${encode(placed)}`;
  if (key !== spotsKey) {
    spotsKey = key;
    const free = new Set<string>();
    for (const [x, y] of tiles) {
      const r = rect({ ...b, x, y }, byType[b.name]);
      if (fits({ name: b.name, r: b.r, x, y }, placed, byType, cells))
        for (let i = r.x; i < r.x + r.w; i++) for (let j = r.y; j < r.y + r.h; j++) free.add(`${i},${j}`);
    }
    spotsCache = tiles.filter(([x, y]) => free.has(`${x},${y}`));
  }
  return spotsCache;
}

// The base and its buildings, with the art graded as inside lamp light when `lit`. Returns the backdrop's
// area on screen and the frame rate of the fastest animation in view (0: none). With `reuse` set, the
// ground comes from its layer (true) or is drawn into it first (false).
function drawScene(c: Ctx, sz: Size, v: View, items: [Placed, Mode][], lit: boolean, time?: number, within?: Box, reuse?: boolean) {
  let hasBg: boolean;
  if (reuse === undefined) hasBg = drawGround(c, sz, v, lit, within);
  else {
    const layer = groundLayers[+lit], W = Math.round(sz.w * sz.dpr), H = Math.round(sz.h * sz.dpr);
    if (!reuse) {
      if (layer.width !== W || layer.height !== H) Object.assign(layer, { width: W, height: H });
      const g = layer.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      groundHasBg[+lit] = drawGround(g, sz, v, lit, within);
    }
    hasBg = groundHasBg[+lit];
    const [x0, y0, x1, y1] = (within ?? [0, 0, sz.w, sz.h]).map(n => Math.round(n * sz.dpr));
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (layer.width && layer.height && x1 > x0 && y1 > y0) c.drawImage(layer, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0); // a canvas of size 0 can't be drawn
  }
  const area = bg && hasBg ? [v.s * bg.u0 + v.tx, -v.s * bg.v0 + v.ty, bg.w * v.s / bg.ppu, bg.h * v.s / bg.ppu] as const : null;
  if (spots?.length) {
    gridSpace(c, sz, v);
    c.beginPath();
    for (const [x, y] of spots) c.roundRect(x - .4, y - .4, .8, .8, .12);
    c.fillStyle = "rgb(160 235 120 / .38)";
    c.fill();
    c.lineWidth = 1.5 / v.s;
    c.strokeStyle = "rgb(200 255 160 / .75)";
    c.stroke();
  }
  const ground = new Map(items.filter(([p]) => isFloor(p.name)).map(([p]) => [`${p.x},${p.y}`, p.name]));
  for (const [p, mode] of items) {
    if (shrines.includes(p.name)) continue; // the Shrine stands off the grid
    const tiled = floor(c, sz, v, p, mode, lit, ground);
    if (!tiled || mode !== "normal") footprint(c, sz, v, p, mode, tiled);
  }
  for (const [p, mode] of items) if (mode !== "normal" || showRanges) range(c, sz, v, p, mode);
  let fps = 0;
  for (const [p, mode] of items) fps = Math.max(fps, sprite(c, sz, v, p, mode, lit, time));
  return { area, fps };
}

// The backdrop and the grid over it; returns whether there's a backdrop.
function drawGround(c: Ctx, sz: Size, v: View, lit: boolean, within?: Box) {
  screenSpace(c, sz);
  const hasBg = drawBackdrop(c, sz, v, lit, within);

  // ground: over the art, inset rounded green outlines like the game's build-mode tiles;
  // without art, plain filled cells
  gridSpace(c, sz, v);
  c.beginPath();
  if (hasBg) for (const [x, y] of tiles) c.roundRect(x - .42, y - .42, .84, .84, .14);
  else for (const [x, y] of tiles) c.rect(x - .5, y - .5, 1, 1);
  const glow = GRID[shown] ?? 1; // the grid would glare over the dark looks
  c.fillStyle = hasBg ? `rgb(150 220 140 / ${.07 * glow})` : "#3d4e33";
  c.fill();
  c.lineWidth = (hasBg ? 1.5 : 1) / v.s;
  c.strokeStyle = hasBg ? `rgb(72 176 96 / ${.75 * glow})` : "rgb(20 16 18 / .45)";
  c.stroke();
  return hasBg;
}

function halo(c: Ctx, text: string, x: number, y: number) {
  c.lineWidth = 3;
  c.lineJoin = "round";
  c.strokeStyle = "rgb(20 16 18 / .85)";
  c.strokeText(text, x, y);
  c.fillStyle = "#ede4d3";
  c.fillText(text, x, y);
}

const FILL: Partial<Record<Mode, string>> = { ghost: "rgb(143 179 108 / .55)", blocked: "rgb(200 66 59 / .55)", erase: "rgb(200 66 59 / .5)", selected: "rgb(200 66 59 / .25)" };
const LINE: Partial<Record<Mode, string>> = { ghost: "#b9d896", blocked: "#e06b63", erase: "#e06b63", hover: "#ede4d3", selected: "#e06b63" };
// `bare`: over a floor's own tile, only the marks of a mode (hover, selection), no tint of its own.
function footprint(c: Ctx, sz: Size, v: View, p: Placed, mode: Mode, bare = false) {
  const T = p.name, r = rect(p, byType[T]), hue = hueOf(T);
  gridSpace(c, sz, v);
  c.fillStyle = FILL[mode] ?? (bare ? "transparent" : `hsl(${hue} 30% 24% / .45)`);
  c.fillRect(r.x - .5, r.y - .5, r.w, r.h);
  const flat = isFloor(T) && !atlas?.items[T] && icon(T);
  if (flat) c.drawImage(flat, r.x - .5, r.y - .5, r.w, r.h);
  c.lineWidth = (mode === "normal" ? 1.25 : 2) / v.s;
  c.strokeStyle = LINE[mode] ?? `hsl(${hue} 40% 52%)`;
  c.strokeRect(r.x - .5 + .5 / v.s, r.y - .5 + .5 / v.s, r.w - 1 / v.s, r.h - 1 / v.s);
}

// The cells a building works on (game.ranges, as reach() counts them), on the ground like the game's own
// indicator: strong for the building held, hovered or selected. With all ranges shown, each type has its own colour (the legend says
// which), so overlapping areas can be told apart.
function range(c: Ctx, sz: Size, v: View, p: Placed, mode: Mode) {
  const a = game!.ranges?.[p.name];
  if (!a) return;
  const cells = reach(p, a), focus = mode !== "normal", bad = mode === "blocked" || mode === "erase";
  const colour = `rgb(${showRanges ? rangeColour(p.name) : "237 228 211"}`;
  gridSpace(c, sz, v);
  c.beginPath();
  c.rect(cells.x - .5, cells.y - .5, cells.n, cells.n);
  c.fillStyle = bad ? "rgb(224 107 99 / .14)" : `${colour} / ${focus ? .18 : .09})`;
  c.fill();
  c.lineWidth = (focus ? 2.5 : 1.5) / v.s;
  c.strokeStyle = bad ? "#e06b63" : `${colour} / ${focus || showRanges ? .9 : .45})`;
  c.stroke();
}
// Colours for the ranged types on the map, in the order they were first placed (so a new one doesn't
// repaint the others); past the palette, the first colours come round again.
const RANGE_COLOURS = ["242 193 78", "94 200 229", "239 111 156", "139 224 122", "180 140 242", "242 137 78", "78 224 181", "233 228 214"];
let rangeColours: Record<string, string> = {}; // set with the legend; a held building of a new type gets the next colour
const rangeColour = (T: string) => rangeColours[T] ?? RANGE_COLOURS[Object.keys(rangeColours).length % RANGE_COLOURS.length];

// With all ranges shown: which colour is which building, and how far it reaches.
function updateLegend() {
  const types = [...new Set(placed.map(p => p.name))].filter(T => game!.ranges?.[T]);
  rangeColours = Object.fromEntries(types.map((T, i) => [T, RANGE_COLOURS[i % RANGE_COLOURS.length]]));
  $("legend").hidden = !showRanges || !types.length;
  $("legend-list").replaceChildren(...types.map(T => {
    const swatch = el("i", {}), n = reach({ x: 0, y: 0 }, game!.ranges![T]).n;
    swatch.style.background = `rgb(${rangeColour(T)})`;
    return el("li", {}, swatch, el("span", {}, nameOf(T)), el("b", { className: "num" }, `${n}×${n}`));
  }));
}

// The backdrop of the look on screen (as inside lamp light with `lit`), within `within` (CSS pixels;
// the screen without it): picture pixel (X, Y) sits at u = u0 + X/ppu, v = v0 - Y/ppu from the grid's
// origin. First the small picture, then over it the tiles at the detail the zoom needs (a picture pixel
// per device pixel at least), never finer than the textures' detail; while one loads, the same tile at a
// detail already there. Returns whether anything was drawn.
type Box = [number, number, number, number];
function drawBackdrop(c: Ctx, sz: Size, v: View, lit: boolean, within: Box = [0, 0, sz.w, sz.h]) {
  if (!bg) return false;
  if (look !== shown && smallBackdrop(look, land) && scene(look).atlas && use(sheet(scene(look), 0))) shown = look;
  const sc = scene(shown), name = `${lit ? "lit-" : ""}${bg.images[Math.min(land, bg.images.length - 1)]}`;
  const x0 = v.s * bg.u0 + v.tx, y0 = -v.s * bg.v0 + v.ty, k = v.s / bg.ppu; // screen pixels per picture pixel
  let drawn = false;
  const small = lit ? null : smallBackdrop(shown, land);
  if (small) { c.drawImage(small, x0, y0, bg.w * k, bg.h * k); drawn = true; }
  const t = bg.tile;
  if (!t) {
    const img = extra(sc, name);
    if (img) { c.drawImage(img, x0, y0, bg.w * k, bg.h * k); drawn = true; }
    return drawn;
  }
  const need = k * sz.dpr, level = detail(Math.max(quality.textures, need > 1 / 2 ? 1 : need > 1 / 3 ? 2 : 3));
  const span = (a: number, b: number, o: number, n: number) => [Math.max(0, Math.floor((a - o) / k / t.size)), Math.min(n - 1, Math.floor((b - o) / k / t.size))];
  const [c0, c1] = span(within[0], within[2], x0, t.cols), [r0, r1] = span(within[1], within[3], y0, t.rows);
  for (let r = r0; r <= r1; r++)
    for (let col = c0; col <= c1; col++) {
      const tile = `${name}/${col}_${r}`;
      const img = extra(sc, levelled(tile, level)) ?? use([1, 2, 3].map(l => sc.pictures.get(levelled(tile, l))).find(p => p?.bitmap));
      if (!img) continue;
      c.drawImage(img, x0 + (col * t.size - t.border) * k, y0 + (r * t.size - t.border) * k, (t.size + 2 * t.border) * k, (t.size + 2 * t.border) * k);
      drawn = true;
    }
  return drawn;
}

// Draws a building; returns its animation's frame rate if it's animated and in view, else 0.
function sprite(c: Ctx, sz: Size, v: View, p: Placed, mode: Mode, lit = false, time?: number) {
  const T = p.name, r = rect(p, byType[T]);
  const a = art(T, lit, time) ?? (lit ? art(T, false, time) : null);
  if (a) {
    // the game's own render: anchored at the centre of the footprint's first cell, same projection as the map
    const [x, y, w, h, ax, ay] = a.item, k = v.s / a.ppu;
    const [px, py] = toScreen(r.x, r.y, v);
    screenSpace(c, sz);
    c.translate(px, py);
    if (p.r) c.scale(-1, 1); // the game's "rotate" mirrors the building
    if (mode === "ghost" || mode === "blocked") c.globalAlpha = .75;
    if (a.patch) {
      // the still frame without the part that moves, then that part as it is now
      const [x0, y0, x1, y1] = a.patch.box, [qx, qy, qw, qh, qax, qay] = a.patch.item, q = v.s / a.patch.ppu;
      c.save();
      c.beginPath();
      c.rect(-ax * k, -ay * k, w * k, h * k);
      c.rect(x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k);
      c.clip("evenodd");
      c.drawImage(a.image, x, y, w, h, -ax * k, -ay * k, w * k, h * k);
      c.restore();
      c.drawImage(a.patch.image, qx, qy, qw, qh, -qax * q, -qay * q, qw * q, qh * q);
    } else c.drawImage(a.image, x, y, w, h, -ax * k, -ay * k, w * k, h * k);
    c.globalAlpha = 1;
    light(c, sz, v, p, "glow");
    return Math.abs(px - sz.w / 2) < sz.w / 2 + w * k && Math.abs(py - sz.h / 2) < sz.h / 2 + h * k ? a.fps : 0;
  }
  if (!isFloor(T)) wikiIcon(c, sz, v, r, p, mode);
  return 0;
}

// A floor as the game tiles it, flat on the ground, anchored like a sprite; false when there's no tile for it.
function floor(c: Ctx, sz: Size, v: View, p: Placed, mode: Mode, lit: boolean, ground: Map<string, string>) {
  const key = floorTile(p.name, p.x, p.y, ground), a = key && (floorArt(key, lit) ?? (lit ? floorArt(key) : null));
  if (!a) return false;
  const [x, y, w, h, ax, ay] = a.item, k = v.s / a.ppu, [px, py] = toScreen(p.x, p.y, v);
  screenSpace(c, sz);
  if (mode === "ghost" || mode === "blocked") c.globalAlpha = .75;
  c.drawImage(a.image, x, y, w, h, px - ax * k, py - ay * k, w * k, h * k);
  c.globalAlpha = 1;
  return true;
}

// A building's light, anchored like its sprite: its mask (into the lamp-light layer) or its additive glow.
function light(c: Ctx, sz: Size, v: View, p: Placed, kind: "mask" | "glow") {
  const l = lightOf(p.name, kind);
  if (!l) return;
  const r = rect(p, byType[p.name]), [x, y, w, h, ax, ay] = l.item, k = v.s / l.ppu;
  const [px, py] = toScreen(r.x, r.y, v);
  screenSpace(c, sz);
  c.translate(px, py);
  if (p.r) c.scale(-1, 1);
  const op = c.globalCompositeOperation;
  if (kind === "glow") c.globalCompositeOperation = "lighter";
  c.drawImage(l.image, x, y, w, h, -ax * k, -ay * k, w * k, h * k);
  c.globalCompositeOperation = op;
}

// Where a building's light mask lands, in device pixels: [x0, y0, x1, y1]; null if it casts none.
function lightRect(sz: Size, v: View, p: Placed) {
  const l = lightOf(p.name, "mask");
  if (!l) return null;
  const r = rect(p, byType[p.name]), [, , w, h, ax, ay] = l.item, k = v.s / l.ppu;
  const [px, py] = toScreen(r.x, r.y, v), left = p.r ? px - (w - ax) * k : px - ax * k;
  return [left * sz.dpr, (py - ay * k) * sz.dpr, (left + w * k) * sz.dpr, (py + (h - ay) * k) * sz.dpr];
}

// Fallback for buildings without extracted art: the wiki's build-menu icon, upright, feet near the front corner.
function wikiIcon(c: Ctx, sz: Size, v: View, r: { x: number; y: number; w: number; h: number }, p: Placed, mode: Mode) {
  const [cx] = toScreen(r.x - .5 + r.w / 2, r.y - .5 + r.h / 2, v);
  const [, front] = toScreen(r.x - .5, r.y - .5, v); // lowest corner on screen
  const [, back] = toScreen(r.x - .5 + r.w, r.y - .5 + r.h, v);
  const width = v.s * K * (r.w + r.h);
  screenSpace(c, sz);
  if (mode === "ghost" || mode === "blocked") c.globalAlpha = .75;
  const img = icon(p.name);
  if (img) {
    const k = width / img.naturalWidth, h = img.naturalHeight * k;
    c.drawImage(img, cx - width / 2, front - (front - back) * .25 - h, width, h);
  } else {
    c.font = `600 ${Math.max(8, width * .22)}px 'Geist Variable', system-ui`;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#ede4d3";
    c.fillText(initials(nameOf(p.name)), cx, (front + back) / 2);
  }
  c.globalAlpha = 1;
}

// The measure tool's box: every cell between corner cells a and b, and how many across ("4×6", as a footprint reads).
function measure(c: Ctx, sz: Size, v: View, a: CellXY, b: CellXY) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x) + 1, h = Math.abs(a.y - b.y) + 1;
  gridSpace(c, sz, v);
  c.fillStyle = "rgb(94 200 229 / .18)";
  c.fillRect(x - .5, y - .5, w, h);
  c.lineWidth = 2 / v.s;
  c.strokeStyle = "#5ec8e5";
  c.strokeRect(x - .5, y - .5, w, h);
  const [cx] = toScreen(x - .5 + w / 2, y - .5 + h / 2, v), [, front] = toScreen(x - .5, y - .5, v);
  screenSpace(c, sz);
  c.font = "600 13px 'Geist Mono Variable', ui-monospace, monospace";
  c.textAlign = "center"; c.textBaseline = "top";
  halo(c, `${w}×${h}`, cx, front + 4);
}

function label(c: Ctx, sz: Size, v: View, p: Placed) {
  const r = rect(p, byType[p.name]);
  const [cx] = toScreen(r.x - .5 + r.w / 2, r.y - .5 + r.h / 2, v);
  const [, front] = toScreen(r.x - .5, r.y - .5, v);
  screenSpace(c, sz);
  c.font = "500 11px 'Geist Variable', system-ui";
  c.textAlign = "center"; c.textBaseline = "top";
  halo(c, nameOf(p.name), cx, front + 3);
}

// ---------- state changes ----------
// History entries hold the layout and the land level together, so undo can bring back land too.
const snapshot = () => JSON.stringify({ placed, land });
function restore(json: string) { const s = JSON.parse(json) as { placed: Placed[]; land: number }; placed = s.placed; selected = null; applyLand(s.land); }
function beginStroke() { strokeBefore ??= snapshot(); }
function endStroke() {
  if (strokeBefore !== null && strokeBefore !== snapshot()) {
    undoStack.push(strokeBefore);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  strokeBefore = null;
  commit();
}
function commit() {
  if (selected && !placed.includes(selected)) selected = null;
  const hash = encode(placed, land);
  history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
  const open = layouts.find(l => l.name === current);
  if (open && open.hash !== hash) { open.hash = hash; saveLayouts(); }
  $("layout-name").textContent = current ?? t("layouts");
  $<HTMLButtonElement>("undo").disabled = !undoStack.length;
  $<HTMLButtonElement>("redo").disabled = !redoStack.length;
  $("hint").hidden = placed.some(deletable) || !!brush || !!selected;
  updateStats();
  updateInspector();
  updateSelectionCard();
  requestDraw();
}
function undo() { if (!undoStack.length) return; dropHeld(); redoStack.push(snapshot()); restore(undoStack.pop()!); commit(); }
function redo() { if (!redoStack.length) return; dropHeld(); undoStack.push(snapshot()); restore(redoStack.pop()!); commit(); }

function applyLand(level: number) {
  if (level === land) return;
  land = level;
  ({ tiles, cells } = cellsFor(base!, land));
  BOUNDS = boundsOf(tiles);
  $<HTMLSelectElement>("land").value = String(land);
  store.set("land", land);
  if (!userView && size.w) fit();
}
// Buying less land than a layout uses drops what no longer fits (one undoable step).
function setLand(level: number) {
  dropHeld();
  beginStroke();
  applyLand(level);
  const before = placed.length;
  placed = placed.filter(p => fits(p, [], byType, cells));
  endStroke();
  const lost = before - placed.length;
  if (lost) toast(t("lostLand", { n: lost }));
}

// Places the held building at cell c. Over a one-per-base limit it offers to move the existing one.
function tryPlace(c: CellXY): boolean {
  if (!brush) return false;
  const cand = anchored(brush, c);
  if (!fits(cand, placed, byType, cells)) return false;
  const same = placed.filter(p => chainKey(p.name) === chainKey(cand.name));
  if (!brush.from && same.length >= limitOf(cand.name)) {
    gesture = null; // stop painting a row while we ask
    void offerMove(cand, same[0], limitOf(cand.name));
    return false;
  }
  placed.push(cand);
  remember(cand.name);
  return true;
}
async function offerMove(cand: Placed, old: Placed, limit: number) {
  const name = nameOf(old.name);
  const ok = await confirm(limit === 1 ? t("onlyOne", { name }) : t("upTo", { n: limit, name }),
    t(limit === 1 ? "limitText1" : "limitTextN", { n: limit }), t("moveHere"));
  if (!ok) { endStroke(); return; }
  beginStroke();
  placed.splice(placed.indexOf(old), 1);
  const moved = { ...cand, name: old.name }; // the same building keeps its level
  placed.push(fits(moved, placed, byType, cells) ? moved : old);
  endStroke();
  if (!placed.includes(moved)) toast(t("noFitLevel"));
}
function remember(T: string) {
  if (recent[0] === T) return;
  recent = [T, ...recent.filter(n => n !== T)].slice(0, 10);
  store.set("recent", recent);
  renderPalette();
}
function removeBuilding(p: Placed) {
  if (!deletable(p)) { toast(t("cantRemove", { name: nameOf(p.name) })); return false; }
  placed.splice(placed.indexOf(p), 1);
  return true;
}
function eraseAt(c: CellXY) {
  const p = itemAt(c.x, c.y, placed, byType);
  if (p) removeBuilding(p);
}

function markTiles() {
  document.querySelectorAll<HTMLElement>(".tile").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.type === brush?.name)));
}
function setBrush(b: Brush | null) {
  dropHeld(); // a building that was being moved goes back first
  brush = b;
  if (b) selected = null;
  if (b && tool !== "select") setTool("select");
  markTiles();
  cursor();
  commit();
}
// Put a building that's mid-move back where it was.
function dropHeld() {
  if (!brush?.from) return;
  placed.splice(brush.at ?? placed.length, 0, brush.from);
  brush = null;
  markTiles();
  endStroke();
}
function pickUp(p: Placed, by?: CellXY) {
  beginStroke();
  const at = placed.indexOf(p);
  placed.splice(at, 1);
  setBrush({ name: p.name, r: p.r, from: p, at, grab: by && { x: by.x - p.x, y: by.y - p.y } });
}
function setTool(next: Tool) {
  tool = next;
  ruler = null;
  if (next !== "select") { dropHeld(); brush = null; selected = null; markTiles(); }
  for (const id of ["select", "erase", "measure"]) $(`tool-${id}`).setAttribute("aria-pressed", String(next === id));
  cursor();
  commit();
}
function cursor() {
  canvas.className = gesture?.kind === "pan" ? "panning" : spaceHeld ? "pan" : tool === "select" ? (brush ? "" : "pan") : tool;
}

// ---------- panels ----------
// Followers a building sleeps (Structures_Bed.SlotCount) and toilet uses before it's emptied
// (Structures_Outhouse.Capacity); a follower goes once per meal.
const BEDS: Record<string, number> = { BED: 1, BED_2: 1, BED_3: 1, SHARED_HOUSE: 3, LEADER_TENT: 1 };
const TOILETS: Record<string, number> = { OUTHOUSE: 5, OUTHOUSE_2: 15 };
function updateCapacity() {
  const sum = (by: Record<string, number>) => placed.reduce((n, p) => n + (by[p.name] ?? 0), 0);
  const rows = [{ key: "capBeds", n: sum(BEDS) }, { key: "capToilets", n: sum(TOILETS), hint: "capToiletsHint" }];
  const room = Math.min(...rows.map(r => r.n));
  $("st-capacity").hidden = rows.every(r => !r.n);
  $("st-room").textContent = t("capSupports", { n: room });
  $("st-capacity-list").replaceChildren(...rows.map(r => el("li", { className: r.n === room ? "limit" : "", title: r.hint ? t(r.hint) : "" },
    el("span", {}, t(r.key), r.n === room ? ` · ${t("capLimit")}` : ""), el("b", { className: "num" }, String(r.n)))));
}
function updateStats() {
  const used = placed.reduce((n, p) => n + byType[p.name].w * byType[p.name].h, 0);
  $("st-count").textContent = String(placed.length);
  $("st-cells").textContent = String(used);
  $("st-cells-of").textContent = t("statsCells", { n: cells.size });
  $("st-bar").parentElement!.title = t("statsFree", { n: cells.size - used });
  $("st-bar").style.width = `${Math.min(100, used / cells.size * 100)}%`;
  const counts: Record<string, number> = {};
  for (const p of placed) if (tabOf[p.name]) counts[tabOf[p.name].id] = (counts[tabOf[p.name].id] ?? 0) + 1;
  $("st-groups").replaceChildren(...game!.menu.filter(tab => counts[tab.id]).sort((a, b) => counts[b.id] - counts[a.id])
    .map(tab => el("li", {}, el("span", {}, term(tab.term)), el("b", { className: "num" }, String(counts[tab.id])))));
  updateCapacity();
  updateMaterials();
  updateLegend();
}
// the buildings the base starts with cost nothing; their upgrades do
const FREE = new Set(base.defaults?.map(d => d.type));
function updateMaterials() {
  const total = new Map<string, number>();
  for (const p of placed) costOf(p.name, FREE, total);
  $("st-materials").hidden = !total.size;
  $("st-materials-list").replaceChildren(...[...total].sort((a, b) => b[1] - a[1]).map(([i, n]) => itemChip(i, n)));
}

// "2×2 · level 1 of 3 · one per base"
function meta(T: string, r: { w: number; h: number }, extra?: string | null) {
  const tiers = tiersOf(T);
  return [`${r.w}×${r.h}`, tiers.length > 1 && t("levelOf", { n: tiers.indexOf(T) + 1, m: tiers.length }),
    limitOf(T) === 1 && t("onePerBase"), extra].filter(Boolean).join(" · ");
}
function updateInspector() {
  const p = brush ?? (hover && !selected ? itemAt(hover.x, hover.y, placed, byType) : undefined);
  const box = $("inspector");
  box.hidden = !p;
  box.classList.toggle("holding", !!brush);
  if (!p) return;
  const T = p.name;
  if (box.dataset.type !== T) { box.dataset.type = T; $("ins-art").replaceChildren(thumb(T, 52)); }
  $("ins-name").textContent = nameOf(T);
  $("ins-meta").textContent = meta(T, rect({ r: p.r, x: 0, y: 0 }, byType[T]), brush && t(brush.from ? "moving" : "placing"));
  showCost($("ins-cost"), T);
  $("ins-desc").textContent = descOf(T);
  $("ins-actions").hidden = !brush;
}

// Level picker for the selected building: every level of its upgrade chain, plus flip/move/delete.
function updateSelectionCard() {
  const card = $("selection");
  card.hidden = !selected;
  if (!selected) return;
  const T = selected.name, tiers = tiersOf(T);
  $("sel-name").textContent = nameOf(T);
  $("sel-meta").textContent = meta(T, rect(selected, byType[T]));
  showCost($("sel-cost"), T);
  $("sel-desc").textContent = descOf(T);
  $("sel-tiers").hidden = tiers.length < 2;
  $("sel-tiers").replaceChildren(...tiers.map((X, i) => {
    const b = el("button", { title: [nameOf(X), costText(X)].filter(Boolean).join("\n") }, thumb(X, 30), el("span", { className: "num" }, ROMAN[i] ?? String(i + 1)));
    b.setAttribute("aria-pressed", String(X === T));
    b.onclick = () => setLevel(X);
    return b;
  }));
  const del = $<HTMLButtonElement>("sel-delete");
  del.disabled = !deletable(selected);
  del.title = t(deletable(selected) ? "deleteKey" : "cantDelete");
  placeSelectionCard();
}
function placeSelectionCard() {
  if (!selected) return;
  const card = $("selection");
  if (phone.matches) { card.style.left = card.style.top = ""; card.classList.remove("below"); return; } // docked at the bottom
  const r = rect(selected, byType[selected.name]);
  const [cx] = toScreen(r.x - .5 + r.w / 2, r.y - .5 + r.h / 2);
  const [, back] = toScreen(r.x - .5 + r.w, r.y - .5 + r.h); // the footprint's top corner on screen
  const a = art(selected.name);
  const top = a ? toScreen(r.x, r.y)[1] - a.item[5] * view.s / a.ppu : back - view.s; // the sprite's top edge
  const h = card.offsetHeight, half = card.offsetWidth / 2;
  // above the sprite, or below the footprint when the toolbar leaves no room above
  const below = top - 8 - h < 64;
  const y = below ? toScreen(r.x - .5, r.y - .5)[1] + 10 : top - 8;
  card.classList.toggle("below", below);
  card.style.left = `${Math.min(size.w - half - 10, Math.max(half + 10, cx))}px`;
  card.style.top = `${Math.min(size.h - 10 - (below ? h : 0), y)}px`;
}
function setLevel(T: string) {
  if (!selected) return;
  const next = { ...selected, name: T };
  const others = placed.filter(p => p !== selected);
  if (!fits(next, others, byType, cells)) { toast(t("levelNoFit")); return; }
  beginStroke();
  placed[placed.indexOf(selected)] = next;
  selected = next;
  endStroke();
}
function select(p: Placed | null | undefined) {
  selected = p ?? null;
  commit();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  $("toast-text").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 2800);
}
function confirm(title: string, text: string, okLabel: string): Promise<boolean> {
  const d = $<HTMLDialogElement>("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  d.returnValue = "";
  d.showModal();
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }));
}

// ---------- importing a save ----------
// The game's base as one undoable step: its land, then every building the planner can put on the grid.
// Weeds, trees, rubble and the like aren't buildings and are left out quietly, and so is what stands
// off the grid (the plaza's shrine and chest); buildings that can't go down are counted as skipped.
const typeOfId = new Map(Object.entries(game.types).map(([T, x]) => [x.id, T]));
async function importSave(file: File) {
  let save;
  try { save = await readSave(new Uint8Array(await file.arrayBuffer())); }
  catch { toast(t("importFailed")); return; }
  dropHeld();
  selected = null;
  beginStroke();
  applyLand(Math.min(maxLand, save.land));
  placed = [];
  let skipped = 0;
  for (const s of save.structures) {
    const T = typeOfId.get(s.type);
    if (!T) continue;
    const p: Placed = { name: T, x: s.x, y: s.y, r: s.flipped ? 1 : 0 };
    if (byType[T] && fits(p, placed, byType, cells)) placed.push(p);
    else if (fits(p, [], game!.types, cells)) skipped++;
  }
  endStroke();
  toast(t(skipped ? "importedSkipped" : "imported", { n: placed.length, m: skipped }));
}

// ---------- named layouts ----------
const saveLayouts = () => store.set("layouts", layouts) && store.set("layout", current);
// for the actions in the layouts dialog: the list stays usable this visit even when the browser won't keep it
function savedOrWarn() { if (!saveLayouts()) toast(t("noStorage")); renderLayouts(); commit(); }
function unique(name: string) {
  let n = name;
  for (let i = 2; layouts.some(l => l.name === n); i++) n = `${name} ${i}`;
  return n;
}
function askName(title: string, value: string): Promise<string | null> {
  const d = $<HTMLDialogElement>("name-dialog"), input = $<HTMLInputElement>("name-input");
  $("name-title").textContent = title;
  input.value = value;
  d.returnValue = "";
  d.showModal();
  input.select();
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue === "ok" && input.value.trim() || null), { once: true }));
}
async function saveAs() {
  const name = await askName(t("saveAs"), current ? t("copyOf", { name: current }) : "");
  if (!name) return;
  current = unique(name);
  layouts.push({ name: current, hash: encode(placed, land) });
  savedOrWarn();
}
async function openLayout(l: Layout) {
  if (l.name === current) return $<HTMLDialogElement>("layouts-dialog").close();
  // the work on the map is lost unless it's a saved layout already (or nothing)
  if (!current && placed.some(deletable) && !await confirm(t("discardTitle"), t("discardText", { name: l.name }), t("open"))) return;
  dropHeld();
  selected = null;
  const s = fromHash(l.hash, 0);
  applyLand(s.land);
  placed = s.placed;
  undoStack.length = redoStack.length = 0; // undoing into another layout would save it into this one
  current = l.name;
  $<HTMLDialogElement>("layouts-dialog").close();
  savedOrWarn();
}
function renderLayouts() {
  const action = (l: Layout, icon: string, key: string, fn: () => unknown) =>
    el("button", { className: "icon-btn", title: t(key), ariaLabel: `${t(key)}: ${l.name}`, onclick: fn }, el("i", { className: `ph ${icon}` }));
  $("layouts-list").replaceChildren(...layouts.map(l => el("li", {},
    el("button", { className: "icon-btn name", ariaCurrent: l.name === current ? "true" : null, onclick: () => openLayout(l) }, el("span", {}, l.name)),
    action(l, "ph-pencil-simple", "rename", async () => {
      const name = await askName(t("rename"), l.name);
      if (!name || name === l.name) return;
      const was = l.name;
      l.name = unique(name);
      if (current === was) current = l.name;
      savedOrWarn();
    }),
    action(l, "ph-copy", "duplicate", () => { layouts.push({ name: unique(t("copyOf", { name: l.name })), hash: l.hash }); savedOrWarn(); }),
    action(l, "ph-trash", "delete", async () => {
      if (!await confirm(t("deleteLayout"), t("deleteLayoutText", { name: l.name }), t("delete"))) return;
      layouts = layouts.filter(x => x !== l);
      if (current === l.name) current = null;
      savedOrWarn();
    }),
  )));
  $("layouts-empty").hidden = layouts.length > 0;
}

// ---------- palette: the game's build menu ----------
function openSheet(open: boolean) {
  $("sheet").classList.toggle("open", open);
  $("sheet-toggle").setAttribute("aria-expanded", String(open));
}

function renderTabs() {
  $("tabs").replaceChildren(...game!.menu.map(tab => {
    const b = el("button", { role: "tab", title: term(tab.term) }, el("i", { className: `ph ${TAB_ICONS[tab.id] ?? "ph-squares-four"}` }), el("span", {}, term(tab.term)));
    b.dataset.tab = tab.id;
    b.onclick = () => {
      group = tab.id;
      store.set("group", group);
      $<HTMLInputElement>("search").value = "";
      renderPalette();
      openSheet(true);
    };
    return b;
  }));
}

function tile(T: string) {
  const b = el("button", { className: "tile" }, thumb(T, 40),
    el("span", { className: "name" }, el("b", {}, nameOf(T)), el("small", {}, meta(T, byType[T]))));
  b.dataset.type = T;
  b.setAttribute("aria-pressed", String(brush?.name === T));
  b.onclick = () => {
    const picking = !(brush?.name === T && !brush.from);
    setBrush(picking ? { name: T, r: 0 } : null);
    if (picking && phone.matches) openSheet(false); // show the map to place it on
  };
  return b;
}

function renderPalette() {
  hideTip();
  const raw = $<HTMLInputElement>("search").value.trim(), q = raw.toLocaleLowerCase(lang);
  document.querySelectorAll<HTMLElement>("#tabs button").forEach(b => b.setAttribute("aria-selected", String(!q && b.dataset.tab === group)));
  let sections: [string, string[], "grid" | "recent"][];
  if (q) {
    // a search finds every level, in the chosen language or English
    const hits: Record<string, string[]> = {};
    for (const T in byType)
      if (nameOf(T).toLocaleLowerCase(lang).includes(q) || (english.names[T] ?? "").toLowerCase().includes(q)) (hits[tabOf[T].id] ??= []).push(T);
    if (!Object.keys(hits).length) { $("palette").replaceChildren(el("p", { className: "empty-search" }, t("noMatch", { q: raw }))); return; }
    sections = game!.menu.filter(tab => hits[tab.id]).map(tab => [term(tab.term), hits[tab.id], "grid"]);
  } else {
    const tab = game!.menu.find(x => x.id === group) ?? game!.menu[0];
    sections = [...(recent.length ? [[t("recent"), recent, "recent"] as [string, string[], "recent"]] : []),
      ...tab.sections.map(s => [term(s.term), s.types.filter(T => byType[T]), "grid"] as [string, string[], "grid"])];
  }
  $("palette").replaceChildren(...sections.flatMap(([title, items, cls]) => [
    el("h2", {}, title, el("span", { className: "num" }, cls === "recent" ? "" : String(items.length))),
    el("div", { className: cls }, ...items.map(tile)),
  ]));
}

// Name, size and description of a tile, next to the list: a moment after the mouse rests on it
// (straight away when moving from tile to tile), or on keyboard focus.
let tipFor: HTMLElement | null = null, tipTimer: ReturnType<typeof setTimeout> | undefined;
function showTip(b: HTMLElement) {
  const T = b.dataset.type!, tip = $("tip");
  tipFor = b;
  $("tip-name").textContent = nameOf(T);
  $("tip-meta").textContent = meta(T, byType[T]);
  showCost($("tip-cost"), T);
  $("tip-desc").textContent = descOf(T);
  tip.hidden = false;
  const r = b.getBoundingClientRect(), side = $("sheet").getBoundingClientRect();
  const x = document.documentElement.dir === "rtl" ? side.left - 10 - tip.offsetWidth : side.right + 10;
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.min(innerHeight - tip.offsetHeight - 10, Math.max(10, r.top + r.height / 2 - tip.offsetHeight / 2))}px`;
  b.setAttribute("aria-describedby", "tip");
}
function hideTip() {
  clearTimeout(tipTimer);
  tipFor?.removeAttribute("aria-describedby");
  tipFor = null;
  $("tip").hidden = true;
}
const tileOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(".tile") : null);
$("palette").addEventListener("pointerover", e => {
  const b = tileOf(e.target);
  if (!b || b === tipFor || e.pointerType !== "mouse" || phone.matches) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(b), tipFor ? 0 : 150);
});
$("palette").addEventListener("pointerout", e => { if (!tileOf(e.relatedTarget)) hideTip(); });
$("palette").addEventListener("focusin", e => { const b = tileOf(e.target); if (b?.matches(":focus-visible") && !phone.matches) showTip(b); });
$("palette").addEventListener("focusout", hideTip);
$("palette").addEventListener("scroll", hideTip, { passive: true });
$("palette").addEventListener("click", hideTip);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown>, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

// Static page text in the chosen language: data-i18n (text), data-i18n-short (text without the
// shortcut), data-i18n-title, data-i18n-label (aria-label), data-i18n-tip (both, for icon buttons).
function applyUI() {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = languages.find(l => l.code === lang)?.dir ?? "ltr";
  document.title = t("title");
  document.querySelector<HTMLMetaElement>('meta[name="description"]')!.content = t("metaDescription");
  const each = (attr: string, fn: (e: HTMLElement, key: string) => void) => {
    for (const e of document.querySelectorAll<HTMLElement>(`[data-${attr}]`)) fn(e, e.getAttribute(`data-${attr}`)!);
  };
  each("i18n", (e, k) => (e.textContent = t(k)));
  each("i18n-short", (e, k) => (e.textContent = short(t(k))));
  each("i18n-title", (e, k) => (e.title = t(k)));
  each("i18n-label", (e, k) => e.setAttribute("aria-label", t(k)));
  each("i18n-placeholder", (e, k) => ((e as HTMLInputElement).placeholder = t(k)));
  each("i18n-tip", (e, k) => { e.title = t(k); e.setAttribute("aria-label", short(e.title)); });
  $("hint-text").textContent = t(phone.matches ? "emptyTextTouch" : "emptyText");
  for (const o of $<HTMLSelectElement>("look").options) o.textContent = t(`look${o.value[0].toUpperCase()}${o.value.slice(1)}`);
}

// ---------- falling rain and snow ----------
// Drawn over the map on their own layer, like the game's camera weather effects (left out of the
// captures, where they'd freeze into dots). Off for viewers who ask for reduced motion.
type Fall = { n: number; speed: [number, number]; len?: [number, number]; drift: number; size: [number, number]; color: string };
const FALL: Record<string, Fall> = {
  rain: { n: 240, speed: [650, 950], len: [10, 18], drift: .18, size: [1, 1.3], color: "rgb(200 215 255 / .32)" },
  winter: { n: 200, speed: [28, 60], drift: .22, size: [1.6, 3.4], color: "rgb(255 255 255 / .85)" },
  blizzard: { n: 650, speed: [240, 440], drift: 1.1, size: [1.2, 2.8], color: "rgb(240 246 255 / .8)" },
};
type Flake = { x: number; y: number; v: number; r: number; len: number; phase: number };
const fx = $<HTMLCanvasElement>("fx"), fxc = fx.getContext("2d")!;
const calm = matchMedia("(prefers-reduced-motion: reduce)");
const rand = ([a, b]: [number, number]) => a + Math.random() * (b - a);
let flakes: Flake[] = [], fxFrame = 0, fxLast = 0;
const flake = (f: Fall, anywhere: boolean): Flake => ({
  x: rand([-size.h * f.drift, size.w]), y: anywhere ? rand([0, size.h]) : rand([-30, -4]),
  v: rand(f.speed), r: rand(f.size) / 2, len: f.len ? rand(f.len) : 0, phase: Math.random() * 7,
});
function weather() {
  cancelAnimationFrame(fxFrame);
  fxc.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  fxc.clearRect(0, 0, size.w, size.h);
  const f = FALL[look];
  flakes = f && !calm.matches ? Array.from({ length: Math.round(f.n * size.w * size.h / 1e6) }, () => flake(f, true)) : [];
  if (!f || !flakes.length) return;
  fxLast = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(.05, (now - fxLast) / 1000);
    fxLast = now;
    fxc.clearRect(0, 0, size.w, size.h);
    fxc.beginPath();
    for (const p of flakes) {
      p.y += p.v * dt;
      p.x += p.v * f.drift * dt + (f.len ? 0 : Math.sin(now / 900 + p.phase) * 14 * dt); // snow sways
      if (p.y > size.h + 20 || p.x > size.w + 20) Object.assign(p, flake(f, false));
      if (f.len) { fxc.moveTo(p.x, p.y); fxc.lineTo(p.x - f.drift * p.len, p.y - p.len); }
      else { fxc.moveTo(p.x + p.r, p.y); fxc.arc(p.x, p.y, p.r, 0, Math.PI * 2); }
    }
    if (f.len) { fxc.lineWidth = f.size[0]; fxc.strokeStyle = f.color; fxc.stroke(); }
    else { fxc.fillStyle = f.color; fxc.fill(); }
    fxFrame = requestAnimationFrame(tick);
  };
  fxFrame = requestAnimationFrame(tick);
}
calm.addEventListener("change", () => { weather(); requestDraw(); });

// ---------- input ----------
const local = (e: MouseEvent): [number, number] => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
const pointers = new Map<number, [number, number]>(); // pointers down on the map, for two-finger pinch
let lastPointer = "mouse";

canvas.addEventListener("pointerdown", e => {
  const [px, py] = local(e);
  lastPointer = e.pointerType;
  pointers.set(e.pointerId, [px, py]);
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) return startPinch();
  if (pointers.size > 2 || gesture?.kind === "pinch") return;
  const c = cellAt(px, py);
  hover = c;
  const under = itemAt(c.x, c.y, placed, byType);
  if (e.button === 1 || spaceHeld || (e.button === 0 && tool === "select" && !brush && !under)) {
    gesture = { kind: "pan", px, py, tx: view.tx, ty: view.ty, still: true };
    return cursor();
  }
  if (e.button !== 0) return;
  if (tool === "measure") {
    gesture = { kind: "measure" };
    ruler = { a: c, b: c };
    return requestDraw();
  }
  if (tool === "erase") {
    gesture = { kind: "erase" };
    beginStroke(); eraseAt(c);
  } else if (brush && e.pointerType === "touch") {
    // a finger hides what's under it: the ghost follows it, and the building goes down when it lifts
    gesture = { kind: "aim" };
  } else if (brush?.from) {
    // dropping a building being moved: one click, no row painting
    if (tryPlace(c)) { brush = null; markTiles(); endStroke(); }
    return;
  } else if (brush) {
    gesture = { kind: "paint" };
    beginStroke(); tryPlace(c);
  } else {
    // on a building: a click selects it (level picker), a drag moves it
    gesture = { kind: "press", p: under, px, py };
    return;
  }
  commit();
});

canvas.addEventListener("pointermove", e => {
  const [px, py] = local(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [px, py]);
  if (gesture?.kind === "pinch") return pinchMove();
  if (e.pointerType === "touch" && !pointers.has(e.pointerId)) return;
  const c = cellAt(px, py);
  const moved = !hover || hover.x !== c.x || hover.y !== c.y, from = hover;
  hover = c;
  if (gesture?.kind === "pan") {
    if (Math.hypot(px - gesture.px, py - gesture.py) > 4) gesture.still = false;
    userView = true;
    view.tx = gesture.tx + px - gesture.px;
    view.ty = gesture.ty + py - gesture.py;
    return requestDraw();
  }
  if (gesture?.kind === "press" && Math.hypot(px - gesture.px, py - gesture.py) > (e.pointerType === "touch" ? 8 : 5)) {
    const { p, px: gx, py: gy } = gesture;
    gesture = { kind: "drag" };
    if (p) pickUp(p, cellAt(gx, gy));
  }
  if (!moved) return;
  const passed = from ? cellsBetween(from, c) : [c];
  if (gesture?.kind === "paint") for (const p of passed) { if (gesture?.kind === "paint") tryPlace(p); } // tryPlace can end the stroke
  if (gesture?.kind === "erase") passed.forEach(eraseAt);
  if (gesture?.kind === "measure") ruler!.b = c;
  else if (gesture) updateStats();
  updateInspector();
  requestDraw();
});

const endGesture = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (gesture?.kind === "pinch") { if (!pointers.size) gesture = null; return; }
  if (!gesture) return;
  if (e.type === "pointercancel") { cancelGesture(); return commit(); }
  const g = gesture;
  gesture = null;
  if (g.kind === "press") select(g.p === selected ? null : g.p);
  else if (g.kind === "drag") { if (hover && tryPlace(hover)) { brush = null; markTiles(); endStroke(); } else dropHeld(); }
  else if (g.kind === "aim" && hover && brush) {
    if (!brush.from) { beginStroke(); tryPlace(hover); endStroke(); }
    else if (tryPlace(hover)) { brush = null; markTiles(); endStroke(); }
  }
  else if (g.kind === "pan") { if (g.still && selected) select(null); }
  else if (g.kind === "measure") { /* the box stays until the next one */ }
  else endStroke();
  cursor();
};
canvas.addEventListener("pointerup", endGesture);
canvas.addEventListener("pointercancel", endGesture);
canvas.addEventListener("pointerleave", () => { if (!gesture) { hover = null; updateInspector(); requestDraw(); } });
canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (lastPointer !== "mouse") return; // a long press on a touch screen isn't a right-click
  const c = cellAt(...local(e)), p = itemAt(c.x, c.y, placed, byType);
  if (p) { beginStroke(); removeBuilding(p); endStroke(); }
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  zoomAt(...local(e), Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0015))); // ctrlKey = trackpad pinch
}, { passive: false });

// A second finger turns the gesture into a pinch; whatever the first finger started is undone.
function cancelGesture() {
  if (gesture?.kind === "drag") dropHeld();
  else if ((gesture?.kind === "paint" || gesture?.kind === "erase") && strokeBefore !== null) { restore(strokeBefore); strokeBefore = null; }
  gesture = null;
}
function twoPointers() {
  const [[ax, ay], [bx, by]] = pointers.values();
  return { d: Math.hypot(ax - bx, ay - by) || 1, mx: (ax + bx) / 2, my: (ay + by) / 2 };
}
function startPinch() {
  cancelGesture();
  gesture = { kind: "pinch", ...twoPointers() };
  hover = null;
  commit();
}
function pinchMove() {
  if (pointers.size < 2 || gesture?.kind !== "pinch") return;
  const now = twoPointers();
  view.tx += now.mx - gesture.mx;
  view.ty += now.my - gesture.my;
  zoomAt(now.mx, now.my, now.d / gesture.d);
  Object.assign(gesture, now);
}

function zoomAt(px: number, py: number, f: number) {
  const s = Math.min(MAX_S, Math.max(MIN_S, view.s * f)), k = s / view.s;
  view = { s, tx: px - (px - view.tx) * k, ty: py - (py - view.ty) * k };
  userView = true;
  $("zoom").textContent = `${Math.round(s / fitScale * 100)}%`;
  requestDraw();
}
function fit() {
  view = fitView(size.w, size.h, Math.min(40, size.w / 20, size.h / 20)); // the islands float over the edges anyway
  fitScale = view.s;
  userView = false;
  $("zoom").textContent = "100%";
  requestDraw();
}

document.addEventListener("keydown", e => {
  if (e.target instanceof Element && e.target.closest("input, select, dialog")) return;
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if ((e.metaKey || e.ctrlKey) && k === "y") { e.preventDefault(); return redo(); }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (k === " ") { e.preventDefault(); if (!spaceHeld) { spaceHeld = true; cursor(); } }
  else if (k === "r") rotate();
  else if (k === "v") setTool("select");
  else if (k === "e") setTool("erase");
  else if (k === "m") setTool("measure");
  else if (k === "l") toggleLabels();
  else if (k === "a") toggleRanges();
  else if (k === "f") fit();
  else if (k === "+" || k === "=") zoomAt(size.w / 2, size.h / 2, 1.25);
  else if (k === "-") zoomAt(size.w / 2, size.h / 2, .8);
  else if (k === "?") $<HTMLDialogElement>("help-dialog").showModal();
  else if (k === "escape") { selected = null; setBrush(null); }
  else if (k === "delete" || k === "backspace") {
    const p = selected ?? (hover && itemAt(hover.x, hover.y, placed, byType));
    if (p) { beginStroke(); removeBuilding(p); endStroke(); }
  }
});
document.addEventListener("keyup", e => { if (e.key === " ") { spaceHeld = false; cursor(); } });

function rotate() {
  if (brush) { brush.r = brush.r ? 0 : 1; brush.grab = undefined; updateInspector(); requestDraw(); }
  else if (selected) { beginStroke(); const i = placed.indexOf(selected); placed[i] = selected = { ...selected, r: selected.r ? 0 : 1 }; endStroke(); }
}
function toggleLabels() {
  showLabels = !showLabels;
  store.set("labels", showLabels);
  $("labels").setAttribute("aria-pressed", String(showLabels));
  requestDraw();
}
function toggleRanges() {
  showRanges = !showRanges;
  store.set("ranges", showRanges);
  $("ranges").setAttribute("aria-pressed", String(showRanges));
  updateLegend();
  requestDraw();
}

$("tool-select").onclick = () => setTool("select");
$("tool-erase").onclick = () => setTool("erase");
$("tool-measure").onclick = () => setTool("measure");
$("rotate").onclick = rotate;
$("undo").onclick = undo;
$("redo").onclick = redo;
$("labels").onclick = toggleLabels;
$("labels").setAttribute("aria-pressed", String(showLabels));
$("ranges").onclick = toggleRanges;
$("ranges").setAttribute("aria-pressed", String(showRanges));
$("help").onclick = () => $<HTMLDialogElement>("help-dialog").showModal();
$("zoom-in").onclick = () => zoomAt(size.w / 2, size.h / 2, 1.25);
$("zoom-out").onclick = () => zoomAt(size.w / 2, size.h / 2, .8);
$("fit").onclick = fit;
$("ins-flip").onclick = rotate;
$("ins-cancel").onclick = () => setBrush(null);
$("sel-flip").onclick = rotate;
$("sel-move").onclick = () => { const p = selected; selected = null; if (p) pickUp(p); };
$("sel-delete").onclick = () => { if (!selected) return; beginStroke(); removeBuilding(selected); endStroke(); };
$("sheet-toggle").onclick = () => openSheet(!$("sheet").classList.contains("open"));
// a menu closes once one of its entries is used (the view settings are a menu on narrow screens only)
const closeMenu = (menu: HTMLElement) => { try { if (menu.matches(":popover-open")) menu.hidePopover(); } catch { /* no popover support */ } };
for (const id of ["more", "file"]) {
  $(id).addEventListener("change", () => closeMenu($(id)));
  $(id).addEventListener("click", e => { if (e.target instanceof Element && e.target.closest("button")) closeMenu($(id)); });
}
const foldStats = (open: boolean) => { $("stats-toggle").setAttribute("aria-expanded", String(open)); store.set("stats", open); };
$("stats-toggle").onclick = () => foldStats($("stats-toggle").getAttribute("aria-expanded") !== "true");
foldStats(store.get("stats", true));
$("clear").onclick = () => {
  if (!placed.some(deletable)) return;
  dropHeld(); beginStroke(); placed = placed.filter(p => !deletable(p)); endStroke();
  toast(t("cleared"));
};
$("share").onclick = async () => {
  commit();
  try { await navigator.clipboard.writeText(location.href); toast(t("copied")); }
  catch { toast(t("noClipboard")); }
};
$("layouts").onclick = () => { renderLayouts(); $<HTMLDialogElement>("layouts-dialog").showModal(); };
$("layouts-save").onclick = saveAs;
$("name-cancel").onclick = () => $<HTMLDialogElement>("name-dialog").close();
$("import").onclick = () => $<HTMLDialogElement>("import-dialog").showModal();
$("import-choose").onclick = () => $<HTMLInputElement>("save-file").click();
$<HTMLInputElement>("save-file").onchange = e => {
  const input = e.target as HTMLInputElement, file = input.files?.[0];
  input.value = ""; // picking the same file again still imports
  $<HTMLDialogElement>("import-dialog").close();
  if (file) void importSave(file);
};
$("png").onclick = () => {
  // Render the whole base at a fixed scale, independent of the current zoom.
  const s = 26, pad = 60;
  const sz = { w: Math.ceil((BOUNDS.x1 - BOUNDS.x0) * s + 2 * pad), h: Math.ceil((BOUNDS.y1 - BOUNDS.y0) * s + 2 * pad), dpr: 1 };
  const off = Object.assign(document.createElement("canvas"), { width: sz.w, height: sz.h });
  draw(off.getContext("2d")!, sz, { s, tx: pad - BOUNDS.x0 * s, ty: pad - BOUNDS.y0 * s }, false);
  off.toBlob(blob => {
    if (!blob) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "cult-base.png" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t("pngSaved"));
  });
};
const landSelect = $<HTMLSelectElement>("land"), langSelect = $<HTMLSelectElement>("lang");
$("search").oninput = renderPalette;
landSelect.value = String(land);
landSelect.onchange = () => setLand(+landSelect.value);
if (!maxLand) landSelect.closest("label")!.style.display = "none";
const lookSelect = $<HTMLSelectElement>("look");
const lookIcon = () => ($("look-icon").className = `ph ${LOOK_ICONS[look] ?? "ph-cloud-sun"}`);
lookSelect.replaceChildren(...looks.map(l => el("option", { value: l })));
lookSelect.value = look;
lookSelect.onchange = () => { look = lookSelect.value; store.set("look", look); lookIcon(); weather(); requestDraw(); };
// picture quality: the most detail this viewer wants for the textures and for the animations. Its
// panel opens on its own, not inside the menu the button may sit in, which closes.
$("quality-open").onclick = () => { try { $("quality").showPopover(); } catch { /* no popover support */ } };
for (const key of ["textures", "animations"] as const) {
  const select = $<HTMLSelectElement>(key);
  select.value = String(quality[key]);
  select.onchange = () => {
    quality[key] = +select.value;
    store.set(key, quality[key]);
    for (const sc of scenes.values()) { for (const p of sc.pictures.values()) p.bitmap?.close(); sc.pictures.clear(); } // the other detail's pictures go
    requestDraw();
  };
}
lookIcon();
if (looks.length < 2) lookSelect.closest("label")!.style.display = "none";
langSelect.replaceChildren(...languages.map(l => el("option", { value: l.code, textContent: native(l.code) })));
langSelect.value = lang;
langSelect.onchange = async () => {
  const code = langSelect.value, data = code === "en" ? english : await load<Strings>(`data/i18n/${code}.json`);
  if (!data) { langSelect.value = lang; return; }
  if (langSelect.value !== code) return; // another language was picked while this one loaded
  [L, lang] = [data, code];
  store.set("lang", lang);
  applyUI(); renderTabs(); renderPalette(); commit();
};
if (languages.length < 2) langSelect.closest("label")!.style.display = "none";
phone.addEventListener("change", () => { applyUI(); commit(); });

new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  size = { w: width, h: height, dpr: devicePixelRatio || 1 };
  canvas.width = fx.width = Math.round(width * size.dpr);
  canvas.height = fx.height = Math.round(height * size.dpr);
  if (!userView) fit(); else requestDraw();
  weather();
}).observe(canvas.parentElement!);

applyUI();
renderTabs();
renderPalette();
openSheet(phone.matches && !placed.some(deletable)); // phones open on the building list until there's something to look at
commit();
