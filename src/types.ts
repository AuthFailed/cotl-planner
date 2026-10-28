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
}

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

export interface WikiBuilding { name: string; icon?: string }

export interface Language { code: string; name: string; dir?: "rtl" | "ltr" }
export interface Strings {
  ui: Record<string, string>;
  terms: Record<string, string>;
  names: Record<string, string>;
  desc: Record<string, string>;
}

export interface Building { type: string; w: number; h: number; once: boolean; fixed: boolean; icon?: string }

export type { Cell };
