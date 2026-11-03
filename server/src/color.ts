import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export async function extractDominantColor(imagePathOrBuffer: string | Buffer): Promise<string> {
  const image = sharp(imagePathOrBuffer).resize(64, 64, { fit: 'inside' }).removeAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map<string, { count: number; r: number; g: number; b: number; score: number }>();

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const { h, s, l } = rgbToHsl(r, g, b);
    if (l > 0.88 || l < 0.12) continue;
    if (s < 0.18) continue;
    const key = `${Math.round(h * 24)}_${Math.round(s * 8)}_${Math.round(l * 8)}`;
    const score = s * (1 - Math.abs(l - 0.45));
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.r += r;
      existing.g += g;
      existing.b += b;
      existing.score += score;
    } else {
      buckets.set(key, { count: 1, r, g, b, score });
    }
  }

  let best = [...buckets.values()].sort((a, b) => b.score - a.score)[0];
  if (!best) {
    return '#1a468d';
  }
  const r = Math.round(best.r / best.count);
  const g = Math.round(best.g / best.count);
  const b = Math.round(best.b / best.count);
  const hsl = rgbToHsl(r, g, b);
  const darkened = hslToRgb(hsl.h, Math.min(1, hsl.s * 1.05), Math.min(0.42, hsl.l * 0.75));
  return toHex(darkened.r, darkened.g, darkened.b);
}

/** Resolve relative / host-local tvg-logo URLs against the ErsatzTV base URL. */
export function resolveLogoUrl(logoUrl: string, etvBaseUrl: string): string {
  const trimmed = logoUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const base = etvBaseUrl.endsWith('/') ? etvBaseUrl : `${etvBaseUrl}/`;
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

export function logoCacheFile(cachePath: string, channelNumber: string): string {
  return path.join(cachePath, 'logos', `${channelNumber}.png`);
}

export async function downloadLogo(url: string, destDir: string, key: string): Promise<string | undefined> {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${key}.png`);
    if (fs.existsSync(dest)) return dest;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      await sharp(buf).png().toFile(dest);
      return dest;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

export async function createLowerThirdBar(
  width: number,
  height: number,
  colorHex: string,
  destPath: string,
): Promise<string> {
  const hex = colorHex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / Math.max(1, width - 1);
      const alpha = Math.round(220 * (1 - Math.pow(t, 1.6)));
      const i = (y * width + x) * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = alpha;
    }
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(destPath);
  return destPath;
}
