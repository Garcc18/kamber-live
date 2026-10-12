// Genera los iconos PNG de la PWA sin dependencias (zlib de Node + PNG mínimo).
// Uso: npm run icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [11, 14, 18];
const AMBER = [255, 176, 32];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Coordenadas normalizadas 0..1. `scale` < 1 reduce el dibujo (zona segura de los iconos maskable).
function shade(u, v, maskable, scale) {
  // Fondo: cuadrado redondeado (o lleno si es maskable)
  if (!maskable) {
    const r = 0.22, cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
    if (Math.hypot(u - cx, v - cy) > r) return null;
  }
  const x = 0.5 + (u - 0.5) / scale, y = 0.5 + (v - 0.5) / scale;
  // Anillo
  const d = Math.hypot(x - 0.5, y - 0.5);
  if (Math.abs(d - 0.38) < 0.03) return AMBER;
  // "K"
  const w = 0.055;
  if (segDist(x, y, 0.38, 0.27, 0.38, 0.73) < w) return AMBER;
  if (segDist(x, y, 0.42, 0.53, 0.65, 0.27) < w) return AMBER;
  if (segDist(x, y, 0.48, 0.47, 0.67, 0.73) < w) return AMBER;
  return BG;
}

function render(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, maskable, maskable ? 0.78 : 1);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
      }
      const n = ss * ss, i = (py * size + px) * 4, cov = a / 255;
      buf[i] = cov ? Math.round(r / cov) : 0;
      buf[i + 1] = cov ? Math.round(g / cov) : 0;
      buf[i + 2] = cov ? Math.round(b / cov) : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return png(size, buf);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', render(192, false));
writeFileSync('public/icons/icon-512.png', render(512, false));
writeFileSync('public/icons/icon-maskable-512.png', render(512, true));
console.log('Iconos generados en public/icons/');
