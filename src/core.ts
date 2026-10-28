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

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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
