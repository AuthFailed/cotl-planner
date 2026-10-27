// Shared canvas drawing for the compose pages: textures, sprite quads and SpriteShape fills,
// all in (u, v) world units mapped to pixels by the caller's OUT matrix.

export const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];

export async function loadTextures(names, log) {
  const tex = {};
  let done = 0;
  await Promise.all([...new Set(names)].map(n => new Promise(res => {
    const im = new Image();
    im.onload = () => { tex[n] = im; log?.(`textures ${++done}/${names.length}`); res(); };
    im.onerror = () => { log?.(`missing ${n}`); res(); };
    im.src = "/" + n.split("/").map(encodeURIComponent).join("/");
  })));
  return tex;
}

const tintCache = new Map();
function tinted(img, sx, sy, sw, sh, col) {
  const key = `${img.src}|${sx}|${sy}|${col}`;
  if (tintCache.has(key)) return tintCache.get(key);
  const t = Object.assign(document.createElement("canvas"), { width: Math.ceil(sw), height: Math.ceil(sh) });
  const x = t.getContext("2d");
  x.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  x.globalCompositeOperation = "multiply";
  x.fillStyle = `rgb(${col.slice(0, 3).map(v => Math.round(v * 255)).join(",")})`;
  x.fillRect(0, 0, sw, sh);
  x.globalCompositeOperation = "destination-in"; // keep the original alpha
  x.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  tintCache.set(key, t);
  return t;
}

// Returns true when something was drawn.
export function drawItem(g, it, sprites, tex, OUT) {
  if (it.shape) {
    // SpriteShape fill: polygon in local units, fill texture tiled at its pixels-per-unit
    const img = tex[it.fill];
    if (!img) return false;
    g.setTransform(...mul(OUT, it.aff));
    const pat = g.createPattern(img, "repeat");
    pat.setTransform(new DOMMatrix([1 / it.ppu, 0, 0, -1 / it.ppu, 0, 0]));
    g.beginPath();
    it.shape.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.globalAlpha = it.c[3];
    g.fillStyle = pat;
    g.fill();
    return true;
  }
  const sp = sprites[it.s], img = tex[sp.tex];
  if (!img) return false;
  const [tx, ty, tw, th] = sp.tr, [rw, rh] = sp.rect, [ox, oy] = sp.off, [pvx, pvy] = sp.pivot, ppu = sp.ppu;
  if (tw < 1 || th < 1) return false;
  const sx = tx, sy = img.naturalHeight - ty - th; // texture rects are measured from the bottom
  // source pixel (px, py) -> sprite-local units (x right, y up)
  let L = [1 / ppu, 0, 0, -1 / ppu, (ox - pvx * rw) / ppu, (oy - pvy * rh + th) / ppu];
  // atlas packing rotation: 1 flip H, 2 flip V, 3 rotate 180
  if (sp.rot === 1 || sp.rot === 3) L = mul(L, [-1, 0, 0, 1, tw, 0]);
  if (sp.rot === 2 || sp.rot === 3) L = mul(L, [1, 0, 0, -1, 0, th]);
  g.setTransform(...mul(OUT, mul(it.aff, L)));
  g.globalAlpha = it.c[3];
  const white = it.c[0] > .99 && it.c[1] > .99 && it.c[2] > .99;
  g.drawImage(white ? img : tinted(img, sx, sy, tw, th, it.c), ...(white ? [sx, sy, tw, th] : [0, 0, tw, th]), 0, 0, tw, th);
  return true;
}
