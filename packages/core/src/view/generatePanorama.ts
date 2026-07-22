/**
 * Synthetic view-from-seat panorama, generated from chart geometry alone.
 *
 * Draws a 2048×1024 equirectangular texture of a dark hall with the stage
 * placed at the correct bearing and angular size for THIS seat — closer seats
 * see a bigger stage, off-center seats see it at an angle. Used whenever the
 * organizer hasn't uploaded a real photo/360 for the seat; both go through the
 * same viewer.
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

  // ---- room shell: ceiling → walls → floor -------------------------------
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#05070c');
  sky.addColorStop(0.42, '#11172a');
  sky.addColorStop(0.5, '#1a2238');
  sky.addColorStop(0.56, '#10141f');
  sky.addColorStop(1, '#07090f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // ---- stage, centered at yaw 0 (the viewer opens facing it) -------------
  // Angular size from real proportions: stage ~8m wide, ~1m platform + 6m set.
  // Pitch is eye-height-aware (Phase B2): a raised/raked seat looks down at it.
  const eyeM = seat.eyeHeightM ?? SEATED_EYE_HEIGHT_M;
  const stageHalfYaw = Math.min(80, (Math.atan2(4, distM) * 180) / Math.PI);
  const sightline = stageSightlinePitch(eyeM, distM);
  const stageTopPitch = Math.min(45, sightline.topPitch);
  const stageBasePitch = sightline.basePitch;

  const sx0 = yawToX(-stageHalfYaw);
  const sx1 = yawToX(stageHalfYaw);
  const sy0 = pitchToY(stageTopPitch);
  const sy1 = pitchToY(stageBasePitch);

  // glow behind the stage
  const glow = ctx.createRadialGradient(W / 2, (sy0 + sy1) / 2, 10, W / 2, (sy0 + sy1) / 2, (sx1 - sx0) * 1.1);
  glow.addColorStop(0, 'rgba(129, 140, 248, 0.5)');
  glow.addColorStop(0.5, 'rgba(99, 102, 241, 0.16)');
  glow.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sx0 - (sx1 - sx0) * 0.6, sy0 - (sy1 - sy0) * 1.2, (sx1 - sx0) * 2.2, (sy1 - sy0) * 3.4);

  // stage box + lit backdrop
  ctx.fillStyle = '#242c44';
  ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  const backdrop = ctx.createLinearGradient(0, sy0, 0, sy1);
  backdrop.addColorStop(0, '#7c5cff');
  backdrop.addColorStop(0.5, '#e1447a');
  backdrop.addColorStop(1, '#f59e0b');
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = backdrop;
  const inset = (sx1 - sx0) * 0.06;
  ctx.fillRect(sx0 + inset, sy0 + (sy1 - sy0) * 0.12, sx1 - sx0 - inset * 2, (sy1 - sy0) * 0.62);
  ctx.globalAlpha = 1;
  // stage lip
  ctx.fillStyle = '#0d1119';
  ctx.fillRect(sx0, sy1 - (sy1 - sy0) * 0.1, sx1 - sx0, (sy1 - sy0) * 0.1);

  // performer silhouettes, scaled by distance
  const performerH = (sy1 - sy0) * 0.45;
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
  const stageBearing = Math.atan2(dx, -dy); // screen coords, -y is "up" the hall
  ctx.fillStyle = 'rgba(16, 20, 30, 0.95)';
  for (const other of neighborSeats) {
    if (other.id === seat.id) continue;
    const ox = other.x - seat.x;
    const oy = other.y - seat.y;
    const d = Math.hypot(ox, oy) * UNIT;
    if (d < 0.3 || d > 14) continue;
    const bearing = Math.atan2(ox, -oy) - stageBearing;
    const yaw = ((((bearing * 180) / Math.PI + 540) % 360) - 180);
    const headPitch = (-Math.atan2(0.35, d) * 180) / Math.PI; // heads slightly below eye level
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
