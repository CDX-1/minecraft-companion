import https from 'https';
import { PNG } from 'pngjs';

export const SKIN_USERNAMES = ['sweetily', 'tscn', 'candoir', 'utet'] as const;
export type SkinUsername = (typeof SKIN_USERNAMES)[number];

/** Fetches the 100×100 head PNG from mc-heads.net and returns raw buffer. */
function fetchHeadBuffer(username: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const url = `https://mc-heads.net/avatar/${username}/100`;
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching skin for ${username}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Parses a PNG buffer and returns RGBA pixel rows. */
function parsePng(buffer: Buffer): Promise<{ width: number; height: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    new PNG().parse(buffer, (err, png) => {
      if (err) reject(err);
      else resolve({ width: png.width, height: png.height, data: png.data });
    });
  });
}

/** Returns an ANSI 24-bit foreground color escape. */
function fg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Returns an ANSI 24-bit background color escape. */
function bg(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

const RESET = '\x1b[0m';

/**
 * Renders a PNG as Unicode half-block art (▀).
 * Each character represents 2 vertical pixels: top pixel = fg, bottom = bg.
 * The image is scaled to `targetWidth` terminal columns.
 */
function renderAsHalfBlocks(
  png: { width: number; height: number; data: Buffer },
  targetWidth: number,
): string {
  const { width, height, data } = png;

  // Scale so the output is targetWidth chars wide.
  const scaleX = width / targetWidth;
  // Terminal chars are ~2:1 tall, so scale Y accordingly.
  const targetHeight = Math.floor(height / scaleX / 2) * 2; // must be even
  const scaleY = height / targetHeight;

  function samplePixel(col: number, row: number): [number, number, number, number] {
    const srcX = Math.min(Math.floor(col * scaleX), width - 1);
    const srcY = Math.min(Math.floor(row * scaleY), height - 1);
    const idx = (srcY * width + srcX) * 4;
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  }

  const lines: string[] = [];
  for (let row = 0; row < targetHeight; row += 2) {
    let line = '';
    for (let col = 0; col < targetWidth; col++) {
      const [tr, tg, tb, ta] = samplePixel(col, row);
      const [br, bg2, bb, ba] = samplePixel(col, row + 1);

      if (ta < 128 && ba < 128) {
        // Both transparent — use a space with no color
        line += ' ';
      } else if (ta < 128) {
        // Top transparent: use space with bg color
        line += bg(br, bg2, bb) + ' ' + RESET;
      } else if (ba < 128) {
        // Bottom transparent: use ▀ with fg only
        line += fg(tr, tg, tb) + '▀' + RESET;
      } else {
        // Both opaque: ▀ with top=fg, bottom=bg
        line += fg(tr, tg, tb) + bg(br, bg2, bb) + '▀' + RESET;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Pre-fetched skin art cache keyed by username */
const cache = new Map<string, string>();

/**
 * Fetches and renders a skin head as half-block art for terminal display.
 * Results are cached so repeated calls are instant.
 *
 * @param username  One of the four skin usernames
 * @param width     Width in terminal columns (default: 20)
 */
export async function fetchSkinArt(username: string, width = 20): Promise<string> {
  const key = `${username}:${width}`;
  if (cache.has(key)) return cache.get(key)!;

  const buffer = await fetchHeadBuffer(username);
  const png = await parsePng(buffer);
  const art = renderAsHalfBlocks(png, width);
  cache.set(key, art);
  return art;
}

/** Pre-warms the cache for all four skins in parallel. */
export async function prefetchAllSkins(width = 20): Promise<void> {
  await Promise.allSettled(SKIN_USERNAMES.map((u) => fetchSkinArt(u, width)));
}
