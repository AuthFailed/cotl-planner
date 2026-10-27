// Self-check for core.js: node tools/test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fits, itemAt, encode, decode } from "../core.js";

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
assert.deepEqual(decode("#" + encode(layout), byName), layout, "hash round-trip");
assert.deepEqual(decode("#garbage", byName), []);
assert.deepEqual(decode("#%E0%A4%A:1.1.0", byName), [], "malformed escape ignored");
assert.deepEqual(decode("#Gone:1.1.0", byName), [], "unknown building dropped");

const data = JSON.parse(readFileSync(new URL("../data/buildings.json", import.meta.url)));
assert.ok(data.length > 100 && data.every(b => b.name && b.w > 0 && b.h > 0), "buildings.json sane");
const base = JSON.parse(readFileSync(new URL("../data/base.json", import.meta.url)));
assert.ok(base.tiles.length > 1000 && base.tiles.some(([x, y]) => x === 0 && y === 0), "base.json sane");
const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const atlas = JSON.parse(readFileSync(new URL("../data/sprites.json", import.meta.url)));
assert.ok(Object.values(game.types).every(t => t.w > 0 && t.w === t.h), "game footprints are square and positive");
assert.ok(Object.values(game.wiki).every(t => game.types[t]), "every wiki match points at a known type");
assert.ok(Object.keys(atlas.items).every(t => game.types[t]?.sprite), "atlas only holds known types");
console.log("ok");
