/**
 * THE seating surface — one function per section, consumed by everything.
 *
 * Before this module the venue had three independently-computed surfaces (tier
 * cap, row treads, seat dots) held apart by hardcoded offsets that had to agree,
 * and never did across chart shapes. Two measured defects came out of that:
 *
 *  - The tier cap was a raw earcut triangulation of the section outline with a
 *    *radial, nonlinear* height evaluated only at outline vertices. A 90 m chord
 *    across a curved bowl is a flat plane through the seating: 23 % of arena
 *    seats and 48 % of amphitheatre seats rendered UNDER their own tier cap
 *    (worst overshoot 5.54 m).
 *  - The cap took each section's front-edge datum from its OUTLINE vertices and
 *    the doc focal, while `layout.ts`'s `assignEyeHeights` takes it from the
 *    section's SEATS and each seat's own `focalPoint`. Different datum ⇒ a
 *    per-section constant disagreement even where tessellation was exact.
 *
 * `deckAt(x, y)` here is the single definition of "the height of the walkable
 * seating surface". It mirrors `assignEyeHeights` exactly — same front-edge
 * datum, same drawn-radial-depth rise — so a seat dot and the deck it stands on
 * can no longer be computed from different models. The cap is tessellated
 * against this same function (see `extrudePrism`'s `maxCapError`), so the drawn
 * triangle mesh tracks it rather than chording across it.
 *
 * Pure: no OGL, no DOM. Unit-tested in workers/api/test/view3dSurface.test.ts.
 */

import type { ChartObject, ExpandedSeat, Point, SectionObject } from '../../core/types';
import { pointInPolygonWithHoles } from '../../core/layout';
import { buildSectionRake } from '../../core/rake';
import { resolveSection, distanceToPolyline, type ResolvedRow } from '../../core/venueStructure';
import { CHART_UNITS_PER_METRE, METRES_PER_CHART_UNIT, SEATED_EYE_HEIGHT_M, sectionGeometry } from '../../core/units';
import { outsetRing } from './geometry';
import { SEAT_DOT_RADIUS_M } from './seatInstances';

/** Top of the thin slab drawn for a section with no authored height/rake. Seats
 * on a flat chart rest on this, so it is part of the surface definition rather
 * than a constant duplicated by the seat builder. */
export const FLAT_SLAB_TOP_M = 0.05;

/**
 * Subdivision TARGET for the drawn tier cap, metres — how closely it tries to
 * track `deckAt`. Consumed by `sceneModel` when it extrudes a tier.
 *
 * A target, not a guarantee: refinement is uniform per section (the only way to
 * stay watertight — see `emitCapUniform`) and bounded by a triangle budget, so a
 * section whose surface folds sharply stops refining before it reaches this.
 * {@link SEAT_CLEARANCE_M} is what actually protects the seats.
 */
export const CAP_MAX_ERROR_M = 0.05;

/**
 * Clearance between a seat dot's origin and the deck it stands on, metres.
 *
 * The cap's error is ONE-SIDED and that is what makes a single clearance work.
 * `deckAt` is a cone — front-edge height plus a linear function of radial
 * distance — which is convex, so a triangle interpolating it lies at or above it
 * everywhere inside the triangle, never below. The cap can therefore only ever
 * float above the true surface, and only a seat needs protecting from it.
 *
 * The size, however, is MEASURED rather than proven. Refinement aims at
 * {@link CAP_MAX_ERROR_M} but is uniform per section and capped by a triangle
 * budget, and the residual peaks at the surface's fold, where a section's flat
 * front plateau turns into its rake. Measured worst cap error across all four
 * harness charts is 13 cm. 15 cm carries that while staying under the ~22 cm
 * seat-dot radius, so it is invisible. THIS is the number that must exceed the
 * cap's real error — the test suite asserts exactly that relationship.
 *
 * The test suite enforces the real invariant directly — zero buried seats on
 * every harness chart — so a regression in either number fails loudly rather
 * than silently eating the margin. If a chart ever needs a tighter cap, the fix
 * is fold-aware refinement (splitting triangles that straddle `frontU`), not a
 * bigger clearance.
 */
export const SEAT_CLEARANCE_M = 0.15;

/**
 * How far outside its authored outline a section still owns seats, chart units.
 *
 * Matches the deck padding in `buildTier` exactly (1.5 seat-dot radii), because
 * it answers the same question: the deck is drawn at that padded ring, so a seat
 * standing on drawn deck must belong to the section that drew it. Any smaller and
 * boundary seats are orphaned onto the floor beneath their own tier.
 */
export const SEAT_OWNERSHIP_PAD_U = SEAT_DOT_RADIUS_M * 1.5 * CHART_UNITS_PER_METRE;

/** One section's resolved seating surface. */
export interface SectionSurface {
  readonly sectionId: string;
  /** World-metre height of the seating deck at a chart-unit point. */
  deckAt(x: number, y: number): number;
  /**
   * ANALYTIC unit normal of the deck at a chart-unit point, world axes (y up).
   *
   * The drawn cap is a piecewise-linear approximation of `deckAt`, so its FACE
   * normals are discontinuous across every shared edge — measured at 46 % of cap
   * edges breaking >2°, worst 110°, which flat-shades into the dark streaks
   * across a raked deck. Worse, the near-degenerate triangles earcut emits at a
   * densified boundary (aspect ratios to 8.7e6) have numerically meaningless
   * face normals, so they shade as random dark needles.
   *
   * `deckAt` is a cone and therefore differentiable everywhere except its fold,
   * so the true normal is available in closed form and costs nothing. Shading the
   * cap with it instead of the face normal makes the surface read as smooth
   * regardless of tessellation AND makes a sliver's shading harmless — it now
   * matches its neighbours even when its own geometry is degenerate.
   */
  normalAt(x: number, y: number): [number, number, number];
  /** True when the section carries no rake — the deck is a constant plane. */
  readonly flat: boolean;
  /** Bottom of the section prism (floor base), world metres. */
  readonly bottomY: number;
  /**
   * The section's rows with the world-metre LEVEL each one sits at, front first.
   *
   * This is what the deck is actually built from. A row is a level ribbon and
   * consecutive ribbons are joined by a riser, so the drawn surface passes
   * exactly through every row instead of approximating a field between them —
   * and because a ribbon is horizontal, its cap error against the seats it
   * carries is zero by construction rather than by measurement.
   *
   * Empty for a flat section, and for a section with fewer than two rows (which
   * keeps the old smooth-cone path, since there is no row structure to build on).
   */
  readonly rowLevels: readonly { readonly pts: readonly Point[]; readonly y: number; readonly depth: number; readonly blockId: number }[];
  /** The landing height for the parts of the outline that hold no rows. */
  readonly landingY: number;
}

export interface VenueSurfaces {
  /** Surface by section object id (NOT logical id — heights are per object). */
  bySection: Map<string, SectionSurface>;
  /** Owning section object id per seat index, or null when a seat sits outside
   * every section (free-standing rows). Parallel to the input seat array. */
  seatOwner: Array<string | null>;
  /** Deck height in world metres for seat index i (falls back to the seat's own
   * resolved eye height when it owns no section). */
  seatDeckY(i: number): number;
  /**
   * Seat pitch in CHART UNITS for seat index i, or undefined when its section
   * has no resolved rows.
   *
   * The spacing a seat actually has to itself — the smaller of its own row's
   * seat spacing and the gap to the neighbouring row. Callers size a seat's
   * marker from this.
   *
   * It is emphatically NOT the distance to the nearest other seat. That measure
   * shrank 80 amphitheatre dots to as little as 0.089 m, every one of them at a
   * WEDGE BOUNDARY: the last seat of one wedge sits 0.212 m from the first seat
   * of the next across an aisle, far closer than the 0.55 m spacing inside either
   * row. Two seats being near each other across an aisle says nothing about how
   * much room either one has.
   */
  seatPitchU(i: number): number | undefined;
}

interface Bbox { minX: number; minY: number; maxX: number; maxY: number }

function bboxOf(pts: Point[]): Bbox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Hard ceiling on rake rise so a mis-authored or focal-wrapping section can
 * never produce a runaway spike (defect guard, carried over from buildTier). */
const MAX_TIER_RISE_M = 25;

export interface SurfaceUnit {
  objects: ChartObject[];
  focal: Point;
  baseHeightM: number;
}

/**
 * Resolve every section's seating surface and each seat's owning section.
 *
 * The front-edge datum is taken from the section's member SEATS when it has any
 * (matching `assignEyeHeights`), and only falls back to the outline's nearest
 * vertex for a section with no seats — where nothing can disagree with it.
 */
export function buildVenueSurfaces(units: SurfaceUnit[], seats: ExpandedSeat[]): VenueSurfaces {
  const bySection = new Map<string, SectionSurface>();
  const seatOwner = new Array<string | null>(seats.length).fill(null);
  const seatDeck = new Float64Array(seats.length);
  /** Level of the seat's own row, when its section resolved into rows. */
  const seatRowLevel = new Array<number | undefined>(seats.length).fill(undefined);
  /** Pitch of the seat's own row (chart units), when resolved. */
  const seatPitch = new Array<number | undefined>(seats.length).fill(undefined);

  // --- Pass 1: ownership + per-section seat front distance -------------------
  interface Acc {
    section: SectionObject;
    unit: SurfaceUnit;
    /** Nearest drawn focal distance among member seats (chart units). */
    frontU: number;
    hasSeats: boolean;
    /** Member seat positions grouped by row — the input the rake axis is fitted from. */
    rows: Map<string, Point[]>;
    /** Indices of this section's member seats, for the structure resolver. */
    seatIndices: number[];
  }
  const acc = new Map<string, Acc>();
  const boxes: Array<{ id: string; box: Bbox; section: SectionObject; unit: SurfaceUnit; outline: Point[] }> = [];
  for (const unit of units) {
    for (const o of unit.objects) {
      if (o.type !== 'section' || !o.outline || o.outline.length < 3) continue;
      // Ownership is tested against the PADDED outline — the same ring the deck
      // is actually drawn with (see `buildTier`'s `outsetRing`). Testing the raw
      // outline instead left seats authored just outside it unowned, so they fell
      // to the floor while the drawn deck covered them: measured as 9 buried
      // cinema seats and a 0.20 m drop on the uber arena. A seat resting on drawn
      // deck belongs to the section that drew it.
      const owned = outsetRing(o.outline, SEAT_OWNERSHIP_PAD_U);
      acc.set(o.id, { section: o, unit, frontU: Infinity, hasSeats: false, rows: new Map(), seatIndices: [] });
      boxes.push({ id: o.id, box: bboxOf(owned), section: o, unit, outline: owned });
    }
  }

  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    for (const b of boxes) {
      // Bbox prefilter keeps the 14k-seat charts cheap; the polygon test only
      // runs for genuine candidates.
      if (s.x < b.box.minX || s.x > b.box.maxX || s.y < b.box.minY || s.y > b.box.maxY) continue;
      if (!pointInPolygonWithHoles({ x: s.x, y: s.y }, b.outline, b.section.holes)) continue;
      seatOwner[i] = b.id;
      const a = acc.get(b.id)!;
      a.hasSeats = true;
      const f = s.focalPoint ?? b.unit.focal;
      const d = Math.hypot(s.x - f.x, s.y - f.y);
      if (d < a.frontU) a.frontU = d;
      // Group by row, exactly as assignEyeHeights does — the rake axis is fitted
      // from the same grouping in both files, or the two models diverge again.
      a.seatIndices.push(i);
      const rowKey = s.rowId || `__seat-${i}`;
      const arr = a.rows.get(rowKey);
      if (arr) arr.push({ x: s.x, y: s.y }); else a.rows.set(rowKey, [{ x: s.x, y: s.y }]);
      break; // first containing section wins, exactly as assignEyeHeights does
    }
  }

  // --- Pass 2: build one surface function per section ------------------------
  for (const [id, a] of acc) {
    const geo = sectionGeometry(a.section, { floorBaseHeightM: a.unit.baseHeightM });
    const bottomY = a.unit.baseHeightM;
    const rakeTan = geo.rake > 0 ? Math.tan((geo.rake * Math.PI) / 180) : 0;
    // An authored override wins over inference (see `SectionObject.surfaceKind`).
    // `rakedRows` cannot manufacture relief a section does not carry, so it only
    // prevents a raked section from being flattened, never the reverse.
    const inferredFlat = geo.rake <= 0.01 && geo.height <= bottomY + 0.001;
    const kind = a.section.surfaceKind;
    const flat = kind === 'flat' ? true : kind === 'rakedRows' ? geo.rake > 0.01 ? false : inferredFlat : inferredFlat;

    // The section's own rake axis, fitted from its rows. `layout.ts` fits the
    // identical axis from the identical grouping; DEPTH, the front datum and the
    // rise all then come from one field, which is what keeps a seat dot and the
    // deck it stands on from being computed under different models.
    const rake = buildSectionRake([...a.rows.values()].map((points) => ({ points })), a.unit.focal);

    let frontU = Infinity;
    if (a.hasSeats) {
      for (const pts of a.rows.values()) {
        for (const p of pts) {
          const d = rake.depthAt(p.x, p.y);
          if (d < frontU) frontU = d;
        }
      }
    }
    if (!a.hasSeats || !Number.isFinite(frontU)) {
      frontU = Infinity;
      for (const p of a.section.outline) {
        const d = rake.depthAt(p.x, p.y);
        if (d < frontU) frontU = d;
      }
    }
    const flatTop = bottomY + FLAT_SLAB_TOP_M;
    const baseFloor = bottomY + FLAT_SLAB_TOP_M;

    /** Height for a depth ordinate measured from the venue focal (fallback path). */
    const levelFor = (depthU: number): number => {
      const depthM = Math.max(0, depthU - frontU) * METRES_PER_CHART_UNIT;
      const rise = Math.min(depthM * rakeTan, MAX_TIER_RISE_M);
      return Math.max(baseFloor, geo.height + rise);
    };

    /** Height for a depth measured back from a BLOCK's own front row. */
    const levelForBlockDepth = (blockDepthU: number): number => {
      const depthM = Math.max(0, blockDepthU) * METRES_PER_CHART_UNIT;
      const rise = Math.min(depthM * rakeTan, MAX_TIER_RISE_M);
      return Math.max(baseFloor, geo.height + rise);
    };

    // One level per row, from the resolved structure. THIS is the deck.
    //
    // Depth is measured inside the row's own BLOCK, so every block of a tier
    // starts at the tier's authored height. Measuring it from the venue focal
    // (which is what `rake.depthAt` does, and what this used to do) raised a
    // bowl's side wedges as though they were further back: sec-gall's six blocks
    // are one tier authored at 6.20 m and started at 6.35 to 10.65 m.
    const structure = a.hasSeats
      ? resolveSection(id, seats, a.seatIndices, a.unit.focal)
      : { sectionId: id, rows: [] as ResolvedRow[], blockCount: 0 };
    const rowLevels = flat
      ? []
      : structure.rows.map((r) => ({
        pts: r.pts,
        y: levelForBlockDepth(r.blockDepth),
        depth: r.blockDepth,
        blockId: r.blockId,
      }));
    const landingY = rowLevels.length ? rowLevels[0].y : flatTop;

    // Bounding circles over the rows, so the nearest-row lookup below prunes
    // instead of walking every polyline in the section. A 50k venue has sections
    // with thousands of rows and this is called per cap sample.
    const rowBounds = rowLevels.map((r) => {
      let cx = 0, cy = 0;
      for (const p of r.pts) { cx += p.x; cy += p.y; }
      const n = r.pts.length || 1;
      cx /= n; cy /= n;
      let rad = 0;
      for (const p of r.pts) {
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d > rad) rad = d;
      }
      return { cx, cy, rad };
    });

    const deckAt = flat
      ? (): number => flatTop
      : rowLevels.length >= 2
        ? (x: number, y: number): number => {
          // The deck is the level of the row you are standing on. A step
          // function, deliberately: it is the drawn geometry, not an
          // approximation of it, so a seat and its ribbon cannot disagree.
          let best = Infinity, bestY = landingY;
          for (let i = 0; i < rowLevels.length; i++) {
            const b = rowBounds[i];
            // Admissible lower bound — cannot discard a row that would have won.
            if (Math.hypot(x - b.cx, y - b.cy) - b.rad >= best) continue;
            const d = distanceToPolyline(rowLevels[i].pts, x, y);
            if (d < best) { best = d; bestY = rowLevels[i].y; }
          }
          return bestY;
        }
        : (x: number, y: number): number => levelFor(rake.depthAt(x, y));

    // The gradient of the same expression. Height rises with radial distance
    // only, so the surface tilts purely along the outward radial direction and
    // the slope is exactly `rakeTan` — except on the flat front plateau
    // (d <= frontU), past the runaway clamp, and where the baseFloor floor wins,
    // all of which are locally horizontal.
    const UP: [number, number, number] = [0, 1, 0];
    // Every ribbon and every landing is HORIZONTAL, so the deck's normal is up
    // everywhere and the analytic-normal machinery has nothing left to correct.
    // The only non-horizontal deck surfaces are the risers, and those carry their
    // own normals from the band builder.
    const normalAt = rowLevels.length >= 2 || flat
      ? (): [number, number, number] => UP
      : (x: number, y: number): [number, number, number] => {
        const d = rake.depthAt(x, y);
        if (d <= frontU) return UP;
        const depthM = (d - frontU) * METRES_PER_CHART_UNIT;
        if (depthM * rakeTan >= MAX_TIER_RISE_M) return UP;       // clamped: flat again
        if (geo.height + depthM * rakeTan <= baseFloor) return UP; // floored: flat
        const [gx, gy] = rake.gradientAt(x, y);
        if (gx === 0 && gy === 0) return UP;
        const inv = 1 / Math.hypot(rakeTan, 1);
        return [-gx * rakeTan * inv, inv, -gy * rakeTan * inv];
      };

    // A seat takes its own row's level DIRECTLY. Searching for the nearest row
    // would give the same answer almost always and the wrong one occasionally
    // (where two blocks interleave), and it would cost a polyline search per seat
    // on a chart that may hold 50,000 of them. Row membership is already known.
    if (!flat) {
      for (const r of structure.rows) {
        const y = levelForBlockDepth(r.blockDepth);
        for (const si of r.seatIndices) seatRowLevel[si] = y;
      }
    }

    // Per-row pitch: the median spacing ALONG the row (immune to the aisle, which
    // falls between rows, not inside one) capped by the gap to the nearest other
    // row, so a dot cannot grow into the row in front either.
    for (const r of structure.rows) {
      const gaps: number[] = [];
      for (let k = 1; k < r.pts.length; k++) {
        const d = Math.hypot(r.pts[k].x - r.pts[k - 1].x, r.pts[k].y - r.pts[k - 1].y);
        if (d > 1e-6) gaps.push(d);
      }
      gaps.sort((x, y) => x - y);
      const along = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;

      // Measured against rows in the SAME BLOCK only. A row in a neighbouring
      // block runs BESIDE this one, not in front of it, and near a block boundary
      // it can pass within a hair of the probe: measured across the catalog that
      // collapsed the pitch to 0.04 mm on the opera house and 0.8 mm on the
      // esports arena, which then drove every dot there to the visibility floor.
      // This is the same mistake as sizing a seat against a neighbour across an
      // aisle, one level up.
      let across = Infinity;
      const probe = r.pts[Math.floor(r.pts.length / 2)];
      if (probe) {
        for (const other of structure.rows) {
          if (other === r || other.blockId !== r.blockId) continue;
          const d = distanceToPolyline(other.pts, probe.x, probe.y);
          if (d > 1e-6 && d < across) across = d;
        }
      }
      // Never below half the in-row spacing. Two rows can genuinely be authored
      // on top of each other (chairs around a table cross their neighbours'
      // arcs), and a seat's own row spacing is still real when that happens.
      const pitch = Math.min(along, Math.max(across, along * 0.5));
      if (Number.isFinite(pitch) && pitch > 0) {
        for (const si of r.seatIndices) seatPitch[si] = pitch;
      }
    }

    bySection.set(id, { sectionId: id, deckAt, normalAt, flat, bottomY, rowLevels, landingY });
  }

  // --- Pass 3: bake each seat's deck height from its owner's surface ---------
  for (let i = 0; i < seats.length; i++) {
    const ownerId = seatOwner[i];
    const s = seats[i];
    if (ownerId) {
      const own = seatRowLevel[i];
      seatDeck[i] = (own ?? bySection.get(ownerId)!.deckAt(s.x, s.y)) + SEAT_CLEARANCE_M;
      continue;
    }
    // Seat outside every section: fall back to its own resolved eye height, the
    // only surface information it carries.
    const eye = s.eyeHeightM;
    seatDeck[i] = Number.isFinite(eye) ? Math.max(0, (eye as number) - SEATED_EYE_HEIGHT_M) : 0;
  }

  return {
    bySection,
    seatOwner,
    seatDeckY: (i: number): number => seatDeck[i],
    seatPitchU: (i: number): number | undefined => seatPitch[i],
  };
}
