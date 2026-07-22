import type { Point } from './types';

/** Axis-aligned chart bounds used to derive a stable, document-relative camera. */
export interface PerspectiveBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A deterministic pinhole camera for the projected 2.5D buyer/Designer views.
 * Coordinates stay in chart units so the ordinary Stage camera (pan/zoom) can
 * remain the only screen-space transform.
 */
export interface PerspectiveCamera {
  target: Point;
  /** Horizontal distance from target to camera, in chart units. */
  distance: number;
  /** Camera height above the chart datum, in chart units. */
  height: number;
  /** Pinhole focal length, in chart units. */
  focalLength: number;
  /** Small plan rotation which keeps the venue from reading as a flat elevation. */
  yawRad: number;
}

/** Canvas/Konva affine: x' = a·x + c·y + e; y' = b·x + d·y + f. */
export interface Affine2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface PerspectivePoint extends Point {
  /** Positive camera-space distance; larger values are farther away. */
  depth: number;
  /** Perspective size multiplier at this point (1 at the camera target). */
  scale: number;
}

/**
 * Choose a camera from venue bounds rather than fixed pixels. The camera rises
 * above the tallest authored surface, so even the (deliberately generous)
 * 120-m validation ceiling cannot cross the near plane.
 */
export function createPerspectiveCamera(
  bounds: PerspectiveBounds,
  maxSurfaceHeightWorld = 0,
): PerspectiveCamera {
  const span = Math.max(1, bounds.width, bounds.height);
  const target = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const distance = span * 1.55;
  const height = Math.max(span * 0.82, Math.max(0, maxSurfaceHeightWorld) + span * 0.45);
  return {
    target,
    distance,
    height,
    focalLength: Math.hypot(distance, height),
    yawRad: (-8 * Math.PI) / 180,
  };
}

/** Project one 3D chart point through the pinhole camera. */
export function projectPerspectivePoint(
  camera: PerspectiveCamera,
  point: Point,
  heightWorld = 0,
): PerspectivePoint {
  const dx = point.x - camera.target.x;
  const dy = point.y - camera.target.y;
  const cos = Math.cos(camera.yawRad);
  const sin = Math.sin(camera.yawRad);
  const x = dx * cos - dy * sin;
  const y = dx * sin + dy * cos;
  const translatedY = y - camera.distance;
  const translatedZ = heightWorld - camera.height;
  const cameraLength = Math.hypot(camera.distance, camera.height);
  const depth = (-camera.distance * translatedY - camera.height * translatedZ) / cameraLength;
  const up = (-camera.height * translatedY + camera.distance * translatedZ) / cameraLength;
  // Camera construction keeps authored surfaces in front of the near plane.
  // The clamp is still a fail-safe for malformed data loaded without validation.
  const safeDepth = Math.max(cameraLength * 0.08, depth);
  const scale = camera.focalLength / safeDepth;
  return {
    x: camera.target.x + x * scale,
    y: camera.target.y - up * scale,
    depth: safeDepth,
    scale,
  };
}

export function applyAffine(affine: Affine2D, point: Point): Point {
  return {
    x: affine.a * point.x + affine.c * point.y + affine.e,
    y: affine.b * point.x + affine.d * point.y + affine.f,
  };
}

export function invertAffine(affine: Affine2D): Affine2D {
  const determinant = affine.a * affine.d - affine.b * affine.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
    throw new Error('perspective projection produced a singular affine');
  }
  const a = affine.d / determinant;
  const b = -affine.b / determinant;
  const c = -affine.c / determinant;
  const d = affine.a / determinant;
  return {
    a,
    b,
    c,
    d,
    e: -(a * affine.e + c * affine.f),
    f: -(b * affine.e + d * affine.f),
  };
}

/** Return `left(right(point))`. */
export function composeAffine(left: Affine2D, right: Affine2D): Affine2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

/**
 * First-order projection around one object/section anchor. The height callback
 * may describe a raked surface; sampling one chart unit along x/y captures its
 * local slope. Per-section tangents are the intentional shell-performance
 * contract. Buyer seat anchors are projected exactly by `projectPerspectivePoint`;
 * only non-interactive section surfaces use this bounded approximation.
 */
export function perspectiveTangentAffine(
  camera: PerspectiveCamera,
  anchor: Point,
  heightAt: (point: Point) => number = () => 0,
): Affine2D {
  const origin = projectPerspectivePoint(camera, anchor, heightAt(anchor));
  const alongXPoint = { x: anchor.x + 1, y: anchor.y };
  const alongYPoint = { x: anchor.x, y: anchor.y + 1 };
  const alongX = projectPerspectivePoint(camera, alongXPoint, heightAt(alongXPoint));
  const alongY = projectPerspectivePoint(camera, alongYPoint, heightAt(alongYPoint));
  const a = alongX.x - origin.x;
  const b = alongX.y - origin.y;
  const c = alongY.x - origin.x;
  const d = alongY.y - origin.y;
  return {
    a,
    b,
    c,
    d,
    e: origin.x - a * anchor.x - c * anchor.y,
    f: origin.y - b * anchor.x - d * anchor.y,
  };
}

/** Parameters accepted by Konva's rotation/scale/skew decomposition. */
export function decomposeAffineLinear(affine: Affine2D): {
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
} {
  const scaleX = Math.hypot(affine.a, affine.b);
  const determinant = affine.a * affine.d - affine.b * affine.c;
  return {
    rotationDeg: (Math.atan2(affine.b, affine.a) * 180) / Math.PI,
    scaleX,
    scaleY: determinant / Math.max(scaleX, 1e-9),
    skewX: (affine.a * affine.c + affine.b * affine.d) / Math.max(determinant, 1e-9),
  };
}
