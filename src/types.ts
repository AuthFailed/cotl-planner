// Shapes of the files in public/data/, as written by the tools in tools/.

import type { Base, Cell } from "./core.ts";

export interface BaseData extends Base {
  defaults?: { type: string; x: number; y: number }[];
}

export interface MenuSection { id: string; term: string; types: string[] }
export interface MenuTab { id: string; term: string; sections: MenuSection[] }
export interface GameData {
  types: Record<string, { name: string | null; id: number; w: number; h: number; once?: boolean; fixed?: boolean }>; // id: the game's TYPES number
  wiki: Record<string, string>; // wiki name -> type
  chains: string[][]; // upgrade chains, first level first
  menu: MenuTab[];
}

/** looks/<look>/<images[N]> is the backdrop with N land upgrades; tint[look] = [r, g, b, a] laid over the screen. */
export interface Background {
  ppu: number; w: number; h: number; u0: number; v0: number;
  images: string[]; looks?: string[]; tint?: Record<string, [number, number, number, number]>;
}

/** items[type] = [x, y, w, h, anchorX, anchorY] in the atlas image. */
export interface Atlas { ppu: number; items: Record<string, [number, number, number, number, number, number]> }

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
