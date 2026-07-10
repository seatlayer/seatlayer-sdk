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
import { Image as KImage } from 'konva/lib/shapes/Image';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Shape } from 'konva/lib/Shape';

import type {
  AccessibilityType,
  ChartDoc,
  ChartTheme,
  ExpandedSeat,
  ISeatmapRenderer,
  LodRung,
  Point,
  RendererOptions,
  SeatStatus,
  SectionObject,
} from '../core/types';
import { chartBounds, expandChart, floorsOf, pointInPolygon, stackFloors } from '../core/layout';
import { t } from '../i18n';
import { formatMoney } from '../lib/money';

const SEAT_RADIUS = 9;
/** Absolute scale at which a seat (r=9) renders ~legibly (~8px). */
const SEAT_LEGIBLE_SCALE = 0.9;
/** Below this absolute scale we swap seats for a cached bitmap. */
const CACHE_THRESHOLD = 0.55 * SEAT_LEGIBLE_SCALE;
/** Show per-seat labels above this ABSOLUTE scale (seat ⌀ ≈ 18px) — chart-size independent. */
const LABEL_SCALE = 1.0;
/**
 * At/below this scale, sections read as solid BLOCKS with row-line hints (seats
 * fully hidden) — the seats.io-style default overview.
 */
const SECTION_PROMINENT_SCALE = 0.45 * SEAT_LEGIBLE_SCALE;
/**
 * Above this scale, seats are fully shown (dots); between here and
 * SECTION_PROMINENT the block melts in. Set high so a big sectioned chart OPENS
 * as named blocks and only reveals seats once you zoom in close.
 */
const BLOCK_MELT_TOP = 0.9 * SEAT_LEGIBLE_SCALE;
/**
 * Below this scale, ZONE blocks/labels take over from per-section detail (the
 * farthest rung). ~0.55× the section rung so: seats → section blocks → zones.
 */
const ZONE_PROMINENT_SCALE = 0.55 * SECTION_PROMINENT_SCALE;
/** Never label more than this many seats at once (viewport clutter guard). */
const MAX_LABELS = 700;

// ---- Isometric ("3D") view mode -------------------------------------------
/** Full-iso rotation of the chart about its centre (degrees). */
const ISO_ANGLE_DEG = -11.5;
/** Full-iso vertical squash (1 = flat). */
const ISO_SQUASH = 0.58;
/** World units a section (and its members) lift per elevation step at full iso. */
const LIFT_PER_STEP = 58;
/** Flat⇄iso tween duration (ms); reduced-motion snaps. */
const ISO_TWEEN_MS = 320;

// ---- Section/zone LOD ("melt") tuning -------------------------------------
/** Peak fill opacity of a solid section block at the block rung. */
const BLOCK_FILL_ALPHA = 0.85;
/** How far a fully-sold section's fill darkens toward black. */
const SOLD_DARKEN = 0.5;
/** Screen-space target sizes (px) for scale-compensated section/zone labels. */
const SECTION_LABEL_PX = 20;
const SECTION_SUB_PX = 12.5;
const ZONE_LABEL_PX = 30;
const ZONE_SUB_PX = 12;

const HELD_FILL = '#6b7280';
const TAKEN_FILL = '#374151';
const NFS_STROKE = '#4b5563';

/** Outer-ring colour per accommodation (a seat's first-listed type wins). */
const ACCESS_RING: Record<AccessibilityType, string> = {
  wheelchair: '#3b82f6',
  companion: '#8b5cf6',
  'semi-ambulatory': '#0ea5e9',
  hearing: '#14b8a6',
  'sign-language': '#f59e0b',
  'plus-size': '#ec4899',
  'lift-armrest': '#22c55e',
};

/** Does a seat satisfy a filter? `[]` means "any accessible seat". */
function seatMatchesAccess(seat: ExpandedSeat, filter: AccessibilityType[]): boolean {
  if (filter.length === 0) return !!seat.accessible;
  return !!seat.accessibility?.some((t) => filter.includes(t));
}

// Theme fallbacks (dark defaults) — used when doc.theme leaves a slot unset.
const DEF_SEAT_LABEL = '#0b1220';
const DEF_SELECTION = '#ffffff';
const DEF_DECOR_FILL = '#232c40';
const DEF_TEXT = '#8b93a7';

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
  label: string;
  outline: Point[];
  centroid: Point;
  zone?: string;
  /** Seats whose centre falls inside the outline (first-match, doc order). */
  memberIds: string[];
  total: number;
  free: number;
  /** Category-mix (or explicit override) fill BEFORE the availability tint. */
  baseFill: string;
  /** Faint outline drawn under seats — the existing near-zoom look, untouched. */
  outlinePoly: Line;
  /** Solid block fill that melts in at the block rung. */
  blockPoly: Line;
  /** Faint per-row hint lines drawn inside the block (the seats.io "rows" look). */
  rowLines: Line[];
  /** Section name (always drawn; brightens at the block rung, hides at zone rung). */
  nameLabel: Text;
  /** Mono "N LEFT" availability sublabel (block rung only). */
  subLabel: Text;
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
  private statusById = new Map<string, SeatStatus>();
  private catColor = new Map<string, string>();
  private theme: ChartTheme = {};

  private selection = new Set<string>();
  private selectionRings = new Map<string, Circle>();
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
  /** Cumulative gesture movement in px — clicks are suppressed after a real pan/pinch. */
  private moved = 0;

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
    this.selectionRings.clear();
    this.statusById.clear();
    this.selection.clear();
    this.seatById.clear();
    this.cached = false;
    this.accessFilter = null;
    this.sections = [];
    this.zones = [];
    this.seatSection.clear();
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
    // Canvas background via container style (reset to '' when theme omits it).
    this.container.style.background = this.theme.background ?? '';
    this.hoverRing.stroke(this.theme.selectionColor ?? DEF_SELECTION);
    this.hoverRing.radius(this.seatR + 2);

    this.catColor.clear();
    this.catPrice.clear();
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

  // ---- keyboard navigation (accessibility) ----------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
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
      // Accessible seats get a static 2px outer ring, coloured by their primary
      // accommodation (few per chart, so the extra node is cheap).
      if (seat.accessible) {
        const primary = seat.accessibility?.[0];
        target.add(
          new Circle({
            x: seat.x,
            y: seat.y,
            radius: this.seatR + 1,
            stroke: (primary && ACCESS_RING[primary]) || '#3b82f6',
            strokeWidth: 2,
            listening: false,
            perfectDrawEnabled: false,
            shadowForStrokeEnabled: false,
          }),
        );
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
    this.paintSeat(rect, seat.id);
    target.add(rect);

    const t = new Text({
      x: seat.x,
      y: seat.y,
      text: seat.label,
      fontSize: 10,
      fontStyle: '600',
      fontFamily: this.labelFont(),
      fill: this.theme.seatLabelColor ?? DEF_SEAT_LABEL,
      listening: false,
      perfectDrawEnabled: false,
    });
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    this.hasBoothText = true; // gate the upright-label scan of the seat layer
    target.add(t);
  }

  /** Apply fill/stroke/opacity for a seat's current status + selection. */
  private paintSeat(c: Shape, id: string): void {
    const seat = this.seatById.get(id)!;
    const status = this.statusById.get(id) ?? 'free';
    const selected = this.selection.has(id);
    const base = this.catColor.get(seat.categoryKey) ?? '#6e7bff';

    c.dash([]);
    c.strokeWidth(0);
    c.stroke('');
    c.opacity(1);

    switch (status) {
      case 'free':
        c.fill(selected ? lighten(base, 0.28) : base);
        break;
      case 'held':
        c.fill(HELD_FILL);
        break;
      case 'booked':
        c.fill(TAKEN_FILL);
        c.opacity(0.45);
        break;
      case 'not_for_sale':
        c.fill(TAKEN_FILL);
        c.stroke(NFS_STROKE);
        c.strokeWidth(1);
        c.dash([2, 2]);
        break;
    }

    // Accessibility filter dims free, unselected seats that don't match.
    if (this.accessFilter && status === 'free' && !selected && !seatMatchesAccess(seat, this.accessFilter)) {
      c.opacity(0.25);
    }
    // Legend hover-highlight dims free, unselected seats of other categories.
    if (this.categoryHighlight && status === 'free' && !selected && seat.categoryKey !== this.categoryHighlight) {
      c.opacity(0.25);
    }
    // Held-back inventory (organizer manager): seats in a dimmed section/zone
    // read as inactive so the map matches the Sections list at a glance.
    if (this.dimmedSections.size) {
      const sec = this.seatSection.get(id);
      if (sec && (this.dimmedSections.has(sec.id) || (sec.zone != null && this.dimmedSections.has(sec.zone)))) {
        c.opacity(0.18);
      }
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

  /** Legend hover: highlight one category (dim the rest), or null to clear. */
  setCategoryHighlight(key: string | null): void {
    if (this.categoryHighlight === key) return;
    this.categoryHighlight = key;
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

  private renderBackground(doc: ChartDoc): void {
    if (doc.backgroundImage) this.renderBackgroundImage(doc.backgroundImage);
    // Sections sit under all other décor so their outlines never occlude seats.
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
    // Focal-point crosshair marker.
    const f = doc.focalPoint;
    if (f) {
      const size = 14;
      const cross = new Group({ listening: false });
      cross.add(
        new Line({ points: [f.x - size, f.y, f.x + size, f.y], stroke: '#4b5563', strokeWidth: 1.5 }),
        new Line({ points: [f.x, f.y - size, f.x, f.y + size], stroke: '#4b5563', strokeWidth: 1.5 }),
        new Circle({ x: f.x, y: f.y, radius: 3, fill: '#4b5563' }),
      );
      this.bgLayer.add(cross);
    }
  }

  /** Organizer floor-plan photo, dimmed, at the very bottom of the bg layer. */
  private renderBackgroundImage(bg: NonNullable<ChartDoc['backgroundImage']>): void {
    const img = new window.Image();
    img.onload = () => {
      const natW = img.naturalWidth || 4;
      const natH = img.naturalHeight || 3;
      const w = bg.width;
      const h = w * (natH / natW);
      const node = new KImage({
        image: img,
        x: bg.center.x - w / 2,
        y: bg.center.y - h / 2,
        width: w,
        height: h,
        opacity: bg.opacity,
        listening: false,
      });
      this.bgLayer.add(node);
      node.moveToBottom();
      this.bgLayer.batchDraw();
    };
    img.src = bg.url;
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
    this.addCentredLabel(this.bgLayer, obj.label, obj.center.x, obj.center.y, '#cbd5e1', 12, true);
  }

  private renderText(obj: Extract<ChartDoc['objects'][number], { type: 'text' }>): void {
    this.bgLayer.add(
      new Text({
        x: obj.position.x,
        y: obj.position.y,
        text: obj.text,
        fontSize: obj.fontSize,
        rotation: obj.rotation,
        fill: obj.color ?? this.theme.textColor ?? DEF_TEXT,
        fontFamily: this.labelFont(),
        listening: false,
        perfectDrawEnabled: false,
      }),
    );
  }

  private renderShape(obj: Extract<ChartDoc['objects'][number], { type: 'shape' }>): void {
    const fill = obj.fill ?? this.theme.decorFill ?? DEF_DECOR_FILL;
    const isStage = obj.role === 'stage';
    const isDecor = !!obj.role && !isStage;
    // Stage: darker at the back (min-y), brighter toward the audience edge (max-y).
    const stroke = isStage ? lighten(fill, 0.28) : undefined;
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
          strokeWidth: isStage ? 1 : 0,
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
        new Ellipse({ x: cx, y: cy, rotation: obj.rotation ?? 0, radiusX: obj.width / 2, radiusY: obj.height / 2, ...grad, stroke, strokeWidth: isStage ? 1 : 0, listening: false }),
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
        new Line({ points: pts, closed: true, x: cx, y: cy, offsetX: cx, offsetY: cy, rotation: obj.rotation ?? 0, ...grad, stroke, strokeWidth: isStage ? 1 : 0, listening: false }),
      );
    }
    if (obj.label) {
      if (isStage) this.addStageLabel(cx, cy, obj.label);
      else if (isDecor) this.addCentredLabel(this.bgLayer, obj.label, cx, cy, '#9aa3b5', 12, false);
      else this.addCentredLabel(this.bgLayer, obj.label, cx, cy, '#cbd5e1', 16, true);
    }
  }

  /** Prominent stage caption: uppercase, letter-spaced, larger, softly dimmed. */
  private addStageLabel(x: number, y: number, text: string): void {
    const t = new Text({
      x,
      y,
      text: text.toUpperCase(),
      fontSize: 22,
      fontStyle: '700',
      letterSpacing: 4,
      fontFamily: this.labelFont(),
      fill: rgba('#e6e9f0', 0.62),
      listening: false,
      perfectDrawEnabled: false,
    });
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    this.bgLayer.add(t);
  }

  private renderGA(obj: Extract<ChartDoc['objects'][number], { type: 'gaArea' }>): void {
    const color = this.catColor.get(obj.categoryKey) ?? '#6e7bff';
    const pts = obj.points.flatMap((p) => [p.x, p.y]);
    const poly = new Line({
      points: pts,
      closed: true,
      fill: color,
      opacity: 0.22,
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

    const cx = obj.points.reduce((a, p) => a + p.x, 0) / obj.points.length;
    const cy = obj.points.reduce((a, p) => a + p.y, 0) / obj.points.length;
    this.addCentredLabel(this.bgLayer, obj.label, cx, cy - 8, '#e6e9f0', 15, false);
    this.addCentredLabel(this.bgLayer, `cap ${obj.capacity}`, cx, cy + 10, '#8b93a7', 11, false);
  }

  /**
   * A section renders in three coordinated layers driven by the LOD melt:
   *   • a faint outline (the existing near-zoom look, untouched),
   *   • a solid category-mix block that fades in at the block rung, and
   *   • a name + "N LEFT" sublabel.
   * Membership (which seats live inside the outline) + the mix fill + the live
   * availability count are precomputed here (once), not per frame.
   */
  private renderSection(obj: SectionObject): void {
    const pts = obj.outline.flatMap((p) => [p.x, p.y]);
    const centroid = {
      x: obj.outline.reduce((a, p) => a + p.x, 0) / obj.outline.length,
      y: obj.outline.reduce((a, p) => a + p.y, 0) / obj.outline.length,
    };

    // Membership: seats inside the outline, first section (doc order) wins.
    const memberIds: string[] = [];
    const catCounts = new Map<string, number>();
    let free = 0;
    for (const seat of this.seats) {
      if (this.seatSection.has(seat.id)) continue;
      if (!pointInPolygon(seat, obj.outline)) continue;
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
    const outlinePoly = new Line({
      points: pts,
      closed: true,
      stroke: rgba(outlineTint, 0.5),
      strokeWidth: 1.75,
      fill: rgba(outlineTint, 0.08),
      lineJoin: 'round',
      listening: false,
      perfectDrawEnabled: false,
    });
    bgTarget.add(outlinePoly);

    // Solid block fill — melts in at the block rung (opacity driven by the LOD).
    const blockPoly = new Line({
      points: pts,
      closed: true,
      fill: baseFill,
      stroke: rgba('#ffffff', 0.12),
      strokeWidth: 1,
      opacity: 0,
      listening: false,
      perfectDrawEnabled: false,
    });
    bgTarget.add(blockPoly);

    // Faint per-row hint lines (the seats.io "block-with-rows" look): a polyline
    // through each member row's seats, fading in with the block. Lets a section
    // read as SEATING — not a flat colour — at the overview zoom, seats hidden.
    const rowSeats = new Map<string, Array<{ i: number; x: number; y: number }>>();
    for (const id of memberIds) {
      const s = this.seatById.get(id);
      if (!s) continue;
      const i = Number(id.slice(id.lastIndexOf(':') + 1)) || 0;
      (rowSeats.get(s.rowId) ?? rowSeats.set(s.rowId, []).get(s.rowId)!).push({ i, x: s.x, y: s.y });
    }
    const rowLines: Line[] = [];
    for (const arr of rowSeats.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.i - b.i);
      const line = new Line({
        points: arr.flatMap((p) => [p.x, p.y]),
        stroke: rgba('#ffffff', 0.34),
        strokeWidth: SEAT_RADIUS * 0.55,
        lineCap: 'round',
        lineJoin: 'round',
        opacity: 0,
        listening: false,
        perfectDrawEnabled: false,
      });
      rowLines.push(line);
      bgTarget.add(line);
    }

    const nameLabel = new Text({
      x: centroid.x,
      y: centroid.y,
      text: obj.label,
      fontSize: 22,
      fontStyle: '700',
      fontFamily: this.labelFont(),
      fill: '#8b93a7',
      // Dark halo so the label reads over the seat dots at any zoom.
      shadowColor: '#05070c',
      shadowBlur: 6,
      shadowOpacity: 0.9,
      shadowForStrokeEnabled: false,
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
      fill: '#f4f6fb',
      shadowColor: '#05070c',
      shadowBlur: 5,
      shadowOpacity: 0.9,
      shadowForStrokeEnabled: false,
      opacity: 0,
      listening: false,
      perfectDrawEnabled: false,
    });
    subLabel.offsetX(subLabel.width() / 2);
    bgTarget.add(subLabel);

    const sec: SectionRender = {
      id: obj.id,
      label: obj.label,
      outline: obj.outline,
      centroid,
      zone: obj.zone,
      memberIds,
      total: memberIds.length,
      free,
      baseFill,
      outlinePoly,
      blockPoly,
      rowLines,
      nameLabel,
      subLabel,
      elevation,
      liftGroupBg,
      liftGroupSeat,
      sideFaces,
    };
    for (const id of memberIds) this.seatSection.set(id, sec);
    this.refreshSectionFill(sec);
    this.sections.push(sec);
  }

  /** Recompute a section's availability-tinted fill + "N LEFT" (cheap; on status change). */
  private refreshSectionFill(sec: SectionRender): void {
    const sold = sec.total > 0 ? (sec.total - sec.free) / sec.total : 0;
    sec.blockPoly.fill(darken(sec.baseFill, sold * SOLD_DARKEN));
    sec.subLabel.text(t('map.seatsLeft', { count: sec.free }));
    sec.subLabel.offsetX(sec.subLabel.width() / 2);
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

      const label = new Text({
        x: cx,
        y: cy,
        text: z.label.toUpperCase(),
        fontSize: 34,
        fontStyle: '800',
        letterSpacing: 2,
        fontFamily: this.labelFont(),
        fill: z.color ?? '#f2f4f8',
        shadowColor: '#05070c',
        shadowBlur: 10,
        shadowOpacity: 0.95,
        shadowForStrokeEnabled: false,
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
          fill: rgba('#e6e9f0', 0.75),
          opacity: 0,
          listening: false,
          perfectDrawEnabled: false,
        });
        sub.offsetX(sub.width() / 2);
        this.bgLayer.add(sub);
      }
      this.zones.push({ id: z.id, label, sub });
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
    // No zones ⇒ skip the zone rung: sections stay the far rung (graceful).
    if (!this.zones.length) zoneT = 0;

    // Seats melt out as the block fill melts in (coordinated with the bitmap swap).
    this.seatLayer.opacity(1 - blockT);

    // Labels are drawn UPRIGHT (the iso squash is cancelled per-text), so their
    // on-screen size follows the raw stage scale, not the squashed effective one.
    const sx = this.stage.scaleX();
    // Scale-compensate label sizes only when the scale meaningfully changed.
    const rescale = this.lodScale === 0 || Math.abs(scale - this.lodScale) / (this.lodScale || 1) > 0.02;
    if (rescale) this.lodScale = scale;

    for (const sec of this.sections) {
      sec.blockPoly.opacity(BLOCK_FILL_ALPHA * blockT);
      for (const line of sec.rowLines) line.opacity(blockT * (1 - zoneT));
      // Name: faint→bright with blockT, then fades out as zones take over.
      sec.nameLabel.fill(lerpColor('#aab3c5', '#ffffff', blockT));
      sec.nameLabel.opacity(1 - zoneT);
      sec.subLabel.opacity(blockT * (1 - zoneT));
      if (rescale) {
        this.sizeLabel(sec.nameLabel, SECTION_LABEL_PX / sx, sec.centroid.y - SECTION_SUB_PX / sx);
        this.sizeLabel(sec.subLabel, SECTION_SUB_PX / sx, sec.centroid.y + SECTION_LABEL_PX / sx);
      }
    }

    // Fade the big zone labels out as the view tilts into 3D — the raised tiers
    // read clearly on their own, and the overlaid zone text just clutters them.
    const zoneOpacity = zoneT * (1 - this.isoT);
    for (const zone of this.zones) {
      zone.label.opacity(zoneOpacity);
      if (zone.sub) zone.sub.opacity(zoneOpacity);
      if (rescale) {
        const cy = zone.label.y();
        this.sizeLabel(zone.label, ZONE_LABEL_PX / sx, cy);
        if (zone.sub) this.sizeLabel(zone.sub, ZONE_SUB_PX / sx, cy + ZONE_LABEL_PX / sx);
      }
    }
    this.bgLayer.batchDraw();
  }

  /** Set a centred label's world fontSize (for a target screen px) and re-anchor it. */
  private sizeLabel(t: Text, fontSize: number, y: number): void {
    t.fontSize(Math.max(1, fontSize));
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    t.y(y);
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
    const hit = this.sections.find((sec) => pointInPolygon(world, sec.outline));
    return hit ? hit.id : null;
  }

  /** Seat ids belonging to a section (Slice 5 section-summary card). */
  sectionMembers(id: string): string[] {
    return this.sections.find((s) => s.id === id)?.memberIds.slice() ?? [];
  }

  private addCentredLabel(
    layer: Layer,
    text: string,
    x: number,
    y: number,
    fill: string,
    fontSize: number,
    bold: boolean,
  ): void {
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
  }

  // ---- selection ------------------------------------------------------------

  private isSelectable(id: string): boolean {
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
      if (this.selection.size >= this.opts.maxSelection) return; // ignore beyond cap
      this.setSelected(id, true);
      const seat = this.seatById.get(id);
      if (seat) this.opts.onSelect?.(seat);
    }
    this.overlayLayer.batchDraw();
  }

  private setSelected(id: string, on: boolean, silent = false): void {
    const c = this.circleById.get(id);
    if (on) {
      this.selection.add(id);
      const seat = this.seatById.get(id)!;
      const ring = new Circle({
        x: seat.x,
        y: seat.y,
        radius: this.seatR,
        stroke: this.theme.selectionColor ?? DEF_SELECTION,
        strokeWidth: 3,
        listening: false,
        perfectDrawEnabled: false,
        shadowForStrokeEnabled: false,
      });
      this.selectionRings.set(id, ring);
      this.overlayLayer.add(ring);
    } else {
      this.selection.delete(id);
      const ring = this.selectionRings.get(id);
      ring?.destroy();
      this.selectionRings.delete(id);
    }
    if (c) {
      this.paintSeat(c, id);
      if (!silent && !this.cached) this.seatLayer.batchDraw();
    }
  }

  // ---- interaction ----------------------------------------------------------

  private wireInteraction(): void {
    this.seatLayer.on('click tap', (e: KonvaEventObject<Event>) => {
      if (this.moved > 8) return; // it was a pan/pinch, not a tap
      const id = seatIdOf(e.target);
      if (!id) return;
      // In the 3D all-floors overview, tapping a seat enters its deck in 2D
      // rather than selecting (seat picking happens on the flat floor map).
      if (this.stacked && this.opts.onDeckTap) {
        const floorId = this.objectFloor.get(this.seatById.get(id)?.rowId ?? '');
        if (floorId) { this.opts.onDeckTap(floorId); return; }
      }
      this.toggleSeat(id);
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
    this.stage.on('click tap', () => {
      if (!this.cached || this.moved > 8) return;
      const pointer = this.stage.getPointerPosition();
      if (!pointer) return;
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
        const hit = this.sections.find((sn) => pointInPolygon(world, sn.outline));
        if (hit) {
          if (this.opts.onSectionTap) this.opts.onSectionTap(hit.id);
          else this.focusRegion(hit.id);
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
    this.pointers.set(e.pointerId, this.toLocal(e));
    if (this.pointers.size === 1) {
      this.moved = 0;
      this.panLast = this.toLocal(e);
      this.pinch = null;
    } else if (this.pointers.size === 2) {
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
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const p = this.toLocal(e);
    const prev = this.pointers.get(e.pointerId)!;
    this.moved += Math.hypot(p.x - prev.x, p.y - prev.y);
    this.pointers.set(e.pointerId, p);

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
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 1) {
      // pinch → single finger: continue as a pan without jumping
      this.panLast = [...this.pointers.values()][0];
    }
    if (this.pointers.size === 0) {
      this.panLast = null;
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
  private zoomToBounds(b: { x: number; y: number; width: number; height: number }): void {
    const w = this.stage.width();
    const h = this.stage.height();
    const { min, max } = this.zoomBounds();
    const margin = 1.12;
    const scale = clamp(Math.min(w / (b.width * margin), h / (b.height * margin)), min, max);
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
   * rect — the Slice 5 "glide in". Pan+zoom tween over ~450ms easeInOutCubic; the
   * melt/LOD rides the camera every frame. `prefers-reduced-motion` (or
   * `opts.animate === false`) snaps via zoomToBounds. A grab (pointer-down) or a
   * newer glide cancels an in-flight one.
   */
  focusRegion(
    target: string | { x: number; y: number; width: number; height: number },
    opts?: { animate?: boolean },
  ): void {
    const b =
      typeof target === 'string'
        ? (() => {
            const sec = this.sections.find((s) => s.id === target);
            return sec ? polyBounds(sec.outline) : null;
          })()
        : target;
    if (!b) return;
    this.cancelGlide();
    if (opts?.animate === false || this.reducedMotion) {
      this.zoomToBounds(b);
      return;
    }
    const w = this.stage.width();
    const h = this.stage.height();
    const { min, max } = this.zoomBounds();
    const margin = 1.12;
    const toScale = clamp(Math.min(w / (b.width * margin), h / (b.height * margin)), min, max);
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
    const DUR = 450;
    const step = (now: number): void => {
      if (this.destroyed) { this.glideRaf = 0; return; }
      const raw = Math.min(1, (now - start) / DUR);
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

  /** Jump the camera to a rung's zoom band, centred on the chart (glided). */
  setRung(rung: LodRung): void {
    if (rung === 'zones') {
      this.cancelGlide();
      this.zoomToFit();
      return;
    }
    const target =
      rung === 'sections'
        ? (SECTION_PROMINENT_SCALE + CACHE_THRESHOLD) / 2
        : Math.max(SEAT_LEGIBLE_SCALE * 1.1, CACHE_THRESHOLD * 1.3);
    const w = this.stage.width();
    const h = this.stage.height();
    const cx = this.bounds.x + this.bounds.width / 2;
    const cy = this.bounds.y + this.bounds.height / 2;
    const bw = w / (target * 1.12);
    const bh = h / (target * 1.12);
    this.focusRegion({ x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh });
  }

  /** Recompute LOD (cache/labels) after any pan/zoom settles. */
  private afterViewChange(): void {
    this.updateLOD();
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
    if (this.hasSections) this.applySectionLod(scale);
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

  private cacheSeatLayer(): void {
    // Cache at ~screen resolution: bitmap px ≈ on-screen px, so a huge chart in
    // chart-units doesn't blow up into a gigapixel canvas when zoomed out.
    const pr = clamp(this.stage.scaleX() * this.dpr, 0.15, 2);
    this.seatLayer.clearCache();
    this.seatLayer.cache({ pixelRatio: pr });
    this.seatLayer.listening(false);
    this.cached = true;
    this.seatLayer.batchDraw();
  }

  private updateLabels(): void {
    const show = this.effScale() > LABEL_SCALE;
    this.labelGroup.destroyChildren();
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
      if (seat.x < x0 || seat.x > x1 || seat.y < y0 || seat.y > y1) continue;
      const t = new Text({
        x: seat.x,
        y: seat.y,
        text: seat.label,
        fontSize: 7,
        fontStyle: '600',
        fontFamily: this.labelFont(),
        fill: this.theme.seatLabelColor ?? DEF_SEAT_LABEL,
        listening: false,
        perfectDrawEnabled: false,
      });
      // Auto-fit: shrink long labels (e.g. "T10-10") so they never spill out of
      // the seat circle. Down to a legibility floor; below that the label is
      // dropped rather than rendered as an unreadable speck.
      const maxW = this.seatR * 2 - 3;
      if (t.width() > maxW) t.fontSize(Math.max(4, (7 * maxW) / t.width()));
      if (t.fontSize() < 4.2) { t.destroy(); continue; }
      t.offsetX(t.width() / 2);
      t.offsetY(t.height() / 2);
      this.labelGroup.add(t);
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
