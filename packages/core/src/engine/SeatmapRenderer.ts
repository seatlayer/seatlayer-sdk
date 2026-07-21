/**
 * SeatmapRenderer — the shared canvas rendering core (buyer picker shell).
 *
 * Uses Konva directly with per-module imports to keep the bundle lean. The
 * whole point of the spike is staying smooth at ~5,000 seats on mobile, so the
 * hot paths lean on: layer bitmap caching + listening(false) when zoomed out,
 * per-seat fill updates (never full rebuilds) on status change, and viewport-
 * only label rendering rebuilt on interaction-end rather than per frame.
 */

// Core (not Global): Core assembles the real Konva namespace — Global alone
// lacks DD/Util and Stage._pointermove dereferences Konva.DD unconditionally.
import { Konva } from 'konva/lib/Core';
import { Stage } from 'konva/lib/Stage';
import { Layer } from 'konva/lib/Layer';
import { Group } from 'konva/lib/Group';
import { Circle } from 'konva/lib/shapes/Circle';
import { Rect } from 'konva/lib/shapes/Rect';
import { Ellipse } from 'konva/lib/shapes/Ellipse';
import { Line } from 'konva/lib/shapes/Line';
import { Text } from 'konva/lib/shapes/Text';
import { Path } from 'konva/lib/shapes/Path';
import { Image as KImage } from 'konva/lib/shapes/Image';
import type { KonvaEventObject } from 'konva/lib/Node';
import { Shape } from 'konva/lib/Shape';

import type {
  AccessibilityType,
  ChartDoc,
  ChartTheme,
  ExpandedSeat,
  ISeatmapRenderer,
  LodRung,
  Point,
  RenderedBookableLabelEvidence,
  RenderedGAAreaEvidence,
  RenderedFreeTextEvidence,
  RendererQualityEvidence,
  RendererOptions,
  SeatStatus,
  SectionOutlinePath,
  SectionObject,
} from '../core/types';
import { accessibilityRingColor } from '../core/types';
import { chartBounds, expandChart, floorsOf, pointInPolygonWithHoles, polygonLabelPoint, stackFloors } from '../core/layout';
import {
  ACCESS_GLYPH_PATH,
  ACCESS_GLYPH_VIEWBOX,
  BOOTH_LABEL_FONT_SIZE,
  GA_CAPACITY_LABEL_FONT_SIZE,
  GA_FILL_OPACITY,
  GA_LABEL_FONT_SIZE,
  MIN_VISIBLE_BOOKABLE_LABEL_PX,
  SEAT_LABEL_FONT_SIZE,
  bookableMarkerLabel,
  compositeHexOver,
  isBookableLabelLegibleAtScale,
  stateAwareBookableLabelInk,
} from '../core/chartRenderRules';
import { t } from '../i18n';
import { formatMoney } from '../lib/money';

const SEAT_RADIUS = 9;
/** Absolute scale at which a seat (r=9) renders ~legibly (~8px). */
const SEAT_LEGIBLE_SCALE = 0.9;
/** Below this absolute scale we swap seats for a cached bitmap. */
const CACHE_THRESHOLD = 0.55 * SEAT_LEGIBLE_SCALE;
/** First scale where a 7u seat label reaches the shared rendered-size floor. */
const LABEL_SCALE = MIN_VISIBLE_BOOKABLE_LABEL_PX / SEAT_LABEL_FONT_SIZE;
const MIN_FITTED_SEAT_LABEL_FONT_SIZE = 4;
/** Extra screen-px of slack around a seat circle that still counts as a tap on
 *  it. Gives small seats a finger-friendly hit target (§4 "hit ≥ 24px") so a
 *  near-miss on mobile still selects the nearest seat instead of doing nothing. */
const SEAT_TAP_SLOP_PX = 14;
/**
 * Min effective on-screen seat radius (CSS px) at which the accessibility glyph
 * becomes legible and is drawn centred on the seat. Below this the seat is too
 * small for a symbol, so the coloured ring alone carries the accommodation.
 */
const SEAT_GLYPH_MIN_PX = 6.5;
/** At/below this scale, sections read as clean labelled shells (seats hidden). */
const SECTION_PROMINENT_SCALE = 0.45 * SEAT_LEGIBLE_SCALE;
/**
 * Above this scale, seats are fully shown (dots); between here and
 * SECTION_PROMINENT the block melts in. Set high so a big sectioned chart OPENS
 * as named blocks and only reveals seats once you zoom in close.
 */
const BLOCK_MELT_TOP = 0.9 * SEAT_LEGIBLE_SCALE;
/** Camera scale used after a section drill-in. Keeping this above the block
 * melt band guarantees that a section tap lands on live, legible seats even
 * when a narrow phone viewport cannot frame the whole section at that scale. */
const SEAT_FOCUS_SCALE = Math.max(SEAT_LEGIBLE_SCALE * 1.1, BLOCK_MELT_TOP);
/** Ignore normal finger jitter before treating a tap as a map pan. */
const PAN_START_SLOP_PX = 8;
/**
 * Below this scale, ZONE blocks/labels take over from per-section detail (the
 * farthest rung). ~0.55× the section rung so: seats → section blocks → zones.
 */
const ZONE_PROMINENT_SCALE = 0.55 * SECTION_PROMINENT_SCALE;
/** Never label more than this many seats at once (viewport clutter guard). */
const MAX_LABELS = 700;
/**
 * Manage-mode marquee: above this many selected seats we stop drawing per-seat
 * selection-ring nodes (they'd be an invisible speck at that zoom and a huge
 * node count on a 13k arena) and rely on the seat-fill selection paint instead.
 * Selection membership (getSelection / bulk block) is unaffected.
 */
const MARQUEE_RING_CAP = 2500;

// ---- Isometric ("3D") view mode -------------------------------------------
/** Full-iso rotation of the chart about its centre (degrees). */
const ISO_ANGLE_DEG = -11.5;
/** Full-iso vertical squash (1 = flat). */
const ISO_SQUASH = 0.58;
/** World units a section (and its members) lift per elevation step at full iso. */
const LIFT_PER_STEP = 58;
/** Flat⇄iso tween duration (ms); reduced-motion snaps. */
const ISO_TWEEN_MS = 320;
/** Buyer camera travel should be easy to follow without feeling sluggish. */
const CAMERA_GLIDE_MS = 650;

// ---- Section/zone LOD ("melt") tuning -------------------------------------
/** Section overview is a semantic hierarchy, not a price/availability heatmap. */
const BLOCK_FILL_ALPHA = 1;
const SECTION_STROKE_PX = 2;
const LIGHT_OVERVIEW_SECTION_FILL = '#e5e7eb';
const LIGHT_OVERVIEW_SECTION_STROKE = '#c7cbd1';
const LIGHT_OVERVIEW_SECTION_INK = '#595f69';
const LIGHT_OVERVIEW_FOCAL_FILL = '#d1d5db';
const LIGHT_OVERVIEW_FOCAL_STROKE = '#b8bdc4';
const DARK_OVERVIEW_SECTION_FILL = '#273142';
const DARK_OVERVIEW_SECTION_STROKE = '#526078';
const DARK_OVERVIEW_SECTION_INK = '#f1f5f9';
const DARK_OVERVIEW_FOCAL_FILL = '#374151';
const DARK_OVERVIEW_FOCAL_STROKE = '#64748b';
/** Screen-space target sizes (px) for scale-compensated section/zone labels. */
const SECTION_LABEL_PX = 20;
const MIN_SECTION_LABEL_PX = 12;
const ZONE_LABEL_PX = 18;
const ZONE_SUB_PX = 12;
const HIERARCHY_PILL_BACKGROUND = '#111827';

const HELD_FILL = '#6b7280';
const TAKEN_FILL = '#374151';
const NFS_STROKE = '#4b5563';
/** Phase 2 event-level `closed` section: a flat desaturated slate block (label
 *  kept), distinct from the per-seat availability-grey. Seats inside read grey
 *  at 40% and are not pickable (per chart-design-standards §3). */
const CLOSED_SEAT_FILL = '#4b5563';
const CLOSED_SEAT_OPACITY = 0.4;
/** AXS section-focus: non-focused sections dim to this opacity. */
const FOCUS_DIM_OPACITY = 0.16;
/** Light/neutral backdrop panel drawn behind the focused section's seats. */
const FOCUS_BACKDROP_FILL = 'rgba(244,246,248,0.06)';
/** Okabe-Ito colorblind-safe hues (black dropped — unreadable on dark charts).
 *  Categories map to these by their doc order when colorblind mode is on. */
const CB_PALETTE = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'];

/** Does a seat satisfy a filter? `[]` means "any accessible seat". */
function seatMatchesAccess(seat: ExpandedSeat, filter: AccessibilityType[]): boolean {
  if (filter.length === 0) return !!seat.accessible;
  return !!seat.accessibility?.some((t) => filter.includes(t));
}

// Theme fallbacks (dark defaults) — used when doc.theme leaves a slot unset.
const DEF_SEAT_LABEL = '#0b1220';
const DEF_SELECTION = '#ffffff';
/** Selection/hover ring on LIGHT canvases — a white ring vanishes there. */
const DEF_SELECTION_ON_LIGHT = '#0b1220';
const DEF_DECOR_FILL = '#232c40';
const DEF_TEXT = '#8b93a7';
const DEF_CANVAS_BACKGROUND = '#0e1117';

/**
 * Relative luminance (0..1) of a CSS color — supports #rgb, #rrggbb and
 * rgb()/rgba(). Returns NaN for anything unparseable (gradients, ''), which
 * callers must treat as "unknown → assume dark" to preserve dark defaults.
 */
function colorLuminance(color: string): number {
  const s = color.trim();
  let r = NaN;
  let g = NaN;
  let b = NaN;
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
    if (rgb) {
      r = +rgb[1];
      g = +rgb[2];
      b = +rgb[3];
    }
  }
  if (Number.isNaN(r)) return NaN;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Light enough that white UI accents (selection ring) lose contrast. */
function isLightColor(color: string): boolean {
  const lum = colorLuminance(color);
  return !Number.isNaN(lum) && lum > 0.6;
}

/** Normalize the opaque CSS colours used by supported buyer surfaces. */
function opaqueColorHex(color: string): string | null {
  const value = color.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
  if (hex) {
    const expanded = hex[1].length === 3
      ? hex[1].split('').map((channel) => channel + channel).join('')
      : hex[1];
    return `#${expanded.toLowerCase()}`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!rgb || (rgb[4] != null && Number(rgb[4]) < 0.999)) return null;
  const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

interface OverviewPalette {
  sectionFill: string;
  sectionStroke: string;
  sectionInk: string;
  focalFill: string;
  focalStroke: string;
}

function overviewPalette(canvasBackground: string): OverviewPalette {
  return isLightColor(canvasBackground)
    ? {
        sectionFill: LIGHT_OVERVIEW_SECTION_FILL,
        sectionStroke: LIGHT_OVERVIEW_SECTION_STROKE,
        sectionInk: LIGHT_OVERVIEW_SECTION_INK,
        focalFill: LIGHT_OVERVIEW_FOCAL_FILL,
        focalStroke: LIGHT_OVERVIEW_FOCAL_STROKE,
      }
    : {
        sectionFill: DARK_OVERVIEW_SECTION_FILL,
        sectionStroke: DARK_OVERVIEW_SECTION_STROKE,
        sectionInk: DARK_OVERVIEW_SECTION_INK,
        focalFill: DARK_OVERVIEW_FOCAL_FILL,
        focalStroke: DARK_OVERVIEW_FOCAL_STROKE,
      };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Read a custom attr off an event target (Stage | Shape union isn't callable directly). */
function seatIdOf(target: unknown): string | undefined {
  const n = target as { getAttr?: (k: string) => unknown } | null;
  return (n?.getAttr?.('seatId') as string | undefined) ?? undefined;
}

/** Mix a #rrggbb colour toward white by `amt` (0..1). */
function lighten(hex: string, amt: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `#${((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1)}`;
}

/** Mix a #rrggbb colour toward black by `amt` (0..1). */
function darken(hex: string, amt: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c * (1 - amt));
  return `#${((1 << 24) | (mix((n >> 16) & 255) << 16) | (mix((n >> 8) & 255) << 8) | mix(n & 255)).toString(16).slice(1)}`;
}

/** Axis-aligned bounds of a polygon (no padding). */
function polyBounds(pts: Point[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function rotatedRectPoints(center: Point, width: number, height: number, rotation: number): Point[] {
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ].map((point) => ({
    x: center.x + point.x * cos - point.y * sin,
    y: center.y + point.x * sin + point.y * cos,
  }));
}

function pointsBounds(points: Point[]): { x: number; y: number; width: number; height: number } {
  const bounds = polyBounds(points);
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

/**
 * Prove the whole rotated label rectangle remains on the filled shell. Sampling
 * a small grid (rather than corners alone) also catches a concave edge or aisle
 * hole passing through the middle of otherwise-valid corners.
 */
function rotatedRectFitsPolygon(
  center: Point,
  width: number,
  height: number,
  rotation: number,
  outer: Point[],
  holes: Point[][],
): boolean {
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  for (let yStep = 0; yStep <= 4; yStep++) {
    for (let xStep = 0; xStep <= 6; xStep++) {
      const localX = width * (xStep / 6 - 0.5);
      const localY = height * (yStep / 4 - 0.5);
      const point = {
        x: center.x + localX * cos - localY * sin,
        y: center.y + localX * sin + localY * cos,
      };
      if (!pointInPolygonWithHoles(point, outer, holes)) return false;
    }
  }
  return true;
}

/** Centre-first interior anchors used when a hole/concavity occupies the shell centre. */
function polygonLabelCandidates(outer: Point[], holes: Point[][], preferred: Point): Point[] {
  const bounds = polyBounds(outer);
  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const points: Point[] = [preferred];
  for (let row = 1; row < 12; row += 1) {
    for (let column = 1; column < 12; column += 1) {
      const point = {
        x: bounds.x + bounds.width * column / 12,
        y: bounds.y + bounds.height * row / 12,
      };
      if (pointInPolygonWithHoles(point, outer, holes)) points.push(point);
    }
  }
  return points
    .sort((left, right) => Math.hypot(left.x - centre.x, left.y - centre.y)
      - Math.hypot(right.x - centre.x, right.y - centre.y))
    .filter((point, index, all) => index === all.findIndex((other) => (
      Math.abs(other.x - point.x) < 1e-6 && Math.abs(other.y - point.y) < 1e-6
    )));
}

function polygonWithHolesShape(
  outer: Point[],
  holes: Point[][] | undefined,
  attrs: { fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; listening?: boolean },
  outerPath?: SectionOutlinePath,
): Shape {
  const signedArea = (points: Point[]): number => points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const outerClockwise = signedArea(outer) > 0;
  return new Shape({
    ...attrs,
    sceneFunc(context, shape) {
      context.beginPath();
      const polygonPath = (points: Point[]) => {
        if (!points.length) return;
        context.moveTo(points[0].x, points[0].y);
        for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
        context.closePath();
      };
      const vectorPath = (path: SectionOutlinePath) => {
        context.moveTo(path.start.x, path.start.y);
        let current = path.start;
        for (const segment of path.segments) {
          if (segment.kind === 'line') context.lineTo(segment.end.x, segment.end.y);
          else if (segment.kind === 'arc') context.arc(
            segment.center.x,
            segment.center.y,
            segment.radius,
            Math.atan2(current.y - segment.center.y, current.x - segment.center.x),
            Math.atan2(segment.end.y - segment.center.y, segment.end.x - segment.center.x),
            !segment.clockwise,
          );
          else context.bezierCurveTo(
            segment.control1.x, segment.control1.y,
            segment.control2.x, segment.control2.y,
            segment.end.x, segment.end.y,
          );
          current = segment.end;
        }
        context.closePath();
      };
      if (outerPath) vectorPath(outerPath);
      else polygonPath(outer);
      // Canvas' default non-zero rule cuts a hole only when its winding is the
      // opposite of the outer path. Normalize here so imported docs do not
      // depend on the order in which a client happened to serialize vertices.
      for (const hole of holes ?? []) {
        const holeClockwise = signedArea(hole) > 0;
        polygonPath(holeClockwise === outerClockwise ? [...hole].reverse() : hole);
      }
      context.fillStrokeShape(shape);
    },
    perfectDrawEnabled: false,
  });
}

/** #rrggbb → rgba() string at alpha `a`; passes non-hex through unchanged. */
function rgba(hex: string, a: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Parse #rrggbb → [r,g,b] (0..255); null for non-hex. */
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number): string =>
  `#${((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1)}`;

/**
 * Count-weighted RGB blend of member seat colours — a section reads as its
 * price makeup, not one flat colour. Falls back to `fallback` when empty.
 */
function mixColors(parts: Array<{ hex: string; w: number }>, fallback: string): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let tw = 0;
  for (const p of parts) {
    const rgb = hexToRgb(p.hex);
    if (!rgb || p.w <= 0) continue;
    r += rgb[0] * p.w;
    g += rgb[1] * p.w;
    b += rgb[2] * p.w;
    tw += p.w;
  }
  return tw > 0 ? toHex(r / tw, g / tw, b / tw) : fallback;
}

/** Linear interpolate between two #rrggbb colours (t 0..1); passes `a` through if unparseable. */
function lerpColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  return toHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}

/** Per-section render state for the block LOD rung (fills, labels, membership). */
interface SectionRender {
  id: string;
  /** Shared public management identity for disconnected visual components. */
  logicalId: string;
  label: string;
  outline: Point[];
  outlinePath?: SectionOutlinePath;
  holes: Point[][];
  centroid: Point;
  /** Deterministic centre-first alternatives for concave/holed label fitting. */
  labelAnchors: Point[];
  zone?: string;
  /** Seats whose centre falls inside the outline (first-match, doc order). */
  memberIds: string[];
  total: number;
  free: number;
  /** Category-mix (or explicit override) fill BEFORE the availability tint. */
  baseFill: string;
  outlineTint: string;
  /** Faint outline drawn under seats — the existing near-zoom look, untouched. */
  outlinePoly: Shape;
  /** Solid block fill that melts in at the block rung. */
  blockPoly: Shape;
  /** Section name (always drawn; brightens at the block rung, hides at zone rung). */
  nameLabel: Text;
  /** Availability retained for focused/detail UI, never painted on the overview shell. */
  subLabel: Text;
  /** Preferred name ink (labelStyle.color or the overview default) fed through
   *  auto-contrast each frame so an authored colour survives the block melt. */
  preferredInk: string;
  /** labelStyle.size relative to the default (1 = default), scaling the fitted
   *  screen-px band so a larger authored label reads larger in the overview. */
  labelScale: number;
  /** Responsive fit decisions for the current stage scale and local polygon span. */
  nameLabelFits: boolean;
  subLabelFits: boolean;
  /** Tier height (0 = floor). Lifts the section + members in iso ("3D") view. */
  elevation: number;
  /**
   * When elevation > 0, the section's bg nodes + member seats live in these
   * groups so a single position offset lifts the whole tier in iso view.
   */
  liftGroupBg: Group | null;
  liftGroupSeat: Group | null;
  /** Extruded side faces (one per outline edge) shown only as isoT rises. */
  sideFaces: Line[];
}

/** Per-zone render state for the farthest LOD rung. */
interface ZoneRender {
  id: string;
  anchor: Point;
  back: Rect;
  background: string;
  label: Text;
  sub: Text | null;
}

export class SeatmapRenderer implements ISeatmapRenderer {
  private container: HTMLDivElement;
  private opts: Required<Pick<RendererOptions, 'maxSelection'>> & RendererOptions;

  private stage: Stage;
  private bgLayer: Layer;
  private seatLayer: Layer;
  private overlayLayer: Layer;
  private labelGroup: Group;

  private seats: ExpandedSeat[] = [];
  private seatById = new Map<string, ExpandedSeat>();
  /** Multi-floor (Batch 5): the last-set chart + which floor we're rendering. */
  private chartDoc: ChartDoc | null = null;
  private activeFloorId = '';
  /** When true on a multi-floor chart, render ALL floors stacked (3D overview). */
  private stacked = false;
  /** Interactive node per seat/booth — a Circle for seats, a Rect for booths. */
  private circleById = new Map<string, Shape>();
  /** Booth block geometry, keyed by booth id (= the unit's rowId). */
  private boothDims = new Map<string, { width: number; height: number; rotation: number }>();
  /** Booth labels live with the booth shape but obey the shared rendered-size LOD. */
  private boothLabelById = new Map<string, Text>();
  /** Viewport seat labels are rebuilt after each settled camera change. */
  private seatLabelById = new Map<string, Text>();
  /** Coloured accommodation ring per accessible seat (few per chart). */
  private accessRingById = new Map<string, Circle>();
  /** Centred accessibility glyph per accessible seat — shown once the seat is
   *  big enough on-screen (see {@link SEAT_GLYPH_MIN_PX}); the ring is the
   *  smaller-zoom fallback. Kept in a map so zoom toggles touch only the handful
   *  of accessible seats, never all 13k nodes. */
  private accessGlyphById = new Map<string, Path>();
  /** Whether the accessibility glyph is legible at the current camera scale. */
  private accessGlyphVisible = false;
  /** Authored free-text nodes obey the same rendered-size visibility floor. */
  private freeTextById = new Map<string, {
    objectId?: string;
    node: Text;
    background: string;
    kind: RenderedFreeTextEvidence['kind'];
    categoryKey?: string;
  }>();
  /** Stage/rink landmarks retain a readable screen-space caption at overview. */
  private primaryFocalLabels = new Map<Text, number>();
  /** GA paint and text share price/highlight filter state. */
  private gaById = new Map<string, {
    label: string;
    capacity: number;
    categoryKey: string;
    points: Point[];
    polygon: Shape;
    effectiveBackground: string;
    /** GA inventory contained by a section is detail, not overview paint. */
    sectionId?: string;
  }>();
  private statusById = new Map<string, SeatStatus>();
  private catColor = new Map<string, string>();
  private theme: ChartTheme = {};
  /** Opaque paint actually visible behind transparent Konva canvases. */
  private canvasBackground = DEF_CANVAS_BACKGROUND;
  /** Effective selection/hover ring color — resolved per chart in setChart(). */
  private effSelection: string = DEF_SELECTION;
  /** Colorblind-safe mode (Okabe-Ito hues + hollow booked seats). */
  private colorblind = false;
  /** Category order from the doc — the stable index into the CB palette. */
  private catOrder: string[] = [];

  private selection = new Set<string>();
  /** Whole-seat/block selection markers: outline + non-colour check cue. */
  private selectionMarkers = new Map<string, Group>();
  /** Held by this picker instance, not by another buyer. */
  private ownedHold = new Set<string>();
  /** One selected seat being inspected before it is committed to the cart. */
  private selectionFocusId: string | null = null;
  private hoverRing: Circle;
  /** Keyboard-navigation focus ring + the currently focused seat id. */
  private focusRing: Circle;
  private focusedId: string | null = null;
  /**
   * Accessibility filter: `null` = off; `[]` = dim all non-accessible free seats;
   * a type list = dim free seats lacking any of those accommodations.
   */
  private accessFilter: AccessibilityType[] | null = null;
  /** Category highlight (legend hover): dims free seats NOT of this category. */
  private categoryHighlight: string | null = null;
  /** Price-band filter (F4): dim free seats whose category is NOT in this set. */
  private categoryFilter: Set<string> | null = null;
  /** Commercial "hide limited-view seats" toggle: dim free seats flagged
   *  restrictedView/obstructedView. Parallel to the accessibility filter. */
  private commercialLimitedFilter = false;

  // Section/zone overlays (bgLayer) — the 3-rung LOD: seats → section blocks →
  // zone blocks. Kept for the melt restyle and for hit-testing a zoomed-out tap.
  private sections: SectionRender[] = [];
  private zones: ZoneRender[] = [];
  private seatSection = new Map<string, SectionRender>();
  private catPrice = new Map<string, number>();
  /** ISO 4217 currency for on-map "FROM …" prices (undefined ⇒ money default). */
  private currency: string | undefined;
  /** Section/zone ids to render dimmed (organizer manager: held-back inventory). */
  private dimmedSections = new Set<string>();
  /** Organizer control-room velocity overlay; absent on buyer surfaces. */
  private sectionHeat = new Map<string, number>();
  /** Phase 2: section/zone ids in the event-level `closed` state — flat grey
   *  block, seats greyed + not pickable, but the section stays rendered. */
  private closedSections = new Set<string>();
  /** AXS section-focus: the currently-focused section id (others dim), or null. */
  private focusedSectionId: string | null = null;
  /** Light backdrop panel drawn behind the focused section (removed on clear). */
  private focusBackdrop: Group | null = null;
  /** Object id → floor id (multi-floor only) — resolves a deck tap in the 3D stack. */
  private objectFloor = new Map<string, string>();
  /** Zone id → colour (drives extruded side faces in iso view). */
  private zoneColor = new Map<string, string>();
  private hasSections = false;
  /** seatLayer carries Text (booth labels) — gate the upright-label scan. */
  private hasBoothText = false;

  // Isometric ("3D") view — an affine skew/rotate + elevation lift, tweened.
  /** 0 = flat (default), 1 = full isometric; animated by setViewMode. */
  private isoT = 0;
  private isoTarget = 0;
  private isoRaf = 0;
  /** Chart centre the iso projection pivots about (bounds centre). */
  private isoCentre = { x: 0, y: 0 };
  /** rAF for an in-flight camera glide (focusRegion / setRung); 0 = none. */
  private glideRaf = 0;
  /** Set in destroy() so an in-flight iso tween bails. */
  private destroyed = false;
  /** Cached scale the section/zone labels were last sized for (scale-compensation). */
  private lodScale = 0;
  /** prefers-reduced-motion → hard-swap rungs instead of cross-fading. */
  private reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  private fitScale = 1;
  /** Effective seat radius (base × theme.seatScale), set per chart in setChart. */
  private seatR = SEAT_RADIUS;
  private bounds = { x: 0, y: 0, width: 1, height: 1 };
  private cached = false;
  private dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);

  private rafId = 0;
  private frames = 0;
  private lastFpsAt = 0;
  private recacheTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObs: ResizeObserver | null = null;
  /** Coalesces bursty view-change sources (pointermove, wheel) into ≤1 callback/frame. */
  private viewChangeRaf = 0;

  // Gesture state — pan/pinch are handled with raw pointer events on the
  // container (Konva stage dragging is off; its touch pipeline proved
  // unreliable for multi-touch on real devices).
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { startDist: number; startScale: number; worldMid: { x: number; y: number } } | null = null;
  private panLast: { x: number; y: number } | null = null;
  private panStart: { x: number; y: number } | null = null;
  private panStarted = false;
  /** Maximum displacement from gesture start — suppress taps only after a real pan/pinch. */
  private moved = 0;
  /**
   * Manage-mode rubber-band marquee (option-gated). `start`/`cur` are WORLD-space
   * points (overlayLayer rides the stage transform); `rect` is the on-canvas
   * selection band. Null except during an active manage-mode drag.
   */
  private marquee: { start: { x: number; y: number }; rect: Rect } | null = null;
  private marqueeCur: { x: number; y: number } | null = null;

  constructor(container: HTMLDivElement, options: RendererOptions = {}) {
    this.container = container;
    this.opts = { maxSelection: 10, selectableStatuses: ['free'], ...options };
    this.currency = options.currency;

    Konva.pixelRatio = this.dpr;

    this.stage = new Stage({
      container,
      width: container.clientWidth || 1,
      height: container.clientHeight || 1,
      draggable: false, // pan/pinch are ours, via pointer events
    });

    container.style.touchAction = 'none';
    container.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    container.addEventListener('pointermove', this.onPointerMove, { passive: false });
    container.addEventListener('pointerup', this.onPointerEnd, { passive: false });
    container.addEventListener('pointercancel', this.onPointerEnd, { passive: false });

    // Keyboard accessibility: the canvas is focusable and navigable seat-by-seat.
    if (container.tabIndex < 0) container.tabIndex = 0;
    container.setAttribute('role', 'application');
    if (!container.getAttribute('aria-label')) {
      container.setAttribute('aria-label', t('map.aria'));
    }
    container.addEventListener('keydown', this.onKeyDown);

    this.bgLayer = new Layer({ listening: true });
    this.seatLayer = new Layer({ listening: true });
    this.overlayLayer = new Layer({ listening: false });
    this.labelGroup = new Group({ listening: false });
    this.overlayLayer.add(this.labelGroup);

    this.hoverRing = new Circle({
      radius: SEAT_RADIUS + 2,
      stroke: '#ffffff',
      strokeWidth: 2,
      opacity: 0.85,
      listening: false,
      visible: false,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
    });
    this.overlayLayer.add(this.hoverRing);

    this.focusRing = new Circle({
      radius: SEAT_RADIUS + 3,
      stroke: '#38bdf8',
      strokeWidth: 2.5,
      dash: [4, 3],
      opacity: 0.95,
      listening: false,
      visible: false,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
    });
    this.overlayLayer.add(this.focusRing);

    this.stage.add(this.bgLayer, this.seatLayer, this.overlayLayer);

    this.wireInteraction();
    this.startFpsLoop();

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__seatmap = this;
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.handleResize());
      this.resizeObs.observe(container);
    }
  }

  // ---- ISeatmapRenderer -----------------------------------------------------

  setChart(doc: ChartDoc, opts?: { floorId?: string }): void {
    // Multi-floor: render the active floor (2D) or all floors stacked (3D). `view`
    // scopes the chart accordingly — single-floor charts pass through (=== doc).
    // A fresh chart (new ref) resets to 2D; a re-render (same ref) preserves the mode.
    if (doc !== this.chartDoc) this.stacked = false;
    this.chartDoc = doc;
    this.activeFloorId = opts?.floorId ?? floorsOf(doc)[0].id;
    // Object id → floor id, for resolving which deck a tap hit in the 3D stack
    // (stackFloors keeps object ids, so the map holds across the flatten).
    this.objectFloor.clear();
    if (doc.floors && doc.floors.length > 1) {
      for (const f of doc.floors) for (const o of f.objects) this.objectFloor.set(o.id, f.id);
    }
    const view = this.floorView(doc);
    this.focusedId = null;
    this.focusRing.visible(false);
    this.bgLayer.destroyChildren();
    this.seatLayer.destroyChildren();
    this.labelGroup.destroyChildren();
    this.circleById.clear();
    this.boothDims.clear();
    this.boothLabelById.clear();
    this.seatLabelById.clear();
    this.accessRingById.clear();
    this.accessGlyphById.clear();
    this.freeTextById.clear();
    this.primaryFocalLabels.clear();
    this.gaById.clear();
    for (const marker of this.selectionMarkers.values()) marker.destroy();
    this.selectionMarkers.clear();
    this.ownedHold.clear();
    this.selectionFocusId = null;
    this.statusById.clear();
    this.selection.clear();
    this.seatById.clear();
    this.cached = false;
    this.accessFilter = null;
    this.sections = [];
    this.zones = [];
    this.seatSection.clear();
    // Section focus is a transient camera/view state. Carrying a section id
    // across a floor switch can match nothing on the next floor and dim every
    // newly rendered section as though it were a non-focused sibling.
    this.focusedSectionId = null;
    this.focusBackdrop = null;
    this.catPrice.clear();
    this.zoneColor.clear();
    this.lodScale = 0;
    this.hasBoothText = false;
    // Reloading the chart resets the view to flat (identity layer transforms).
    if (this.isoRaf) { cancelAnimationFrame(this.isoRaf); this.isoRaf = 0; }
    this.isoT = 0;
    this.isoTarget = 0;
    this.resetLayerTransforms();
    this.hasSections = view.objects.some((o) => o.type === 'section');
    for (const z of doc.zones ?? []) if (z.color) this.zoneColor.set(z.id, z.color);
    // Seats fade against the block fill during the melt; reset to fully opaque.
    this.seatLayer.opacity(1);
    this.hoverRing.visible(false);

    this.theme = doc.theme ?? {};
    // Adjustable seat size: a chart-level scale on the base radius. Clamped so
    // enlarged seats don't collide with typical row spacing (~24 units).
    this.seatR = clamp(this.theme.seatScale ?? 1, 0.7, 1.6) * SEAT_RADIUS;
    // Resolve an unthemed embed against its real host surface once, then pin
    // that opaque paint on the renderer container. Rendering decisions and QA
    // evidence must describe the same pixels even when Konva stays transparent.
    this.container.style.background = '';
    this.canvasBackground = this.resolveCanvasBackground();
    this.container.style.background = this.canvasBackground;
    this.effSelection = this.resolveSelectionColor();
    this.hoverRing.stroke(this.effSelection);
    this.hoverRing.radius(this.seatR + 2);

    this.catColor.clear();
    this.catPrice.clear();
    this.catOrder = doc.categories.map((c) => c.key);
    for (const c of doc.categories) {
      this.catColor.set(c.key, c.color);
      if (typeof c.price === 'number') this.catPrice.set(c.key, c.price);
    }

    for (const obj of view.objects) {
      if (obj.type === 'booth') {
        this.boothDims.set(obj.id, { width: obj.width, height: obj.height, rotation: obj.rotation });
      }
    }

    this.seats = expandChart(view);
    for (const s of this.seats) {
      this.seatById.set(s.id, s);
      this.statusById.set(s.id, 'free');
    }

    this.renderBackground(view);
    this.renderSeats();
    // re-add overlay furniture wiped by destroyChildren above
    this.overlayLayer.add(this.labelGroup);
    this.overlayLayer.add(this.hoverRing);

    this.bounds = chartBounds(view);
    this.isoCentre = { x: this.bounds.x + this.bounds.width / 2, y: this.bounds.y + this.bounds.height / 2 };
    this.zoomToFit();
  }

  /** The chart to render: all floors stacked (3D overview), the active floor, or
   *  the whole chart for single-floor charts. */
  private floorView(doc: ChartDoc): ChartDoc {
    if (!doc.floors || !doc.floors.length) return doc;
    if (this.stacked && doc.floors.length >= 2) return stackFloors(doc);
    const floor = doc.floors.find((f) => f.id === this.activeFloorId) ?? doc.floors[0];
    return { ...doc, objects: floor.objects, focalPoint: floor.focalPoint, backgroundImage: floor.backgroundImage, floors: undefined };
  }

  /** Toggle the 3D all-floors stacked overview (Batch 5). Re-renders; no-op on
   *  single-floor charts. The caller re-applies statuses + animates the iso view. */
  setStacked(on: boolean): void {
    if (!this.chartDoc || on === this.stacked) return;
    const multi = !!this.chartDoc.floors && this.chartDoc.floors.length >= 2;
    if (!multi) return;
    this.stacked = on;
    this.setChart(this.chartDoc, { floorId: this.activeFloorId });
  }
  isStacked(): boolean {
    return this.stacked;
  }

  /** Switch which floor is shown (2D). Re-renders + re-fits; no-op if unchanged. */
  setActiveFloor(floorId: string): void {
    if (!this.chartDoc || floorId === this.activeFloorId) return;
    this.setChart(this.chartDoc, { floorId });
  }

  /** Floors for the host's switcher (single-floor charts return one synthetic floor). */
  getFloors(): { id: string; name: string }[] {
    return this.chartDoc ? floorsOf(this.chartDoc).map((f) => ({ id: f.id, name: f.name })) : [];
  }

  getActiveFloorId(): string {
    return this.activeFloorId;
  }

  setStatus(seatIds: string[], status: SeatStatus): void {
    let touched = false;
    // Sections whose availability tint / "N LEFT" needs a cheap recompute.
    const affected = this.hasSections ? new Set<SectionRender>() : null;
    for (const id of seatIds) {
      if (!this.statusById.has(id)) continue;
      const prev = this.statusById.get(id);
      this.statusById.set(id, status);
      const c = this.circleById.get(id);
      if (c) {
        this.paintSeat(c, id);
        touched = true;
      }
      if (affected) {
        const sec = this.seatSection.get(id);
        if (sec) {
          if ((prev === 'free') !== (status === 'free')) {
            sec.free += status === 'free' ? 1 : -1;
          }
          affected.add(sec);
        }
      }
    }
    if (affected && affected.size) {
      for (const sec of affected) this.refreshSectionFill(sec);
      this.bgLayer.batchDraw();
    }
    if (!touched) return;
    if (this.cached) {
      // bitmap is stale; debounce a re-cache so bulk updates coalesce
      if (this.recacheTimer) clearTimeout(this.recacheTimer);
      this.recacheTimer = setTimeout(() => this.cacheSeatLayer(), 150);
    } else {
      this.seatLayer.batchDraw();
    }
    if (this.effScale() > LABEL_SCALE) this.updateLabels();
  }

  setOwnedHold(seatIds: string[] | null): void {
    const next = new Set((seatIds ?? []).filter((id) => this.statusById.has(id)));
    const touched = new Set([...this.ownedHold, ...next]);
    this.ownedHold = next;
    for (const id of touched) {
      const shape = this.circleById.get(id);
      if (shape) this.paintSeat(shape, id);
      this.syncSelectionMarker(id);
    }
    if (!touched.size) return;
    if (this.cached) {
      if (this.recacheTimer) clearTimeout(this.recacheTimer);
      this.recacheTimer = setTimeout(() => this.cacheSeatLayer(), 150);
    } else {
      this.seatLayer.batchDraw();
    }
    if (this.effScale() > LABEL_SCALE) this.updateLabels();
    this.overlayLayer.batchDraw();
  }

  setSelectionFocus(seatId: string | null): void {
    const next = seatId && this.selection.has(seatId) ? seatId : null;
    if (next === this.selectionFocusId) return;
    const previous = this.selectionFocusId;
    this.selectionFocusId = next;

    for (const seat of this.seats) {
      const shape = this.circleById.get(seat.id);
      if (shape) this.paintSeat(shape, seat.id);
    }
    if (previous) this.syncSelectionMarker(previous);
    if (next) this.syncSelectionMarker(next);
    for (const [id, marker] of this.selectionMarkers) {
      marker.opacity(!next || id === next ? 1 : 0.2);
    }
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
    this.overlayLayer.batchDraw();
  }

  getStatus(seatId: string): SeatStatus {
    return this.statusById.get(seatId) ?? 'free';
  }

  getSelection(): ExpandedSeat[] {
    const out: ExpandedSeat[] = [];
    for (const id of this.selection) {
      const s = this.seatById.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  clearSelection(): void {
    const ids = [...this.selection];
    for (const id of ids) this.setSelected(id, false, true);
    this.overlayLayer.batchDraw();
  }

  setMaxSelection(maxSelection: number): void {
    this.opts.maxSelection = Math.max(0, Math.floor(maxSelection));
  }

  select(seatIds: string[]): ExpandedSeat[] {
    const added: ExpandedSeat[] = [];
    for (const id of seatIds) {
      if (this.selection.has(id) || !this.isSelectable(id)) continue;
      if (this.selection.size >= this.opts.maxSelection) {
        this.opts.onSelectionLimit?.(this.opts.maxSelection);
        break;
      }
      this.setSelected(id, true, true);
      const seat = this.seatById.get(id);
      if (seat) added.push(seat);
    }
    if (added.length) this.overlayLayer.batchDraw();
    return added;
  }

  /** Switch organizer interaction in place so the host preserves camera, LOD,
   * focus and live status state while moving between Monitor and Block. */
  setManageInteraction(options: {
    manageMode: boolean;
    marqueeSelect: boolean;
    selectableStatuses: SeatStatus[];
    maxSelection?: number;
  }): void {
    if (this.marquee) this.cancelMarquee();
    this.panLast = null;
    this.panStart = null;
    this.panStarted = false;
    this.opts.manageMode = options.manageMode;
    this.opts.marqueeSelect = options.marqueeSelect;
    this.opts.selectableStatuses = [...options.selectableStatuses];
    if (options.maxSelection != null) this.opts.maxSelection = options.maxSelection;

    // A selection from a previous interaction mode must not remain actionable
    // after the new mode makes it read-only or changes its eligible statuses.
    const invalid = [...this.selection].filter((id) => !this.isSelectable(id));
    if (invalid.length) this.deselect(invalid);
    if (!options.manageMode && this.selection.size) this.clearSelection();
    this.container.style.cursor = 'default';
    this.overlayLayer.batchDraw();
  }

  /** Apply a non-destructive velocity treatment to section outlines. Seat
   * category/status fills remain untouched so heat never changes seat meaning. */
  setSectionHeat(scores: Record<string, number> | null): void {
    this.sectionHeat.clear();
    for (const [sectionId, raw] of Object.entries(scores ?? {})) {
      if (Number.isFinite(raw)) this.sectionHeat.set(sectionId, Math.max(0, Math.min(1, raw)));
    }
    for (const section of this.sections) this.refreshSectionHeat(section);
    this.bgLayer.batchDraw();
  }

  deselect(seatIds: string[]): void {
    let changed = false;
    for (const id of seatIds) {
      if (this.selection.has(id)) {
        this.setSelected(id, false, true);
        changed = true;
      }
    }
    if (changed) this.overlayLayer.batchDraw();
  }

  // ---- manage-mode bulk selection (SDK SeatManager) -------------------------
  // All option-gated: no-ops (or empty) unless `manageMode` is set, so buyer
  // surfaces that never pass the flag can't reach any of this.

  /** Select every selectable seat on the chart (⌘A). Returns the added seats. */
  selectAllSelectable(): ExpandedSeat[] {
    if (!this.opts.manageMode) return [];
    const ids: string[] = [];
    for (const seat of this.seats) if (this.isSelectable(seat.id)) ids.push(seat.id);
    return this.selectMany(ids);
  }

  /** Select the selectable seats matching these public labels (category/row/
   *  section bulk resolves to labels host-side). Returns the newly added seats. */
  selectByLabels(labels: string[]): ExpandedSeat[] {
    if (!this.opts.manageMode) return [];
    const want = new Set(labels);
    const ids: string[] = [];
    for (const seat of this.seats) {
      if (want.has(seat.label) && this.isSelectable(seat.id)) ids.push(seat.id);
    }
    return this.selectMany(ids);
  }

  /** Exact SDK capture helper. MCP never accepts this id; the SDK derives it
   * from the persisted floor and uses the normal selected paint/ring path. */
  setEvidenceSelection(seatId: string): boolean {
    if (!this.seatById.has(seatId) || !this.isSelectable(seatId)) return false;
    if (this.selection.size) this.clearSelection();
    this.setSelected(seatId, true);
    this.overlayLayer.batchDraw();
    return this.selection.has(seatId);
  }

  /** Selectable seats in a section OR zone id — pure read (no selection change). */
  getSelectableInSection(sectionId: string): ExpandedSeat[] {
    const out: ExpandedSeat[] = [];
    const seen = new Set<string>();
    for (const sec of this.sections) {
      if (sec.id !== sectionId && sec.logicalId !== sectionId && sec.zone !== sectionId) continue;
      for (const id of sec.memberIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!this.isSelectable(id)) continue;
        const s = this.seatById.get(id);
        if (s) out.push(s);
      }
    }
    return out;
  }

  /**
   * Union `ids` into the selection in one batched pass. Beyond MARQUEE_RING_CAP
   * total selected we skip the per-seat ring nodes (fill paint still marks the
   * seats) so a whole-arena select doesn't spawn thousands of Konva shapes.
   * Returns the full current selection.
   */
  private selectMany(ids: string[]): ExpandedSeat[] {
    const fresh = ids.filter((id) => !this.selection.has(id));
    if (!fresh.length) return this.getSelection();
    const drawRings = this.selection.size + fresh.length <= MARQUEE_RING_CAP;
    for (const id of fresh) {
      if (drawRings) {
        this.setSelected(id, true, true); // ring + fill, silent (batch draw below)
      } else {
        this.selection.add(id);
        const c = this.circleById.get(id);
        if (c) this.paintSeat(c, id);
      }
    }
    if (!this.cached) this.seatLayer.batchDraw();
    this.overlayLayer.batchDraw();
    return this.getSelection();
  }

  // ---- manage-mode marquee gesture ------------------------------------------

  private beginMarquee(clientPt: { x: number; y: number }): void {
    const w = this.screenToWorld(clientPt);
    const s = this.stage.scaleX() || 1;
    const rect = new Rect({
      x: w.x,
      y: w.y,
      width: 0,
      height: 0,
      stroke: this.effSelection,
      strokeWidth: 1.5 / s, // world units → ~constant on-screen px under the stage scale
      dash: [5 / s, 4 / s],
      fill: 'rgba(110,123,255,0.10)',
      listening: false,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
    });
    this.overlayLayer.add(rect);
    this.marquee = { start: w, rect };
    this.marqueeCur = w;
    this.overlayLayer.batchDraw();
  }

  private updateMarquee(clientPt: { x: number; y: number }): void {
    if (!this.marquee) return;
    const w = this.screenToWorld(clientPt);
    const { start, rect } = this.marquee;
    rect.setAttrs({
      x: Math.min(start.x, w.x),
      y: Math.min(start.y, w.y),
      width: Math.abs(w.x - start.x),
      height: Math.abs(w.y - start.y),
    });
    this.marqueeCur = w;
    this.overlayLayer.batchDraw();
  }

  private cancelMarquee(): void {
    if (!this.marquee) return;
    this.marquee.rect.destroy();
    this.marquee = null;
    this.marqueeCur = null;
    this.overlayLayer.batchDraw();
  }

  /**
   * Pointer-up: hit-test the marquee world-rect against the in-memory seat
   * centres (NOT the Konva hit-graph — that's a cached bitmap when zoomed and
   * far slower), keep only SELECTABLE seats, union them into the selection and
   * fire `onMarquee`. A near-zero drag reads as a click: clear the selection.
   */
  private finishMarquee(): void {
    const m = this.marquee;
    this.marquee = null;
    if (!m) return;
    m.rect.destroy();
    this.overlayLayer.batchDraw();
    const cur = this.marqueeCur ?? m.start;
    this.marqueeCur = null;
    const x0 = Math.min(m.start.x, cur.x);
    const x1 = Math.max(m.start.x, cur.x);
    const y0 = Math.min(m.start.y, cur.y);
    const y1 = Math.max(m.start.y, cur.y);
    const s = this.stage.scaleX() || 1;
    // Sub-4px drag = a click on empty canvas → deselect-all affordance.
    if ((x1 - x0) * s < 4 && (y1 - y0) * s < 4) {
      if (this.selection.size) {
        this.clearSelection();
        this.opts.onMarquee?.([]);
      }
      return;
    }
    const ids: string[] = [];
    for (const seat of this.seats) {
      if (seat.x < x0 || seat.x > x1 || seat.y < y0 || seat.y > y1) continue;
      if (!this.isSelectable(seat.id)) continue;
      ids.push(seat.id);
    }
    this.selectMany(ids);
    this.opts.onMarquee?.(this.getSelection());
  }

  flashSeat(seatId: string, color = '#f43f5e'): void {
    const seat = this.seatById.get(seatId);
    if (!seat) return;
    const ring = new Circle({
      x: seat.x,
      y: seat.y,
      radius: this.seatR,
      stroke: color,
      strokeWidth: 3,
      opacity: 0.9,
      listening: false,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
    });
    this.overlayLayer.add(ring);
    const start = performance.now();
    const dur = 620;
    const step = (now: number): void => {
      // Guard against a destroy() mid-animation (layer torn down).
      if (!ring.getLayer()) return;
      const t = Math.min(1, (now - start) / dur);
      ring.radius(this.seatR * (1 + t * 1.8));
      ring.opacity(0.9 * (1 - t));
      this.overlayLayer.batchDraw();
      if (t < 1) requestAnimationFrame(step);
      else {
        ring.destroy();
        this.overlayLayer.batchDraw();
      }
    };
    requestAnimationFrame(step);
  }

  /**
   * Pulse a section outline without moving the camera or mutating the authored
   * geometry. The temporary halo is drawn in the non-listening overlay layer,
   * so the apparent 4% lift never changes hit testing or selection bounds.
   */
  flashSection(sectionId: string, color = '#22a06b'): void {
    const matches = this.sections.filter((section) =>
      section.id === sectionId || section.zone === sectionId);
    if (!matches.length) return;

    for (const section of matches) {
      const centre = section.outline.reduce(
        (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
        { x: 0, y: 0 },
      );
      centre.x /= section.outline.length;
      centre.y /= section.outline.length;
      const lift = section.elevation > 0 ? this.isoLiftLocal(section.elevation) : { x: 0, y: 0 };
      const halo = new Line({
        x: centre.x + lift.x,
        y: centre.y + lift.y,
        points: section.outline.flatMap((point) => [point.x - centre.x, point.y - centre.y]),
        closed: true,
        stroke: color,
        strokeWidth: 3,
        strokeScaleEnabled: false,
        opacity: 0.92,
        listening: false,
        perfectDrawEnabled: false,
        shadowForStrokeEnabled: true,
        shadowColor: color,
        shadowBlur: 14,
        shadowOpacity: 0.7,
      });
      this.overlayLayer.add(halo);
      this.overlayLayer.batchDraw();

      const remove = (): void => {
        if (!halo.getLayer()) return;
        halo.destroy();
        this.overlayLayer.batchDraw();
      };
      if (this.reducedMotion || (typeof document !== 'undefined' && document.hidden)) {
        setTimeout(remove, 520);
        continue;
      }

      const start = performance.now();
      const duration = 820;
      const step = (now: number): void => {
        if (this.destroyed || !halo.getLayer()) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const scale = 1 + eased * 0.04;
        halo.scale({ x: scale, y: scale });
        halo.opacity(0.92 * (1 - t));
        this.overlayLayer.batchDraw();
        if (t < 1) requestAnimationFrame(step);
        else remove();
      };
      requestAnimationFrame(step);
    }
  }

  // ---- keyboard navigation (accessibility) ----------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    // Manage-mode bulk shortcuts: ⌘/Ctrl-A selects all selectable, Escape clears.
    // Both fire onMarquee so the SDK toolbar tracks selection through one path.
    if (this.opts.manageMode) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        this.opts.onMarquee?.(this.selectAllSelectable());
        return;
      }
      if (e.key === 'Escape' && this.selection.size) {
        e.preventDefault();
        this.clearSelection();
        this.opts.onMarquee?.([]);
        return;
      }
    }
    const dir =
      e.key === 'ArrowLeft' ? { x: -1, y: 0 }
      : e.key === 'ArrowRight' ? { x: 1, y: 0 }
      : e.key === 'ArrowUp' ? { x: 0, y: -1 }
      : e.key === 'ArrowDown' ? { x: 0, y: 1 }
      : null;
    if (dir) {
      e.preventDefault();
      const next = this.focusedId ? this.nearestSeat(this.focusedId, dir) : this.seats[0]?.id ?? null;
      if (next) this.focusSeat(next);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && this.focusedId) {
      e.preventDefault();
      this.toggleSeat(this.focusedId);
      const s = this.seatById.get(this.focusedId);
      if (s) this.opts.onFocusSeat?.(s); // re-announce; status may have changed
    }
  };

  /** Nearest seat from `fromId` in a cardinal direction (aligned + close wins). */
  private nearestSeat(fromId: string, dir: { x: number; y: number }): string | null {
    const from = this.seatById.get(fromId);
    if (!from) return null;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const s of this.seats) {
      if (s.id === fromId) continue;
      const dx = s.x - from.x;
      const dy = s.y - from.y;
      const proj = dx * dir.x + dy * dir.y; // along the chosen direction
      if (proj <= 0.5) continue; // must lie in that direction
      const perp = Math.abs(dx * dir.y - dy * dir.x); // lateral offset
      const score = proj + perp * 2.5; // reward alignment + proximity
      if (score < bestScore) {
        bestScore = score;
        best = s.id;
      }
    }
    return best;
  }

  private focusSeat(id: string): void {
    const seat = this.seatById.get(id);
    if (!seat) return;
    this.focusedId = id;
    this.focusRing.radius(this.seatR + 3);
    this.focusRing.position({ x: seat.x, y: seat.y });
    this.focusRing.visible(true);
    this.ensureVisible(seat);
    this.overlayLayer.batchDraw();
    this.opts.onFocusSeat?.(seat);
  }

  /** Pan/zoom so a seat sits on-screen at a legible scale (for keyboard focus). */
  private ensureVisible(seat: ExpandedSeat): void {
    const w = this.stage.width();
    const h = this.stage.height();
    const target = Math.max(this.stage.scaleX(), SEAT_LEGIBLE_SCALE * 1.2);
    const p = this.worldToScreen(seat);
    const margin = 70;
    const offscreen = p.x < margin || p.x > w - margin || p.y < margin || p.y > h - margin;
    if (this.stage.scaleX() < target || offscreen) {
      // Centre on the PROJECTED seat position so iso view frames it correctly.
      const ip = this.isoT === 0 ? seat : this.isoForward(seat);
      this.stage.scale({ x: target, y: target });
      this.stage.position({ x: w / 2 - ip.x * target, y: h / 2 - ip.y * target });
      this.afterViewChange();
      this.stage.batchDraw();
    }
  }

  zoomToFit(): void {
    const w = this.stage.width();
    const h = this.stage.height();
    const b = this.bounds;
    this.fitScale = Math.min(w / b.width, h / b.height) || 1;
    const s = this.fitScale;
    this.stage.scale({ x: s, y: s });
    this.stage.position({
      x: (w - b.width * s) / 2 - b.x * s,
      y: (h - b.height * s) / 2 - b.y * s,
    });
    this.afterViewChange();
    this.stage.batchDraw();
  }

  /** Step factor for the on-screen +/− buttons (B1) — same clamp path as pinch/wheel. */
  private static readonly ZOOM_STEP = 1.4;

  zoomIn(): void {
    const center = { x: this.stage.width() / 2, y: this.stage.height() / 2 };
    this.zoomAbout(this.stage.scaleX() * SeatmapRenderer.ZOOM_STEP, center);
  }

  zoomOut(): void {
    const center = { x: this.stage.width() / 2, y: this.stage.height() / 2 };
    this.zoomAbout(this.stage.scaleX() / SeatmapRenderer.ZOOM_STEP, center);
  }

  seatCount(): number {
    return this.seats.length;
  }

  bookableCount(): number {
    let total = this.seats.length;
    for (const area of this.gaById.values()) total += area.capacity;
    return total;
  }

  worldToScreen(point: Point): { x: number; y: number } {
    const s = this.stage.scaleX();
    // In iso view, host overlays (confirm card, tooltip) must anchor to the
    // PROJECTED seat, so run the point through the iso affine first. At isoT=0
    // isoForward is the identity — byte-for-byte the flat behaviour.
    const p = this.isoT === 0 ? point : this.isoForward(point);
    return { x: p.x * s + this.stage.x(), y: p.y * s + this.stage.y() };
  }

  setAccessibleFilter(on: boolean): void {
    this.setAccessibilityFilter(on ? [] : null);
  }

  setAccessibilityFilter(types: AccessibilityType[] | null): void {
    const next = types === null ? null : [...types];
    if (this.sameAccessFilter(next)) return;
    this.accessFilter = next;
    for (const seat of this.seats) {
      const c = this.circleById.get(seat.id);
      if (c) this.paintSeat(c, seat.id);
    }
    this.updateLabels();
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
  }

  private sameAccessFilter(next: AccessibilityType[] | null): boolean {
    const cur = this.accessFilter;
    if (cur === null || next === null) return cur === next;
    return cur.length === next.length && cur.every((t, i) => t === next[i]);
  }

  /**
   * "Hide limited-view seats" toggle (commercial): when on, dim free, unselected
   * seats flagged restrictedView or obstructedView — the same visual dimming the
   * accessibility filter uses, just keyed off the seat's commercial attributes.
   */
  setCommercialLimitedFilter(on: boolean): void {
    if (this.commercialLimitedFilter === on) return;
    this.commercialLimitedFilter = on;
    for (const seat of this.seats) {
      const c = this.circleById.get(seat.id);
      if (c) this.paintSeat(c, seat.id);
    }
    this.updateLabels();
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
  }

  /**
   * Price-band filter (F4): dim free, unselected seats whose category key is NOT
   * in `keys`. `null` clears the filter (all categories fully visible). The
   * widget resolves which categories fall inside the buyer's chosen band.
   */
  setCategoryFilter(keys: string[] | null): void {
    const next = keys === null ? null : new Set(keys);
    const same = (next === null && this.categoryFilter === null) ||
      (next !== null && this.categoryFilter !== null &&
        next.size === this.categoryFilter.size && [...next].every((k) => this.categoryFilter!.has(k)));
    if (same) return;
    this.categoryFilter = next;
    for (const seat of this.seats) {
      const c = this.circleById.get(seat.id);
      if (c) this.paintSeat(c, seat.id);
    }
    this.updateLabels();
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
    this.applyGAFilterState();
  }

  private gaCategoryDimmed(categoryKey: string): boolean {
    return Boolean(
      (this.categoryHighlight && categoryKey !== this.categoryHighlight)
      || (this.categoryFilter && !this.categoryFilter.has(categoryKey)),
    );
  }

  /** Keep GA paint and its two labels in the same legend/price-filter state. */
  private applyGAFilterState(): void {
    this.paintGAStateForView();
    this.updateFreeTextVisibility();
    this.bgLayer.batchDraw();
  }

  private paintGAStateForView(): void {
    for (const ga of this.gaById.values()) {
      const filteredOut = Boolean(this.categoryFilter && !this.categoryFilter.has(ga.categoryKey));
      const overviewHidden = ga.sectionId != null && this.effScale() < CACHE_THRESHOLD;
      ga.polygon.opacity(overviewHidden
        ? 0
        : this.gaCategoryDimmed(ga.categoryKey)
          ? GA_FILL_OPACITY * 0.08
          : GA_FILL_OPACITY);
      // A legend hover is only visual; a price-filter exclusion is not sellable
      // from the map until the filter is cleared.
      ga.polygon.listening(!overviewHidden && !filteredOut);
    }
  }

  /** Frame the currently available inventory that survived a buyer price
   *  filter. Clearing the filter glides back to the full venue. */
  focusCategories(keys: string[] | null): void {
    if (!keys?.length) {
      this.focusRegion(this.bounds, { durationMs: CAMERA_GLIDE_MS });
      return;
    }
    const wanted = new Set(keys);
    const matching = this.seats.filter((seat) => {
      if (!wanted.has(seat.categoryKey) || this.seatInClosedSection(seat.id)) return false;
      const status = this.statusById.get(seat.id) ?? 'free';
      return status === 'free' || this.ownedHold.has(seat.id);
    });
    if (!matching.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const seat of matching) {
      minX = Math.min(minX, seat.x);
      maxX = Math.max(maxX, seat.x);
      minY = Math.min(minY, seat.y);
      maxY = Math.max(maxY, seat.y);
    }
    const pad = Math.max(24, this.seatR * 3);
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;
    this.focusRegion(
      { x: minX, y: minY, width: Math.max(40, maxX - minX), height: Math.max(40, maxY - minY) },
      { durationMs: CAMERA_GLIDE_MS },
    );
  }

  // ---- isometric ("3D") view mode -------------------------------------------

  /**
   * Switch the projection between flat top-down and the isometric "3D" view
   * (rotate + y-squash about the chart centre, plus per-elevation lift). Tweens
   * `isoT` 0⇄1 over ~0.32s (ease in-out); reduced-motion snaps. Purely visual —
   * geometry stays flat, so hit-testing (Konva's own, plus the manual section
   * inverse) keeps landing on the projected seats/sections.
   */
  setViewMode(mode: 'flat' | 'isometric'): void {
    const target = mode === 'isometric' ? 1 : 0;
    this.isoTarget = target;
    if (this.isoRaf) { cancelAnimationFrame(this.isoRaf); this.isoRaf = 0; }
    if (this.reducedMotion) {
      this.isoT = target;
      this.applyIso();
      this.afterViewChange();
      return;
    }
    const from = this.isoT;
    if (from === target) { this.applyIso(); this.afterViewChange(); return; }
    const start = performance.now();
    const step = (now: number): void => {
      if (this.destroyed) return; // guard a destroy() mid-tween
      const raw = Math.min(1, (now - start) / ISO_TWEEN_MS);
      // easeInOutCubic — matches the melt's camera glide.
      const e = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      this.isoT = from + (this.isoTarget - from) * e;
      this.applyIso();
      this.scheduleViewChange();
      if (raw < 1) {
        this.isoRaf = requestAnimationFrame(step);
      } else {
        this.isoT = this.isoTarget;
        this.isoRaf = 0;
        this.applyIso();
        this.afterViewChange(); // re-evaluate cache/labels at the settled effective scale
      }
    };
    this.isoRaf = requestAnimationFrame(step);
  }

  /** Current projection — reflects the tween target, not the mid-tween isoT. */
  getViewMode(): 'flat' | 'isometric' {
    return this.isoTarget === 1 ? 'isometric' : 'flat';
  }

  /** Iso angle (rad) + y-squash for the current isoT. */
  private isoParams(): { th: number; sg: number } {
    return { th: (ISO_ANGLE_DEG * Math.PI) / 180 * this.isoT, sg: 1 - (1 - ISO_SQUASH) * this.isoT };
  }

  /** Effective vertical scale = stage scale × iso squash — legibility math uses this. */
  private effScale(): number {
    return this.stage.scaleX() * (1 - (1 - ISO_SQUASH) * this.isoT);
  }

  /** Project a world point through the iso affine about the chart centre (→ iso-world). */
  private isoForward(p: Point): { x: number; y: number } {
    const { th, sg } = this.isoParams();
    const c = this.isoCentre;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const rx = dx * Math.cos(th) - dy * Math.sin(th);
    const ry = (dx * Math.sin(th) + dy * Math.cos(th)) * sg;
    return { x: c.x + rx, y: c.y + ry };
  }

  /** Inverse of isoForward (iso-world → world) for screen-space hit-testing. */
  private isoInverse(p: Point): { x: number; y: number } {
    const { th, sg } = this.isoParams();
    const c = this.isoCentre;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const uy = dy / sg;
    const wx = dx * Math.cos(th) + uy * Math.sin(th);
    const wy = -dx * Math.sin(th) + uy * Math.cos(th);
    return { x: c.x + wx, y: c.y + wy };
  }

  /**
   * Local-space offset that, once the layer applies the iso affine, lifts an
   * object straight UP in iso-world by `elevation × LIFT_PER_STEP × isoT`
   * (= inverse-linear of the pure vertical lift). Zero at isoT=0.
   */
  private isoLiftLocal(elevation: number): { x: number; y: number } {
    const { th, sg } = this.isoParams();
    const delta = elevation * LIFT_PER_STEP * this.isoT;
    return { x: -(delta / sg) * Math.sin(th), y: -(delta / sg) * Math.cos(th) };
  }

  /** Restore the three layers to identity (flat) — byte-for-byte the original. */
  private resetLayerTransforms(): void {
    for (const layer of [this.bgLayer, this.seatLayer, this.overlayLayer]) {
      layer.position({ x: 0, y: 0 });
      layer.offset({ x: 0, y: 0 });
      layer.scale({ x: 1, y: 1 });
      layer.rotation(0);
      layer.skewX(0);
      layer.skewY(0);
    }
  }

  /**
   * Apply the current isoT to the scene: the base rotate+squash as a decomposed
   * layer transform (so seats/décor/rings project together and Konva's own
   * hit-testing follows), upright counter-transforms on text, and the elevation
   * lift + extruded side faces on elevated sections.
   */
  private applyIso(): void {
    const t = this.isoT;
    if (t === 0) {
      this.resetLayerTransforms();
    } else {
      const { th, sg } = this.isoParams();
      // L_iso = Scale(1,sg)·Rot(th) about the centre; decompose to Konva props.
      const a = Math.cos(th);
      const b = sg * Math.sin(th);
      const cc = -Math.sin(th);
      const d = sg * Math.cos(th);
      const r = Math.sqrt(a * a + b * b);
      const delta = a * d - b * cc; // = sg
      const rotationDeg = (Math.atan2(b, a) * 180) / Math.PI;
      const scaleX = r;
      const scaleY = delta / r;
      const skewX = (a * cc + b * d) / delta;
      const c = this.isoCentre;
      for (const layer of [this.bgLayer, this.seatLayer, this.overlayLayer]) {
        layer.position({ x: c.x, y: c.y });
        layer.offset({ x: c.x, y: c.y });
        layer.rotation(rotationDeg);
        layer.scaleX(scaleX);
        layer.scaleY(scaleY);
        layer.skewX(skewX);
        layer.skewY(0);
      }
    }

    this.applyUprightLabels();
    this.applyElevation();

    this.bgLayer.batchDraw();
    this.seatLayer.batchDraw();
    this.overlayLayer.batchDraw();
  }

  /** Counter-skew every visible label so it renders upright at its projected anchor. */
  private applyUprightLabels(): void {
    const thDeg = ISO_ANGLE_DEG * this.isoT;
    const invScaleY = 1 / (1 - (1 - ISO_SQUASH) * this.isoT);
    // Seat labels live in overlayLayer (labelGroup); section/zone/décor in bgLayer.
    // Skip the seatLayer scan unless it actually holds booth labels (else it is
    // thousands of Circles with no Text).
    const layers = this.hasBoothText
      ? [this.bgLayer, this.seatLayer, this.overlayLayer]
      : [this.bgLayer, this.overlayLayer];
    for (const layer of layers) {
      const texts = layer.find('Text') as unknown as Text[];
      for (const tn of texts) {
        let base = tn.getAttr('uprightBase') as number | undefined;
        if (base == null) {
          base = tn.rotation();
          tn.setAttr('uprightBase', base);
        }
        tn.rotation(base - thDeg);
        tn.scaleX(1);
        tn.scaleY(invScaleY);
        tn.skewX(0);
      }
    }
  }

  /** Lift elevated sections (+ their members) and update their extruded side faces. */
  private applyElevation(): void {
    const t = this.isoT;
    for (const sec of this.sections) {
      if (sec.elevation <= 0) continue;
      const off = this.isoLiftLocal(sec.elevation);
      sec.liftGroupBg?.position(off);
      sec.liftGroupSeat?.position(off);
      // Side faces: quad per edge from base outline to the lifted outline, in
      // local (world) space — the layer projects them. Invisible at isoT=0.
      const alpha = 0.9 * t;
      for (let i = 0; i < sec.sideFaces.length; i++) {
        const face = sec.sideFaces[i];
        const p0 = sec.outline[i];
        const p1 = sec.outline[(i + 1) % sec.outline.length];
        face.points([p0.x, p0.y, p1.x, p1.y, p1.x + off.x, p1.y + off.y, p0.x + off.x, p0.y + off.y]);
        face.opacity(alpha);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.isoRaf) cancelAnimationFrame(this.isoRaf);
    if (this.glideRaf) cancelAnimationFrame(this.glideRaf);
    if (this.viewChangeRaf) cancelAnimationFrame(this.viewChangeRaf);
    if (this.recacheTimer) clearTimeout(this.recacheTimer);
    this.resizeObs?.disconnect();
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerup', this.onPointerEnd);
    this.container.removeEventListener('pointercancel', this.onPointerEnd);
    this.container.removeEventListener('keydown', this.onKeyDown);
    this.stage.destroy();
  }

  // ---- rendering ------------------------------------------------------------

  /** Theme font stack for all rendered text (falls back to Inter). */
  private labelFont(): string {
    return this.theme.fontFamily || 'Inter, sans-serif';
  }

  /**
   * Where a seat's nodes live: an elevated section's lift group (so the whole
   * tier shifts with one offset in iso view) or the seat layer directly.
   */
  private seatContainer(id: string): Group | Layer {
    return this.seatSection.get(id)?.liftGroupSeat ?? this.seatLayer;
  }

  private renderSeats(): void {
    for (const seat of this.seats) {
      if (seat.kind === 'booth') {
        this.renderBoothUnit(seat);
        continue;
      }
      const target = this.seatContainer(seat.id);
      const c = new Circle({
        x: seat.x,
        y: seat.y,
        radius: this.seatR,
        perfectDrawEnabled: false,
        shadowForStrokeEnabled: false,
        hitStrokeWidth: 0,
      });
      c.setAttr('seatId', seat.id);
      this.circleById.set(seat.id, c);
      this.paintSeat(c, seat.id);
      target.add(c);
      // Accessible seats get two markers (few per chart, so the extra nodes are
      // cheap): a colour-coded accommodation ring, plus a centred glyph revealed
      // once the seat is big enough on-screen. The ring is the small-zoom
      // fallback, so it is drawn a touch thicker/wider to stay perceptible there.
      if (seat.accessible) {
        const ring = new Circle({
          x: seat.x,
          y: seat.y,
          radius: this.seatR + 1.5,
          stroke: accessibilityRingColor(seat.accessibility),
          strokeWidth: 2.5,
          listening: false,
          perfectDrawEnabled: false,
          shadowForStrokeEnabled: false,
        });
        this.accessRingById.set(seat.id, ring);
        target.add(ring);
        const glyph = this.buildAccessGlyph(seat, typeof c.fill() === 'string' ? (c.fill() as string) : '');
        this.accessGlyphById.set(seat.id, glyph);
        target.add(glyph);
      }
    }
  }

  /** A booth renders as a click-selectable rounded block (dims from the doc). */
  private renderBoothUnit(seat: ExpandedSeat): void {
    const target = this.seatContainer(seat.id);
    const dims = this.boothDims.get(seat.rowId) ?? { width: 40, height: 30, rotation: 0 };
    const rect = new Rect({
      x: seat.x,
      y: seat.y,
      width: dims.width,
      height: dims.height,
      offsetX: dims.width / 2,
      offsetY: dims.height / 2,
      rotation: dims.rotation,
      cornerRadius: 4,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
      hitStrokeWidth: 0,
    });
    rect.setAttr('seatId', seat.id);
    this.circleById.set(seat.id, rect);
    target.add(rect);

    const t = new Text({
      x: seat.x,
      y: seat.y,
      text: seat.displayLabel ?? seat.label,
      fontSize: BOOTH_LABEL_FONT_SIZE,
      fontStyle: '600',
      fontFamily: this.labelFont(),
      fill: this.theme.seatLabelColor ?? DEF_SEAT_LABEL,
      listening: false,
      perfectDrawEnabled: false,
    });
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    t.visible(false);
    this.boothLabelById.set(seat.id, t);
    this.hasBoothText = true; // gate the upright-label scan of the seat layer
    this.boothLabelById.set(seat.id, t);
    target.add(t);
    this.paintSeat(rect, seat.id);
  }

  /**
   * Build the centred accessibility glyph for a seat. Sized relative to the seat
   * radius (so it always fills the marker at any zoom) and given a contrast-aware
   * fill against the seat's paint — recomputed per state in {@link paintSeat}.
   */
  private buildAccessGlyph(seat: ExpandedSeat, seatFill: string): Path {
    const k = (this.seatR * 1.5) / ACCESS_GLYPH_VIEWBOX;
    return new Path({
      x: seat.x,
      y: seat.y,
      data: ACCESS_GLYPH_PATH,
      offsetX: ACCESS_GLYPH_VIEWBOX / 2,
      offsetY: ACCESS_GLYPH_VIEWBOX / 2,
      scaleX: k,
      scaleY: k,
      fill: stateAwareBookableLabelInk(seatFill, '#ffffff'),
      listening: false,
      visible: this.accessGlyphVisible,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
    });
  }

  /**
   * Toggle the accessibility glyphs for the current camera scale: shown once the
   * effective on-screen seat radius clears {@link SEAT_GLYPH_MIN_PX}, otherwise
   * hidden so only the ring remains. Iterates the (small) accessible-seat set,
   * never the full node graph, so it is cheap to call on every view change.
   */
  private updateAccessGlyphs(scale: number): void {
    if (!this.accessGlyphById.size) return;
    this.accessGlyphVisible = this.seatR * scale >= SEAT_GLYPH_MIN_PX;
    for (const [id, glyph] of this.accessGlyphById) {
      glyph.visible(this.accessGlyphVisible && this.accessGlyphEligible(id));
    }
  }

  /**
   * Whether an accessible seat's glyph should show for its current status. It is
   * hidden on seats a buyer cannot take (sold, or another buyer's hold) where the
   * overlay status cue (diagonal mark / lock) carries the state instead — mirrors
   * the `unavailable` test in {@link updateLabels} so the two never collide.
   */
  private accessGlyphEligible(id: string): boolean {
    const status = this.statusById.get(id) ?? 'free';
    if (status === 'booked') return false;
    if (status === 'held' && !this.ownedHold.has(id) && !this.opts.manageMode) return false;
    return true;
  }

  /** The category's display color — Okabe-Ito hue when colorblind-safe is on. */
  private seatBaseColor(categoryKey: string): string {
    if (!this.colorblind) return this.catColor.get(categoryKey) ?? '#6e7bff';
    const idx = this.catOrder.indexOf(categoryKey);
    return CB_PALETTE[(idx >= 0 ? idx : 0) % CB_PALETTE.length];
  }

  /** Per-seat authored label size relative to the neutral default (1 = default),
   * mirroring the section convention (labelStyle.size ?? 18) / 18. Only real
   * seats carry labelStyle, so booths and unstyled seats resolve to 1. */
  private seatLabelScale(seat: ExpandedSeat): number {
    return (seat.labelStyle?.size ?? 18) / 18;
  }

  /** Preferred label ink for a seat: the authored per-seat colour when set,
   * otherwise today's theme default. Fed through auto-contrast by seatLabelInk. */
  private seatPreferredLabelInk(seat: ExpandedSeat): string {
    return seat.labelStyle?.color ?? this.theme.seatLabelColor ?? DEF_SEAT_LABEL;
  }

  /** Resolve a seat's label ink against the paint actually visible, honouring an
   * authored per-seat colour through the same auto-contrast rule as sections. */
  private seatLabelInk(seat: ExpandedSeat, shape: Shape): string {
    const fill = shape.fill();
    return stateAwareBookableLabelInk(typeof fill === 'string' ? fill : '', this.seatPreferredLabelInk(seat));
  }

  /** Apply fill/stroke/opacity for a seat's current status + selection. */
  private paintSeat(c: Shape, id: string): void {
    const seat = this.seatById.get(id)!;
    const status = this.statusById.get(id) ?? 'free';
    const selected = this.selection.has(id);
    const base = this.seatBaseColor(seat.categoryKey);
    const boothLabel = this.boothLabelById.get(id);

    c.dash([]);
    c.strokeWidth(0);
    c.stroke('');
    c.opacity(1);

    switch (status) {
      case 'free':
        // Selected: on dark canvases the lightened fill + white ring pops; on
        // light canvases that same wash reads as *disabled*, so keep the full
        // category fill and let the dark contrast ring carry the state.
        c.fill(
          selected && this.effSelection === DEF_SELECTION ? lighten(base, 0.28) : base,
        );
        break;
      case 'held':
        if (this.ownedHold.has(id)) {
          // A buyer returning from checkout must be able to distinguish their
          // own inventory from somebody else's hold. Preserve the category
          // identity and outline the actual seat/booth shape (full rectangle
          // for a booth), rather than painting it generic unavailable grey.
          c.fill(lighten(base, this.effSelection === DEF_SELECTION ? 0.24 : 0.1));
          c.stroke(this.effSelection);
          c.strokeWidth(3);
        } else {
          c.fill(HELD_FILL);
        }
        break;
      case 'booked':
        if (this.colorblind) {
          // Non-color cue: booked reads as a hollow ring, never hue alone.
          c.fill('rgba(0,0,0,0)');
          c.stroke(TAKEN_FILL);
          c.strokeWidth(1.5);
          c.opacity(0.9);
        } else {
          c.fill(TAKEN_FILL);
          c.opacity(0.45);
        }
        break;
      case 'not_for_sale':
        c.fill(TAKEN_FILL);
        c.stroke(NFS_STROKE);
        c.strokeWidth(1);
        c.dash([2, 2]);
        break;
    }

    if (boothLabel) {
      boothLabel.text(status === 'booked' ? 'SOLD' : status === 'held' ? 'HELD' : seat.label);
      boothLabel.fontSize(status === 'free' ? 10 : Math.min(10, Math.max(6, this.boothDims.get(seat.rowId)?.width ?? 40) / 6));
      boothLabel.fontStyle(status === 'free' ? '600' : '800');
      boothLabel.fill(status === 'free' ? (this.theme.seatLabelColor ?? DEF_SEAT_LABEL) : '#ffffff');
      boothLabel.offsetX(boothLabel.width() / 2);
      boothLabel.offsetY(boothLabel.height() / 2);
    }

    // Accessibility filter dims free, unselected seats that don't match.
    if (this.accessFilter && status === 'free' && !selected && !seatMatchesAccess(seat, this.accessFilter)) {
      c.opacity(0.25);
    }
    // Legend hover-highlight dims free, unselected seats of other categories.
    if (this.categoryHighlight && status === 'free' && !selected && seat.categoryKey !== this.categoryHighlight) {
      c.opacity(0.25);
    }
    // Price-band filter (F4): dim free, unselected seats outside the chosen band.
    if (this.categoryFilter && status === 'free' && !selected && !this.categoryFilter.has(seat.categoryKey)) {
      c.opacity(0.22);
    }
    // "Hide limited-view seats": dim free, unselected seats with a restricted or
    // obstructed sightline so the clear-view seats stand out.
    if (this.commercialLimitedFilter && status === 'free' && !selected &&
        (seat.commercial?.restrictedView || seat.commercial?.obstructedView)) {
      c.opacity(0.22);
    }
    // Held-back inventory (organizer manager): seats in a dimmed section/zone
    // read as inactive so the map matches the Sections list at a glance.
    if (this.dimmedSections.size) {
      const sec = this.seatSection.get(id);
      if (sec && (
        this.dimmedSections.has(sec.id)
        || this.dimmedSections.has(sec.logicalId)
        || (sec.zone != null && this.dimmedSections.has(sec.zone))
      )) {
        c.opacity(0.18);
      }
    }
    // Phase 2 `closed` section: flat grey, 40% opacity, never a category hue —
    // overrides the status paint above. Seats stay visible but read off-sale.
    if (this.closedSections.size && this.seatInClosedSection(id)) {
      c.fill(CLOSED_SEAT_FILL);
      c.stroke('');
      c.strokeWidth(0);
      c.dash([]);
      c.opacity(CLOSED_SEAT_OPACITY);
    }
    // AXS section-focus: seats outside the focused section desaturate + dim so
    // the focused block reads against a calm ground (§4 focus spec).
    if (this.focusedSectionId) {
      const sec = this.seatSection.get(id);
      const inFocus = !!sec && (
        sec.id === this.focusedSectionId
        || sec.logicalId === this.focusedSectionId
        || sec.zone === this.focusedSectionId
      );
      if (!inFocus) c.opacity(FOCUS_DIM_OPACITY);
    }
    // Buyer confirmation focus: retain the candidate at full strength while
    // every unrelated seat recedes. Labels use the resulting opacity below so
    // the detail layer follows the same focus hierarchy as the seat geometry.
    if (this.selectionFocusId && id !== this.selectionFocusId) c.opacity(Math.min(c.opacity(), 0.16));
    const bookableLabel = this.boothLabelById.get(id) ?? this.seatLabelById.get(id);
    if (bookableLabel) {
      // Booths carry no labelStyle, so seatLabelInk resolves to today's theme
      // ink for them; real seats get their authored colour auto-contrasted.
      bookableLabel.fill(this.seatLabelInk(seat, c));
      bookableLabel.visible(
        isBookableLabelLegibleAtScale(bookableLabel.fontSize(), this.effScale())
        && c.opacity() >= 0.5,
      );
    }
    // Keep the accessibility markers composed with the seat's final paint: the
    // glyph re-contrasts against the current fill (legible on any state incl.
    // colorblind hues), and both markers inherit the seat's opacity so filter/
    // focus dimming carries through instead of leaving a bright ring behind.
    const accessGlyph = this.accessGlyphById.get(id);
    if (accessGlyph) {
      const fill = c.fill();
      accessGlyph.fill(stateAwareBookableLabelInk(typeof fill === 'string' ? fill : '', '#ffffff'));
      accessGlyph.opacity(c.opacity());
      accessGlyph.visible(this.accessGlyphVisible && this.accessGlyphEligible(id));
    }
    this.accessRingById.get(id)?.opacity(c.opacity());
  }

  /** True when a seat sits in a section/zone currently marked `closed`. */
  private seatInClosedSection(id: string): boolean {
    if (!this.closedSections.size) return false;
    const sec = this.seatSection.get(id);
    return !!sec && (
      this.closedSections.has(sec.id)
      || this.closedSections.has(sec.logicalId)
      || (sec.zone != null && this.closedSections.has(sec.zone))
    );
  }

  /**
   * Colorblind-safe mode: swap category hues for the Okabe-Ito palette and
   * render booked seats hollow. Off restores the exact default rendering.
   */
  setColorblindSafe(on: boolean): void {
    if (on === this.colorblind) return;
    this.colorblind = on;
    for (const seat of this.seats) {
      const c = this.circleById.get(seat.id);
      if (c) this.paintSeat(c, seat.id);
    }
    this.updateLabels();
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
  }

  /**
   * Dim the seats of these section/zone ids (organizer manager use) so held-back
   * inventory is visually distinct on the canvas without hiding it. `null`/empty
   * clears. Unlike the buyer's applyHidden, the sections stay rendered.
   */
  setDimmedSections(ids: string[] | null): void {
    const next = new Set(ids ?? []);
    if (next.size === this.dimmedSections.size && [...next].every((i) => this.dimmedSections.has(i))) return;
    this.dimmedSections = next;
    for (const seat of this.seats) {
      const c = this.circleById.get(seat.id);
      if (c) this.paintSeat(c, seat.id);
    }
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
  }

  /**
   * Phase 2 event-level section states: mark these section/zone ids `closed` —
   * flat grey block, seats greyed + not pickable, but the section stays rendered
   * (unlike the buyer's applyHidden which strips it). `null`/empty clears.
   */
  setClosedSections(ids: string[] | null): void {
    const next = new Set(ids ?? []);
    if (next.size === this.closedSections.size && [...next].every((i) => this.closedSections.has(i))) return;
    this.closedSections = next;
    this.repaintSectionsAndSeats();
  }

  /**
   * AXS section-focus: dim + desaturate every other section, draw a calm backdrop
   * panel behind this section's seats, and glide the camera in to frame it (the
   * seat-pick gate below only lets buyers pick once seats are ≥ LABEL_SCALE big).
   */
  focusSection(id: string): void {
    if (!this.sections.some((section) => section.id === id || section.logicalId === id)) return;
    this.focusedSectionId = id;
    this.drawFocusBackdrop(id);
    this.repaintSectionsAndSeats();
    this.updateLOD();
    this.focusRegion(id, { minScale: SEAT_FOCUS_SCALE });
  }

  /** Clear an AXS section focus — restore full-bowl brightness + drop the backdrop. */
  clearSectionFocus(): void {
    if (!this.focusedSectionId) return;
    this.focusedSectionId = null;
    if (this.focusBackdrop) {
      this.focusBackdrop.destroy();
      this.focusBackdrop = null;
    }
    this.repaintSectionsAndSeats();
    this.updateLOD();
  }

  /** The currently AXS-focused section id, or null. */
  getFocusedSection(): string | null {
    return this.focusedSectionId;
  }

  /** Draw (or replace) the light backdrop panel behind the focused section. */
  private drawFocusBackdrop(id: string): void {
    if (this.focusBackdrop) {
      this.focusBackdrop.destroy();
      this.focusBackdrop = null;
    }
    const sections = this.sections.filter((section) => section.id === id || section.logicalId === id);
    if (!sections.length) return;
    const backdrop = new Group({ listening: false });
    for (const section of sections) {
      backdrop.add(polygonWithHolesShape(section.outline, section.holes, {
        fill: FOCUS_BACKDROP_FILL,
        stroke: rgba('#ffffff', 0.1),
        strokeWidth: 1,
        listening: false,
      }, section.outlinePath));
    }
    this.bgLayer.add(backdrop);
    backdrop.moveToTop(); // above the dimmed sibling blocks, still under the seat layer
    this.focusBackdrop = backdrop;
  }

  /** Repaint every seat + section block to reflect closed/focus state, then redraw. */
  private repaintSectionsAndSeats(): void {
    for (const seat of this.seats) {
      const c = this.circleById.get(seat.id);
      if (c) this.paintSeat(c, seat.id);
    }
    for (const sec of this.sections) sec.blockPoly.fill(this.sectionBlockFill(sec));
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
    this.bgLayer.batchDraw();
  }

  /** The world-space rectangle currently visible in the viewport (minimap F3). */
  getVisibleWorldRect(): { x: number; y: number; width: number; height: number } {
    const tl = this.screenToWorld({ x: 0, y: 0 });
    const br = this.screenToWorld({ x: this.stage.width(), y: this.stage.height() });
    return {
      x: Math.min(tl.x, br.x),
      y: Math.min(tl.y, br.y),
      width: Math.abs(br.x - tl.x),
      height: Math.abs(br.y - tl.y),
    };
  }

  /** Axis-aligned world bounds of seats, section outlines, and GA polygons (minimap F3 frame). */
  getWorldBounds(): { x: number; y: number; width: number; height: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (x: number, y: number): void => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const s of this.seats) grow(s.x, s.y);
    for (const sec of this.sections) for (const p of sec.outline) grow(p.x, p.y);
    for (const area of this.gaById.values()) for (const p of area.points) grow(p.x, p.y);
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  /** Legend hover: highlight one category (dim the rest), or null to clear. */
  setCategoryHighlight(key: string | null): void {
    if (this.categoryHighlight === key) return;
    this.categoryHighlight = key;
    for (const seat of this.seats) {
      const c = this.circleById.get(seat.id);
      if (c) this.paintSeat(c, seat.id);
    }
    this.updateLabels();
    if (this.cached) {
      this.seatLayer.clearCache();
      this.cacheSeatLayer();
    } else {
      this.seatLayer.batchDraw();
    }
    this.applyGAFilterState();
  }

  private renderBackground(doc: ChartDoc): void {
    if (doc.backgroundImage) this.renderBackgroundImage(doc.backgroundImage);
    // Decor graphics (ice rink, court art) draw first so they sit UNDER the
    // section outlines and — being on bgLayer, below seatLayer entirely — under
    // every seat. listening(false) keeps them out of the hit graph.
    for (const obj of doc.objects) if (obj.type === 'decorImage') this.renderDecorImage(obj);
    // Sections sit under all other décor so their outlines never occlude seats.
    // NOTE(phase-2): event-level section open/closed/hidden state will gate this
    // draw + the seat membership below — hide/dim a section by id/zone here.
    for (const obj of doc.objects) if (obj.type === 'section') this.renderSection(obj);
    // Zone labels sit above section blocks (drawn after) — the farthest rung.
    this.renderZones(doc);
    for (const obj of doc.objects) {
      if (obj.type === 'shape') {
        this.renderShape(obj);
      } else if (obj.type === 'gaArea') {
        this.renderGA(obj);
      } else if (obj.type === 'table') {
        this.renderTable(obj);
      } else if (obj.type === 'text') {
        this.renderText(obj);
      }
    }
    // `focalPoint` is authoring geometry, not buyer-facing décor. The designer
    // exposes its guide only while the focal tool is active.
  }

  /** Organizer floor-plan photo, dimmed, at the very bottom of the bg layer. */
  private renderBackgroundImage(bg: NonNullable<ChartDoc['backgroundImage']>): void {
    if (!bg.url || bg.visible === false) return;
    const img = new window.Image();
    img.onload = () => {
      const natW = img.naturalWidth || 4;
      const natH = img.naturalHeight || 3;
      const rawCrop = bg.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const cropX = Math.max(0, Math.min(0.99, rawCrop.x));
      const cropY = Math.max(0, Math.min(0.99, rawCrop.y));
      const crop = {
        x: cropX,
        y: cropY,
        width: Math.max(0.01, Math.min(1 - cropX, rawCrop.width)),
        height: Math.max(0.01, Math.min(1 - cropY, rawCrop.height)),
      };
      const w = bg.width;
      const h = w * ((natH * crop.height) / (natW * crop.width));
      const node = new KImage({
        image: img,
        x: bg.center.x,
        y: bg.center.y,
        offsetX: w / 2,
        offsetY: h / 2,
        width: w,
        height: h,
        rotation: bg.rotation ?? 0,
        crop: {
          x: crop.x * natW,
          y: crop.y * natH,
          width: crop.width * natW,
          height: crop.height * natH,
        },
        opacity: bg.opacity,
        listening: false,
      });
      this.bgLayer.add(node);
      node.moveToBottom();
      this.bgLayer.batchDraw();
    };
    img.src = bg.url;
  }

  /**
   * A decor graphic (rink / court / stage art). The KImage node is added to the
   * bgLayer synchronously so it keeps its z-slot beneath the sections drawn right
   * after; the bitmap is decoded async and pasted in on load. A single node = a
   * single drawImage per frame, and it rides the same layer cache — effectively
   * zero per-frame cost. Never listens, so it can't intercept a seat click.
   */
  private renderDecorImage(obj: Extract<ChartDoc['objects'][number], { type: 'decorImage' }>): void {
    // Pass the (not-yet-loaded) Image element as the node's image: Konva draws
    // nothing until it decodes, then onload triggers a repaint. Keeps the node's
    // z-slot fixed beneath the sections drawn immediately after.
    const img = new window.Image();
    const node = new KImage({
      image: img,
      x: obj.x + obj.width / 2,
      y: obj.y + obj.height / 2,
      offsetX: obj.width / 2,
      offsetY: obj.height / 2,
      width: obj.width,
      height: obj.height,
      rotation: obj.rotation ?? 0,
      opacity: clamp(obj.opacity ?? 1, 0, 1),
      listening: false,
      perfectDrawEnabled: false,
    });
    this.bgLayer.add(node);
    img.onload = () => {
      if (!node.getLayer()) return; // chart swapped out before the image loaded
      this.bgLayer.batchDraw();
    };
    img.src = obj.href;
  }

  private renderTable(obj: Extract<ChartDoc['objects'][number], { type: 'table' }>): void {
    if (obj.shape === 'round') {
      this.bgLayer.add(
        new Circle({
          x: obj.center.x,
          y: obj.center.y,
          radius: obj.radius ?? 40,
          fill: '#232c40',
          stroke: '#2a3348',
          strokeWidth: 1.5,
          listening: false,
        }),
      );
    } else {
      const w = obj.width ?? 80;
      const h = obj.height ?? 50;
      this.bgLayer.add(
        new Rect({
          x: obj.center.x,
          y: obj.center.y,
          width: w,
          height: h,
          offsetX: w / 2,
          offsetY: h / 2,
          rotation: obj.rotation,
          fill: '#232c40',
          stroke: '#2a3348',
          strokeWidth: 1.5,
          cornerRadius: 4,
          listening: false,
        }),
      );
    }
    const label = this.addCentredLabel(this.bgLayer, obj.label, obj.center.x, obj.center.y, '#cbd5e1', 12, true);
    this.freeTextById.set(obj.id, { node: label, background: '#232c40', kind: 'table' });
  }

  private renderText(obj: Extract<ChartDoc['objects'][number], { type: 'text' }>): void {
    const background = this.canvasBackground;
    const preferredInk = obj.color ?? this.theme.textColor ?? DEF_TEXT;
    const node = new Text({
      x: obj.position.x,
      y: obj.position.y,
      text: obj.text,
      fontSize: obj.fontSize,
      rotation: obj.rotation,
      // Authored ink remains preferred, but an embed/theme surface can change
      // the actual canvas. Fail over to readable black/white instead of
      // painting an otherwise valid caption invisibly on that active surface.
      fill: stateAwareBookableLabelInk(background, preferredInk),
      fontFamily: this.labelFont(),
      listening: false,
      perfectDrawEnabled: false,
    });
    this.freeTextById.set(obj.id, {
      node,
      background,
      kind: 'free-text',
    });
    this.bgLayer.add(node);
  }

  private renderShape(obj: Extract<ChartDoc['objects'][number], { type: 'shape' }>): void {
    const authoredFill = obj.fill ?? this.theme.decorFill ?? DEF_DECOR_FILL;
    const isStage = obj.role === 'stage';
    const referenceFocal = obj.role === 'reference-focal';
    const isDecor = !!obj.role && !isStage;
    const palette = overviewPalette(this.canvasBackground);
    // A sampled source colour remains persisted on the object as evidence, but
    // the buyer overview renders the focal landmark as the same neutral visual
    // hierarchy as the supplied seating-chart target. Source black must not
    // become an unlabelled black hole in the generated chart.
    const fill = referenceFocal ? palette.focalFill : authoredFill;
    // Stage: darker at the back (min-y), brighter toward the audience edge (max-y).
    const stroke = isStage ? lighten(fill, 0.28) : referenceFocal ? palette.focalStroke : undefined;
    const strokeWidth = isStage ? 1 : referenceFocal ? 2 : 0;
    let cx = 0;
    let cy = 0;
    if (obj.kind === 'rect' && obj.x != null && obj.y != null && obj.width != null && obj.height != null) {
      const grad = isStage
        ? {
            fillLinearGradientStartPoint: { x: 0, y: 0 },
            fillLinearGradientEndPoint: { x: 0, y: obj.height },
            fillLinearGradientColorStops: [0, darken(fill, 0.3), 1, lighten(fill, 0.12)],
          }
        : { fill };
      cx = obj.x + obj.width / 2;
      cy = obj.y + obj.height / 2;
      // Rotate about center: pivot at (cx,cy) via offset; local coords (and the
      // gradient) are unchanged, so the fill spans the box regardless of angle.
      this.bgLayer.add(
        new Rect({
          x: cx,
          y: cy,
          offsetX: obj.width / 2,
          offsetY: obj.height / 2,
          rotation: obj.rotation ?? 0,
          width: obj.width,
          height: obj.height,
          ...grad,
          stroke,
          strokeWidth,
          cornerRadius: 4,
          listening: false,
        }),
      );
    } else if (obj.kind === 'ellipse' && obj.x != null && obj.y != null && obj.width != null && obj.height != null) {
      cx = obj.x + obj.width / 2;
      cy = obj.y + obj.height / 2;
      const grad = isStage
        ? {
            fillLinearGradientStartPoint: { x: 0, y: -obj.height / 2 },
            fillLinearGradientEndPoint: { x: 0, y: obj.height / 2 },
            fillLinearGradientColorStops: [0, darken(fill, 0.3), 1, lighten(fill, 0.12)],
          }
        : { fill };
      this.bgLayer.add(
        new Ellipse({ x: cx, y: cy, rotation: obj.rotation ?? 0, radiusX: obj.width / 2, radiusY: obj.height / 2, ...grad, stroke, strokeWidth, listening: false }),
      );
    } else if (obj.kind === 'polygon' && obj.points && obj.points.length) {
      const pts = obj.points.flatMap((p) => [p.x, p.y]);
      const b = polyBounds(obj.points);
      cx = obj.points.reduce((a, p) => a + p.x, 0) / obj.points.length;
      cy = obj.points.reduce((a, p) => a + p.y, 0) / obj.points.length;
      const grad = isStage
        ? {
            // Line points are absolute chart coords; the gradient endpoints share
            // that space and rotate with the node (pivot at the centroid below).
            fillLinearGradientStartPoint: { x: 0, y: b.y },
            fillLinearGradientEndPoint: { x: 0, y: b.y + b.height },
            fillLinearGradientColorStops: [0, darken(fill, 0.3), 1, lighten(fill, 0.12)],
          }
        : { fill };
      // Rotate about the centroid: position=offset=centroid leaves the polygon
      // in place at rotation 0 and pivots there for any angle.
      this.bgLayer.add(
        new Line({ points: pts, closed: true, x: cx, y: cy, offsetX: cx, offsetY: cy, rotation: obj.rotation ?? 0, ...grad, stroke, strokeWidth, listening: false }),
      );
    }
    if (obj.label) {
      if (isStage) {
        const node = this.addStageLabel(cx, cy, obj.label, fill);
        this.primaryFocalLabels.set(node, 22);
        this.freeTextById.set(obj.id, { node, background: fill, kind: 'stage' });
      }
      else if (isDecor) {
        // A compiled reference focal is a primary orientation landmark, not
        // quiet furniture. Keep its desktop overview label above the shared
        // 12px rendered floor and choose ink against the actual source fill.
        // Ordinary décor retains the subdued treatment.
        const node = this.addCentredLabel(
          this.bgLayer,
          obj.label,
          cx,
          cy,
          referenceFocal ? stateAwareBookableLabelInk(fill, '#e6e9f0') : '#9aa3b5',
          referenceFocal ? 18 : 12,
          false,
        );
        if (referenceFocal) this.primaryFocalLabels.set(node, 18);
        this.freeTextById.set(obj.id, { node, background: fill, kind: 'decor' });
      } else {
        const node = this.addCentredLabel(this.bgLayer, obj.label, cx, cy, '#cbd5e1', 16, true);
        this.freeTextById.set(obj.id, { node, background: fill, kind: 'decor' });
      }
    }
  }

  /** Prominent stage caption: uppercase, letter-spaced, larger, softly dimmed. */
  private addStageLabel(x: number, y: number, text: string, background: string): Text {
    const ink = stateAwareBookableLabelInk(background, '#e6e9f0');
    const t = new Text({
      x,
      y,
      text: text.toUpperCase(),
      fontSize: 22,
      fontStyle: '700',
      letterSpacing: 4,
      fontFamily: this.labelFont(),
      fill: ink,
      listening: false,
      perfectDrawEnabled: false,
    });
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    this.bgLayer.add(t);
    return t;
  }

  private renderGA(obj: Extract<ChartDoc['objects'][number], { type: 'gaArea' }>): void {
    const color = this.catColor.get(obj.categoryKey) ?? '#6e7bff';
    const canvas = this.canvasBackground;
    const effectiveBackground = compositeHexOver(color, canvas, GA_FILL_OPACITY);
    const preferredInk = this.theme.textColor ?? '#e6e9f0';
    const ink = stateAwareBookableLabelInk(effectiveBackground, preferredInk);
    const poly = polygonWithHolesShape(obj.points, obj.holes, {
      fill: color,
      opacity: GA_FILL_OPACITY,
      stroke: color,
      strokeWidth: 1.5,
    });
    poly.setAttr('gaId', obj.id);
    poly.on('click tap', () => this.opts.onGAClick?.(obj.id));
    poly.on('mouseenter', () => {
      this.container.style.cursor = 'pointer';
    });
    poly.on('mouseleave', () => {
      this.container.style.cursor = 'default';
    });
    this.bgLayer.add(poly);

    const labelPoint = polygonLabelPoint(obj.points, obj.holes);
    const containingSection = this.sections.find((section) => (
      pointInPolygonWithHoles(labelPoint, section.outline, section.holes)
    ));
    const label = this.addCentredLabel(this.bgLayer, obj.label, labelPoint.x, labelPoint.y - 8, ink, GA_LABEL_FONT_SIZE, false);
    const capacity = this.addCentredLabel(this.bgLayer, `cap ${obj.capacity}`, labelPoint.x, labelPoint.y + 10, ink, GA_CAPACITY_LABEL_FONT_SIZE, false);
    this.freeTextById.set(`${obj.id}:label`, {
      objectId: obj.id,
      node: label,
      background: effectiveBackground,
      kind: 'ga-label',
      categoryKey: obj.categoryKey,
    });
    this.freeTextById.set(`${obj.id}:capacity`, {
      objectId: obj.id,
      node: capacity,
      background: effectiveBackground,
      kind: 'ga-capacity',
      categoryKey: obj.categoryKey,
    });
    this.gaById.set(obj.id, {
      label: obj.label,
      capacity: obj.capacity,
      categoryKey: obj.categoryKey,
      points: obj.points,
      polygon: poly,
      effectiveBackground,
      ...(containingSection ? { sectionId: containingSection.logicalId } : {}),
    });
  }

  /**
   * A section renders in three coordinated layers driven by the LOD melt:
   *   • a faint outline (the existing near-zoom look, untouched),
   *   • a neutral solid shell that fades in at the overview rung, and
   *   • one readable, contained section name.
   * Category, row, seat, and availability detail belongs to section focus/zoom.
   * Membership and category mix are still precomputed for the detailed state.
   */
  private renderSection(obj: SectionObject): void {
    const centroid = polygonLabelPoint(obj.outline, obj.holes);
    const palette = overviewPalette(this.canvasBackground);

    // Membership: seats inside the outline, first section (doc order) wins.
    const memberIds: string[] = [];
    const catCounts = new Map<string, number>();
    let free = 0;
    for (const seat of this.seats) {
      if (this.seatSection.has(seat.id)) continue;
      if (!pointInPolygonWithHoles(seat, obj.outline, obj.holes)) continue;
      memberIds.push(seat.id);
      catCounts.set(seat.categoryKey, (catCounts.get(seat.categoryKey) ?? 0) + 1);
      if ((this.statusById.get(seat.id) ?? 'free') === 'free') free++;
    }

    // Category-mix fill: explicit override wins, else blend member colours by count.
    const baseFill =
      obj.color ??
      mixColors(
        [...catCounts].map(([key, w]) => ({ hex: this.catColor.get(key) ?? '#6e7bff', w })),
        '#3a4358',
      );

    // Elevation: elevated sections lift as one tier in the iso view, so their bg
    // nodes + member seats go into lift groups (positioned in applyElevation).
    // Side faces (a zone-coloured quad per outline edge) extrude only as isoT rises.
    const elevation = Math.max(0, Math.round(obj.elevation ?? 0));
    let liftGroupBg: Group | null = null;
    let liftGroupSeat: Group | null = null;
    const sideFaces: Line[] = [];
    if (elevation > 0) {
      const faceFill = darken(this.zoneColor.get(obj.zone ?? '') ?? baseFill, 0.42);
      for (let i = 0; i < obj.outline.length; i++) {
        const face = new Line({
          points: [],
          closed: true,
          fill: faceFill,
          stroke: rgba('#000000', 0.25),
          strokeWidth: 1,
          opacity: 0,
          listening: false,
          perfectDrawEnabled: false,
        });
        sideFaces.push(face);
        this.bgLayer.add(face); // behind the group added next → behind the fill
      }
      liftGroupBg = new Group({ listening: false });
      this.bgLayer.add(liftGroupBg);
      liftGroupSeat = new Group({ listening: false });
      this.seatLayer.add(liftGroupSeat);
    }
    const bgTarget: Group | Layer = liftGroupBg ?? this.bgLayer;

    // Zone-coloured outline under the seats — matches the crisp section blocks
    // the designer draws, so the near-zoom map reads as defined zones too.
    const outlineTint = obj.color ?? this.zoneColor.get(obj.zone ?? '') ?? '#3a4358';
    const outlinePoly = polygonWithHolesShape(obj.outline, obj.holes, {
      stroke: rgba(outlineTint, 0.5),
      strokeWidth: 1.75,
      fill: rgba(outlineTint, 0.08),
      listening: false,
    }, obj.outlinePath);
    bgTarget.add(outlinePoly);

    // Neutral overview shell — category paint is intentionally deferred until
    // focus/seat detail so the venue hierarchy remains legible at first glance.
    const blockPoly = polygonWithHolesShape(obj.outline, obj.holes, {
      fill: palette.sectionFill,
      stroke: palette.sectionStroke,
      strokeWidth: SECTION_STROKE_PX,
      opacity: 0,
      listening: false,
    }, obj.outlinePath);
    bgTarget.add(blockPoly);

    // Per-section label overrides (size/color) layered on the overview defaults.
    // color becomes the preferred ink the block-melt loop auto-contrasts each
    // frame; size scales the fitted screen-px band (default section size = 18).
    const labelStyle = obj.labelPresentation?.labelStyle;
    const preferredInk = labelStyle?.color ?? palette.sectionInk;
    const labelScale = (labelStyle?.size ?? 18) / 18;
    const nameLabel = new Text({
      x: obj.labelPresentation?.position?.x ?? centroid.x,
      y: obj.labelPresentation?.position?.y ?? centroid.y,
      text: obj.displayLabel ?? obj.label,
      rotation: obj.labelPresentation?.rotation ?? 0,
      visible: obj.labelPresentation?.visible !== false,
      fontSize: 22 * labelScale,
      fontStyle: '700',
      fontFamily: this.labelFont(),
      fill: stateAwareBookableLabelInk(palette.sectionFill, preferredInk),
      listening: false,
      perfectDrawEnabled: false,
    });
    nameLabel.offsetX(nameLabel.width() / 2);
    nameLabel.offsetY(nameLabel.height() / 2);
    bgTarget.add(nameLabel);

    const subLabel = new Text({
      x: centroid.x,
      y: centroid.y,
      text: t('map.seatsLeft', { count: free }),
      fontSize: 12,
      fontStyle: '700',
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fill: palette.sectionInk,
      opacity: 0,
      listening: false,
      perfectDrawEnabled: false,
    });
    subLabel.offsetX(subLabel.width() / 2);
    bgTarget.add(subLabel);

    const sec: SectionRender = {
      id: obj.id,
      logicalId: obj.logicalSectionId ?? obj.id,
      label: obj.displayLabel ?? obj.label,
      outline: obj.outline,
      ...(obj.outlinePath ? { outlinePath: obj.outlinePath } : {}),
      holes: obj.holes ?? [],
      centroid,
      labelAnchors: polygonLabelCandidates(obj.outline, obj.holes ?? [], centroid),
      zone: obj.zone,
      memberIds,
      total: memberIds.length,
      free,
      baseFill,
      outlineTint,
      outlinePoly,
      blockPoly,
      nameLabel,
      subLabel,
      preferredInk,
      labelScale,
      nameLabelFits: true,
      subLabelFits: true,
      elevation,
      liftGroupBg,
      liftGroupSeat,
      sideFaces,
    };
    for (const id of memberIds) this.seatSection.set(id, sec);
    this.refreshSectionFill(sec);
    this.refreshSectionHeat(sec);
    this.sections.push(sec);
  }

  private refreshSectionHeat(sec: SectionRender): void {
    const raw = this.sectionHeat.get(sec.id)
      ?? this.sectionHeat.get(sec.logicalId)
      ?? (sec.zone ? this.sectionHeat.get(sec.zone) : undefined);
    if (raw == null || raw <= 0) {
      sec.outlinePoly.stroke(rgba(sec.outlineTint, 0.5));
      sec.outlinePoly.fill(rgba(sec.outlineTint, 0.08));
      sec.outlinePoly.strokeWidth(1.75);
      sec.outlinePoly.shadowOpacity(0);
      return;
    }
    const color = lerpColor('#f4b740', '#ef4444', raw);
    sec.outlinePoly.stroke(rgba(color, 0.72 + raw * 0.25));
    sec.outlinePoly.fill(rgba(color, 0.08 + raw * 0.13));
    sec.outlinePoly.strokeWidth(2 + raw * 3.5);
    sec.outlinePoly.shadowColor(color);
    sec.outlinePoly.shadowBlur(4 + raw * 12);
    sec.outlinePoly.shadowOpacity(0.25 + raw * 0.45);
  }

  /** Recompute a section's neutral overview state and retained detail count. */
  private refreshSectionFill(sec: SectionRender): void {
    sec.blockPoly.fill(this.sectionBlockFill(sec));
    sec.subLabel.text(t('map.seatsLeft', { count: sec.free }));
    sec.subLabel.offsetX(sec.subLabel.width() / 2);
  }

  /** True when a section/zone is currently in the `closed` event-state. */
  private isSectionClosed(sec: SectionRender): boolean {
    return this.closedSections.has(sec.id)
      || this.closedSections.has(sec.logicalId)
      || (sec.zone != null && this.closedSections.has(sec.zone));
  }

  /** Clean overview shells never leak category, price, or live availability paint. */
  private sectionBlockFill(sec: SectionRender): string {
    const fill = overviewPalette(this.canvasBackground).sectionFill;
    return this.isSectionClosed(sec) ? darken(fill, 0.12) : fill;
  }

  /**
   * Zone rung: one giant screen-constant label per zone (+ optional "FROM $n"),
   * shown at the farthest zoom in place of per-section detail. Skipped entirely
   * when the doc declares no zones — sections then stay the far rung (graceful).
   */
  private renderZones(doc: ChartDoc): void {
    if (!doc.zones?.length || !this.sections.length) return;
    const byZone = new Map<string, SectionRender[]>();
    for (const sec of this.sections) {
      if (!sec.zone) continue;
      (byZone.get(sec.zone) ?? byZone.set(sec.zone, []).get(sec.zone)!).push(sec);
    }
    for (const z of doc.zones) {
      const members = byZone.get(z.id);
      if (!members || !members.length) continue;
      // Anchor at the TOPMOST member (min y), not the mean centroid: for a
      // symmetric bowl (a zone = a full ring around the stage) the mean lands on
      // the origin and every zone label stacks on the stage. The topmost member
      // gives a distinct point per ring (labels stack up the vertical axis).
      let anchor = members[0];
      for (const s of members) if (s.centroid.y < anchor.centroid.y) anchor = s;
      const cx = anchor.centroid.x;
      const cy = anchor.centroid.y;

      // "FROM $n" = cheapest category price found among this zone's member seats.
      let minPrice = Infinity;
      for (const sec of members) {
        for (const id of sec.memberIds) {
          const seat = this.seatById.get(id);
          const p = seat && this.catPrice.get(seat.categoryKey);
          if (typeof p === 'number' && p < minPrice) minPrice = p;
        }
      }

      // A zone name often extends beyond its irregular section polygon. Give
      // the entire caption an opaque, measured backing instead of choosing ink
      // against only the anchor section and then painting part of that text over
      // the surrounding canvas.
      const back = new Rect({
        x: cx,
        y: cy,
        width: 1,
        height: 1,
        offsetX: 0.5,
        offsetY: 0.5,
        cornerRadius: 1,
        fill: HIERARCHY_PILL_BACKGROUND,
        stroke: z.color ?? anchor.outlineTint,
        strokeWidth: 1,
        opacity: 0,
        listening: false,
        perfectDrawEnabled: false,
      });
      this.bgLayer.add(back);

      const label = new Text({
        x: cx,
        y: cy,
        text: z.label.toUpperCase(),
        fontSize: ZONE_LABEL_PX,
        fontStyle: '800',
        letterSpacing: 0.5,
        fontFamily: this.labelFont(),
        fill: '#f4f6fb',
        opacity: 0,
        listening: false,
        perfectDrawEnabled: false,
      });
      label.offsetX(label.width() / 2);
      label.offsetY(label.height() / 2);
      this.bgLayer.add(label);

      let sub: Text | null = null;
      if (isFinite(minPrice)) {
        sub = new Text({
          x: cx,
          y: cy,
          text: t('map.fromPrice', { price: formatMoney(minPrice, this.currency) }),
          fontSize: 14,
          fontStyle: '600',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fill: '#cbd5e1',
          opacity: 0,
          listening: false,
          perfectDrawEnabled: false,
        });
        sub.offsetX(sub.width() / 2);
        this.bgLayer.add(sub);
      }
      this.zones.push({
        id: z.id,
        anchor: { x: cx, y: cy },
        back,
        background: HIERARCHY_PILL_BACKGROUND,
        label,
        sub,
      });
    }
  }

  /**
   * THE MELT — a continuous, scale-driven cross-fade across the three rungs:
   *   seats ⇄ section blocks ⇄ zone blocks.
   * `blockT` ramps 0→1 as scale falls through [SECTION_PROMINENT, CACHE_THRESHOLD]
   * so the solid fill is fully present exactly as seats become the cached bitmap
   * and fade out; `zoneT` ramps 0→1 across [ZONE_PROMINENT, SECTION_PROMINENT] so
   * per-section detail hands off to giant zone labels. Reduced-motion hard-swaps.
   * Section/zone labels are scale-compensated to hold a roughly constant screen size.
   */
  private applySectionLod(scale: number): void {
    let blockT: number;
    let zoneT: number;
    if (this.reducedMotion) {
      blockT = scale <= SECTION_PROMINENT_SCALE ? 1 : 0;
      zoneT = scale <= ZONE_PROMINENT_SCALE ? 1 : 0;
    } else {
      blockT = clamp((BLOCK_MELT_TOP - scale) / (BLOCK_MELT_TOP - SECTION_PROMINENT_SCALE), 0, 1);
      zoneT = clamp((SECTION_PROMINENT_SCALE - scale) / (SECTION_PROMINENT_SCALE - ZONE_PROMINENT_SCALE), 0, 1);
    }
    // The overview rung is a crisp semantic composition. Finish the melt before
    // entering it so no residual seats or category outlines leak through simply
    // because zoom-to-fit landed a few hundredths below the detail threshold.
    const sectionOverview = scale < CACHE_THRESHOLD;
    if (sectionOverview) blockT = 1;
    // No zones ⇒ skip the zone rung: sections stay the far rung (graceful).
    if (!this.zones.length) zoneT = 0;

    // Seats melt out as the block fill melts in (coordinated with the bitmap swap).
    this.seatLayer.opacity(sectionOverview ? 0 : 1 - blockT);

    // Labels are drawn UPRIGHT (the iso squash is cancelled per-text), so their
    // on-screen size follows the raw stage scale, not the squashed effective one.
    const sx = this.stage.scaleX();
    // Scale-compensate label sizes only when the scale meaningfully changed.
    const rescale = this.lodScale === 0 || Math.abs(scale - this.lodScale) / (this.lodScale || 1) > 0.02;
    if (rescale) this.lodScale = scale;

    const focus = this.focusedSectionId;
    const palette = overviewPalette(this.canvasBackground);
    // Avoid a ghosted label during the first 20% of the block melt, when
    // individual bookable shapes are still the dominant visual layer.
    const sectionLabelT = clamp((blockT - 0.2) / 0.8, 0, 1);
    for (const sec of this.sections) {
      // AXS focus: non-focused sections dim to ~16%; the focused block stays full.
      const dim = focus && sec.id !== focus && sec.logicalId !== focus && sec.zone !== focus ? FOCUS_DIM_OPACITY : 1;
      // Category-tinted detail outlines disappear as the clean shell takes over.
      sec.outlinePoly.opacity(sectionOverview ? 0 : (1 - blockT) * dim);
      sec.blockPoly.opacity(BLOCK_FILL_ALPHA * blockT * dim);
      sec.blockPoly.stroke(palette.sectionStroke);
      sec.blockPoly.strokeWidth(SECTION_STROKE_PX / Math.max(sx, 0.0001));
      // Section names belong to the block rung. Hide them completely once
      // individual seats/booths are the active layer so they cannot sit under
      // bookable labels or shapes.
      const sectionFill = sec.blockPoly.fill();
      const sectionInk = stateAwareBookableLabelInk(
        typeof sectionFill === 'string' ? sectionFill : sec.baseFill,
        sec.preferredInk,
      );
      sec.nameLabel.fill(sectionInk);
      sec.subLabel.fill(sectionInk);
      if (rescale) this.fitSectionRungLabels(sec, sx);
      const labelOpacity = sectionLabelT * (1 - zoneT) * dim;
      sec.nameLabel.opacity(sec.nameLabelFits ? labelOpacity : 0);
      // Availability stays in the focused/detail UI. It is deliberately not a
      // second map label at the clean section-overview rung.
      sec.subLabel.opacity(0);
    }

    // Fade the big zone labels out as the view tilts into 3D — the raised tiers
    // read clearly on their own, and the overlaid zone text just clutters them.
    const zoneOpacity = zoneT * (1 - this.isoT);
    for (const zone of this.zones) {
      zone.back.opacity(zoneOpacity);
      zone.label.opacity(zoneOpacity);
      if (zone.sub) zone.sub.opacity(zoneOpacity);
      if (rescale) this.sizeZonePill(zone, sx);
    }
    // Greedy de-collision of the visible label tiers (small canvases stack
    // "UPPER BOWL"/"LOWER BOWL"/FROM-$ on top of each other otherwise).
    this.decollideRungLabels(sx);
    this.dedupeLogicalSectionLabels();
    for (const zone of this.zones) {
      const opacity = zone.label.opacity();
      zone.back.opacity(opacity);
      if (zone.sub) zone.sub.opacity(opacity);
    }
    this.bgLayer.batchDraw();
  }

  /** One semantic section gets one overview label, even across split contours. */
  private dedupeLogicalSectionLabels(): void {
    const byLogical = new Map<string, SectionRender[]>();
    for (const section of this.sections) {
      (byLogical.get(section.logicalId) ?? byLogical.set(section.logicalId, []).get(section.logicalId)!).push(section);
    }
    for (const components of byLogical.values()) {
      if (components.length < 2) continue;
      const visible = components
        .filter((component) => component.nameLabel.opacity() > 0.05)
        .sort((left, right) => {
          const leftBounds = polyBounds(left.outline);
          const rightBounds = polyBounds(right.outline);
          return rightBounds.width * rightBounds.height - leftBounds.width * leftBounds.height;
        });
      for (const component of visible.slice(1)) component.nameLabel.opacity(0);
    }
  }

  /**
   * Keep transitional zone pills from covering section names. Section names
   * are already proven inside disjoint shells, so they must not cull each other.
   */
  private decollideRungLabels(sx: number): void {
    const GAP = 4;
    interface Cand { node: Text; tier: number; section: boolean; box: { x: number; y: number; w: number; h: number } }
    const cands: Cand[] = [];
    const boxOf = (t: Text): { x: number; y: number; w: number; h: number } => {
      const p = this.worldToScreen({ x: t.x(), y: t.y() });
      const rotated = pointsBounds(rotatedRectPoints(
        { x: 0, y: 0 },
        t.width() * sx,
        t.height() * sx,
        t.rotation(),
      ));
      const w = rotated.width;
      const h = rotated.height;
      return { x: p.x - w / 2, y: p.y - h / 2, w, h };
    };
    for (const zone of this.zones) {
      if (zone.label.opacity() > 0.05) {
        const p = this.worldToScreen(zone.anchor);
        const w = zone.back.width() * sx;
        const h = zone.back.height() * sx;
        cands.push({ node: zone.label, tier: 0, section: false, box: { x: p.x - w / 2, y: p.y - h / 2, w, h } });
      }
    }
    for (const sec of this.sections) {
      if (sec.nameLabel.opacity() > 0.05) cands.push({ node: sec.nameLabel, tier: 1, section: true, box: boxOf(sec.nameLabel) });
    }
    if (cands.length < 2) return;
    cands.sort((a, b) => a.tier - b.tier || a.box.y - b.box.y || a.box.x - b.box.x);
    const kept: Cand['box'][] = [];
    const collides = (b: Cand['box']): boolean =>
      kept.some((k) =>
        b.x < k.x + k.w + GAP && k.x < b.x + b.w + GAP &&
        b.y < k.y + k.h + GAP && k.y < b.y + b.h + GAP,
      );
    for (const c of cands) {
      if (collides(c.box)) {
        c.node.opacity(0);
      } else if (!c.section) {
        // Section shells do not collide by construction; only zone pills form
        // blockers for later transitional labels.
        kept.push(c.box);
      }
    }
  }

  /** Set a centred label's world fontSize (for a target screen px) and re-anchor it. */
  private sizeLabel(t: Text, fontSize: number, y: number): void {
    t.fontSize(Math.max(1, fontSize));
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    t.y(y);
  }

  /** Fit one centred section name, rotating narrow shells like the target chart. */
  private fitSectionRungLabels(sec: SectionRender, sx: number): void {
    const paddingPx = 8;
    sec.subLabelFits = false;
    // Scale the fitted screen-px band by the section's authored label size so a
    // larger override reads larger; the step still shrinks to fit the polygon.
    const maxPx = SECTION_LABEL_PX * sec.labelScale;
    const minPx = MIN_SECTION_LABEL_PX * sec.labelScale;
    for (let fontPx = maxPx; fontPx >= minPx; fontPx -= 1) {
      for (const rotation of [0, -90]) {
        sec.nameLabel.rotation(rotation);
        this.sizeLabel(sec.nameLabel, fontPx / sx, sec.nameLabel.y());
        for (const anchor of sec.labelAnchors) {
          sec.nameLabel.position(anchor);
          const paddingWorld = paddingPx / sx;
          if (rotatedRectFitsPolygon(
            anchor,
            sec.nameLabel.width() + paddingWorld,
            sec.nameLabel.height() + paddingWorld,
            rotation,
            sec.outline,
            sec.holes,
          )) {
            sec.nameLabelFits = true;
            return;
          }
        }
      }
    }
    sec.nameLabel.position(sec.centroid);
    sec.nameLabel.rotation(0);
    sec.nameLabelFits = false;
  }

  /** Size one screen-constant zone name/price pill around its shared anchor. */
  private sizeZonePill(zone: ZoneRender, sx: number): void {
    const padX = 10 / sx;
    const padY = 6 / sx;
    const gap = zone.sub ? 3 / sx : 0;
    this.sizeLabel(zone.label, ZONE_LABEL_PX / sx, zone.anchor.y);
    if (zone.sub) this.sizeLabel(zone.sub, ZONE_SUB_PX / sx, zone.anchor.y);
    const width = Math.max(zone.label.width(), zone.sub?.width() ?? 0) + padX * 2;
    const height = zone.label.height() + (zone.sub ? gap + zone.sub.height() : 0) + padY * 2;
    zone.label.y(zone.anchor.y - (zone.sub ? (gap + zone.sub.height()) / 2 : 0));
    if (zone.sub) zone.sub.y(zone.anchor.y + (zone.label.height() + gap) / 2);
    zone.back.position(zone.anchor);
    zone.back.size({ width, height });
    zone.back.offset({ x: width / 2, y: height / 2 });
    zone.back.cornerRadius(7 / sx);
    zone.back.strokeWidth(1 / sx);
  }

  /**
   * Map a container-relative screen point back to world coords. Inverts the
   * stage (scale/pos) and, in iso view, the iso affine — so screen-space taps
   * test against the flat world outlines/geometry. Identity-equivalent at isoT=0.
   */
  private screenToWorld(clientPoint: { x: number; y: number }): { x: number; y: number } {
    const s = this.stage.scaleX();
    const iso = { x: (clientPoint.x - this.stage.x()) / s, y: (clientPoint.y - this.stage.y()) / s };
    return this.isoT === 0 ? iso : this.isoInverse(iso);
  }

  /** Section id under a container-relative screen point, or null (Slice 5 tap-to-zoom). */
  sectionAt(clientPoint: { x: number; y: number }): string | null {
    if (!this.sections.length) return null;
    const world = this.screenToWorld(clientPoint);
    const hit = this.sections.find((sec) => pointInPolygonWithHoles(world, sec.outline, sec.holes));
    return hit ? hit.logicalId : null;
  }

  /** Seat ids belonging to a section (Slice 5 section-summary card). */
  sectionMembers(id: string): string[] {
    return [...new Set(this.sections
      .filter((section) => section.id === id || section.logicalId === id || section.zone === id)
      .flatMap((section) => section.memberIds))];
  }

  private addCentredLabel(
    layer: Layer,
    text: string,
    x: number,
    y: number,
    fill: string,
    fontSize: number,
    bold: boolean,
  ): Text {
    const t = new Text({
      x,
      y,
      text,
      fontSize,
      fontStyle: bold ? '700' : '500',
      fontFamily: this.labelFont(),
      fill,
      listening: false,
      perfectDrawEnabled: false,
    });
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    layer.add(t);
    return t;
  }

  // ---- selection ------------------------------------------------------------

  private isSelectable(id: string): boolean {
    // A closed section's seats are never pickable, whatever their raw status.
    if (this.seatInClosedSection(id)) return false;
    const statuses = this.opts.selectableStatuses ?? ['free'];
    return statuses.includes(this.statusById.get(id) ?? 'free');
  }

  private toggleSeat(id: string): void {
    if (this.selection.has(id)) {
      this.setSelected(id, false);
      const seat = this.seatById.get(id);
      if (seat) this.opts.onDeselect?.(seat);
    } else {
      if (!this.isSelectable(id)) return;
      if (this.selection.size >= this.opts.maxSelection) {
        this.opts.onSelectionLimit?.(this.opts.maxSelection);
        return;
      }
      this.setSelected(id, true);
      const seat = this.seatById.get(id);
      if (seat) this.opts.onSelect?.(seat);
    }
    this.overlayLayer.batchDraw();
  }

  /**
   * Selection/hover ring color. An explicit theme.selectionColor always wins;
   * otherwise auto-contrast against the effective canvas background — the
   * designer renders on dark (white ring reads), but light-themed hosts (e.g.
   * the DesiPass buyer picker on cream) made the white ring invisible and
   * selected seats looked *disabled*. theme.background is checked first, then
   * the container's computed CSS background (walking up past transparent
   * ancestors). Unknown/unparseable backgrounds keep the dark default.
   */
  private resolveCanvasBackground(): string {
    const themed = this.theme.background ? opaqueColorHex(this.theme.background) : null;
    if (themed) return themed;
    if (typeof getComputedStyle === 'function') {
      let element: HTMLElement | null = this.container;
      while (element) {
        const resolved = opaqueColorHex(getComputedStyle(element).backgroundColor);
        if (resolved) return resolved;
        element = element.parentElement;
      }
    }
    return DEF_CANVAS_BACKGROUND;
  }

  private resolveSelectionColor(): string {
    if (this.theme.selectionColor) return this.theme.selectionColor;
    return isLightColor(this.canvasBackground) ? DEF_SELECTION_ON_LIGHT : DEF_SELECTION;
  }

  private setSelected(id: string, on: boolean, silent = false): void {
    const c = this.circleById.get(id);
    if (on) {
      this.selection.add(id);
    } else {
      if (this.selectionFocusId === id) this.setSelectionFocus(null);
      this.selection.delete(id);
    }
    this.syncSelectionMarker(id);
    if (c) {
      this.paintSeat(c, id);
      if (!silent && !this.cached) this.seatLayer.batchDraw();
    }
  }

  /** Rebuild one marker after selected/held/candidate state changes. */
  private syncSelectionMarker(id: string): void {
    this.selectionMarkers.get(id)?.destroy();
    this.selectionMarkers.delete(id);
    if (!this.selection.has(id) && !this.ownedHold.has(id)) return;

    const seat = this.seatById.get(id);
    if (!seat) return;
    const candidate = this.selectionFocusId === id;
    const dims = this.boothDims.get(seat.rowId);
    const marker = new Group({
      name: 'selection-ring',
      x: seat.x,
      y: seat.y,
      rotation: dims?.rotation ?? 0,
      listening: false,
      perfectDrawEnabled: false,
      opacity: this.selectionFocusId && !candidate ? 0.2 : 1,
    });
    marker.setAttr('seatId', id);
    const common = {
      stroke: this.effSelection,
      listening: false,
      perfectDrawEnabled: false,
      shadowForStrokeEnabled: false,
    };

    if (dims) {
      marker.add(new Rect({
        ...common,
        width: dims.width,
        height: dims.height,
        offsetX: dims.width / 2,
        offsetY: dims.height / 2,
        cornerRadius: 4,
        strokeWidth: candidate ? 4 : 3,
      }));
      if (candidate) {
        marker.add(new Rect({
          ...common,
          width: dims.width + 10,
          height: dims.height + 10,
          offsetX: (dims.width + 10) / 2,
          offsetY: (dims.height + 10) / 2,
          cornerRadius: 7,
          strokeWidth: 2,
          opacity: 0.55,
        }));
      } else {
        const badgeX = Math.max(0, dims.width / 2 - 14);
        const badgeY = -Math.max(0, dims.height / 2 - 14);
        marker.add(new Circle({ x: badgeX, y: badgeY, radius: 10, fill: this.effSelection, listening: false }));
        marker.add(new Line({
          x: badgeX,
          y: badgeY,
          points: [-4.5, 0, -1, 3.5, 5.5, -4.5],
          stroke: isLightColor(this.effSelection) ? '#0b1220' : '#ffffff',
          strokeWidth: 2.4,
          lineCap: 'round',
          lineJoin: 'round',
          listening: false,
        }));
      }
    } else {
      marker.add(new Circle({ ...common, radius: this.seatR + (candidate ? 4.5 : 2.5), strokeWidth: candidate ? 3.5 : 2.5 }));
      if (candidate) {
        marker.add(new Circle({
          ...common,
          radius: this.seatR + 8,
          strokeWidth: 2,
          opacity: 0.55,
        }));
      } else {
        marker.add(new Line({
          points: [-this.seatR * 0.52, 0, -this.seatR * 0.12, this.seatR * 0.4, this.seatR * 0.6, -this.seatR * 0.46],
          stroke: '#ffffff',
          strokeWidth: Math.max(2.6, this.seatR * 0.34),
          lineCap: 'round',
          lineJoin: 'round',
          shadowColor: '#0b1220',
          shadowBlur: 1.5,
          shadowOpacity: 0.55,
          listening: false,
        }));
      }
    }

    this.selectionMarkers.set(id, marker);
    this.overlayLayer.add(marker);
  }

  // ---- interaction ----------------------------------------------------------

  /**
   * The stage scale `focusRegion(id)` would settle at — i.e. the zoom that
   * frames this section in the current viewport. Used to decide whether
   * redirecting a seat tap to section-focus would actually zoom in FURTHER, or
   * whether the section already fills the viewport (small container) so the tap
   * must fall through and pick.
   */
  private sectionBounds(id: string): { x: number; y: number; width: number; height: number } | null {
    const bounds = this.sections
      .filter((section) => section.id === id || section.logicalId === id)
      .map((section) => polyBounds(section.outline));
    if (!bounds.length) return null;
    const left = Math.min(...bounds.map((box) => box.x));
    const top = Math.min(...bounds.map((box) => box.y));
    const right = Math.max(...bounds.map((box) => box.x + box.width));
    const bottom = Math.max(...bounds.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  private sectionFrameScale(id: string): number {
    const b = this.sectionBounds(id);
    if (!b) return this.stage.scaleX();
    const w = this.stage.width();
    const h = this.stage.height();
    const { min, max } = this.zoomBounds();
    const margin = 1.12;
    if (b.width <= 0 || b.height <= 0) return this.stage.scaleX();
    const frameScale = Math.min(w / (b.width * margin), h / (b.height * margin));
    return clamp(Math.max(frameScale, SEAT_FOCUS_SCALE), min, max);
  }

  /**
   * Resolve a seat tap: honour the 3D deck-drill and the AXS seat-pick gate,
   * then toggle. The gate (§4) redirects small on-screen seats to section-focus
   * to avoid blind mis-picks at overview scales — but ONLY when focusing would
   * zoom the seat up to a safe size. If we're already focused on the section, or
   * the section already fills the viewport (a narrow — OR even a wide — container
   * frames a big section BELOW LABEL_SCALE), redirecting is a no-op that would
   * leave the seat permanently unpickable (§5 `picking-gate-unreachable`), so we
   * fall through and PICK. This is the invariant: seats are never unpickable.
   */
  private handleSeatTap(id: string): void {
    // In the 3D all-floors overview, tapping a seat enters its deck in 2D
    // rather than selecting (seat picking happens on the flat floor map).
    if (this.stacked && this.opts.onDeckTap) {
      const floorId = this.objectFloor.get(this.seatById.get(id)?.rowId ?? '');
      if (floorId) { this.opts.onDeckTap(floorId); return; }
    }
    if (this.effScale() < LABEL_SCALE && this.sections.length) {
      const sec = this.seatSection.get(id);
      if (sec) {
        const alreadyFocused = this.focusedSectionId === sec.logicalId;
        // Would section-focus zoom us in meaningfully (>2%)? If not, the gate has
        // nowhere left to go — pick instead of deadlocking.
        const canZoomInFurther = this.sectionFrameScale(sec.logicalId) > this.stage.scaleX() * 1.02;
        if (!alreadyFocused && canZoomInFurther) {
          if (this.opts.onSectionTap) this.opts.onSectionTap(sec.logicalId);
          else this.focusSection(sec.logicalId);
          return;
        }
      }
    }
    this.toggleSeat(id);
  }

  /**
   * Nearest SELECTABLE seat whose centre is within `slopPx` (screen space) of a
   * seat circle edge, or null. Enlarges the effective tap target for small seats
   * so a near-miss on mobile still lands on the intended seat, without ever
   * hijacking a clean tap on empty space beyond the slop.
   */
  private nearestSeatToScreen(screen: { x: number; y: number }, slopPx: number): string | null {
    const s = this.stage.scaleX() || 1;
    const reachWorld = this.seatR + slopPx / s; // circle radius + finger slack
    const world = this.screenToWorld(screen);
    let best: string | null = null;
    let bestD = reachWorld;
    for (const seat of this.seats) {
      if (!this.selection.has(seat.id) && !this.isSelectable(seat.id)) continue;
      const d = Math.hypot(seat.x - world.x, seat.y - world.y);
      if (d < bestD) {
        bestD = d;
        best = seat.id;
      }
    }
    return best;
  }

  private wireInteraction(): void {
    this.seatLayer.on('click tap', (e: KonvaEventObject<Event>) => {
      if (this.moved > PAN_START_SLOP_PX) return; // it was a pan/pinch, not a tap
      const id = seatIdOf(e.target);
      if (!id) return;
      this.handleSeatTap(id);
    });

    // Hover (mouse only) via delegated enter/leave on seat circles.
    this.seatLayer.on('mouseover', (e: KonvaEventObject<MouseEvent>) => {
      const id = seatIdOf(e.target);
      if (!id) return;
      const seat = this.seatById.get(id);
      if (!seat) return;
      this.hoverRing.position({ x: seat.x, y: seat.y });
      this.hoverRing.visible(true);
      this.overlayLayer.batchDraw();
      this.container.style.cursor = 'pointer';
      this.opts.onHover?.(seat);
    });
    this.seatLayer.on('mouseout', () => {
      this.hoverRing.visible(false);
      this.overlayLayer.batchDraw();
      this.container.style.cursor = 'default';
      this.opts.onHover?.(null);
    });

    this.stage.on('wheel', (e: KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      // Position from the event itself — Konva's tracked pointer position is
      // unreliable when the last pointer event went elsewhere.
      const r = this.container.getBoundingClientRect();
      const pointer = { x: e.evt.clientX - r.left, y: e.evt.clientY - r.top };
      // Scale with the actual wheel delta so trackpad flings and fast wheels
      // zoom proportionally (a fixed step per event ignores delta magnitude).
      const factor = Math.exp(-e.evt.deltaY * 0.002);
      this.zoomAbout(this.stage.scaleX() * clamp(factor, 0.5, 2), pointer);
    });

    // Zoomed out, the seat layer is a non-listening cached bitmap and seats
    // are finger-width anyway — a tap zooms into that area instead of
    // attempting a 4px-precision selection (same behaviour as seats.io).
    this.stage.on('click tap', (e: KonvaEventObject<Event>) => {
      if (this.moved > PAN_START_SLOP_PX) return;
      const pointer = this.stage.getPointerPosition();
      if (!pointer) return;
      // Seats are LIVE (not a cached bitmap): the seatLayer handler above owns
      // direct seat hits. Here we only rescue near-misses — a finger landing just
      // off a small seat picks the nearest one (mobile hit target, §4 hit ≥ 24px).
      // A clean tap on empty space beyond the slop still does nothing.
      if (!this.cached) {
        if (seatIdOf(e.target)) return; // direct hit already handled
        const near = this.nearestSeatToScreen(pointer, SEAT_TAP_SLOP_PX);
        if (near) this.handleSeatTap(near);
        return;
      }
      // 3D all-floors overview: tapping a deck enters that floor in 2D. The iso
      // projection is a layer transform, so the flat screenToWorld hit-test below
      // won't work here — resolve the deck via the iso-aware nearest seat instead.
      if (this.stacked && this.opts.onDeckTap) {
        const floorId = this.deckFloorAt();
        if (floorId) { this.opts.onDeckTap(floorId); return; }
      }
      // A tap inside a section (seats aren't the active rung here — the layer is
      // cached) hands off to the host: fire onSectionTap so the picker can glide
      // in + show the section-summary card (Slice 5). With no handler wired we
      // keep the standalone behaviour of gliding to fit that section.
      if (this.sections.length) {
        const world = this.screenToWorld(pointer);
        const hit = this.sections.find((sn) => pointInPolygonWithHoles(world, sn.outline, sn.holes));
        if (hit) {
          if (this.opts.onSectionTap) this.opts.onSectionTap(hit.logicalId);
          else this.focusRegion(hit.logicalId);
          return;
        }
      }
      const target = Math.max(SEAT_LEGIBLE_SCALE * 1.2, this.stage.scaleX() * 2.5);
      this.zoomAbout(target, pointer);
    });
  }

  /**
   * Which deck (floor) a screen tap landed on in the 3D stacked overview. The
   * seat layer is melt-cached at that zoom so individual seat nodes aren't
   * hit-testable; instead we invert the iso+stage transform via the layer's
   * relative pointer and take the nearest seat's floor. Only the floor matters,
   * so within-floor elevation offsets don't affect the result. Null if none.
   */
  private deckFloorAt(): string | null {
    if (!this.objectFloor.size) return null;
    const p = this.seatLayer.getRelativePointerPosition();
    if (!p) return null;
    let best: string | null = null;
    let bestD = Infinity;
    for (const s of this.seats) {
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = s.rowId; }
    }
    return best ? this.objectFloor.get(best) ?? null : null;
  }

  // ---- Pan & pinch (raw pointer events — mouse, touch and pen alike) --------

  private toLocal(e: PointerEvent): { x: number; y: number } {
    const r = this.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // NOTE: no setPointerCapture here — capturing on the container retargets
  // pointer events away from Konva's canvas, killing its click/tap/hover
  // pipeline. We rely on bubbling instead.
  private onPointerDown = (e: PointerEvent): void => {
    this.cancelGlide(); // grabbing the map cancels an in-flight glide
    const local = this.toLocal(e);
    this.pointers.set(e.pointerId, local);
    if (this.pointers.size === 1) {
      this.moved = 0;
      this.pinch = null;
      this.panStart = local;
      this.panStarted = false;
      // Manage-mode rubber-band marquee (option-gated — buyer pan is byte-
      // identical when manageMode is off). A mouse/pen primary-button drag at
      // the seats rung selects instead of panning; touch keeps single-finger
      // pan (pinch zooms) and a middle-button drag (button !== 0) still pans.
      // Disabled below the seats rung so the organizer zooms in first.
      if (
        this.opts.manageMode && this.opts.marqueeSelect &&
        e.pointerType !== 'touch' && e.button === 0 &&
        this.getRung() === 'seats'
      ) {
        this.beginMarquee(local);
        this.panLast = null;
      } else {
        this.panLast = local;
      }
    } else if (this.pointers.size === 2) {
      // A second finger converts an in-progress marquee into a pinch-zoom.
      if (this.marquee) this.cancelMarquee();
      // Anchor the whole pinch to its starting geometry: scale follows the
      // finger-distance ratio and the world point under the midpoint stays
      // glued to the midpoint. No per-event compounding → no drift.
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = this.stage.scaleX();
      this.pinch = {
        startDist: Math.hypot(b.x - a.x, b.y - a.y),
        startScale: s,
        worldMid: { x: (mid.x - this.stage.x()) / s, y: (mid.y - this.stage.y()) / s },
      };
      this.panLast = null;
      this.panStart = null;
      this.panStarted = true;
      this.moved = PAN_START_SLOP_PX + 1;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const p = this.toLocal(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1 && this.panStart) {
      this.moved = Math.max(this.moved, Math.hypot(p.x - this.panStart.x, p.y - this.panStart.y));
    } else if (this.pointers.size >= 2) {
      this.moved = PAN_START_SLOP_PX + 1;
    }

    if (this.marquee) {
      this.updateMarquee(p);
      return;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (this.pinch.startDist < 1) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { min, max } = this.zoomBounds();
      const scale = clamp(this.pinch.startScale * (dist / this.pinch.startDist), min, max);
      this.stage.scale({ x: scale, y: scale });
      this.stage.position({
        x: mid.x - this.pinch.worldMid.x * scale,
        y: mid.y - this.pinch.worldMid.y * scale,
      });
      this.stage.batchDraw();
      this.scheduleViewChange();
    } else if (this.panLast && this.pointers.size === 1) {
      // Keep the camera still through normal finger jitter. Aside from making
      // taps feel steadier, this lets Konva deliver the section tap instead of
      // losing it to a one- or two-pixel accidental drag.
      if (!this.panStarted) {
        if (this.moved <= PAN_START_SLOP_PX) return;
        this.panStarted = true;
      }
      this.stage.position({
        x: this.stage.x() + (p.x - this.panLast.x),
        y: this.stage.y() + (p.y - this.panLast.y),
      });
      this.panLast = p;
      this.stage.batchDraw();
      this.scheduleViewChange();
    }
  };

  private onPointerEnd = (e: PointerEvent): void => {
    // Finishing a manage-mode marquee: compute the selection on pointer-UP.
    if (this.marquee) {
      this.finishMarquee();
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.panLast = null;
      return;
    }
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 1) {
      // pinch → single finger: continue as a pan without jumping
      this.panLast = [...this.pointers.values()][0];
      this.panStart = this.panLast;
      this.panStarted = true;
    }
    if (this.pointers.size === 0) {
      this.panLast = null;
      this.panStart = null;
      this.panStarted = false;
      this.afterViewChange();
    }
  };

  /**
   * Min is chart-relative (never lose the room); max is absolute so seats
   * reach a readable size on any chart, however large the venue.
   */
  private zoomBounds(): { min: number; max: number } {
    let min = 0.5 * this.fitScale;
    // When the chart has zones, the zone rung lives at an ABSOLUTE scale
    // (ZONE_PROMINENT_SCALE). On a large venue `0.5·fitScale` can sit above it,
    // making the zone overview unreachable by zooming out — allow a touch more
    // room so the rung is actually reachable (zone-charts only).
    if (this.zones.length) min = Math.min(min, ZONE_PROMINENT_SCALE * 0.9);
    return { min, max: Math.max(10 * this.fitScale, 4) };
  }

  /** Zoom so `clientPoint` (stage-relative px) stays fixed under the cursor. */
  private zoomAbout(nextScale: number, clientPoint: { x: number; y: number }): void {
    const { min, max } = this.zoomBounds();
    const scale = clamp(nextScale, min, max);
    const old = this.stage.scaleX();
    if (scale === old) return;
    const worldX = (clientPoint.x - this.stage.x()) / old;
    const worldY = (clientPoint.y - this.stage.y()) / old;
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({
      x: clientPoint.x - worldX * scale,
      y: clientPoint.y - worldY * scale,
    });
    this.afterViewChange();
    this.stage.batchDraw();
  }

  /** Zoom + pan so world-rect `b` fills the viewport (with a small margin). */
  private zoomToBounds(
    b: { x: number; y: number; width: number; height: number },
    minScale?: number,
  ): void {
    const w = this.stage.width();
    const h = this.stage.height();
    const { min, max } = this.zoomBounds();
    const margin = 1.12;
    const frameScale = Math.min(w / (b.width * margin), h / (b.height * margin));
    const scale = clamp(Math.max(frameScale, minScale ?? min), min, max);
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({
      x: w / 2 - (b.x + b.width / 2) * scale,
      y: h / 2 - (b.y + b.height / 2) * scale,
    });
    this.afterViewChange();
    this.stage.batchDraw();
  }

  /**
   * Smoothly glide the camera to frame a section (by id) or a world-space bounds
   * rect — the Slice 5 "glide in". Pan+zoom tween over a calm easeInOutCubic; the
   * melt/LOD rides the camera every frame. `prefers-reduced-motion` (or
   * `opts.animate === false`) snaps via zoomToBounds. A grab (pointer-down) or a
   * newer glide cancels an in-flight one.
   */
  focusRegion(
    target: string | { x: number; y: number; width: number; height: number },
    opts?: { animate?: boolean; minScale?: number; durationMs?: number },
  ): void {
    const b =
      typeof target === 'string'
        ? this.sectionBounds(target)
        : target;
    if (!b) return;
    this.cancelGlide();
    if (opts?.animate === false || this.reducedMotion) {
      this.zoomToBounds(b, opts?.minScale);
      return;
    }
    const w = this.stage.width();
    const h = this.stage.height();
    const { min, max } = this.zoomBounds();
    const margin = 1.12;
    const frameScale = Math.min(w / (b.width * margin), h / (b.height * margin));
    const toScale = clamp(Math.max(frameScale, opts?.minScale ?? min), min, max);
    const toX = w / 2 - (b.x + b.width / 2) * toScale;
    const toY = h / 2 - (b.y + b.height / 2) * toScale;
    const fromScale = this.stage.scaleX();
    const fromX = this.stage.x();
    const fromY = this.stage.y();
    if (Math.abs(toScale - fromScale) < 1e-4 && Math.abs(toX - fromX) < 0.5 && Math.abs(toY - fromY) < 0.5) {
      this.afterViewChange();
      return;
    }
    const start = performance.now();
    const duration = Math.max(180, Math.min(1200, opts?.durationMs ?? CAMERA_GLIDE_MS));
    const step = (now: number): void => {
      if (this.destroyed) { this.glideRaf = 0; return; }
      const raw = Math.min(1, (now - start) / duration);
      const e = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      const sc = fromScale + (toScale - fromScale) * e;
      this.stage.scale({ x: sc, y: sc });
      this.stage.position({ x: fromX + (toX - fromX) * e, y: fromY + (toY - fromY) * e });
      this.updateLOD(); // the melt cross-fades as the camera rides in
      this.scheduleViewChange();
      this.stage.batchDraw();
      if (raw < 1) {
        this.glideRaf = requestAnimationFrame(step);
      } else {
        this.glideRaf = 0;
        this.afterViewChange();
      }
    };
    this.glideRaf = requestAnimationFrame(step);
  }

  /** Cancel an in-flight camera glide (a grab or a newer glide interrupts it). */
  private cancelGlide(): void {
    if (this.glideRaf) {
      cancelAnimationFrame(this.glideRaf);
      this.glideRaf = 0;
    }
  }

  /** Current LOD rung derived from effective zoom — drives the ZONES/SECTIONS/SEATS pill. */
  getRung(): LodRung {
    const scale = this.effScale();
    if (scale >= CACHE_THRESHOLD) return 'seats';
    if (this.zones.length && scale < ZONE_PROMINENT_SCALE) return 'zones';
    return 'sections';
  }

  getRenderedQualityEvidence(): RendererQualityEvidence {
    const effectiveScale = this.effScale();
    const stageScale = this.stage.scaleX();
    const viewport = { width: this.stage.width(), height: this.stage.height() };
    const rounded = (value: number) => Math.round(value * 100) / 100;
    const labels: RenderedBookableLabelEvidence[] = this.seats.map((seat) => {
      const shape = this.circleById.get(seat.id);
      const label = this.boothLabelById.get(seat.id) ?? this.seatLabelById.get(seat.id);
      const authoredFontSize = seat.kind === 'booth'
        ? BOOTH_LABEL_FONT_SIZE
        : SEAT_LABEL_FONT_SIZE * this.seatLabelScale(seat);
      const renderedFontPx = rounded((label?.fontSize() ?? authoredFontSize) * effectiveScale);
      const screen = this.worldToScreen(seat);
      const outside = screen.x < 0 || screen.x > viewport.width || screen.y < 0 || screen.y > viewport.height;
      const opacity = shape?.opacity() ?? 0;
      const section = this.seatSection.get(seat.id);
      const visible = Boolean(label?.isVisible()) && opacity >= 0.5 && !outside;
      let hiddenReason: RenderedBookableLabelEvidence['hiddenReason'];
      if (!visible) {
        if (opacity < 0.5) hiddenReason = 'dimmed-or-unavailable';
        else if (renderedFontPx < MIN_VISIBLE_BOOKABLE_LABEL_PX) hiddenReason = 'below-minimum-size';
        else if (outside) hiddenReason = 'outside-viewport';
        else if (!label) hiddenReason = 'clutter-or-fit';
        else hiddenReason = 'renderer-hidden';
      }
      const labelWidth = label ? label.width() * stageScale : 0;
      const labelHeight = label ? label.height() * effectiveScale : 0;
      const directWidthPx = shape instanceof Rect
        ? shape.width() * stageScale
        : this.seatR * 2 * effectiveScale;
      const directHeightPx = shape instanceof Rect
        ? shape.height() * stageScale
        : this.seatR * 2 * effectiveScale;
      // The stage-level near-miss resolver extends every live seat target by
      // SEAT_TAP_SLOP_PX around the same seat radius used by interaction.
      const assistedDiameterPx = 2 * (this.seatR * effectiveScale + SEAT_TAP_SLOP_PX);
      const fill = shape?.fill();
      const ink = label?.fill();
      return {
        seatId: seat.id,
        label: seat.label,
        kind: seat.kind === 'booth' ? 'booth' : 'seat',
        categoryKey: seat.categoryKey,
        ...(section ? { sectionId: section.id } : {}),
        ...(section?.zone ? { zoneId: section.zone } : {}),
        status: this.statusById.get(seat.id) ?? 'free',
        selected: this.selection.has(seat.id),
        visible,
        renderedFontPx,
        fill: typeof fill === 'string' ? fill : '',
        ink: typeof ink === 'string' ? ink : (this.theme.seatLabelColor ?? DEF_SEAT_LABEL),
        opacity: rounded(opacity),
        pointerTarget: {
          active: !this.cached && this.isSelectable(seat.id),
          directWidthPx: rounded(directWidthPx),
          directHeightPx: rounded(directHeightPx),
          effectiveMinimumPx: rounded(Math.max(
            Math.min(directWidthPx, directHeightPx),
            assistedDiameterPx,
          )),
        },
        screenCenter: { x: rounded(screen.x), y: rounded(screen.y) },
        ...(visible ? {
          screenBox: {
            x: rounded(screen.x - labelWidth / 2),
            y: rounded(screen.y - labelHeight / 2),
            width: rounded(labelWidth),
            height: rounded(labelHeight),
          },
        } : {}),
        ...(hiddenReason ? { hiddenReason } : {}),
      };
    });
    const visibleLabels = labels.filter((label) => label.visible).length;
    const hierarchyEvidence = (
      id: string,
      kind: 'section' | 'zone',
      role: 'name' | 'availability' | 'price',
      node: Text,
      backgroundFill: string,
      section?: SectionRender,
    ) => {
      const worldCorners = rotatedRectPoints(
        { x: node.x(), y: node.y() },
        node.width(),
        node.height(),
        node.rotation(),
      );
      const screenBounds = pointsBounds(worldCorners.map((corner) => this.worldToScreen(corner)));
      const opacity = rounded(node.opacity());
      const ink = node.fill();
      const outside = screenBounds.x + screenBounds.width < 0 || screenBounds.x > viewport.width
        || screenBounds.y + screenBounds.height < 0 || screenBounds.y > viewport.height;
      const visible = node.isVisible() && opacity > 0.05 && !outside;
      const fitsContainer = section
        ? rotatedRectFitsPolygon(
            { x: node.x(), y: node.y() },
            node.width(),
            node.height(),
            node.rotation(),
            section.outline,
            section.holes,
          )
        : undefined;
      return {
        id,
        kind,
        role,
        label: node.text(),
        visible,
        renderedFontPx: rounded(node.fontSize() * stageScale),
        opacity,
        fill: backgroundFill,
        ink: typeof ink === 'string' ? ink : '',
        ...(fitsContainer == null ? {} : { fitsContainer }),
        ...(visible ? {
          screenBox: {
            x: rounded(screenBounds.x),
            y: rounded(screenBounds.y),
            width: rounded(screenBounds.width),
            height: rounded(screenBounds.height),
          },
        } : {}),
      };
    };
    const hierarchyLabels = [
      ...this.sections.map((section) => {
        const fill = section.blockPoly.fill();
        return hierarchyEvidence(
          section.id,
          'section',
          'name',
          section.nameLabel,
          typeof fill === 'string' ? fill : section.baseFill,
          section,
        );
      }),
      ...this.sections.map((section) => {
        const fill = section.blockPoly.fill();
        return hierarchyEvidence(
          `${section.id}:availability`,
          'section',
          'availability',
          section.subLabel,
          typeof fill === 'string' ? fill : section.baseFill,
          section,
        );
      }),
      ...this.zones.flatMap((zone) => [
        hierarchyEvidence(zone.id, 'zone', 'name', zone.label, zone.background),
        ...(zone.sub ? [hierarchyEvidence(`${zone.id}:price`, 'zone', 'price', zone.sub, zone.background)] : []),
      ]),
    ];
    const gaAreas: RenderedGAAreaEvidence[] = [...this.gaById].map(([areaId, ga]) => {
      const screenPoints = ga.points.map((point) => this.worldToScreen(point));
      const left = Math.min(...screenPoints.map((point) => point.x));
      const top = Math.min(...screenPoints.map((point) => point.y));
      const right = Math.max(...screenPoints.map((point) => point.x));
      const bottom = Math.max(...screenPoints.map((point) => point.y));
      const outside = right < 0 || left > viewport.width || bottom < 0 || top > viewport.height;
      const opacity = rounded(ga.polygon.opacity());
      const visible = opacity >= 0.1 && !outside;
      const fill = ga.polygon.fill();
      return {
        areaId,
        label: ga.label,
        capacity: ga.capacity,
        categoryKey: ga.categoryKey,
        ...(ga.sectionId ? { sectionId: ga.sectionId } : {}),
        visible,
        interactive: ga.polygon.listening(),
        opacity,
        fill: typeof fill === 'string' ? fill : '',
        effectiveBackground: ga.effectiveBackground,
        ...(visible ? {
          screenBox: {
            x: rounded(left),
            y: rounded(top),
            width: rounded(right - left),
            height: rounded(bottom - top),
          },
        } : {}),
      };
    });
    const freeTextLabels = [...this.freeTextById].map(([recordKey, record]) => {
      const { node, background, kind } = record;
      const point = this.worldToScreen({ x: node.x(), y: node.y() });
      const width = node.width() * stageScale;
      const height = node.height() * effectiveScale;
      const left = point.x - node.offsetX() * stageScale;
      const top = point.y - node.offsetY() * effectiveScale;
      const renderedFontPx = rounded(node.fontSize() * effectiveScale);
      const outside = left + width < 0 || left > viewport.width
        || top + height < 0 || top > viewport.height;
      const visible = node.isVisible() && !outside;
      const ink = node.fill();
      const opacity = rounded(node.getAbsoluteOpacity());
      let hiddenReason: 'below-minimum-size' | 'outside-viewport' | 'renderer-hidden' | undefined;
      if (!visible) {
        if (renderedFontPx < MIN_VISIBLE_BOOKABLE_LABEL_PX) hiddenReason = 'below-minimum-size';
        else if (outside) hiddenReason = 'outside-viewport';
        else hiddenReason = 'renderer-hidden';
      }
      return {
        objectId: record.objectId ?? recordKey,
        kind,
        text: node.text(),
        visible,
        renderedFontPx,
        ink: typeof ink === 'string' ? ink : '',
        background,
        opacity,
        ...(visible ? {
          screenBox: {
            x: rounded(left),
            y: rounded(top),
            width: rounded(width),
            height: rounded(height),
          },
        } : {}),
        ...(hiddenReason ? { hiddenReason } : {}),
      };
    });
    const palette = overviewPalette(this.canvasBackground);
    const neutralSectionFills = new Set([
      palette.sectionFill.toLowerCase(),
      darken(palette.sectionFill, 0.12).toLowerCase(),
    ]);
    const visibleSectionShells = this.sections.filter((section) => section.blockPoly.opacity() > 0.05);
    return {
      viewport,
      canvasBackground: this.canvasBackground,
      effectiveScale: rounded(effectiveScale),
      rung: this.getRung(),
      minimumVisibleLabelPx: MIN_VISIBLE_BOOKABLE_LABEL_PX,
      totalLabelledBookableUnits: labels.length,
      visibleLabels,
      hiddenLabels: labels.length - visibleLabels,
      totalBookableUnits: labels.length + gaAreas.reduce((sum, area) => sum + area.capacity, 0),
      selectionRingSeatIds: this.overlayLayer.find('.selection-ring')
        .map((node) => String(node.getAttr('seatId') ?? ''))
        .filter(Boolean),
      selectionRingColor: this.effSelection,
      focusedSectionId: this.focusedSectionId,
      focusBackdropVisible: Boolean(this.focusBackdrop?.isVisible()),
      categoryFilterKeys: this.categoryFilter ? [...this.categoryFilter].sort() : null,
      overviewStyle: {
        visibleSectionShells: visibleSectionShells.length,
        categoryPaintedSectionShells: visibleSectionShells.filter((section) => {
          const fill = section.blockPoly.fill();
          return typeof fill !== 'string' || !neutralSectionFills.has(fill.toLowerCase());
        }).length,
        visibleCategoryDetailOutlines: this.sections.filter((section) => section.outlinePoly.opacity() > 0.05).length,
        // Row-hint nodes no longer exist in the production overview scene.
        visibleSectionRowHints: 0,
        visibleSectionAvailabilityLabels: this.sections.filter((section) => section.subLabel.opacity() > 0.05).length,
        visibleSectionGADetails: [...this.gaById.values()].filter((area) => (
          area.sectionId != null && area.polygon.opacity() > 0.05
        )).length,
      },
      labels,
      gaAreas,
      hierarchyLabels,
      freeTextLabels,
    };
  }

  /** Jump the camera to a rung's zoom band (glided). */
  setRung(rung: LodRung): void {
    if (rung === 'zones') {
      this.cancelGlide();
      this.zoomToFit();
      return;
    }
    const target =
      rung === 'sections'
        ? (SECTION_PROMINENT_SCALE + CACHE_THRESHOLD) / 2
        : Math.max(
          this.seatLabelTargetScale() * 1.05,
          SEAT_FOCUS_SCALE,
          CACHE_THRESHOLD * 1.3,
        );
    const w = this.stage.width();
    const h = this.stage.height();
    const visible = this.getVisibleWorldRect();
    const viewCentre = {
      x: visible.x + visible.width / 2,
      y: visible.y + visible.height / 2,
    };
    let cx = viewCentre.x;
    let cy = viewCentre.y;
    if (rung === 'sections' && this.sections.length > 0) {
      const sectionCentres = this.sections.map((section) => {
        const bounds = polyBounds(section.outline);
        return {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
        };
      });
      const halfWidth = w / (target * 2);
      const halfHeight = h / (target * 2);
      const hierarchyWillBeVisible = sectionCentres.some((point) =>
        Math.abs(point.x - viewCentre.x) <= halfWidth
        && Math.abs(point.y - viewCentre.y) <= halfHeight);
      if (!hierarchyWillBeVisible) {
        // A narrow viewport through the empty centre of an upper stadium deck
        // can miss every section. Fall back to the nearest hierarchy block.
        const nearest = sectionCentres.reduce((best, point) => {
          const distance = (point.x - viewCentre.x) ** 2 + (point.y - viewCentre.y) ** 2;
          return distance < best.distance ? { point, distance } : best;
        }, { point: sectionCentres[0], distance: Infinity });
        cx = nearest.point.x;
        cy = nearest.point.y;
      }
    }
    const seatAnchors = rung === 'seats' ? this.seats.filter((seat) => seat.kind !== 'booth') : [];
    if (seatAnchors.length > 0) {
      // Bowl/arena charts commonly have an empty focal area at their geometric
      // centre. Centring a deep seat zoom there exposes only the pitch or stage.
      // Anchor the rung on the nearest actual seat to the current view centre so
      // explicit LOD navigation stays local after a pan and always reveals
      // bookable inventory after zoom-to-fit.
      let nearest = seatAnchors[0];
      let nearestDistance = Infinity;
      for (const seat of seatAnchors) {
        const dx = seat.x - viewCentre.x;
        const dy = seat.y - viewCentre.y;
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          nearest = seat;
          nearestDistance = distance;
        }
      }
      cx = nearest.x;
      cy = nearest.y;
    }
    const bw = w / (target * 1.12);
    const bh = h / (target * 1.12);
    this.focusRegion({ x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh });
  }

  /**
   * The seat rung must account for labels that auto-fit inside a seat circle.
   * A short `A-1` remains at the normal 7u target; a table label such as
   * `T13-10` may fit at 4u and therefore needs a deeper camera target to reach
   * the same 12 CSS-pixel floor. Measurement happens only on explicit rung
   * navigation, never during pan/zoom frames.
   */
  private seatLabelTargetScale(): number {
    let minimumFont = BOOTH_LABEL_FONT_SIZE;
    const measure = new Text({
      fontSize: SEAT_LABEL_FONT_SIZE,
      fontStyle: '600',
      fontFamily: this.labelFont(),
      listening: false,
    });
    const maxWidth = this.seatR * 2 - 3;
    for (const seat of this.seats) {
      if (seat.kind === 'booth') {
        minimumFont = Math.min(minimumFont, BOOTH_LABEL_FONT_SIZE);
        continue;
      }
      const authoredFontSize = SEAT_LABEL_FONT_SIZE * this.seatLabelScale(seat);
      measure.fontSize(authoredFontSize);
      measure.text(bookableMarkerLabel(seat.displayLabel ?? seat.label));
      const fitted = measure.width() > maxWidth
        ? Math.max(MIN_FITTED_SEAT_LABEL_FONT_SIZE, (authoredFontSize * maxWidth) / measure.width())
        : authoredFontSize;
      minimumFont = Math.min(minimumFont, fitted);
    }
    measure.destroy();
    return MIN_VISIBLE_BOOKABLE_LABEL_PX / Math.max(MIN_FITTED_SEAT_LABEL_FONT_SIZE, minimumFont);
  }

  /** Recompute LOD (cache/labels) after any pan/zoom settles. */
  private afterViewChange(): void {
    this.updateLOD();
    this.updateFreeTextVisibility();
    this.updateLabels();
    this.scheduleViewChange();
  }

  /** rAF-coalesced `onViewChange` — at most one host callback per animation frame. */
  private scheduleViewChange(): void {
    if (this.viewChangeRaf) return;
    this.viewChangeRaf = requestAnimationFrame(() => {
      this.viewChangeRaf = 0;
      this.opts.onViewChange?.();
    });
  }

  private updateLOD(): void {
    // Effective scale folds in the iso y-squash (smaller ⇒ seats read smaller),
    // so LOD/melt thresholds trip correctly in 3D view. Equals the raw stage
    // scale at isoT=0 → flat behaviour is unchanged.
    const scale = this.effScale();
    const focalScale = Math.max(scale, 0.0001);
    for (const [label, targetPx] of this.primaryFocalLabels) {
      this.sizeLabel(label, targetPx / focalScale, label.y());
    }
    if (this.hasSections) this.applySectionLod(scale);
    else if (this.primaryFocalLabels.size) this.bgLayer.batchDraw();
    this.paintGAStateForView();
    // Reveal/hide the per-seat accessibility glyphs for this zoom BEFORE the
    // cache decision below, so the seat-layer bitmap bakes them in/out to match.
    this.updateAccessGlyphs(scale);
    const shouldCache = scale < CACHE_THRESHOLD;
    if (shouldCache && !this.cached) {
      this.cacheSeatLayer();
    } else if (!shouldCache && this.cached) {
      this.seatLayer.clearCache();
      this.seatLayer.listening(true);
      this.cached = false;
      this.seatLayer.batchDraw();
    }
  }

  /** Rebuild the seat-layer bitmap synchronously (no paint). Shared by the
   *  debounced cacheSeatLayer() and the synchronous forceDraw() catch-up. */
  private rebuildSeatCache(): void {
    // Cache at ~screen resolution: bitmap px ≈ on-screen px, so a huge chart in
    // chart-units doesn't blow up into a gigapixel canvas when zoomed out.
    const pr = clamp(this.stage.scaleX() * this.dpr, 0.15, 2);
    this.seatLayer.clearCache();
    this.seatLayer.cache({ pixelRatio: pr });
    this.seatLayer.listening(false);
    this.cached = true;
  }

  private cacheSeatLayer(): void {
    this.rebuildSeatCache();
    this.seatLayer.batchDraw();
  }

  /**
   * SYNCHRONOUS repaint that bypasses requestAnimationFrame — see the
   * ISeatmapRenderer.forceDraw() contract. Chrome pauses rAF (and therefore
   * Konva's batchDraw) on hidden/backgrounded/occluded tabs, so seat-status
   * deltas applied via setStatus() mutate the scene graph but never reach the
   * canvas until the tab is foregrounded. This flushes the cache-debounce and
   * paints every layer setStatus() can touch, immediately.
   *
   * Additive: the foreground path never calls this, so foreground behaviour is
   * byte-identical.
   */
  forceDraw(): void {
    // Flush any pending cache-debounce (setStatus coalesces bursts behind a
    // 150ms setTimeout) so a returning tab isn't left showing a stale bitmap.
    if (this.recacheTimer) {
      clearTimeout(this.recacheTimer);
      this.recacheTimer = null;
      // Fold coalesced deltas into a bitmap only if the CURRENT camera is still
      // on the cached overview rung. A status update can queue this timer and a
      // subsequent detail zoom can uncache the layer before forceDraw(); blindly
      // rebuilding here would disable pointer listening on live detail seats.
      if (this.effScale() < CACHE_THRESHOLD) {
        this.rebuildSeatCache();
      } else if (this.cached) {
        this.seatLayer.clearCache();
        this.seatLayer.listening(true);
        this.cached = false;
      }
    }
    // Synchronous paint of every layer setStatus() may repaint. Layer.draw()
    // renders on the calling thread, unlike batchDraw()'s rAF schedule.
    this.bgLayer.draw();
    this.seatLayer.draw();
    this.overlayLayer.draw();
  }

  private updateFreeTextVisibility(): void {
    const effectiveScale = this.effScale();
    for (const { objectId, node, categoryKey, kind } of this.freeTextById.values()) {
      const gaDimmed = categoryKey != null
        && (kind === 'ga-label' || kind === 'ga-capacity')
        && this.gaCategoryDimmed(categoryKey);
      const gaOverviewHidden = objectId != null
        && (kind === 'ga-label' || kind === 'ga-capacity')
        && this.gaById.get(objectId)?.sectionId != null
        && effectiveScale < CACHE_THRESHOLD;
      node.visible(!gaDimmed && !gaOverviewHidden && isBookableLabelLegibleAtScale(node.fontSize(), effectiveScale));
    }
  }

  private updateLabels(): void {
    const effectiveScale = this.effScale();
    const show = effectiveScale >= LABEL_SCALE;
    for (const [id, label] of this.boothLabelById) {
      const shape = this.circleById.get(id);
      label.visible(
        isBookableLabelLegibleAtScale(label.fontSize(), effectiveScale)
        && (shape?.opacity() ?? 1) >= 0.5,
      );
    }
    this.labelGroup.destroyChildren();
    this.seatLabelById.clear();
    if (!show) {
      this.overlayLayer.batchDraw();
      return;
    }
    // Visible chart rect (with a small margin) in chart coordinates.
    const s = this.stage.scaleX();
    const x0 = (-this.stage.x()) / s;
    const y0 = (-this.stage.y()) / s;
    const x1 = (this.stage.width() - this.stage.x()) / s;
    const y1 = (this.stage.height() - this.stage.y()) / s;

    let count = 0;
    for (const seat of this.seats) {
      // Booth labels already live beside their rectangular shape in seatLayer
      // (renderBoothUnit). Adding them again to the zoom-only overlay produces
      // the offset/doubled numbers visible at close zoom levels.
      if (seat.kind === 'booth') continue;
      if (seat.x < x0 || seat.x > x1 || seat.y < y0 || seat.y > y1) continue;
      // Accessible seats show their accessibility glyph in place of the seat
      // number (venue-map convention) — skip the overlay number so the two don't
      // stack. The glyph is always legible before labels are (lower zoom gate),
      // so an accessible seat is never left with no on-seat mark here.
      if (seat.accessible && this.accessGlyphVisible) continue;
      const shape = this.circleById.get(seat.id);
      if ((shape?.opacity() ?? 1) < 0.5) continue;
      const status = this.statusById.get(seat.id) ?? 'free';
      // Buyers see another buyer's hold as an unavailable lock, without its
      // inventory label. Organizers in manage mode retain the held unit's
      // identity so they can inspect or release it from the control room.
      const unavailable = status === 'booked'
        || (status === 'held' && !this.ownedHold.has(seat.id) && !this.opts.manageMode);
      if (unavailable) {
        // Status is geometry, not a letter: a centred lock for a temporary hold
        // and one quiet diagonal mark for sold. This stays aligned at every
        // zoom level and does not ask buyers to decode "H" or a large × glyph.
        const cue = new Group({ x: seat.x, y: seat.y, listening: false });
        if (status === 'held') {
          cue.add(new Rect({
            x: -4.2, y: -0.7, width: 8.4, height: 6.5, cornerRadius: 1.3,
            stroke: '#ffffff', strokeWidth: 1.25, listening: false,
          }));
          cue.add(new Line({
            points: [-2.4, -0.8, -2.4, -2.7, -1.2, -4, 0, -4.35, 1.2, -4, 2.4, -2.7, 2.4, -0.8],
            stroke: '#ffffff', strokeWidth: 1.2, lineCap: 'round', lineJoin: 'round', listening: false,
          }));
        } else {
          cue.add(new Line({
            points: [-4.2, 4.2, 4.2, -4.2], stroke: '#ffffff', strokeWidth: 1.8,
            lineCap: 'round', listening: false,
          }));
        }
        this.labelGroup.add(cue);
        if (++count >= MAX_LABELS) break;
        continue;
      }
      // Authored per-seat size scales the neutral default BEFORE auto-fit, so
      // the fit/shrink/legibility logic below still runs on top of it.
      const authoredFontSize = SEAT_LABEL_FONT_SIZE * this.seatLabelScale(seat);
      const t = new Text({
        x: seat.x,
        y: seat.y,
        text: bookableMarkerLabel(seat.displayLabel ?? seat.label),
        fontSize: authoredFontSize,
        fontStyle: '600',
        fontFamily: this.labelFont(),
        fill: shape ? this.seatLabelInk(seat, shape) : this.seatPreferredLabelInk(seat),
        listening: false,
        perfectDrawEnabled: false,
      });
      // Auto-fit: shrink long labels (e.g. "T10-10") so they never spill out of
      // the seat circle. Down to a legibility floor; below that the label is
      // dropped rather than rendered as an unreadable speck.
      const maxW = this.seatR * 2 - 3;
      if (t.width() > maxW) t.fontSize(Math.max(MIN_FITTED_SEAT_LABEL_FONT_SIZE, (authoredFontSize * maxW) / t.width()));
      // The minimum fitted font can still be wider than the physical marker
      // for verbose row labels. Never let text spill across adjacent seats;
      // keep the seat interactive and let the picker/tooltip expose its label.
      if (t.width() > maxW + 0.01) { t.destroy(); continue; }
      if (!isBookableLabelLegibleAtScale(t.fontSize(), effectiveScale)) { t.destroy(); continue; }
      t.offsetX(t.width() / 2);
      t.offsetY(t.height() / 2);
      this.labelGroup.add(t);
      this.seatLabelById.set(seat.id, t);
      if (++count >= MAX_LABELS) break;
    }
    // Keep freshly-built seat labels upright under the iso layer skew.
    if (this.isoT > 0) this.applyUprightLabels();
    this.overlayLayer.batchDraw();
  }

  private handleResize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    if (w === this.stage.width() && h === this.stage.height()) return;
    this.stage.size({ width: w, height: h });
    // Keep the chart framed; refit is the least surprising behaviour on resize.
    this.zoomToFit();
  }

  private startFpsLoop(): void {
    const tick = (now: number) => {
      if (!this.lastFpsAt) this.lastFpsAt = now;
      this.frames++;
      const elapsed = now - this.lastFpsAt;
      if (elapsed >= 1000) {
        this.opts.onFps?.(Math.round((this.frames * 1000) / elapsed));
        this.frames = 0;
        this.lastFpsAt = now;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }
}

export function createRenderer(container: HTMLDivElement, opts?: RendererOptions): ISeatmapRenderer {
  return new SeatmapRenderer(container, opts);
}
