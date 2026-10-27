import { rect, fits, itemAt, encode, decode, cellsFor } from "./core.js";

// The game rotates the base grid 45° (data/base.json "rotation") and its cameras look down
// at ~45°, which flattens the ground vertically by about cos 45°. So a cell (x, y) lands
// at K·(x − y, −V·(x + y)) before zoom and pan, and buildings stand upright on top.
const K = Math.SQRT1_2, V = Math.SQRT1_2;
const GROUPS = { "Follower buildings": "Followers", Faith: "Faith", Decorations: "Decor", Woolhaven: "Woolhaven" };
const MIN_S = 6, MAX_S = 90;

const $ = id => document.getElementById(id);
const canvas = $("map"), ctx = canvas.getContext("2d");

const [buildings, base, game] = await Promise.all(["data/buildings.json", "data/base.json", "data/game.json"].map(async u => (await fetch(u)).json()));
// Exact footprints from the game files (tools/background/build_sprites.py) replace the wiki's sizes.
for (const b of buildings) {
  const t = game.types[game.wiki[b.name]];
  if (t) Object.assign(b, { type: game.wiki[b.name], w: t.w, h: t.h, guess: false });
}
const byName = Object.fromEntries(buildings.map(b => [b.name, b]));

// Backdrop rendered by the game (tools/capture), one image per number of land expansions bought.
// Optional: the grid works without it.
const bg = await fetch("data/background.json").then(r => r.json()).catch(() => null);
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
// In-game building sprites, packed in one atlas: items[type] = [x, y, w, h, anchorX, anchorY].
const atlas = await fetch("data/sprites.json").then(r => r.json()).catch(() => null);
const atlasImage = atlas && Object.assign(new Image(), { src: "data/sprites.webp" });
atlasImage?.addEventListener("load", () => requestDraw());

const decoded = decode(location.hash, byName);
const maxLand = base.expansions?.length ?? 0;
// a shared link says how much land it was planned on; otherwise use this viewer's last choice
let land = Math.min(maxLand, decoded.land ?? (location.hash.length > 1 ? 0 : store0("land", 0)));
let { tiles, cells } = cellsFor(base, land);
let placed = decoded.placed.filter(p => fits(p, [], byName, cells));
let tool = "select"; // or "erase"
let brush = null; // { name, r, from? } while holding a building; `from` = where a moved one came from
let hover = null; // cell under the pointer
let view = { s: 20, tx: 0, ty: 0 }, fitScale = 20, userView = false; // userView: panned/zoomed by hand, so stop auto-fitting
let size = { w: 0, h: 0, dpr: 1 };
let gesture = null; // { kind: "pan" | "paint" | "erase", ... } while a pointer is down
let spaceHeld = false;
const undoStack = [], redoStack = [];
let strokeBefore = null;

// Per-viewer conveniences only; the layout itself lives in the URL.
const store = { get: store0, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
function store0(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
let recent = store.get("recent", []).filter(n => byName[n]);
let showLabels = store.get("labels", false);

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
  const r = rect({ ...brush, x: 0, y: 0 }, byName[brush.name]);
  return { name: brush.name, r: brush.r, x: c.x - Math.floor((r.w - 1) / 2), y: c.y - Math.floor((r.h - 1) / 2) };
}

// ---------- icons ----------
const images = new Map();
function icon(name) {
  let img = images.get(name);
  if (!img) {
    img = new Image();
    // anonymous CORS (the wiki CDN allows it) keeps the canvas exportable; no referrer or the CDN refuses the hotlink
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = requestDraw;
    if (byName[name].icon) img.src = byName[name].icon;
    images.set(name, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

const hueOf = name => {
  let h = 0;
  for (const ch of byName[name].category) h = (h * 31 + ch.charCodeAt(0)) % 360;
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
  const hovered = live && !brush && hover ? itemAt(hover.x, hover.y, placed, byName) : null;
  const items = placed.map(p => [p, p === hovered ? (tool === "erase" ? "erase" : "hover") : "normal"]);
  if (live && brush && hover) {
    const g = anchored(hover);
    items.push([g, fits(g, placed, byName, cells) ? "ghost" : "blocked"]);
  }
  for (const [p, mode] of items) footprint(c, sz, v, p, mode);
  const depth = p => p.x + p.y; // larger x + y sits further up the screen, i.e. further back
  for (const [p, mode] of items.sort((a, b) => depth(b[0]) - depth(a[0]))) sprite(c, sz, v, p, mode);
  if (showLabels) for (const [p, mode] of items) if (mode !== "ghost" && mode !== "blocked") label(c, sz, v, p);
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
  const r = rect(p, byName[p.name]), hue = hueOf(p.name);
  gridSpace(c, sz, v);
  c.fillStyle = { ghost: "rgb(143 179 108 / .55)", blocked: "rgb(200 66 59 / .55)", erase: "rgb(200 66 59 / .5)" }[mode] ?? `hsl(${hue} 30% 24% / .45)`;
  c.fillRect(r.x - .5, r.y - .5, r.w, r.h);
  c.lineWidth = (mode === "normal" ? 1.25 : 2) / v.s;
  c.strokeStyle = { ghost: "#b9d896", blocked: "#e06b63", erase: "#e06b63", hover: "#ede4d3" }[mode] ?? `hsl(${hue} 40% 52%)`;
  c.strokeRect(r.x - .5 + .5 / v.s, r.y - .5 + .5 / v.s, r.w - 1 / v.s, r.h - 1 / v.s);
}

function sprite(c, sz, v, p, mode) {
  const b = byName[p.name], r = rect(p, b);
  const a = atlasImage?.complete && atlasImage.naturalWidth && atlas.items[b.type];
  if (a) {
    // the game's own art: anchored at the centre of the footprint's first cell, same projection as the map
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
  wikiIcon(c, sz, v, r, p, mode);
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
    c.fillText(initials(p.name), cx, (front + back) / 2);
  }
  c.globalAlpha = 1;
}

function label(c, sz, v, p) {
  const r = rect(p, byName[p.name]);
  const [cx] = toScreen(r.x - .5 + r.w / 2, r.y - .5 + r.h / 2, v);
  const [, front] = toScreen(r.x - .5, r.y - .5, v);
  screenSpace(c, sz);
  c.font = "500 11px 'Geist Variable', system-ui";
  c.textAlign = "center"; c.textBaseline = "top";
  halo(c, p.name, cx, front + 3);
}

// ---------- state changes ----------
// History entries hold the layout and the land level together, so undo can bring back land too.
const snapshot = () => JSON.stringify({ placed, land });
function restore(json) { const s = JSON.parse(json); placed = s.placed; applyLand(s.land); }
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
  const hash = encode(placed, land);
  history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
  $("hint").hidden = placed.length > 0 || !!brush;
  updateStats();
  updateInspector();
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
  placed = placed.filter(p => fits(p, [], byName, cells));
  endStroke();
  const lost = before - placed.length;
  if (lost) toast(`Removed ${lost} building${lost > 1 ? "s" : ""} on land you haven't bought. Ctrl+Z brings them back.`);
}

function tryPlace(c) {
  const cand = anchored(c);
  if (!fits(cand, placed, byName, cells)) return false;
  placed.push(cand);
  remember(cand.name);
  return true;
}
function remember(name) {
  if (recent[0] === name) return;
  recent = [name, ...recent.filter(n => n !== name)].slice(0, 10);
  store.set("recent", recent);
  renderPalette();
}
function eraseAt(c) {
  const p = itemAt(c.x, c.y, placed, byName);
  if (p) placed.splice(placed.indexOf(p), 1);
}

function markTiles() {
  document.querySelectorAll(".tile").forEach(t => t.setAttribute("aria-pressed", String(t.dataset.name === brush?.name)));
}
function setBrush(b) {
  brush = b;
  if (b && tool !== "select") setTool("select");
  markTiles();
  cursor();
  commit();
}
// Put a building that's mid-move back where it was.
function dropHeld() {
  if (!brush?.from) return;
  placed.push(brush.from);
  brush = null;
  markTiles();
  endStroke();
}
function setTool(t) {
  tool = t;
  if (t === "erase") { dropHeld(); brush = null; markTiles(); }
  $("tool-select").setAttribute("aria-pressed", String(t === "select"));
  $("tool-erase").setAttribute("aria-pressed", String(t === "erase"));
  cursor();
  commit();
}
function cursor() {
  canvas.className = gesture?.kind === "pan" ? "panning" : spaceHeld ? "pan" : tool === "erase" ? "erase" : brush ? "" : "pan";
}

// ---------- panels ----------
function updateStats() {
  const used = placed.reduce((n, p) => n + byName[p.name].w * byName[p.name].h, 0);
  $("st-count").textContent = placed.length;
  $("st-cells").textContent = used;
  $("st-cells-of").textContent = `of ${cells.size} cells used`;
  $("st-bar").style.width = `${Math.min(100, used / cells.size * 100)}%`;
  const counts = {};
  for (const p of placed) counts[byName[p.name].category] = (counts[byName[p.name].category] ?? 0) + 1;
  $("st-groups").replaceChildren(...Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, n]) => el("li", {}, el("span", {}, k), el("b", { className: "num" }, String(n)))));
}

function updateInspector() {
  const p = brush ?? (hover && itemAt(hover.x, hover.y, placed, byName));
  $("inspector").hidden = !p;
  if (!p) return;
  const b = byName[p.name], r = rect(p, b);
  if ($("ins-icon").dataset.name !== b.name) {
    $("ins-icon").dataset.name = b.name;
    $("ins-icon").src = b.icon || "";
  }
  $("ins-name").textContent = b.name;
  $("ins-meta").textContent = `${b.category}, ${r.w}×${r.h}${brush ? (brush.from ? ", moving" : ", placing") : ""}`;
  $("ins-warn").hidden = !b.guess;
}

let toastTimer;
function toast(text) {
  $("toast-text").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 2200);
}

// ---------- palette ----------
const groupNames = Object.keys(GROUPS);
let group = store.get("group", groupNames[0]);
if (!GROUPS[group]) group = groupNames[0];

$("tabs").replaceChildren(...groupNames.map(g => {
  const t = el("button", { role: "tab", textContent: GROUPS[g], title: g });
  t.dataset.group = g;
  t.onclick = () => { group = g; store.set("group", g); $("search").value = ""; renderPalette(); };
  return t;
}));

function tile(b) {
  const t = el("button", { className: "tile", title: b.guess ? `${b.name} (footprint not confirmed)` : b.name },
    b.icon ? el("img", { crossOrigin: "anonymous", referrerPolicy: "no-referrer", loading: "lazy", src: b.icon, alt: "", onerror() { this.replaceWith(el("i", { className: "ph ph-image" })); } }) : el("i", { className: "ph ph-image" }),
    el("span", {}, b.name),
    el("small", { className: b.guess ? "num guess" : "num" }, `${b.w}×${b.h}${b.guess ? "?" : ""}`));
  t.dataset.name = b.name;
  t.setAttribute("aria-pressed", String(brush?.name === b.name));
  t.onclick = () => setBrush(brush?.name === b.name && !brush.from ? null : { name: b.name, r: 0 });
  return t;
}

function renderPalette() {
  const raw = $("search").value.trim(), q = raw.toLowerCase();
  document.querySelectorAll("#tabs button").forEach(t => t.setAttribute("aria-selected", String(!q && t.dataset.group === group)));
  const cats = {};
  for (const b of buildings) {
    if (q ? !b.name.toLowerCase().includes(q) : b.group !== group) continue;
    (cats[q ? GROUPS[b.group] : b.category] ??= []).push(b);
  }
  if (q && !Object.keys(cats).length) {
    $("palette").replaceChildren(el("p", { className: "empty-search" }, `Nothing matches "${raw}".`));
    return;
  }
  const sections = (!q && recent.length ? [["Recently used", recent.map(n => byName[n]), "recent"]] : [])
    .concat(Object.entries(cats).map(([c, items]) => [c, items, "grid"]));
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

// ---------- input ----------
const local = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

canvas.addEventListener("pointerdown", e => {
  const [px, py] = local(e);
  const c = cellAt(px, py);
  const under = itemAt(c.x, c.y, placed, byName);
  if (e.button === 1 || spaceHeld || (e.button === 0 && tool === "select" && !brush && !under)) {
    canvas.setPointerCapture(e.pointerId);
    gesture = { kind: "pan", px, py, tx: view.tx, ty: view.ty };
    return cursor();
  }
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  if (tool === "erase") {
    gesture = { kind: "erase" };
    beginStroke(); eraseAt(c);
  } else if (brush?.from) {
    // dropping a building being moved: one click, no row painting
    if (tryPlace(c)) { brush = null; markTiles(); endStroke(); }
    return;
  } else if (brush) {
    gesture = { kind: "paint", last: `${c.x},${c.y}` };
    beginStroke(); tryPlace(c);
  } else {
    beginStroke();
    placed.splice(placed.indexOf(under), 1);
    return setBrush({ name: under.name, r: under.r, from: under });
  }
  commit();
});

canvas.addEventListener("pointermove", e => {
  const [px, py] = local(e);
  const c = cellAt(px, py);
  const moved = !hover || hover.x !== c.x || hover.y !== c.y;
  hover = c;
  if (gesture?.kind === "pan") {
    userView = true;
    view.tx = gesture.tx + px - gesture.px;
    view.ty = gesture.ty + py - gesture.py;
    return requestDraw();
  }
  if (!moved) return;
  if (gesture?.kind === "paint") tryPlace(c);
  if (gesture?.kind === "erase") eraseAt(c);
  if (gesture) updateStats();
  updateInspector();
  requestDraw();
});

const endGesture = () => {
  if (!gesture) return;
  const kind = gesture.kind;
  gesture = null;
  if (kind !== "pan") endStroke();
  cursor();
};
canvas.addEventListener("pointerup", endGesture);
canvas.addEventListener("pointercancel", endGesture);
canvas.addEventListener("pointerleave", () => { if (!gesture) { hover = null; updateInspector(); requestDraw(); } });
canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  const c = cellAt(...local(e)), p = itemAt(c.x, c.y, placed, byName);
  if (p) { beginStroke(); placed.splice(placed.indexOf(p), 1); endStroke(); }
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  zoomAt(...local(e), Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0015))); // ctrlKey = trackpad pinch
}, { passive: false });

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
  if (e.target.closest?.("input, dialog")) return;
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
  else if (k === "escape") { dropHeld(); setBrush(null); }
  else if ((k === "delete" || k === "backspace") && hover) {
    const p = itemAt(hover.x, hover.y, placed, byName);
    if (p) { beginStroke(); placed.splice(placed.indexOf(p), 1); endStroke(); }
  }
});
document.addEventListener("keyup", e => { if (e.key === " ") { spaceHeld = false; cursor(); } });

function rotate() { if (brush) { brush.r = brush.r ? 0 : 1; updateInspector(); requestDraw(); } }
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
$("clear").onclick = () => {
  if (!placed.length) return;
  dropHeld(); beginStroke(); placed = []; endStroke();
  toast("Map cleared. Press Ctrl+Z to undo.");
};
$("share").onclick = async () => {
  commit();
  try { await navigator.clipboard.writeText(location.href); toast("Link copied. Anyone with it sees this layout."); }
  catch { toast("Couldn't reach the clipboard. Copy the address bar instead."); }
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
    toast("PNG saved.");
  });
};
$("search").oninput = renderPalette;
$("land").value = String(land);
$("land").onchange = e => setLand(+e.target.value);
if (!maxLand) $("land").closest("label").hidden = true;

new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  size = { w: width, h: height, dpr: devicePixelRatio || 1 };
  canvas.width = Math.round(width * size.dpr);
  canvas.height = Math.round(height * size.dpr);
  if (!userView) fit(); else requestDraw();
}).observe(canvas.parentElement);

renderPalette();
commit();
