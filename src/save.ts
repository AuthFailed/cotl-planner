// Reads a Cult of the Lamb save (saves/slot_N.json or slot_N.mp) in the browser, shared with the test.
// Both are encrypted: "E", a 16-byte AES key, a 16-byte IV, then AES-128-CBC. Inside, older saves
// are JSON (fields by name); newer ones are MessagePack-CSharp, LZ4-compressed, each object an array
// indexed by its [Key(n)] numbers (DataManager, StructuresData in the game's Assembly-CSharp).

/** A structure in the base: the game's TYPES number, its first cell, and whether it's mirrored. */
export interface SavedStructure { type: number; x: number; y: number; flipped: boolean }
export interface SavedBase { structures: SavedStructure[]; land: number }

// MessagePack keys (game version 1.5): DataManager.BaseStructures / LandPurchased,
// StructuresData.Type / Location / GridTilePosition / Direction.
const MP = { base: 1117, land: 1013, type: 0, location: 30, cell: 43, direction: 51 };
const BASE_LOCATION = 1; // FollowerLocation.Base

export async function readSave(file: Uint8Array): Promise<SavedBase> {
  const bytes = file[0] === 0x45 /* E */ ? await decrypt(file) : file;
  const json = bytes[0] === 0x7b; /* { */
  const data = json ? JSON.parse(new TextDecoder().decode(bytes)) : unpack(bytes);
  const list: unknown = json ? data?.BaseStructures : data?.[MP.base];
  if (!Array.isArray(list)) throw new Error("no base structures in this file");
  const structures: SavedStructure[] = [];
  for (const s of list) {
    const location = json ? s?.Location : s?.[MP.location];
    if (location !== undefined && location !== BASE_LOCATION) continue;
    const type = json ? s?.Type : s?.[MP.type], cell = json ? s?.GridTilePosition : s?.[MP.cell];
    const x = json ? cell?.x : cell?.[0], y = json ? cell?.y : cell?.[1];
    const dir = json ? s?.Direction : s?.[MP.direction];
    if (typeof type === "number" && Number.isInteger(x) && Number.isInteger(y)) structures.push({ type, x, y, flipped: dir === -1 });
  }
  const land = json ? data?.LandPurchased : data?.[MP.land];
  return { structures, land: Number.isInteger(land) ? land : 0 };
}

async function decrypt(file: Uint8Array): Promise<Uint8Array> {
  if (file.length < 49) throw new Error("file too short");
  const key = await crypto.subtle.importKey("raw", file.slice(1, 17), "AES-CBC", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: file.slice(17, 33) }, key, file.slice(33)));
}

// ---------- MessagePack, with MessagePack-CSharp's LZ4 extensions ----------
// ext 98 (Lz4BlockArray): the first element of an array holds the blocks' uncompressed lengths, the
// rest are the LZ4 blocks; ext 99 (Lz4Block): an int32 length (big endian, as msgpack) then one block.
export function unpack(bytes: Uint8Array): unknown {
  const r = new Reader(bytes);
  const v = r.value();
  if (Array.isArray(v) && v[0] instanceof Ext && v[0].type === 98) {
    const lengths = new Reader(v[0].data).all();
    const out = new Uint8Array(lengths.reduce((a: number, n) => a + (n as number), 0));
    let at = 0;
    lengths.forEach((n, i) => { lz4(v[i + 1] as Uint8Array, out, at, at + (n as number)); at += n as number; });
    return unpack(out);
  }
  if (v instanceof Ext && v.type === 99) {
    const head = new Reader(v.data), n = head.value() as number, out = new Uint8Array(n);
    lz4(v.data.subarray(head.at), out, 0, n);
    return unpack(out);
  }
  return v;
}

class Ext {
  type: number; data: Uint8Array;
  constructor(type: number, data: Uint8Array) { this.type = type; this.data = data; }
}

class Reader {
  at = 0;
  b: Uint8Array; view: DataView;
  constructor(b: Uint8Array) { this.b = b; this.view = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  all() { const out = []; while (this.at < this.b.length) out.push(this.value()); return out; }
  take(n: number) { if (this.at + n > this.b.length) throw new Error("truncated save"); const s = this.b.subarray(this.at, this.at + n); this.at += n; return s; }
  u8() { return this.take(1)[0]; }
  num(get: (v: DataView, at: number) => number, n: number) { this.take(n); return get(this.view, this.at - n); }
  list(n: number) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.value(); return a; }
  map(n: number) { const m: Record<string, unknown> = {}; for (let i = 0; i < n; i++) { const k = this.value(); m[String(k)] = this.value(); } return m; }
  str(n: number) { return new TextDecoder().decode(this.take(n)); }
  ext(n: number) { const type = this.view.getInt8(this.at); this.at++; return new Ext(type, this.take(n)); }
  value(): unknown {
    const c = this.u8();
    if (c < 0x80) return c;
    if (c < 0x90) return this.map(c & 0xf);
    if (c < 0xa0) return this.list(c & 0xf);
    if (c < 0xc0) return this.str(c & 0x1f);
    if (c >= 0xe0) return c - 0x100;
    const u16 = () => this.num((v, a) => v.getUint16(a), 2), u32 = () => this.num((v, a) => v.getUint32(a), 4);
    switch (c) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.take(this.u8());
      case 0xc5: return this.take(u16());
      case 0xc6: return this.take(u32());
      case 0xc7: return this.ext(this.u8());
      case 0xc8: return this.ext(u16());
      case 0xc9: return this.ext(u32());
      case 0xca: return this.num((v, a) => v.getFloat32(a), 4);
      case 0xcb: return this.num((v, a) => v.getFloat64(a), 8);
      case 0xcc: return this.u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: return Number(this.num((v, a) => Number(v.getBigUint64(a)), 8));
      case 0xd0: return this.num((v, a) => v.getInt8(a), 1);
      case 0xd1: return this.num((v, a) => v.getInt16(a), 2);
      case 0xd2: return this.num((v, a) => v.getInt32(a), 4);
      case 0xd3: return this.num((v, a) => Number(v.getBigInt64(a)), 8);
      case 0xd4: return this.ext(1);
      case 0xd5: return this.ext(2);
      case 0xd6: return this.ext(4);
      case 0xd7: return this.ext(8);
      case 0xd8: return this.ext(16);
      case 0xd9: return this.str(this.u8());
      case 0xda: return this.str(u16());
      case 0xdb: return this.str(u32());
      case 0xdc: return this.list(u16());
      case 0xdd: return this.list(u32());
      case 0xde: return this.map(u16());
      case 0xdf: return this.map(u32());
    }
    throw new Error(`bad save data (0x${c.toString(16)})`);
  }
}

// LZ4 block format: sequences of literals then a back-reference, into out[at, end).
function lz4(src: Uint8Array, out: Uint8Array, at: number, end: number) {
  let i = 0;
  const len = (n: number) => { if (n === 15) { let b; do { b = src[i++]; n += b; } while (b === 255 && i < src.length); } return n; };
  while (i < src.length) {
    const token = src[i++];
    const lit = len(token >> 4);
    if (at + lit > end || i + lit > src.length) throw new Error("bad compressed block");
    out.set(src.subarray(i, i + lit), at);
    i += lit; at += lit;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    const n = len(token & 15) + 4;
    if (!offset || offset > at || at + n > end) throw new Error("bad compressed block");
    for (let k = 0; k < n; k++, at++) out[at] = out[at - offset];
  }
  if (at !== end) throw new Error("bad compressed block");
}
