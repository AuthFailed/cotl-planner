import { rect, fits, itemAt, encode, decode } from "./core.js";

const CELL = 16;
// The game rotates the base grid 45° on screen (see data/base.json "rotation"),
// so cells draw as diamonds: screen = K·(x − y, −(x + y)).
const K = CELL * Math.SQRT1_2;

const [buildings, base] = await Promise.all(["data/buildings.json", "data/base.json"].map(async u => (await fetch(u)).json()));
const byName = Object.fromEntries(buildings.map(b => [b.name, b]));
const cells = new Set(base.tiles.map(([x, y]) => `${x},${y}`));
const $ = id => document.getElementById(id);
const canvas = $("grid"), ctx = canvas.getContext("2d");

let placed = decode(location.hash, byName).filter(p => fits(p, [], byName, cells));
let brush = null; // { name, r } while placing
let hover = null; // { x, y } cell under the pointer

// Canvas size and origin: bounding box of every cell corner, plus padding for labels.
const PAD = 60;
const corners = base.tiles.flatMap(([x, y]) => [[x - .5, y - .5], [x + .5, y + .5], [x - .5, y + .5], [x + .5, y - .5]]);
const sx = corners.map(([x, y]) => K * (x - y)), sy = corners.map(([x, y]) => -K * (x + y));
const OX = PAD - Math.min(...sx), OY = PAD - Math.min(...sy);
canvas.width = Math.max(...sx) - Math.min(...sx) + 2 * PAD;
canvas.height = Math.max(...sy) - Math.min(...sy) + 2 * PAD;
const toScreen = (x, y) => [K * (x - y) + OX, -K * (x + y) + OY];
const gridSpace = () => ctx.setTransform(K, -K, -K, -K, OX, OY); // grid units in, screen pixels out

// Stable per-category colour so a layout reads at a glance.
const color = name => {
  const c = byName[name].category;
  let h = 0;
  for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
};

function save() {
  history.replaceState(null, "", "#" + encode(placed));
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#16100f";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  gridSpace();
  ctx.fillStyle = "#4f6b3a";
  ctx.strokeStyle = "#3d5530";
  ctx.lineWidth = 1 / CELL;
  for (const [x, y] of base.tiles) { ctx.fillRect(x - .5, y - .5, 1, 1); ctx.strokeRect(x - .5, y - .5, 1, 1); }
  for (const p of placed) block(p, color(p.name));
  if (brush && hover) {
    const ghost = anchored(hover);
    ctx.globalAlpha = .6;
    block(ghost, fits(ghost, placed, byName, cells) ? "#6fae5a" : "#d33f3f");
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = "bold 11px system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const l of base.landmarks) {
    const [px, py] = toScreen(l.x, l.y);
    ctx.fillStyle = "#d33f3f";
    ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
    ctx.fillStyle = "#efe3cf";
    ctx.fillText(l.name, px + 8, py);
  }
}

// The brush footprint is centred on the hovered cell.
function anchored(c) {
  const r = rect({ ...brush, x: 0, y: 0 }, byName[brush.name]);
  return { ...brush, x: c.x - Math.floor((r.w - 1) / 2), y: c.y - Math.floor((r.h - 1) / 2) };
}

function block(p, fill) {
  const r = rect(p, byName[p.name]);
  gridSpace();
  ctx.fillStyle = fill;
  ctx.fillRect(r.x - .5, r.y - .5, r.w, r.h);
  ctx.strokeStyle = "#16100f";
  ctx.lineWidth = 2 / CELL;
  ctx.strokeRect(r.x - .45, r.y - .45, r.w - .1, r.h - .1);
  // ponytail: single-line label at the footprint centre; 1x1 items get initials only.
  const label = r.w * r.h === 1 ? p.name.split(/\s+/).map(s => s[0]).join("").slice(0, 2) : p.name;
  const [px, py] = toScreen(r.x - .5 + r.w / 2, r.y - .5 + r.h / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#efe3cf";
  ctx.font = "10px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, px, py, K * 1.4 * Math.min(r.w, r.h));
  gridSpace();
}

function cellOf(e) {
  const b = canvas.getBoundingClientRect();
  const X = (e.clientX - b.left - OX) / K, Y = (e.clientY - b.top - OY) / K; // X = x − y, Y = −(x + y)
  return { x: Math.round((X - Y) / 2), y: Math.round((-X - Y) / 2) };
}

function setBrush(b) {
  brush = b;
  document.querySelectorAll(".item").forEach(el => el.classList.toggle("active", el.dataset.name === brush?.name));
  draw();
}

canvas.addEventListener("pointermove", e => { hover = cellOf(e); if (brush) draw(); });
canvas.addEventListener("pointerleave", () => { hover = null; draw(); });
canvas.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  const c = cellOf(e);
  if (brush) {
    const cand = anchored(c);
    if (!fits(cand, placed, byName, cells)) return;
    placed.push(cand);
    if (brush.moving) setBrush(null); // a moved building drops once; a palette pick keeps painting
    save();
  } else {
    const p = itemAt(c.x, c.y, placed, byName);
    if (!p) return;
    placed.splice(placed.indexOf(p), 1);
    setBrush({ name: p.name, r: p.r, moving: true });
  }
  draw();
});
canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  const c = cellOf(e), p = itemAt(c.x, c.y, placed, byName);
  if (p) { placed.splice(placed.indexOf(p), 1); save(); draw(); }
});

const rotate = () => { if (brush) { brush.r = brush.r ? 0 : 1; draw(); } };
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "r" || e.key === "R") rotate();
  if (e.key === "Escape") setBrush(null); // a building being moved is dropped, i.e. deleted
});
$("rotate").onclick = rotate;

$("clear").onclick = () => { if (confirm("Remove every building?")) { placed = []; save(); draw(); } };
$("share").onclick = async () => {
  save();
  await navigator.clipboard.writeText(location.href);
  $("share").textContent = "Copied!";
  setTimeout(() => ($("share").textContent = "Copy link"), 1500);
};
$("png").onclick = () => {
  const b = brush; brush = null; draw(); brush = b;
  canvas.toBlob(blob => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "cult-layout.png" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
};

// Palette: group > category > items, filtered by search.
function renderList(q = "") {
  const tree = {};
  for (const b of buildings) {
    if (q && !b.name.toLowerCase().includes(q)) continue;
    ((tree[b.group] ??= {})[b.category] ??= []).push(b);
  }
  $("list").replaceChildren(...Object.entries(tree).map(([g, cats]) => {
    const d = el("details", { open: !!q }, el("summary", {}, g));
    for (const [c, items] of Object.entries(cats)) {
      const dc = el("details", { open: !!q }, el("summary", {}, `${c} (${items.length})`));
      for (const b of items) {
        const btn = el("button", { className: "item", title: b.guess ? "Size not on the wiki yet — guessed 1×1" : b.name },
          // referrerPolicy/loading must be set before src: the wiki CDN refuses hotlinks that send a referrer
          el("img", { referrerPolicy: "no-referrer", loading: "lazy", src: b.icon || "", alt: "", onerror() { this.style.visibility = "hidden"; } }), b.name, el("small", {}, `${b.w}×${b.h}${b.guess ? "?" : ""}`));
        btn.dataset.name = b.name;
        btn.classList.toggle("active", brush?.name === b.name);
        btn.onclick = () => setBrush(brush?.name === b.name ? null : { name: b.name, r: 0 });
        dc.append(btn);
      }
      d.append(dc);
    }
    return d;
  }));
}
function el(tag, props, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}
$("search").oninput = e => renderList(e.target.value.trim().toLowerCase());

renderList();
draw();
