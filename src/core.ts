// Pure layout logic, shared by the page (app.ts) and the test (tools/test.mjs).

/** A building on the map; `name` is the game's structure type (BED, TEMPLE_II, ...). */
export interface Placed { name: string; x: number; y: number; r: 0 | 1 }
export interface Footprint { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type Cell = [number, number];
export interface Base { tiles: Cell[]; expansions?: Cell[][] }

// Footprint of a placed item; r=1 means rotated 90°, which swaps w/h.
export function rect(p: { x: number; y: number; r: 0 | 1 }, b: Footprint): Rect {
  return p.r ? { x: p.x, y: p.y, w: b.h, h: b.w } : { x: p.x, y: p.y, w: b.w, h: b.h };
}

export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Can `cand` go down with every cell on buildable ground (`cells`: Set of "x,y") and nothing in the way?
export function fits(cand: Placed, placed: Placed[], byName: Record<string, Footprint>, cells: Set<string>): boolean {
  const c = rect(cand, byName[cand.name]);
  for (let x = c.x; x < c.x + c.w; x++)
    for (let y = c.y; y < c.y + c.h; y++) if (!cells.has(`${x},${y}`)) return false;
  return !placed.some(p => overlaps(c, rect(p, byName[p.name])));
}

// Buildable cells with the first `land` Woolhaven expansions bought (the game sells them in order).
export function cellsFor(base: Base, land: number): { tiles: Cell[]; cells: Set<string> } {
  const tiles = [base.tiles, ...(base.expansions ?? []).slice(0, land)].flat();
  return { tiles, cells: new Set(tiles.map(([x, y]) => `${x},${y}`)) };
}

// The cells a range reaches: those whose centre is inside its square (`size` across, centred `at` cells along the
// diagonal from the building's first cell) or on its edge, as the game's box checks count them; buildings and
// plots stand at cell centres. Returns the first cell and how many cells across.
export function reach(p: { x: number; y: number }, a: { size: number; at: number }): { x: number; y: number; n: number } {
  const lo = (c: number) => Math.ceil(c + a.at - a.size / 2 - 1e-3) + 0, hi = (c: number) => Math.floor(c + a.at + a.size / 2 + 1e-3);
  return { x: lo(p.x), y: lo(p.y), n: hi(p.x) - lo(p.x) + 1 };
}

// The cells from a (exclusive) to b (inclusive), each sharing a side with the one before, so a fast drag
// paints a path that still joins up.
export function cellsBetween(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number }[] {
  const n = Math.abs(b.x - a.x) + Math.abs(b.y - a.y), out = [];
  let { x, y } = a;
  for (let i = 0; i < n; i++) {
    // step along whichever axis is further behind the straight line
    if (x !== b.x && (y === b.y || Math.abs((x - a.x + Math.sign(b.x - a.x)) * (b.y - a.y)) <= Math.abs((y - a.y + Math.sign(b.y - a.y)) * (b.x - a.x)))) x += Math.sign(b.x - a.x);
    else y += Math.sign(b.y - a.y);
    out.push({ x, y });
  }
  return out;
}

// Mirrors a group the way the game flips one building (swapping its footprint's sides): across the diagonal
// through `at` (default: the group's first corner).
export function flipGroup(ps: Placed[], at = { x: Math.min(...ps.map(p => p.x)), y: Math.min(...ps.map(p => p.y)) }): Placed[] {
  return ps.map(p => ({ ...p, x: at.x + p.y - at.y, y: at.y + p.x - at.x, r: p.r ? 0 : 1 }));
}

// The candidates that stay within each kind's limit (`limit` of its `key`) on top of what's placed.
export function withinLimits(cands: Placed[], placed: Placed[], key: (T: string) => string, limit: (T: string) => number): Placed[] {
  const n = new Map<string, number>();
  for (const p of placed) n.set(key(p.name), (n.get(key(p.name)) ?? 0) + 1);
  return cands.filter(p => { const k = key(p.name), m = (n.get(k) ?? 0) + 1; n.set(k, m); return m <= limit(p.name); });
}

export function itemAt(x: number, y: number, placed: Placed[], byName: Record<string, Footprint>): Placed | undefined {
  return placed.findLast(p => overlaps({ x, y, w: 1, h: 1 }, rect(p, byName[p.name])));
}

// URL hash format: "land=2|Name:x.y.r,x.y.r|Other:x.y.r" (x/y may be negative; land
// only when expansions are bought) — keyed by name so it survives reordering of the data.
export function encode(placed: Placed[], land = 0): string {
  const groups: Record<string, string[]> = {};
  for (const p of placed) (groups[p.name] ??= []).push(`${p.x}.${p.y}.${p.r ? 1 : 0}`);
  const parts = Object.entries(groups).map(([n, ps]) => `${encodeURIComponent(n)}:${ps.join(",")}`);
  return (land > 0 ? [`land=${land}`, ...parts] : parts).join("|");
}

// Returns { placed, land }; land is null when the hash doesn't say. Names `known` lacks are dropped.
export function decode(hash: string, known: Record<string, unknown>): { placed: Placed[]; land: number | null } {
  const placed: Placed[] = [];
  let land: number | null = null;
  for (const g of hash.replace(/^#/, "").split("|")) {
    const m = /^land=(\d)$/.exec(g);
    if (m) { land = +m[1]; continue; }
    const i = g.lastIndexOf(":");
    if (i < 0) continue;
    let name: string;
    try { name = decodeURIComponent(g.slice(0, i)); } catch { continue; }
    if (!known[name]) continue; // building renamed/removed upstream: drop it rather than break the page
    for (const s of g.slice(i + 1).split(",")) {
      const [x, y, r] = s.split(".").map(Number);
      if (Number.isInteger(x) && Number.isInteger(y)) placed.push({ name, x, y, r: r === 1 ? 1 : 0 });
    }
  }
  return { placed, land };
}
