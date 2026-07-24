/**
 * Synthetic view-from-seat panorama, generated from chart geometry alone.
 *
 * Draws a 2048×1024 equirectangular texture of the hall as seen from THIS seat.
 * Everything is placed from geometry the viewer already carries — the seat's
 * position, its per-seat eye height (which already bakes in its section's
 * height + rake + row rise), and every other seat's position + eye height:
 *
 *   • the SCENE at the correct bearing/angular size, chosen from the chart's own
 *     geometry — a proscenium theatre stage, an in-the-round centre-stage deck,
 *     or a flat sports playing surface (see {@link classifyScene});
 *   • the SURROUNDING STANDS — other sections drawn as darker raked banks
 *     rising to the pitch of their highest seat at their true bearing (upper
 *     tiers loom higher, a pit sits below the horizon), so the buyer senses the
 *     bowl wrapping around them;
 *   • a BALCONY-OVERHANG ceiling lip where a high, near section sits overhead;
 *   • the AUDIENCE — nearby people drawn as stylised head/neck/shoulder
 *     silhouettes at their true bearing, rising behind and dropping in front
 *     with the rake, near rows occluding far ones (painter's order).
 *
 * Used whenever the organizer hasn't uploaded a real photo/360 for the seat;
 * both go through the same viewer, and the designer preview reuses this exact
 * generator so authors see what buyers will.
 *
 * Height data drives the extra depth: a FLAT chart (no eye-height spread) draws
 * only the plain dark hall + scene + audience it always has — no raked masses,
 * no overhang, nothing invented from absent data.
 *
 * SCENE + PER-VENUE VARIATION. The picker hands this generator only seats — never
 * the stage object — so scene TYPE is inferred from the audience geometry around
 * the focal point (a bowl that wraps ~360° with a small central void is a
 * centre-stage arena; a large elongated void is a sports surface; a one-sided
 * audience is a proscenium theatre), and a stable per-chart seed (hashed from the
 * seat count + section ids + focal) drives backdrop hue, lighting tint and rig
 * layout so every venue looks like its own place. All deterministic: same
 * chart + seat ⇒ byte-identical texture (no Date, no Math.random).
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
const TAU = Math.PI * 2;
/** Equirectangular vertical resolution: pixels per degree of pitch. */
const PX_PER_DEG = H / 180;

const yawToX = (yawDeg: number) => ((yawDeg + 180) / 360) * W;
const pitchToY = (pitchDeg: number) => ((90 - pitchDeg) / 180) * H;

// --- deterministic helpers ---------------------------------------------------

/** FNV-1a → uint32, for a stable seed from a string descriptor. */
function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — seeded, deterministic, for per-venue dressing choices. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// --- scene classification ----------------------------------------------------
// The generator never sees the stage object (its signature takes only seats), so
// scene TYPE is inferred from where the audience sits around the focal point:
//   • a bowl wrapping ~360° with a SMALL central void  → in-the-round centre-stage;
//   • a bowl wrapping ~360° with a LARGE, elongated void → a sports playing surface;
//   • a one-sided audience                              → a proscenium theatre.
// A per-chart seed (seat count + section ids + focal) drives the dressing.

type SceneMode = 'proscenium' | 'arena' | 'sport';
interface Scene {
  mode: SceneMode;
  seed: number;
  /** Median radius (m) of the central void the audience rings — the performance area. */
  voidRadiusM: number;
  /** Elongation of the void (long axis / short axis); ~1 round, ~2 a rink. */
  aspect: number;
}

function classifyScene(_seat: ExpandedSeat, focal: Point, neighbors: ExpandedSeat[]): Scene {
  const NB = 72;
  const occ = new Array<boolean>(NB).fill(false);
  const innerM = new Array<number>(NB).fill(Infinity);
  const secSet = new Set<string>();
  let n = 0;
  for (const s of neighbors) {
    n++;
    if (s.sectionId) secSet.add(s.sectionId);
    const dx = s.x - focal.x;
    const dy = s.y - focal.y;
    const dM = Math.hypot(dx, dy) * UNIT;
    if (dM < 0.5) continue;
    const bearing = Math.atan2(dx, -dy); // −π..π, 0 = toward focal's −y
    let idx = Math.floor(((bearing + Math.PI) / TAU) * NB);
    if (idx < 0) idx = 0; else if (idx >= NB) idx = NB - 1;
    occ[idx] = true;
    if (dM < innerM[idx]) innerM[idx] = dM;
  }
  let occN = 0;
  const inner: number[] = [];
  for (let i = 0; i < NB; i++) if (occ[i]) { occN++; inner.push(innerM[i]); }
  const coverage = (occN / NB) * 360;
  inner.sort((a, b) => a - b);
  const median = inner.length ? inner[inner.length >> 1] : 0;
  const lo = inner.length ? (inner[Math.floor(inner.length * 0.15)] ?? median) : 0;
  const hi = inner.length ? (inner[Math.floor(inner.length * 0.85)] ?? median) : 0;
  const aspect = lo > 0.5 ? hi / lo : 1;
  const seed = fnv1a(`${n}|${[...secSet].sort().join(',')}|${Math.round(focal.x)},${Math.round(focal.y)}`);

  let mode: SceneMode;
  if (coverage >= 300 && median > 11 && aspect > 1.35) mode = 'sport';
  else if (coverage >= 285) mode = 'arena';
  else mode = 'proscenium';
  return { mode, seed, voidRadiusM: median, aspect };
}

// --- stylised human silhouettes ----------------------------------------------
// Theatre-poster silhouettes, NOT photoreal: a slightly-oval head, a visible neck
// gap, and shoulders that slope from the neck (a trapezius curve) into upper arms.
// Deterministic per seat/performer index — head size/tilt, hair outline, shoulder
// width and clothing tone all vary so no two neighbours are identical.

const HAIR_KINDS = 5; // 0 short · 1 full · 2 tied/bun · 3 cap · 4 long

/** Hair as extra silhouette shapes on top of the base head oval (local head coords). */
function drawHair(ctx: CanvasRenderingContext2D, r: number, kind: number): void {
  switch (kind) {
    case 1: // full / bushy — a larger rounded mass sitting over and around the head
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.14, r * 1.16, r * 1.16, 0, 0, TAU);
      ctx.fill();
      break;
    case 2: // tied back — a bun above the crown
      ctx.beginPath();
      ctx.ellipse(0, -r * 1.02, r * 0.42, r * 0.42, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.2, r * 0.98, r * 1.02, 0, 0, TAU);
      ctx.fill();
      break;
    case 3: // cap / hat — flattened crown with a small forward brim
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.36, r * 1.04, r * 0.6, 0, Math.PI, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.52, r * 1.22, r * 0.24, 0, 0, TAU); // brim
      ctx.fill();
      break;
    case 4: // long — hair falling past the neck on both sides
      ctx.beginPath();
      ctx.ellipse(-r * 0.66, r * 0.5, r * 0.5, r * 1.35, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r * 0.66, r * 0.5, r * 0.5, r * 1.35, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.08, r * 1.06, r * 1.08, 0, 0, TAU);
      ctx.fill();
      break;
    default: // short — the clean head oval already reads as short hair
      break;
  }
}

interface SeatedOpts {
  tone: RGB;
  clothing: RGB;
  alpha: number;
  tilt: number; // head tilt, radians
  shoulderK: number; // shoulder half-width in head-radii
  hair: number;
  rim: number; // 0..1 warm rim strength on head/shoulder crown
}

/**
 * A seated spectator seen from behind: sloping shoulders (drawn first) with a
 * trapezius curve into the upper arms, then a narrower neck + head on top so the
 * neck gap reads, then a hair-variant silhouette and an optional warm rim.
 */
function drawSeated(ctx: CanvasRenderingContext2D, hx: number, hy: number, r: number, o: SeatedOpts): void {
  const neckHalf = r * 0.44;
  const shHalf = r * o.shoulderK;
  const neckTopY = r * 0.66;
  const shoulderY = r * 1.68;
  const botY = r * 5.4; // runs off below the crop / into the seat back
  const clo = `rgba(${o.clothing[0]},${o.clothing[1]},${o.clothing[2]},${o.alpha})`;
  const skin = `rgba(${o.tone[0]},${o.tone[1]},${o.tone[2]},${o.alpha})`;

  ctx.save();
  ctx.translate(hx, hy);

  // shoulders + torso (clothing tone) — trapezius slope from neck to shoulder,
  // then upper-arm drop.
  ctx.fillStyle = clo;
  ctx.beginPath();
  ctx.moveTo(-neckHalf, neckTopY);
  ctx.quadraticCurveTo(-neckHalf * 1.18, shoulderY - r * 0.6, -shHalf, shoulderY);
  ctx.quadraticCurveTo(-shHalf * 1.05, shoulderY + r * 1.2, -shHalf * 0.94, botY);
  ctx.lineTo(shHalf * 0.94, botY);
  ctx.quadraticCurveTo(shHalf * 1.05, shoulderY + r * 1.2, shHalf, shoulderY);
  ctx.quadraticCurveTo(neckHalf * 1.18, shoulderY - r * 0.6, neckHalf, neckTopY);
  ctx.closePath();
  ctx.fill();

  // neck column (head tone), narrower than both head and shoulders → the gap.
  ctx.fillStyle = skin;
  ctx.fillRect(-neckHalf * 0.82, r * 0.5, neckHalf * 1.64, r * 0.9);

  // head + hair, with a small tilt.
  ctx.save();
  ctx.rotate(o.tilt);
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.9, r * 1.06, 0, 0, TAU);
  ctx.fill();
  drawHair(ctx, r, o.hair);
  // warm rim catching the stage light on the crown + a shoulder edge.
  if (o.rim > 0.01) {
    ctx.strokeStyle = `rgba(245,205,150,${(0.5 * o.rim).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, r * 0.14);
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.06, r * 0.86, r * 1.0, 0, Math.PI * 1.12, Math.PI * 1.9);
    ctx.stroke();
  }
  ctx.restore();

  if (o.rim > 0.01) {
    ctx.strokeStyle = `rgba(240,200,150,${(0.28 * o.rim).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(-shHalf * 0.8, shoulderY - r * 0.05);
    ctx.quadraticCurveTo(-neckHalf, shoulderY - r * 0.75, 0, shoulderY - r * 0.82);
    ctx.quadraticCurveTo(neckHalf, shoulderY - r * 0.75, shHalf * 0.8, shoulderY - r * 0.05);
    ctx.stroke();
  }
  ctx.restore();
}

/** Cheap head+shoulders for the mid LOD band — an oval head over a soft shoulder cap. */
function drawSeatedMid(ctx: CanvasRenderingContext2D, hx: number, hy: number, r: number, clothing: RGB, tone: RGB, alpha: number): void {
  ctx.fillStyle = `rgba(${clothing[0]},${clothing[1]},${clothing[2]},${alpha})`;
  ctx.beginPath();
  ctx.moveTo(hx - r * 1.9, hy + r * 4);
  ctx.quadraticCurveTo(hx - r * 1.95, hy + r * 1.2, hx - r * 0.5, hy + r * 0.9);
  ctx.quadraticCurveTo(hx, hy + r * 0.4, hx + r * 0.5, hy + r * 0.9);
  ctx.quadraticCurveTo(hx + r * 1.95, hy + r * 1.2, hx + r * 1.9, hy + r * 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(${tone[0]},${tone[1]},${tone[2]},${alpha})`;
  ctx.beginPath();
  ctx.ellipse(hx, hy, r * 0.92, r * 1.05, 0, 0, TAU);
  ctx.fill();
}

interface PerformerOpts {
  tone: RGB;
  alpha: number;
  pose: number; // 0 neutral · 1 arms up · 2 instrument · 3 mic
  rim: RGB; // rim-light colour (from the scene lighting)
  rimStrength: number;
}

/**
 * A standing performer on the stage/deck: full body with varied poses, grounded
 * by a contact shadow on the deck. Same silhouette language as the audience.
 */
function drawPerformer(ctx: CanvasRenderingContext2D, x: number, footY: number, h: number, o: PerformerOpts): void {
  const headR = h * 0.1;
  const headCy = footY - h * 0.9;
  const shoulderY = footY - h * 0.74;
  const hipY = footY - h * 0.46;
  const shHalf = h * 0.13;
  const hipHalf = h * 0.09;
  const skin = `rgba(${o.tone[0]},${o.tone[1]},${o.tone[2]},${o.alpha})`;

  // contact shadow — an elongated soft ellipse under the feet, on the deck.
  const sh = ctx.createRadialGradient(x, footY, 1, x, footY, h * 0.24);
  sh.addColorStop(0, 'rgba(0,0,0,0.4)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.scale(1, 0.28);
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.ellipse(x, footY / 0.28, h * 0.24, h * 0.24, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = skin;
  // legs — two tapered columns to the feet.
  ctx.beginPath();
  ctx.moveTo(x - hipHalf, hipY);
  ctx.lineTo(x - hipHalf * 0.7, footY);
  ctx.lineTo(x - hipHalf * 0.1, footY);
  ctx.lineTo(x - hipHalf * 0.1, hipY + h * 0.02);
  ctx.lineTo(x + hipHalf * 0.1, hipY + h * 0.02);
  ctx.lineTo(x + hipHalf * 0.1, footY);
  ctx.lineTo(x + hipHalf * 0.7, footY);
  ctx.lineTo(x + hipHalf, hipY);
  ctx.closePath();
  ctx.fill();

  // torso — shoulders down to hips.
  ctx.beginPath();
  ctx.moveTo(x - shHalf, shoulderY);
  ctx.quadraticCurveTo(x - shHalf * 0.9, hipY - h * 0.12, x - hipHalf, hipY);
  ctx.lineTo(x + hipHalf, hipY);
  ctx.quadraticCurveTo(x + shHalf * 0.9, hipY - h * 0.12, x + shHalf, shoulderY);
  ctx.quadraticCurveTo(x, shoulderY - h * 0.05, x - shHalf, shoulderY);
  ctx.closePath();
  ctx.fill();

  // arms by pose.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = skin;
  ctx.lineWidth = h * 0.055;
  const armY = shoulderY + h * 0.02;
  if (o.pose === 1) {
    // arms up in a V.
    ctx.beginPath();
    ctx.moveTo(x - shHalf * 0.8, armY);
    ctx.lineTo(x - shHalf * 1.5, footY - h * 1.02);
    ctx.moveTo(x + shHalf * 0.8, armY);
    ctx.lineTo(x + shHalf * 1.5, footY - h * 1.02);
    ctx.stroke();
  } else if (o.pose === 2) {
    // instrument: one arm across the body, a guitar body hint at the hip.
    ctx.beginPath();
    ctx.moveTo(x - shHalf * 0.8, armY);
    ctx.lineTo(x + hipHalf * 1.4, hipY - h * 0.02);
    ctx.moveTo(x + shHalf * 0.8, armY);
    ctx.lineTo(x - hipHalf * 0.4, hipY - h * 0.06);
    ctx.stroke();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(x + hipHalf * 1.5, hipY - h * 0.04, h * 0.07, h * 0.09, -0.5, 0, TAU);
    ctx.fill();
  } else if (o.pose === 3) {
    // mic stance: one arm up toward the head, a thin mic stand in front.
    ctx.beginPath();
    ctx.moveTo(x - shHalf * 0.8, armY);
    ctx.lineTo(x - shHalf * 0.2, headCy + headR * 0.6);
    ctx.moveTo(x + shHalf * 0.8, armY);
    ctx.lineTo(x + shHalf * 1.1, hipY);
    ctx.stroke();
    ctx.lineWidth = h * 0.02;
    ctx.beginPath();
    ctx.moveTo(x - shHalf * 0.2, headCy + headR * 0.9);
    ctx.lineTo(x - shHalf * 0.2, footY - h * 0.02);
    ctx.stroke();
  } else {
    // neutral — arms at the sides.
    ctx.beginPath();
    ctx.moveTo(x - shHalf * 0.85, armY);
    ctx.lineTo(x - shHalf * 0.95, hipY + h * 0.02);
    ctx.moveTo(x + shHalf * 0.85, armY);
    ctx.lineTo(x + shHalf * 0.95, hipY + h * 0.02);
    ctx.stroke();
  }

  // neck + head.
  ctx.fillStyle = skin;
  ctx.fillRect(x - headR * 0.34, headCy + headR * 0.6, headR * 0.68, headR * 0.9);
  ctx.beginPath();
  ctx.ellipse(x, headCy, headR * 0.86, headR * 1.05, 0, 0, TAU);
  ctx.fill();

  // rim light on the figure's lit edge.
  if (o.rimStrength > 0.01) {
    ctx.strokeStyle = `rgba(${o.rim[0]},${o.rim[1]},${o.rim[2]},${(0.6 * o.rimStrength).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, h * 0.02);
    ctx.beginPath();
    ctx.moveTo(x - shHalf, shoulderY);
    ctx.lineTo(x - headR * 0.6, headCy + headR * 0.4);
    ctx.moveTo(x - headR * 0.7, headCy);
    ctx.ellipse(x, headCy, headR * 0.84, headR * 1.02, 0, Math.PI * 1.05, Math.PI * 1.55);
    ctx.stroke();
  }
}

/** A tapered light-beam cone that ADDS light ('lighter' composite), strong at the
 *  fixture and fading down. Narrow at the source (halfTop), wide at the target
 *  pool (halfBot). */
function drawBeam(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  halfTop: number, halfBot: number, tint: string, strength: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, `rgba(${tint},${strength})`);
  g.addColorStop(0.5, `rgba(${tint},${(strength * 0.4).toFixed(3)})`);
  g.addColorStop(1, `rgba(${tint},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x0 - halfTop, y0);
  ctx.lineTo(x1 - halfBot, y1);
  ctx.lineTo(x1 + halfBot, y1);
  ctx.lineTo(x0 + halfTop, y0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A rig fixture: a bright dot with a soft halo where a beam originates. */
function drawFixture(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, tint: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
  g.addColorStop(0, `rgba(${tint},0.9)`);
  g.addColorStop(0.4, `rgba(${tint},0.35)`);
  g.addColorStop(1, `rgba(${tint},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 3, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `rgba(${tint},1)`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
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

  const scene = classifyScene(seat, focalPoint, neighborSeats);
  const rand = rng(scene.seed);
  // Per-venue lighting identity: a base hue steers the backdrop, a cool rig tint
  // shifts a little off the default periwinkle, and a warm accent lights figures.
  const baseHue = 210 + rand() * 150; // violet → magenta → amber sweep
  const rigTint: RGB = hslToRgb(220 + (rand() - 0.5) * 60, 0.55, 0.82);
  const rigTintStr = `${rigTint[0]},${rigTint[1]},${rigTint[2]}`;

  // ---- room shell: ceiling → walls → floor -------------------------------
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#080b12');
  sky.addColorStop(0.42, '#12182c');
  sky.addColorStop(0.5, '#1c2440');
  sky.addColorStop(0.56, '#151b2c');
  sky.addColorStop(0.78, '#171e30');
  sky.addColorStop(1, '#131829');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Ambient floor wash — a broad dim lift across the lower hall.
  const floorAmb = ctx.createLinearGradient(0, pitchToY(-6), 0, H);
  floorAmb.addColorStop(0, 'rgba(30, 37, 56, 0)');
  floorAmb.addColorStop(0.55, 'rgba(30, 37, 56, 0.22)');
  floorAmb.addColorStop(1, 'rgba(22, 28, 44, 0.12)');
  ctx.fillStyle = floorAmb;
  ctx.fillRect(0, pitchToY(-6), W, H - pitchToY(-6));

  // Bearing of the stage in screen coords (-y is "up" the hall).
  const stageBearing = Math.atan2(dx, -dy);

  // ---- surrounding stands: other sections as raked banks (all modes) ------
  const stands = buildStands(seat, neighborSeats, stageBearing, eyeM);
  const hasRelief = stands.maxDelta >= FLAT_DELTA_M;
  if (hasRelief) drawStands(ctx, stands.bins, yawToX, pitchToY);

  // Distance drama factor.
  const nearGlow = Math.max(0.3, Math.min(1, 1 - (distM - 6) / 60));

  // ---- the scene, centered at yaw 0 --------------------------------------
  const sightline = stageSightlinePitch(eyeM, distM);
  const stageHalfYaw = Math.min(80, (Math.atan2(4, distM) * 180) / Math.PI);
  const stageTopPitch = Math.min(45, sightline.topPitch);
  const stageBasePitch = sightline.basePitch;

  if (scene.mode === 'sport') {
    drawSportScene(ctx, distM, eyeM, scene, nearGlow, baseHue, rigTintStr, rand);
  } else if (scene.mode === 'arena') {
    drawArenaScene(ctx, distM, eyeM, scene, nearGlow, rigTintStr, rand);
  } else {
    drawProsceniumScene(ctx, stageHalfYaw, stageTopPitch, stageBasePitch, nearGlow, baseHue, rigTintStr, rand);
  }

  // ---- rig lights along the ceiling all around ---------------------------
  // Sport gets even flood banks; performance venues get a warmer scattered rig.
  const rigCount = scene.mode === 'sport' ? 34 : 24 + Math.floor(rand() * 8);
  ctx.fillStyle = `rgba(${rigTintStr},0.8)`;
  for (let i = 0; i < rigCount; i++) {
    const x = ((i + 0.5) / rigCount) * W;
    const y = pitchToY(scene.mode === 'sport' ? 58 : 54 + ((i * 7) % 3) * 6);
    ctx.beginPath();
    ctx.arc(x, y, scene.mode === 'sport' ? 2.6 : 3.2, 0, TAU);
    ctx.fill();
  }

  // ---- audience: stylised silhouettes of nearby seats --------------------
  drawAudience(ctx, seat, neighborSeats, focalPoint, stageBearing, eyeM, dx, dy, hasRelief, scene);

  // subtle vignette at the poles (hides equirect pinching)
  const poleFade = ctx.createLinearGradient(0, 0, 0, H);
  poleFade.addColorStop(0, 'rgba(0,0,0,0.85)');
  poleFade.addColorStop(0.12, 'rgba(0,0,0,0)');
  poleFade.addColorStop(0.9, 'rgba(0,0,0,0)');
  poleFade.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = poleFade;
  ctx.fillRect(0, 0, W, H);

  return { url: canvas.toDataURL('image/jpeg', 0.82), distanceM: Math.round(distM) };
}

// ---- scene drawers ----------------------------------------------------------

/**
 * Proscenium theatre: a perspective arch (top valance + tapering legs) with dark
 * masking wings, a backdrop INSET in the opening that falls off softly at its
 * edges (never a hard rectangle floating in black), a lit stage-floor front edge
 * with footlights, tapered light-beam cones, and posed performer silhouettes.
 */
function drawProsceniumScene(
  ctx: CanvasRenderingContext2D,
  stageHalfYaw: number,
  stageTopPitch: number,
  stageBasePitch: number,
  nearGlow: number,
  baseHue: number,
  rigTintStr: string,
  rand: () => number,
): void {
  const sx0 = yawToX(-stageHalfYaw);
  const sx1 = yawToX(stageHalfYaw);
  const sy0 = pitchToY(stageTopPitch);
  const sy1 = pitchToY(stageBasePitch);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  const archTop = pitchToY(Math.min(50, stageTopPitch + 10));

  // Warm glow bloom behind the opening.
  const glowR = sw * (1.1 + (1 - nearGlow) * 0.5);
  const glow = ctx.createRadialGradient(W / 2, (sy0 + sy1) / 2, 8, W / 2, (sy0 + sy1) / 2, glowR);
  glow.addColorStop(0, 'rgba(255, 214, 150, 0.34)');
  glow.addColorStop(0.28, 'rgba(150, 150, 230, 0.3)');
  glow.addColorStop(0.6, 'rgba(99, 102, 241, 0.12)');
  glow.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sx0 - sw * 0.6, sy0 - sh * 1.2, sw * 2.2, sh * 3.4);

  // Backdrop inset — a seeded gradient painted only inside the opening, then a
  // soft edge falloff so it melts into the masking instead of a hard edge.
  const topCol = hslToRgb(baseHue, 0.62, 0.55);
  const midCol = hslToRgb(baseHue + 40, 0.7, 0.5);
  const botCol = hslToRgb(baseHue + 70, 0.78, 0.52);
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx0, sy0, sw, sh);
  ctx.clip();
  const backdrop = ctx.createLinearGradient(0, sy0, 0, sy1);
  backdrop.addColorStop(0, `rgb(${topCol[0]},${topCol[1]},${topCol[2]})`);
  backdrop.addColorStop(0.5, `rgb(${midCol[0]},${midCol[1]},${midCol[2]})`);
  backdrop.addColorStop(1, `rgb(${botCol[0]},${botCol[1]},${botCol[2]})`);
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = backdrop;
  ctx.fillRect(sx0, sy0, sw, sh);
  ctx.globalAlpha = 1;
  // Edge falloff: transparent centre → dark at the opening's borders.
  const fall = ctx.createRadialGradient(W / 2, (sy0 + sy1) / 2, sw * 0.12, W / 2, (sy0 + sy1) / 2, sw * 0.62);
  fall.addColorStop(0, 'rgba(6,8,14,0)');
  fall.addColorStop(0.7, 'rgba(6,8,14,0.15)');
  fall.addColorStop(1, 'rgba(5,6,11,0.92)');
  ctx.fillStyle = fall;
  ctx.fillRect(sx0, sy0, sw, sh);
  ctx.restore();

  // Performers on the stage floor.
  const perfCount = 3 + Math.floor(rand() * 3);
  const perfH = sh * 0.46;
  const floorY = sy1 - sh * 0.08;
  for (let i = 0; i < perfCount; i++) {
    const t = (i + 1) / (perfCount + 1);
    const px = sx0 + sw * (0.22 + t * 0.56 + (rand() - 0.5) * 0.06);
    drawPerformer(ctx, px, floorY, perfH * (0.9 + rand() * 0.24), {
      tone: [8, 10, 16],
      alpha: 0.9,
      pose: Math.floor(rand() * 4),
      rim: hslToRgb(baseHue + 20, 0.5, 0.7),
      rimStrength: 0.7,
    });
  }

  // Masking wings — dark vertical legs beyond the opening.
  ctx.fillStyle = '#05070d';
  ctx.fillRect(sx0 - sw * 0.5, archTop, sw * 0.5, sy1 - archTop);
  ctx.fillRect(sx1, archTop, sw * 0.5, sy1 - archTop);

  // Perspective arch: legs lean inward slightly toward the top, a top beam/valance.
  const legBot = sw * 0.055 + 3; // leg thickness at the base
  const legTop = legBot * 1.35; // wider at the top (perspective)
  ctx.fillStyle = '#03050a';
  // left leg
  ctx.beginPath();
  ctx.moveTo(sx0, sy1);
  ctx.lineTo(sx0 - legBot, sy1);
  ctx.lineTo(sx0 - legTop, archTop);
  ctx.lineTo(sx0 + sw * 0.012, archTop);
  ctx.closePath();
  ctx.fill();
  // right leg
  ctx.beginPath();
  ctx.moveTo(sx1, sy1);
  ctx.lineTo(sx1 + legBot, sy1);
  ctx.lineTo(sx1 + legTop, archTop);
  ctx.lineTo(sx1 - sw * 0.012, archTop);
  ctx.closePath();
  ctx.fill();
  // top beam.
  ctx.fillRect(sx0 - legTop, archTop, sw + legTop * 2, (sy1 - archTop) * 0.12);
  // valance: a soft draped border hanging below the beam.
  const valH = sh * 0.14;
  const valY = archTop + (sy1 - archTop) * 0.12;
  ctx.fillStyle = 'rgba(4,6,12,0.96)';
  const scallops = 7;
  ctx.beginPath();
  ctx.moveTo(sx0 - legTop, valY);
  for (let i = 0; i <= scallops; i++) {
    const xx = sx0 - legTop + ((sw + legTop * 2) * i) / scallops;
    ctx.quadraticCurveTo(xx - (sw + legTop * 2) / scallops / 2, valY + valH, xx, valY);
  }
  ctx.lineTo(sx1 + legTop, valY);
  ctx.lineTo(sx1 + legTop, archTop);
  ctx.lineTo(sx0 - legTop, archTop);
  ctx.closePath();
  ctx.fill();
  // faint lit inner rim on the arch legs.
  ctx.fillStyle = `rgba(${rigTintStr},0.12)`;
  ctx.fillRect(sx0 - 1.5, valY, 1.5, sy1 - valY);
  ctx.fillRect(sx1, valY, 1.5, sy1 - valY);

  // Stage floor front edge + footlight glow.
  ctx.fillStyle = '#0b0f18';
  ctx.fillRect(sx0 - legBot, sy1 - sh * 0.05, sw + legBot * 2, sh * 0.05 + 3);
  const foot = ctx.createLinearGradient(0, sy1 - sh * 0.05, 0, sy1 + sh * 0.12);
  foot.addColorStop(0, `rgba(255,206,140,${(0.5 * nearGlow).toFixed(3)})`);
  foot.addColorStop(1, 'rgba(255,206,140,0)');
  ctx.fillStyle = foot;
  ctx.fillRect(sx0 - legBot, sy1 - sh * 0.05, sw + legBot * 2, sh * 0.2);

  // Tapered light-beam cones from rig fixtures above the arch.
  const beams = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < beams; i++) {
    const t = (i + 1) / (beams + 1);
    const fx = sx0 + sw * (t + (rand() - 0.5) * 0.08);
    const fy = pitchToY(Math.min(62, stageTopPitch + 26));
    const skew = (rand() - 0.5) * sw * 0.16;
    drawBeam(ctx, fx, fy, fx + skew, sy1, 4, sw * 0.09, rigTintStr, 0.16 * (0.7 + nearGlow * 0.5));
    drawFixture(ctx, fx, fy, 2.4, rigTintStr);
  }
}

/**
 * In-the-round centre-stage: an elevated elliptical deck with a lit rim and a
 * visible riser side, a truss ring above with hanging fixtures and tapered beam
 * cones onto the deck, a warm floor-spill pool, and performers standing ON the
 * deck. No proscenium — the opposite stands stay visible behind it.
 */
function drawArenaScene(
  ctx: CanvasRenderingContext2D,
  distM: number,
  eyeM: number,
  scene: Scene,
  nearGlow: number,
  rigTintStr: string,
  rand: () => number,
): void {
  // Bound the deck radius so a seat AT the stage edge (distM ≈ void radius) can't
  // blow the near-edge pitch up to the pole — the deck never exceeds the viewer's
  // own distance, and the near edge stays a safe fraction of the way in.
  const stageR = Math.min(distM * 0.6, Math.max(3, scene.voidRadiusM));
  const halfYaw = Math.min(55, (Math.atan2(stageR, distM) * 180) / Math.PI);
  const cx = W / 2;
  const deckRiserM = 1.2;
  const nearDist = Math.max(distM * 0.45, distM - stageR);
  const farDist = distM + stageR;
  // Near/far edges of the deck top, in pitch.
  const nearTopPitch = (Math.atan2(deckRiserM - eyeM, nearDist) * 180) / Math.PI;
  const farTopPitch = (Math.atan2(deckRiserM - eyeM, farDist) * 180) / Math.PI;
  const nearBasePitch = (Math.atan2(-eyeM, nearDist) * 180) / Math.PI; // floor at the near edge
  const yNearTop = pitchToY(nearTopPitch);
  const yFarTop = pitchToY(farTopPitch);
  const yBase = pitchToY(nearBasePitch);
  const halfW = yawToX(halfYaw) - cx;
  const topRy = Math.max(6, (yNearTop - yFarTop) / 2); // ellipse vertical radius (foreshortened)
  const topCy = (yNearTop + yFarTop) / 2;

  // Floor-spill pool around the deck base.
  const pool = ctx.createRadialGradient(cx, yBase, 4, cx, yBase, halfW * 2.6);
  pool.addColorStop(0, `rgba(255,206,150,${(0.2 * nearGlow).toFixed(3)})`);
  pool.addColorStop(0.5, 'rgba(150,140,190,0.08)');
  pool.addColorStop(1, 'rgba(40,44,60,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = pool;
  ctx.fillRect(cx - halfW * 2.6, yFarTop - topRy, halfW * 5.2, yBase - yFarTop + topRy + 40);
  ctx.restore();

  // Riser side (the deck wall) — dark, from the near-top ellipse down to the floor.
  ctx.fillStyle = '#0c1019';
  ctx.beginPath();
  ctx.moveTo(cx - halfW, topCy);
  ctx.ellipse(cx, topCy, halfW, topRy, 0, Math.PI, 0, false);
  ctx.lineTo(cx + halfW, yBase);
  ctx.ellipse(cx, yBase, halfW, topRy, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();
  // lit vertical seam on the riser front.
  const riser = ctx.createLinearGradient(0, topCy, 0, yBase);
  riser.addColorStop(0, `rgba(${rigTintStr},0.14)`);
  riser.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = riser;
  ctx.fillRect(cx - halfW, topCy, halfW * 2, yBase - topCy);

  // Deck top face — a lit elliptical platform.
  const deckTop = ctx.createLinearGradient(0, topCy - topRy, 0, topCy + topRy);
  deckTop.addColorStop(0, '#2b3350');
  deckTop.addColorStop(1, '#161b2c');
  ctx.fillStyle = deckTop;
  ctx.beginPath();
  ctx.ellipse(cx, topCy, halfW, topRy, 0, 0, TAU);
  ctx.fill();
  // warm centre bloom on the deck.
  const deckGlow = ctx.createRadialGradient(cx, topCy, 2, cx, topCy, halfW);
  deckGlow.addColorStop(0, `rgba(255,214,160,${(0.28 * nearGlow).toFixed(3)})`);
  deckGlow.addColorStop(1, 'rgba(255,214,160,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = deckGlow;
  ctx.beginPath();
  ctx.ellipse(cx, topCy, halfW, topRy, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
  // lit rim around the deck edge.
  ctx.strokeStyle = `rgba(${rigTintStr},0.7)`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, topCy, halfW, topRy, 0, 0, TAU);
  ctx.stroke();

  // Performers standing on the deck.
  const perfCount = 2 + Math.floor(rand() * 3);
  const perfH = Math.max(24, (yBase - yFarTop) * 1.3);
  for (let i = 0; i < perfCount; i++) {
    const t = perfCount === 1 ? 0.5 : i / (perfCount - 1);
    const px = cx + (t - 0.5) * 2 * halfW * 0.66;
    const footY = topCy + topRy * 0.5 * Math.cos((t - 0.5) * Math.PI) - topRy * 0.1;
    drawPerformer(ctx, px, footY, perfH * (0.85 + rand() * 0.3), {
      tone: [10, 12, 20],
      alpha: 0.92,
      pose: Math.floor(rand() * 4),
      rim: hslToRgb(40, 0.6, 0.72),
      rimStrength: 0.8,
    });
  }

  // Truss ring above the deck with hanging fixtures + tapered beams onto the deck.
  const trussY = pitchToY(Math.min(60, farTopPitch + 34));
  const trussRy = topRy * 1.1 + 6;
  ctx.strokeStyle = 'rgba(60,68,92,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, trussY, halfW * 1.15, trussRy, 0, 0, TAU);
  ctx.stroke();
  const fixtures = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < fixtures; i++) {
    const a = (i / fixtures) * TAU;
    const fxX = cx + Math.cos(a) * halfW * 1.15;
    const fxY = trussY + Math.sin(a) * trussRy;
    if (Math.sin(a) > -0.2) {
      // front-facing fixtures cast visible beams down onto the deck.
      const tx = cx + (rand() - 0.5) * halfW * 0.8;
      drawBeam(ctx, fxX, fxY, tx, topCy, 3, halfW * 0.32, rigTintStr, 0.14 * (0.7 + nearGlow * 0.4));
    }
    drawFixture(ctx, fxX, fxY, 2.2, rigTintStr);
  }
}

/**
 * A flat sports playing surface (rink/court) in the middle of the bowl: a bright
 * lit ellipse with faint markings, a scoreboard glow overhead instead of a stage
 * screen, and even arena flood lighting. No proscenium, no performers.
 */
function drawSportScene(
  ctx: CanvasRenderingContext2D,
  distM: number,
  eyeM: number,
  scene: Scene,
  _nearGlow: number,
  baseHue: number,
  rigTintStr: string,
  rand: () => number,
): void {
  const cx = W / 2;
  const surfR = Math.max(10, scene.voidRadiusM);
  // The surface spans a wide arc; near edge close, far edge across the bowl.
  const nearEdge = Math.max(2, distM - surfR);
  const farEdge = distM + surfR;
  const halfYaw = Math.min(78, (Math.atan2(surfR * 1.15, distM) * 180) / Math.PI);
  const nearPitch = (Math.atan2(-eyeM, nearEdge) * 180) / Math.PI;
  const farPitch = (Math.atan2(-eyeM, farEdge) * 180) / Math.PI;
  const yNear = pitchToY(nearPitch);
  const yFar = pitchToY(farPitch);
  const halfW = yawToX(halfYaw) - cx;
  const cy = (yNear + yFar) / 2;
  const ry = Math.max(10, (yNear - yFar) / 2);

  // Cool bright playing surface (ice/court), a soft blue-white.
  const surfCol = ctx.createRadialGradient(cx, cy, 4, cx, cy, halfW);
  surfCol.addColorStop(0, '#e8f0fb');
  surfCol.addColorStop(0.7, '#b9c9e2');
  surfCol.addColorStop(1, '#8fa3c4');
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, halfW, ry, 0, 0, TAU);
  ctx.clip();
  ctx.fillStyle = surfCol;
  ctx.fillRect(cx - halfW, cy - ry, halfW * 2, ry * 2);
  // faint markings: centre line + centre circle + two zone lines.
  ctx.strokeStyle = 'rgba(90,120,170,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry);
  ctx.lineTo(cx, cy + ry);
  ctx.moveTo(cx - halfW * 0.5, cy - ry);
  ctx.lineTo(cx - halfW * 0.5, cy + ry);
  ctx.moveTo(cx + halfW * 0.5, cy - ry);
  ctx.lineTo(cx + halfW * 0.5, cy + ry);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(180,90,110,0.45)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, ry * 0.9, ry * 0.5, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
  // lit rim / board line around the surface.
  ctx.strokeStyle = 'rgba(210,225,245,0.6)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, halfW, ry, 0, 0, TAU);
  ctx.stroke();

  // A couple of tiny player marks for life (small, not performers).
  ctx.fillStyle = 'rgba(20,26,40,0.8)';
  for (let i = 0; i < 5; i++) {
    const px = cx + (rand() - 0.5) * halfW * 1.4;
    const py = cy + (rand() - 0.5) * ry * 1.1;
    const s = Math.max(2, ry * 0.06);
    ctx.beginPath();
    ctx.ellipse(px, py, s * 0.6, s, 0, 0, TAU);
    ctx.fill();
  }

  // Cool even wash of light on the surface.
  const wash = ctx.createRadialGradient(cx, cy, 4, cx, cy, halfW * 1.4);
  wash.addColorStop(0, 'rgba(200,220,255,0.12)');
  wash.addColorStop(1, 'rgba(200,220,255,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = wash;
  ctx.fillRect(cx - halfW * 1.4, yFar - ry, halfW * 2.8, yNear - yFar + ry * 2);
  ctx.restore();

  // Scoreboard cluster overhead — a glowing hexagonal bank centred over the ice.
  const sbY = pitchToY(Math.min(66, farPitch + 60));
  const sbW = Math.max(80, halfW * 0.7);
  const sbH = sbW * 0.5;
  const sbGlow = ctx.createRadialGradient(cx, sbY, 4, cx, sbY, sbW * 1.6);
  sbGlow.addColorStop(0, `rgba(${rigTintStr},0.3)`);
  sbGlow.addColorStop(1, `rgba(${rigTintStr},0)`);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = sbGlow;
  ctx.fillRect(cx - sbW * 1.6, sbY - sbW * 1.2, sbW * 3.2, sbW * 2.4);
  ctx.restore();
  // scoreboard body — four lit screens around a dark hexagon.
  ctx.fillStyle = '#080b12';
  ctx.beginPath();
  ctx.moveTo(cx - sbW / 2, sbY - sbH / 2);
  ctx.lineTo(cx + sbW / 2, sbY - sbH / 2);
  ctx.lineTo(cx + sbW * 0.6, sbY);
  ctx.lineTo(cx + sbW / 2, sbY + sbH / 2);
  ctx.lineTo(cx - sbW / 2, sbY + sbH / 2);
  ctx.lineTo(cx - sbW * 0.6, sbY);
  ctx.closePath();
  ctx.fill();
  const screenHue = baseHue;
  for (let i = 0; i < 3; i++) {
    const scol = hslToRgb(screenHue + i * 30, 0.5, 0.5);
    ctx.fillStyle = `rgba(${scol[0]},${scol[1]},${scol[2]},0.75)`;
    const swid = sbW * 0.26;
    ctx.fillRect(cx - sbW * 0.42 + i * (swid + sbW * 0.06), sbY - sbH * 0.32, swid, sbH * 0.64);
  }
  // hanging rig lights under the scoreboard.
  ctx.fillStyle = `rgba(${rigTintStr},0.9)`;
  for (let i = 0; i < 8; i++) {
    const lx = cx - sbW * 0.6 + (sbW * 1.2 * i) / 7;
    ctx.beginPath();
    ctx.arc(lx, sbY + sbH * 0.62, 2.4, 0, TAU);
    ctx.fill();
  }
}

// ---- audience ---------------------------------------------------------------

/**
 * Nearby seats drawn as stylised silhouettes at their true bearing, sorted far→
 * near so front rows occlude the rows behind (painter's order). Three LOD bands:
 * near = full head/neck/shoulders + hair + rim; mid = simplified head+shoulders;
 * far = a dot + shoulder cap. A seat-back rail is drawn last when a seat sits
 * directly ahead (front-row seats face open floor and get none).
 */
function drawAudience(
  ctx: CanvasRenderingContext2D,
  seat: ExpandedSeat,
  neighborSeats: ExpandedSeat[],
  _focalPoint: Point,
  stageBearing: number,
  eyeM: number,
  dx: number,
  dy: number,
  hasRelief: boolean,
  scene: Scene,
): void {
  const own = seat.sectionId;
  let seatAhead = false;
  interface Fig { hx: number; hy: number; r: number; d: number; hash: number }
  const figs: Fig[] = [];
  for (const other of neighborSeats) {
    if (other.id === seat.id) continue;
    const ox = other.x - seat.x;
    const oy = other.y - seat.y;
    const d = Math.hypot(ox, oy) * UNIT;
    if (own && other.sectionId === own && d < 3 && ox * dx + oy * dy > 0) seatAhead = true;
    if (d < 0.3 || d > 17) continue;
    const bearing = Math.atan2(ox, -oy) - stageBearing;
    const yaw = ((((bearing * 180) / Math.PI + 540) % 360) - 180);
    const rise = hasRelief ? (other.eyeHeightM ?? SEATED_EYE_HEIGHT_M) - eyeM : 0;
    // Head sits ~0.28m below the eye-line of its own seat, rake-shifted.
    const headPitch = (Math.atan2(rise - 0.28, d) * 180) / Math.PI;
    // Skip the far-and-high leak: same-section neighbours up the rake that the
    // fan curvature bends into the forward cone would otherwise read as a crowd
    // floating above the stage. A believable "row in front" sits at or below the
    // eye-line, so anything far AND well above it is culled.
    if (headPitch > 10 && d > 5) continue;
    let hh = 0;
    for (let k = 0; k < other.id.length; k++) hh = (hh * 31 + other.id.charCodeAt(k)) & 0xffff;
    // Physically-based head size: a ~0.16 m head half-width at distance d.
    const jitter = 0.9 + (hh & 15) / 40; // ~0.9..1.28
    const r = Math.min(78, (Math.atan2(0.16, d) * 180 / Math.PI) * PX_PER_DEG * jitter);
    if (r < 2) continue;
    figs.push({ hx: yawToX(yaw), hy: pitchToY(headPitch), r, d, hash: hh });
  }
  // Painter's order: far first so nearer figures overlap on top.
  figs.sort((a, b) => b.d - a.d);

  const CLOTHES: RGB[] = [[22, 26, 40], [28, 27, 42], [24, 31, 46], [31, 30, 47], [20, 24, 36]];
  for (const f of figs) {
    // Near figures are near-solid so they occlude cleanly; only the far dots fade.
    const alpha = f.d < 12 ? 0.95 : Math.max(0.66, 0.95 - (f.d - 12) / 18);
    const lift = Math.round((1 - Math.min(1, f.d / 16)) * 10);
    const headTone: RGB = [14 + ((f.hash >> 4) & 6) + lift, 17 + ((f.hash >> 4) & 6) + lift, 25 + ((f.hash >> 4) & 6) + lift];
    const clo0 = CLOTHES[f.hash % CLOTHES.length];
    const clothing: RGB = [clo0[0] + lift, clo0[1] + lift, clo0[2] + lift];
    if (f.r >= 13) {
      const rim = f.d < 9 ? 0.16 * (1 - f.d / 9) + (scene.mode === 'proscenium' ? 0.06 : 0) : 0;
      drawSeated(ctx, f.hx, f.hy, f.r, {
        tone: headTone,
        clothing,
        alpha,
        tilt: (((f.hash >> 2) & 7) - 3.5) * 0.018, // ±~7°
        shoulderK: 1.72 + ((f.hash >> 5) & 7) / 22, // ~1.72..2.04
        hair: f.hash % HAIR_KINDS,
        rim,
      });
    } else if (f.r >= 5.5) {
      drawSeatedMid(ctx, f.hx, f.hy, f.r, clothing, headTone, alpha);
    } else {
      ctx.fillStyle = `rgba(${headTone[0]},${headTone[1]},${headTone[2]},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(f.hx, f.hy, f.r, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(f.hx, f.hy + f.r * 1.4, f.r * 1.85, f.r * 0.95, 0, Math.PI, 0, true);
      ctx.fill();
    }
  }

  // Foreground seat-back rail (only when a seat sits directly ahead).
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
}

// ---------------------------------------------------------------------------
// Compact forward-view thumbnail — a cheap (480×270) rectilinear preview of
// what this seat faces, for inline display inside the buyer's confirm card.
// Unlike the full equirectangular panorama it maps a ~100°×60° forward field
// of view directly (no 360 squish), so it reads as a real POV at a glance and
// costs a fraction of the full render. It has no neighbour list, so it always
// draws a compact upgraded proscenium (arch + inset backdrop + posed performers
// + tapered beams), seeded off the seat id so venues still differ.
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
  const rand = rng(fnv1a(`${seat.id}|${Math.round(focalPoint.x)},${Math.round(focalPoint.y)}`));
  const baseHue = 210 + rand() * 150;
  const rigTint = hslToRgb(220 + (rand() - 0.5) * 60, 0.55, 0.82);
  const rigTintStr = `${rigTint[0]},${rigTint[1]},${rigTint[2]}`;

  // hall shell (ceiling → wall → floor), horizon at mid-height.
  const sky = ctx.createLinearGradient(0, 0, 0, TH);
  sky.addColorStop(0, '#080b12');
  sky.addColorStop(0.44, '#151c32');
  sky.addColorStop(0.5, '#1d2644');
  sky.addColorStop(0.58, '#161c2e');
  sky.addColorStop(1, '#131829');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, TW, TH);

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
  const nearGlow = Math.max(0.35, Math.min(1, 1 - (distM - 6) / 60));
  const archTop = pitchToTY(Math.min(HALF_VFOV - 1, stageTopPitch + 8));

  // glow bloom behind the opening.
  const glow = ctx.createRadialGradient(TW / 2, (sy0 + sy1) / 2, 4, TW / 2, (sy0 + sy1) / 2, sw * 1.15);
  glow.addColorStop(0, 'rgba(255,214,150,0.34)');
  glow.addColorStop(0.28, 'rgba(150,150,230,0.3)');
  glow.addColorStop(0.6, 'rgba(99,102,241,0.12)');
  glow.addColorStop(1, 'rgba(99,102,241,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sx0 - sw * 0.6, sy0 - sh * 1.2, sw * 2.2, sh * 3.4);

  // backdrop inset with soft edge falloff.
  const topCol = hslToRgb(baseHue, 0.62, 0.55);
  const midCol = hslToRgb(baseHue + 40, 0.7, 0.5);
  const botCol = hslToRgb(baseHue + 70, 0.78, 0.52);
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx0, sy0, sw, sh);
  ctx.clip();
  const backdrop = ctx.createLinearGradient(0, sy0, 0, sy1);
  backdrop.addColorStop(0, `rgb(${topCol[0]},${topCol[1]},${topCol[2]})`);
  backdrop.addColorStop(0.5, `rgb(${midCol[0]},${midCol[1]},${midCol[2]})`);
  backdrop.addColorStop(1, `rgb(${botCol[0]},${botCol[1]},${botCol[2]})`);
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = backdrop;
  ctx.fillRect(sx0, sy0, sw, sh);
  ctx.globalAlpha = 1;
  const fall = ctx.createRadialGradient(TW / 2, (sy0 + sy1) / 2, sw * 0.12, TW / 2, (sy0 + sy1) / 2, sw * 0.6);
  fall.addColorStop(0, 'rgba(6,8,14,0)');
  fall.addColorStop(0.7, 'rgba(6,8,14,0.15)');
  fall.addColorStop(1, 'rgba(5,6,11,0.9)');
  ctx.fillStyle = fall;
  ctx.fillRect(sx0, sy0, sw, sh);
  ctx.restore();

  // performers.
  const perfCount = 3;
  const floorY = sy1 - sh * 0.08;
  for (let i = 0; i < perfCount; i++) {
    const t = (i + 1) / (perfCount + 1);
    drawPerformer(ctx, sx0 + sw * (0.24 + t * 0.52), floorY, sh * 0.46 * (0.9 + rand() * 0.24), {
      tone: [8, 10, 16],
      alpha: 0.9,
      pose: Math.floor(rand() * 4),
      rim: hslToRgb(baseHue + 20, 0.5, 0.7),
      rimStrength: 0.7,
    });
  }

  // masking wings + arch.
  ctx.fillStyle = '#05070d';
  ctx.fillRect(sx0 - sw * 0.5, archTop, sw * 0.5, sy1 - archTop);
  ctx.fillRect(sx1, archTop, sw * 0.5, sy1 - archTop);
  const legBot = sw * 0.05 + 2;
  const legTop = legBot * 1.35;
  ctx.fillStyle = '#03050a';
  ctx.beginPath();
  ctx.moveTo(sx0, sy1);
  ctx.lineTo(sx0 - legBot, sy1);
  ctx.lineTo(sx0 - legTop, archTop);
  ctx.lineTo(sx0 + sw * 0.012, archTop);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sx1, sy1);
  ctx.lineTo(sx1 + legBot, sy1);
  ctx.lineTo(sx1 + legTop, archTop);
  ctx.lineTo(sx1 - sw * 0.012, archTop);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(sx0 - legTop, archTop, sw + legTop * 2, (sy1 - archTop) * 0.13);
  ctx.fillStyle = `rgba(${rigTintStr},0.12)`;
  ctx.fillRect(sx0 - 1.2, archTop, 1.2, sy1 - archTop);
  ctx.fillRect(sx1, archTop, 1.2, sy1 - archTop);

  // stage floor front edge + footlights.
  ctx.fillStyle = '#0b0f18';
  ctx.fillRect(sx0 - legBot, sy1 - sh * 0.05, sw + legBot * 2, sh * 0.05 + 2);
  const foot = ctx.createLinearGradient(0, sy1 - sh * 0.05, 0, sy1 + sh * 0.14);
  foot.addColorStop(0, `rgba(255,206,140,${(0.5 * nearGlow).toFixed(3)})`);
  foot.addColorStop(1, 'rgba(255,206,140,0)');
  ctx.fillStyle = foot;
  ctx.fillRect(sx0 - legBot, sy1 - sh * 0.05, sw + legBot * 2, sh * 0.22);

  // tapered beams.
  for (let i = 0; i < 3; i++) {
    const t = (i + 1) / 4;
    const fx = sx0 + sw * t;
    const fy = pitchToTY(Math.min(HALF_VFOV - 1, stageTopPitch + 20));
    drawBeam(ctx, fx, fy, fx + (rand() - 0.5) * sw * 0.14, sy1, 3, sw * 0.09, rigTintStr, 0.17 * nearGlow);
    drawFixture(ctx, fx, fy, 1.8, rigTintStr);
  }

  // rig lights across the ceiling.
  ctx.fillStyle = `rgba(${rigTintStr},0.75)`;
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.arc(((i + 0.5) / 8) * TW, pitchToTY(HALF_VFOV - 4 - (i % 2) * 3), 2.2, 0, TAU);
    ctx.fill();
  }

  // seat-back rows in the foreground for depth.
  ctx.fillStyle = 'rgba(10,13,20,0.9)';
  ctx.fillRect(0, TH - 26, TW, 26);
  ctx.fillStyle = 'rgba(30,37,54,0.9)';
  for (let i = 0; i < 9; i++) {
    const bx = i * (TW / 9) + TW / 18;
    ctx.beginPath();
    ctx.ellipse(bx, TH - 22, (TW / 9) * 0.4, 15, 0, Math.PI, 0, true);
    ctx.fill();
  }

  return { url: canvas.toDataURL('image/jpeg', 0.8), distanceM: Math.round(distM) };
}
