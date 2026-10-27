import { rect, fits, itemAt, encode, decode, cellsFor } from "./core.js";

// The game rotates the base grid 45° (data/base.json "rotation") and its cameras look down
// at ~45°, which flattens the ground vertically by about cos 45°. So a cell (x, y) lands
// at K·(x − y, −V·(x + y)) before zoom and pan, and buildings stand upright on top.
const K = Math.SQRT1_2, V = Math.SQRT1_2;
const MIN_S = 6, MAX_S = 90;
const ROMAN = ["I", "II", "III", "IV", "V"];
const TAB_ICONS = { follower: "ph-users-three", faith: "ph-hands-praying", decor: "ph-flower-tulip", woolhaven: "ph-mountains" };

const $ = id => document.getElementById(id);
const canvas = $("map"), ctx = canvas.getContext("2d");
const load = u => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
const phone = matchMedia("(max-width: 767px)");

const [base, game, bg, atlas, wiki, langs, en] = await Promise.all(
  ["base", "game", "background", "sprites", "buildings", "i18n/index", "i18n/en"].map(n => load(`data/${n}.json`)));

// ---------- buildings, keyed by the game's structure type (BED, TEMPLE_II, ...) ----------
// A placed building is { name: type, x, y, r }. The build menu (game.menu, as the game groups it)
// lists each building's first level; the other levels of its upgrade chain are picked on the map.
const chainOf = {};
for (const chain of game.chains) for (const T of chain) chainOf[T] = chain;
const wikiOf = {}; // the wiki's entry for a type: an English name and a build-menu icon (fallback art)
for (const b of wiki ?? []) if (game.wiki[b.name]) wikiOf[game.wiki[b.name]] ??= b;
const byType = {}, tabOf = {};
for (const tab of game.menu) for (const s of tab.sections) for (const head of s.types)
  for (const T of chainOf[head] ?? [head]) {
    // higher levels only when there's something to draw for them
    if (T !== head && !atlas?.items[T] && !wikiOf[T]?.icon) continue;
    const t = game.types[T];
    byType[T] ??= { type: T, w: t.w, h: t.h, once: !!t.once, fixed: !!t.fixed, icon: wikiOf[T]?.icon };
    tabOf[T] ??= tab;
  }
// one building per chain, whatever its level, counts against the limit
const chainKey = T => chainOf[T]?.[0] ?? T;
const tiersOf = T => (chainOf[T] ?? [T]).filter(X => byType[X]);
const limitOf = T => (byType[T].once ? 1 : Infinity);
const deletable = p => !byType[p.name].fixed;
// Paths and floors lie flat; without a render of their own they're drawn on the ground, not standing up.
const isFloor = T => /^TILE_|_FLOOR$/.test(T);

// ---------- text: the game's own translations plus the planner's strings ----------
const EMPTY = { ui: {}, terms: {}, names: {}, desc: {} };
const english = en ?? EMPTY;
const languages = langs ?? [{ code: "en", name: "English" }];
const native = code => {
  try { const s = new Intl.DisplayNames([code], { type: "language" }).of(code); return s[0].toLocaleUpperCase(code) + s.slice(1); }
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
function store0(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
const store = { get: store0, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let lang = store.get("lang", null) ?? preferred();
if (!languages.some(l => l.code === lang)) lang = "en";
let L = lang === "en" ? english : await load(`data/i18n/${lang}.json`);
if (!L) [L, lang] = [english, "en"];
const t = (key, vars = {}) => (L.ui[key] ?? english.ui[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
const short = s => s.replace(/\s*\([^()]*\)$/, ""); // "Undo (Ctrl+Z)" → "Undo", for labels that show no shortcut
const term = key => L.terms[key] || english.terms[key] || key;
const nameOf = T => L.names[T] || english.names[T] || wikiOf[T]?.name || T;
const descOf = T => L.desc[T] || english.desc[T] || "";

// ---------- backdrop and sprites ----------
// Backdrop rendered by the game (tools/capture), one image per number of land expansions bought.
const backdrops = new Map();
function backdrop(level) {
  if (!bg) return null;
  const src = bg.images ? bg.images[Math.min(level, bg.images.length - 1)] : "background.webp";
  let img = backdrops.get(src);
  if (!img) {
    img = new Image();
    img.onload = requestDraw;
    img.src = "data/" + src;
    backdrops.set(src, img);
  }
  // while another level's image loads, keep showing whichever one is ready
  return img.complete && img.naturalWidth ? img : [...backdrops.values()].find(i => i.complete && i.naturalWidth) ?? null;
}
// Buildings as the game draws them, packed in one atlas: items[type] = [x, y, w, h, anchorX, anchorY].
const atlasImage = atlas && Object.assign(new Image(), { src: "data/sprites.webp" });
let atlasReady = false;
atlasImage?.addEventListener("load", () => { atlasReady = true; requestDraw(); });

// ---------- layout state ----------
// Links made before layouts were keyed by type name buildings by their English (wiki or game) name.
const aliases = {};
for (const [n, T] of Object.entries(game.wiki)) if (byType[T]) aliases[n] = T;
for (const T in byType) if (english.names[T]) { aliases[english.names[T]] ??= T; aliases[`${english.names[T]} (${T})`] = T; }
const decoded = decode(location.hash, { ...aliases, ...byType });
for (const p of decoded.placed) p.name = byType[p.name] ? p.name : aliases[p.name];
const maxLand = base.expansions?.length ?? 0;
// a shared link says how much land it was planned on; otherwise use this viewer's last choice
let land = Math.min(maxLand, decoded.land ?? (location.hash.length > 1 ? 0 : store0("land", 0)));
let { tiles, cells } = cellsFor(base, land);
let placed = decoded.placed.filter(p => fits(p, [], byType, cells));
// Every base starts with its Temple, which the game won't delete: add it where it usually stands.
for (const d of base.defaults ?? []) {
  const p = { name: d.type, x: d.x, y: d.y, r: 0 };
  if (byType[d.type] && !placed.some(q => chainKey(q.name) === chainKey(d.type)) && fits(p, placed, byType, cells)) placed.unshift(p);
}
let tool = "select"; // or "erase"
let brush = null; // { name, r, from?, at? } while holding a building; `from`/`at` = where a moved one came from
let selected = null; // placed building whose level picker is open
let hover = null; // cell under the pointer
let view = { s: 20, tx: 0, ty: 0 }, fitScale = 20, userView = false; // userView: panned/zoomed by hand, so stop auto-fitting
let size = { w: 0, h: 0, dpr: 1 };
let gesture = null; // { kind: "pan" | "paint" | "erase" | "press" | "drag" | "aim" | "pinch", ... } while a pointer is down
let spaceHeld = false;
const undoStack = [], redoStack = [];
let strokeBefore = null;
let recent = store.get("recent", []).filter(T => byType[T]);
let showLabels = store.get("labels", false);
let group = store.get("group", null);
if (!game.menu.some(tab => tab.id === group)) group = game.menu[0].id;

// ---------- geometry ----------
function boundsOf(ts) {
  const corners = ts.flatMap(([x, y]) => [[x - .5, y - .5], [x + .5, y + .5], [x - .5, y + .5], [x + .5, y - .5]]);
  const isoX = corners.map(([x, y]) => K * (x - y)), isoY = corners.map(([x, y]) => -K * V * (x + y));
  return { x0: Math.min(...isoX), x1: Math.max(...isoX), y0: Math.min(...isoY), y1: Math.max(...isoY) };
}
let BOUNDS = boundsOf(tiles);
const toScreen = (x, y, v = view) => [v.s * K * (x - y) + v.tx, -v.s * K * V * (x + y) + v.ty];
function cellAt(px, py) {
  const X = (px - view.tx) / (view.s * K), Y = (py - view.ty) / (view.s * K * V); // X = x − y, Y = −(x + y)
  return { x: Math.round((X - Y) / 2), y: Math.round((-X - Y) / 2) };
}
const fitView = (w, h, pad = 90) => {
  const s = Math.min((w - 2 * pad) / (BOUNDS.x1 - BOUNDS.x0), (h - 2 * pad) / (BOUNDS.y1 - BOUNDS.y0));
  return { s, tx: w / 2 - s * (BOUNDS.x0 + BOUNDS.x1) / 2, ty: h / 2 - s * (BOUNDS.y0 + BOUNDS.y1) / 2 };
};

// The held footprint is centred on the hovered cell.
function anchored(c) {
  const r = rect({ ...brush, x: 0, y: 0 }, byType[brush.name]);
  return { name: brush.name, r: brush.r, x: c.x - Math.floor((r.w - 1) / 2), y: c.y - Math.floor((r.h - 1) / 2) };
}

// ---------- art for the palette and panels ----------
// A building as the game draws it, shrunk into a square box (`size` CSS pixels, for resolution);
// the wiki's build-menu icon when the game render is missing.
function thumb(T, size = 44) {
  const a = atlas?.items[T];
  if (a) {
    const px = Math.round(size * Math.min(2, devicePixelRatio || 1));
    const c = el("canvas", { className: "thumb", width: px, height: px });
    const paint = () => {
      const [x, y, w, h] = a, k = Math.min(px / w, px / h, px / 40);
      c.getContext("2d").drawImage(atlasImage, x, y, w, h, (px - w * k) / 2, (px - h * k) / 2, w * k, h * k);
    };
    if (atlasReady) paint(); else atlasImage.addEventListener("load", paint, { once: true });
    return c;
  }
  const blank = () => el("i", { className: "thumb ph ph-image" });
  // anonymous CORS (the wiki CDN allows it) keeps the map exportable; no referrer or the CDN refuses the hotlink
  return byType[T].icon ? el("img", { className: "thumb", crossOrigin: "anonymous", referrerPolicy: "no-referrer", loading: "lazy", alt: "", src: byType[T].icon, onerror() { this.replaceWith(blank()); } }) : blank();
}

// Wiki icons drawn on the map for buildings without a game render.
const images = new Map();
function icon(T) {
  let img = images.get(T);
  if (!img) {
    img = Object.assign(new Image(), { crossOrigin: "anonymous", referrerPolicy: "no-referrer", onload: requestDraw });
    if (byType[T].icon) img.src = byType[T].icon;
    images.set(T, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

const hueOf = T => {
  let h = 0;
  for (const ch of tabOf[T]?.id ?? T) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};
const initials = name => name.split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();

// ---------- drawing ----------
let frame = 0;
function requestDraw() { frame ||= requestAnimationFrame(() => { frame = 0; draw(ctx, size, view, true); }); }

const gridSpace = (c, sz, v) => c.setTransform(sz.dpr * v.s * K, -sz.dpr * v.s * K * V, -sz.dpr * v.s * K, -sz.dpr * v.s * K * V, sz.dpr * v.tx, sz.dpr * v.ty);
const screenSpace = (c, sz) => c.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);

function draw(c, sz, v, live) {
  screenSpace(c, sz);
  c.fillStyle = "#141012";
  c.fillRect(0, 0, sz.w, sz.h);

  // backdrop: image pixel (X, Y) sits at u = u0 + X/ppu, v = v0 - Y/ppu relative to grid origin
  const bgImage = backdrop(land), hasBg = !!bgImage;
  if (hasBg) c.drawImage(bgImage, v.s * bg.u0 + v.tx, -v.s * bg.v0 + v.ty, bg.w * v.s / bg.ppu, bg.h * v.s / bg.ppu);

  // ground: over the art, inset rounded green outlines like the game's build-mode tiles;
  // without art, plain filled cells
  gridSpace(c, sz, v);
  c.beginPath();
  if (hasBg) for (const [x, y] of tiles) c.roundRect(x - .42, y - .42, .84, .84, .14);
  else for (const [x, y] of tiles) c.rect(x - .5, y - .5, 1, 1);
  c.fillStyle = hasBg ? "rgb(150 220 140 / .07)" : "#3d4e33";
  c.fill();
  c.lineWidth = (hasBg ? 1.5 : 1) / v.s;
  c.strokeStyle = hasBg ? "rgb(72 176 96 / .75)" : "rgb(20 16 18 / .45)";
  c.stroke();

  // footprints flat on the ground first, then sprites back-to-front so nearer ones overlap
  const hovered = live && !brush && hover ? itemAt(hover.x, hover.y, placed, byType) : null;
  const items = placed.map(p => [p, live && p === selected ? "selected" : p === hovered ? (tool === "erase" ? "erase" : "hover") : "normal"]);
  if (live && brush && hover) {
    const g = anchored(hover);
    items.push([g, fits(g, placed, byType, cells) ? "ghost" : "blocked"]);
  }
  for (const [p, mode] of items) footprint(c, sz, v, p, mode);
  const depth = p => p.x + p.y; // larger x + y sits further up the screen, i.e. further back
  for (const [p, mode] of items.sort((a, b) => depth(b[0]) - depth(a[0]))) sprite(c, sz, v, p, mode);
  if (showLabels) for (const [p, mode] of items) if (mode !== "ghost" && mode !== "blocked") label(c, sz, v, p);
  if (live) placeSelectionCard();
}

function halo(c, text, x, y) {
  c.lineWidth = 3;
  c.lineJoin = "round";
  c.strokeStyle = "rgb(20 16 18 / .85)";
  c.strokeText(text, x, y);
  c.fillStyle = "#ede4d3";
  c.fillText(text, x, y);
}

function footprint(c, sz, v, p, mode) {
  const T = p.name, r = rect(p, byType[T]), hue = hueOf(T);
  gridSpace(c, sz, v);
  c.fillStyle = { ghost: "rgb(143 179 108 / .55)", blocked: "rgb(200 66 59 / .55)", erase: "rgb(200 66 59 / .5)", selected: "rgb(200 66 59 / .25)" }[mode] ?? `hsl(${hue} 30% 24% / .45)`;
  c.fillRect(r.x - .5, r.y - .5, r.w, r.h);
  const flat = isFloor(T) && !atlas?.items[T] && icon(T);
  if (flat) c.drawImage(flat, r.x - .5, r.y - .5, r.w, r.h);
  c.lineWidth = (mode === "normal" ? 1.25 : 2) / v.s;
  c.strokeStyle = { ghost: "#b9d896", blocked: "#e06b63", erase: "#e06b63", hover: "#ede4d3", selected: "#e06b63" }[mode] ?? `hsl(${hue} 40% 52%)`;
  c.strokeRect(r.x - .5 + .5 / v.s, r.y - .5 + .5 / v.s, r.w - 1 / v.s, r.h - 1 / v.s);
}

function sprite(c, sz, v, p, mode) {
  const T = p.name, r = rect(p, byType[T]);
  const a = atlasReady && atlas.items[T];
  if (a) {
    // the game's own render: anchored at the centre of the footprint's first cell, same projection as the map
    const [x, y, w, h, ax, ay] = a, k = v.s / atlas.ppu;
    const [px, py] = toScreen(r.x, r.y, v);
    screenSpace(c, sz);
    c.translate(px, py);
    if (p.r) c.scale(-1, 1); // the game's "rotate" mirrors the building
    if (mode === "ghost" || mode === "blocked") c.globalAlpha = .75;
    c.drawImage(atlasImage, x, y, w, h, -ax * k, -ay * k, w * k, h * k);
    c.globalAlpha = 1;
    return;
  }
  if (!isFloor(T)) wikiIcon(c, sz, v, r, p, mode);
}

// Fallback for buildings without extracted art: the wiki's build-menu icon, upright, feet near the front corner.
function wikiIcon(c, sz, v, r, p, mode) {
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

function label(c, sz, v, p) {
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
function restore(json) { const s = JSON.parse(json); placed = s.placed; selected = null; applyLand(s.land); }
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
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
  $("hint").hidden = placed.some(deletable) || !!brush || !!selected;
  updateStats();
  updateInspector();
  updateSelectionCard();
  requestDraw();
}
function undo() { if (!undoStack.length) return; dropHeld(); redoStack.push(snapshot()); restore(undoStack.pop()); commit(); }
function redo() { if (!redoStack.length) return; dropHeld(); undoStack.push(snapshot()); restore(redoStack.pop()); commit(); }

function applyLand(level) {
  if (level === land && tiles) return;
  land = level;
  ({ tiles, cells } = cellsFor(base, land));
  BOUNDS = boundsOf(tiles);
  $("land").value = String(land);
  store.set("land", land);
  if (!userView && size.w) fit();
}
// Buying less land than a layout uses drops what no longer fits (one undoable step).
function setLand(level) {
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
function tryPlace(c) {
  const cand = anchored(c);
  if (!fits(cand, placed, byType, cells)) return false;
  const same = placed.filter(p => chainKey(p.name) === chainKey(cand.name));
  if (!brush.from && same.length >= limitOf(cand.name)) {
    gesture = null; // stop painting a row while we ask
    offerMove(cand, same[0], limitOf(cand.name));
    return false;
  }
  placed.push(cand);
  remember(cand.name);
  return true;
}
async function offerMove(cand, old, limit) {
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
function remember(T) {
  if (recent[0] === T) return;
  recent = [T, ...recent.filter(n => n !== T)].slice(0, 10);
  store.set("recent", recent);
  renderPalette();
}
function removeBuilding(p) {
  if (!deletable(p)) { toast(t("cantRemove", { name: nameOf(p.name) })); return false; }
  placed.splice(placed.indexOf(p), 1);
  return true;
}
function eraseAt(c) {
  const p = itemAt(c.x, c.y, placed, byType);
  if (p) removeBuilding(p);
}

function markTiles() {
  document.querySelectorAll(".tile").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.type === brush?.name)));
}
function setBrush(b) {
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
  placed.splice(brush.at, 0, brush.from);
  brush = null;
  markTiles();
  endStroke();
}
function pickUp(p) {
  beginStroke();
  const at = placed.indexOf(p);
  placed.splice(at, 1);
  setBrush({ name: p.name, r: p.r, from: p, at });
}
function setTool(next) {
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
  $("st-count").textContent = placed.length;
  $("st-cells").textContent = used;
  $("st-cells-of").textContent = t("statsCells", { n: cells.size });
  $("st-bar").style.width = `${Math.min(100, used / cells.size * 100)}%`;
  const counts = {};
  for (const p of placed) if (tabOf[p.name]) counts[tabOf[p.name].id] = (counts[tabOf[p.name].id] ?? 0) + 1;
  $("st-groups").replaceChildren(...game.menu.filter(tab => counts[tab.id]).sort((a, b) => counts[b.id] - counts[a.id])
    .map(tab => el("li", {}, el("span", {}, term(tab.term)), el("b", { className: "num" }, String(counts[tab.id])))));
}

// "2×2 · level 1 of 3 · one per base"
function meta(T, r, extra) {
  const tiers = tiersOf(T);
  return [`${r.w}×${r.h}`, tiers.length > 1 && t("levelOf", { n: tiers.indexOf(T) + 1, m: tiers.length }),
    limitOf(T) === 1 && t("onePerBase"), extra].filter(Boolean).join(" · ");
}
function updateInspector() {
  const p = brush ?? (hover && !selected && itemAt(hover.x, hover.y, placed, byType));
  const box = $("inspector");
  box.hidden = !p;
  box.classList.toggle("holding", !!brush);
  if (!p) return;
  const T = p.name;
  if (box.dataset.type !== T) { box.dataset.type = T; $("ins-art").replaceChildren(thumb(T, 52)); }
  $("ins-name").textContent = nameOf(T);
  $("ins-meta").textContent = meta(T, rect(p, byType[T]), brush && t(brush.from ? "moving" : "placing"));
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
  $("sel-delete").disabled = !deletable(selected);
  $("sel-delete").title = t(deletable(selected) ? "deleteKey" : "cantDelete");
  placeSelectionCard();
}
function placeSelectionCard() {
  if (!selected) return;
  const card = $("selection");
  if (phone.matches) { card.style.left = card.style.top = ""; card.classList.remove("below"); return; } // docked at the bottom
  const r = rect(selected, byType[selected.name]);
  const [cx] = toScreen(r.x - .5 + r.w / 2, r.y - .5 + r.h / 2);
  const [, back] = toScreen(r.x - .5 + r.w, r.y - .5 + r.h); // the footprint's top corner on screen
  const a = atlas?.items[selected.name];
  const top = a ? toScreen(r.x, r.y)[1] - a[5] * view.s / atlas.ppu : back - view.s; // the sprite's top edge
  const h = card.offsetHeight, half = card.offsetWidth / 2;
  // above the sprite, or below the footprint when the toolbar leaves no room above
  const below = top - 8 - h < 64;
  const y = below ? toScreen(r.x - .5, r.y - .5)[1] + 10 : top - 8;
  card.classList.toggle("below", below);
  card.style.left = `${Math.min(size.w - half - 10, Math.max(half + 10, cx))}px`;
  card.style.top = `${Math.min(size.h - 10 - (below ? h : 0), y)}px`;
}
function setLevel(T) {
  const next = { ...selected, name: T };
  const others = placed.filter(p => p !== selected);
  if (!fits(next, others, byType, cells)) { toast(t("levelNoFit")); return; }
  beginStroke();
  placed[placed.indexOf(selected)] = next;
  selected = next;
  endStroke();
}
function select(p) {
  selected = p;
  commit();
}

let toastTimer;
function toast(text) {
  $("toast-text").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 2800);
}
function confirm(title, text, okLabel) {
  const d = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  d.returnValue = "";
  d.showModal();
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }));
}

// ---------- palette: the game's build menu ----------
function openSheet(open) {
  $("sheet").classList.toggle("open", open);
  $("sheet-toggle").setAttribute("aria-expanded", String(open));
}

function renderTabs() {
  $("tabs").replaceChildren(...game.menu.map(tab => {
    const b = el("button", { role: "tab", title: term(tab.term) }, el("i", { className: `ph ${TAB_ICONS[tab.id] ?? "ph-squares-four"}` }), el("span", {}, term(tab.term)));
    b.dataset.tab = tab.id;
    b.onclick = () => {
      group = tab.id;
      store.set("group", group);
      $("search").value = "";
      renderPalette();
      openSheet(true);
    };
    return b;
  }));
}

function tile(T) {
  const name = nameOf(T), desc = descOf(T), tiers = tiersOf(T).length;
  const b = el("button", { className: "tile", title: desc ? `${name}\n${desc}` : name },
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
  const raw = $("search").value.trim(), q = raw.toLocaleLowerCase(lang);
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", String(!q && b.dataset.tab === group)));
  let sections;
  if (q) {
    // a search finds every level, in the chosen language or English
    const hits = {};
    for (const T in byType)
      if (nameOf(T).toLocaleLowerCase(lang).includes(q) || (english.names[T] ?? "").toLowerCase().includes(q)) (hits[tabOf[T].id] ??= []).push(T);
    if (!Object.keys(hits).length) return $("palette").replaceChildren(el("p", { className: "empty-search" }, t("noMatch", { q: raw })));
    sections = game.menu.filter(tab => hits[tab.id]).map(tab => [term(tab.term), hits[tab.id], "grid"]);
  } else {
    const tab = game.menu.find(x => x.id === group);
    sections = (recent.length ? [[t("recent"), recent, "recent"]] : [])
      .concat(tab.sections.map(s => [term(s.term), s.types.filter(T => byType[T]), "grid"]));
  }
  $("palette").replaceChildren(...sections.flatMap(([title, items, cls]) => [
    el("h2", {}, title, el("span", { className: "num" }, cls === "recent" ? "" : String(items.length))),
    el("div", { className: cls }, ...items.map(tile)),
  ]));
}

function el(tag, props, ...kids) {
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
  document.querySelector('meta[name="description"]').content = t("metaDescription");
  for (const e of document.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll("[data-i18n-short]")) e.textContent = short(t(e.dataset.i18nShort));
  for (const e of document.querySelectorAll("[data-i18n-title]")) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll("[data-i18n-label]")) e.setAttribute("aria-label", t(e.dataset.i18nLabel));
  for (const e of document.querySelectorAll("[data-i18n-placeholder]")) e.placeholder = t(e.dataset.i18nPlaceholder);
  for (const e of document.querySelectorAll("[data-i18n-tip]")) { e.title = t(e.dataset.i18nTip); e.setAttribute("aria-label", short(e.title)); }
  $("hint-text").textContent = t(phone.matches ? "emptyTextTouch" : "emptyText");
}

// ---------- input ----------
const local = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
const pointers = new Map(); // pointers down on the map, for two-finger pinch
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
    pickUp(p);
  }
  if (!moved) return;
  if (gesture?.kind === "paint") tryPlace(c);
  if (gesture?.kind === "erase") eraseAt(c);
  if (gesture) updateStats();
  updateInspector();
  requestDraw();
});

const endGesture = e => {
  pointers.delete(e.pointerId);
  if (gesture?.kind === "pinch") { if (!pointers.size) gesture = null; return; }
  if (!gesture) return;
  if (e.type === "pointercancel") { cancelGesture(); return commit(); }
  const g = gesture;
  gesture = null;
  if (g.kind === "press") select(g.p === selected ? null : g.p);
  else if (g.kind === "drag") { if (hover && tryPlace(hover)) { brush = null; markTiles(); endStroke(); } else dropHeld(); }
  else if (g.kind === "aim" && hover) {
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
function startPinch() {
  cancelGesture();
  const [[ax, ay], [bx, by]] = pointers.values();
  gesture = { kind: "pinch", d: Math.hypot(ax - bx, ay - by) || 1, mx: (ax + bx) / 2, my: (ay + by) / 2 };
  hover = null;
  commit();
}
function pinchMove() {
  if (pointers.size < 2) return;
  const [[ax, ay], [bx, by]] = pointers.values();
  const d = Math.hypot(ax - bx, ay - by) || 1, mx = (ax + bx) / 2, my = (ay + by) / 2;
  view.tx += mx - gesture.mx;
  view.ty += my - gesture.my;
  zoomAt(mx, my, d / gesture.d);
  Object.assign(gesture, { d, mx, my });
}

function zoomAt(px, py, f) {
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
  if (e.target.closest?.("input, select, dialog")) return;
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
  else if (k === "?") $("help-dialog").showModal();
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
$("help").onclick = () => $("help-dialog").showModal();
$("zoom-in").onclick = () => zoomAt(size.w / 2, size.h / 2, 1.25);
$("zoom-out").onclick = () => zoomAt(size.w / 2, size.h / 2, .8);
$("fit").onclick = fit;
$("ins-flip").onclick = rotate;
$("ins-cancel").onclick = () => setBrush(null);
$("sel-flip").onclick = rotate;
$("sel-move").onclick = () => { const p = selected; selected = null; pickUp(p); };
$("sel-delete").onclick = () => { beginStroke(); removeBuilding(selected); endStroke(); };
$("sheet-toggle").onclick = () => openSheet(!$("sheet").classList.contains("open"));
// on phones these live in a popup menu, which closes once one is used
for (const id of ["land", "labels", "clear", "png"]) $(id).addEventListener(id === "land" ? "change" : "click", () => { try { $("more").hidePopover(); } catch {} });
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
  draw(off.getContext("2d"), sz, { s, tx: pad - BOUNDS.x0 * s, ty: pad - BOUNDS.y0 * s }, false);
  off.toBlob(blob => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "cult-base.png" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t("pngSaved"));
  });
};
$("search").oninput = renderPalette;
$("land").value = String(land);
$("land").onchange = e => setLand(+e.target.value);
if (!maxLand) $("land").closest("label").hidden = true;
$("lang").replaceChildren(...languages.map(l => el("option", { value: l.code, textContent: native(l.code) })));
$("lang").value = lang;
$("lang").onchange = async e => {
  const code = e.target.value, data = code === "en" ? english : await load(`data/i18n/${code}.json`);
  if (!data) { $("lang").value = lang; return; }
  if ($("lang").value !== code) return; // another language was picked while this one loaded
  [L, lang] = [data, code];
  store.set("lang", lang);
  applyUI(); renderTabs(); renderPalette(); commit();
};
if (languages.length < 2) $("lang").closest("label").hidden = true;
phone.addEventListener("change", () => { applyUI(); commit(); });

new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  size = { w: width, h: height, dpr: devicePixelRatio || 1 };
  canvas.width = Math.round(width * size.dpr);
  canvas.height = Math.round(height * size.dpr);
  if (!userView) fit(); else requestDraw();
}).observe(canvas.parentElement);

applyUI();
renderTabs();
renderPalette();
openSheet(phone.matches && !placed.some(deletable)); // phones open on the building list until there's something to look at
commit();
