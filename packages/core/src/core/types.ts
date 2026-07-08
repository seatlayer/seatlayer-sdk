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

export interface Category {
  key: string;
  label: string;
  color: string;
  /** Demo-only convenience; real pricing comes from ticket tiers server-side. */
  price?: number;
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
  categoryKey?: string;
  /** @deprecated legacy flag — read as `['wheelchair']`; write `accessibility`. */
  accessible?: boolean;
  /** Accessibility accommodations of this seat (empty/absent = none). */
  accessibility?: AccessibilityType[];
}

/** Brand/venue theming — applied by the renderer in both designer and picker. */
export interface ChartTheme {
  /** Canvas background color (default dark: #0e1117-ish radial). */
  background?: string;
  /** Seat label text color (default dark ink #0b1220). */
  seatLabelColor?: string;
  /** Selection ring / accent color (default white ring + brand accent). */
  selectionColor?: string;
  /** Décor (stage/shape) default fill. */
  decorFill?: string;
  /** Free-text color default. */
  textColor?: string;
  /** Font family (CSS stack) for all rendered text — seat labels, sections, décor text. */
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
  categoryKey: string;
  /** First seat number (default 1). */
  seatLabelStart?: number;
  /** Seat numbering within the row (default ltr, step 1). */
  seatNumbering?: {
    direction: 'ltr' | 'rtl';
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
}

export interface GAAreaObject {
  type: 'gaArea';
  id: string;
  label: string;
  /** Closed polygon, in chart units. */
  points: Point[];
  capacity: number;
  categoryKey: string;
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
  /** Rect tables. */
  width?: number;
  height?: number;
  categoryKey: string;
  /** Whole-table booking: buyers get all seats or none (per-event override later). */
  bookAsWhole?: boolean;
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
  /** Closed polygon, chart units. */
  outline: Point[];
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
    // stage / décor live on 'shape'; free text is background furniture.
    case 'shape':
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
  text: string;
  position: Point;
  fontSize: number;
  rotation: number;
  color?: string;
}

export type ChartObject =
  | RowObject
  | GAAreaObject
  | ShapeObject
  | TableObject
  | BoothObject
  | TextObject
  | SectionObject;

export interface ChartDoc {
  version: 1;
  name: string;
  venueType: 'SIMPLE' | 'MIXED';
  /** The stage / point every seat looks at. Anchors seat-view + sightlines. */
  focalPoint: Point;
  categories: Category[];
  /** Section groupings for far-zoom navigation + pricing (optional; sections reference by id). */
  zones?: ZoneDef[];
  objects: ChartObject[];
  /** Floor-plan photo the organizer traces over (designer-only aid, also rendered dimly in picker if kept). */
  backgroundImage?: {
    url: string;
    center: Point;
    /** Rendered width in chart units (height follows the image aspect). */
    width: number;
    opacity: number;
    locked?: boolean;
  };
  /** Brand/venue theming (colors); categories carry their own colors separately. */
  theme?: ChartTheme;
}

// ---------------------------------------------------------------------------
// Expanded (render-time) model — produced by layout.ts, consumed by the engine
// ---------------------------------------------------------------------------

export interface ExpandedSeat {
  /** Stable id: `${rowId}:${index}` */
  id: string;
  /** Public label: `${rowLabel}-${seatNumber}` */
  label: string;
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
  /** seat is null when the pointer leaves any seat. */
  onHover?: (seat: ExpandedSeat | null) => void;
  /** Keyboard focus moved to a seat (arrow-key navigation) — for screen-reader announcements. */
  onFocusSeat?: (seat: ExpandedSeat | null) => void;
  /** Called ~1×/sec with the measured frames-per-second. */
  onFps?: (fps: number) => void;
  /** Fired when a GA area is clicked (quantity picking is UI-side). */
  onGAClick?: (areaId: string) => void;
  /** Fired after any pan/zoom/resize settles — re-anchor screen-space overlays. */
  onViewChange?: () => void;
}

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
}

export interface ISeatmapRenderer {
  /** Replace the chart. Resets selection and statuses, zooms to fit. */
  setChart(doc: ChartDoc): void;
  /** Bulk status update; re-renders affected seats only. */
  setStatus(seatIds: string[], status: SeatStatus): void;
  getStatus(seatId: string): SeatStatus;
  getSelection(): ExpandedSeat[];
  clearSelection(): void;
  /** Programmatic deselect of specific seats (e.g. chip × in the cart). */
  deselect(seatIds: string[]): void;
  /**
   * Brief attention pulse on a seat (a ring that expands + fades once) — used to
   * signal live activity, e.g. a seat "just taken" by another buyer via a WS
   * delta. Purely visual; no state change. `color` overrides the default.
   */
  flashSeat(seatId: string, color?: string): void;
  zoomToFit(): void;
  /** Zoom in one step about the viewport center, clamped to the usual zoom bounds. */
  zoomIn(): void;
  /** Zoom out one step about the viewport center, clamped to the usual zoom bounds. */
  zoomOut(): void;
  /** Total seat count of the current chart. */
  seatCount(): number;
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
  /**
   * Switch the projection. `'flat'` = normal top-down; `'isometric'` = the "3D"
   * view (affine skew/rotate + elevation lift), hit-testing preserved in screen
   * space. Purely visual — the chart is authored flat. Animated unless reduced-motion.
   */
  setViewMode?(mode: 'flat' | 'isometric'): void;
  /**
   * Section id whose outline contains a container-relative screen point (or null).
   * Feeds the far-zoom "tap a section to zoom in" flow (Slice 5).
   */
  sectionAt?(clientPoint: Point): string | null;
  /** Seat ids belonging to a section — for the section-summary card (Slice 5). */
  sectionMembers?(id: string): string[];
  destroy(): void;
}

/** localStorage key the Designer writes and the Picker reads. */
export const CHART_STORAGE_KEY = 'seatmap.chart';
