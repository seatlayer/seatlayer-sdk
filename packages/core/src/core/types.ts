/**
 * SeatMap chart document — the single source of truth shared by the
 * Designer (authoring) and the Renderer (buyer picker).
 *
 * Mirrors docs/seatmap-build-spec.md §5. Coordinates are abstract units
 * (roughly "pixels at scale 1"); the renderer fits the chart to its container.
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
  /** Commercial selling/view attributes are deliberately not accessibility. */
  commercial?: SeatCommercialAttributes;
  /** Seat-specific view photo; falls back to the row photo. */
  viewFromSeatUrl?: string;
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
  /** Row label, e.g. "A". Seat labels are `${label}-${n}`. */
  label: string;
  /** Buyer-facing row name. `label` remains the legacy inventory prefix. */
  displayLabel?: string;
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
  /** First seat number (default 1). */
  seatLabelStart?: number;
  /** Seat numbering within the row (default ltr, step 1). */
  seatNumbering?: {
    /** ltr / rtl number from an end; `center` numbers outward from the middle
     *  (centre seat lowest — the premium-centre theatre convention). */
    direction: 'ltr' | 'rtl' | 'center';
    /** 2 = odd/even numbering (1,3,5… — start at 2 for evens). */
    step?: 1 | 2;
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
  label: string;
  /** Closed polygon, in chart units. */
  points: Point[];
  /** Explicit aisles/pillars/cutouts excluded from the sellable GA surface. */
  holes?: Point[][];
  capacity: number;
  categoryKey: string;
  referenceInventorySource?: ReferenceInventorySource;
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

/** Non-bookable décor: stage, walls, exits. */
export interface ShapeObject {
  type: 'shape';
  id: string;
  kind: 'rect' | 'ellipse' | 'polygon';
  label?: string;
  /** For rect/ellipse: bounding box. For a stage polygon: the base (pre-shape) box, so its kind can be regenerated. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** For polygon. */
  points?: Point[];
  fill?: string;
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

/** Seats arranged around a table; bookable per-seat or as a whole. */
export interface TableObject {
  type: 'table';
  id: string;
  /** e.g. "T1" — seat labels are `${label}-${n}`. */
  label: string;
  center: Point;
  shape: 'round' | 'rect';
  /** Seats around the perimeter (round) or along the enabled edges (rect). */
  seatCount: number;
  /** Rect tables: which edges get seats (default ['top','bottom']). */
  sides?: Array<'top' | 'bottom' | 'left' | 'right'>;
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
  /** Whole-table booking: buyers get all seats or none (per-event override later). */
  bookAsWhole?: boolean;
  referenceInventorySource?: ReferenceInventorySource;
}

/** A booth: one bookable unit rendered as a block (trade shows, VIP boxes). */
export interface BoothObject {
  type: 'booth';
  id: string;
  label: string;
  center: Point;
  width: number;
  height: number;
  rotation: number;
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
   */
  elevation?: number;
  /** Uniform scale about the outline centroid (1 = as drawn). Scales members too. */
  scale?: number;
  /** 0–1: how strongly member-row curves are bent toward a common arc fitted to the outline. */
  smoothing?: number;
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
}

/**
 * Selection layer — a hit-test/dim filter in the designer, NOT z-order management.
 * Fixed set of four; derived from object type via `layerOf()` (no per-object field yet).
 */
export type SelectionLayer = 'interactive' | 'background' | 'foreground' | 'surroundings';

/** Derive an object's selection layer from its type (design contract, HANDOFF §03). */
export function layerOf(obj: ChartObject): SelectionLayer {
  switch (obj.type) {
    case 'row':
    case 'table':
    case 'gaArea':
    case 'booth':
    case 'section':
      return 'interactive';
    // stage / décor live on 'shape'; free text + decor images are background furniture.
    case 'shape':
    case 'text':
    case 'decorImage':
      return 'background';
    default:
      return 'interactive';
  }
}

/** Free-standing text on the chart (aisle names, door labels…). */
export interface TextObject {
  type: 'text';
  id: string;
  text: string;
  position: Point;
  fontSize: number;
  rotation: number;
  color?: string;
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
  objects: ChartObject[];
  focalPoint: Point;
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
  /** Floor-plan photo the organizer traces over (designer-only aid, also rendered dimly in picker if kept). */
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
  categoryKey: string;
  /** 'booth' units render as blocks (dimensions looked up via rowId = booth id). */
  kind?: 'seat' | 'booth';
  /** True when the seat has any accessibility accommodation — renderer rings/dims these. */
  accessible?: boolean;
  /** Specific accessibility accommodations (absent = none) — picker badges/filters these. */
  accessibility?: AccessibilityType[];
  commercial?: SeatCommercialAttributes;
  /** Organizer-supplied view-from-seat image (inherited from the row). */
  viewUrl?: string;
}

export type SeatStatus = 'free' | 'held' | 'booked' | 'not_for_sale';

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
   * Switch the projection. `'flat'` = normal top-down; `'isometric'` = the "3D"
   * view (affine skew/rotate + elevation lift), hit-testing preserved in screen
   * space. Purely visual — the chart is authored flat. Animated unless reduced-motion.
   */
  setViewMode?(mode: 'flat' | 'isometric'): void;
  /** Current projection (defaults to 'flat' when unimplemented). */
  getViewMode?(): 'flat' | 'isometric';
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
