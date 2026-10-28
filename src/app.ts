import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import { rect, fits, itemAt, encode, decode, cellsFor, type Placed, type Cell } from "./core.ts";
import type { Atlas, Background, BaseData, Building, GameData, Language, MenuTab, Strings, WikiBuilding } from "./types.ts";

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
type Brush = { name: string; r: 0 | 1; from?: Placed; at?: number };
type CellXY = { x: number; y: number };
type Gesture =
  | { kind: "pan"; px: number; py: number; tx: number; ty: number; still: boolean }
  | { kind: "press"; p: Placed | undefined; px: number; py: number }
  | { kind: "pinch"; d: number; mx: number; my: number }
  | { kind: "paint" | "erase" | "drag" | "aim" };

// Every id the script touches exists in index.html; the type parameter says what kind of element it is.
const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const canvas = $<HTMLCanvasElement>("map"), ctx = canvas.getContext("2d")!;
const load = <T>(u: string): Promise<T | null> => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
const phone = matchMedia("(max-width: 767px)");

const [base, game, bg, atlas, wiki, langs, en] = await Promise.all([
  load<BaseData>("data/base.json"), load<GameData>("data/game.json"), load<Background>("data/background.json"),
  load<Atlas>("data/looks/day/sprites.json"), load<WikiBuilding[]>("data/buildings.json"),
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
// Paths and floors lie flat; without a render of their own they're drawn on the ground, not standing up.
const isFloor = (T: string) => /^TILE_|_FLOOR$/.test(T);

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

// Per-viewer conveniences only; the layout itself lives in the URL.
const store = {
  get<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off: fine */ } },
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

// ---------- looks: the base as the game draws it by weather and time of day ----------
// data/looks/<look>/ holds a backdrop per number of land upgrades bought (background-N) and the
// buildings' atlas (sprites.json and its sheets), all rendered by the game itself (tools/capture).
// A look loads the first time it's picked; the palette always uses the day atlas. Each backdrop
// shows a small version first, and the atlas's second sheet (upgrade levels) loads only when asked for.
const LOOK_ICONS: Record<string, string> = { day: "ph-sun", night: "ph-moon-stars", rain: "ph-cloud-rain", bloodmoon: "ph-moon", winter: "ph-snowflake", blizzard: "ph-cloud-snow" };
const GRID: Record<string, number> = { night: .4, bloodmoon: .4 }; // build-grid strength where the scene is dark
const looks = bg?.looks ?? ["day"];
let look = store.get("look", "day");
if (!looks.includes(look)) look = looks[0];
let shown = look; // the look on screen: a newly picked one takes over once its art has loaded
type Scene = { name: string; atlas: Atlas | null; sheets: HTMLImageElement[]; backdrops: Map<string, { small: HTMLImageElement; full: HTMLImageElement }> };
const scenes = new Map<string, Scene>();
const ready = (img?: HTMLImageElement) => !!img?.complete && !!img.naturalWidth;
// AVIF where the browser has it, WebP otherwise (an AVIF it can't decode fails to load).
function picture(path: string) {
  const img = Object.assign(new Image(), { onload: requestDraw });
  img.onerror = () => { if (img.src.endsWith(".avif")) img.src = `${path}.webp`; };
  img.src = `${path}.avif`;
  return img;
}
function scene(name: string): Scene {
  let sc = scenes.get(name);
  if (!sc) {
    const s: Scene = { name, atlas: name === "day" ? atlas : null, sheets: [], backdrops: new Map() };
    if (s.atlas) sheet(s, 0);
    else void load<Atlas>(`data/looks/${name}/sprites.json`).then(a => { s.atlas = a; if (a) sheet(s, 0); });
    scenes.set(name, sc = s);
  }
  return sc;
}
// Sheet i of a look's atlas, fetched the first time it's asked for.
const sheet = (sc: Scene, i: number) => (sc.sheets[i] ??= picture(`data/looks/${sc.name}/${sc.atlas!.sheets[i]}`));
// A look's backdrop for a land level: the full image once loaded, the small one until then (unless `full`).
function backdropOf(name: string, level: number, full = false) {
  if (!bg) return null;
  const sc = scene(name), path = `data/looks/${name}/${bg.images[Math.min(level, bg.images.length - 1)]}`;
  let b = sc.backdrops.get(path);
  if (!b) sc.backdrops.set(path, b = { small: Object.assign(new Image(), { onload: requestDraw, src: `${path}.small.webp` }), full: picture(path) });
  return ready(b.full) ? b.full : !full && ready(b.small) ? b.small : null;
}
function backdrop() {
  if (backdropOf(look, land, true) && ready(scene(look).sheets[0])) shown = look;
  // while another land level's image loads, keep showing whichever one is ready
  return backdropOf(shown, land) ?? [...scene(shown).backdrops.values()].find(b => ready(b.full))?.full ?? null;
}
// A building's render in the look on screen, or the day one while that loads.
function art(T: string) {
  for (const sc of [scene(shown), scene("day")]) {
    const item = sc.atlas?.items[T], image = item && sheet(sc, item[6] ?? 0);
    if (item && ready(image)) return { image: image!, item, ppu: sc.atlas!.ppu };
  }
  return null;
}

// ---------- layout state ----------
// Links made before layouts were keyed by type named buildings by their English (wiki or game) name.
const aliases: Record<string, string> = {};
for (const [n, T] of Object.entries(game.wiki)) if (byType[T]) aliases[n] = T;
for (const T in byType) if (english.names[T]) { aliases[english.names[T]] ??= T; aliases[`${english.names[T]} (${T})`] = T; }
const decoded = decode(location.hash, { ...aliases, ...byType });
for (const p of decoded.placed) p.name = byType[p.name] ? p.name : aliases[p.name];
const maxLand = base.expansions?.length ?? 0;
// a shared link says how much land it was planned on; otherwise use this viewer's last choice
let land = Math.min(maxLand, decoded.land ?? (location.hash.length > 1 ? 0 : store.get("land", 0)));
let { tiles, cells } = cellsFor(base, land);
let placed: Placed[] = decoded.placed.filter(p => fits(p, [], byType, cells));
// Every base starts with its Temple, which the game won't delete: add it where it usually stands.
for (const d of base.defaults ?? []) {
  const p: Placed = { name: d.type, x: d.x, y: d.y, r: 0 };
  if (byType[d.type] && !placed.some(q => chainKey(q.name) === chainKey(d.type)) && fits(p, placed, byType, cells)) placed.unshift(p);
}
let tool: "select" | "erase" = "select";
let brush: Brush | null = null; // while holding a building; `from`/`at` = where a moved one came from
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

// The held footprint is centred on the hovered cell.
function anchored(b: Brush, c: CellXY): Placed {
  const r = rect({ r: b.r, x: 0, y: 0 }, byType[b.name]);
  return { name: b.name, r: b.r, x: c.x - Math.floor((r.w - 1) / 2), y: c.y - Math.floor((r.h - 1) / 2) };
}

// ---------- art for the palette and panels ----------
// A building as the game draws it, shrunk into a square box (`size` CSS pixels, for resolution);
// the wiki's build-menu icon when the game render is missing.
function thumb(T: string, size = 44): HTMLElement {
  const a = atlas?.items[T];
  if (a) {
    const image = sheet(scene("day"), a[6] ?? 0);
    const px = Math.round(size * Math.min(2, devicePixelRatio || 1));
    const c = el("canvas", { className: "thumb", width: px, height: px });
    const paint = () => {
      const [x, y, w, h] = a, k = Math.min(px / w, px / h, px / 40);
      c.getContext("2d")!.drawImage(image, x, y, w, h, (px - w * k) / 2, (px - h * k) / 2, w * k, h * k);
    };
    if (ready(image)) paint(); else image.addEventListener("load", paint, { once: true });
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
let frame = 0;
function requestDraw() { frame ||= requestAnimationFrame(() => { frame = 0; draw(ctx, size, view, true); }); }

const gridSpace = (c: Ctx, sz: Size, v: View) => c.setTransform(sz.dpr * v.s * K, -sz.dpr * v.s * K * V, -sz.dpr * v.s * K, -sz.dpr * v.s * K * V, sz.dpr * v.tx, sz.dpr * v.ty);
const screenSpace = (c: Ctx, sz: Size) => c.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);

function draw(c: Ctx, sz: Size, v: View, live: boolean) {
  screenSpace(c, sz);
  c.fillStyle = "#141012";
  c.fillRect(0, 0, sz.w, sz.h);

  // backdrop: image pixel (X, Y) sits at u = u0 + X/ppu, v = v0 - Y/ppu relative to grid origin
  const bgImage = backdrop();
  const area = bg && bgImage ? [v.s * bg.u0 + v.tx, -v.s * bg.v0 + v.ty, bg.w * v.s / bg.ppu, bg.h * v.s / bg.ppu] as const : null;
  if (area && bgImage) c.drawImage(bgImage, ...area);
  const hasBg = !!bgImage;

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

  // footprints flat on the ground first, then sprites back-to-front so nearer ones overlap
  const hovered = live && !brush && hover ? itemAt(hover.x, hover.y, placed, byType) : null;
  const items: [Placed, Mode][] = placed.map(p => [p, live && p === selected ? "selected" : p === hovered ? (tool === "erase" ? "erase" : "hover") : "normal"]);
  if (live && brush && hover) {
    const g = anchored(brush, hover);
    items.push([g, fits(g, placed, byType, cells) ? "ghost" : "blocked"]);
  }
  for (const [p, mode] of items) footprint(c, sz, v, p, mode);
  const depth = (p: Placed) => p.x + p.y; // larger x + y sits further up the screen, i.e. further back
  for (const [p, mode] of items.sort((a, b) => depth(b[0]) - depth(a[0]))) sprite(c, sz, v, p, mode);
  // the game's weather tint, a colour it lays over the screen; here over the scene, not the empty margin
  const tint = bg?.tint?.[shown];
  if (tint && area) {
    screenSpace(c, sz);
    c.fillStyle = `rgb(${tint.slice(0, 3).map(x => Math.round(x * 255)).join(" ")} / ${tint[3]})`;
    c.fillRect(...area);
  }
  if (showLabels) for (const [p, mode] of items) if (mode !== "ghost" && mode !== "blocked") label(c, sz, v, p);
  if (live) placeSelectionCard();
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
function footprint(c: Ctx, sz: Size, v: View, p: Placed, mode: Mode) {
  const T = p.name, r = rect(p, byType[T]), hue = hueOf(T);
  gridSpace(c, sz, v);
  c.fillStyle = FILL[mode] ?? `hsl(${hue} 30% 24% / .45)`;
  c.fillRect(r.x - .5, r.y - .5, r.w, r.h);
  const flat = isFloor(T) && !atlas?.items[T] && icon(T);
  if (flat) c.drawImage(flat, r.x - .5, r.y - .5, r.w, r.h);
  c.lineWidth = (mode === "normal" ? 1.25 : 2) / v.s;
  c.strokeStyle = LINE[mode] ?? `hsl(${hue} 40% 52%)`;
  c.strokeRect(r.x - .5 + .5 / v.s, r.y - .5 + .5 / v.s, r.w - 1 / v.s, r.h - 1 / v.s);
}

function sprite(c: Ctx, sz: Size, v: View, p: Placed, mode: Mode) {
  const T = p.name, r = rect(p, byType[T]);
  const a = art(T);
  if (a) {
    // the game's own render: anchored at the centre of the footprint's first cell, same projection as the map
    const [x, y, w, h, ax, ay] = a.item, k = v.s / a.ppu;
    const [px, py] = toScreen(r.x, r.y, v);
    screenSpace(c, sz);
    c.translate(px, py);
    if (p.r) c.scale(-1, 1); // the game's "rotate" mirrors the building
    if (mode === "ghost" || mode === "blocked") c.globalAlpha = .75;
    c.drawImage(a.image, x, y, w, h, -ax * k, -ay * k, w * k, h * k);
    c.globalAlpha = 1;
    return;
  }
  if (!isFloor(T)) wikiIcon(c, sz, v, r, p, mode);
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
function pickUp(p: Placed) {
  beginStroke();
  const at = placed.indexOf(p);
  placed.splice(at, 1);
  setBrush({ name: p.name, r: p.r, from: p, at });
}
function setTool(next: "select" | "erase") {
  tool = next;
  if (next === "erase") { dropHeld(); brush = null; selected = null; markTiles(); }
  $("tool-select").setAttribute("aria-pressed", String(next === "select"));
  $("tool-erase").setAttribute("aria-pressed", String(next === "erase"));
  cursor();
  commit();
}
function cursor() {
  canvas.className = gesture?.kind === "pan" ? "panning" : spaceHeld ? "pan" : tool === "erase" ? "erase" : brush ? "" : "pan";
}

// ---------- panels ----------
function updateStats() {
  const used = placed.reduce((n, p) => n + byType[p.name].w * byType[p.name].h, 0);
  $("st-count").textContent = String(placed.length);
  $("st-cells").textContent = String(used);
  $("st-cells-of").textContent = t("statsCells", { n: cells.size });
  $("st-bar").style.width = `${Math.min(100, used / cells.size * 100)}%`;
  const counts: Record<string, number> = {};
  for (const p of placed) if (tabOf[p.name]) counts[tabOf[p.name].id] = (counts[tabOf[p.name].id] ?? 0) + 1;
  $("st-groups").replaceChildren(...game!.menu.filter(tab => counts[tab.id]).sort((a, b) => counts[b.id] - counts[a.id])
    .map(tab => el("li", {}, el("span", {}, term(tab.term)), el("b", { className: "num" }, String(counts[tab.id])))));
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
  $("sel-desc").textContent = descOf(T);
  $("sel-tiers").hidden = tiers.length < 2;
  $("sel-tiers").replaceChildren(...tiers.map((X, i) => {
    const b = el("button", { title: nameOf(X) }, thumb(X, 30), el("span", { className: "num" }, ROMAN[i] ?? String(i + 1)));
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
  const name = nameOf(T), tiers = tiersOf(T).length;
  const b = el("button", { className: "tile" },
    thumb(T), el("span", {}, name), el("small", { className: "num" }, `${byType[T].w}×${byType[T].h}`));
  if (tiers > 1) b.prepend(el("span", { className: "tiers num", title: t("levelsHint", { n: tiers }) }, el("i", { className: "ph ph-stack" }), String(tiers)));
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
calm.addEventListener("change", weather);

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
  const moved = !hover || hover.x !== c.x || hover.y !== c.y;
  hover = c;
  if (gesture?.kind === "pan") {
    if (Math.hypot(px - gesture.px, py - gesture.py) > 4) gesture.still = false;
    userView = true;
    view.tx = gesture.tx + px - gesture.px;
    view.ty = gesture.ty + py - gesture.py;
    return requestDraw();
  }
  if (gesture?.kind === "press" && Math.hypot(px - gesture.px, py - gesture.py) > (e.pointerType === "touch" ? 8 : 5)) {
    const p = gesture.p;
    gesture = { kind: "drag" };
    if (p) pickUp(p);
  }
  if (!moved) return;
  if (gesture?.kind === "paint") tryPlace(c);
  if (gesture?.kind === "erase") eraseAt(c);
  if (gesture) updateStats();
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
  view = fitView(size.w, size.h, Math.min(90, size.w / 10, size.h / 10));
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
  else if (k === "l") toggleLabels();
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
  if (brush) { brush.r = brush.r ? 0 : 1; updateInspector(); requestDraw(); }
  else if (selected) { beginStroke(); const i = placed.indexOf(selected); placed[i] = selected = { ...selected, r: selected.r ? 0 : 1 }; endStroke(); }
}
function toggleLabels() {
  showLabels = !showLabels;
  store.set("labels", showLabels);
  $("labels").setAttribute("aria-pressed", String(showLabels));
  requestDraw();
}

$("tool-select").onclick = () => setTool("select");
$("tool-erase").onclick = () => setTool("erase");
$("rotate").onclick = rotate;
$("undo").onclick = undo;
$("redo").onclick = redo;
$("labels").onclick = toggleLabels;
$("labels").setAttribute("aria-pressed", String(showLabels));
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
// on phones these live in a popup menu, which closes once one is used
for (const id of ["land", "look", "labels", "clear", "png"])
  $(id).addEventListener(id === "land" || id === "look" ? "change" : "click", () => { try { $("more").hidePopover(); } catch { /* no popover support */ } });
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
