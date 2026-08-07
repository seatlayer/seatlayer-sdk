/**
 * The JS-side source of truth for the 3D scene — a pure, GPU-free description
 * built once from the chart's existing height contract. Everything the renderer
 * uploads (merged solid geometry, the instanced seat cloud, camera-framing
 * bounds, the seat-state colour LUT) is derived here, so it survives a WebGL
 * context loss: on `webglcontextrestored` the renderer simply re-uploads from
 * this model without recomputing anything.
 *
 * Feeds 100% from `sectionGeometry` / `Floor.baseHeightM` / `ExpandedSeat`
 * (docs/3d-program-workorder §Architecture) — no new chart data is invented.
 */

import type { ChartDoc, ChartObject, ExpandedSeat, Point, SectionObject, ShapeObject } from '../../core/types';
import { CHART_UNITS_PER_METRE } from '../../core/units';
import { SEAT_STATES, STRUCTURE, hexToRgb, mix, desaturate, scaleRgb, type RGB } from '../palette';
import { resolveTheme3D, themeSeatColorLUT, type Theme3D } from '../theme';
import { centroidOf, type SceneLabel } from '../labels';
import {
  MeshBuilder, extrudePrism, mergeMeshData, ellipsePolygon, rectPolygon, outsetRing, M, type MeshData,
} from './geometry';
import polygonClipping from 'polygon-clipping';
import { buildSeatInstances, SEAT_DOT_RADIUS_M, type SeatInstanceData } from './seatInstances';
import { computeSeatYaw } from './seatChair';
import { buildVenueSurfaces, CAP_MAX_ERROR_M, type SectionSurface } from './surface';

/** Axis-aligned stage footprint in world metres. */
export interface StageBounds {
  cx: number;
  cz: number;
  y: number;
  halfX: number;
  halfZ: number;
}
import { emitDeckBands, deckFootprints, rowNeighbourhoods } from './deckBands';

/** One resolved plane of geometry — a single-floor chart is one of these. */
interface FloorUnit {
  objects: ChartObject[];
  focal: Point;
  baseHeightM: number;
}

/**
 * A navigable zone — the venue's own top-level grouping (Orchestra, Lower Bowl,
 * Hall A), resolved for camera framing and for the section/zone LOD rung.
 *
 * Every shipped chart authors zones and gives every section one, and the 2D
 * renderer uses them as its farthest LOD rung. 3D ignored them entirely, so the
 * one structure a buyer navigates by ("take me to the Grand Circle") had no
 * representation at all in the 3D view.
 */
export interface SceneZone {
  id: string;
  label: string;
  /** Authored zone colour, or null when the chart leaves it to the category mix. */
  color: RGB | null;
  /** Section object ids belonging to this zone. */
  sectionIds: string[];
  /** Seats resolved into this zone. */
  seatCount: number;
  /** World-metre centre of the zone's seats (camera target). */
  center: [number, number, number];
  /** Half-diagonal of its footprint, world metres (camera fit). */
  radius: number;
  /** What this zone faces — its authored focal, else the venue's. */
  focalWorld: [number, number, number];
}

/**
 * One seated section, resolved for navigation — the middle rung of the venue
 * ladder, between a zone and a seat. A chart with no zones authored still has
 * sections, so this is the level at which every venue can be navigated.
 */
export interface SceneSection {
  id: string;
  /** Buyer-facing name, matching the section label. */
  label: string;
  seatCount: number;
  /** World-metre centre of the section's seats (camera target). */
  center: [number, number, number];
  /** Half-diagonal of its seat footprint, world metres (camera fit). */
  radius: number;
  /** What this section faces — the camera approaches from this side. */
  focalWorld: [number, number, number];
}

/** One authored row resolved for guided large-venue navigation. */
export interface SceneRow {
  id: string;
  label: string;
  sectionId?: string;
  seatCount: number;
  center: [number, number, number];
  radius: number;
}

/** A navigable floor — a logical level of the venue. */
export interface SceneFloor {
  index: number;
  id: string;
  label: string;
  seatCount: number;
  center: [number, number, number];
  radius: number;
}

export interface SceneModel {
  /** Every non-seat surface merged into one triangle soup (1 draw call). */
  solids: MeshData;
  seats: SeatInstanceData;
  bounds: {
    /** World-metre venue centre (camera target). */
    center: [number, number, number];
    /** Half-diagonal of the horizontal footprint, metres (camera fit). */
    radius: number;
    groundY: number;
  };
  /** 5 × vec3 flat LUT for the seat fragment shader. */
  stateColorLUT: number[];
  /** Resolved colours for this chart's authored theme (background, seat scale). */
  theme: Theme3D;
  seatCount: number;
  /** Venue focal point in world metres (cinematic look-at target). */
  focalWorld: [number, number, number];
  /** The venue's zones, in authored order. Empty when the chart has none. */
  zones: SceneZone[];
  /**
   * Stage footprints in world metres.
   *
   * Collected for stage lighting, which is not shipped: additive cones were
   * built, placed correctly and still could not be read from a seat (see
   * `git log` for `stageLight.ts`). The bounds stay because they are cheap,
   * correct, and exactly what a second attempt needs — the geometry was never
   * the hard part, the technique was.
   */
  stages: StageBounds[];
  /** Seated sections, in authored order — the navigable middle rung. */
  sections: SceneSection[];
  /** Rows used by the Section → Row → Seat locator. */
  rows: SceneRow[];
  /**
   * The venue's floors, in authored order. A single-floor chart reports one.
   *
   * Every shipped multi-floor template puts all its floors at baseHeightM 0 and
   * takes height from the sections instead, so floors are a logical grouping,
   * not a physical stack. What they need is ISOLATION: draw all three of an
   * opera house at once and the balcony sits over the parterre.
   */
  floors: SceneFloor[];
  /**
   * Everything worth naming, with a world anchor: zones, sections, authored
   * wayfinding text, and booths. Rendered as a DOM overlay — see `labels.ts` for
   * why text is not geometry here.
   */
  labels: SceneLabel[];
}

export function shapeVisibleInConfiguration(
  shape: Pick<ShapeObject, 'eventConfigurationIds'>,
  activeConfigurationId?: string,
): boolean {
  const ids = shape.eventConfigurationIds;
  return !ids?.length || (!!activeConfigurationId && ids.includes(activeConfigurationId));
}

function visibleObjects(objects: ChartObject[], activeConfigurationId?: string): ChartObject[] {
  return objects.filter((object) => (
    object.type !== 'shape' || shapeVisibleInConfiguration(object, activeConfigurationId)
  ));
}

function floorUnits(doc: ChartDoc, activeConfigurationId?: string): FloorUnit[] {
  if (doc.floors?.length) {
    return doc.floors.map((f) => ({
      objects: visibleObjects(f.objects, activeConfigurationId),
      focal: f.focalPoint ?? doc.focalPoint,
      baseHeightM: f.baseHeightM ?? 0,
    }));
  }
  return [{ objects: visibleObjects(doc.objects, activeConfigurationId), focal: doc.focalPoint, baseHeightM: 0 }];
}

const AO = { top: 1.0, wallBottom: 0.5, bottomCap: 0.4 };

// The cap's tessellation tolerance lives beside the surface it approximates
// (surface.ts), together with the seat clearance derived from it.

/**
 * Fold a surface's 2D fill colour into the dark structure palette: desaturate
 * ~40 %, darken, then ground it in the neutral structure grey so a tier top
 * reads architectural — a recognisable hue (purple/green/orange) but muted, not
 * candy-coloured paint. Risers/walls stay neutral concrete; baked AO still
 * multiplies these per vertex downstream. `null` fill ⇒ the neutral grey.
 */
function tintTop(fill: RGB | null, neutral: RGB): RGB {
  if (!fill) return neutral;
  const muted = scaleRgb(desaturate(fill, 0.4), 0.62);
  return mix(neutral, muted, 0.72);
}

/**
 * Resolve each section's 2D paint colour, keyed by logical section id
 * (`logicalSectionId ?? id`, matching how expanded seats attribute `sectionId`):
 * the count-weighted mix of its member seats' category colours — the same source
 * the 2D renderer blends into a section's block fill. An explicit `section.color`
 * override is applied later (it wins in `sectionFill`).
 */
function resolveSectionFills(doc: ChartDoc, seats: ExpandedSeat[]): Map<string, RGB> {
  const catColor = new Map<string, string>();
  for (const c of doc.categories ?? []) catColor.set(c.key, c.color);
  const counts = new Map<string, Map<string, number>>();
  for (const s of seats) {
    if (!s.sectionId) continue;
    let m = counts.get(s.sectionId);
    if (!m) { m = new Map(); counts.set(s.sectionId, m); }
    m.set(s.categoryKey, (m.get(s.categoryKey) ?? 0) + 1);
  }
  const out = new Map<string, RGB>();
  for (const [sid, byCat] of counts) {
    let r = 0, g = 0, b = 0, w = 0;
    for (const [key, n] of byCat) {
      const rgb = hexToRgb(catColor.get(key));
      if (!rgb) continue;
      r += rgb[0] * n; g += rgb[1] * n; b += rgb[2] * n; w += n;
    }
    if (w > 0) out.set(sid, [r / w, g / w, b / w]);
  }
  return out;
}

/** A section's fill: explicit `color` override wins, else the member-category mix. */
function sectionFill(section: SectionObject, byLogical: Map<string, RGB>): RGB | null {
  return hexToRgb(section.color) ?? byLogical.get(section.logicalSectionId ?? section.id) ?? null;
}

/**
 * Extrude one section into the shared builder, capped by ITS OWN seating surface.
 *
 * The height function is not recomputed here — it comes from `surface.ts`, the
 * same object the seat dots stand on. That is the whole point: there is one
 * definition of the seating surface, and the cap, the walls and the seats all
 * read it, so no cross-file offset constant has to be kept in agreement.
 */
interface RingBox { minX: number; minY: number; maxX: number; maxY: number }

function bboxOfRing(ring: readonly Point[]): RingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function boxesOverlap(a: RingBox, b: RingBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * A section's padded outline with every OTHER section's authored outline removed.
 *
 * Deck padding grows a section by 0.33 m so a seat authored hard against its
 * boundary still rests on deck. Where two sections abut, that growth crosses into
 * the neighbour — and if the neighbour is lower, the overhang covers its seats.
 * Measured on the concert hall: 27 stalls-terrace seats buried by 0.20 m beneath
 * the terrace beside them, which sits 0.60 m higher.
 *
 * Clipping to the section's own padded ring is not enough, because the padding IS
 * the intrusion. The rule that works is: grow to hold your own seats, but never
 * over another section's floor.
 */
function paddedFootprint(section: SectionObject, siblings: readonly SectionObject[]): Point[][] {
  const padded = outsetRing(section.outline, SEAT_DOT_RADIUS_M * 1.5 * CHART_UNITS_PER_METRE);
  // Only siblings whose bounding box actually overlaps can remove any area, and
  // a polygon boolean is expensive. Differencing against EVERY sibling made
  // scene build quadratic in section count: measured 2.7 s at 50k seats / 40
  // sections and 11.7 s at 99k / 60, where doubling the venue cost 4.3x the
  // time. A venue's sections are laid out around it, so almost no pair overlaps
  // and this prunes nearly all of the work.
  const box = bboxOfRing(padded);
  const others = siblings.filter((o) => o !== section
    && o.outline && o.outline.length >= 3
    && boxesOverlap(box, bboxOfRing(o.outline)));
  if (!others.length) return [padded];
  const toRing = (pts: readonly Point[]): [number, number][] => {
    const r = pts.map((p) => [p.x, p.y] as [number, number]);
    r.push(r[0]);
    return r;
  };
  try {
    const diff = polygonClipping.difference([toRing(padded)], ...others.map((o) => [toRing(o.outline)]));
    const out: Point[][] = [];
    for (const poly of diff) {
      if (!poly.length) continue;
      const pts = poly[0].map(([x, y]) => ({ x, y }));
      if (pts.length > 1) {
        const f = pts[0], l = pts[pts.length - 1];
        if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) pts.pop();
      }
      if (pts.length >= 3) out.push(pts);
    }
    return out.length ? out : [padded];
  } catch {
    return [padded];
  }
}

/** Intersect each block footprint with the section's own allowed area. */
function clipFootprints(
  blocks: ReturnType<typeof deckFootprints>,
  allowed: Point[][],
): ReturnType<typeof deckFootprints> {
  if (!allowed.length) return blocks;
  const toRing = (pts: readonly Point[]): [number, number][] => {
    const r = pts.map((p) => [p.x, p.y] as [number, number]);
    r.push(r[0]);
    return r;
  };
  const allowedPolys = allowed.map((a) => [toRing(a)]);
  const out: ReturnType<typeof deckFootprints> = [];
  for (const b of blocks) {
    // NOTE: a "skip the clip when the block looks contained" fast path was tried
    // here and reverted. Testing that the block's VERTICES lie inside the allowed
    // ring is not sound for a CONCAVE allowed region — and a section footprint is
    // routinely concave, since an arena wedge curves inward and siblings are
    // subtracted from it. An edge can bulge outside while every vertex is inside,
    // which buried seats on the arena. A sound test needs edge-intersection
    // checks, which is most of the cost of the boolean it would be avoiding.
    let pieces;
    try {
      pieces = polygonClipping.intersection([toRing(b.outline)], ...[allowedPolys.flat()]);
    } catch {
      out.push(b);
      continue;
    }
    for (const poly of pieces) {
      if (!poly.length) continue;
      const pts = poly[0].map(([x, y]) => ({ x, y }));
      if (pts.length > 1) {
        const f = pts[0], l = pts[pts.length - 1];
        if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) pts.pop();
      }
      if (pts.length >= 3) out.push({ outline: pts, holes: [], topY: b.topY });
    }
  }
  return out.length ? out : blocks;
}

function buildTier(
  builder: MeshBuilder,
  section: SectionObject,
  unit: FloorUnit,
  fill: RGB | null,
  surface: SectionSurface | undefined,
  claimed: ClaimedArea,
  siblings: readonly SectionObject[],
  S: typeof STRUCTURE,
): void {
  if (!section.outline || section.outline.length < 3) return;
  const bottomY = unit.baseHeightM;
  const colTop = tintTop(fill, S.tierTop);
  if (!surface) return;
  const topY = (p: Point): number => surface.deckAt(p.x, p.y);
  // Pad the deck so a seat authored hard against the section boundary rests ON
  // its own section instead of overhanging into the aisle. Seats are chart data
  // and never move; the deck grows to meet them. 1.5x the dot footprint: enough
  // that a dot sitting exactly on the boundary still lands clear of the edge,
  // and small against real aisle widths.
  const footprint = paddedFootprint(section, siblings);
  const outline = footprint[0] ?? section.outline;

  // A section whose rows resolved into levels is drawn as GEOMETRY, not as a
  // tessellated field: a flat landing prism carrying one level ribbon per row,
  // with a riser between consecutive ribbons. See `deckBands.ts` for why a
  // refined cap cannot work once every row has to be level.
  if (surface.rowLevels.length >= 2) {
    // One base prism per BLOCK, hugging the ribbons above it, instead of one flat
    // plate over the section's whole authored outline. The outline reaches well
    // past the seating, so a single plate stuck out around the stands as a slab
    // and cut every block's end square through it. Each block also stands on its
    // OWN lowest row rather than the section's.
    // Clipped to the section's own footprint like the treads are: a block base is
    // built from a ribbon union carrying its own outward margin, so it overhangs
    // for the same reason and buries a lower neighbour's seats the same way.
    // One neighbourhood solve, shared by the footprint and the emission below.
    const nbrs = rowNeighbourhoods(surface.rowLevels);
    const blocks = clipFootprints(deckFootprints(surface.rowLevels, unit.focal, nbrs), footprint);
    // Explicit UP normals rather than face normals. A block footprint is a
    // boolean union of ~100 overlapping ribbons, and such a union always leaves
    // some very thin triangles along its seams; deriving a normal from one by
    // cross product is numerically meaningless and shades as a dark hairline.
    // The top is FLAT, so the correct normal is known outright and the thin
    // triangles become harmless.
    const capUp = (): [number, number, number] => [0, 1, 0];
    for (const b of blocks) {
      extrudePrism(builder, b.outline, b.holes, () => b.topY, bottomY,
        colTop, S.tierWall, AO, undefined, capUp);
    }
    // Nothing resolved (a degenerate row set) — fall back to the outline so the
    // section is never simply missing.
    if (!blocks.length) {
      extrudePrism(builder, outline, section.holes, () => surface.landingY, bottomY,
        colTop, S.tierWall, AO);
    }
    emitDeckBands(builder, surface.rowLevels, unit.focal, surface.landingY, {
      tread: [colTop[0] * AO.top, colTop[1] * AO.top, colTop[2] * AO.top],
      // Risers read as the structure they are, a shade below their tread, which
      // is what makes the stepping legible from a low angle.
      riser: [colTop[0] * 0.72, colTop[1] * 0.72, colTop[2] * 0.72],
    }, footprint.length === 1 ? outline : footprint.flat(), nbrs);
    return;
  }

  // A flat section's cap is exact at any tessellation, so it is left
  // unsubdivided (Infinity) and stays identical to the pre-surface mesh —
  // legacy height-less charts must not shift by a single vertex.
  const maxErr = surface.flat ? Infinity : CAP_MAX_ERROR_M;
  const topN = (p: Point): [number, number, number] => surface.normalAt(p.x, p.y);

  // Take only the ground this section has not already lost to an earlier one.
  //
  // Every flat section's top sits at exactly the same height, and the deck
  // padding above grows each one by 0.33 m, so neighbouring sections OVERLAP.
  // Two coplanar surfaces at identical depth is a z-fight, and it renders as a
  // serrated comb of interpenetrating teeth along every shared boundary — the
  // artifact visible on the flat chart. Depth-biasing them apart would hide it
  // rather than fix it, and would break down as soon as a chart has many
  // sections. Removing the overlap means there is nothing to fight over.
  // A flat section's deck is one constant height, so it can be tested for
  // coplanarity; a raked fallback surface has no single height to offer.
  const level = surface.flat ? surface.landingY : undefined;
  for (const ring of claimed.subtract(outline, level)) {
    extrudePrism(builder, ring, section.holes, topY, bottomY, colTop, S.tierWall, AO, maxErr, topN);
  }
}

/**
 * The ground already taken by sections drawn so far, so a later section can be
 * clipped to what is left. Only meaningful between COPLANAR surfaces, which is
 * why raked sections (each at its own height) never reach this.
 */
/** Two claims fight for the same ground only if both are level and level TOGETHER.
 * A claim with no single height (an unresolved raked surface) is treated as
 * comparable with everything, which is what it did before heights existed. */
function coplanarLevels(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return Math.abs(a - b) < 1e-3;
}

class ClaimedArea {
  private rings: Array<[number, number][][]> = [];
  private boxes: RingBox[] = [];
  /** Constant deck height of each claim, or undefined when it is not level. */
  private levels: Array<number | undefined> = [];

  /**
   * `ring` minus everything claimed so far AT THE SAME HEIGHT; then claim it.
   *
   * `level` is the claim's constant deck height when it has one. Two decks only
   * z-fight when they are coplanar, so only a coplanar claim may take ground
   * away — an elevated box hanging over a ground-level section overlaps it in
   * plan and must still draw its whole floor, or the box loses the part of its
   * deck that shares a footprint with whatever is underneath it. Passing
   * undefined (a surface with no single height) keeps the original
   * clip-against-everything behaviour.
   */
  subtract(ring: Point[], level?: number): Point[][] {
    const closed: [number, number][] = ring.map((p) => [p.x, p.y]);
    if (closed.length < 3) return [];
    closed.push(closed[0]);
    const box = bboxOfRing(ring);
    // Same prune as `paddedFootprint`: a claim that cannot overlap cannot remove
    // anything, and without this the boolean work is quadratic in section count.
    const overlapping = this.rings.filter((_, i) => boxesOverlap(box, this.boxes[i])
      && coplanarLevels(level, this.levels[i]));
    let pieces: Array<[number, number][][]> = [[closed]];
    if (overlapping.length) {
      try {
        const diff = polygonClipping.difference([closed], ...overlapping);
        pieces = diff.map((poly) => poly.map((r) => r.map(([x, y]) => [x, y] as [number, number])));
      } catch {
        pieces = [[closed]]; // a degenerate outline must not drop the section
      }
    }
    this.rings.push([closed]);
    this.boxes.push(box);
    this.levels.push(level);
    const out: Point[][] = [];
    for (const poly of pieces) {
      if (!poly.length) continue;
      const pts = poly[0].map(([x, y]) => ({ x, y }));
      if (pts.length > 1) {
        const f = pts[0], l = pts[pts.length - 1];
        if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) pts.pop();
      }
      if (pts.length >= 3) out.push(pts);
    }
    return out;
  }
}

/**
 * Height of a booth stand, world metres — a partition wall, not a table.
 *
 * Trade-show and exhibition charts are entirely booths (267 across the two
 * shipped templates), and before this they drew nothing at all: the whole venue
 * rendered as empty floor. A booth is a sellable unit the buyer picks, so it has
 * to be a solid the camera can approach and the pointer can hit.
 */
const BOOTH_HEIGHT_M = 2.4;

/** How far a label floats above the thing it names, world metres. */
const ZONE_LABEL_LIFT_M = 6;
const SECTION_LABEL_LIFT_M = 2.2;
const ANNOTATION_LIFT_M = 0.1;
const BOOTH_LABEL_LIFT_M = 0.3;
/** A GA area is flat, so its name sits at head height over the standing floor. */
const GA_LABEL_LIFT_M = 1.8;
/** Row and seat labels ride just above their own deck, like painted markings. */
const ROW_LABEL_LIFT_M = 0.9;
const SEAT_LABEL_LIFT_M = 0.55;
/**
 * Seat-label ceiling. Above this the whole set is not emitted — see the note at
 * the emit site. 6,000 covers theatres, halls, cinemas and mid-size arenas; the
 * charts above it are exactly the ones where a per-seat label is least readable.
 */
const SEAT_LABEL_MAX = 6_000;

/** Height of a banquet table top, world metres (standard dining height). */
const TABLE_HEIGHT_M = 0.75;

/**
 * Height of a décor-image floor plate — a marking on the ground, not an object.
 *
 * Matched to the GA slab (0.15 m) rather than made as thin as it "should" be: a
 * 4 cm plate under a 76 m rink is a depth ratio of 5e-4 and Uber Arena's ice
 * z-fought the ground slab into horizontal stripes across the whole surface.
 */
const DECOR_PLATE_M = 0.15;

/** Resolve a booth to its closed chart-unit polygon, honouring a custom outline. */
function boothPolygon(booth: Extract<ChartObject, { type: 'booth' }>): Point[] | null {
  // A custom outline wins and ignores rotation, exactly as the 2D renderer does
  // (see BoothObject.points) — L-shaped and island units on an expo floor.
  if (booth.points && booth.points.length >= 3) return booth.points;
  const { center, width, height, rotation } = booth;
  if (!width || !height) return null;
  const a = ((rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const hw = width / 2, hh = height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
    x: center.x + lx * cos - ly * sin,
    y: center.y + lx * sin + ly * cos,
  }));
}

function buildBooth(
  builder: MeshBuilder,
  booth: Extract<ChartObject, { type: 'booth' }>,
  base: number,
  fill: RGB | null,
  S: typeof STRUCTURE,
): void {
  const poly = boothPolygon(booth);
  if (!poly) return;
  extrudePrism(builder, poly, undefined, () => base + BOOTH_HEIGHT_M, base,
    tintTop(fill, S.boothTop), S.boothWall, AO);
}

/** Resolve a table to its closed chart-unit polygon. */
function tablePolygon(table: Extract<ChartObject, { type: 'table' }>): Point[] | null {
  if (table.shape === 'round') {
    const r = table.radius;
    if (!r) return null;
    return ellipsePolygon(table.center.x, table.center.y, r, r, 24);
  }
  const { width, height, rotation, center } = table;
  if (!width || !height) return null;
  const a = ((rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const hw = width / 2, hh = height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
    x: center.x + lx * cos - ly * sin,
    y: center.y + lx * sin + ly * cos,
  }));
}

function buildTable(
  builder: MeshBuilder,
  table: Extract<ChartObject, { type: 'table' }>,
  base: number,
  fill: RGB | null,
  S: typeof STRUCTURE,
): void {
  const poly = tablePolygon(table);
  if (!poly) return;
  // Banquet and club charts (77 tables across the shipped templates) drew their
  // chairs floating around nothing. The table is what makes the arrangement read
  // as a table rather than a ring of stray seats.
  extrudePrism(builder, poly, undefined, () => base + TABLE_HEIGHT_M, base,
    tintTop(fill, S.tableTop), S.tableWall, AO);
}

function rotateShapePolygon(poly: Point[], degrees: number | undefined): Point[] {
  if (!degrees) return poly;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of poly) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return poly.map((point) => {
    const dx = point.x - cx, dy = point.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });
}

/** Resolve a shape object to its rotated closed chart-unit polygon. */
function shapePolygon(shape: Extract<ChartObject, { type: 'shape' }>): Point[] | null {
  let poly: Point[] | null = null;
  if (shape.kind === 'polygon' && shape.points && shape.points.length >= 3) poly = shape.points;
  if (shape.kind === 'rect' && shape.width && shape.height) {
    poly = rectPolygon(shape.x ?? 0, shape.y ?? 0, shape.width, shape.height);
  }
  if (shape.kind === 'ellipse' && shape.width && shape.height) {
    const cx = (shape.x ?? 0) + shape.width / 2;
    const cy = (shape.y ?? 0) + shape.height / 2;
    poly = ellipsePolygon(cx, cy, shape.width / 2, shape.height / 2);
  }
  return poly ? rotateShapePolygon(poly, shape.rotation) : null; // line / polyline are stroke-only
}

export type ShapeArchitectureKind = 'plate' | 'stage' | 'solid' | 'portal' | 'suite';
export interface ShapeArchitecture {
  kind: ShapeArchitectureKind;
  heightM: number;
}

/** Physical interpretation of the chart's existing décor vocabulary. */
export function architectureForShape(shape: Pick<ShapeObject, 'role' | 'heightM'>): ShapeArchitecture {
  const role = shape.role ?? '';
  const defaults: Record<string, ShapeArchitecture> = {
    stage: { kind: 'stage', heightM: 1 },
    entrance: { kind: 'portal', heightM: 2.7 },
    exit: { kind: 'portal', heightM: 2.7 },
    screen: { kind: 'solid', heightM: 6 },
    wall: { kind: 'solid', heightM: 2.8 },
    rail: { kind: 'solid', heightM: 1.1 },
    suite: { kind: 'suite', heightM: 3 },
    obstruction: { kind: 'solid', heightM: 4.5 },
    sound: { kind: 'solid', heightM: 1.45 },
    restroom: { kind: 'solid', heightM: 2.4 },
    bar: { kind: 'solid', heightM: 1.1 },
    concession: { kind: 'solid', heightM: 1.1 },
    coat: { kind: 'solid', heightM: 1.1 },
  };
  const resolved = defaults[role] ?? { kind: 'plate' as const, heightM: 0.25 };
  return { ...resolved, heightM: shape.heightM ?? resolved.heightM };
}

interface ShapeLayerFootprint {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  topOffsetM: number;
}

/**
 * Flat authored shapes share one solid draw call, so polygonOffset cannot
 * separate a marking from the surface below it. Preserve the 2D object order by
 * lifting only shapes whose footprints overlap something already emitted.
 * Eight centimetres remains visually flush at venue scale while clearing the
 * depth precision that made Cricket Oval's wicket strip flicker into slivers.
 */
const SHAPE_LAYER_LIFT_M = 0.08;

function claimShapeTopOffset(
  shape: Extract<ChartObject, { type: 'shape' }>,
  claimed: ShapeLayerFootprint[],
): number {
  const poly = shapePolygon(shape);
  const architecture = architectureForShape(shape);
  const defaultTop = architecture.heightM;
  if (!poly) return defaultTop;
  // Vertical architecture occupies real space; it does not participate in the
  // tiny z-fight lifts used to order overlapping painted floor plates.
  if (architecture.kind !== 'plate' && architecture.kind !== 'stage') return defaultTop;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  let topOffsetM = defaultTop;
  for (const prior of claimed) {
    const overlaps = maxX > prior.minX && minX < prior.maxX
      && maxY > prior.minY && minY < prior.maxY;
    if (overlaps && topOffsetM <= prior.topOffsetM + 1e-6) {
      topOffsetM = prior.topOffsetM + SHAPE_LAYER_LIFT_M;
    }
  }
  claimed.push({ minX, minY, maxX, maxY, topOffsetM });
  return topOffsetM;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function orientQuadLong(poly: Point[]): Point[] {
  if (poly.length !== 4) return poly;
  const edge0 = Math.hypot(poly[1].x - poly[0].x, poly[1].y - poly[0].y);
  const edge1 = Math.hypot(poly[2].x - poly[1].x, poly[2].y - poly[1].y);
  return edge0 >= edge1 ? poly : [poly[1], poly[2], poly[3], poly[0]];
}

function quadWidthSlice(poly: Point[], t0: number, t1: number): Point[] {
  return [
    lerpPoint(poly[0], poly[1], t0), lerpPoint(poly[0], poly[1], t1),
    lerpPoint(poly[3], poly[2], t1), lerpPoint(poly[3], poly[2], t0),
  ];
}

function quadDepthSlice(poly: Point[], t0: number, t1: number): Point[] {
  return [
    lerpPoint(poly[0], poly[3], t0), lerpPoint(poly[1], poly[2], t0),
    lerpPoint(poly[1], poly[2], t1), lerpPoint(poly[0], poly[3], t1),
  ];
}

function emitArchitecturalPrism(
  builder: MeshBuilder,
  poly: Point[],
  top: number,
  bottom: number,
  colTop: RGB,
  colWall: RGB,
): void {
  extrudePrism(builder, poly, undefined, () => top, bottom, colTop, colWall, AO);
}

function buildShape(
  builder: MeshBuilder,
  shape: Extract<ChartObject, { type: 'shape' }>,
  base: number,
  topOffsetM: number,
  S: typeof STRUCTURE,
  focal: Point,
  /** Collects the footprint of each STAGE, for the lighting rig above it. */
  stages?: StageBounds[],
): void {
  const poly = shapePolygon(shape);
  if (!poly) return;
  const isStage = shape.role === 'stage';
  const architecture = architectureForShape(shape);
  const height = base + topOffsetM;
  if (isStage && stages) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const pt of poly) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minZ) minZ = pt.y;
      if (pt.y > maxZ) maxZ = pt.y;
    }
    // Chart units -> world metres, matching every other position in the scene.
    stages.push({
      cx: ((minX + maxX) / 2) * M,
      cz: ((minZ + maxZ) / 2) * M,
      y: height,
      halfX: Math.max(((maxX - minX) / 2) * M, 0.5),
      halfZ: Math.max(((maxZ - minZ) / 2) * M, 0.5),
    });
  }
  // An authored `fill` is what the 2D renderer paints this shape (see
  // `renderShape`), and 3D used to discard it for a fixed grey — so an organizer
  // who coloured their stage, dance floor or pitch saw it in the map and lost it
  // the moment they switched to 3D. Muted through `tintTop` like every other
  // authored colour, so it keeps its hue without out-shouting the seating.
  const colTop = tintTop(hexToRgb(shape.fill), isStage ? S.stageTop : S.decorTop);
  // A screen's useful surface is vertical, so it needs to read from its WALL
  // faces rather than its almost invisible top cap. Treat it like a powered LED
  // panel; every other structure remains inside the muted architectural palette.
  const colWall: RGB = isStage
    ? S.stageWall
    : shape.role === 'screen'
      ? [0.24, 0.46, 0.82]
      : tintTop(hexToRgb(shape.fill), S.decorWall);
  if (architecture.kind === 'portal' && poly.length === 4) {
    const quad = orientQuadLong(poly);
    emitArchitecturalPrism(builder, quadWidthSlice(quad, 0, 0.16), height, base, colTop, colWall);
    emitArchitecturalPrism(builder, quadWidthSlice(quad, 0.84, 1), height, base, colTop, colWall);
    emitArchitecturalPrism(builder, quad, height, Math.max(base, height - 0.35), colTop, colWall);
    return;
  }
  if (architecture.kind === 'suite' && poly.length === 4) {
    const edgeDistances = poly.map((point, index) => {
      const next = poly[(index + 1) % 4];
      const mx = (point.x + next.x) / 2, my = (point.y + next.y) / 2;
      return Math.hypot(mx - focal.x, my - focal.y);
    });
    const front = edgeDistances.indexOf(Math.min(...edgeDistances));
    const quad = [0, 1, 2, 3].map((offset) => poly[(front + offset) % 4]);
    emitArchitecturalPrism(builder, quadWidthSlice(quad, 0, 0.08), height, base, colTop, colWall);
    emitArchitecturalPrism(builder, quadWidthSlice(quad, 0.92, 1), height, base, colTop, colWall);
    emitArchitecturalPrism(builder, quadDepthSlice(quad, 0.88, 1), height, base, colTop, colWall);
    emitArchitecturalPrism(builder, quad, height, Math.max(base, height - 0.18), colTop, colWall);
    return;
  }
  emitArchitecturalPrism(builder, poly, height, base, colTop, colWall);
}

/**
 * Resolve a décor image to its closed chart-unit polygon.
 *
 * `DecorImageObject` is authored as a top-left anchor plus size, rotated about
 * its own CENTRE — the same convention the 2D renderer uses when it offsets the
 * Konva node by half its extent.
 */
function decorPolygon(decor: Extract<ChartObject, { type: 'decorImage' }>): Point[] | null {
  const { x, y, width, height } = decor;
  if (!width || !height) return null;
  const cx = x + width / 2, cy = y + height / 2;
  const a = ((decor.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const hw = width / 2, hh = height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  }));
}

/**
 * The colour a décor plate is painted, sniffed from an SVG data URL.
 *
 * The renderer is deliberately texture-free (three draw calls, no atlas), so a
 * décor image cannot be drawn as an image. What it CAN do is paint the plate in
 * the graphic's own dominant colour, which is the difference between an ice rink
 * reading as ice and reading as a grey slab.
 *
 * The heuristic is narrow on purpose: take the paint of the FIRST covering
 * element (`<rect>` or `<path>`), because an SVG floor graphic is built up
 * background-first — the rink surface, then the lines on top of it. A gradient
 * reference resolves to the mean of that gradient's stops. Anything else (a
 * raster data URL, an external href, an SVG that does not match) returns null
 * and the caller falls back to the neutral décor tone, which is what the object
 * rendered as before this existed.
 */
function decorPlatePaint(href: string | undefined): RGB | null {
  if (!href || !href.startsWith('data:image/svg+xml')) return null;
  let svg = href.slice(href.indexOf(',') + 1);
  if (/;base64/i.test(href.slice(0, href.indexOf(',')))) {
    try { svg = atob(svg); } catch { return null; }
  } else {
    try { svg = decodeURIComponent(svg); } catch { /* already literal */ }
  }

  const covering = svg.match(/<(?:rect|path)\b[^>]*\bfill="([^"]+)"/i);
  if (!covering) return null;
  const paint = covering[1].trim();
  if (paint === 'none' || paint === 'transparent') return null;

  const gradient = paint.match(/^url\(#([^)]+)\)$/);
  if (!gradient) return hexToRgb(paint);

  // Average the referenced gradient's stops — a two-stop ice gradient is one
  // colour as far as a flat-shaded plate is concerned.
  const def = svg.match(new RegExp(`<(?:linear|radial)Gradient\\b[^>]*\\bid="${gradient[1]}"[^>]*>([\\s\\S]*?)</(?:linear|radial)Gradient>`, 'i'));
  if (!def) return null;
  const stops: RGB[] = [];
  for (const m of def[1].matchAll(/stop-color="([^"]+)"/gi)) {
    const c = hexToRgb(m[1].trim());
    if (c) stops.push(c);
  }
  if (!stops.length) return null;
  return stops.reduce<RGB>((acc, c, i) => mix(acc, c, 1 / (i + 1)), stops[0]);
}

function buildDecorImage(
  builder: MeshBuilder,
  decor: Extract<ChartObject, { type: 'decorImage' }>,
  base: number,
  S: typeof STRUCTURE,
): void {
  // A `foreground` décor image draws ABOVE the seats in 2D — a canopy or an
  // overlay graphic. In 3D an opaque plate over the seating would hide the very
  // thing the buyer came to pick from, so it is left undrawn rather than drawn
  // wrongly. No shipped template authors one; the designer can.
  if (decor.layer === 'foreground') return;
  const poly = decorPolygon(decor);
  if (!poly) return;
  // The plate is a floor marking, not an object: it sits a few centimetres proud
  // of the ground slab so it cannot z-fight, and well under the 0.25 m décor
  // shapes that may be standing on it.
  const top = base + DECOR_PLATE_M;
  // Muted into the structure palette exactly like a category fill on a tier cap.
  // Taken literally, the rink's #f4f9ff ice is the BRIGHTEST thing in the venue
  // and the floor out-shouts the seating — against the look brief, which puts
  // saturated colour only on seats. Through `tintTop` it keeps its blue cast and
  // sits in the same tonal range as every other surface.
  let paint = tintTop(decorPlatePaint(decor.href), S.decorTop);
  // No alpha in the solid pass, so authored opacity is honoured by mixing the
  // plate toward the ground it would otherwise be showing through to.
  const opacity = Math.max(0, Math.min(1, decor.opacity ?? 1));
  if (opacity < 1) paint = mix(S.ground, paint, opacity);
  extrudePrism(builder, poly, undefined, () => top, base, paint, mix(paint, S.decorWall, 0.5), AO);
}

function buildGa(builder: MeshBuilder, ga: Extract<ChartObject, { type: 'gaArea' }>, base: number, fill: RGB | null, S: typeof STRUCTURE): void {
  if (!ga.points || ga.points.length < 3) return;
  const colTop = tintTop(fill, S.gaTop);
  extrudePrism(builder, ga.points, ga.holes, () => base + 0.15, base, colTop, S.gaWall, AO);
}

/** Compute the horizontal chart-unit footprint over everything drawable. */
function chartFootprint(units: FloorUnit[], seats: ExpandedSeat[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number): void => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  for (const s of seats) acc(s.x, s.y);
  for (const u of units) {
    for (const o of u.objects) {
      if (o.type === 'section') for (const p of o.outline) acc(p.x, p.y);
      else if (o.type === 'shape' && o.points) for (const p of o.points) acc(p.x, p.y);
      else if (o.type === 'gaArea') for (const p of o.points) acc(p.x, p.y);
      else if (o.type === 'booth') { const b = boothPolygon(o); if (b) for (const p of b) acc(p.x, p.y); }
      else if (o.type === 'table') { const t = tablePolygon(o); if (t) for (const p of t) acc(p.x, p.y); }
      else if (o.type === 'decorImage') { const d = decorPolygon(o); if (d) for (const p of d) acc(p.x, p.y); }
    }
  }
  if (!Number.isFinite(minX)) { minX = -100; minY = -100; maxX = 100; maxY = 100; }
  return { minX, minY, maxX, maxY };
}

export interface SceneModelInput {
  doc: ChartDoc;
  seats: ExpandedSeat[];
  /** Overrides the chart's active layout without mutating its authored data. */
  eventConfigurationId?: string;
  /** Optional initial per-seat state (default all available). */
  initialState?: (seat: ExpandedSeat) => import('../palette').SeatState3D;
}

export function buildSceneModel(input: SceneModelInput): SceneModel {
  const { doc, seats } = input;
  // Resolved once and threaded down, so no builder reaches for the module-level
  // palette and quietly ignores an organizer's branding.
  const theme = resolveTheme3D(doc.theme);
  const S = theme.structure;
  const units = floorUnits(doc, input.eventConfigurationId ?? doc.eventConfigurationId);
  const builder = new MeshBuilder();

  // Ground slab sized to the footprint (+ margin), sitting at datum 0.
  const fp = chartFootprint(units, seats);
  const padU = Math.max(60, (fp.maxX - fp.minX + fp.maxY - fp.minY) * 0.06);
  const groundPoly = rectPolygon(fp.minX - padU, fp.minY - padU, (fp.maxX - fp.minX) + padU * 2, (fp.maxY - fp.minY) + padU * 2);
  extrudePrism(builder, groundPoly, undefined, () => 0, -0.4, S.ground, S.ground, AO);

  // Per-section 2D fill colours (member-category mix), carried onto tier tops.
  const sectionFills = resolveSectionFills(doc, seats);
  const catColor = new Map<string, string>();
  for (const c of doc.categories ?? []) catColor.set(c.key, c.color);
  const stageBounds: StageBounds[] = [];

  // ONE seating surface per section, resolved from the same model layout.ts uses
  // for eye heights. Consumed below by the tier caps and by the seat instances.
  const surfaces = buildVenueSurfaces(units, seats);
  /** Owning floor per seat, for per-instance floor isolation. */
  const seatFloor = new Float32Array(seats.length);

  // Coplanar sections must not overlap (see ClaimedArea). One claim per floor:
  // sections on different floors sit at different heights and cannot z-fight.
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const unit = units[unitIndex];
    builder.setFloor(unitIndex);
    const claimed = new ClaimedArea();
    const claimedShapeLayers: ShapeLayerFootprint[] = [];
    const siblings = unit.objects.filter((o): o is SectionObject => o.type === 'section' && !!o.outline && o.outline.length >= 3);
    for (const o of unit.objects) {
      if (o.type === 'section') buildTier(builder, o, unit, sectionFill(o, sectionFills), surfaces.bySection.get(o.id), claimed, siblings, S);
      else if (o.type === 'shape') buildShape(
        builder,
        o,
        unit.baseHeightM,
        claimShapeTopOffset(o, claimedShapeLayers),
        S,
        unit.focal,
        stageBounds,
      );
      else if (o.type === 'gaArea') buildGa(builder, o, unit.baseHeightM, hexToRgb(catColor.get(o.categoryKey)), S);
      else if (o.type === 'booth') buildBooth(builder, o, unit.baseHeightM, hexToRgb(catColor.get(o.categoryKey)), S);
      else if (o.type === 'table') buildTable(builder, o, unit.baseHeightM, hexToRgb(catColor.get(o.categoryKey)), S);
      else if (o.type === 'decorImage') buildDecorImage(builder, o, unit.baseHeightM, S);
    }
  }

  const focal = doc.focalPoint ?? { x: (fp.minX + fp.maxX) / 2, y: (fp.minY + fp.maxY) / 2 };

  // NOTE — per-row stepped treads (./rowSteps.ts) are DISABLED pending the
  // unified-surface rework. See docs/handover-2026-07-25-3d-surface-rework.md.
  //
  // They layered a second surface on top of the section prism, and the two could
  // not be kept in agreement across chart shapes: treads became large flat plates
  // that swallowed the stepping, sliver triangles appeared where seat ordering
  // failed, and seat dots were sliced by their own tread. The fix is one surface
  // function per section consumed by cap + steps + dots, not a second layer.
  // The module is kept (with its measurements in the doc comments) as input to
  // that rework; re-enabling it as-is is not the intended path.

  const solids = mergeMeshData([builder.build()]);
  const seatData: SeatInstanceData = buildSeatInstances(seats, input.initialState, surfaces, seatFloor, catColor);

  // --- Zones -----------------------------------------------------------------
  // Resolved from the SEATS, not the section outlines: a zone's meaning to a
  // buyer is the seats in it, and framing on the outlines would include the
  // aisles and margins a section is drawn with.
  const zoneDefs = doc.zones ?? [];
  const zones: SceneZone[] = [];
  if (zoneDefs.length) {
    const sectionZone = new Map<string, string>();
    for (const unit of units) {
      for (const o of unit.objects) {
        if (o.type === 'section' && o.zone) sectionZone.set(o.id, o.zone);
      }
    }
    interface Acc { n: number; minX: number; minY: number; maxX: number; maxY: number; sumY: number }
    const acc = new Map<string, Acc>();
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      // Prefer the seat's own resolved zone; fall back to its owning section's.
      const owner = surfaces.seatOwner[i];
      const zid = s.zoneId ?? (owner ? sectionZone.get(owner) : undefined);
      if (!zid) continue;
      let a = acc.get(zid);
      if (!a) { a = { n: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, sumY: 0 }; acc.set(zid, a); }
      a.n++;
      if (s.x < a.minX) a.minX = s.x;
      if (s.y < a.minY) a.minY = s.y;
      if (s.x > a.maxX) a.maxX = s.x;
      if (s.y > a.maxY) a.maxY = s.y;
      a.sumY += surfaces.seatDeckY(i);
    }
    for (const z of zoneDefs) {
      const a = acc.get(z.id);
      const sectionIds: string[] = [];
      for (const [secId, zid] of sectionZone) if (zid === z.id) sectionIds.push(secId);
      if (!a || a.n === 0) {
        // A zone with no seats still exists (an empty hall, a zone of GA areas);
        // report it rather than dropping it, so navigation can show it as empty.
        zones.push({
          id: z.id, label: z.label, color: hexToRgb(z.color), sectionIds, seatCount: 0,
          center: [0, 0, 0], radius: 0,
          focalWorld: [(z.focalPoint ?? focal).x * M, 1.5, (z.focalPoint ?? focal).y * M],
        });
        continue;
      }
      zones.push({
        id: z.id,
        label: z.label,
        color: hexToRgb(z.color),
        sectionIds,
        seatCount: a.n,
        center: [((a.minX + a.maxX) / 2) * M, a.sumY / a.n, ((a.minY + a.maxY) / 2) * M],
        radius: 0.5 * Math.hypot((a.maxX - a.minX) * M, (a.maxY - a.minY) * M) || 1,
        // A zone may face its own point (`ZoneDef.focalPoint`); the documented
        // fallback is the floor/chart focal.
        focalWorld: [(z.focalPoint ?? focal).x * M, 1.5, (z.focalPoint ?? focal).y * M],
      });
    }
  }

  // --- Labels ----------------------------------------------------------------
  const labels: SceneLabel[] = [];
  const sections: SceneSection[] = [];
  const rows: SceneRow[] = [];
  for (const z of zones) {
    if (z.seatCount === 0) continue;
    // Zone labels float above the seating they name, so they read as belonging
    // to the whole block rather than to whichever seat is under them.
    labels.push({
      id: `zone:${z.id}`,
      kind: 'zone',
      text: z.label,
      anchor: [z.center[0], z.center[1] + ZONE_LABEL_LIFT_M, z.center[2]],
      color: doc.zones?.find((d) => d.id === z.id)?.color,
    });
  }
  {
    // A section is named over its own SEATS, at their mean deck height. Its
    // outline centroid would drift into the aisles a concave section wraps, and
    // on a raked tier the label would sit at the wrong height entirely.
    const acc = new Map<string, { n: number; x: number; y: number; deck: number }>();
    // Seat extent per section, for the camera fit `focusSection` needs.
    const ext = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
    for (let i = 0; i < seats.length; i++) {
      const owner = surfaces.seatOwner[i];
      if (!owner) continue;
      let a = acc.get(owner);
      if (!a) { a = { n: 0, x: 0, y: 0, deck: 0 }; acc.set(owner, a); }
      a.n++; a.x += seats[i].x; a.y += seats[i].y; a.deck += surfaces.seatDeckY(i);
      let e = ext.get(owner);
      if (!e) { e = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }; ext.set(owner, e); }
      if (seats[i].x < e.minX) e.minX = seats[i].x;
      if (seats[i].x > e.maxX) e.maxX = seats[i].x;
      if (seats[i].y < e.minY) e.minY = seats[i].y;
      if (seats[i].y > e.maxY) e.maxY = seats[i].y;
    }
    for (const unit of units) {
      for (const o of unit.objects) {
        if (o.type !== 'section') continue;
        const a = acc.get(o.id);
        if (!a || a.n === 0) continue;
        const e = ext.get(o.id)!;
        const centre: [number, number, number] = [(a.x / a.n) * M, a.deck / a.n, (a.y / a.n) * M];
        sections.push({
          id: o.id,
          label: o.displayLabel || o.label || o.id,
          seatCount: a.n,
          center: centre,
          // Half-diagonal of the seat extent — the same fit the zones use.
          radius: Math.max(1, Math.hypot(e.maxX - e.minX, e.maxY - e.minY) * 0.5 * M),
          // A section faces its floor's focal, which is what the camera should
          // look along so the seats present their fronts.
          focalWorld: [unit.focal.x * M, unit.baseHeightM + 1.5, unit.focal.y * M],
        });
        labels.push({
          id: `section:${o.id}`,
          kind: 'section',
          // The buyer-facing name wins over the technical one, as it does in 2D.
          text: o.displayLabel || o.label || o.id,
          anchor: [centre[0], centre[1] + SECTION_LABEL_LIFT_M, centre[2]],
        });
      }
    }
  }
  // --- GA areas, rows and seats ----------------------------------------------
  {
    for (const unit of units) {
      for (const o of unit.objects) {
        if (o.type !== 'gaArea') continue;
        const c = centroidOf(o.points);
        if (!c) continue;
        // A GA area's capacity IS its buyer-facing fact — "Standing Floor" alone
        // does not say whether 40 or 4,000 people fit in it, and 2D shows the
        // number. The label carries both, as one line.
        const name = o.displayLabel || o.label || o.id;
        labels.push({
          id: `ga:${o.id}`,
          kind: 'ga',
          text: o.capacity > 0 ? `${name} · ${o.capacity.toLocaleString()}` : name,
          anchor: [c.x * M, unit.baseHeightM + GA_LABEL_LIFT_M, c.y * M],
        });
      }
    }

    // Rows are labelled at the END of the row, where a real venue paints them —
    // on the aisle, not over the middle of the seating. Anchored to the outermost
    // seat so the label tracks the row's own rake instead of a flat guess.
    const rowEnds = new Map<string, { seat: ExpandedSeat; index: number; far: number }>();
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      const far = Math.hypot(s.x - focal.x, s.y - focal.y);
      const cur = rowEnds.get(s.rowId);
      // "End" = furthest along the row from its own midpoint; approximated by
      // distance from the venue focal, which for a row is one of its two ends.
      if (!cur || far > cur.far) rowEnds.set(s.rowId, { seat: s, index: i, far });
    }
    for (const [rowId, end] of rowEnds) {
      // A seat's public label is `${rowLabel}-${seatNumber}`, so the row's name
      // is everything before the LAST separator — a row legitimately called
      // "A-1" in a segmented plan must not be truncated to "A".
      const cut = end.seat.label ? end.seat.label.lastIndexOf('-') : -1;
      const text = cut > 0 ? end.seat.label.slice(0, cut) : rowId;
      if (!text) continue;
      labels.push({
        id: `row:${rowId}`,
        kind: 'row',
        text,
        anchor: [end.seat.x * M, surfaces.seatDeckY(end.index) + ROW_LABEL_LIFT_M, end.seat.y * M],
      });
    }

    const rowAcc = new Map<string, {
      n: number; x: number; y: number; z: number;
      minX: number; maxX: number; minZ: number; maxZ: number;
      label: string; sectionId?: string;
    }>();
    for (let i = 0; i < seats.length; i++) {
      const seat = seats[i];
      const cut = seat.label ? seat.label.lastIndexOf('-') : -1;
      let acc = rowAcc.get(seat.rowId);
      if (!acc) {
        acc = {
          n: 0, x: 0, y: 0, z: 0,
          minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
          label: cut > 0 ? seat.label.slice(0, cut) : seat.rowId,
          sectionId: seat.sectionId,
        };
        rowAcc.set(seat.rowId, acc);
      }
      const offset = i * 3;
      const x = seatData.iPosition[offset];
      const y = seatData.iPosition[offset + 1];
      const z = seatData.iPosition[offset + 2];
      acc.n++; acc.x += x; acc.y += y; acc.z += z;
      acc.minX = Math.min(acc.minX, x); acc.maxX = Math.max(acc.maxX, x);
      acc.minZ = Math.min(acc.minZ, z); acc.maxZ = Math.max(acc.maxZ, z);
    }
    for (const [id, acc] of rowAcc) {
      rows.push({
        id,
        label: acc.label,
        sectionId: acc.sectionId,
        seatCount: acc.n,
        center: [acc.x / acc.n, acc.y / acc.n, acc.z / acc.n],
        radius: Math.max(0.8, Math.hypot(acc.maxX - acc.minX, acc.maxZ - acc.minZ) * 0.5),
      });
    }

    // Seat labels are the densest rung by far, and unlike every other kind their
    // count is the seat count. On a 52,000-seat ground that is 52,000 DOM-backed
    // labels to hold and project, for text that is only legible when a handful
    // are on screen. So they are emitted for charts where the whole set stays
    // cheap, and above that a seat identifies itself the way it already does on
    // every surface: by being tapped, which raises the seat's own card.
    if (seats.length <= SEAT_LABEL_MAX) {
      for (let i = 0; i < seats.length; i++) {
        const s = seats[i];
        const text = s.displayLabel || s.label;
        if (!text) continue;
        labels.push({
          id: `seat:${s.id}`,
          kind: 'seat',
          text,
          anchor: [s.x * M, surfaces.seatDeckY(i) + SEAT_LABEL_LIFT_M, s.y * M],
        });
      }
    }
  }

  for (const unit of units) {
    for (const o of unit.objects) {
      if (o.type === 'shape' && o.role && ['entrance', 'exit', 'screen', 'suite', 'obstruction'].includes(o.role)) {
        const poly = shapePolygon(o);
        const centre = poly ? centroidOf(poly) : null;
        if (!centre || !o.label) continue;
        labels.push({
          id: `architecture:${o.id}`,
          kind: 'annotation',
          text: o.label,
          anchor: [centre.x * M, unit.baseHeightM + architectureForShape(o).heightM + ANNOTATION_LIFT_M, centre.y * M],
          color: o.fill,
        });
      } else if (o.type === 'text') {
        // Authored wayfinding sits just above the floor it annotates — a door or
        // aisle name belongs to the ground, not to the air above it.
        if (!o.text) continue;
        labels.push({
          id: `text:${o.id}`,
          kind: 'annotation',
          text: o.text,
          anchor: [o.position.x * M, unit.baseHeightM + ANNOTATION_LIFT_M, o.position.y * M],
          color: o.color,
          rotation: o.rotation,
        });
      } else if (o.type === 'booth') {
        // A booth is a sellable unit the buyer picks by NAME, so it is labelled
        // on top of its own stand rather than left as an anonymous box.
        const poly = boothPolygon(o);
        if (!poly) continue;
        const c = centroidOf(poly);
        if (!c) continue;
        labels.push({
          id: `booth:${o.id}`,
          kind: 'booth',
          text: o.displayLabel || o.label || o.id,
          anchor: [c.x * M, unit.baseHeightM + BOOTH_HEIGHT_M + BOOTH_LABEL_LIFT_M, c.y * M],
        });
      }
    }
  }

  // --- Floors ----------------------------------------------------------------
  const floors: SceneFloor[] = [];
  {
    const sectionFloor = new Map<string, number>();
    for (let ui = 0; ui < units.length; ui++) {
      for (const o of units[ui].objects) if (o.type === 'section') sectionFloor.set(o.id, ui);
    }
    const acc = units.map(() => ({ n: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, sumY: 0 }));
    for (let i = 0; i < seats.length; i++) {
      const owner = surfaces.seatOwner[i];
      const ui = owner !== null ? sectionFloor.get(owner) : undefined;
      if (ui === undefined) continue;
      const a = acc[ui];
      const s = seats[i];
      a.n++;
      if (s.x < a.minX) a.minX = s.x;
      if (s.y < a.minY) a.minY = s.y;
      if (s.x > a.maxX) a.maxX = s.x;
      if (s.y > a.maxY) a.maxY = s.y;
      a.sumY += surfaces.seatDeckY(i);
      seatFloor[i] = ui;
    }
    for (let ui = 0; ui < units.length; ui++) {
      const a = acc[ui];
      const f = doc.floors?.[ui];
      floors.push({
        index: ui,
        id: f?.id ?? `floor-${ui}`,
        label: f?.name ?? (units.length > 1 ? `Floor ${ui + 1}` : 'Venue'),
        seatCount: a.n,
        center: a.n ? [((a.minX + a.maxX) / 2) * M, a.sumY / a.n, ((a.minY + a.maxY) / 2) * M] : [0, 0, 0],
        radius: a.n ? (0.5 * Math.hypot((a.maxX - a.minX) * M, (a.maxY - a.minY) * M) || 1) : 0,
      });
    }
  }

  // --- Seat facing -----------------------------------------------------------
  // Resolved here rather than in `buildSeatInstances` because it needs the thing
  // only this layer knows: which floor a seat belongs to, and therefore what it
  // looks at. Runs after the floors block above, which is what fills `seatFloor`.
  seatData.iYaw = computeSeatYaw(
    seatData.iPosition,
    seats.length,
    (i) => seats[i].rowId,
    (i) => {
      const f = units[seatFloor[i]]?.focal ?? focal;
      return [f.x * M, f.y * M];
    },
  );

  const cx = ((fp.minX + fp.maxX) / 2) * M;
  const cz = ((fp.minY + fp.maxY) / 2) * M;
  const radius = 0.5 * Math.hypot((fp.maxX - fp.minX) * M, (fp.maxY - fp.minY) * M) || 10;

  return {
    solids,
    seats: seatData,
    bounds: { center: [cx, radius * 0.08, cz], radius, groundY: 0 },
    stateColorLUT: themeSeatColorLUT(theme, SEAT_STATES),
    theme,
    seatCount: seats.length,
    // Look-at target ~1.5 m up so a seated camera aims slightly down at the stage.
    focalWorld: [focal.x * M, 1.5, focal.y * M],
    zones,
    stages: stageBounds,
    sections,
    rows,
    labels,
    floors,
  };
}
