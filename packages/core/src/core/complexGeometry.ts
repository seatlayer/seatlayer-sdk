import type { CubicPath, Point } from './types';

export type SectionShellMode = 'auto' | 'rectangle' | 'tapered' | 'bezier';

export function cubicPoint(path: CubicPath, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * path.start.x + b * path.control1.x + c * path.control2.x + d * path.end.x,
    y: a * path.start.y + b * path.control1.y + c * path.control2.y + d * path.end.y,
  };
}

/** Equal-arc-length points on a cubic path, including both endpoints. */
export function distributeAlongCubic(path: CubicPath, count: number, resolution = 192): Point[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('Path point count must be a positive integer');
  if (count === 1) return [cubicPoint(path, 0.5)];
  const samples = Array.from({ length: resolution + 1 }, (_, index) => cubicPoint(path, index / resolution));
  const lengths = new Float64Array(samples.length);
  for (let index = 1; index < samples.length; index += 1) {
    const dx = samples[index].x - samples[index - 1].x;
    const dy = samples[index].y - samples[index - 1].y;
    lengths[index] = lengths[index - 1] + Math.hypot(dx, dy);
  }
  const total = lengths[lengths.length - 1];
  if (total <= 1e-9) return Array.from({ length: count }, () => ({ ...path.start }));
  const output: Point[] = [];
  let segment = 1;
  for (let index = 0; index < count; index += 1) {
    const target = (total * index) / (count - 1);
    while (segment < lengths.length - 1 && lengths[segment] < target) segment += 1;
    const before = lengths[segment - 1];
    const after = lengths[segment];
    const ratio = after === before ? 0 : (target - before) / (after - before);
    output.push({
      x: samples[segment - 1].x + (samples[segment].x - samples[segment - 1].x) * ratio,
      y: samples[segment - 1].y + (samples[segment].y - samples[segment - 1].y) * ratio,
    });
  }
  return output;
}

function add(a: Point, b: Point): Point { return { x: a.x + b.x, y: a.y + b.y }; }
function sub(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function mul(a: Point, scale: number): Point { return { x: a.x * scale, y: a.y * scale }; }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function lerp(a: Point, b: Point, t: number): Point { return add(a, mul(sub(b, a), t)); }

function sample(path: CubicPath, count = 13): Point[] {
  return Array.from({ length: count }, (_, index) => cubicPoint(path, index / (count - 1)));
}

function pointOnSampledPath(points: Point[], t: number): Point {
  const scaled = Math.max(0, Math.min(1, t)) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  return lerp(points[index], points[index + 1], scaled - index);
}

function sampledPathSegment(points: Point[], from: number, to: number): Point[] {
  const start = Math.max(0, Math.min(1, from));
  const end = Math.max(start, Math.min(1, to));
  const output = [pointOnSampledPath(points, start)];
  for (let index = 1; index < points.length - 1; index += 1) {
    const t = index / (points.length - 1);
    if (t > start + 1e-9 && t < end - 1e-9) output.push(points[index]);
  }
  output.push(pointOnSampledPath(points, end));
  return output;
}

interface SectionFrame {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  normal: Point;
  depth: number;
}

function orientSectionFrame(corners: Point[], focal: Point): SectionFrame {
  const edges: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 0]];
  let nearEdge = 0;
  let nearDistance = Number.POSITIVE_INFINITY;
  edges.forEach(([a, b], index) => {
    const d = distance(lerp(corners[a], corners[b], 0.5), focal);
    if (d < nearDistance) {
      nearDistance = d;
      nearEdge = index;
    }
  });
  const p0 = corners[nearEdge];
  const p1 = corners[(nearEdge + 1) % 4];
  const p2 = corners[(nearEdge + 2) % 4];
  const p3 = corners[(nearEdge + 3) % 4];
  const nearMid = lerp(p0, p1, 0.5);
  const inward = sub(focal, nearMid);
  const inwardLength = Math.max(1e-9, Math.hypot(inward.x, inward.y));
  return {
    p0,
    p1,
    p2,
    p3,
    normal: mul(inward, 1 / inwardLength),
    depth: (distance(p0, p3) + distance(p1, p2)) / 2,
  };
}

function bezierSectionPaths(frame: SectionFrame): { nearPath: CubicPath; farPath: CubicPath } {
  const { p0, p1, p2, p3, normal, depth } = frame;
  const nearSpan = sub(p1, p0);
  const farSpan = sub(p2, p3);
  const nearCurve = depth * 0.22;
  const farCurve = depth * 0.12;
  return {
    nearPath: {
      start: p0,
      control1: add(add(p0, mul(nearSpan, 1 / 3)), mul(normal, nearCurve)),
      control2: add(add(p0, mul(nearSpan, 2 / 3)), mul(normal, nearCurve)),
      end: p1,
    },
    farPath: {
      start: p2,
      control1: add(add(p3, mul(farSpan, 2 / 3)), mul(normal, farCurve)),
      control2: add(add(p3, mul(farSpan, 1 / 3)), mul(normal, farCurve)),
      end: p3,
    },
  };
}

/**
 * Convert a server-mapped rectangle into an editable complex shell. The four
 * corners must be clockwise. No caller-supplied control points are accepted.
 */
export function buildSectionShell(corners: Point[], focal: Point, requested: SectionShellMode): {
  mode: Exclude<SectionShellMode, 'auto'>;
  outline: Point[];
} {
  if (corners.length !== 4) throw new Error('A section shell requires four mapped bounds corners');
  const center = corners.reduce((sum, point) => add(sum, point), { x: 0, y: 0 });
  center.x /= 4;
  center.y /= 4;
  const width = distance(corners[0], corners[1]);
  const height = distance(corners[0], corners[3]);
  const mode = requested === 'auto'
    ? (width > height * 1.25 && distance(center, focal) > height ? 'bezier' : 'tapered')
    : requested;
  if (mode === 'rectangle') return { mode, outline: corners.map((point) => ({ ...point })) };

  // Rotate corners so local p0→p1 is the edge nearest the focal point and
  // p3→p2 is the far edge, while preserving clockwise winding.
  const frame = orientSectionFrame(corners, focal);
  const { p0, p1, p2, p3 } = frame;

  if (mode === 'tapered') {
    const inset = 0.14;
    return {
      mode,
      outline: [
        add(p0, mul(sub(p1, p0), inset)),
        add(p0, mul(sub(p1, p0), 1 - inset)),
        p2,
        p3,
      ],
    };
  }

  const { nearPath, farPath } = bezierSectionPaths(frame);
  return { mode, outline: [...sample(nearPath), ...sample(farPath).slice(1)] };
}

/** Server-owned straight aisle cutouts spanning the near/far edges. */
export function buildAisleHoles(
  corners: Point[],
  focal: Point,
  count: number,
  mode: Exclude<SectionShellMode, 'auto'>,
): Point[][] {
  if (corners.length !== 4) throw new Error('Aisle generation requires four mapped bounds corners');
  if (!Number.isInteger(count) || count < 0 || count > 3) throw new Error('Aisle count must be an integer from 0 to 3');
  if (count === 0) return [];
  const frame = orientSectionFrame(corners, focal);
  const { p0, p1, p2, p3 } = frame;
  const paths = mode === 'bezier' ? bezierSectionPaths(frame) : null;
  // For curved shells, interpolate the same sampled polylines stored in the
  // document. Exact cubic points between samples can sit fractionally outside
  // their chord approximation and fail topology validation/hit clipping.
  const nearSamples = paths ? sample(paths.nearPath) : null;
  const farLateralSamples = paths ? sample(paths.farPath).reverse() : null;
  const widthFraction = Math.min(0.055, 0.18 / (count + 1));
  return Array.from({ length: count }, (_, index) => {
    const t = (index + 1) / (count + 1);
    const left = t - widthFraction / 2;
    const right = t + widthFraction / 2;
    if (nearSamples && farLateralSamples) {
      return [
        ...sampledPathSegment(nearSamples, left, right),
        ...sampledPathSegment(farLateralSamples, left, right).reverse(),
      ];
    }
    return [lerp(p0, p1, left), lerp(p0, p1, right), lerp(p3, p2, right), lerp(p3, p2, left)];
  });
}
