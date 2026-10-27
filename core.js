// Pure layout logic, shared by the page (app.js) and the test (tools/test.mjs).

// Footprint of a placed item; r=1 means rotated 90°, which swaps w/h.
export function rect(p, b) {
  return p.r ? { x: p.x, y: p.y, w: b.h, h: b.w } : { x: p.x, y: p.y, w: b.w, h: b.h };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Can `cand` go down with every cell on buildable ground (`cells`: Set of "x,y") and nothing in the way?
export function fits(cand, placed, byName, cells) {
  const c = rect(cand, byName[cand.name]);
  for (let x = c.x; x < c.x + c.w; x++)
    for (let y = c.y; y < c.y + c.h; y++) if (!cells.has(`${x},${y}`)) return false;
  return !placed.some(p => overlaps(c, rect(p, byName[p.name])));
}

// Buildable cells with the first `land` Woolhaven expansions bought (the game sells them in order).
export function cellsFor(base, land) {
  const tiles = [base.tiles, ...(base.expansions ?? []).slice(0, land)].flat();
  return { tiles, cells: new Set(tiles.map(([x, y]) => `${x},${y}`)) };
}

export function itemAt(x, y, placed, byName) {
  return placed.findLast(p => overlaps({ x, y, w: 1, h: 1 }, rect(p, byName[p.name])));
}

// URL hash format: "land=2|Name:x.y.r,x.y.r|Other:x.y.r" (x/y may be negative; land
// only when expansions are bought) — keyed by name so it survives reordering of buildings.json.
export function encode(placed, land = 0) {
  const groups = {};
  for (const p of placed) (groups[p.name] ??= []).push(`${p.x}.${p.y}.${p.r ? 1 : 0}`);
  const parts = Object.entries(groups).map(([n, ps]) => `${encodeURIComponent(n)}:${ps.join(",")}`);
  return (land > 0 ? [`land=${land}`, ...parts] : parts).join("|");
}

// Returns { placed, land }; land is null when the hash doesn't say.
export function decode(hash, byName) {
  const placed = [];
  let land = null;
  for (const g of hash.replace(/^#/, "").split("|")) {
    const m = /^land=(\d)$/.exec(g);
    if (m) { land = +m[1]; continue; }
    const i = g.lastIndexOf(":");
    if (i < 0) continue;
    let name;
    try { name = decodeURIComponent(g.slice(0, i)); } catch { continue; }
    if (!byName[name]) continue; // building renamed/removed upstream: drop it rather than break the page
    for (const s of g.slice(i + 1).split(",")) {
      const [x, y, r] = s.split(".").map(Number);
      if (Number.isInteger(x) && Number.isInteger(y)) placed.push({ name, x, y, r: r === 1 ? 1 : 0 });
    }
  }
  return { placed, land };
}
