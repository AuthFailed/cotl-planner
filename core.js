// Pure layout logic, shared by the page (app.js) and the test (tools/test.mjs).

// Footprint of a placed item; r=1 means rotated 90°, which swaps w/h.
export function rect(p, b) {
  return p.r ? { x: p.x, y: p.y, w: b.h, h: b.w } : { x: p.x, y: p.y, w: b.w, h: b.h };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Can `cand` go on a gridW x gridH grid without leaving it or hitting `placed`?
export function fits(cand, placed, byName, gridW, gridH) {
  const c = rect(cand, byName[cand.name]);
  if (c.x < 0 || c.y < 0 || c.x + c.w > gridW || c.y + c.h > gridH) return false;
  return !placed.some(p => overlaps(c, rect(p, byName[p.name])));
}

export function itemAt(x, y, placed, byName) {
  return placed.findLast(p => overlaps({ x, y, w: 1, h: 1 }, rect(p, byName[p.name])));
}

// URL hash format: "W,H|Name:x.y.r,x.y.r|Other:x.y.r" — keyed by name so it
// survives reordering of buildings.json.
export function encode(state) {
  const groups = {};
  for (const p of state.placed) (groups[p.name] ??= []).push(`${p.x}.${p.y}.${p.r ? 1 : 0}`);
  return [`${state.w},${state.h}`, ...Object.entries(groups).map(([n, ps]) => `${encodeURIComponent(n)}:${ps.join(",")}`)].join("|");
}

export function decode(hash, byName) {
  const [size, ...groups] = hash.replace(/^#/, "").split("|");
  const [w, h] = size.split(",").map(Number);
  if (!(w > 0 && h > 0)) return null;
  const placed = [];
  for (const g of groups) {
    const i = g.lastIndexOf(":");
    const name = decodeURIComponent(g.slice(0, i));
    if (!byName[name]) continue; // building renamed/removed upstream: drop it rather than break the page
    for (const s of g.slice(i + 1).split(",")) {
      const [x, y, r] = s.split(".").map(Number);
      if (Number.isInteger(x) && Number.isInteger(y)) placed.push({ name, x, y, r: r === 1 ? 1 : 0 });
    }
  }
  return { w, h, placed };
}
