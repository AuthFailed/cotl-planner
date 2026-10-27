import { rect, fits, itemAt, encode, decode } from "./core.js";

// The game rotates the base grid 45° on screen (data/base.json "rotation"), so a cell
// (x, y) lands at K·(x − y, −(x + y)) before zoom and pan.
const K = Math.SQRT1_2;
const GROUPS = { "Follower buildings": "Followers", Faith: "Faith", Decorations: "Decor", Woolhaven: "Woolhaven" };
const MIN_S = 6, MAX_S = 90;

const $ = id => document.getElementById(id);
const canvas = $("map"), ctx = canvas.getContext("2d");

const [buildings, base] = await Promise.all(["data/buildings.json", "data/base.json"].map(async u => (await fetch(u)).json()));
const byName = Object.fromEntries(buildings.map(b => [b.name, b]));
const cells = new Set(base.tiles.map(([x, y]) => `${x},${y}`));

let placed = decode(location.hash, byName).filter(p => fits(p, [], byName, cells));
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
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let recent = store.get("recent", []).filter(n => byName[n]);
let showLabels = store.get("labels", false);

// ---------- geometry ----------
const corners = base.tiles.flatMap(([x, y]) => [[x - .5, y - .5], [x + .5, y + .5], [x - .5, y + .5], [x + .5, y - .5]]);
const isoX = corners.map(([x, y]) => K * (x - y)), isoY = corners.map(([x, y]) => -K * (x + y));
const BOUNDS = { x0: Math.min(...isoX), x1: Math.max(...isoX), y0: Math.min(...isoY), y1: Math.max(...isoY) };
const toScreen = (x, y, v = view) => [v.s * K * (x - y) + v.tx, -v.s * K * (x + y) + v.ty];
function cellAt(px, py) {
  const X = (px - view.tx) / (view.s * K), Y = (py - view.ty) / (view.s * K); // X = x − y, Y = −(x + y)
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

const gridSpace = (c, sz, v) => c.setTransform(sz.dpr * v.s * K, -sz.dpr * v.s * K, -sz.dpr * v.s * K, -sz.dpr * v.s * K, sz.dpr * v.tx, sz.dpr * v.ty);
const screenSpace = (c, sz) => c.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);

function draw(c, sz, v, live) {
  screenSpace(c, sz);
  c.fillStyle = "#141012";
  c.fillRect(0, 0, sz.w, sz.h);

  // ground
  gridSpace(c, sz, v);
  c.beginPath();
  for (const [x, y] of base.tiles) c.rect(x - .5, y - .5, 1, 1);
  c.fillStyle = "#3d4e33";
  c.fill();
  c.lineWidth = 1 / v.s;
  c.strokeStyle = "rgb(20 16 18 / .45)";
  c.stroke();

  const hovered = live && !brush && hover ? itemAt(hover.x, hover.y, placed, byName) : null;
  for (const p of placed) footprint(c, sz, v, p, p === hovered ? (tool === "erase" ? "erase" : "hover") : "normal");
  if (live && brush && hover) {
    const g = anchored(hover);
    footprint(c, sz, v, g, fits(g, placed, byName, cells) ? "ghost" : "blocked");
  }

  // landmarks
  screenSpace(c, sz);
  c.font = "600 12px 'Geist Variable', system-ui";
  c.textBaseline = "middle";
  const pins = base.landmarks.map(l => [l, ...toScreen(l.x, l.y, v)]);
  for (const [l, px, py] of pins) {
    c.fillStyle = "#c8423b";
    c.beginPath(); c.arc(px, py, 5, 0, Math.PI * 2); c.fill();
    c.lineWidth = 2; c.strokeStyle = "#141012"; c.stroke();
    // label to the left when another pin sits just to the right, so neighbours don't collide
    const crowded = pins.some(([o, ox, oy]) => o !== l && ox > px && ox - px < 120 && Math.abs(oy - py) < 16);
    c.textAlign = crowded ? "right" : "left";
    halo(c, l.name, px + (crowded ? -10 : 10), py);
  }
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
  c.fillStyle = { ghost: "rgb(143 179 108 / .55)", blocked: "rgb(200 66 59 / .55)", erase: "rgb(200 66 59 / .5)" }[mode] ?? `hsl(${hue} 30% 24% / .9)`;
  c.fillRect(r.x - .5, r.y - .5, r.w, r.h);
  c.lineWidth = (mode === "normal" ? 1.25 : 2) / v.s;
  c.strokeStyle = { ghost: "#b9d896", blocked: "#e06b63", erase: "#e06b63", hover: "#ede4d3" }[mode] ?? `hsl(${hue} 40% 52%)`;
  c.strokeRect(r.x - .5 + .5 / v.s, r.y - .5 + .5 / v.s, r.w - 1 / v.s, r.h - 1 / v.s);

  // upright icon at the footprint centre
  const [cx, cy] = toScreen(r.x - .5 + r.w / 2, r.y - .5 + r.h / 2, v);
  const px = v.s * Math.min(r.w, r.h) * .95;
  screenSpace(c, sz);
  if (mode === "ghost" || mode === "blocked") c.globalAlpha = .8;
  const img = icon(p.name);
  if (img) {
    const k = Math.min(px / img.naturalWidth, px / img.naturalHeight);
    c.drawImage(img, cx - img.naturalWidth * k / 2, cy - img.naturalHeight * k / 2, img.naturalWidth * k, img.naturalHeight * k);
  } else {
    c.font = `600 ${Math.max(8, px * .32)}px 'Geist Variable', system-ui`;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#ede4d3";
    c.fillText(initials(p.name), cx, cy);
  }
  c.globalAlpha = 1;
  if (showLabels && mode !== "ghost" && mode !== "blocked") {
    c.font = "500 11px 'Geist Variable', system-ui";
    c.textAlign = "center"; c.textBaseline = "top";
    halo(c, p.name, cx, cy + px / 2 + 2);
  }
}

// ---------- state changes ----------
function beginStroke() { strokeBefore ??= JSON.stringify(placed); }
function endStroke() {
  if (strokeBefore !== null && strokeBefore !== JSON.stringify(placed)) {
    undoStack.push(strokeBefore);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  strokeBefore = null;
  commit();
}
function commit() {
  history.replaceState(null, "", placed.length ? "#" + encode(placed) : location.pathname + location.search);
  $("undo").disabled = !undoStack.length;
  $("redo").disabled = !redoStack.length;
  $("hint").hidden = placed.length > 0 || !!brush;
  updateStats();
  updateInspector();
  requestDraw();
}
function undo() { if (!undoStack.length) return; dropHeld(); redoStack.push(JSON.stringify(placed)); placed = JSON.parse(undoStack.pop()); commit(); }
function redo() { if (!redoStack.length) return; dropHeld(); undoStack.push(JSON.stringify(placed)); placed = JSON.parse(redoStack.pop()); commit(); }

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

new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  size = { w: width, h: height, dpr: devicePixelRatio || 1 };
  canvas.width = Math.round(width * size.dpr);
  canvas.height = Math.round(height * size.dpr);
  if (!userView) fit(); else requestDraw();
}).observe(canvas.parentElement);

renderPalette();
commit();
