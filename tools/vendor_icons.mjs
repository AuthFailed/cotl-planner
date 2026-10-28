// Copy the wiki icons the planner still shows (buildings with no game render) into
// public/data/icons/ as WebP and point buildings.json at them, so nothing loads from the wiki.
// 192px wide is plenty: the map draws a cell at most ~180 device pixels.
// Run after tools/scrape_wiki.py: node tools/vendor_icons.mjs  (needs cwebp)
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const data = new URL("../public/data/", import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, data)));
const game = read("game.json"), atlas = read("looks/day/sprites.json"), wiki = read("buildings.json");

// same type mapping as src/app.ts: menu chains, wiki entries matched by English name
const chainOf = {};
for (const chain of game.chains) for (const T of chain) chainOf[T] = chain;
const typeOf = new Map(wiki.map(b => [b, game.wiki[b.name]]));
const menu = new Set(game.menu.flatMap(tab => tab.sections.flatMap(s => s.types.flatMap(h => chainOf[h] ?? [h]))));

mkdirSync(new URL("icons/", data), { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "icons-"));
for (const b of wiki) {
  const T = typeOf.get(b);
  if (!b.icon?.startsWith("http")) continue;
  if (!T || !menu.has(T) || atlas.items[T]) { delete b.icon; continue; }
  const res = await fetch(b.icon, { headers: { "User-Agent": "cotl-planner" } });
  if (!res.ok) throw new Error(`${b.icon}: ${res.status}`);
  const src = join(tmp, "icon");
  writeFileSync(src, Buffer.from(await res.arrayBuffer()));
  execFileSync("cwebp", ["-quiet", "-q", "90", "-alpha_q", "100", "-resize", "192", "0", src, "-o", fileURLToPath(new URL(`icons/${T}.webp`, data))]);
  b.icon = `data/icons/${T}.webp`;
  console.error(T);
}
writeFileSync(new URL("buildings.json", data), JSON.stringify(wiki, null, 1) + "\n");
