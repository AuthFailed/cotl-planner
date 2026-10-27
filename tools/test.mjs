// Self-check for core.js: node tools/test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fits, itemAt, encode, decode } from "../core.js";

const byName = { "Farm Plot": { w: 1, h: 1 }, "Long: Thing": { w: 3, h: 1 } };
const placed = [{ name: "Long: Thing", x: 2, y: 2, r: 0 }];

assert.equal(fits({ name: "Farm Plot", x: 4, y: 2 }, placed, byName, 10, 10), false, "overlap");
assert.equal(fits({ name: "Farm Plot", x: 5, y: 2 }, placed, byName, 10, 10), true, "adjacent ok");
assert.equal(fits({ name: "Long: Thing", x: 8, y: 0 }, [], byName, 10, 10), false, "off grid");
assert.equal(fits({ name: "Long: Thing", x: 9, y: 0, r: 1 }, [], byName, 10, 10), true, "rotated fits");
assert.equal(itemAt(4, 2, placed, byName), placed[0]);
assert.equal(itemAt(4, 3, placed, byName), undefined);

const state = { w: 12, h: 8, placed: [...placed, { name: "Farm Plot", x: 0, y: 0, r: 0 }, { name: "Farm Plot", x: 1, y: 0, r: 0 }] };
assert.deepEqual(decode("#" + encode(state), byName), state, "hash round-trip");
assert.equal(decode("#garbage", byName), null);
assert.deepEqual(decode("#5,5|Gone:1.1.0", byName).placed, [], "unknown building dropped");

const data = JSON.parse(readFileSync(new URL("../data/buildings.json", import.meta.url)));
assert.ok(data.length > 100 && data.every(b => b.name && b.w > 0 && b.h > 0), "buildings.json sane");
console.log("ok");
