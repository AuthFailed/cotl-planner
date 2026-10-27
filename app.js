import { rect, fits, itemAt, encode, decode } from "./core.js";

const CELL = 24;

const buildings = await (await fetch("data/buildings.json")).json();
const byName = Object.fromEntries(buildings.map(b => [b.name, b]));
const $ = id => document.getElementById(id);
const canvas = $("grid"), ctx = canvas.getContext("2d");

let state = decode(location.hash, byName) || { w: 30, h: 30, placed: [] };
let brush = null; // { name, r } while placing
let hover = null; // { x, y } cell under the pointer

// Stable per-category colour so a layout reads at a glance.
const color = name => {
  const c = byName[name].category;
  let h = 0;
  for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
};

function save() {
  history.replaceState(null, "", "#" + encode(state));
}

function draw() {
  canvas.width = state.w * CELL;
  canvas.height = state.h * CELL;
  ctx.fillStyle = "#2b1f1c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#3a2a27";
  ctx.beginPath();
  for (let x = 0; x <= state.w; x++) { ctx.moveTo(x * CELL + .5, 0); ctx.lineTo(x * CELL + .5, canvas.height); }
  for (let y = 0; y <= state.h; y++) { ctx.moveTo(0, y * CELL + .5); ctx.lineTo(canvas.width, y * CELL + .5); }
  ctx.stroke();
  for (const p of state.placed) block(p, color(p.name));
  if (brush && hover) {
    const ghost = { ...brush, ...hover };
    ctx.globalAlpha = .6;
    block(ghost, fits(ghost, state.placed, byName, state.w, state.h) ? "#6fae5a" : "#d33f3f");
    ctx.globalAlpha = 1;
  }
}

function block(p, fill) {
  const b = byName[p.name], r = rect(p, b);
  const [x, y, w, h] = [r.x * CELL, r.y * CELL, r.w * CELL, r.h * CELL];
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, w - 1, h - 1);
  ctx.strokeStyle = "#16100f";
  ctx.strokeRect(x + 1.5, y + 1.5, w - 2, h - 2);
  ctx.fillStyle = "#efe3cf";
  ctx.font = "10px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // ponytail: single-line label clipped to the footprint; 1x1 items get initials only.
  const label = r.w * r.h === 1 ? p.name.split(/\s+/).map(s => s[0]).join("").slice(0, 2) : p.name;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
}

function cellOf(e) {
  const b = canvas.getBoundingClientRect();
  return { x: Math.floor((e.clientX - b.left) / CELL), y: Math.floor((e.clientY - b.top) / CELL) };
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
    const cand = { ...brush, ...c };
    if (!fits(cand, state.placed, byName, state.w, state.h)) return;
    state.placed.push(cand);
    if (brush.moving) setBrush(null); // a moved building drops once; a palette pick keeps painting
    save();
  } else {
    const p = itemAt(c.x, c.y, state.placed, byName);
    if (!p) return;
    state.placed.splice(state.placed.indexOf(p), 1);
    setBrush({ name: p.name, r: p.r, moving: true });
  }
  draw();
});
canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  const c = cellOf(e), p = itemAt(c.x, c.y, state.placed, byName);
  if (p) { state.placed.splice(state.placed.indexOf(p), 1); save(); draw(); }
});

const rotate = () => { if (brush) { brush.r = brush.r ? 0 : 1; draw(); } };
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "r" || e.key === "R") rotate();
  if (e.key === "Escape") setBrush(null); // a building being moved is dropped, i.e. deleted
});
$("rotate").onclick = rotate;

for (const [id, k] of [["gw", "w"], ["gh", "h"]]) {
  $(id).value = state[k];
  $(id).onchange = () => {
    const v = Math.max(4, Math.min(200, Math.round(+$(id).value) || state[k]));
    $(id).value = state[k] = v;
    state.placed = state.placed.filter(p => fits(p, [], byName, state.w, state.h)); // drop what no longer fits
    save(); draw();
  };
}
$("clear").onclick = () => { if (confirm("Remove every building?")) { state.placed = []; save(); draw(); } };
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
