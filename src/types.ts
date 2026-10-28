// Shapes of the files in public/data/, as written by the tools in tools/.

import type { Base, Cell } from "./core.ts";

export interface BaseData extends Base {
  defaults?: { type: string; x: number; y: number }[];
  shrine?: { x: number; y: number }; // where the Shrine stands (grid units); it is off the grid and can't be moved
}

export interface MenuSection { id: string; term: string; types: string[] }
export interface MenuTab { id: string; term: string; sections: MenuSection[] }
export interface GameData {
  types: Record<string, { name: string | null; id: number; w: number; h: number; once?: boolean; fixed?: boolean }>; // id: the game's TYPES number
  wiki: Record<string, string>; // wiki name -> type
  chains: string[][]; // upgrade chains, first level first
  menu: MenuTab[];
  ranges?: Record<string, Range>;
  costs?: Record<string, [string, number][]>; // what building a type costs: [item type, quantity], as the game lists it
  upgrades?: Record<string, string>; // type -> the type it upgrades in place (building it costs that one's cost too)
}

/**
 * The area a building works in, as its in-game indicator shows it (tools/capture/ranges_to_data.py): a square
 * `size` cells across, centred `at` cells along the diagonal from the footprint's first cell.
 */
export interface Range { size: number; at: number }

/**
 * looks/<look>/<images[N]> is the backdrop with N land upgrades (w x h pixels at ppu, its top-left corner at
 * u0, v0 from the grid's origin): <images[N]>.small.webp while loading, then either one picture
 * (<images[N]>.avif, .webp without AVIF) or, with `tile`, cols x rows tiles <images[N]>/<col>_<row> of
 * size x size pixels with a border of their neighbours' pixels all round, also at ½ and ⅓ (@2, @3).
 * In the `lit` looks, lit-<images[N]> is the same backdrop graded as the game grades it inside lamp light.
 * tint[look] = [r, g, b, a] is laid over the screen.
 */
export interface Background {
  ppu: number; w: number; h: number; u0: number; v0: number;
  tile?: { size: number; border: number; cols: number; rows: number };
  images: string[]; looks?: string[]; lit?: string[]; tint?: Record<string, [number, number, number, number]>;
}

type Item = [number, number, number, number, number, number, number?];
/**
 * items[key] = [x, y, w, h, anchorX, anchorY, sheet?] in the atlas image <sheets[sheet ?? 0]>.avif (or .webp), and
 * divided by 2 or 3 in the same picture at ½ or ⅓ (<sheet>@2, @3); in
 * looks where lamps light the ground, <sheet>-lit has the same layout graded as inside lamp light. In sprites.json a
 * key is a type, in lights.json "mask:<type>" is the light a building casts (alpha = how lit) and "glow:<type>" its
 * additive light. `anim` lists the idle animations: frames[type] = [count, fps], box[type] = the part that moves
 * ([x0, y0, x1, y1] from the anchor, in the atlas's pixels), items["<type>#<i>"] that part of frame i (with a margin
 * of what stays still) in the sheet anim/<type> (and anim/<type>-lit), at anim.ppu.
 */
export interface Atlas {
  ppu: number; sheets: string[]; items: Record<string, Item>;
  anim?: { ppu: number; frames: Record<string, [number, number]>; box: Record<string, [number, number, number, number]>; items: Record<string, Item> };
}

/**
 * floors.json: per path or floor type, its rule tile as the game checks it. The first rule whose `need` holds
 * ([dx, dy, 1] that cell has the same floor, [dx, dy, 2] it hasn't) picks the tile: sprite `s` turned by matrix
 * `m`, or for a random rule the sprite and matrix `pick` lists for the cell (row by row, `w` wide from x0, y0).
 * No rule: sprite `default`. Each look's floors.json (an Atlas) has the tiles, keyed "<TYPE>.<s>.<m>".
 */
export interface FloorRule {
  need: [number, number, 1 | 2][]; m?: string; s?: number;
  pick?: { x0: number; y0: number; w: number; ms: string[]; s: number[]; m: number[] };
}
export type FloorRules = Record<string, { default: number; rules: FloorRule[] }>;

export interface WikiBuilding { name: string; icon?: string }

export interface Language { code: string; name: string; dir?: "rtl" | "ltr" }
export interface Strings {
  ui: Record<string, string>;
  terms: Record<string, string>;
  names: Record<string, string>;
  desc: Record<string, string>;
  items?: Record<string, string>; // item type (LOG, STONE, ...) -> name
}

export interface Building { type: string; w: number; h: number; once: boolean; fixed: boolean; icon?: string }

export type { Cell };
