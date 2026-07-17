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
