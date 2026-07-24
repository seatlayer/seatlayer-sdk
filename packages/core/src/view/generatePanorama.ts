/**
 * Synthetic view-from-seat panorama, generated from chart geometry alone.
 *
 * Draws a 2048×1024 equirectangular texture of the hall as seen from THIS seat.
 * Everything is placed from geometry the viewer already carries — the seat's
 * position, its per-seat eye height (which already bakes in its section's
 * height + rake + row rise), and every other seat's position + eye height:
 *
 *   • the STAGE at the correct bearing/angular size, with a back wall +
 *     proscenium frame that shrink with distance;
 *   • the SURROUNDING STANDS — other sections drawn as darker raked banks
 *     rising to the pitch of their highest seat at their true bearing (upper
 *     tiers loom higher, a pit sits below the horizon), so the buyer senses the
 *     bowl wrapping around them;
 *   • a BALCONY-OVERHANG ceiling lip where a high, near section sits overhead;
 *   • a subtle open FLOOR / GA tone between the seat and the stage;
 *   • the AUDIENCE — nearby heads at their true bearing, rising behind and
 *     dropping in front with the rake, plus the seat-back rail of the row ahead.
 *
 * Used whenever the organizer hasn't uploaded a real photo/360 for the seat;
 * both go through the same viewer, and the designer preview reuses this exact
 * generator so authors see what buyers will.
 *
 * Height data drives the extra depth: a FLAT chart (no eye-height spread) draws
 * only the plain dark hall + stage + audience it always has — no raked masses,
 * no overhang, nothing invented from absent data.
 *
 * Equirectangular mapping: x = (yaw + 180°)/360° · W, y = (90° − pitch)/180° · H,
 * where yaw 0 = the direction the camera faces by default.
 */

import type { ExpandedSeat, Point } from '../core/types';
import { METRES_PER_CHART_UNIT, SEATED_EYE_HEIGHT_M } from '../core/units';
import { stageSightlinePitch } from './sightline';

const W = 2048;
const H = 1024;
/** Chart units → meters, for plausible eye-level proportions (seatSpacing 24 ≈ 0.55m). */
const UNIT = METRES_PER_CHART_UNIT;

const yawToX = (yawDeg: number) => ((yawDeg + 180) / 360) * W;
const pitchToY = (pitchDeg: number) => ((90 - pitchDeg) / 180) * H;

// --- surrounding-stands model ------------------------------------------------
// The buyer picker (SDK-owned, unmodifiable) hands us the full expanded seat
// list, not raw section outlines — so we reconstruct each OTHER section as a
// ring of yaw bins from its member seats. Each seat's `eyeHeightM` already
// encodes its section's height + rake + drawn row rise (see layout.assignEye-
// Heights), so the bank rises to exactly the pitch a real spectator would see.
// Deriving from seats (not outlines) is also what keeps the buyer and the
// designer preview pixel-identical: both feed the same expanded list in.

const NBINS = 96;
const BIN_DEG = 360 / NBINS;
/** Below this eye-height spread (m) the venue reads as flat: no raked banks, no
 *  overhang — the plain dark hall is the honest floor for a flat chart. */
const FLAT_DELTA_M = 0.6;
/** Mid sky tone the distance haze blends banks toward (matches the shell). */
const HAZE_SKY: [number, number, number] = [17, 23, 42];

function blendToSky(base: [number, number, number], t: number, a = 1): string {
  const k = Math.max(0, Math.min(0.72, t));
  const r = Math.round(base[0] + (HAZE_SKY[0] - base[0]) * k);
  const g = Math.round(base[1] + (HAZE_SKY[1] - base[1]) * k);
  const b = Math.round(base[2] + (HAZE_SKY[2] - base[2]) * k);
  return `rgba(${r},${g},${b},${a})`;
}

interface StandBin {
  /** Pitch (deg) to the highest seat's head in this bin — the bank crest. */
  top: number;
  /** Pitch (deg) to the section's seat surface — its front-edge base. */
  base: number;
  /** Nearest member distance (m) in this bin, for the distance haze. */
  nearM: number;
  /** A high, near mass overhead → hint a balcony ceiling lip. */
  overhead: boolean;
}

/**
 * Bin the OTHER sections' member seats by bearing into a surrounding ring.
 * Returns `maxDelta` (the largest eye-height difference seen) so the caller can
 * fall back to the flat hall when there is no real relief to draw.
 */
function buildStands(
  seat: ExpandedSeat,
  neighborSeats: ExpandedSeat[],
  stageBearing: number,
  myEyeM: number,
): { bins: (StandBin | null)[]; maxDelta: number } {
  const bins: (StandBin | null)[] = new Array(NBINS).fill(null);
  let maxDelta = 0;
  const own = seat.sectionId;
  for (const other of neighborSeats) {
    if (other.id === seat.id) continue;
    const os = other.sectionId;
    // Own section is the foreground crowd (drawn as heads + a seat-back rail);
    // seats with no section can't be attributed to a bank, so skip them.
    if (!os || (own && os === own)) continue;
    const ox = other.x - seat.x;
    const oy = other.y - seat.y;
    const dM = Math.hypot(ox, oy) * UNIT;
    if (dM < 1.5 || dM > 95) continue;
    const otherEye = other.eyeHeightM ?? SEATED_EYE_HEIGHT_M;
    const dTop = otherEye - myEyeM;
    if (Math.abs(dTop) > maxDelta) maxDelta = Math.abs(dTop);
    const top = (Math.atan2(dTop, dM) * 180) / Math.PI;
    const base = (Math.atan2(otherEye - SEATED_EYE_HEIGHT_M - myEyeM, dM) * 180) / Math.PI;
    const bearing = Math.atan2(ox, -oy) - stageBearing;
    const yaw = (((bearing * 180) / Math.PI + 540) % 360) - 180;
    const idx = Math.min(NBINS - 1, Math.max(0, Math.floor((yaw + 180) / BIN_DEG)));
    const overhead = top > 34 && dM < 16;
    const cur = bins[idx];
    if (!cur) bins[idx] = { top, base, nearM: dM, overhead };
    else {
      if (top > cur.top) cur.top = top;
      if (base < cur.base) cur.base = base;
      if (dM < cur.nearM) cur.nearM = dM;
      cur.overhead = cur.overhead || overhead;
    }
  }
  return { bins, maxDelta };
}

/**
 * Paint the binned banks: each is a dark raked mass from its crest down past the
 * horizon (so it reads solid, never floating), hazed by distance, with faint row
 * banding and — where a high near mass sits overhead — a balcony ceiling lip.
 */
function drawStands(
  ctx: CanvasRenderingContext2D,
  bins: (StandBin | null)[],
  toX: (yawDeg: number) => number,
  toY: (pitchDeg: number) => number,
): void {
  for (let i = 0; i < NBINS; i++) {
    const b = bins[i];
    if (!b) continue;
    const yaw0 = -180 + i * BIN_DEG;
    const x0 = toX(yaw0);
    const x1 = toX(yaw0 + BIN_DEG);
    if (!(x1 > x0)) continue; // equirect seam inside this bin → skip the sliver
    const top = Math.min(72, b.top);
    const bottom = Math.min(b.base, -4); // always reach just past the horizon
    const yTop = toY(top);
    const yBot = toY(bottom);
    if (yBot <= yTop) continue;
    const haze = b.nearM / 95;
    const grad = ctx.createLinearGradient(0, yTop, 0, yBot);
    grad.addColorStop(0, blendToSky([40, 49, 74], haze)); // lit seat-row crest
    grad.addColorStop(0.28, blendToSky([22, 28, 45], haze)); // seating
    grad.addColorStop(1, blendToSky([9, 12, 20], haze)); // facade into shadow
    ctx.fillStyle = grad;
    ctx.fillRect(x0, yTop, x1 - x0 + 1, yBot - yTop);
    // row banding on the seated portion (crest down to the horizon)
    const bandBottom = Math.min(yBot, toY(0));
    const bandSpan = bandBottom - yTop;
    if (bandSpan > 10) {
      ctx.fillStyle = `rgba(0,0,0,${0.1 * (1 - haze * 0.5)})`;
      for (let r = 1; r < 4; r++) ctx.fillRect(x0, yTop + (bandSpan * r) / 4, x1 - x0 + 1, 1.5);
    }
    // balcony overhang: a dark ceiling lip fading down onto the crest
    if (b.overhead) {
      const lipY = toY(Math.min(86, top + 12));
      const g2 = ctx.createLinearGradient(0, lipY, 0, yTop);
      g2.addColorStop(0, 'rgba(3,4,8,0.9)');
      g2.addColorStop(1, 'rgba(3,4,8,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(x0, lipY, x1 - x0 + 1, yTop - lipY);
      ctx.fillStyle = 'rgba(120,130,160,0.14)'; // faint lit underside rim
      ctx.fillRect(x0, yTop - 1.5, x1 - x0 + 1, 1.5);
    }
  }
}

export interface PanoramaResult {
  url: string;
  /** Meters from the stage, for the caption. */
  distanceM: number;
}

export function generateSeatPanorama(
  seat: ExpandedSeat,
  focalPoint: Point,
  neighborSeats: ExpandedSeat[],
): PanoramaResult {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const dx = focalPoint.x - seat.x;
  const dy = focalPoint.y - seat.y;
  const distU = Math.hypot(dx, dy);
  const distM = Math.max(2, distU * UNIT);
  const eyeM = seat.eyeHeightM ?? SEATED_EYE_HEIGHT_M;

  // ---- room shell: ceiling → walls → floor -------------------------------
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#05070c');
  sky.addColorStop(0.42, '#11172a');
  sky.addColorStop(0.5, '#1a2238');
  sky.addColorStop(0.56, '#10141f');
  sky.addColorStop(1, '#07090f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Bearing of the stage in screen coords (-y is "up" the hall) — every
  // bearing-relative placement below rotates around this so yaw 0 faces it.
  const stageBearing = Math.atan2(dx, -dy);

  // ---- surrounding stands: other sections as raked banks -----------------
  // Only when the chart actually has height relief; a flat chart shows the
  // plain hall it always has (no masses invented from absent data).
  const stands = buildStands(seat, neighborSeats, stageBearing, eyeM);
  const hasRelief = stands.maxDelta >= FLAT_DELTA_M;
  if (hasRelief) drawStands(ctx, stands.bins, yawToX, pitchToY);

  // ---- open floor / GA tone between the seat and the stage ----------------
  // A subtle warmer patch on the floor toward the stage — a hint of the flat
  // standing/floor area, kept faint so a plain hall still reads as a plain hall.
  const floorGlow = ctx.createRadialGradient(W / 2, pitchToY(-22), 20, W / 2, pitchToY(-22), W * 0.42);
  floorGlow.addColorStop(0, 'rgba(34, 38, 52, 0.20)');
  floorGlow.addColorStop(1, 'rgba(34, 38, 52, 0)');
  ctx.fillStyle = floorGlow;
  ctx.fillRect(0, pitchToY(0), W, H - pitchToY(0));

  // ---- stage, centered at yaw 0 (the viewer opens facing it) -------------
  // Angular size from real proportions: stage ~8m wide, ~1m platform + 6m set.
  // Pitch is eye-height-aware (Phase B2): a raised/raked seat looks down at it.
  const stageHalfYaw = Math.min(80, (Math.atan2(4, distM) * 180) / Math.PI);
  const sightline = stageSightlinePitch(eyeM, distM);
  const stageTopPitch = Math.min(45, sightline.topPitch);
  const stageBasePitch = sightline.basePitch;

  const sx0 = yawToX(-stageHalfYaw);
  const sx1 = yawToX(stageHalfYaw);
  const sy0 = pitchToY(stageTopPitch);
  const sy1 = pitchToY(stageBasePitch);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;

  // glow behind the stage
  const glow = ctx.createRadialGradient(W / 2, (sy0 + sy1) / 2, 10, W / 2, (sy0 + sy1) / 2, sw * 1.1);
  glow.addColorStop(0, 'rgba(129, 140, 248, 0.5)');
  glow.addColorStop(0.5, 'rgba(99, 102, 241, 0.16)');
  glow.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sx0 - sw * 0.6, sy0 - sh * 1.2, sw * 2.2, sh * 3.4);

  // back wall behind the stage (wider + taller than the box; shrinks with the
  // stage, so it is implicitly distance-scaled)
  const wallTop = pitchToY(Math.min(48, stageTopPitch + 8));
  const wall = ctx.createLinearGradient(0, wallTop, 0, sy1);
  wall.addColorStop(0, '#0a0e18');
  wall.addColorStop(1, '#05070c');
  ctx.fillStyle = wall;
  ctx.fillRect(sx0 - sw * 0.18, wallTop, sw * 1.36, sy1 - wallTop);

  // stage box + lit backdrop
  ctx.fillStyle = '#242c44';
  ctx.fillRect(sx0, sy0, sw, sh);
  const backdrop = ctx.createLinearGradient(0, sy0, 0, sy1);
  backdrop.addColorStop(0, '#7c5cff');
  backdrop.addColorStop(0.5, '#e1447a');
  backdrop.addColorStop(1, '#f59e0b');
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = backdrop;
  const inset = sw * 0.06;
  ctx.fillRect(sx0 + inset, sy0 + sh * 0.12, sw - inset * 2, sh * 0.62);
  ctx.globalAlpha = 1;
  // stage lip
  ctx.fillStyle = '#0d1119';
  ctx.fillRect(sx0, sy1 - sh * 0.1, sw, sh * 0.1);

  // proscenium frame: two pillars + a top beam around the lit backdrop
  const frameW = sw * 0.05 + 2;
  ctx.fillStyle = '#04060b';
  ctx.fillRect(sx0 - frameW, wallTop, frameW, sy1 - wallTop);
  ctx.fillRect(sx1, wallTop, frameW, sy1 - wallTop);
  ctx.fillRect(sx0 - frameW, wallTop, sw + frameW * 2, (sy1 - wallTop) * 0.1);
  ctx.fillStyle = 'rgba(124, 140, 255, 0.1)'; // faint rim light on the inner edges
  ctx.fillRect(sx0 - 1.5, wallTop, 1.5, sy1 - wallTop);
  ctx.fillRect(sx1, wallTop, 1.5, sy1 - wallTop);

  // performer silhouettes, scaled by distance
  const performerH = sh * 0.45;
  ctx.fillStyle = 'rgba(8, 10, 16, 0.85)';
  for (const fx of [0.35, 0.5, 0.65]) {
    const px = sx0 + (sx1 - sx0) * fx;
    const py = sy1 - (sy1 - sy0) * 0.12;
    ctx.beginPath();
    ctx.arc(px, py - performerH * 0.82, performerH * 0.16, 0, Math.PI * 2); // head
    ctx.fill();
    ctx.fillRect(px - performerH * 0.14, py - performerH * 0.68, performerH * 0.28, performerH * 0.68); // body
  }

  // spotlight beams from above the stage
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#c7d2fe';
  for (const fx of [0.3, 0.5, 0.7]) {
    const bx = sx0 + (sx1 - sx0) * fx;
    ctx.beginPath();
    ctx.moveTo(bx - 8, pitchToY(Math.min(60, stageTopPitch + 25)));
    ctx.lineTo(bx - (sx1 - sx0) * 0.09, sy1);
    ctx.lineTo(bx + (sx1 - sx0) * 0.09, sy1);
    ctx.lineTo(bx + 8, pitchToY(Math.min(60, stageTopPitch + 25)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ---- rig lights along the ceiling all around ---------------------------
  ctx.fillStyle = 'rgba(199, 210, 254, 0.8)';
  for (let i = 0; i < 26; i++) {
    const x = (i / 26) * W;
    const y = pitchToY(55 + (i % 3) * 6);
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- audience: heads of nearby seats, at their true bearings -----------
  // Bearing relative to the stage direction so yaw 0 keeps facing the stage.
  // When the chart has relief, each head sits at the pitch its own eye height
  // implies — the row behind rises above you, the row in front drops below —
  // giving the "sitting in a crowd on a rake" depth cue. Flat charts keep the
  // legacy fixed −atan2(0.35) offset exactly (rise = 0), so they don't change.
  const own = seat.sectionId;
  let seatAhead = false; // an own-section seat between you and the stage?
  ctx.fillStyle = 'rgba(16, 20, 30, 0.95)';
  for (const other of neighborSeats) {
    if (other.id === seat.id) continue;
    const ox = other.x - seat.x;
    const oy = other.y - seat.y;
    const d = Math.hypot(ox, oy) * UNIT;
    if (own && other.sectionId === own && d < 3 && ox * dx + oy * dy > 0) seatAhead = true;
    if (d < 0.3 || d > 14) continue;
    const bearing = Math.atan2(ox, -oy) - stageBearing;
    const yaw = ((((bearing * 180) / Math.PI + 540) % 360) - 180);
    const rise = hasRelief ? (other.eyeHeightM ?? SEATED_EYE_HEIGHT_M) - eyeM : 0;
    const headPitch = (Math.atan2(rise - 0.35, d) * 180) / Math.PI; // heads ~eye level, rake-shifted
    const headR = Math.min(46, 260 / (d / UNIT / 24 + 1.2) / 4);
    const hx = yawToX(yaw);
    const hy = pitchToY(headPitch);
    ctx.beginPath();
    ctx.arc(hx, hy, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath(); // shoulders
    ctx.ellipse(hx, hy + headR * 1.4, headR * 1.7, headR * 0.9, 0, Math.PI, 0, true);
    ctx.fill();
  }

  // ---- foreground: the seat-back rail of the row right in front of you ----
  // Only drawn when there's actually a seat ahead (front-row seats face open
  // floor and get no rail) — an honest, geometry-gated depth anchor.
  if (seatAhead) {
    const railTop = pitchToY(-34);
    ctx.fillStyle = 'rgba(6, 8, 14, 0.92)';
    ctx.fillRect(0, railTop, W, H - railTop);
    ctx.fillStyle = 'rgba(24, 30, 46, 0.9)';
    const humps = 16;
    for (let i = 0; i < humps; i++) {
      const cx = ((i + 0.5) / humps) * W;
      ctx.beginPath();
      ctx.ellipse(cx, railTop + 6, (W / humps) * 0.42, 22, 0, Math.PI, 0, true);
      ctx.fill();
    }
  }

  // subtle vignette at the poles (hides equirect pinching)
  const poleFade = ctx.createLinearGradient(0, 0, 0, H);
  poleFade.addColorStop(0, 'rgba(0,0,0,0.85)');
  poleFade.addColorStop(0.12, 'rgba(0,0,0,0)');
  poleFade.addColorStop(0.88, 'rgba(0,0,0,0)');
  poleFade.addColorStop(1, 'rgba(0,0,0,0.85)');
  ctx.fillStyle = poleFade;
  ctx.fillRect(0, 0, W, H);

  return { url: canvas.toDataURL('image/jpeg', 0.82), distanceM: Math.round(distM) };
}

// ---------------------------------------------------------------------------
// Compact forward-view thumbnail — a cheap (480×270) rectilinear preview of
// what this seat faces, for inline display inside the buyer's confirm card.
// Unlike the full equirectangular panorama it maps a ~100°×60° forward field
// of view directly (no 360 squish), so it reads as a real POV at a glance and
// costs a fraction of the full render. Same geometry → the two stay consistent.
// ---------------------------------------------------------------------------

const TW = 480;
const TH = 270;
const HALF_HFOV = 50; // degrees left/right of the stage direction
const HALF_VFOV = 30; // degrees up/down of the horizon

const yawToTX = (yawDeg: number) => ((yawDeg + HALF_HFOV) / (2 * HALF_HFOV)) * TW;
const pitchToTY = (pitchDeg: number) => ((HALF_VFOV - pitchDeg) / (2 * HALF_VFOV)) * TH;

export function generateSeatThumb(seat: ExpandedSeat, focalPoint: Point, _neighborSeats?: ExpandedSeat[]): PanoramaResult {
  const canvas = document.createElement('canvas');
  canvas.width = TW;
  canvas.height = TH;
  const ctx = canvas.getContext('2d')!;

  const dx = focalPoint.x - seat.x;
  const dy = focalPoint.y - seat.y;
  const distM = Math.max(2, Math.hypot(dx, dy) * UNIT);

  // hall shell (ceiling → wall → floor), horizon at mid-height
  const sky = ctx.createLinearGradient(0, 0, 0, TH);
  sky.addColorStop(0, '#05070c');
  sky.addColorStop(0.44, '#141b30');
  sky.addColorStop(0.5, '#1b2440');
  sky.addColorStop(0.58, '#10141f');
  sky.addColorStop(1, '#070910');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, TW, TH);

  // stage geometry (identical formulas to the full panorama, eye-height-aware)
  const eyeM = seat.eyeHeightM ?? SEATED_EYE_HEIGHT_M;
  const sightline = stageSightlinePitch(eyeM, distM);
  const stageHalfYaw = Math.min(HALF_HFOV - 2, (Math.atan2(4, distM) * 180) / Math.PI);
  const stageTopPitch = Math.min(HALF_VFOV - 2, sightline.topPitch);
  const stageBasePitch = Math.max(-HALF_VFOV + 2, sightline.basePitch);
  const sx0 = yawToTX(-stageHalfYaw);
  const sx1 = yawToTX(stageHalfYaw);
  const sy0 = pitchToTY(stageTopPitch);
  const sy1 = pitchToTY(stageBasePitch);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;

  // glow
  const glow = ctx.createRadialGradient(TW / 2, (sy0 + sy1) / 2, 4, TW / 2, (sy0 + sy1) / 2, sw * 1.1);
  glow.addColorStop(0, 'rgba(129,140,248,0.5)');
  glow.addColorStop(0.5, 'rgba(99,102,241,0.15)');
  glow.addColorStop(1, 'rgba(99,102,241,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sx0 - sw * 0.6, sy0 - sh * 1.2, sw * 2.2, sh * 3.4);

  // stage box + lit backdrop + lip
  ctx.fillStyle = '#242c44';
  ctx.fillRect(sx0, sy0, sw, sh);
  const backdrop = ctx.createLinearGradient(0, sy0, 0, sy1);
  backdrop.addColorStop(0, '#7c5cff');
  backdrop.addColorStop(0.5, '#e1447a');
  backdrop.addColorStop(1, '#f59e0b');
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = backdrop;
  const inset = sw * 0.06;
  ctx.fillRect(sx0 + inset, sy0 + sh * 0.12, sw - inset * 2, sh * 0.62);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0d1119';
  ctx.fillRect(sx0, sy1 - sh * 0.1, sw, sh * 0.1);

  // performer silhouettes
  const ph = sh * 0.45;
  ctx.fillStyle = 'rgba(8,10,16,0.85)';
  for (const fx of [0.35, 0.5, 0.65]) {
    const px = sx0 + sw * fx;
    const py = sy1 - sh * 0.12;
    ctx.beginPath();
    ctx.arc(px, py - ph * 0.82, ph * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(px - ph * 0.14, py - ph * 0.68, ph * 0.28, ph * 0.68);
  }

  // spotlight beams
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#c7d2fe';
  for (const fx of [0.3, 0.5, 0.7]) {
    const bx = sx0 + sw * fx;
    ctx.beginPath();
    ctx.moveTo(bx - 5, pitchToTY(Math.min(HALF_VFOV, stageTopPitch + 18)));
    ctx.lineTo(bx - sw * 0.09, sy1);
    ctx.lineTo(bx + sw * 0.09, sy1);
    ctx.lineTo(bx + 5, pitchToTY(Math.min(HALF_VFOV, stageTopPitch + 18)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // a few rig lights across the ceiling
  ctx.fillStyle = 'rgba(199,210,254,0.75)';
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.arc(((i + 0.5) / 8) * TW, pitchToTY(HALF_VFOV - 4 - (i % 2) * 3), 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // seat-back rows in the foreground for depth
  ctx.fillStyle = 'rgba(10,13,20,0.9)';
  ctx.fillRect(0, TH - 26, TW, 26);
  ctx.fillStyle = 'rgba(30,37,54,0.9)';
  for (let i = 0; i < 9; i++) ctx.fillRect(i * (TW / 9) + 6, TH - 22, TW / 9 - 12, 14);

  return { url: canvas.toDataURL('image/jpeg', 0.8), distanceM: Math.round(distM) };
}
