import type { Point, SectionOutlinePath, SectionPathSegment } from './types';

const TAU = Math.PI * 2;

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function arcSweep(start: number, end: number, clockwise: boolean): number {
  let delta = end - start;
  if (clockwise) {
    while (delta < 0) delta += TAU;
    while (delta >= TAU) delta -= TAU;
  } else {
    while (delta > 0) delta -= TAU;
    while (delta <= -TAU) delta += TAU;
  }
  return delta;
}

export function sectionPathSegmentEnd(segment: SectionPathSegment): Point {
  return segment.end;
}

/** Validate finite, continuous closed-path geometry without trusting renderer
 * behaviour. Arc endpoints must lie on their declared circle. */
export function validSectionOutlinePath(path: SectionOutlinePath): boolean {
  if (path.version !== 1 || path.closed !== true || !finitePoint(path.start)
    || !Array.isArray(path.segments) || path.segments.length < 2 || path.segments.length > 512) return false;
  let current = path.start;
  for (const segment of path.segments) {
    if (!segment || !finitePoint(segment.end)) return false;
    if (segment.kind === 'line') {
      if (distance(current, segment.end) <= 1e-9) return false;
    } else if (segment.kind === 'bezier') {
      if (!finitePoint(segment.control1) || !finitePoint(segment.control2)
        || distance(current, segment.end) <= 1e-9) return false;
    } else if (segment.kind === 'arc') {
      if (!finitePoint(segment.center) || !Number.isFinite(segment.radius) || segment.radius <= 1e-6
        || Math.abs(distance(current, segment.center) - segment.radius) > Math.max(1e-4, segment.radius * 1e-4)
        || Math.abs(distance(segment.end, segment.center) - segment.radius) > Math.max(1e-4, segment.radius * 1e-4)
        || distance(current, segment.end) <= 1e-9) return false;
    } else return false;
    current = segment.end;
  }
  return distance(current, path.start) <= 1e-4;
}

function cubicPoint(start: Point, segment: Extract<SectionPathSegment, { kind: 'bezier' }>, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * start.x + 3 * mt ** 2 * t * segment.control1.x
      + 3 * mt * t ** 2 * segment.control2.x + t ** 3 * segment.end.x,
    y: mt ** 3 * start.y + 3 * mt ** 2 * t * segment.control1.y
      + 3 * mt * t ** 2 * segment.control2.y + t ** 3 * segment.end.y,
  };
}

/** Deterministic polygon sample used by validation, hit testing, diff, and old
 * clients. The returned loop omits the duplicate closing point. */
export function sampleSectionOutlinePath(path: SectionOutlinePath, maxStep = 2): Point[] {
  if (!validSectionOutlinePath(path)) throw new Error('Section outline path is invalid');
  const step = Math.max(0.25, maxStep);
  const points: Point[] = [{ ...path.start }];
  let current = path.start;
  for (const segment of path.segments) {
    if (segment.kind === 'line') {
      points.push({ ...segment.end });
    } else if (segment.kind === 'arc') {
      const startAngle = Math.atan2(current.y - segment.center.y, current.x - segment.center.x);
      const endAngle = Math.atan2(segment.end.y - segment.center.y, segment.end.x - segment.center.x);
      const sweep = arcSweep(startAngle, endAngle, segment.clockwise);
      const count = Math.max(2, Math.ceil(Math.abs(sweep) * segment.radius / step));
      for (let index = 1; index <= count; index += 1) {
        const angle = startAngle + sweep * index / count;
        points.push({
          x: segment.center.x + Math.cos(angle) * segment.radius,
          y: segment.center.y + Math.sin(angle) * segment.radius,
        });
      }
    } else {
      const controlLength = distance(current, segment.control1)
        + distance(segment.control1, segment.control2)
        + distance(segment.control2, segment.end);
      const count = Math.max(2, Math.ceil(controlLength / step));
      for (let index = 1; index <= count; index += 1) points.push(cubicPoint(current, segment, index / count));
    }
    current = segment.end;
  }
  if (distance(points[points.length - 1], points[0]) <= 1e-4) points.pop();
  return points;
}

export function translateSectionOutlinePath(path: SectionOutlinePath, dx: number, dy: number): SectionOutlinePath {
  const translate = (point: Point): Point => ({ x: point.x + dx, y: point.y + dy });
  return transformSectionOutlinePath(path, translate);
}

/** Apply a similarity transform. Callers provide the point transform and the
 * absolute radius scale; reflections toggle arc direction. */
export function transformSectionOutlinePath(
  path: SectionOutlinePath,
  transform: (point: Point) => Point,
  radiusScale = 1,
  reflected = false,
): SectionOutlinePath {
  return {
    ...path,
    start: transform(path.start),
    segments: path.segments.map((segment) => segment.kind === 'line'
      ? { ...segment, end: transform(segment.end) }
      : segment.kind === 'arc'
        ? {
            ...segment,
            center: transform(segment.center),
            radius: segment.radius * Math.abs(radiusScale),
            clockwise: reflected ? !segment.clockwise : segment.clockwise,
            end: transform(segment.end),
          }
        : {
            ...segment,
            control1: transform(segment.control1),
            control2: transform(segment.control2),
            end: transform(segment.end),
          }),
  };
}

/** Default corner-smoothing strength applied automatically when a hand-clicked
 * polygon section is closed. Wide, gently-angled corners round; sharp structural
 * corners stay crisp, so a rectangle drawn as a polygon is left untouched. */
export const DEFAULT_SECTION_CORNER_SMOOTHING = 45;

/** Only corners at least this wide (interior angle, degrees) are rounded — the
 * arc-approximating points of a hand-traced wedge, not its true corners. */
const WIDE_ANGLE_THRESHOLD_DEG = 150;

/** Circle-approximation constant: control-point pull from a cut point toward the
 * original vertex for a smooth cubic corner. */
const CORNER_KAPPA = 0.5523;

function polygonPointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= 1e-6 && Math.abs(a.y - b.y) <= 1e-6;
}

/** Drop consecutive duplicate vertices and any wrap-around duplicate close point. */
function dedupeClosedPolygon(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    if (!finitePoint(point)) continue;
    if (out.length && polygonPointsEqual(out[out.length - 1], point)) continue;
    out.push({ x: point.x, y: point.y });
  }
  while (out.length > 1 && polygonPointsEqual(out[0], out[out.length - 1])) out.pop();
  return out;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * Build a smooth closed {@link SectionOutlinePath} by rounding the wide corners
 * of a hand-clicked polygon. The polygon stays authoritative — this is a purely
 * additive rendered curve. Returns `null` when nothing qualifies (strength 0, a
 * degenerate polygon, or no corner wide enough), letting the caller keep the raw
 * straight polygon. Deterministic: same input always yields the same path.
 */
export function sectionCornerSmoothingPath(
  polygon: Point[],
  strength: number,
  options?: { wideAngleThresholdDeg?: number },
): SectionOutlinePath | null {
  const pts = dedupeClosedPolygon(polygon);
  const n = pts.length;
  if (n < 3) return null;
  const s = Math.min(100, Math.max(0, strength)) / 100;
  if (s <= 0) return null;
  const threshold = options?.wideAngleThresholdDeg ?? WIDE_ANGLE_THRESHOLD_DEG;

  const edgeLen: number[] = [];
  for (let i = 0; i < n; i += 1) edgeLen[i] = distance(pts[i], pts[(i + 1) % n]);

  // Per-vertex corner cut distance. Wide (near-straight) corners round most;
  // corners sharper than the threshold are left untouched.
  const cut: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const toPrev = { x: prev.x - curr.x, y: prev.y - curr.y };
    const toNext = { x: next.x - curr.x, y: next.y - curr.y };
    const lenPrev = Math.hypot(toPrev.x, toPrev.y);
    const lenNext = Math.hypot(toNext.x, toNext.y);
    if (lenPrev <= 1e-9 || lenNext <= 1e-9) continue;
    const cos = Math.min(1, Math.max(-1, (toPrev.x * toNext.x + toPrev.y * toNext.y) / (lenPrev * lenNext)));
    const interiorDeg = (Math.acos(cos) * 180) / Math.PI;
    if (interiorDeg < threshold) continue; // sharp structural corner — keep crisp
    const weight = smoothstep((interiorDeg - threshold) / (180 - threshold));
    cut[i] = s * weight * 0.5 * Math.min(lenPrev, lenNext);
  }

  // Never let two neighbouring cuts overrun a shared edge.
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const total = cut[i] + cut[j];
    if (total > edgeLen[i] && total > 1e-9) {
      const scale = edgeLen[i] / total;
      cut[i] *= scale;
      cut[j] *= scale;
    }
  }

  const entry: Point[] = new Array(n); // point on the incoming edge, before the vertex
  const exit: Point[] = new Array(n); // point on the outgoing edge, after the vertex
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    if (cut[i] <= 1e-6) {
      entry[i] = { ...curr };
      exit[i] = { ...curr };
      continue;
    }
    const lenPrev = distance(curr, prev) || 1;
    const lenNext = distance(curr, next) || 1;
    entry[i] = { x: curr.x + ((prev.x - curr.x) / lenPrev) * cut[i], y: curr.y + ((prev.y - curr.y) / lenPrev) * cut[i] };
    exit[i] = { x: curr.x + ((next.x - curr.x) / lenNext) * cut[i], y: curr.y + ((next.y - curr.y) / lenNext) * cut[i] };
  }

  // Nothing rounded → let the caller keep the straight polygon.
  if (cut.every((c) => c <= 1e-6)) return null;

  const segments: SectionPathSegment[] = [];
  const start = { ...exit[0] };
  let current = start;
  const pushLine = (end: Point) => {
    if (distance(current, end) > 1e-9) {
      segments.push({ kind: 'line', end: { ...end } });
      current = end;
    }
  };
  for (let step = 1; step <= n; step += 1) {
    const i = step % n;
    const vertex = pts[i];
    // Straight run along the edge from the previous exit to this vertex's entry.
    pushLine(entry[i]);
    if (cut[i] > 1e-6 && distance(entry[i], exit[i]) > 1e-9) {
      // Rounded corner: a cubic pulling toward the original vertex.
      segments.push({
        kind: 'bezier',
        control1: lerp(entry[i], vertex, CORNER_KAPPA),
        control2: lerp(exit[i], vertex, CORNER_KAPPA),
        end: { ...exit[i] },
      });
      current = exit[i];
    }
  }
  if (segments.length < 2) return null;
  // Guarantee exact closure onto the start point.
  const last = segments[segments.length - 1];
  if (distance(last.end, start) > 1e-9) {
    if (last.kind === 'line') last.end = { ...start };
    else segments.push({ kind: 'line', end: { ...start } });
  }
  const path: SectionOutlinePath = { version: 1, closed: true, start, segments };
  return validSectionOutlinePath(path) ? path : null;
}

/** Reverse a closed path without changing its painted boundary. */
export function reverseSectionOutlinePath(path: SectionOutlinePath): SectionOutlinePath {
  const starts: Point[] = [];
  let current = path.start;
  for (const segment of path.segments) {
    starts.push(current);
    current = segment.end;
  }
  const segments: SectionPathSegment[] = [];
  for (let index = path.segments.length - 1; index >= 0; index -= 1) {
    const segment = path.segments[index];
    const end = starts[index];
    if (segment.kind === 'line') segments.push({ kind: 'line', end: { ...end } });
    else if (segment.kind === 'arc') segments.push({
      kind: 'arc', center: { ...segment.center }, radius: segment.radius,
      clockwise: !segment.clockwise, end: { ...end },
    });
    else segments.push({
      kind: 'bezier', control1: { ...segment.control2 }, control2: { ...segment.control1 }, end: { ...end },
    });
  }
  return { version: 1, closed: true, start: { ...path.start }, segments };
}
