/**
 * GPU color-pick id encoding — pure, DOM-free, so the round-trip and the tap →
 * framebuffer pixel maths are unit-testable. The seat instance index is offset
 * by +1 so id 0 is reserved for "no hit" (the cleared black background).
 */

/** instanceIndex → normalised RGB (0..1) the pick shader writes. */
export function encodePickId(instanceIndex: number): [number, number, number] {
  const id = instanceIndex + 1;
  return [(id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255];
}

/** RGB bytes (0..255) read back → instanceIndex, or -1 for the no-hit clear. */
export function decodePickRGB(r: number, g: number, b: number): number {
  const id = r + (g << 8) + (b << 16);
  return id === 0 ? -1 : id - 1;
}

/**
 * Scan a readback window (RGBA, bottom-left origin, row-major) for the seat hit
 * NEAREST the tap centre. A single tap on a low-res overview lands between ~2px
 * dots, so we read a small box and pick the closest non-empty seat instead of a
 * single pixel. `centerI/centerJ` are the tap's box-local pixel coords.
 * `maxIndex` bounds valid indices (defence against a stray decode).
 */
export function pickNearestFromBuffer(
  pixels: Uint8Array,
  boxW: number,
  boxH: number,
  centerI: number,
  centerJ: number,
  maxIndex: number,
): number {
  let best = -1;
  let bestDist = Infinity;
  for (let j = 0; j < boxH; j++) {
    for (let i = 0; i < boxW; i++) {
      const o = (j * boxW + i) * 4;
      const idx = decodePickRGB(pixels[o], pixels[o + 1], pixels[o + 2]);
      if (idx < 0 || idx >= maxIndex) continue;
      const di = i - centerI;
      const dj = j - centerJ;
      const d = di * di + dj * dj;
      if (d < bestDist) { bestDist = d; best = idx; }
    }
  }
  return best;
}

/**
 * Map a tap in CSS pixels (relative to the canvas bounding rect) to a
 * bottom-left-origin framebuffer pixel, clamped in range. `rect` is the canvas
 * getBoundingClientRect; `dpr` the renderer device-pixel-ratio.
 */
export function pickPixelCoords(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  dpr: number,
  bufferWidth: number,
  bufferHeight: number,
): { x: number; y: number } {
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const x = Math.round(cssX * dpr);
  // WebGL framebuffer origin is bottom-left → flip Y.
  const y = Math.round((rect.height - cssY) * dpr);
  return {
    x: Math.max(0, Math.min(bufferWidth - 1, x)),
    y: Math.max(0, Math.min(bufferHeight - 1, y)),
  };
}
