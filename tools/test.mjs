// Self-check for src/core.ts: node tools/test.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fits, itemAt, encode, decode, cellsFor } from "../src/core.ts";

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

const layout = [...placed, { name: "Farm Plot", x: -1, y: 0, r: 0 }, { name: "Farm Plot", x: 1, y: -2, r: 0 }];
assert.deepEqual(decode("#" + encode(layout), byName), { placed: layout, land: null }, "hash round-trip");
assert.deepEqual(decode("#" + encode(layout, 2), byName), { placed: layout, land: 2 }, "land level round-trip");
assert.deepEqual(decode("#garbage", byName).placed, []);
assert.deepEqual(decode("#%E0%A4%A:1.1.0", byName).placed, [], "malformed escape ignored");
assert.deepEqual(decode("#Gone:1.1.0", byName).placed, [], "unknown building dropped");
const lands = { tiles: [[0, 0]], expansions: [[[0, -1]], [[-1, 0]], [[1, 0]]] };
assert.equal(cellsFor(lands, 0).cells.size, 1);
assert.ok(cellsFor(lands, 2).cells.has("-1,0") && !cellsFor(lands, 2).cells.has("1,0"), "expansions add in order");

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
assert.ok(Object.keys(atlas.items).every(t => game.types[t]), "atlas only holds known types");
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
// every look has its art, and a name in the page's strings
const bg = json("public/data/background.json");
assert.equal(bg.looks[0], "day", "day comes first: the palette's thumbnails use it");
for (const l of bg.looks) {
  for (const f of [...bg.images, "sprites.webp"]) readFileSync(new URL(`../public/data/looks/${l}/${f}`, import.meta.url));
  assert.ok(Object.keys(json(`public/data/looks/${l}/sprites.json`).items).every(T => game.types[T]), `${l}: atlas only holds known types`);
  assert.ok(en.ui[`look${l[0].toUpperCase()}${l.slice(1)}`], `${l}: has a name`);
}
console.log("ok");
