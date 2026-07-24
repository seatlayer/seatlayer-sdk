/**
 * Pure, DOM/GPU-free maths for the fly-to-seat cinematic — spline, timing, and
 * waypoint construction. Split from cinematic.ts (which imports OGL) so this is
 * unit-testable in a plain runtime.
 */

export const FLIGHT_DURATION_MS = 2500;
export const FOV_START = 35;
export const FOV_END = 28;
/** Orientation t leads position t by this much (clamped) — aim before arrival. */
export const ORIENTATION_LEAD = 0.15;
/** Final approach: this far behind the seat (≈2–3 rows) and above its eye. */
const BACK_M = 2.5;
const ABOVE_EYE_M = 1.5;

export type Vec3Arr = [number, number, number];

function sub(a: Vec3Arr, b: Vec3Arr): Vec3Arr { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3Arr, b: Vec3Arr): Vec3Arr { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3Arr, k: number): Vec3Arr { return [a[0] * k, a[1] * k, a[2] * k]; }
function norm(a: Vec3Arr): Vec3Arr {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-6 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Smootherstep (Ken Perlin) — zero 1st & 2nd derivatives at the ends. */
export function smootherstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Orientation t = position t nudged ahead by `lead`, clamped to [0,1]. */
export function orientationLeadT(posT: number, lead: number): number {
  return Math.max(0, Math.min(1, posT + lead));
}

/**
 * Uniform multi-segment Catmull-Rom passing THROUGH every waypoint. `u` in
 * [0,1] spans the whole path; endpoints are duplicated for tangents.
 */
export function catmullRom(points: Vec3Arr[], u: number): Vec3Arr {
  const n = points.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return [...points[0]];
  const cu = Math.max(0, Math.min(1, u));
  const segCount = n - 1;
  let seg = Math.floor(cu * segCount);
  if (seg >= segCount) seg = segCount - 1;
  const t = cu * segCount - seg;
  const p0 = points[Math.max(0, seg - 1)];
  const p1 = points[seg];
  const p2 = points[seg + 1];
  const p3 = points[Math.min(n - 1, seg + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  const out: Vec3Arr = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = 0.5 * (
      2 * p1[i]
      + (-p0[i] + p2[i]) * t
      + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2
      + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3
    );
  }
  return out;
}

/**
 * Build the flight waypoints from the current camera position to a seat. The
 * mid arc is pushed OUTSIDE the venue bounds sphere and high up, so the swoop
 * never clips through the tier solids; the final anchor sits behind + above the
 * seat, looking toward the focal point.
 */
export function buildWaypoints(
  start: Vec3Arr,
  seatEye: Vec3Arr,
  focal: Vec3Arr,
  center: Vec3Arr,
  radius: number,
): { waypoints: Vec3Arr[]; finalPos: Vec3Arr } {
  let away = norm(sub(seatEye, focal)); // "behind" the seat (away from stage)
  if (away[0] === 0 && away[1] === 0 && away[2] === 0) away = [0, 0, 1];
  const finalPos = add(add(seatEye, scale(away, BACK_M)), [0, ABOVE_EYE_M, 0]);

  const horiz: Vec3Arr = [seatEye[0] - center[0], 0, seatEye[2] - center[2]];
  let hn = norm(horiz);
  if (hn[0] === 0 && hn[2] === 0) hn = [away[0], 0, away[2]];
  const r = Math.max(1, radius);
  const arc: Vec3Arr = [
    center[0] + hn[0] * r * 1.3,
    center[1] + r * 0.75,
    center[2] + hn[2] * r * 1.3,
  ];
  return { waypoints: [start, arc, finalPos], finalPos };
}

export interface FlightSample {
  pos: Vec3Arr;
  fov: number;
  /** Eased position parameter (drives the orientation lead). */
  eased: number;
}

/** Sample the flight at raw parameter `u` in [0,1]. */
export function sampleFlight(waypoints: Vec3Arr[], u: number, fovStart = FOV_START, fovEnd = FOV_END): FlightSample {
  const eased = smootherstep(u);
  const pos = catmullRom(waypoints, eased);
  const fovT = smootherstep(Math.max(0, Math.min(1, (u - 0.66) / 0.34))); // push-in over final third
  return { pos, fov: fovStart + (fovEnd - fovStart) * fovT, eased };
}
