// Self-check for src/core.ts: node tools/test.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fits, itemAt, encode, decode, cellsFor, reach, cellsBetween, flipGroup, withinLimits } from "../src/core.ts";
import { readSave } from "../src/save.ts";

const byName = { "Farm Plot": { w: 1, h: 1 }, "Long: Thing": { w: 3, h: 1 } };
const cells = new Set();
for (let x = -2; x < 8; x++) for (let y = -2; y < 8; y++) if (!(x === 5 && y === 5)) cells.add(`${x},${y}`);
const placed = [{ name: "Long: Thing", x: 2, y: 2, r: 0 }];

assert.equal(fits({ name: "Farm Plot", x: 4, y: 2 }, placed, byName, cells), false, "overlap");
assert.equal(fits({ name: "Farm Plot", x: 5, y: 2 }, placed, byName, cells), true, "adjacent ok");
assert.equal(fits({ name: "Long: Thing", x: 6, y: 0 }, [], byName, cells), false, "off the ground");
assert.equal(fits({ name: "Long: Thing", x: 4, y: 5 }, [], byName, cells), false, "over a hole");
assert.equal(fits({ name: "Long: Thing", x: -2, y: -2, r: 1 }, [], byName, cells), true, "rotated, negative coords");
assert.equal(itemAt(4, 2, placed, byName), placed[0]);
assert.equal(itemAt(4, 3, placed, byName), undefined);
assert.deepEqual(reach({ x: 0, y: 0 }, { size: 8, at: 0 }), { x: -4, y: -4, n: 9 }, "even range on one cell: the cells on its edge count");
assert.deepEqual(reach({ x: 2, y: 2 }, { size: 6, at: 0.49 }), { x: 0, y: 0, n: 6 }, "range around a 2x2 footprint");
const line = cellsBetween({ x: 0, y: 0 }, { x: 3, y: -2 });
assert.equal(line.length, 5, "a drag skipping cells fills them in");
assert.deepEqual(line.at(-1), { x: 3, y: -2 }, "ends where the pointer is");
assert.ok(line.every((c, i) => Math.abs(c.x - (line[i - 1] ?? { x: 0 }).x) + Math.abs(c.y - (line[i - 1] ?? { y: 0 }).y) === 1), "each cell shares a side with the last");
assert.deepEqual(cellsBetween({ x: 1, y: 1 }, { x: 1, y: 1 }), [], "no move, no cells");
assert.deepEqual(reach({ x: 0, y: 0 }, { size: 3, at: 0.6 }), { x: 0, y: 0, n: 3 }, "off-centre range");
const flipped = flipGroup([{ name: "Long: Thing", x: 2, y: 2, r: 0 }, { name: "Farm Plot", x: 5, y: 3, r: 0 }]);
assert.deepEqual(flipped, [{ name: "Long: Thing", x: 2, y: 2, r: 1 }, { name: "Farm Plot", x: 3, y: 5, r: 1 }], "group flips across its diagonal");
assert.ok(flipped.every(p => fits(p, flipped.filter(q => q !== p), byName, cells)), "a flipped group doesn't overlap itself");
assert.deepEqual(flipGroup(flipGroup(flipped)), flipped, "flipping twice is a no-op");
const once = T => (T === "Long: Thing" ? 1 : Infinity);
assert.deepEqual(withinLimits([{ name: "Long: Thing", x: 0, y: 0, r: 0 }, { name: "Farm Plot", x: 0, y: 1, r: 0 }], placed, T => T, once).map(p => p.name), ["Farm Plot"], "a one-per-base building already placed is left out");
assert.equal(withinLimits([{ name: "Long: Thing", x: 0, y: 0, r: 0 }, { name: "Long: Thing", x: 0, y: 1, r: 0 }], [], T => T, once).length, 1, "and only one of two pasted");

const layout = [...placed, { name: "Farm Plot", x: -1, y: 0, r: 0 }, { name: "Farm Plot", x: 1, y: -2, r: 0 }];
assert.deepEqual(decode("#" + encode(layout), byName), { placed: layout, land: null }, "hash round-trip");
assert.deepEqual(decode("#" + encode(layout, 2), byName), { placed: layout, land: 2 }, "land level round-trip");
assert.deepEqual(decode("#garbage", byName).placed, []);
assert.deepEqual(decode("#%E0%A4%A:1.1.0", byName).placed, [], "malformed escape ignored");
assert.deepEqual(decode("#Gone:1.1.0", byName).placed, [], "unknown building dropped");
const lands = { tiles: [[0, 0]], expansions: [[[0, -1]], [[-1, 0]], [[1, 0]]] };
assert.equal(cellsFor(lands, 0).cells.size, 1);
assert.ok(cellsFor(lands, 2).cells.has("-1,0") && !cellsFor(lands, 2).cells.has("1,0"), "expansions add in order");

// saves: encrypted ("E", key, IV, AES-CBC); MessagePack with LZ4 blocks, or JSON in older versions
async function encrypt(bytes) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), key = await crypto.subtle.importKey("raw", raw.slice(0, 16), "AES-CBC", false, ["encrypt"]);
  return new Uint8Array([0x45, ...raw, ...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: raw.slice(16) }, key, bytes))]);
}
const nils = n => Array(n).fill(0xc0);
// StructuresData as an array: Type 115 (TEMPLE) at [0], Location 1 (Base) at [30], GridTilePosition at [43], Direction -1 (flipped) at [51]
const temple = [0xdc, 0, 52, 115, ...nils(29), 1, ...nils(12), 0x92, 7, 14, ...nils(7), 0xff];
const away = [0xdc, 0, 52, 2, ...nils(29), 3, ...nils(12), 0x92, 0, 0, ...nils(7), 1]; // a bed in another location
// DataManager: LandPurchased 2 at [1013], BaseStructures at [1117]
const mp = [0xdc, 0x04, 0x5e, ...nils(1013), 2, ...nils(103), 0x92, ...temple, ...away];
// one LZ4 block of literals only (token 0xf0, then the length past 15 in 255s and a remainder)
const extra = mp.length - 15, lz4 = [0xf0, ...Array(Math.floor(extra / 255)).fill(255), extra % 255, ...mp];
const packed = [0x92, 0xc7, 3, 98, 0xcd, mp.length >> 8, mp.length & 255, 0xc5, lz4.length >> 8, lz4.length & 255, ...lz4];
assert.deepEqual(await readSave(await encrypt(new Uint8Array(packed))), { structures: [{ type: 115, x: 7, y: 14, flipped: true }], land: 2 }, "MessagePack save");
const oldSave = { BaseStructures: [{ Type: 115, Location: 1, GridTilePosition: { x: 7, y: 14 }, Direction: 1 }] };
assert.deepEqual(await readSave(await encrypt(new TextEncoder().encode(JSON.stringify(oldSave)))), { structures: [{ type: 115, x: 7, y: 14, flipped: false }], land: 0 }, "JSON save");
await assert.rejects(readSave(new Uint8Array([0x45, ...nils(60)])), "garbage is an error, not a crash");

const data = JSON.parse(readFileSync(new URL("../public/data/buildings.json", import.meta.url)));
assert.ok(data.length > 100 && data.every(b => b.name && b.w > 0 && b.h > 0), "buildings.json sane");
assert.ok(data.every(b => !b.icon || existsSync(new URL(`../public/${b.icon}`, import.meta.url))), "wiki icons are local files");
const base = JSON.parse(readFileSync(new URL("../public/data/base.json", import.meta.url)));
assert.ok(base.tiles.length > 1000 && base.tiles.some(([x, y]) => x === 0 && y === 0), "base.json sane");
assert.equal(base.expansions.length, 3, "three land expansions");
assert.equal(new Set(base.expansions.flat().concat(base.tiles).map(String)).size,
  base.tiles.length + base.expansions.flat().length, "expansion cells never repeat");
const game = JSON.parse(readFileSync(new URL("../public/data/game.json", import.meta.url)));
const atlas = JSON.parse(readFileSync(new URL("../public/data/looks/day/sprites.json", import.meta.url)));
assert.ok(Object.values(game.types).every(t => t.w > 0 && t.w === t.h), "game footprints are square and positive");
assert.ok(Object.values(game.wiki).every(t => game.types[t]), "every wiki match points at a known type");
assert.equal(new Set(Object.values(game.types).map(t => t.id)).size, Object.keys(game.types).length, "every type has its own save id");
// an atlas holds known types on its listed sheets, and every frame of each animated one ("<type>#<i>" in anim.items)
const sane = a => Object.keys(a.items).every(T => game.types[T]) && Object.values(a.items).every(it => (it[6] ?? 0) < a.sheets.length)
  && Object.entries(a.anim?.frames ?? {}).every(([T, [n, fps]]) => a.items[T] && a.anim.box[T] && fps > 0
    && Array.from({ length: n }, (_, i) => a.anim.items[`${T}#${i}`]).every(Boolean))
  && Object.keys(a.anim?.items ?? {}).every(k => +k.split("#")[1] < a.anim.frames[k.split("#")[0]]?.[0]);
assert.ok(sane(atlas), "atlas only holds known types on its sheets, and whole animations");
assert.ok(game.chains.every(c => c.length > 0) && Object.values(game.types).some(t => t.once), "build rules present");
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = path => JSON.parse(read(path));
const menuTypes = game.menu.flatMap(tab => tab.sections.flatMap(s => s.types));
assert.ok(menuTypes.every(T => game.types[T]), "the build menu only lists known types");
const en = json("public/data/i18n/en.json");
assert.ok(menuTypes.every(T => en.names[T] && en.desc[T]), "every build-menu building has an English name and description");
assert.ok(game.menu.flatMap(tab => [tab.term, ...tab.sections.map(s => s.term)]).every(k => en.terms[k]), "menu titles have text");
// every string key the page asks for exists
const used = [...read("index.html").matchAll(/data-i18n(?:-\w+)?="(\w+)"/g), ...read("src/app.ts").matchAll(/\bt\("(\w+)"/g)].map(m => m[1]);
assert.deepEqual(used.filter(k => !(k in en.ui)), [], "UI keys used by the page exist");
const vars = s => [...s.matchAll(/\{\w+\}/g)].map(m => m[0]).sort().join();
for (const { code } of json("public/data/i18n/index.json")) {
  const d = json(`public/data/i18n/${code}.json`);
  assert.deepEqual(Object.keys(d.ui).sort(), Object.keys(en.ui).sort(), `${code}: every planner string`);
  assert.ok(Object.entries(d.ui).every(([k, s]) => vars(s) === vars(en.ui[k])), `${code}: same {placeholders} as English`);
  assert.ok(Object.values(d.desc).every(s => !/[<>]/.test(s)), `${code}: descriptions are plain text`);
}
// every look has its art (every backdrop tile and sheet at full, ½ and ⅓ in AVIF, the ⅓ ones also in
// WebP for browsers without AVIF, and the small backdrops), and a name in the page's strings
const bg = json("public/data/background.json");
const floorRules = json("public/data/floors.json");
assert.ok(Object.keys(floorRules).every(T => game.types[T]), "floor rules for known types");
assert.ok(Object.values(floorRules).every(f => f.rules.every(r => r.need.every(([dx, dy, c]) => Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (c === 1 || c === 2)))),
  "floor rules look at the 8 neighbours");
assert.equal(bg.looks[0], "day", "day comes first: the palette's thumbnails use it");
assert.ok(!bg.tile || bg.tile.cols * bg.tile.size >= bg.w && bg.tile.rows * bg.tile.size >= bg.h, "backdrop tiles cover the backdrop");
for (const l of bg.looks) {
  const a = json(`public/data/looks/${l}/sprites.json`), lit = bg.lit?.includes(l);
  assert.ok(sane(a), `${l}: atlas only holds known types on its sheets, and whole animations`);
  const lights = existsSync(new URL(`../public/data/looks/${l}/lights.json`, import.meta.url)) ? json(`public/data/looks/${l}/lights.json`) : null;
  if (lights) assert.ok(Object.keys(lights.items).every(k => /^(mask|glow):/.test(k) && game.types[k.slice(5)]), `${l}: lights of known types`);
  assert.ok(en.ui[`look${l[0].toUpperCase()}${l.slice(1)}`], `${l}: has a name`);
  // every tile a floor's rules can put down (each sprite and turn they name, and the default), drawn in this look
  const floors = json(`public/data/looks/${l}/floors.json`);
  const picks = Object.entries(floorRules).flatMap(([T, f]) => [...(f.default < 0 ? [] : [`${T}.${f.default}.1,0,0,1`]), ...f.rules.flatMap(r => r.pick
    ? r.pick.s.map((s, i) => `${T}.${s}.${r.pick.ms[r.pick.m[i]]}`) : [`${T}.${r.s}.${r.m}`])]);
  assert.deepEqual([...new Set(picks.filter(k => !floors.items[k]))], [], `${l}: every floor tile`);
  const sheets = [...a.sheets, ...floors.sheets, ...Object.keys(a.anim?.frames ?? {}).map(T => `anim/${T}`)];
  const lightSheets = lights ? [...new Set(Object.keys(lights.items).map(k => `lights/${k.slice(5)}`))] : [];
  const tiles = bg.tile ? bg.images.flatMap(b => Array.from({ length: bg.tile.cols * bg.tile.rows }, (_, i) => `${b}/${i % bg.tile.cols}_${i / bg.tile.cols | 0}`)) : bg.images;
  const pictures = [...sheets, ...lightSheets, ...tiles, ...(lit ? [...sheets.map(s => `${s}-lit`), ...tiles.map(t => `lit-${t}`)] : [])];
  for (const f of [...bg.images.map(b => `${b}.small.webp`), ...pictures.flatMap(p => [`${p}.avif`, `${p}@2.avif`, `${p}@3.avif`, `${p}@3.webp`])])
    assert.ok(existsSync(new URL(`../public/data/looks/${l}/${f}`, import.meta.url)), `${l}: ${f}`);
}

// every icon the page names is in the subset fonts (uv run --with fonttools --with brotli tools/subset_icons.py)
const iconCss = readFileSync(new URL("../src/icons/icons.css", import.meta.url), "utf8");
const pageSources = ["../index.html", "../src/app.ts", "../src/core.ts", "../src/save.ts", "../src/types.ts"].map(f => readFileSync(new URL(f, import.meta.url), "utf8"));
for (const name of new Set(pageSources.join("\n").match(/\bph-[a-z0-9-]+/g)))
  if (name !== "ph-fill") assert.ok(iconCss.includes(`.ph.${name}:before`) && iconCss.includes(`.ph-fill.${name}:before`), `icon ${name} missing: rerun tools/subset_icons.py`);
console.log("ok");
