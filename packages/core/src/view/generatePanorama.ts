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

type RGB = [number, number, number];

function blendToSky(base: RGB, t: number, a = 1): string {
  // Distance haze: blend toward the sky, but keep more of the band's own colour
  // at distance than before (cap 0.58, was 0.72) so far stands stay legible
  // architecture rather than dissolving into flat silhouettes.
  const k = Math.max(0, Math.min(0.58, t));
  const r = Math.round(base[0] + (HAZE_SKY[0] - base[0]) * k);
  const g = Math.round(base[1] + (HAZE_SKY[1] - base[1]) * k);
  const b = Math.round(base[2] + (HAZE_SKY[2] - base[2]) * k);
  return `rgba(${r},${g},${b},${a})`;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * A stable, DESATURATED tint for a section from its category key. The panorama
 * has no access to the doc's category→colour map (its signature takes only
 * seats), so it derives a deterministic hue per category and mutes it hard —
 * same spirit as the 3D tier tinting in sceneModel.tintTop: enough to tell
 * adjacent sections apart as coloured architecture, never a saturated poster.
 */
const tintCache = new Map<string, RGB>();
function tintFromKey(key: string | undefined): RGB | null {
  if (!key) return null;
  const cached = tintCache.get(key);
  if (cached) return cached;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  const hue = (h >>> 0) % 360;
  const rgb = hslToRgb(hue, 0.3, 0.42);
  tintCache.set(key, rgb);
  return rgb;
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
  /** Desaturated section-colour hint (from the nearest member's category). */
  tint: RGB | null;
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
    if (!cur) bins[idx] = { top, base, nearM: dM, overhead, tint: tintFromKey(other.categoryKey) };
    else {
      if (top > cur.top) cur.top = top;
      if (base < cur.base) cur.base = base;
      // The nearest member drives the visible tint (it fills most of the bank).
      if (dM < cur.nearM) { cur.nearM = dM; cur.tint = tintFromKey(other.categoryKey); }
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
    // Fold the section's desaturated colour hint into the bank so the panorama
    // and the 3D view read as the same venue. Kept subtle (~0.34) and only on
    // the lit upper stops so the shadowed facade stays neutral.
    const tint = b.tint;
    const crest: RGB = tint ? mixRgb([44, 54, 80], tint, 0.34) : [44, 54, 80];
    const seating: RGB = tint ? mixRgb([24, 30, 48], tint, 0.28) : [24, 30, 48];
    const grad = ctx.createLinearGradient(0, yTop, 0, yBot);
    grad.addColorStop(0, blendToSky(crest, haze)); // lit seat-row crest
    grad.addColorStop(0.24, blendToSky(seating, haze)); // seating
    grad.addColorStop(1, blendToSky([10, 13, 22], haze)); // facade into shadow
    ctx.fillStyle = grad;
    ctx.fillRect(x0, yTop, x1 - x0 + 1, yBot - yTop);
    // crest edge: a faint lit rim so the bank top reads as a hard architectural
    // line even far away (distance no longer melts it into the sky).
    ctx.fillStyle = `rgba(150,165,205,${0.35 * (1 - haze * 0.55)})`;
    ctx.fillRect(x0, yTop, x1 - x0 + 1, 1.5);
    // tier-band striping on the seated portion (crest down to the horizon):
    // alternating lit/shadow rows so distant stands read as populated tiers, not
    // a flat wash. More bands + higher contrast than before.
    const bandBottom = Math.min(yBot, toY(0));
    const bandSpan = bandBottom - yTop;
    if (bandSpan > 8) {
      const bands = 6;
      const contrast = 1 - haze * 0.4;
      for (let r = 1; r < bands; r++) {
        const y = yTop + (bandSpan * r) / bands;
        ctx.fillStyle = `rgba(0,0,0,${0.16 * contrast})`; // seat-row shadow gap
        ctx.fillRect(x0, y, x1 - x0 + 1, 1.5);
        ctx.fillStyle = `rgba(120,134,170,${0.1 * contrast})`; // lit seat-back band
        ctx.fillRect(x0, y + 1.5, x1 - x0 + 1, 1.2);
      }
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
  // Floor stops are lifted off near-black to a dim hall grey-blue: no region of
  // the frame should read as pure void, so a far/upper seat lands in a room, not
  // a black pit. Ceiling stays dark for the premium-hall look.
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#080b12');
  sky.addColorStop(0.42, '#12182c');
  sky.addColorStop(0.5, '#1c2440');
  sky.addColorStop(0.56, '#151b2c');
  sky.addColorStop(0.78, '#171e30');
  sky.addColorStop(1, '#131829');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Ambient floor wash — a broad dim lift across the lower hall so foreground
  // floor reads as a lit surface receding into shadow, never a black plane.
  const floorAmb = ctx.createLinearGradient(0, pitchToY(-6), 0, H);
  floorAmb.addColorStop(0, 'rgba(30, 37, 56, 0)');
  floorAmb.addColorStop(0.55, 'rgba(30, 37, 56, 0.22)');
  floorAmb.addColorStop(1, 'rgba(22, 28, 44, 0.12)');
  ctx.fillStyle = floorAmb;
  ctx.fillRect(0, pitchToY(-6), W, H - pitchToY(-6));

  // Bearing of the stage in screen coords (-y is "up" the hall) — every
  // bearing-relative placement below rotates around this so yaw 0 faces it.
  const stageBearing = Math.atan2(dx, -dy);

  // ---- surrounding stands: other sections as raked banks -----------------
  // Only when the chart actually has height relief; a flat chart shows the
  // plain hall it always has (no masses invented from absent data).
  const stands = buildStands(seat, neighborSeats, stageBearing, eyeM);
  const hasRelief = stands.maxDelta >= FLAT_DELTA_M;
  if (hasRelief) drawStands(ctx, stands.bins, yawToX, pitchToY);

  // Distance drama factor: near seats get a strong warm spill (you feel the
  // footlights), far seats a gentler one — but the stage stays the clear focal
  // point at every distance. 1 at ~6 m, easing to ~0.3 by ~55 m.
  const nearGlow = Math.max(0.3, Math.min(1, 1 - (distM - 6) / 60));

  // ---- open floor / GA tone between the seat and the stage ----------------
  // Warm light spilling off the stage onto the floor/GA in front of it — the eye
  // lands on the stage. Warmer + stronger than the old neutral patch, and scaled
  // by distance so near seats get footlight drama without blowing out far ones.
  const floorGlow = ctx.createRadialGradient(W / 2, pitchToY(-16), 20, W / 2, pitchToY(-16), W * 0.5);
  floorGlow.addColorStop(0, `rgba(240, 176, 96, ${0.16 * nearGlow})`);
  floorGlow.addColorStop(0.5, `rgba(150, 120, 120, ${0.1 * nearGlow})`);
  floorGlow.addColorStop(1, 'rgba(40, 44, 60, 0)');
  ctx.fillStyle = floorGlow;
  ctx.fillRect(0, pitchToY(2), W, H - pitchToY(2));

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

  // glow behind the stage — a warm core inside the cool halo so the focal point
  // reads as lit, not just tinted. Radius widens a touch with distance so a far
  // stage still carries a visible bloom.
  const glowR = sw * (1.1 + (1 - nearGlow) * 0.5);
  const glow = ctx.createRadialGradient(W / 2, (sy0 + sy1) / 2, 8, W / 2, (sy0 + sy1) / 2, glowR);
  glow.addColorStop(0, 'rgba(255, 214, 150, 0.4)'); // warm footlight core
  glow.addColorStop(0.28, 'rgba(150, 150, 230, 0.34)');
  glow.addColorStop(0.6, 'rgba(99, 102, 241, 0.14)');
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
  for (const other of neighborSeats) {
    if (other.id === seat.id) continue;
    const ox = other.x - seat.x;
    const oy = other.y - seat.y;
    const d = Math.hypot(ox, oy) * UNIT;
    if (own && other.sectionId === own && d < 3 && ox * dx + oy * dy > 0) seatAhead = true;
    if (d < 0.3 || d > 16) continue;
    const bearing = Math.atan2(ox, -oy) - stageBearing;
    const yaw = ((((bearing * 180) / Math.PI + 540) % 360) - 180);
    const rise = hasRelief ? (other.eyeHeightM ?? SEATED_EYE_HEIGHT_M) - eyeM : 0;
    const headPitch = (Math.atan2(rise - 0.35, d) * 180) / Math.PI; // heads ~eye level, rake-shifted
    // Cheap per-seat variation from a hash of the id: heads differ in size and
    // tone so the near rows read as a real, varied crowd, not stamped clones.
    let hh = 0;
    for (let k = 0; k < other.id.length; k++) hh = (hh * 31 + other.id.charCodeAt(k)) & 0xffff;
    const jitter = 0.86 + (hh & 15) / 48; // ~0.86..1.17
    const headR = Math.min(46, (260 / (d / UNIT / 24 + 1.2) / 4)) * jitter;
    const hx = yawToX(yaw);
    const hy = pitchToY(headPitch);
    // Tone: dim blue-grey, lifted a little for near heads and jittered per head;
    // fades toward the hall with distance so far heads recede.
    const fade = Math.max(0.35, 1 - d / 20);
    const tone = 14 + ((hh >> 4) & 7) + Math.round((1 - d / 16) * 10);
    ctx.fillStyle = `rgba(${tone},${tone + 4},${tone + 12},${(0.9 * fade).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(hx, hy, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath(); // shoulders (slightly wide so near rows overlap into a crowd)
    ctx.ellipse(hx, hy + headR * 1.4, headR * 1.85, headR * 0.95, 0, Math.PI, 0, true);
    ctx.fill();
    // warm rim on the stage-facing top of near heads — footlights catching hair.
    if (d < 9) {
      ctx.fillStyle = `rgba(240, 200, 150, ${(0.16 * (1 - d / 9)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(hx, hy - headR * 0.25, headR * 0.82, Math.PI * 1.15, Math.PI * 1.85);
      ctx.fill();
    }
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
  poleFade.addColorStop(0.9, 'rgba(0,0,0,0)');
  // Softer at the nadir than the zenith: within the windowed pitch range the
  // floor stays a dim lit hall; only the extreme straight-down pole darkens.
  poleFade.addColorStop(1, 'rgba(0,0,0,0.55)');
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

  // hall shell (ceiling → wall → floor), horizon at mid-height. Floor lifted off
  // near-black to a dim hall grey-blue, matching the full panorama's ambient.
  const sky = ctx.createLinearGradient(0, 0, 0, TH);
  sky.addColorStop(0, '#080b12');
  sky.addColorStop(0.44, '#151c32');
  sky.addColorStop(0.5, '#1d2644');
  sky.addColorStop(0.58, '#161c2e');
  sky.addColorStop(1, '#131829');
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

  // glow — warm footlight core inside the cool halo, matching the full panorama.
  const glow = ctx.createRadialGradient(TW / 2, (sy0 + sy1) / 2, 4, TW / 2, (sy0 + sy1) / 2, sw * 1.15);
  glow.addColorStop(0, 'rgba(255,214,150,0.4)');
  glow.addColorStop(0.28, 'rgba(150,150,230,0.32)');
  glow.addColorStop(0.6, 'rgba(99,102,241,0.13)');
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
