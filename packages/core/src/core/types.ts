/**
 * SeatMap chart document — the single source of truth shared by the
 * Designer (authoring) and the Renderer (buyer picker).
 *
 * Coordinates are abstract units (roughly "pixels at scale 1"); the renderer
 * fits the chart to its container.
 * Rows are PARAMETRIC (origin + count + spacing + curve + rotation) — never
 * store per-seat coordinates in the document; expansion happens in layout.ts.
 */

export interface Point {
  x: number;
  y: number;
}

export interface CubicPath {
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
}

/** A real closed section boundary. `outline` remains its sampled collision and
 * persistence fallback; this path is the smooth authoring/buyer paint source. */
export type SectionPathSegment =
  | { kind: 'line'; end: Point }
  | { kind: 'arc'; center: Point; radius: number; clockwise: boolean; end: Point }
  | { kind: 'bezier'; control1: Point; control2: Point; end: Point };

export interface SectionOutlinePath {
  version: 1;
  closed: true;
  start: Point;
  segments: SectionPathSegment[];
}

export interface Category {
  key: string;
  label: string;
  color: string;
  /** Base price — used when the category has no explicit tiers. */
  price?: number;
  /** Durable evidence for semantic/display facts proposed while converting a
   * private reference into sellable inventory. */
  referenceCategorySource?: ReferenceCategorySource;
  /**
   * Ticket tiers (Adult / Child / Senior…). When present, a buyer picks a tier
   * per seat in this category and the tier's price applies; the first tier is the
   * default. Per-category (not per-seat) pricing — see Batch 3.5. Empty/absent =
   * a single price (the `price` above).
   */
  tiers?: CategoryTier[];
}

export interface ReferenceCategorySource {
  assetId: string;
  /** Original sampled section color. `Category.color` is the approved output
   * color and may differ only with separately recorded evidence. */
  sourceColor: string;
  /** Every exact sampled color normalized into the same original 4-bit/channel
   * segmentation class. Older documents may contain only `sourceColor`. */
  sourceColors?: string[];
  /** Logical sections whose generated inventory uses this category. */
  logicalSectionIds?: string[];
  /** Source-color grouping is deterministic; a semantic regrouping needs its
   * own confirmed assignment evidence. */
  assignmentDerivation?: 'source-color-class' | 'confirmed-logical-sections';
  assignmentEvidence?: 'user-confirmed' | 'authoritative-source';
  assignmentSourceDescription?: string;
  /** Optional legend/commercial swatch stated by the source. This remains
   * immutable provenance when the approved accessible output color differs. */
  sourcePaletteColor?: string;
  sourcePaletteColorEvidence?: 'user-confirmed' | 'authoritative-source';
  sourcePaletteColorSourceDescription?: string;
  labelEvidence: 'user-confirmed' | 'authoritative-source';
  labelSourceDescription: string;
  priceEvidence: 'user-confirmed' | 'authoritative-source';
  priceSourceDescription: string;
  outputColorEvidence?: 'user-confirmed' | 'authoritative-source';
  outputColorSourceDescription?: string;
}

/** One ticket tier within a category: a named price (Adult, Child, Senior…). */
export interface CategoryTier {
  id: string;
  name: string;
  price: number;
}

/**
 * Accessibility accommodations a seat can carry. Mirrors the taxonomy real
 * venues (and seats.io) expose so buyers can filter for exactly what they need
 * and organizers can mark seats precisely. `wheelchair` is the legacy default.
 */
export type AccessibilityType =
  | 'wheelchair'
  | 'companion'
  | 'semi-ambulatory'
  | 'hearing'
  | 'cart'
  | 'sign-language'
  | 'plus-size'
  | 'lift-armrest';

export interface AccessibilityMeta {
  key: AccessibilityType;
  /** Full descriptive label (designer checkbox, picker legend). */
  label: string;
  /** Compact label for chips/badges. */
  short: string;
  /** Single-glyph badge shown on seat chips + filter chips. */
  icon: string;
}

/** Ordered taxonomy — drives the designer seat panel and the picker filters. */
export const ACCESSIBILITY_TYPES: AccessibilityMeta[] = [
  { key: 'wheelchair', label: 'Wheelchair space', short: 'Wheelchair', icon: '♿' },
  { key: 'companion', label: 'Companion seat', short: 'Companion', icon: '🧑‍🤝‍🧑' },
  { key: 'semi-ambulatory', label: 'Semi-ambulatory (limited mobility)', short: 'Limited mobility', icon: '🦯' },
  { key: 'hearing', label: 'Assistive listening', short: 'Hearing', icon: '🦻' },
  { key: 'cart', label: 'CART live-caption view', short: 'CART captions', icon: 'CC' },
  { key: 'sign-language', label: 'Sign-language view', short: 'Sign language', icon: '🤟' },
  { key: 'plus-size', label: 'Plus-size seat', short: 'Plus-size', icon: '💺' },
  { key: 'lift-armrest', label: 'Lift-up armrest', short: 'Lift armrest', icon: '↕️' },
];

const ACCESSIBILITY_LABEL = new Map(ACCESSIBILITY_TYPES.map((a) => [a.key, a]));

/** Metadata for one accessibility key (undefined for unknown keys). */
export function accessibilityMeta(key: AccessibilityType): AccessibilityMeta | undefined {
  return ACCESSIBILITY_LABEL.get(key);
}

/**
 * Outer-ring colour per accommodation. Shared by the buyer picker and the
 * designer canvas so an accessible seat reads with the same hue in both — the
 * seat's first-listed type wins. `wheelchair` blue is the default fallback.
 */
export const ACCESSIBILITY_RING_COLOR: Record<AccessibilityType, string> = {
  wheelchair: '#3b82f6',
  companion: '#8b5cf6',
  'semi-ambulatory': '#0ea5e9',
  hearing: '#14b8a6',
  cart: '#7c3aed',
  'sign-language': '#f59e0b',
  'plus-size': '#ec4899',
  'lift-armrest': '#22c55e',
};

/** Ring colour for a seat's accessibility set (first-listed type wins). */
export function accessibilityRingColor(types: AccessibilityType[] | undefined): string {
  const primary = types?.[0];
  return (primary && ACCESSIBILITY_RING_COLOR[primary]) || '#3b82f6';
}

export interface SeatOverride {
  /** 0-based seat index within the row. */
  index: number;
  /** Physical seat absent (pillar, sound desk) — numbering gap preserved. */
  skip?: boolean;
  /** Position nudge in chart units. */
  dx?: number;
  dy?: number;
  /** Replace the computed label entirely. */
  label?: string;
  /** Buyer-facing copy only. Booking/API identity remains row id + slot index
   * internally and the legacy `label` externally for backwards compatibility. */
  displayLabel?: string;
  categoryKey?: string;
  /** @deprecated legacy flag — read as `['wheelchair']`; write `accessibility`. */
  accessible?: boolean;
  /** Accessibility accommodations of this seat (empty/absent = none). */
  accessibility?: AccessibilityType[];
  /**
   * Physical wheelchair provision. Absent keeps legacy seat rendering;
   * `seat-present` is an explicit removable/fixed accessible chair, while
   * `no-seat` is an empty wheelchair bay that remains one sellable inventory
   * unit. This is deliberately distinct from `skip`, which removes inventory.
   */
  wheelchairSpaceType?: 'seat-present' | 'no-seat';
  /** Commercial selling/view attributes are deliberately not accessibility. */
  commercial?: SeatCommercialAttributes;
  /** Seat-specific view photo; falls back to the row photo. */
  viewFromSeatUrl?: string;
  /** Per-seat label size/color override; falls back to the row/theme default.
   *  Size is clamped to LABEL_STYLE_MIN_SIZE..MAX_SIZE; color is passed through
   *  the shared auto-contrast rule at paint time (see {@link LabelStyle}). */
  labelStyle?: LabelStyle;
}

export interface SeatCommercialAttributes {
  restrictedView?: boolean;
  obstructedView?: boolean;
  premium?: boolean;
  note?: string;
}

/**
 * Per-object label ink + size overrides layered on top of the chart-wide Theme
 * defaults (rowLabelColor / textColor for rows, the section-name ink for
 * sections). Both fields are optional: an absent field means "inherit the theme
 * default". `color` is a preferred hex — renderers still pass it through the
 * shared auto-contrast rule (`stateAwareBookableLabelInk`), so a choice that
 * would be illegible over the seat/section background is switched to black or
 * white at paint time. `size` is a font size in chart units, clamped to
 * LABEL_STYLE_MIN_SIZE..LABEL_STYLE_MAX_SIZE by the shared ops.
 */
export interface LabelStyle {
  size?: number;
  color?: string;
}

/** Clamp bounds for a per-object label `size`, shared by ops, MCP, and UI. */
export const LABEL_STYLE_MIN_SIZE = 8;
export const LABEL_STYLE_MAX_SIZE = 24;

export interface LabelPresentation {
  visible?: boolean;
  /** Exact Designer-owned label anchor; public semantic MCP schemas omit it. */
  position?: Point;
  rotation?: number;
  style?: 'plain' | 'pill';
  /** Per-object size/color override for this row's or section's label. */
  labelStyle?: LabelStyle;
  /**
   * End-position preset for a ROW label — which end(s) of the row show it:
   *  - `start` (default/undefined) — the row's numbering-start end (legacy behaviour).
   *  - `end`   — the far end of the row.
   *  - `both`  — a label at BOTH ends.
   *  - `none`  — hidden (kept coherent with `visible: false`).
   * A free-drag `position` overrides the preset (the designer shows a 'custom'
   * state). Ignored for sections (they use `position`/`visible` only).
   */
  positionPreset?: 'start' | 'end' | 'both' | 'none';
}

/** Brand/venue theming — applied by the renderer in both designer and picker. */
export interface ChartTheme {
  /** Canvas background color (default dark: #0e1117-ish radial). */
  background?: string;
  /** Preferred text color for the numbers inside seat markers. */
  seatLabelColor?: string;
  /** Preferred color for row identifiers such as A, B, C. Falls back to textColor. */
  rowLabelColor?: string;
  /** Selection ring / accent color (default white ring + brand accent). */
  selectionColor?: string;
  /** Décor (stage/shape) default fill. */
  decorFill?: string;
  /** Free-text color default. */
  textColor?: string;
  /** Font family (CSS stack) for all rendered text — row labels, seat numbers, sections, décor text. */
  fontFamily?: string;
  /** Seat size multiplier on the base radius (0.7–1.6, default 1) — bigger seats fit longer labels. */
  seatScale?: number;
  // ---- White-label branding (applied by the buyer picker chrome) ----
  /** Brand accent color — recolors buttons, links, the hold pill, selection UI. */
  accent?: string;
  /** Ink color for text on the accent (e.g. button labels). Default light. */
  accentInk?: string;
  /** Organizer logo shown in the picker header (data/R2 URL). Falls back to the name. */
  logoUrl?: string;
  /** Brand/venue name shown in the picker header when no event name is set. */
  brandName?: string;
  /** Paid-tier flag: hide the "Powered by SeatMap" badge. */
  hideBadge?: boolean;
}

export interface RowObject {
  type: 'row';
  id: string;
  /** Present when this row was materialized by the in-canvas reference scan.
   *  A re-scan of the same asset replaces rows carrying this marker and NEVER
   *  touches hand-authored rows — the same replace-generated-only invariant as
   *  applyReferenceInventory. */
  referenceScan?: { assetId: string };
  /** Row label, e.g. "A". Seat labels are `${label}-${n}`. */
  label: string;
  /** Buyer-facing row name. `label` remains the legacy inventory prefix. */
  displayLabel?: string;
  /**
   * Buyer-facing type word override (seats.io "Displayed type"). Replaces the
   * hardcoded "Row" in the picker tooltip/confirm/cart, e.g. "Table", "Bench",
   * "Aisle". ≤24 chars; absent = the default "Row". Pure presentation.
   */
  displayType?: string;
  labelPresentation?: LabelPresentation;
  /** Position of the FIRST seat. */
  origin: Point;
  /** Degrees, clockwise. 0 = seats laid out along +x. */
  rotation: number;
  /**
   * Total arc sweep in degrees across the whole row. 0 = straight.
   * Positive bends away from +y (concave toward the focal point when the
   * row faces it). Typical theatre rows: 10–40.
   */
  curve: number;
  seatCount: number;
  /** Distance between adjacent seat centers, in chart units. */
  seatSpacing: number;
  /** Optional exact cubic centreline. Normal code owns these coordinates and
   * distributes seats by arc length; MCP/model inputs never submit them. */
  path?: CubicPath;
  categoryKey: string;
  /** Deterministic provenance for rows fitted from confirmed reference
   * inventory. It enables revision-safe replacement without touching manually
   * authored rows or accepting client coordinates. */
  referenceInventorySource?: ReferenceInventorySource;
  /** Semantic parameters for a row produced by the shared Arc/Fan operation.
   * Designer can reopen these parameters while every segment in the group
   * still carries the same generation signature. Public MCP tools never accept
   * the stored center/angles as arbitrary model-authored coordinates. */
  arcFanGeneration?: {
    kind: 'arc-fan-v1';
    groupId: string;
    center: Point;
    innerRadius: number;
    rowCount: number;
    rowGap: number;
    startAngle: number;
    endAngle: number;
    seatPitch: number;
    fit: 'seat-pitch' | 'fixed-count';
    seatsPerRow?: number;
    facing: 'inward' | 'outward';
    taperDegrees: number;
    skewDegrees: number;
    aisleGaps: { left: number; center: number; right: number };
    rowLabelStart: number;
    seatLabelStart: number;
    rowIndex: number;
    segmentIndex: number;
  };
  /**
   * Membership in one buyer-facing segmented row. Physical component rows and
   * their `${rowId}:${slotIndex}` inventory ids remain authoritative; this
   * metadata only supplies logical ordering/presentation and explicit aisle
   * continuity. The descriptor is repeated on every component so selecting any
   * one can resolve the complete logical row without a chart-level side table.
   */
  segmentedRow?: {
    kind: 'segmented-row-v1';
    groupId: string;
    componentIndex: number;
    componentCount: number;
    /** The first component must use `start`; later boundaries are explicit. */
    boundaryBefore: 'start' | 'continuous' | 'break';
    /** Buyer-facing row name; technical component `label` values never change. */
    displayLabel: string;
    displayType?: string;
    labelPresentation?: LabelPresentation;
    viewFromSeatUrl?: string;
    /** Presentation intent for a continuous node-defined centreline. */
    smoothing?: boolean;
  };
  /**
   * Versioned provenance for rows created by the multiple/intertwined block
   * generator. Manual geometry edits remove this marker rather than allowing a
   * later regeneration to overwrite hand-authored work.
   */
  rowBlockGeneration?: {
    kind: 'row-block-v1';
    groupId: string;
    style: 'multiple' | 'intertwined';
    rowIndex: number;
    rowCount: number;
    seatsPerRow: number;
    origin: Point;
    rotation: number;
    rowGap: number;
    seatSpacing: number;
    curve: number;
    /** Stable canonical generator signature shared by every intact member. */
    signature: string;
  };
  /** First seat number (default 1). Roman/letters read it as a 1-based ordinal
   *  (start 1 → I / A). */
  seatLabelStart?: number;
  /** Seat numbering within the row (default decimal, ltr, step 1). */
  seatNumbering?: {
    /** ltr / rtl number from an end; `center` numbers outward from the middle
     *  (centre seat lowest — the premium-centre theatre convention). */
    direction: 'ltr' | 'rtl' | 'center';
    /** 2 = odd/even numbering (1,3,5… — start at 2 for evens). */
    step?: 1 | 2;
    /**
     * Label scheme for the seat NUMBER part (the row prefix is separate).
     * Default `decimal`. Composition with `direction`/`step`/`seatLabelStart`:
     *  - `decimal`      1,2,3         — honours direction + step + start.
     *  - `odd`          1,3,5         — odd numbers from the first odd ≥ start.
     *  - `even`         2,4,6         — even numbers from the first even ≥ start.
     *  - `updown`       1,3,5,…,6,4,2 — odd-up-even-back; REPLACES direction (uses
     *                                   physical left→right order); start shifts.
     *  - `updown-descending` …5,3,1,2,4,6 — odd-back-even-up; the distinct
     *                                   reverse up/down sequence. Also replaces
     *                                   direction and uses physical order.
     *  - `roman`        I,II,III      — honours direction + step + start (uppercase).
     *  - `letters-upper` A,B,C…Z,AA   — honours direction + step + start.
     *  - `letters-lower` a,b,c…z,aa   — honours direction + step + start.
     * Like `step`/`direction` today, the scheme changes the seat's inventory
     * label (its booking identity), by design.
     */
    scheme?: 'decimal' | 'odd' | 'even' | 'updown' | 'updown-descending' | 'roman' | 'letters-upper' | 'letters-lower';
    /** Optional prefix prepended to every seat number, e.g. 'R' → 'R1', 'R2'. */
    prefix?: string;
    /**
     * End-at preset ("useEndAt"): the row's numbering ENDS at this value instead
     * of starting at `seatLabelStart`. The start is derived so the last-numbered
     * seat (highest position rank) lands on `endAt`, respecting the scheme's step
     * (odd/even = 2). When set it WINS over the stored `seatLabelStart` (which is
     * left untouched). For letters it is a 1-based number index (26 → last seat
     * 'Z'); `updown` owns its own sequence and ignores `endAt`.
     */
    endAt?: number;
  };
  /**
   * Per-seat exceptions, keyed by seat index (0-based position in the row).
   * `skip` removes the physical seat but keeps the numbering gap (theatre
   * convention: a pillar eats A-3; A-4 stays A-4).
   */
  overrides?: SeatOverride[];
  /**
   * Organizer-supplied equirectangular 360 (or wide photo) shown as the
   * view-from-seat for every seat in this row. When absent, the picker
   * generates a synthetic panorama from chart geometry.
   */
  viewFromSeatUrl?: string;
  /** Default commercial attributes inherited by seats without an override. */
  commercial?: SeatCommercialAttributes;
}

export interface GAAreaObject {
  type: 'gaArea';
  id: string;
  /** Stable technical/inventory label. */
  label: string;
  /** Buyer-facing area name; technical `label` and GA unit ids stay stable. */
  displayLabel?: string;
  /** Buyer-facing type word override (seats.io "Displayed type"), ≤24 chars.
   * Absent = the default type word. Pure presentation. */
  displayType?: string;
  /** Closed polygon, in chart units. */
  points: Point[];
  /** Explicit aisles/pillars/cutouts excluded from the sellable GA surface. */
  holes?: Point[][];
  capacity: number;
  categoryKey: string;
  /** Corner-rounding radius in chart units (default 0 = sharp corners). Pure
   * presentation — softens the polygon's corners in every renderer without
   * touching capacity, unit identities, or the stored points. Clamped per
   * corner to half the shorter adjacent edge at draw time. */
  cornerRadius?: number;
  /**
   * Durable inventory provenance for a surface produced by Join Areas.
   *
   * A GA unit is identified by the id and zero-based range of the area that
   * originally authored it, not by the current polygon which happens to own
   * it.  Keeping those source ranges means a geometric join never renumbers an
   * already published/booked unit.  Ordinary (never-joined) areas omit this
   * field and implicitly own `[0, capacity)` under their own id.
   *
   * The ranges must be non-overlapping, contain positive whole counts, and sum
   * exactly to `capacity`; validation rejects malformed metadata.  Capacity
   * growth appends a new range under the surviving area id, while shrinking a
   * joined area is deliberately refused because it would silently destroy
   * stable inventory identities.
   */
  inventorySegments?: GAInventorySegment[];
  referenceInventorySource?: ReferenceInventorySource;
}

export interface GAInventorySegment {
  sourceAreaId: string;
  startIndex: number;
  count: number;
}

/**
 * Durable evidence link for sellable objects generated from a private reference.
 * The client supplies facts and stable logical-section ids, never coordinates.
 */
export interface ReferenceAccessibilitySource {
  placementDerivation: 'server-synthesized-row-edges';
  groupLogicalSectionIds: string[];
  assignmentEvidence: 'user-confirmed' | 'authoritative-source';
  assignmentSourceDescription: string;
  counts: Array<{
    type: AccessibilityType;
    count: number;
    evidence: 'user-confirmed' | 'authoritative-source';
    sourceDescription: string;
  }>;
}

export interface ReferenceInventorySource {
  assetId: string;
  logicalSectionId: string;
  evidence: 'user-confirmed' | 'authoritative-source';
  sourceDescription: string;
  /** Distinguishes directly supplied inventory from a user-approved server
   * distribution based only on an aggregate capacity. */
  derivation?: 'explicit-inventory' | 'server-synthesized-from-aggregate';
  /** Evidence for the aggregate figure; synthesized rows remain
   * `user-confirmed` and are never mislabeled as source-extracted. */
  aggregateEvidence?: 'user-confirmed' | 'authoritative-source';
  /** Separate evidence for assigning standing inventory to this logical
   * section. Aggregate evidence alone cannot prove section placement. */
  sectionAssignmentEvidence?: 'user-confirmed' | 'authoritative-source';
  sectionAssignmentSourceDescription?: string;
  /** Aggregate row synthesis may propose numbering, but persistence requires
   * the applying user/agent to confirm that policy explicitly. */
  numberingEvidence?: 'user-confirmed';
  numberingSourceDescription?: string;
  /** Evidence and deterministic placement contract for synthesized accessible
   * units in this logical section. */
  accessibility?: ReferenceAccessibilitySource;
}

/** Durable evidence that a visible source-backed section shell intentionally
 * carries no generated sellable inventory in this reference configuration. */
export interface ReferenceInventoryExclusionSource {
  assetId: string;
  logicalSectionId: string;
  reason: string;
  evidence: 'user-confirmed' | 'authoritative-source';
  sourceDescription: string;
}

/** Open-path stroke semantics. Optional ShapeObject fields retain the legacy
 * round/round/no-ending rendering when absent. */
export type ShapeLineCap = 'butt' | 'round' | 'square';
export type ShapeLineJoin = 'miter' | 'round' | 'bevel';
export type ShapeLineEnding = 'none' | 'arrow';

/** Non-bookable décor: stage, walls, exits. */
export interface ShapeObject {
  type: 'shape';
  id: string;
  /**
   * Closed area shapes (`rect`/`ellipse`/`polygon`) take a `fill`; open path
   * primitives (`line` = two points, `polyline` = n points) are stroke-only and
   * never filled. All kinds honour the optional `stroke`.
   */
  kind: 'rect' | 'ellipse' | 'polygon' | 'line' | 'polyline';
  label?: string;
  /** For rect/ellipse: bounding box. For a stage polygon: the base (pre-shape) box, so its kind can be regenerated. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** For polygon/line/polyline. */
  points?: Point[];
  fill?: string;
  /** Optional outline. `width` is in chart units; both fields are required together. */
  stroke?: { color: string; width: number };
  /** Open line/polyline only. Absent fields preserve round/round/no-ending legacy rendering. */
  lineCap?: ShapeLineCap;
  /** Controls corners between open-path segments. */
  lineJoin?: ShapeLineJoin;
  /** Independent open-path start/end decorations. Closed outlines never use these fields. */
  startEnding?: ShapeLineEnding;
  endEnding?: ShapeLineEnding;
  /** Rect only — corner rounding radius in chart units, clamped to half the short side at edit time. */
  cornerRadius?: number;
  /** Whole-shape opacity 0.1–1 (default 1). */
  opacity?: number;
  /** Degrees clockwise about the shape's center (default 0). Applied at render time. */
  rotation?: number;
  /**
   * Semantic tag driving special rendering. `'stage'` gets the gradient +
   * prominent uppercase label treatment; a décor landmark role (bar, exit…)
   * gets a quieter label. Loose string to avoid a circular import with
   * stage.ts / decor.ts (see StageKind / DecorRole there).
   */
  role?: string;
  /** For a stage: which `StageKind` its polygon was generated from. */
  stageKind?: string;
}

export type RectTableSide = 'top' | 'bottom' | 'left' | 'right';

/** Exact rectangular-table chair distribution. The four keys are deliberately
 * required: zero means that edge has no chair, while the sum is the authored
 * `seatCount`. Numeric chair identity remains `${table.id}:${index}` in the
 * canonical top, bottom, left, right expansion order. */
export interface RectTableSeatCounts {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Seats arranged around a table. Grouped selling is activated only by an
 * event's explicit inventory-model-2 snapshot; model-1 events continue to
 * treat every authored chair as an independent unit. */
export interface TableObject {
  type: 'table';
  id: string;
  /** e.g. "T1" — seat labels are `${label}-${n}`. */
  label: string;
  /** Buyer-facing table name; technical chair/group labels stay stable. */
  displayLabel?: string;
  /** Buyer-facing type word override (seats.io "Displayed type"), ≤24 chars.
   * Absent = the default "Row"/"Table" word. Pure presentation. */
  displayType?: string;
  center: Point;
  shape: 'round' | 'rect';
  /** Seats around the perimeter (round) or along the enabled edges (rect). */
  seatCount: number;
  /** Rect tables: which edges get seats (default ['top','bottom']). */
  sides?: RectTableSide[];
  /**
   * Rect tables only: exact chairs on every edge. Absent preserves the legacy
   * `seatCount` + `sides` round-robin distribution byte-for-byte. When present,
   * all four values are whole numbers >= 0 and their sum equals `seatCount`.
   */
  seatCountsBySide?: RectTableSeatCounts;
  /** Individual-chair semantic overrides. Grouped whole/variable tables cannot
   * author these because their only sellable identity is the table itself. */
  overrides?: SeatOverride[];
  rotation: number;
  /** Round tables. */
  radius?: number;
  /**
   * Round tables: the arc (in degrees) the seats occupy, default 360 (full
   * ring). Below 360 leaves an open side — e.g. a service gap for waiters, a
   * head table facing the room, or clearance against a wall. The opening is
   * centred on the `rotation` direction; seats spread across the rest.
   */
  seatArc?: number;
  /** Rect tables. */
  width?: number;
  height?: number;
  categoryKey: string;
  /** One buyer owns the complete table at exactly `seatCount` guests. */
  bookAsWhole?: boolean;
  /** One buyer owns the complete table and chooses a bounded guest quantity. */
  variableOccupancy?: boolean;
  /** Required inclusive guest bounds when `variableOccupancy` is true. */
  minOccupancy?: number;
  maxOccupancy?: number;
  referenceInventorySource?: ReferenceInventorySource;
}

/** A booth: one bookable unit rendered as a block (trade shows, VIP boxes). */
export interface BoothObject {
  type: 'booth';
  id: string;
  /** Stable technical/inventory label. */
  label: string;
  /** Buyer-facing booth name; technical `label` stays stable. */
  displayLabel?: string;
  /** Buyer-facing type word override (seats.io "Displayed type"), ≤24 chars.
   * Absent = the default type word. Pure presentation. */
  displayType?: string;
  center: Point;
  width: number;
  height: number;
  rotation: number;
  /**
   * Optional custom outline (closed polygon, absolute chart coordinates) for
   * non-rectangular booths — L-shaped, corner, or island units on expo floors.
   * Absent = the default axis-aligned rectangle described by `width`/`height`/
   * `rotation`. A booth stays exactly ONE atomic sellable unit whatever its
   * outline; `points` is purely geometric. `width`/`height` are retained as the
   * last rectangular size so "Back to rectangle" can restore it. When `points`
   * is present, renderers draw the polygon and ignore `rotation`.
   */
  points?: Point[];
  categoryKey: string;
  referenceInventorySource?: ReferenceInventorySource;
}

/**
 * A named region of the venue (Balcony Left, Floor B…). Sections are outlines
 * only — objects belong to a section spatially (center inside the outline),
 * keeping the document flat (no nesting; simpler for tools and for AI edits).
 * Renderer: far zoom shows section shapes/labels instead of seats; clicking
 * a section zooms into it.
 */
export interface SectionObject {
  type: 'section';
  id: string;
  label: string;
  /** Buyer-facing section name; logical/id fields remain stable. */
  displayLabel?: string;
  /**
   * Buyer-facing entrance/door hint shown in the picker section card
   * ("Entrance X"). ≤40 chars; absent = no entrance line. Pure presentation.
   */
  entrance?: string;
  /**
   * Organizer-supplied view image inherited by buyer inventory whose owning
   * row/table/booth sits in this logical section. Seat and row photos take
   * precedence; multipart components are kept in sync by the shared section
   * metadata operation.
   */
  viewFromSeatUrl?: string;
  labelPresentation?: LabelPresentation;
  /**
   * Stable management/inventory identity shared by disconnected visual
   * components of one logical section. When absent, `id` is the logical id.
   * Each component keeps its own `id` and reference provenance so rendering,
   * editing, measured diffs, and source restoration remain exact.
   */
  logicalSectionId?: string;
  /** Shared semantic Arc/Fan group wrapped by this section. The section id is
   * preserved when the fan parameters are reopened and regenerated. */
  arcFanGroupId?: string;
  /** Closed polygon, chart units. */
  outline: Point[];
  /** Optional true line/arc/cubic boundary. `outline` is a deterministic sample
   * of this path and remains authoritative for membership, validation, and
   * clients that predate curved section rendering. */
  outlinePath?: SectionOutlinePath;
  /** Explicit aisle/cutout polygons excluded from rendering, hit-testing, and membership. */
  holes?: Point[][];
  /** Durable opaque link to the private reference component. Unlike generator
   * provenance, this survives manual geometry edits so a measured diff can
   * report drift and server-owned code can restore the source contour. */
  referenceSource?: {
    assetId: string;
    regionId: string;
  };
  /** Evidence-backed reason this source section remains a visible shell without
   * synthesized sellable inventory (press, closed technical zone, etc.). */
  referenceInventoryExclusion?: ReferenceInventoryExclusionSource;
  /** Deterministic generator provenance for editable reference/parametric shells. */
  geometry?: {
    kind: 'rectangle' | 'tapered' | 'bezier' | 'contour';
    sourceRegionId?: string;
    contourMethod?: 'pixel-edge-loops-rdp' | 'shared-edge-vector-fit-v1';
    simplificationTolerancePx?: number;
    vectorFitErrorPx?: number;
    sharedEdgeCount?: number;
  };
  /** Optional tint override (defaults to a neutral fill / dominant category mix). */
  color?: string;
  /** Zone this section belongs to (id into `ChartDoc.zones`). Far-zoom nav + pricing group. */
  zone?: string;
  /**
   * Tier height. 0 = floor (default). Higher values lift the section in the
   * picker's isometric ("3D") view, drawn on extruded side faces. Same field a
   * future multi-floor mode reuses — authored in 2D, never drawn by the user.
   *
   * This is the coarse, back-compat source for {@link height}/{@link rake}: when
   * those are absent, {@link sectionGeometry} derives real geometry from this
   * tier so legacy charts render pixel-identical.
   */
  elevation?: number;
  /**
   * 3D foundations (Phase A, additive — no migration; charts are JSON blobs).
   * Metres the section's **front edge** sits above floor 0 (a balcony/tier floor
   * height). Absent ⇒ derived from the coarse {@link elevation} tier via
   * {@link sectionGeometry}. Deliberately two scalars, not a foundation polygon:
   * front-height + {@link rake} fully determine a rectangular tier's back-height.
   *
   * NOTE: no consumer reads this raw field directly — all callers go through
   * {@link sectionGeometry}. Phase B consumers (iso view lift in
   * `SeatmapRenderer`, per-seat eye-height in the `generatePanorama` 360°
   * generator) are intentionally NOT wired in Phase A. Range 0–120 m.
   */
  height?: number;
  /**
   * Degrees of seating incline within the section (0 = flat; typical stalls
   * 5–15°, steep tiers 25–35°). Absent ⇒ 0. Consumed alongside {@link height}
   * by the future Phase B iso-lift shear and 360° sightline math — never in
   * Phase A. Range 0–45°.
   */
  rake?: number;
  /** Uniform scale about the outline centroid (1 = as drawn). Scales members too. */
  scale?: number;
  /** 0–100: reviewed strength last used to bend member rows toward a common fitted arc. */
  smoothing?: number;
  /**
   * Corner smoothing: the raw clicked polygon this section was drawn from, kept
   * verbatim so {@link cornerSmoothing} stays re-derivable and fully reversible.
   * When present, {@link outlinePath} is a curve computed from THIS polygon (not
   * a reference/blueprint contour); {@link outline} is its deterministic sample.
   * Additive and optional — legacy charts and reference-derived curves omit it.
   */
  sourceOutline?: Point[];
  /**
   * 0–100 corner-smoothing strength applied to {@link sourceOutline} to produce
   * the curved {@link outlinePath}. 0/absent = exact clicked corners. Higher
   * rounds the wide (gently-angled) corners more; sharp corners stay crisp.
   * Coordinate-free, so it round-trips over MCP (`update_sections`).
   */
  cornerSmoothing?: number;
  /** Degrees clockwise about the outline centroid (default 0). Rotates members too. */
  rotation?: number;
}

/**
 * A group of sections (Lower Bowl, Upper Bowl, Floor…). One concept, three jobs:
 * the farthest-zoom navigation unit, a pricing group, and (Batch 3) a timed-
 * release unit. Kept as a flat list on the doc; sections point back by `zone` id.
 */
export interface ZoneDef {
  id: string;
  label: string;
  color?: string;
  /**
   * Authored point this zone faces. Optional only for legacy documents: runtime
   * consumers fall back to the active floor/chart focal, while publication of
   * a zone-mode draft requires every used zone to carry an explicit point.
   */
  focalPoint?: Point;
}

/**
 * Selection layer — a hit-test/dim filter in the designer, NOT z-order management.
 * Fixed set of four; derived from object type via `layerOf()` (no per-object field yet).
 */
export type SelectionLayer = 'interactive' | 'background' | 'foreground' | 'surroundings';

/** Shape roles emitted by the curated venue-landmark palette. Keep this list in
 * lockstep with `DECOR_PRESETS`; the selection-layer unit test fails if either
 * vocabulary changes without an explicit routing decision. `reference-focal`
 * is source-backed venue context rather than an authoring-palette preset. */
export const SURROUNDINGS_SHAPE_ROLES = [
  'reference-focal',
  'bar',
  'entrance',
  'exit',
  'restroom',
  'screen',
  'sound',
  'concession',
  'coat',
  'wall',
] as const;

const SURROUNDINGS_SHAPE_ROLE_SET: ReadonlySet<string> = new Set(SURROUNDINGS_SHAPE_ROLES);

/** Derive an object's selection layer from its type. */
export function layerOf(obj: ChartObject): SelectionLayer {
  switch (obj.type) {
    case 'row':
    case 'table':
    case 'gaArea':
    case 'booth':
    case 'section':
      return 'interactive';
    // Raster décor follows its explicit authored z-layer. Absence retains the
    // legacy Background default; bitmap content is never guessed semantically.
    case 'decorImage':
      return obj.layer === 'foreground' ? 'foreground' : 'background';
    // Source-backed focal geometry and curated venue landmarks help an author
    // orient around the sellable plan. A stage and an ordinary authored shape
    // remain Background even when they carry an arbitrary/custom role.
    case 'shape':
      return obj.role && SURROUNDINGS_SHAPE_ROLE_SET.has(obj.role)
        ? 'surroundings'
        : 'background';
    // Free text — including semantic icon text — is background furniture.
    case 'text':
      return 'background';
    default:
      return 'interactive';
  }
}

/** Free-standing text on the chart (aisle names, door labels…). */
export interface TextObject {
  type: 'text';
  id: string;
  /** Persisted provenance for objects created from the venue-icon palette. */
  semanticKind?: 'icon';
  /**
   * Registry key for a vector wayfinding icon (see src/core/icons.ts). Present
   * on modern icon placements; the object then renders as a single-color vector
   * Path instead of `text`. Absent on legacy emoji icons, which keep rendering
   * `text` through the shared glyph path — old charts are never rewritten.
   */
  iconKey?: string;
  text: string;
  position: Point;
  fontSize: number;
  /** Optional CSS family stack for this annotation; absent inherits ChartTheme.fontFamily. */
  fontFamily?: string;
  rotation: number;
  color?: string;
  /** Render weight (default false). Maps to Konva fontStyle bold. */
  bold?: boolean;
  /** Render slant (default false). Maps to Konva fontStyle italic. */
  italic?: boolean;
}

/**
 * A raster/vector decor graphic drawn IN the chart, beneath the seats and
 * sections (ice rink, basketball court, stage art, pitch markings). Purely
 * visual venue context — never bookable, never hit-tested, so it never steals a
 * seat click. `href` is a self-contained data URL (image or SVG) produced by the
 * same client-side downscale used for row photos, so it travels with the doc and
 * caches as a single bitmap blit (zero per-frame cost). Placed by top-left
 * (x,y) + size, rotated about its centre — the same handles a shape rect uses.
 */
export interface DecorImageObject {
  type: 'decorImage';
  id: string;
  /** Image or SVG data URL. */
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise about the image centre (default 0). */
  rotation?: number;
  /** 0–1 (default 1). Multiplied by any chart-theme dimming at render time. */
  opacity?: number;
  /**
   * Z-layer relative to the interactive seat layer. `background` (default)
   * draws beneath the seats/sections; `foreground` draws above them (a roof
   * canopy, an overlay graphic). Absent = background — no migration needed.
   */
  layer?: 'background' | 'foreground';
  /** Optional caption for the designer inspector / accessibility (not drawn). */
  label?: string;
}

export type ChartObject =
  | RowObject
  | GAAreaObject
  | ShapeObject
  | TableObject
  | BoothObject
  | TextObject
  | SectionObject
  | DecorImageObject;

/**
 * One floor / level of a multi-floor venue (Batch 5). Each floor owns its own
 * geometry, stage focal point, and trace image; categories/zones/tiers stay
 * chart-global (one event, one inventory). A single-floor chart has NO `floors`
 * — its `objects[]` is the whole venue — so all existing charts are untouched.
 */
export interface Floor {
  id: string;
  name: string;
  /**
   * Absolute physical deck height in metres above the venue/stage datum.
   * Optional for backwards compatibility; an absent value resolves to ground
   * level (0 m). Section tiers and rakes are separate, section-local metadata.
   * Range 0–120 m.
   */
  baseHeightM?: number;
  objects: ChartObject[];
  focalPoint: Point;
  /**
   * Private organizer trace/calibration layer. This is authoring evidence and
   * must never be served to, or rendered by, a buyer surface.
   */
  referenceImage?: ChartReferenceImage;
  /**
   * Buyer-visible aesthetic background. Canonical documents store URL-only
   * images here. Historical `assetId` values are interpreted as a trace layer
   * by the background compatibility helpers.
   */
  backgroundImage?: ChartDoc['backgroundImage'];
}

export interface ReferenceCalibration {
  type: 'two-point';
  /** Points in immutable source-image pixels, selected by a human or trusted detector. */
  sourceA: Point;
  sourceB: Point;
  /** Verified real-world distance between the two source points. */
  distance: number;
  unit: 'm' | 'ft' | 'chart-unit';
  /** Derived and stored for deterministic geometry compilers. */
  pixelsPerUnit: number;
}

/**
 * A single human-placed seat probe: the author clicks one seat on the reference
 * image and the server reads the surrounding seat lattice from it.
 *
 * COORDINATE-POLICY CARVE-OUT (owner decision 2026-07-21). The reference
 * blueprint pipeline runs `coordinatePolicy: 'opaque-region-ids-only'` — the
 * server is the sole source of chart coordinates and MCP clients select opaque
 * `reg_*` ids, never points. This type is a deliberate, narrow exception on the
 * same grounds as `ReferenceCalibration`: the point is placed by a human in the
 * designer canvas, not proposed by a model.
 *
 * Therefore this is DESIGNER-ONLY and is intentionally NOT exposed over MCP.
 * That is an accepted, documented exception to the MCP-parity rule — the
 * server-is-sole-source guarantee for model-driven edits is worth more than
 * parity here. Do not "fix" it by adding a seed point to an MCP tool schema.
 */
export interface ReferenceSeatSeed {
  /** Seed centre in immutable source-image pixels (never chart coordinates). */
  source: Point;
  /** Half-width of the author's sizing ring, in source pixels — the "this is how
   *  big one seat is" hint that replaces seats.io's zoom-until-it-matches step. */
  radius: number;
  /** Whether `radius` was fitted from image pixels or set by hand. Detection
   *  weights an author-set radius more heavily than one we guessed. */
  origin: 'auto-fit' | 'manual';
}

/** One detected row in a scan proposal — a straight seat run in CHART
 *  coordinates (the server maps source pixels through referencePixelToChart;
 *  clients never see source-pixel geometry back). */
export interface ReferenceScanRowProposal {
  start: Point;
  end: Point;
  seatCount: number;
}

/** Detected rows attributed to one compiled section (or unattributed when the
 *  lattice extends outside every compiled polygon). */
export interface ReferenceScanSectionProposal {
  /** Id of the compiled SectionObject the rows landed in; null = unattributed. */
  sectionId: string | null;
  name: string;
  rows: ReferenceScanRowProposal[];
  seatCount: number;
  /** 0..1 — how well this section's lattice agreed with the probe's pitch. */
  confidence: number;
  /** Index of the seed (multi-probe) whose pitch produced these rows. */
  seedIndex: number;
}

/** Server response for an in-canvas reference scan. A PROPOSAL — nothing is
 *  committed until the author applies it in the designer (chartOps + undo). */
export interface ReferenceScanProposal {
  assetId: string;
  /** Measured seat diameter / centre-to-centre pitch, in chart units. */
  seatDiameter: number;
  seatPitch: number;
  totalSeats: number;
  totalRows: number;
  sections: ReferenceScanSectionProposal[];
}

/**
 * Human-only Magic Trace request. `source` is one click in immutable
 * source-image pixels; it is accepted only by the browser Designer HTTP
 * surfaces and must never be added to an MCP schema.
 */
export interface ReferenceSectionTraceInput {
  assetId: string;
  floorId?: string;
  expectedUpdatedAt: number;
  source: Point;
}

/**
 * Whole-reference Magic Trace request. Unlike the one-region request this
 * carries no source coordinates: the server returns every persisted closed
 * region as an ID-free proposal for explicit browser review.
 */
export interface ReferenceSectionTraceBatchInput {
  assetId: string;
  floorId?: string;
  expectedUpdatedAt: number;
}

/**
 * Read-only Magic Trace result. This is deliberately not a SectionObject:
 * there is no object id or label until the author accepts the proposal through
 * the normal Designer command/undo boundary.
 *
 * All geometry is in chart coordinates. Source pixels, private contour
 * vertices and reference bounds are never returned.
 */
export interface ReferenceSectionTraceProposal {
  assetId: string;
  floorId: string;
  outline: Point[];
  /** Required exact fitted line/arc/cubic boundary. */
  outlinePath: SectionOutlinePath;
  /** Only structural source voids; printed labels/icons are filtered out. */
  holes: Point[][];
  color: string;
  referenceSource: {
    assetId: string;
    regionId: string;
  };
  geometry: {
    kind: 'contour';
    sourceRegionId: string;
    contourMethod: 'shared-edge-vector-fit-v1';
    simplificationTolerancePx: number;
    vectorFitErrorPx: number;
    sharedEdgeCount: number;
  };
  provenance: {
    regionId: string;
    analysisVersion: number;
    vectorTopologyVersion: number;
    selection: 'human-source-pixel-seed' | 'human-bulk-reference-review';
    registration: 'persisted-reference-registration-v1';
  };
  /** Coordinate-free evidence suitable for an author-facing confirmation. */
  diagnostics: {
    regionMarker: string;
    structuralHoleCount: number;
    fittedComponentCount: number;
    sharedBoundaryCount: number;
    maximumAllowedVectorErrorPx: number;
    measuredVectorErrorPx: number;
    /** Source component footprint, as a percentage of the analyzed image. */
    sourceAreaPercent?: number;
  };
}

/** Read-only whole-reference proposal. The author may approve each proposal or
 * all proposals; the Designer then materializes the accepted set atomically. */
export interface ReferenceSectionTraceBatchProposal {
  assetId: string;
  floorId: string;
  proposals: ReferenceSectionTraceProposal[];
  diagnostics: {
    analyzedRegionCount: number;
    proposalCount: number;
    alreadyTracedCount: number;
    withinToleranceCount: number;
  };
}

/** Coordinate-free physical scale derived by server code from a confirmed
 * semantic feature. Unlike manual two-point calibration, no source points pass
 * through an MCP client or language model. */
export interface ReferenceDerivedScale {
  method: 'confirmed-focal-axis-v1';
  feature: 'focal-long-axis' | 'focal-short-axis';
  distance: number;
  unit: 'm' | 'ft';
  evidence: 'user-confirmed' | 'authoritative-source';
  sourceDescription: string;
  chartUnitsPerUnit: number;
}

export interface ChartReferenceImage {
  /** Stable private reference asset. New cloud-authored charts use this. */
  assetId?: string;
  /** Legacy/self-contained source. Optional when assetId is present. */
  url?: string;
  center: Point;
  /** Rendered width in chart units (height follows the cropped image aspect). */
  width: number;
  opacity: number;
  rotation?: number;
  visible?: boolean;
  layer?: 'below' | 'above';
  locked?: boolean;
  /** Normalized source crop; defaults to the full image. */
  crop?: { x: number; y: number; width: number; height: number };
  calibration?: ReferenceCalibration;
  /** Server-derived semantic calibration without source-image coordinates. */
  derivedScale?: ReferenceDerivedScale;
}

export interface ChartDoc {
  version: 1;
  name: string;
  venueType: 'SIMPLE' | 'MIXED';
  /** The stage / point every seat looks at. Anchors seat-view + sightlines.
   *  Multi-floor: mirrors floor 0; each floor also carries its own focalPoint. */
  focalPoint: Point;
  categories: Category[];
  /** Section groupings for far-zoom navigation + pricing (optional; sections reference by id). */
  zones?: ZoneDef[];
  /** Multi-floor venues (Batch 5): present ⇒ floors[] is the source of truth;
   *  absent ⇒ single-floor and `objects` below is the whole chart. `objects`
   *  is kept mirroring floor 0 so single-floor readers never branch. */
  floors?: Floor[];
  objects: ChartObject[];
  /**
   * Private floor-plan source used for tracing, calibration, scanning and
   * reference-backed generation. Buyer projections always remove this field.
   */
  referenceImage?: ChartReferenceImage;
  /**
   * Buyer-visible aesthetic background. Canonical values are URL-only.
   * Compatibility: a historical value containing `assetId` is trace-only and
   * is never rendered or exposed to buyers.
   */
  backgroundImage?: ChartReferenceImage;
  /** Brand/venue theming (colors); categories carry their own colors separately. */
  theme?: ChartTheme;
  /** Parametric-template provenance: present ⇒ the chart came from a capacity-
   *  adjustable template family, and the designer offers a capacity control that
   *  regenerates it at a new target seat count (Batch 4 "curated singles + resize"). */
  template?: { family: string; targetSeats: number };
}

// ---------------------------------------------------------------------------
// Expanded (render-time) model — produced by layout.ts, consumed by the engine
// ---------------------------------------------------------------------------

export interface ExpandedSeat {
  /** Stable id: `${rowId}:${index}` */
  id: string;
  /** Public label: `${rowLabel}-${seatNumber}` */
  label: string;
  /** Buyer-facing copy; absent on legacy charts, where `label` is displayed. */
  displayLabel?: string;
  x: number;
  y: number;
  rowId: string;
  /** Owning logical section and navigation zone, resolved once at expand time. */
  sectionId?: string;
  zoneId?: string;
  /** Zone focal when authored, otherwise the active floor/chart legacy fallback. */
  focalPoint?: Point;
  /** Buyer-facing segmented-row identity. `rowId` stays the physical owner id. */
  logicalRowId?: string;
  /**
   * Seat order inside the logical row. A deliberate missing integer is inserted
   * at every aisle boundary, so numerical adjacency cannot bridge a gap.
   */
  logicalSeatIndex?: number;
  categoryKey: string;
  /** 'booth' units render as blocks (dimensions looked up via rowId = booth id). */
  kind?: 'seat' | 'booth';
  /** True when the seat has any accessibility accommodation — renderer rings/dims these. */
  accessible?: boolean;
  /** Specific accessibility accommodations (absent = none) — picker badges/filters these. */
  accessibility?: AccessibilityType[];
  /** Physical wheelchair provision resolved from the seat override. */
  wheelchairSpaceType?: 'seat-present' | 'no-seat';
  commercial?: SeatCommercialAttributes;
  /** Organizer-supplied view-from-seat image (inherited from the row). */
  viewUrl?: string;
  /** Per-seat label size/color override; absent = inherit the row/theme default. */
  labelStyle?: LabelStyle;
  /**
   * Real-world eye height in metres above the focal/stage datum, resolved at
   * expand time from the owning section's `{height, rake}` + drawn depth (Phase B2).
   * Feeds the auto-360° generator's stage-pitch math. Absent ⇒ flat seated eye
   * height (legacy / seats in no section) — so old charts stay pixel-identical.
   */
  eyeHeightM?: number;
}

export type SeatStatus = 'free' | 'held' | 'booked' | 'not_for_sale';

/** Buyer canvas projection. Perspective is a view-only projected-2.5D lane. */
export type RendererViewMode = 'flat' | 'isometric' | 'perspective';

// ---------------------------------------------------------------------------
// Renderer engine public API — implemented in src/engine/SeatmapRenderer.ts
// ---------------------------------------------------------------------------

export interface RendererCallbacks {
  onSelect?: (seat: ExpandedSeat) => void;
  onDeselect?: (seat: ExpandedSeat) => void;
  /** Buyer tried to add a seat after the active selection cap was reached. */
  onSelectionLimit?: (maxSelection: number) => void;
  /** seat is null when the pointer leaves any seat. */
  onHover?: (seat: ExpandedSeat | null) => void;
  /** Keyboard focus moved to a seat (arrow-key navigation) — for screen-reader announcements. */
  onFocusSeat?: (seat: ExpandedSeat | null) => void;
  /** Called ~1×/sec with the measured frames-per-second. */
  onFps?: (fps: number) => void;
  /** Fired when a GA area is clicked (quantity picking is UI-side). */
  onGAClick?: (areaId: string) => void;
  /**
   * Fired when a tap lands on a section outline while seats are NOT the active
   * rung (i.e. zoomed out, section/zone LOD). The host glides in + shows a
   * section-summary card instead of trying to select a 4px seat (Slice 5).
   */
  onSectionTap?: (sectionId: string) => void;
  /**
   * Fired when a seat/deck is tapped in the 3D all-floors stacked overview — the
   * host drops back to the flat 2D map on that floor ("tap a deck to enter").
   */
  onDeckTap?: (floorId: string) => void;
  /** Fired after any pan/zoom/resize settles — re-anchor screen-space overlays. */
  onViewChange?: () => void;
  /**
   * Organizer manage-mode only (`manageMode` + `marqueeSelect`): fired on
   * pointer-UP after a rubber-band marquee drag, or a ⌘A/Escape bulk shortcut,
   * with the FULL current selection (selectable seats only). The host toolbar
   * reads this to drive bulk block/unblock. Never fires when manageMode is off.
   */
  onMarquee?: (seats: ExpandedSeat[]) => void;
}

/** Far-zoom level-of-detail rung: whole zones → section blocks → individual seats. */
export type LodRung = 'zones' | 'sections' | 'seats';

export interface RendererOptions extends RendererCallbacks {
  /** Max seats selectable at once (default 10). */
  maxSelection?: number;
  /** Only these statuses are clickable (default ['free']). */
  selectableStatuses?: SeatStatus[];
  /**
   * Opt-in host behaviour flag — the renderer's own click/selection logic is
   * unchanged (it still selects + fires `onSelect` immediately, so the seat
   * highlights right away). When true, the host (e.g. PublicEventPage) treats
   * that `onSelect` as a pending candidate and shows a confirm card instead of
   * pushing straight into the cart; `deselect([seat.id])` on Cancel un-highlights.
   */
  confirmSelection?: boolean;
  /** ISO 4217 currency for on-map prices ("FROM …"); defaults to money.DEFAULT_CURRENCY.
   *  Locale for grouping/symbol placement comes from the active i18n locale. */
  currency?: string;
  /**
   * Organizer manage surface (SDK SeatManager). Opt-in — enables the manage-mode
   * gestures (marquee, ⌘A/Escape) and the bulk-selection helpers. Buyer pan /
   * pinch / tap and every existing code path are byte-identical when this is
   * false (every manage branch is gated on it). Default false.
   */
  manageMode?: boolean;
  /**
   * When `manageMode` is on, a mouse/pen primary-button drag at the seats rung
   * draws a rubber-band marquee that bulk-selects the seats it covers (emitting
   * `onMarquee` on pointer-up) instead of panning. Touch keeps single-finger
   * pan (pinch to zoom); a middle-button drag pans with a mouse. Disabled below
   * the seats rung (zoom in first). No effect unless `manageMode` is also set.
   */
  marqueeSelect?: boolean;
}

export type RenderedLabelHiddenReason =
  | 'below-minimum-size'
  | 'outside-viewport'
  | 'dimmed-or-unavailable'
  | 'clutter-or-fit'
  | 'renderer-hidden';

/** Browser-renderer evidence used by visual QA and catalog release gates. */
export interface RenderedBookableLabelEvidence {
  seatId: string;
  label: string;
  kind: 'seat' | 'booth';
  /** Painted inventory silhouette. Empty wheelchair bays are deliberately
   * square, while physical seats retain the ordinary circular marker. */
  markerShape: 'circle' | 'square' | 'booth';
  /** Physical wheelchair provision represented by this inventory unit. */
  wheelchairSpaceType?: 'seat-present' | 'no-seat';
  categoryKey: string;
  sectionId?: string;
  zoneId?: string;
  status: SeatStatus;
  selected: boolean;
  visible: boolean;
  renderedFontPx: number;
  fill: string;
  ink: string;
  opacity: number;
  /** Buyer-visible accessibility glyph evidence. Filter emphasis uses a
   * screen-space minimum so wheelchair provision remains recognizable at fit. */
  accessibilityMarker?: {
    glyphVisible: boolean;
    glyphWidthPx: number;
    emphasizedByFilter: boolean;
  };
  /** Direct Konva shape bounds and the production near-miss rescue combined. */
  pointerTarget: {
    active: boolean;
    directWidthPx: number;
    directHeightPx: number;
    effectiveMinimumPx: number;
  };
  /** Centre of the painted unit, even when its text is intentionally hidden. */
  screenCenter: { x: number; y: number };
  screenBox?: { x: number; y: number; width: number; height: number };
  hiddenReason?: RenderedLabelHiddenReason;
}

export interface RenderedHierarchyLabelEvidence {
  id: string;
  kind: 'section' | 'zone';
  role: 'name' | 'availability' | 'price';
  label: string;
  visible: boolean;
  renderedFontPx: number;
  opacity: number;
  fill: string;
  ink: string;
  /** Independent geometric containment check for section-owned text. */
  fitsContainer?: boolean;
  screenBox?: { x: number; y: number; width: number; height: number };
}

export interface RenderedFreeTextEvidence {
  objectId: string;
  kind: 'free-text' | 'stage' | 'table' | 'decor' | 'ga-label' | 'ga-capacity';
  text: string;
  visible: boolean;
  renderedFontPx: number;
  ink: string;
  background: string;
  opacity: number;
  screenBox?: { x: number; y: number; width: number; height: number };
  hiddenReason?: 'below-minimum-size' | 'outside-viewport' | 'renderer-hidden';
}

export interface RenderedGAAreaEvidence {
  areaId: string;
  label: string;
  capacity: number;
  categoryKey: string;
  /** Owning logical section when the rendered GA surface is section-contained. */
  sectionId?: string;
  visible: boolean;
  interactive: boolean;
  opacity: number;
  fill: string;
  effectiveBackground: string;
  screenBox?: { x: number; y: number; width: number; height: number };
}

export interface RendererQualityEvidence {
  viewport: { width: number; height: number };
  /** Runtime projection actually used for the pixels and hit graph below. */
  projection: RendererViewMode;
  /** Phase-C proof metadata. Present only in the projected-2.5D lane. */
  perspective?: {
    model: 'pinhole-exact-seat-anchors';
    sectionSurfaceModel: 'tangent-plane';
    exactSeatAnchorCount: number;
    depthSorted: true;
  };
  canvasBackground: string;
  effectiveScale: number;
  rung: LodRung;
  minimumVisibleLabelPx: number;
  totalLabelledBookableUnits: number;
  visibleLabels: number;
  hiddenLabels: number;
  /** Seats/table-seats/booths plus the full GA capacity. */
  totalBookableUnits: number;
  selectionRingSeatIds: string[];
  selectionRingColor: string;
  focusedSectionId: string | null;
  focusBackdropVisible: boolean;
  categoryFilterKeys: string[] | null;
  /** Exact scene-graph proof for the clean section-first overview contract. */
  overviewStyle: {
    visibleSectionShells: number;
    categoryPaintedSectionShells: number;
    visibleCategoryDetailOutlines: number;
    visibleSectionRowHints: number;
    visibleSectionAvailabilityLabels: number;
    visibleSectionGADetails: number;
  };
  labels: RenderedBookableLabelEvidence[];
  gaAreas: RenderedGAAreaEvidence[];
  hierarchyLabels: RenderedHierarchyLabelEvidence[];
  freeTextLabels: RenderedFreeTextEvidence[];
}

export interface ISeatmapRenderer {
  /** Replace the chart. Resets selection and statuses, zooms to fit.
   *  `opts.floorId` picks which floor to render on a multi-floor chart (Batch 5). */
  setChart(doc: ChartDoc, opts?: { floorId?: string }): void;
  /** Bulk status update; re-renders affected seats only. */
  setStatus(seatIds: string[], status: SeatStatus): void;
  /**
   * Mark the active buyer's own held seats. They remain server-status `held`,
   * but render with the buyer selection treatment instead of the anonymous
   * unavailable treatment used for another buyer's hold.
   */
  setOwnedHold?(seatIds: string[] | null): void;
  /**
   * Mark one selected seat as the buyer's pending confirmation candidate.
   * The candidate receives a strong focus halo while unrelated seats recede;
   * pass null after Select/Cancel. This is visual only and never mutates the
   * renderer selection.
   */
  setSelectionFocus?(seatId: string | null): void;
  /**
   * SYNCHRONOUS repaint that bypasses requestAnimationFrame. Konva's batchDraw()
   * (used by setStatus and friends) schedules the actual paint on the next rAF
   * tick, which Chrome throttles/pauses on hidden, backgrounded, or occluded
   * tabs — so a seat-status delta updates the scene graph but the pixels never
   * change until the tab is foregrounded again. forceDraw() paints the affected
   * layers immediately (Layer.draw() is synchronous) and flushes any pending
   * cache-debounce, so a caller (visibilitychange catch-up, or an opted-in
   * always-live board) can guarantee the canvas reflects current state
   * regardless of tab visibility. No-op difference in the foreground.
   */
  forceDraw(): void;
  getStatus(seatId: string): SeatStatus;
  getSelection(): ExpandedSeat[];
  clearSelection(): void;
  /** Update the buyer selection cap without rebuilding the chart or camera. */
  setMaxSelection?(maxSelection: number): void;
  /**
   * Programmatically restore free seats (for example an Undo action). Added
   * seats respect the active cap and do not reopen a confirmation popover.
   */
  select?(seatIds: string[]): ExpandedSeat[];
  /**
   * Dynamically update organizer-only interaction without rebuilding the
   * renderer. No buyer surface calls this; every behavior remains gated by
   * `manageMode` exactly as it is at construction time.
   */
  setManageInteraction?(options: {
    manageMode: boolean;
    marqueeSelect: boolean;
    selectableStatuses: SeatStatus[];
    maxSelection?: number;
  }): void;
  /** Organizer-only section heat overlay. Values are normalized 0..1. */
  setSectionHeat?(scores: Record<string, number> | null): void;
  /**
   * Manage-mode bulk selection helpers (no-op / empty unless `manageMode`).
   * They select the matching SELECTABLE seats (respecting `selectableStatuses`
   * + closed sections), union with the current selection, and return the seats
   * they added — the SDK SeatManager expands category/row/section picks to
   * labels and drives one batched block/unblock from them.
   */
  selectAllSelectable?(): ExpandedSeat[];
  selectByLabels?(labels: string[]): ExpandedSeat[];
  /** Exact-render QA only: select one server-chosen unit without label ambiguity. */
  setEvidenceSelection?(seatId: string): boolean;
  /** Selectable seats belonging to a section OR zone id (no selection side-effect). */
  getSelectableInSection?(sectionId: string): ExpandedSeat[];
  /** Programmatic deselect of specific seats (e.g. chip × in the cart). */
  deselect(seatIds: string[]): void;
  /**
   * Brief attention pulse on a seat (a ring that expands + fades once) — used to
   * signal live activity, e.g. a seat "just taken" by another buyer via a WS
   * delta. Purely visual; no state change. `color` overrides the default.
   */
  flashSeat(seatId: string, color?: string): void;
  /**
   * Brief organizer attention pulse around a whole section. This is a visual
   * overlay only: it never changes section geometry, hit targets, selection, or
   * the active camera. Useful for grouped realtime operations at venue overview.
   */
  flashSection?(sectionId: string, color?: string): void;
  zoomToFit(): void;
  /** Zoom in one step about the viewport center, clamped to the usual zoom bounds. */
  zoomIn(): void;
  /** Zoom out one step about the viewport center, clamped to the usual zoom bounds. */
  zoomOut(): void;
  /** Individually status-managed seats/table-seats/booths; excludes GA capacity. */
  seatCount(): number;
  /** Seats/table-seats/booths plus the full capacity of rendered GA areas. */
  bookableCount(): number;
  /**
   * Maps a chart-space point (or a seat, by its x/y) to container-relative
   * screen pixels, using the current stage scale/position. Lets host UI anchor
   * DOM overlays (confirm card, tooltip) over a live seat and re-anchor them
   * on `onViewChange`.
   */
  worldToScreen(point: Point): { x: number; y: number };
  /** When on, dim non-accessible free seats so accessible seats stand out. */
  setAccessibleFilter(on: boolean): void;
  /**
   * Dim free seats that lack ANY of these accessibility types. `null` clears the
   * filter; `[]` means "any accessible seat" (same as setAccessibleFilter(true)).
   */
  setAccessibilityFilter(types: AccessibilityType[] | null): void;
  /** Legend hover-highlight: dim free seats of other categories (null clears). */
  setCategoryHighlight?(key: string | null): void;
  /** Price-band filter (F4): dim free seats whose category is NOT in `keys`
   *  (null clears). The widget resolves which categories fall in the band. */
  setCategoryFilter?(keys: string[] | null): void;
  /** Smoothly frame the currently available seats in these categories. `null`
   *  returns to the full chart. Used after an explicit buyer price-filter action. */
  focusCategories?(keys: string[] | null): void;
  /** Dim the seats of these section/zone ids (organizer manager: held-back inventory). */
  setDimmedSections?(ids: string[] | null): void;
  /**
   * Phase 2 event-level section states: mark these section/zone ids `closed` —
   * flat grey block, seats greyed + not pickable, section stays rendered.
   * `null`/empty clears. (Distinct from the buyer's applyHidden seat-strip.)
   */
  setClosedSections?(ids: string[] | null): void;
  /**
   * AXS section-focus: dim + desaturate every other section, draw a calm backdrop
   * behind this section, and glide the camera to frame it. Seat-picking is gated
   * until seats are large enough on screen (≥ LABEL_SCALE). Slice 5 / Phase 2 §4.
   */
  focusSection?(id: string): void;
  /** Clear an AXS section focus (restore full-bowl brightness + drop backdrop). */
  clearSectionFocus?(): void;
  /** The currently AXS-focused section id, or null. */
  getFocusedSection?(): string | null;
  /** World-space rect currently visible in the viewport (minimap viewport frame). */
  getVisibleWorldRect?(): { x: number; y: number; width: number; height: number };
  /** Axis-aligned world bounds of all seats + section outlines (minimap frame). */
  getWorldBounds?(): { x: number; y: number; width: number; height: number };
  /**
   * Colorblind-safe mode: category hues switch to an Okabe-Ito palette and
   * booked seats render hollow (a non-color cue), so seat state never relies
   * on hue alone. Off (the default) renders exactly as before.
   */
  setColorblindSafe?(on: boolean): void;
  /**
   * Switch the projection. `'flat'` = normal top-down; `'isometric'` = the
   * legacy affine preview; `'perspective'` = projected 2.5D with exact pinhole
   * seat anchors/native hit shapes and bounded per-section tangent surfaces.
   * Purely visual — the chart is authored flat.
   */
  setViewMode?(mode: RendererViewMode): void;
  /** Current projection (defaults to 'flat' when unimplemented). */
  getViewMode?(): RendererViewMode;
  /** Multi-floor (Batch 5): switch the shown floor; list floors; read the active id. */
  setActiveFloor?(floorId: string): void;
  getFloors?(): { id: string; name: string }[];
  getActiveFloorId?(): string;
  /** Render all floors stacked (3D overview) vs the active floor. No-op single-floor. */
  setStacked?(on: boolean): void;
  isStacked?(): boolean;
  /**
   * Section id whose outline contains a container-relative screen point (or null).
   * Feeds the far-zoom "tap a section to zoom in" flow (Slice 5).
   */
  sectionAt?(clientPoint: Point): string | null;
  /** Seat ids belonging to a section — for the section-summary card (Slice 5). */
  sectionMembers?(id: string): string[];
  /**
   * Smoothly glide (pan+zoom) the camera to frame a section (by id) or a world-
   * space bounds rect over a calm easeInOutCubic glide. `prefers-reduced-motion` snaps.
   * A pointer-down (grab/pan) cancels an in-flight glide. Slice 5 "glide in".
   */
  focusRegion?(
    target: string | { x: number; y: number; width: number; height: number },
    opts?: { animate?: boolean; minScale?: number; durationMs?: number },
  ): void;
  /** Current LOD rung derived from zoom (for the ZONES/SECTIONS/SEATS pill). */
  getRung?(): LodRung;
  /** Jump the camera to a rung's zoom band, centred on the chart (glided). */
  setRung?(rung: LodRung): void;
  /** Read actual browser-rendered label visibility, size, fill, ink and state.
   *  Pure diagnostic: it never changes chart or renderer state. */
  getRenderedQualityEvidence(): RendererQualityEvidence;
  destroy(): void;
}

/** localStorage key the Designer writes and the Picker reads. */
export const CHART_STORAGE_KEY = 'seatmap.chart';
