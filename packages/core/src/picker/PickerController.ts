/**
 * PickerController — the single, framework-agnostic buyer-picker core.
 *
 * Consolidates the transport + booking logic that was copy-pasted across
 * sdk/src/SeatingChart.ts, src/pages/PublicEventPage.tsx and PickerPage.tsx:
 * fetch the published chart, mount the Konva renderer, seed statuses from a REST
 * snapshot, keep them live over a WebSocket (reconnect w/ backoff, re-snapshot on
 * every open), and run the hold → book state machine (best-available, hold reuse,
 * per-label partial release, 409 semantics, server-authoritative hold expiry).
 *
 * The SDK, the live buyer page, and the demo picker all drive this one class;
 * presentation (confirm card, legend, cart, etc.) lives in the consumers.
 *
 * Transport is injected (PickerTransport) so the SDK can use its CORS-trivial
 * PubApi while the dashboard uses an adapter over src/lib/api.ts.
 */
import { createRenderer } from '../engine/SeatmapRenderer';
import { allObjects, expandChart } from '../core/layout';
import { applyHidden, computeSections } from '../core/sections';
import { strandedSingles } from '../core/orphans';
import { pickBestAvailable } from '../core/bestAvailable';
import { t } from '../i18n';
import type {
  AccessibilityType,
  CategoryTier,
  ChartDoc,
  ChartObject,
  ExpandedSeat,
  ISeatmapRenderer,
  LodRung,
  RendererCallbacks,
  RendererViewMode,
  SeatCommercialAttributes,
  SeatStatus,
  SectionObject,
} from '../core/types';
import { gaAreasOf, gaUnitLabels } from '../core/ga';
import {
  groupedTableInventory,
  type GroupedTableInventoryUnit,
} from '../core/tableInventory';

const DEFAULT_MAX_SELECTION = 10;
const MAX_BACKOFF_MS = 15_000;

export interface PickerSeat {
  id: string;
  label: string;
  /** Buyer-facing label (row `displayLabel` applied). Falls back to `label`;
   *  never use for booking — `label` is the inventory/booking identity. */
  displayLabel?: string;
  /** Buyer-facing object type word authored in Designer. Pure presentation. */
  displayType?: string;
  /** @deprecated Use `displayType`; retained for source compatibility. */
  rowType?: string;
  /** Stable parent chart-object id (row/table/booth), separate from seat id. */
  objectId?: string;
  /** Buyer-facing spatial context shared by selection, hold, and hover callbacks. */
  sectionLabel?: string;
  rowLabel?: string;
  seatNumber?: string;
  categoryKey: string;
  /** Price for the chosen tier when the category has tiers, else the base price. */
  price: number;
  /** Ticket tiers the seat's category offers (Adult/Child/…); absent when none. */
  tiers?: CategoryTier[];
  /** The chosen tier's id — defaults to the first tier; absent when no tiers. */
  tierId?: string;
  /** Commercial selling/view attributes (restricted/obstructed view, premium,
   *  note) resolved for this seat; absent when the seat carries none. Lets the
   *  buyer cart + confirm surface flag limited-view/premium seats. */
  commercial?: SeatCommercialAttributes;
  /** Accessibility semantics exposed to SDK callbacks and buyer summaries. */
  accessibility?: AccessibilityType[];
  /** Explicit physical wheelchair chair/bay distinction. */
  wheelchairSpaceType?: 'seat-present' | 'no-seat';
  /** Physical/bookable source kind; booking identity remains `label`. */
  objectType?: 'seat' | 'booth' | 'table';
  /** Grouped-table booking contract; absent for normal chair inventory. */
  bookingMode?: 'whole' | 'variable';
  /** Guest quantity represented by this one atomic table line. */
  quantity?: number;
  capacity?: number;
  minOccupancy?: number;
  maxOccupancy?: number;
}

/** Accessible quantity/confirmation payload for one model-2 table selection. */
export interface TableSelectionDetails extends PickerSeat {
  objectType: 'table';
  bookingMode: 'whole' | 'variable';
  quantity: number;
  capacity: number;
  minOccupancy: number;
  maxOccupancy: number;
  physicalSeatIds: string[];
}

/**
 * Rich hover payload for seat tooltips — the PickerSeat plus everything a
 * buyer-facing popover needs: category label + swatch color, live status and
 * the chart currency. Emitted by `onSeatHover` (null on hover-out).
 */
export interface SeatHoverDetails extends PickerSeat {
  categoryLabel: string;
  categoryColor: string;
  status: SeatStatus;
  currency: string;
}

export interface PickerGAArea {
  id: string;
  /** Stable technical/inventory prefix. */
  label: string;
  /** Buyer-facing area name and type; absent fields use UI defaults. */
  displayLabel?: string;
  displayType?: string;
  capacity: number;
  available: number;
  categoryKey: string;
  price: number;
  currency: string;
  tiers?: CategoryTier[];
}

export interface HoldConflict {
  label: string;
  status: string;
}

/** An open hold — its id, the labels it covers, and the server's expiry time (ms epoch). */
export interface HoldInfo {
  holdId: string;
  labels: string[];
  expiresAt: number;
  /** The held seats with their chosen ticket tier — what the host books against. */
  seats: PickerSeat[];
  /** Server-authoritative commercial line items, including GA units and resolved prices. */
  items?: HoldServerItem[];
}

/** One category's slice of a section (dot + price + count) for the summary card. */
export interface SectionCategory {
  key: string;
  label: string;
  color: string;
  price: number;
  count: number;
}

/**
 * Big-venue section-summary — everything the tapped-section card renders: name,
 * its zone, live seats-left, price range, and the per-category breakdown.
 * Computed from the renderer's spatial section membership (Slice 5).
 */
export interface SectionSummary {
  id: string;
  /** Buyer-facing section name (`displayLabel` when set, else the inventory label). */
  label: string;
  /** Zone label (from ChartDoc.zones); '' when the section has no zone. */
  zoneLabel: string;
  /** Buyer-facing entrance/door hint ("Entrance X"); absent when unset. */
  entrance?: string;
  /** Mix/section colour for the card's dot (section.color → zone colour → dominant category). */
  color: string;
  /** Free member seats right now. */
  seatsLeft: number;
  priceMin: number;
  priceMax: number;
  /** Per-category breakdown, cheapest first. */
  categories: SectionCategory[];
}

interface HoldResponse {
  holdId: string;
  expiresAt: number;
  items?: HoldServerItem[];
}
interface ResumeHoldResponse extends HoldResponse {
  items: HoldServerItem[];
}
export interface HoldServerItem {
  label: string;
  objectId: string;
  objectType: 'seat' | 'booth' | 'ga' | 'table';
  categoryKey: string;
  tierId: string | null;
  unitPrice: number;
  currency: string;
  quantity?: number;
}
export interface HoldSelectionRequest { label: string; tierId?: string | null; quantity?: number }
interface BestAvailableResponse extends HoldResponse {
  labels: string[];
}

/** Swappable public-surface transport (SDK PubApi or a dashboard `api.pub.*` adapter). */
export interface PickerTransport {
  chart(key: string): Promise<{
    doc: ChartDoc;
    event: { key: string; name: string; salesClosed?: boolean; venue?: string | null; startsAt?: number | null; currency?: string; mode?: string; inventoryModelVersion?: 1 | 2 };
  }>;
  objects(key: string): Promise<{ seats: Record<string, string>; hidden?: string[]; closed?: string[] }>;
  hold(key: string, selections: HoldSelectionRequest[], ttlMs?: number, replaceHoldId?: string): Promise<HoldResponse>;
  bestAvailable(key: string, qty: number, categoryKey?: string, zoneId?: string): Promise<BestAvailableResponse>;
  release(key: string, labels: string[], holdId: string): Promise<unknown>;
  /** Optional capability-style lookup used to restore an active browser hold. */
  resume?(key: string, holdId: string): Promise<ResumeHoldResponse>;
  /** Optional — the SDK omits booking (it hands the holdId to the host page). */
  book?(key: string, labels: string[], holdId: string, bookingRef: string): Promise<unknown>;
  /** Optional (P4) — push an active hold's expiry out ("need more time?"). */
  extend?(key: string, holdId: string, ttlMs?: number): Promise<{ holdId: string; expiresAt: number; extends?: number }>;
  socketUrl(key: string): string;
}

export interface PickerCallbacks extends RendererCallbacks {
  /** Selection changed (manual clicks or a server best-available pick). */
  onSelectionChange?: (seats: PickerSeat[]) => void;
  /** A grouped table was selected and needs buyer confirmation/guest quantity. */
  onTableSelectionRequest?: (table: TableSelectionDetails) => void;
  /** A hold opened (manual hold or best-available). */
  onHold?: (hold: HoldInfo) => void;
  /** A prior active hold was restored from its opaque hold id. */
  onHoldRestored?: (hold: HoldInfo) => void;
  /** The open hold expired server-side (the controller has already released it). */
  onHoldExpired?: () => void;
  /** A booking completed with this ref. */
  onBook?: (bookingRef: string) => void;
  /** Any live seat-status change arrived (delta or snapshot) — e.g. to recount "N left". */
  onStatusChange?: () => void;
  /**
   * Mouse hover moved onto a seat (null on hover-out) — the seat enriched with
   * category label/color, resolved price and live status, ready for a tooltip.
   * Fires alongside the raw renderer-level `onHover`.
   */
  onSeatHover?: (details: SeatHoverDetails | null) => void;
  /** The server declared the event closed (a 409 event_closed). */
  onSalesClosed?: () => void;
  /**
   * A section block was tapped at the far/zone rung — the controller has glided
   * the camera in and passes the computed summary (or null when cleared, e.g.
   * overview() / zoom-to-zones) so the host can show/hide the summary card.
   */
  onSectionFocus?: (summary: SectionSummary | null) => void;
  /** A deck was tapped in the 3D all-floors overview — host enters that floor in 2D. */
  onDeckTap?: (floorId: string) => void;
  /**
   * Non-blocking selection advice (localized): currently the orphan-seat hint —
   * the selection would strand a single free seat between unavailable
   * neighbors. `null` clears a previously shown hint. Never prevents anything.
   */
  onHint?: (message: string | null) => void;
  onError?: (err: unknown) => void;
}

export interface PickerOptions extends PickerCallbacks {
  transport: PickerTransport;
  eventKey: string;
  maxSelection?: number;
  /** Renderer confirm-card mode (host shows a confirm popover instead of instant cart add). */
  confirmSelection?: boolean;
  /** ISO 4217 currency for on-map prices (default from money.DEFAULT_CURRENCY). */
  currency?: string;
  /** Flash a pulse when a seat we didn't touch goes free→taken (live-activity cue). */
  flashOnLiveChange?: boolean;
  /** Start in colorblind-safe rendering (Okabe-Ito hues + hollow booked seats). */
  colorblindSafe?: boolean;
  /**
   * Keep painting seat-status deltas even while the tab is hidden/backgrounded.
   *
   * Default FALSE — the buyer widget stays efficient: it lets rAF stay paused
   * while hidden and does a single synchronous catch-up repaint on regain (the
   * visibilitychange handler resnapshots + forceDraw()s). Set TRUE only for an
   * always-live surface — the future organizer control-room board — where a
   * backgrounded monitor must keep repainting; then each delta calls
   * renderer.forceDraw() when the tab is hidden. Purely a paint hint; enforcement
   * and the WS protocol are identical either way.
   */
  keepLiveWhileHidden?: boolean;
}

/** Read `status`/`conflicts`/`reason` off any thrown error without importing a specific ApiError. */
function errInfo(err: unknown): { status?: number; conflicts?: HoldConflict[]; reason?: string } {
  const e = (err ?? {}) as { status?: number; conflicts?: HoldConflict[]; reason?: string };
  return { status: e.status, conflicts: e.conflicts, reason: e.reason };
}

/** DO seat status → renderer status ('blocked' has no renderer analogue → 'not_for_sale'). */
function mapStatus(s: string): SeatStatus {
  if (s === 'blocked') return 'not_for_sale';
  if (s === 'held' || s === 'booked' || s === 'free' || s === 'not_for_sale') return s;
  return 'free';
}

export class PickerController {
  private readonly opts: PickerOptions;
  private readonly api: PickerTransport;
  private readonly key: string;
  private maxSelection: number;

  private renderer: ISeatmapRenderer | null = null;
  private _doc: ChartDoc | null = null;
  /** Section/zone ids hidden from buyers this event (3.3) — seats vanish, not grey. */
  private hidden = new Set<string>();
  /** Section/zone ids in the `closed` event-state (Phase 2) — seats stay, greyed
   *  + not pickable. Kept separate from `hidden` (which strips them). */
  private closedSections = new Set<string>();

  /** label ⇄ id maps — backend speaks labels, the engine speaks ids. */
  private labelToId = new Map<string, string>();
  private labelToSeat = new Map<string, ExpandedSeat>();
  /** seatId → chosen ticket-tier id (absent ⇒ the category's first/default tier). */
  private seatTiers = new Map<string, string>();
  /** id → seat, for the section-summary breakdown (renderer members are ids). */
  private seatById = new Map<string, ExpandedSeat>();
  /** id → buyer-facing spatial metadata used by every tooltip/confirm surface. */
  private seatContext = new Map<string, {
    objectId: string;
    objectType: 'seat' | 'booth' | 'table';
    sectionLabel?: string;
    rowLabel?: string;
    seatNumber?: string;
    displayType?: string;
    /** @deprecated compatibility alias for older tooltip consumers. */
    rowType?: string;
  }>();
  private allIds: string[] = [];
  /** Model-2 tables are one booking unit whose chairs remain renderer geometry. */
  private groupedTablesByObject = new Map<string, GroupedTableInventoryUnit>();
  private groupedTablesByLabel = new Map<string, GroupedTableInventoryUnit>();
  private groupedTableBySeatId = new Map<string, GroupedTableInventoryUnit>();
  private tableQuantities = new Map<string, number>();
  /** Variable quantity is a buyer contract, never an inferred default. */
  private confirmedVariableTables = new Set<string>();
  private groupedSelectionOverhead = 0;

  // realtime socket
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  /** Bound visibilitychange listener (buyer catch-up on tab regain). Kept on the
   *  instance so destroy() can detach it; null when not attached (guards double
   *  mounts / non-DOM environments). */
  private onVisibilityChange: (() => void) | null = null;

  // hold state
  private hold_: HoldInfo | null = null;
  private liveStatuses = new Map<string, string>();
  private currency = 'USD';
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PickerOptions) {
    this.opts = options;
    this.api = options.transport;
    this.key = options.eventKey;
    this.maxSelection = options.maxSelection ?? DEFAULT_MAX_SELECTION;
  }

  get doc(): ChartDoc | null {
    return this._doc;
  }

  /** The chart with hidden sections' seats removed — what buyers actually see. */
  private visibleDoc(): ChartDoc {
    return this._doc ? applyHidden(this._doc, this.hidden) : ({ objects: [] } as unknown as ChartDoc);
  }

  /** Adopt a new hidden set; rebuild the visible chart only if it differs. */
  private syncHidden(ids: string[]): boolean {
    const next = ids.filter((x): x is string => typeof x === 'string');
    if (next.length === this.hidden.size && next.every((id) => this.hidden.has(id))) return false;
    this.hidden = new Set(next);
    this.renderer?.setChart(this.visibleDoc());
    return true;
  }

  /** Adopt a new closed-section set; restyle (grey + non-pickable) if it differs.
   *  Cheap restyle — no chart rebuild — so mid-sale open/close repaints live. */
  private syncClosed(ids: string[] | undefined): boolean {
    const next = (ids ?? []).filter((x): x is string => typeof x === 'string');
    if (next.length === this.closedSections.size && next.every((id) => this.closedSections.has(id))) return false;
    this.closedSections = new Set(next);
    this.renderer?.setClosedSections?.(next);
    return true;
  }

  /** Whether a section is currently in the `closed` state (card must not open). */
  isSectionClosed(id: string): boolean {
    return this.closedSections.has(id);
  }
  currentHold(): HoldInfo | null {
    return this.hold_;
  }
  getRenderer(): ISeatmapRenderer | null {
    return this.renderer;
  }
  seatByLabel(label: string): ExpandedSeat | undefined {
    return this.labelToSeat.get(label);
  }
  idForLabel(label: string): string | undefined {
    return this.labelToId.get(label);
  }

  private idsForLabel(label: string): string[] {
    const table = this.groupedTablesByLabel.get(label);
    if (table) return table.chairs.map((chair) => chair.id);
    const id = this.labelToId.get(label);
    return id ? [id] : [];
  }

  private idsForLabels(labels: Iterable<string>): string[] {
    return [...new Set([...labels].flatMap((label) => this.idsForLabel(label)))];
  }

  /** Resolve a physical chair id (or table inventory label) to its table unit. */
  tableSelection(seatIdOrLabel: string): TableSelectionDetails | null {
    const group = this.groupedTableBySeatId.get(seatIdOrLabel)
      ?? this.groupedTablesByLabel.get(seatIdOrLabel);
    return group ? this.toTableSeat(group) : null;
  }

  /** Fetch chart, build label maps, mount the renderer, seed statuses, go live. */
  async render(host: HTMLDivElement): Promise<{
    doc: ChartDoc;
    salesClosed: boolean;
    eventName: string;
    venue?: string | null;
    startsAt?: number | null;
    currency?: string;
    /** 'test' ⇒ sandbox event (hosts show a TEST MODE ribbon). */
    mode?: string;
  } | null> {
    if (this.renderer) return null; // already rendered — never mount twice on one controller
    this.closed = false;
    let res;
    try {
      res = await this.api.chart(this.key);
    } catch (err) {
      this.emitError(err);
      return null;
    }
    // destroy() may have run while the chart fetch was in flight (StrictMode
    // double-mount, or a fast key change) — bail before mounting anything.
    if (this.closed) return null;
    this._doc = res.doc;

    try {
      const groups = groupedTableInventory(
        res.doc,
        res.event.inventoryModelVersion === 2 ? 2 : 1,
      );
      this.groupedTablesByObject = new Map(groups.map((group) => [group.objectId, group]));
      this.groupedTablesByLabel = new Map(groups.map((group) => [group.label, group]));
      this.groupedTableBySeatId = new Map(
        groups.flatMap((group) => group.chairs.map((chair) => [chair.id, group] as const)),
      );
      this.tableQuantities = new Map(groups.map((group) => [
        group.label,
        group.mode === 'whole' ? group.capacity : group.minOccupancy,
      ]));
      this.confirmedVariableTables = new Set();
      this.groupedSelectionOverhead = groups.reduce(
        (sum, group) => sum + Math.max(0, group.chairs.length - 1),
        0,
      );
    } catch (err) {
      // A model-2 event with an invalid grouping contract is not safe to sell.
      // Fail before mounting the interactive renderer instead of falling back
      // to per-chair labels that the server does not own.
      this.emitError(err);
      return null;
    }

    this.labelToId = new Map();
    this.labelToSeat = new Map();
    this.seatById = new Map();
    this.seatContext = new Map();
    this.allIds = [];
    const chartObjects = new Map(allObjects(res.doc).map((object) => [object.id, object] as const));
    const membership = computeSections(res.doc);
    const sectionLabels = new Map(
      [...membership.sections, ...(membership.ungrouped ? [membership.ungrouped] : [])].map((section) => [section.id, section.label] as const),
    );
    for (const s of expandChart(res.doc)) {
      this.labelToId.set(s.label, s.id);
      this.labelToSeat.set(s.label, s);
      this.seatById.set(s.id, s);
      this.allIds.push(s.id);
      const source = chartObjects.get(s.rowId);
      const sourceLabel = source && 'label' in source && typeof source.label === 'string' ? source.label : undefined;
      const logicalRow = source?.type === 'row' ? source.segmentedRow : undefined;
      // Buyer-facing row name honours the designer's row `displayLabel`; inventory
      // `label` stays the booking identity used everywhere seats are held/booked.
      const sourceDisplayLabel = logicalRow?.displayLabel
        ?? (source && 'displayLabel' in source && typeof source.displayLabel === 'string' && source.displayLabel
          ? source.displayLabel
          : sourceLabel);
      const groupedTable = this.groupedTablesByObject.get(s.rowId);
      const objectType = source?.type === 'table' ? 'table' : source?.type === 'booth' ? 'booth' : 'seat';
      const rowLabel = sourceDisplayLabel;
      // Buyer-facing type word override (seats.io "Displayed type") — replaces the
      // default "Row" in tooltip/confirm/cart for rows and tables when set.
      const rowType = logicalRow?.displayType?.trim()
        || (source && 'displayType' in source && typeof source.displayType === 'string' && source.displayType.trim()
          ? source.displayType.trim()
          : undefined);
      // Seat number is read off the buyer-facing seat label so a renamed row shows
      // the buyer copy; both labels share the same `${prefix}-${number}` suffix.
      const visibleSeatLabel = s.displayLabel ?? s.label;
      const labelParts = visibleSeatLabel.split('-');
      const seatNumber = groupedTable
        ? undefined
        : s.kind === 'booth'
          ? undefined
        : sourceDisplayLabel && visibleSeatLabel.startsWith(`${sourceDisplayLabel}-`)
        ? visibleSeatLabel.slice(sourceDisplayLabel.length + 1)
        : labelParts[labelParts.length - 1] ?? visibleSeatLabel;
      this.seatContext.set(s.id, {
        objectId: s.rowId,
        objectType,
        sectionLabel: sectionLabels.get(membership.objectToSection.get(s.rowId) ?? ''),
        rowLabel,
        seatNumber,
        ...(rowType ? { displayType: rowType, rowType } : {}),
      });
    }
    // The backend speaks the table label, while the renderer still speaks chair
    // ids. Point the atomic label at a stable representative chair; every
    // status/selection mutation expands through idsForLabel() below.
    for (const group of this.groupedTablesByLabel.values()) {
      const representative = group.chairs[0];
      if (!representative) continue;
      this.labelToId.set(group.label, representative.id);
      this.labelToSeat.set(group.label, representative);
    }

    // The organizer's currency travels with the chart payload; it wins over any
    // option passed at construction (the SDK host may not know it up front).
    const currency = res.event.currency ?? this.opts.currency;
    this.currency = currency ?? 'USD';
    const renderer = createRenderer(host, {
      // Group chairs are selected together for paint, but count as one logical
      // inventory line. The controller enforces the guest-weighted cap.
      maxSelection: this.rendererSelectionCap(),
      confirmSelection: this.opts.confirmSelection,
      currency,
      onSelect: (seat) => {
        this.handleRendererSelect(seat);
      },
      onDeselect: (seat) => {
        this.handleRendererDeselect(seat);
      },
      onSelectionLimit: this.opts.onSelectionLimit,
      onHover: (seat) => {
        this.opts.onHover?.(seat);
        if (this.opts.onSeatHover) this.opts.onSeatHover(seat ? this.describeSeat(seat) : null);
      },
      onFocusSeat: this.opts.onFocusSeat,
      onViewChange: this.opts.onViewChange,
      onGAClick: this.opts.onGAClick,
      // Section tap at the far/zone rung → glide in + surface the summary card.
      onSectionTap: (id) => this.handleSectionTap(id),
      onDeckTap: (floorId) => this.handleDeckTap(floorId),
      onFps: this.opts.onFps,
    });
    if (this.closed) {
      renderer.destroy(); // destroyed during createRenderer — don't leak the stage
      return null;
    }
    this.renderer = renderer;

    // Pull live state (seat statuses + hidden section/zone ids) BEFORE the first
    // paint so hidden sections never flash in. Falls back to the raw chart if the
    // snapshot is briefly unavailable — the WS re-snapshot then reconciles.
    let seats: Record<string, string> | null = null;
    let closedIds: string[] = [];
    try {
      const objs = await this.api.objects(this.key);
      this.hidden = new Set(objs.hidden ?? []);
      closedIds = (objs.closed ?? []).filter((x): x is string => typeof x === 'string');
      seats = objs.seats;
    } catch {
      /* transient — connect()'s onopen re-snapshots */
    }
    if (this.closed) {
      renderer.destroy();
      this.renderer = null;
      return null;
    }
    renderer.setChart(this.visibleDoc());
    if (this.opts.colorblindSafe) renderer.setColorblindSafe?.(true);
    // Closed sections are applied AFTER setChart (which resets state) so their
    // grey + non-pickable treatment lands on the first paint, no flash.
    this.closedSections = new Set(closedIds);
    if (closedIds.length) renderer.setClosedSections?.(closedIds);
    if (seats) this.applySeatsMap(seats);
    this.attachVisibilityListener();
    this.connect();
    return {
      doc: res.doc,
      salesClosed: !!res.event.salesClosed,
      eventName: res.event.name,
      venue: res.event.venue,
      startsAt: res.event.startsAt,
      currency,
      // 'test' ⇒ sandbox event: hosts render a TEST MODE ribbon (Phase 11).
      mode: res.event.mode ?? 'live',
    };
  }

  // ---- selection ------------------------------------------------------------

  getSelection(): PickerSeat[] {
    if (!this.renderer) return [];
    const out: PickerSeat[] = [];
    const grouped = new Set<string>();
    for (const seat of this.renderer.getSelection()) {
      const table = this.groupedTableBySeatId.get(seat.id);
      if (table) {
        if (!grouped.has(table.label)) {
          grouped.add(table.label);
          out.push(this.toTableSeat(table));
        }
      } else {
        out.push(this.toSeat(seat));
      }
    }
    return out;
  }
  /** Enriched metadata for a seat confirmation card or tooltip. */
  seatDetails(seatId: string): SeatHoverDetails | null {
    const seat = this.seatById.get(seatId);
    return seat ? this.describeSeat(seat) : null;
  }
  clearSelection(): void {
    this.renderer?.clearSelection();
    this.resetUnheldTableQuantities();
    this.emitSelectionChange();
  }
  deselect(ids: string[]): void {
    const expanded = new Set<string>();
    for (const id of ids) {
      const table = this.groupedTableBySeatId.get(id) ?? this.groupedTablesByLabel.get(id);
      if (table) {
        table.chairs.forEach((chair) => expanded.add(chair.id));
        if (!this.hold_?.labels.includes(table.label)) {
          this.tableQuantities.set(
            table.label,
            table.mode === 'whole' ? table.capacity : table.minOccupancy,
          );
          if (table.mode === 'variable') this.confirmedVariableTables.delete(table.label);
        }
      } else expanded.add(id);
    }
    this.renderer?.deselect([...expanded]);
    this.emitSelectionChange();
  }
  setMaxSelection(maxSelection: number): void {
    this.maxSelection = Math.max(0, Math.floor(maxSelection));
    this.renderer?.setMaxSelection?.(this.rendererSelectionCap());
  }
  select(ids: string[]): PickerSeat[] {
    const before = new Set(this.getSelection().map((seat) => seat.label));
    const expanded = new Set<string>();
    for (const id of ids) {
      const table = this.groupedTableBySeatId.get(id) ?? this.groupedTablesByLabel.get(id);
      if (table) table.chairs.forEach((chair) => expanded.add(chair.id));
      else expanded.add(id);
    }
    this.renderer?.select?.([...expanded]);
    if (this.selectionGuestCount() > this.maxSelection) {
      this.renderer?.deselect([...expanded]);
      this.opts.onSelectionLimit?.(this.maxSelection);
      return [];
    }
    const added = this.getSelection().filter((seat) => !before.has(seat.label));
    if (added.length) this.emitSelectionChange();
    return added;
  }

  /** Confirm/update the guest quantity for a selected variable table. */
  setTableQuantity(label: string, quantity: number): boolean {
    const table = this.groupedTablesByLabel.get(label);
    if (!table) return false;
    const q = table.mode === 'whole' ? table.capacity : Math.floor(quantity);
    if (!Number.isInteger(q) || q < table.minOccupancy || q > table.maxOccupancy) return false;
    const previous = this.tableQuantities.get(label) ?? table.minOccupancy;
    this.tableQuantities.set(label, q);
    if (this.selectionGuestCount() > this.maxSelection) {
      this.tableQuantities.set(label, previous);
      this.opts.onSelectionLimit?.(this.maxSelection);
      return false;
    }
    if (table.mode === 'variable') this.confirmedVariableTables.add(label);
    this.emitSelectionChange();
    return true;
  }

  /** Atomically replace an active variable-table hold with a new guest count. */
  async replaceTableQuantity(label: string, quantity: number): Promise<HoldInfo | null> {
    const table = this.groupedTablesByLabel.get(label);
    const hold = this.hold_;
    if (!table || table.mode !== 'variable' || !hold?.labels.includes(label)) return null;
    const q = Math.floor(quantity);
    if (!Number.isInteger(q) || q < table.minOccupancy || q > table.maxOccupancy) return null;
    const otherGuests = (hold.items ?? [])
      .filter((item) => item.label !== label)
      .reduce((sum, item) => sum + (item.quantity ?? 1), 0);
    if (otherGuests + q > this.maxSelection) {
      this.opts.onSelectionLimit?.(this.maxSelection);
      return null;
    }
    const selections: HoldSelectionRequest[] = (hold.items ?? []).map((item) => ({
      label: item.label,
      tierId: item.tierId,
      quantity: item.label === label ? q : item.quantity,
    }));
    if (!selections.some((item) => item.label === label)) return null;
    const result = await this.api.hold(this.key, selections, undefined, hold.holdId);
    this.tableQuantities.set(label, q);
    this.setHold({
      holdId: result.holdId,
      labels: selections.map((item) => item.label),
      expiresAt: result.expiresAt,
      items: result.items,
    });
    return this.hold_;
  }

  private rendererSelectionCap(): number {
    return this.maxSelection + this.groupedSelectionOverhead;
  }

  private selectionGuestCount(): number {
    return this.getSelection().reduce((sum, seat) => sum + (seat.quantity ?? 1), 0);
  }

  private handleRendererSelect(seat: ExpandedSeat): void {
    const table = this.groupedTableBySeatId.get(seat.id);
    if (table) {
      if (this.selectionGuestCount() > this.maxSelection) {
        this.renderer?.deselect(table.chairs.map((chair) => chair.id));
        this.opts.onSelectionLimit?.(this.maxSelection);
        this.emitSelectionChange();
        return;
      }
      // One click paints every chair as selected; the public selection remains
      // one table line through getSelection(). Programmatic select is silent.
      this.renderer?.select?.(table.chairs.map((chair) => chair.id));
      this.opts.onSelect?.(table.chairs[0] ?? seat);
      this.opts.onTableSelectionRequest?.(this.toTableSeat(table));
      this.emitSelectionChange();
      return;
    }
    if (this.selectionGuestCount() > this.maxSelection) {
      this.renderer?.deselect([seat.id]);
      this.opts.onSelectionLimit?.(this.maxSelection);
      this.emitSelectionChange();
      return;
    }
    this.opts.onSelect?.(seat);
    this.emitSelectionChange();
  }

  private handleRendererDeselect(seat: ExpandedSeat): void {
    const table = this.groupedTableBySeatId.get(seat.id);
    if (table) {
      this.renderer?.deselect(table.chairs.map((chair) => chair.id));
      if (!this.hold_?.labels.includes(table.label)) {
        this.tableQuantities.set(
          table.label,
          table.mode === 'whole' ? table.capacity : table.minOccupancy,
        );
        if (table.mode === 'variable') this.confirmedVariableTables.delete(table.label);
      }
      this.opts.onDeselect?.(table.chairs[0] ?? seat);
    } else {
      this.opts.onDeselect?.(seat);
    }
    this.emitSelectionChange();
  }

  private resetUnheldTableQuantities(): void {
    for (const table of this.groupedTablesByLabel.values()) {
      if (this.hold_?.labels.includes(table.label)) continue;
      this.tableQuantities.set(
        table.label,
        table.mode === 'whole' ? table.capacity : table.minOccupancy,
      );
      if (table.mode === 'variable') this.confirmedVariableTables.delete(table.label);
    }
  }

  private resetTableQuantitiesForLabels(labels: Iterable<string>): void {
    for (const label of labels) {
      const table = this.groupedTablesByLabel.get(label);
      if (!table) continue;
      this.tableQuantities.set(
        label,
        table.mode === 'whole' ? table.capacity : table.minOccupancy,
      );
      if (table.mode === 'variable') this.confirmedVariableTables.delete(label);
    }
  }

  private tableQuantityRequest(seat: PickerSeat | null): { quantity?: number } {
    if (seat?.objectType !== 'table') return {};
    if (seat.bookingMode === 'variable' && !this.confirmedVariableTables.has(seat.label)) {
      throw new Error('picker: confirm a variable table guest quantity before holding');
    }
    return { quantity: seat.quantity };
  }

  // ---- booking machine ------------------------------------------------------

  /**
   * Hold the current selection (or a given label set). The controller does the
   * renderer/hold side (409 → deselect + repaint the taken seats held) and then
   * re-throws so the caller can choose the banner copy. Returns null only when
   * there's nothing to hold.
   */
  async hold(labelsArg?: string[], ttlMs?: number): Promise<HoldInfo | null> {
    const r = this.renderer;
    if (!r) return null;
    const labels = labelsArg ?? this.getSelection().map((seat) => seat.label);
    const existingGA = (this.hold_?.items ?? []).filter((item) => item.objectType === 'ga');
    const combinedLabels = [...new Set([...existingGA.map((item) => item.label), ...labels])];
    if (!combinedLabels.length) return null;

    // Reuse an existing hold that exactly covers this selection (re-holding 409s).
    if (this.hold_ && this.holdCovers(combinedLabels)) return this.hold_;
    try {
      const selections = combinedLabels.map((label) => {
        const ga = existingGA.find((item) => item.label === label);
        if (ga) return { label, tierId: ga.tierId, quantity: ga.quantity };
        const seat = this.labelToSeat.get(label);
        const resolved = seat ? this.toSeat(seat) : null;
        return {
          label,
          ...(resolved?.tierId ? { tierId: resolved.tierId } : {}),
          ...this.tableQuantityRequest(resolved),
        };
      });
      const result = await this.api.hold(this.key, selections, ttlMs, this.hold_?.holdId);
      this.setHold({ holdId: result.holdId, labels: combinedLabels, expiresAt: result.expiresAt, items: result.items });
      return this.hold_;
    } catch (err) {
      this.handle409Conflicts(err);
      throw err;
    }
  }

  /** Restore an active server hold without creating or extending inventory. */
  async resumeHold(holdId: string): Promise<HoldInfo | null> {
    if (this.closed || !holdId || !this.api.resume) return null;
    const result = await this.api.resume(this.key, holdId);
    if (this.closed) return null;
    const labels = [...new Set(result.items.map((item) => item.label))];
    if (!labels.length) return null;
    this.setHold(
      { holdId: result.holdId, labels, expiresAt: result.expiresAt, items: result.items },
      'restored',
    );
    return this.hold_;
  }

  /**
   * P4 "need more time?": extend the OPEN hold's server-side expiry and re-arm
   * the client expiry timer to match (via setHold), so the controller doesn't
   * fire a false expiry and start polling. Returns the new hold, or null if
   * there's no open hold or the transport can't extend / the server refused
   * (hold gone, expired, or at its renewal cap). Never throws for the refusal
   * case — the caller decides the copy.
   */
  async extendHold(ttlMs?: number): Promise<HoldInfo | null> {
    const current = this.hold_;
    if (!current || !this.api.extend) return null;
    try {
      const result = await this.api.extend(this.key, current.holdId, ttlMs);
      if (this.hold_?.holdId !== current.holdId) return this.hold_; // superseded meanwhile
      // Keep the same labels/items — only the expiry moved. setHold re-arms the timer.
      this.setHold({ holdId: current.holdId, labels: current.labels, expiresAt: result.expiresAt, items: current.items });
      return this.hold_;
    } catch {
      return null;
    }
  }

  /** Public GA inventory derived from the live synthetic-unit status stream. */
  /**
   * Live seats-left per category key (status 'free' right now). Recompute on
   * onStatusChange — this is what a price panel's "N left" counters read.
   */
  categoryAvailability(): Record<string, number> {
    const out: Record<string, number> = {};
    const closedMembers = this.closedMemberIds();
    for (const [id, s] of this.seatById) {
      if (this.groupedTableBySeatId.has(id)) continue;
      if (closedMembers.has(id)) continue; // closed sections aren't on sale
      if ((this.getStatus(id) ?? 'free') === 'free') {
        out[s.categoryKey] = (out[s.categoryKey] ?? 0) + 1;
      }
    }
    for (const table of this.groupedTablesByLabel.values()) {
      if (table.chairs.some((chair) => closedMembers.has(chair.id))) continue;
      const representative = table.chairs[0];
      if (representative && (this.getStatus(representative.id) ?? 'free') === 'free') {
        // Availability is guest capacity, while atomic ownership remains one row.
        out[table.categoryKey] = (out[table.categoryKey] ?? 0) + table.maxOccupancy;
      }
    }
    return out;
  }

  /** Seat ids belonging to a currently-closed section (excluded from counts). */
  private closedMemberIds(): Set<string> {
    const out = new Set<string>();
    const r = this.renderer;
    if (!r || !this.closedSections.size) return out;
    for (const id of this.closedSections) for (const sid of (r.sectionMembers?.(id) ?? [])) out.add(sid);
    return out;
  }

  getGAAreas(): PickerGAArea[] {
    const doc = this.visibleDoc();
    if (!doc) return [];
    return gaAreasOf(doc).map((area) => {
      const category = doc.categories.find((candidate) => candidate.key === area.categoryKey);
      return {
        id: area.id,
        label: area.label,
        ...(area.displayLabel ? { displayLabel: area.displayLabel } : {}),
        ...(area.displayType ? { displayType: area.displayType } : {}),
        capacity: Math.max(0, Math.floor(area.capacity)),
        available: gaUnitLabels(area).filter((label) => (this.liveStatuses.get(label) ?? 'free') === 'free').length,
        categoryKey: area.categoryKey,
        tiers: category?.tiers,
        price: category?.tiers?.[0]?.price ?? category?.price ?? 0,
        currency: this.currency,
      };
    });
  }

  /** Select a quantity from one GA area and hold it atomically. */
  async holdGA(
    areaId: string,
    qty: number,
    options: { tierId?: string | null; ttlMs?: number } = {},
  ): Promise<HoldInfo | null> {
    const doc = this.visibleDoc();
    if (!doc || !Number.isFinite(qty) || qty < 1) return null;
    const area = gaAreasOf(doc).find((candidate) => candidate.id === areaId);
    if (!area) return null;
    const labels = gaUnitLabels(area)
      .filter((label) => !this.hold_?.labels.includes(label) && (this.liveStatuses.get(label) ?? 'free') === 'free')
      .slice(0, Math.floor(qty));
    if (labels.length !== Math.floor(qty)) return null;
    const selections = new Map<string, HoldSelectionRequest>();
    for (const item of this.hold_?.items ?? []) selections.set(item.label, {
      label: item.label,
      tierId: item.tierId,
      quantity: item.quantity,
    });
    if (this.hold_ && !this.hold_?.items?.length) {
      for (const seat of this.hold_.seats) selections.set(seat.label, { label: seat.label, ...(seat.tierId ? { tierId: seat.tierId } : {}) });
    }
    for (const seat of this.getSelection()) {
      selections.set(seat.label, {
        label: seat.label,
        ...(seat.tierId ? { tierId: seat.tierId } : {}),
        ...this.tableQuantityRequest(seat),
      });
    }
    for (const label of labels) selections.set(label, { label, ...(options.tierId ? { tierId: options.tierId } : {}) });
    const combined = [...selections.values()];
    const result = await this.api.hold(this.key, combined, options.ttlMs, this.hold_?.holdId);
    this.setHold({ holdId: result.holdId, labels: combined.map((s) => s.label), expiresAt: result.expiresAt, items: result.items });
    return this.hold_;
  }

  /** True when any seat on the visible chart carries the `premium` commercial
   *  flag — gates the buyer widget's "★ Best seats" premium quick-pick (chip is
   *  present-only, exactly like the accessibility filter chips). */
  hasPremiumSeats(): boolean {
    for (const seat of this.labelToSeat.values()) {
      if (seat.commercial?.premium) return true;
    }
    return false;
  }

  /** Zones which still own visible buyer inventory, in authored order. */
  getBestAvailableZones(): Array<{ id: string; label: string }> {
    const doc = this.visibleDoc();
    if (!doc?.zones?.length) return [];
    const used = new Set(
      computeSections(doc).sections
        .filter((section) => section.seatCount > 0 && !!section.zone)
        .map((section) => section.zone!),
    );
    return doc.zones.filter((zone) => used.has(zone.id)).map((zone) => ({ id: zone.id, label: zone.label }));
  }

  /**
   * Client-side premium pre-pass: find the best contiguous block of `qty`
   * PREMIUM-flagged free seats (orphan-avoiding, closest to the focal point)
   * using the local seat geometry + live availability, mirroring the server's
   * held-back exclusion via the visible (hidden-stripped) chart and current
   * seat status. Returns a FULL premium block of `qty`, or null when none
   * exists (the caller then falls back to the normal server pick).
   */
  private pickPremiumBlock(qty: number, categoryKey?: string, zoneId?: string): string[] | null {
    const doc = this.visibleDoc();
    if (!doc?.objects?.length) return null;
    const focal = doc.focalPoint ?? { x: 0, y: 0 };
    const groupedObjectIds = new Set(this.groupedTablesByObject.keys());
    // Group chairs are geometry, never adjacency inventory. Excluding their
    // rowIds prevents premium fallback from bridging/splitting a table.
    const seats = expandChart(doc).filter((seat) => !groupedObjectIds.has(seat.rowId));
    const held = new Set(this.hold_?.labels ?? []);
    const available = new Set<string>();
    for (const seat of seats) {
      if (held.has(seat.label)) continue;
      const id = this.labelToId.get(seat.label);
      const status = id ? this.getStatus(id) : undefined;
      if ((status ?? 'free') === 'free') available.add(seat.label);
    }
    const pick = pickBestAvailable(seats, available, { qty, categoryKey, zoneId, focal, preferPremium: true });
    if (pick.labels.length !== qty) return null;
    // Only treat it as a premium block when EVERY picked seat is premium — a
    // partial run means there's no true premium block of `qty` to offer.
    const allPremium = pick.labels.every((l) => this.labelToSeat.get(l)?.commercial?.premium);
    return allPremium ? [...pick.labels] : null;
  }

  /**
   * Server-picks `qty` best free seats and holds them atomically. Throws on
   * failure. With `preferPremium`, first tries to hold the best PREMIUM block
   * locally; when none matches the requested quantity it falls back to the
   * normal server pick (the widget surfaces a subtle note on that fallback).
   */
  async bestAvailable(
    qty: number,
    categoryKey?: string,
    opts: { preferPremium?: boolean; zoneId?: string } = {},
  ): Promise<HoldInfo | null> {
    const r = this.renderer;
    if (!r) return null;
    if (opts.preferPremium) {
      const block = this.pickPremiumBlock(qty, categoryKey, opts.zoneId);
      if (block) {
        // Drop any prior auto-hold before claiming the premium block.
        if (this.hold_ && !(await this.release())) return null;
        try {
          const selection = block.map((label) => {
            const seat = this.labelToSeat.get(label);
            const resolved = seat ? this.toSeat(seat) : null;
            return { label, ...(resolved?.tierId ? { tierId: resolved.tierId } : {}) };
          });
          const result = await this.api.hold(this.key, selection);
          r.clearSelection();
          const ids = this.idsForLabels(block);
          if (ids.length) r.setStatus(ids, 'held');
          this.setHold({ holdId: result.holdId, labels: [...block], expiresAt: result.expiresAt, items: result.items });
          const seats = block
            .map((l) => this.labelToSeat.get(l))
            .filter((s): s is ExpandedSeat => !!s)
            .map((s) => this.toSeat(s));
          this.opts.onSelectionChange?.(seats);
          return this.hold_;
        } catch (err) {
          const { status, reason } = errInfo(err);
          if (status === 409 && reason === 'event_closed') {
            this.opts.onSalesClosed?.();
            throw err;
          }
          // Lost a race for the premium block (a seat was taken) — fall through
          // to the atomic server pick below rather than failing the buyer.
        }
      }
      // No premium block available — fall through to the normal server pick.
    }
    // Drop any prior auto-hold first.
    if (this.hold_ && !(await this.release())) return null;
    try {
      const result = await this.api.bestAvailable(this.key, qty, categoryKey, opts.zoneId);
      r.clearSelection();
      const ids = this.idsForLabels(result.labels);
      if (ids.length) r.setStatus(ids, 'held');
      this.setHold({ holdId: result.holdId, labels: [...result.labels], expiresAt: result.expiresAt, items: result.items });
      const seats = result.labels
        .map((l) => this.labelToSeat.get(l))
        .filter((s): s is ExpandedSeat => !!s)
        .map((s) => this.toSeat(s));
      this.opts.onSelectionChange?.(seats);
      return this.hold_;
    } catch (err) {
      const { status, reason } = errInfo(err);
      if (status === 409 && reason === 'event_closed') this.opts.onSalesClosed?.();
      throw err;
    }
  }

  /**
   * Complete a booking. Requires a transport that supports book() (the SDK
   * deliberately does not). `bookingRef` MUST be a real reference from the caller.
   * `labelsArg` lets the caller book its own cart (the live page's confirm-flow
   * cart can hold best-available seats that aren't in the renderer selection);
   * defaults to the renderer selection. Reuses an existing exact-match hold, else
   * holds first. Returns the labels booked, or null on failure (conflicts painted).
   */
  async book(bookingRef: string, labelsArg?: string[]): Promise<string[] | null> {
    const r = this.renderer;
    if (!r) return null;
    if (!this.api.book) throw new Error('picker: transport has no book() — hold-only mode');
    const labels = labelsArg ?? this.getSelection().map((seat) => seat.label);
    if (!labels.length) return null;

    let holdId: string | undefined;
    try {
      if (this.hold_ && this.holdCovers(labels)) {
        holdId = this.hold_.holdId; // already held server-side — re-holding would 409
      } else {
        const replaceHoldId = this.hold_?.holdId;
        const h = await this.api.hold(
          this.key,
          labels.map((label) => {
            const seat = this.labelToSeat.get(label);
            const resolved = seat ? this.toSeat(seat) : null;
            return {
              label,
              ...(resolved?.tierId ? { tierId: resolved.tierId } : {}),
              ...this.tableQuantityRequest(resolved),
            };
          }),
          undefined,
          replaceHoldId,
        );
        holdId = h.holdId;
        this.setHold({ holdId, labels: [...labels], expiresAt: h.expiresAt, items: h.items });
      }
      await this.api.book(this.key, labels, holdId, bookingRef);
    } catch (err) {
      const { status, conflicts, reason } = errInfo(err);
      this.clearHold();
      if (status === 409 && reason === 'event_closed') {
        this.opts.onSalesClosed?.();
      } else if (status === 409 && conflicts?.length) {
        // Paint the taken seats, deselect them, release the still-free remainder.
        const takenLabels = new Set(conflicts.map((c) => c.label));
        const takenIds = this.idsForLabels(takenLabels);
        if (takenIds.length) {
          r.setStatus(takenIds, 'booked');
          r.deselect(takenIds);
          this.resetTableQuantitiesForLabels(takenLabels);
        }
        const stillFree = labels.filter((l) => !takenLabels.has(l));
        if (stillFree.length && holdId) void this.api.release(this.key, stillFree, holdId).catch(() => {});
        this.emitSelectionChange();
      } else if (holdId) {
        // Non-conflict failure after a hold landed — release it so seats aren't stranded.
        void this.api.release(this.key, labels, holdId).catch(() => {});
      }
      throw err;
    }
    // Success — optimistically paint booked, deselect just the booked seats
    // (not the whole selection — the cart may be an explicit subset), clear hold.
    const ids = this.idsForLabels(labels);
    if (ids.length) {
      r.setStatus(ids, 'booked');
      r.deselect(ids);
    }
    this.clearHold();
    this.resetTableQuantitiesForLabels(labels);
    this.emitSelectionChange();
    this.opts.onBook?.(bookingRef);
    return labels;
  }

  /** Release the whole open hold (if any), repaint those seats free. */
  async release(): Promise<boolean> {
    const hold = this.hold_;
    if (!hold) return true;
    try {
      const result = await this.api.release(this.key, hold.labels, hold.holdId);
      if (!this.releaseConfirmed(result, hold.labels)) {
        await this.resnapshot();
        return false;
      }
    } catch (err) {
      this.emitError(err);
      return false;
    }
    if (this.hold_?.holdId !== hold.holdId) return true;
    this.clearHold();
    this.resetTableQuantitiesForLabels(hold.labels);
    const ids = this.idsForLabels(hold.labels);
    if (ids.length) {
      this.renderer?.deselect(ids);
      this.renderer?.setStatus(ids, 'free');
    }
    return true;
  }

  /**
   * Release just some labels from the open hold, keeping the rest held (used when
   * a buyer removes one seat chip). Clears the hold entirely once it empties.
   */
  async releaseLabels(labels: string[]): Promise<boolean> {
    const hold = this.hold_;
    if (!hold) return true;
    const drop = labels.filter((l) => hold.labels.includes(l));
    if (!drop.length) return true;
    try {
      const result = await this.api.release(this.key, drop, hold.holdId);
      if (!this.releaseConfirmed(result, drop)) {
        await this.resnapshot();
        return false;
      }
    } catch (err) {
      this.emitError(err);
      return false;
    }
    if (this.hold_?.holdId !== hold.holdId) return true;
    const remaining = hold.labels.filter((l) => !drop.includes(l));
    const remainingItems = hold.items?.filter((item) => !drop.includes(item.label));
    if (remaining.length) this.setHold({ ...hold, labels: remaining, items: remainingItems });
    else this.clearHold();
    this.resetTableQuantitiesForLabels(drop);
    const ids = this.idsForLabels(drop);
    if (ids.length) {
      this.renderer?.deselect(ids);
      this.renderer?.setStatus(ids, 'free');
    }
    return true;
  }

  /** New transports return the exact labels released; tolerate older adapters. */
  private releaseConfirmed(result: unknown, requested: string[]): boolean {
    const released = (result as { released?: unknown } | null)?.released;
    return !Array.isArray(released) || requested.every((label) => released.includes(label));
  }

  // ---- renderer proxies (so consumers don't reach through) ------------------

  setStatus(ids: string[], status: SeatStatus): void {
    this.renderer?.setStatus(ids, status);
  }
  getStatus(id: string): SeatStatus | undefined {
    return this.renderer?.getStatus(id);
  }
  flashSeat(id: string, color?: string): void {
    this.renderer?.flashSeat(id, color);
  }
  zoomIn(): void {
    this.renderer?.zoomIn();
  }
  zoomOut(): void {
    this.renderer?.zoomOut();
  }
  zoomToFit(): void {
    this.renderer?.zoomToFit();
  }
  worldToScreen(p: { x: number; y: number }): { x: number; y: number } {
    return this.renderer?.worldToScreen(p) ?? { x: 0, y: 0 };
  }
  setSelectionFocus(seatId: string | null): void {
    this.renderer?.setSelectionFocus?.(seatId);
  }
  setAccessibilityFilter(types: string[] | null): void {
    this.renderer?.setAccessibilityFilter?.(types as never);
  }
  /**
   * "Hide limited-view seats" toggle — dims free seats flagged
   * restricted/obstructed view. Additive commercial parallel to the
   * accessibility filter; called via the concrete renderer (not on the shared
   * ISeatmapRenderer interface).
   */
  setCommercialLimitedFilter(on: boolean): void {
    (this.renderer as { setCommercialLimitedFilter?: (on: boolean) => void } | null)
      ?.setCommercialLimitedFilter?.(on);
  }

  // ---- multi-floor (Batch 5) ------------------------------------------------

  /** Floors for the buyer's switcher (>1 ⇒ show it). Single-floor ⇒ one entry. */
  getFloors(): { id: string; name: string }[] {
    return this.renderer?.getFloors?.() ?? [];
  }
  getActiveFloorId(): string {
    return this.renderer?.getActiveFloorId?.() ?? '';
  }
  /** Switch the shown floor (2D), then re-apply live seat statuses onto it. */
  setFloor(id: string): void {
    const r = this.renderer;
    if (!r?.setActiveFloor || id === r.getActiveFloorId?.()) return;
    r.setStacked?.(false); // leaving any 3D stack — back to a single floor
    r.setActiveFloor(id);
    void this.resnapshot(); // re-paint statuses on the newly-rendered floor
    this.emitSelectionChange();
  }

  /** 3D all-floors stacked overview ⇄ active floor. Re-applies statuses after. */
  setStacked(on: boolean): void {
    const r = this.renderer;
    if (!r?.setStacked || on === r.isStacked?.()) return;
    r.setStacked(on);
    void this.resnapshot(); // re-paint statuses across the rebuilt view
  }
  isMultiFloor(): boolean {
    return (this._doc?.floors?.length ?? 0) > 1;
  }

  /** Tap-a-deck-to-enter: leave the 3D stack, drop to flat 2D on `floorId`, and
   *  tell the host so it can sync its 2D/3D toggle + floor-switcher state. */
  private handleDeckTap(floorId: string): void {
    const r = this.renderer;
    if (!r) return;
    r.setViewMode?.('flat');
    r.setStacked?.(false);
    r.setActiveFloor?.(floorId);
    void this.resnapshot();
    this.emitSelectionChange();
    this.opts.onDeckTap?.(floorId);
  }

  // ---- big-venue: sections / rungs / projection (Slice 5) -------------------

  /** Switch the map projection. No-op on a flat-only renderer. */
  setViewMode(mode: RendererViewMode): void {
    this.renderer?.setViewMode?.(mode);
  }
  getViewMode(): RendererViewMode {
    return this.renderer?.getViewMode?.() ?? 'flat';
  }
  /** Current LOD rung (for the ZONES/SECTIONS/SEATS pill). */
  getRung(): LodRung {
    return this.renderer?.getRung?.() ?? 'seats';
  }
  /** Jump to a rung; ZONES clears any focused summary (back to overview). */
  setRung(rung: LodRung): void {
    if (rung === 'zones') {
      this.overview();
      return;
    }
    this.renderer?.setRung?.(rung);
  }

  /** Price-band filter (F4): dim free seats whose category is outside `keys`
   *  (null clears). The widget resolves which categories fall in the band. */
  setCategoryFilter(keys: string[] | null): void {
    this.renderer?.setCategoryFilter?.(keys);
  }

  /** An explicit buyer price-filter action should not only dim the rest of the
   *  chart: clear any older section drill-in and guide the camera to the seats
   *  that remain relevant. Clearing the filter glides back to the full chart. */
  focusCategoryFilter(keys: string[] | null): void {
    const renderer = this.renderer;
    if (!renderer) return;
    renderer.clearSectionFocus?.();
    this.opts.onSectionFocus?.(null);
    // Multi-floor: the wanted categories may live on another deck entirely.
    // The renderer only knows the active floor's seats, so without switching
    // first the camera has nothing to frame and the filter is a silent no-op.
    if (keys?.length) {
      const target = this.floorForCategories(keys);
      if (target) this.setFloor(target);
    }
    if (renderer.focusCategories) renderer.focusCategories(keys);
    else renderer.zoomToFit();
  }

  /** The floor a buyer means when filtering to `keys`: the active floor when it
   *  carries any of those categories, else the first floor that does (null =
   *  stay put). Row overrides and GA areas count — a category can exist on a
   *  floor only via a per-seat override. */
  private floorForCategories(keys: string[]): string | null {
    const doc = this._doc;
    if (!doc?.floors || doc.floors.length < 2) return null;
    const wanted = new Set(keys);
    const carries = (objects: ChartObject[]): boolean =>
      objects.some((o) =>
        (o.type === 'row'
          && (wanted.has(o.categoryKey)
            || (o.overrides ?? []).some((ov) => ov.categoryKey != null && wanted.has(ov.categoryKey))))
        || (o.type === 'gaArea' && wanted.has(o.categoryKey)),
      );
    const activeId = this.getActiveFloorId();
    const active = doc.floors.find((f) => f.id === activeId);
    if (active && carries(active.objects)) return null;
    return doc.floors.find((f) => carries(f.objects))?.id ?? null;
  }

  /** World-space rect currently visible + full chart bounds (F3 minimap frame). */
  getViewport(): { visible: { x: number; y: number; width: number; height: number }; bounds: { x: number; y: number; width: number; height: number } } | null {
    const r = this.renderer;
    if (!r?.getVisibleWorldRect || !r.getWorldBounds) return null;
    return { visible: r.getVisibleWorldRect(), bounds: r.getWorldBounds() };
  }
  /** Glide in on a section and surface its summary (same path as a section tap). */
  focusSection(id: string): void {
    this.handleSectionTap(id);
  }
  /** Zoom back out to the whole chart and clear the section-summary card + focus. */
  overview(): void {
    this.renderer?.clearSectionFocus?.();
    this.renderer?.zoomToFit();
    this.opts.onSectionFocus?.(null);
  }

  /** Glide the camera into a tapped section and emit its computed summary. Uses
   *  the AXS focus treatment (dim + backdrop) when the engine supports it; a
   *  closed section is framed but never opens a buyer card. */
  private handleSectionTap(id: string): void {
    const r = this.renderer;
    if (!r) return;
    if (r.focusSection) r.focusSection(id);
    else r.focusRegion?.(id);
    if (this.isSectionClosed(id)) {
      this.opts.onSectionFocus?.(null); // closed: no purchase card
      return;
    }
    this.opts.onSectionFocus?.(this.sectionSummary(id));
  }

  /**
   * Build a section summary from the renderer's spatial membership: section +
   * zone labels, live seats-left, price range, and the per-category breakdown.
   */
  private sectionSummary(id: string): SectionSummary | null {
    const r = this.renderer;
    const doc = this._doc;
    if (!r || !doc) return null;
    const sec = doc.objects.find(
      (o): o is SectionObject => o.type === 'section' && o.id === id,
    );
    if (!sec) return null;

    const memberIds = r.sectionMembers?.(id) ?? [];
    const byCat = new Map<string, number>();
    const seenTables = new Set<string>();
    let seatsLeft = 0;
    for (const sid of memberIds) {
      const seat = this.seatById.get(sid);
      if (!seat) continue;
      const table = this.groupedTableBySeatId.get(sid);
      if (table) {
        if (seenTables.has(table.label)) continue;
        seenTables.add(table.label);
        byCat.set(table.categoryKey, (byCat.get(table.categoryKey) ?? 0) + table.maxOccupancy);
        if (r.getStatus(table.chairs[0]?.id ?? sid) === 'free') seatsLeft += table.maxOccupancy;
      } else {
        byCat.set(seat.categoryKey, (byCat.get(seat.categoryKey) ?? 0) + 1);
        if (r.getStatus(sid) === 'free') seatsLeft++;
      }
    }

    const categories: SectionCategory[] = [...byCat.entries()]
      .map(([key, count]) => {
        const cat = doc.categories.find((c) => c.key === key);
        return {
          key,
          count,
          label: cat?.label ?? key,
          color: cat?.color ?? '#6e7bff',
          price: cat?.price ?? 0,
        };
      })
      .sort((a, b) => a.price - b.price);

    const prices = categories.map((c) => c.price);
    const zone = sec.zone ? doc.zones?.find((z) => z.id === sec.zone) : undefined;
    const color = sec.color ?? zone?.color ?? categories[0]?.color ?? '#6e7bff';

    return {
      id,
      label: sec.displayLabel ?? sec.label,
      zoneLabel: zone?.label ?? '',
      ...(sec.entrance && sec.entrance.trim() ? { entrance: sec.entrance.trim() } : {}),
      color,
      seatsLeft,
      priceMin: prices.length ? prices[0] : 0,
      priceMax: prices.length ? prices[prices.length - 1] : 0,
      categories,
    };
  }

  destroy(): void {
    this.closed = true;
    this.detachVisibilityListener();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.renderer?.destroy();
    this.renderer = null;
  }

  // ---- internals ------------------------------------------------------------

  private toSeat(s: ExpandedSeat): PickerSeat {
    const table = this.groupedTableBySeatId.get(s.id);
    if (table) return this.toTableSeat(table);
    const commercial = s.commercial ? { commercial: s.commercial } : undefined;
    const display = s.displayLabel ? { displayLabel: s.displayLabel } : undefined;
    const accessibility = s.accessibility?.length ? { accessibility: s.accessibility } : undefined;
    const wheelchair = s.wheelchairSpaceType ? { wheelchairSpaceType: s.wheelchairSpaceType } : undefined;
    const context = this.seatContext.get(s.id);
    const tiers = this.tiersFor(s.categoryKey);
    if (!tiers) {
      return { id: s.id, label: s.label, ...display, ...context, categoryKey: s.categoryKey, price: this.priceFor(s.categoryKey), ...commercial, ...accessibility, ...wheelchair };
    }
    const chosen = tiers.find((t) => t.id === this.seatTiers.get(s.id)) ?? tiers[0];
    return {
      id: s.id,
      label: s.label,
      ...display,
      ...context,
      categoryKey: s.categoryKey,
      price: chosen.price,
      tiers,
      tierId: chosen.id,
      ...commercial,
      ...accessibility,
      ...wheelchair,
    };
  }

  private toTableSeat(table: GroupedTableInventoryUnit): TableSelectionDetails {
    const representative = table.chairs[0];
    const tiers = this.tiersFor(table.categoryKey);
    const chosen = tiers?.find((tier) => tier.id === this.seatTiers.get(representative?.id ?? '')) ?? tiers?.[0];
    return {
      id: representative?.id ?? table.objectId,
      label: table.label,
      displayLabel: table.displayLabel ?? table.label,
      ...(table.displayType ? { displayType: table.displayType, rowType: table.displayType } : {}),
      objectId: table.objectId,
      sectionLabel: representative ? this.seatContext.get(representative.id)?.sectionLabel : undefined,
      rowLabel: table.displayLabel ?? table.label,
      categoryKey: table.categoryKey,
      price: chosen?.price ?? this.priceFor(table.categoryKey),
      ...(tiers ? { tiers, tierId: chosen?.id } : {}),
      objectType: 'table',
      bookingMode: table.mode,
      quantity: this.tableQuantities.get(table.label)
        ?? (table.mode === 'whole' ? table.capacity : table.minOccupancy),
      capacity: table.capacity,
      minOccupancy: table.minOccupancy,
      maxOccupancy: table.maxOccupancy,
      physicalSeatIds: table.chairs.map((chair) => chair.id),
    };
  }
  /** Tooltip payload for a hovered seat — see PickerCallbacks.onSeatHover. */
  private describeSeat(s: ExpandedSeat): SeatHoverDetails {
    const cat = this._doc?.categories.find((c) => c.key === s.categoryKey);
    return {
      ...this.toSeat(s),
      categoryLabel: cat?.label ?? s.categoryKey,
      categoryColor: cat?.color ?? '#6e7bff',
      status: this.renderer?.getStatus(s.id) ?? 'free',
      currency: this.currency,
      ...this.seatContext.get(s.id),
    };
  }

  private priceFor(categoryKey: string): number {
    return this._doc?.categories.find((c) => c.key === categoryKey)?.price ?? 0;
  }
  private tiersFor(categoryKey: string): CategoryTier[] | undefined {
    const t = this._doc?.categories.find((c) => c.key === categoryKey)?.tiers;
    return t && t.length ? t : undefined;
  }

  /**
   * Choose a ticket tier for a selected seat (e.g. Adult → Child). Re-emits the
   * selection so the host's cart + the eventual hold carry the new tier + price.
   * `tierId = null` reverts to the category's first (default) tier. No-op if the
   * seat's category has no tiers or the id isn't one of them.
   */
  setSeatTier(seatId: string, tierId: string | null): void {
    const seat = this.seatById.get(seatId);
    if (!seat) return;
    const tiers = this.tiersFor(seat.categoryKey);
    if (!tiers) return;
    if (tierId == null) this.seatTiers.delete(seatId);
    else if (tiers.some((t) => t.id === tierId)) this.seatTiers.set(seatId, tierId);
    else return;
    this.emitSelectionChange();
    if (this.hold_) this.hold_ = { ...this.hold_, seats: this.seatsForLabels(this.hold_.labels) };
  }

  /** PickerSeats (with chosen tier) for a set of held labels. */
  private seatsForLabels(labels: string[]): PickerSeat[] {
    const out: PickerSeat[] = [];
    for (const l of labels) {
      const s = this.labelToSeat.get(l);
      if (s) out.push(this.toSeat(s));
    }
    return out;
  }
  private emitSelectionChange(): void {
    this.opts.onSelectionChange?.(this.getSelection());
    this.emitOrphanHint();
  }

  /** Whether the last emitted hint was non-null (avoids clearing repeatedly). */
  private hintShown = false;

  /**
   * Orphan-seat advice on manual selection: when the buyer's current picks
   * strand one (or more) single free seats between unavailable same-row
   * neighbors, surface a localized, non-blocking hint. Cleared (null) as soon
   * as the selection stops stranding anyone.
   */
  private emitOrphanHint(): void {
    if (!this.opts.onHint) return;
    const r = this.renderer;
    if (!r) return;
    const selected = new Set(r.getSelection().map((s) => s.id));
    const stranded = selected.size
      ? strandedSingles(this.seatById.values(), (id) => r.getStatus(id), selected)
      : [];
    if (stranded.length > 0) {
      this.hintShown = true;
      this.opts.onHint(t('picker.orphanHint'));
    } else if (this.hintShown) {
      this.hintShown = false;
      this.opts.onHint(null);
    }
  }

  /** Toggle colorblind-safe rendering at runtime (see PickerOptions.colorblindSafe). */
  setColorblindSafe(on: boolean): void {
    this.renderer?.setColorblindSafe?.(on);
  }
  private emitError(err: unknown): void {
    if (this.opts.onError) this.opts.onError(err);
    else console.error('[picker]', err);
  }

  private holdCovers(labels: string[]): boolean {
    const h = this.hold_;
    if (!h || h.labels.length !== labels.length || !labels.every((l) => h.labels.includes(l))) return false;
    const tiers = new Map((h.items ?? []).map((item) => [item.label, item.tierId]));
    const quantities = new Map((h.items ?? []).map((item) => [item.label, item.quantity ?? 1]));
    return labels.every((label) => {
      const seat = this.labelToSeat.get(label);
      const resolved = seat ? this.toSeat(seat) : null;
      const currentTier = resolved?.tierId ?? null;
      const quantityMatches = resolved?.objectType !== 'table'
        || (resolved.bookingMode !== 'variable' || this.confirmedVariableTables.has(label))
          && (!quantities.has(label) || quantities.get(label) === resolved.quantity);
      return quantityMatches && (!tiers.has(label) || tiers.get(label) === currentTier);
    });
  }

  private handle409Conflicts(err: unknown): void {
    const { status, conflicts } = errInfo(err);
    if (status !== 409 || !conflicts?.length) return;
    const r = this.renderer;
    if (!r) return;
    const takenIds = this.idsForLabels(conflicts.map((conflict) => conflict.label));
    if (takenIds.length) {
      r.deselect(takenIds);
      r.setStatus(takenIds, 'held');
      this.resetTableQuantitiesForLabels(conflicts.map((conflict) => conflict.label));
    }
    this.emitSelectionChange();
  }

  /** Set the open hold + (re)arm the server-authoritative expiry timer. */
  private setHold(
    hold: Omit<HoldInfo, 'seats'> & { seats?: PickerSeat[] },
    source: 'created' | 'restored' = 'created',
  ): void {
    for (const item of hold.items ?? []) {
      if (this.groupedTablesByLabel.has(item.label) && item.quantity != null) {
        this.tableQuantities.set(item.label, item.quantity);
        if (this.groupedTablesByLabel.get(item.label)?.mode === 'variable') {
          this.confirmedVariableTables.add(item.label);
        }
      }
    }
    // Always resolve seats (with chosen tier) from the held labels so the host's
    // onHold — and any later book — carries the tier the buyer picked per seat.
    const full: HoldInfo = { ...hold, seats: this.seatsForLabels(hold.labels) };
    this.hold_ = full;
    this.renderer?.setOwnedHold?.(
      this.idsForLabels(full.labels),
    );
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const ms = Math.max(0, full.expiresAt - Date.now());
    this.expiryTimer = setTimeout(() => void this.expireActiveHold(), ms);
    if (source === 'restored') this.opts.onHoldRestored?.(full);
    else this.opts.onHold?.(full);
  }
  private clearHold(): void {
    this.hold_ = null;
    this.renderer?.setOwnedHold?.(null);
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
  private async expireActiveHold(): Promise<void> {
    const hold = this.hold_;
    if (!hold) return;
    try {
      const snap = await this.api.objects(this.key);
      if (this.hold_?.holdId !== hold.holdId) return;
      this.applySeatsMap(snap.seats);
    } catch {
      // Do not report expiry from a disconnected/stale client. Reconcile once
      // the authoritative snapshot becomes reachable.
      if (this.hold_?.holdId === hold.holdId) {
        this.expiryTimer = setTimeout(() => void this.expireActiveHold(), 2_000);
      }
      return;
    }
    if (this.hold_?.holdId !== hold.holdId) return; // booked snapshot cleared it
    if (hold.labels.some((label) => this.liveStatuses.get(label) === 'held')) {
      this.expiryTimer = setTimeout(() => void this.expireActiveHold(), 1_000);
      return;
    }
    this.clearHold();
    this.opts.onHoldExpired?.();
  }

  private applySeatsMap(seats: Record<string, string>): void {
    const r = this.renderer;
    if (!r) return;
    this.liveStatuses = new Map(Object.entries(seats));
    if (this.allIds.length) r.setStatus(this.allIds, 'free');
    // setChart() rebuilds renderer state (floor/hidden-section changes), so
    // restore the buyer-ownership layer before repainting held statuses.
    r.setOwnedHold?.(
      this.idsForLabels(this.hold_?.labels ?? []),
    );
    const byStatus: Record<SeatStatus, string[]> = { free: [], held: [], booked: [], not_for_sale: [] };
    for (const [label, st] of Object.entries(seats)) {
      byStatus[mapStatus(st)].push(...this.idsForLabel(label));
    }
    (['held', 'booked', 'not_for_sale'] as SeatStatus[]).forEach((st) => {
      if (byStatus[st].length) r.setStatus(byStatus[st], st);
    });
    this.opts.onStatusChange?.();
    this.clearBookedHoldIfSettled();
  }

  private clearBookedHoldIfSettled(): void {
    const hold = this.hold_;
    if (hold?.labels.every((label) => this.liveStatuses.get(label) === 'booked')) {
      this.clearHold();
      this.resetTableQuantitiesForLabels(hold.labels);
    }
  }

  private async resnapshot(): Promise<void> {
    try {
      const objs = await this.api.objects(this.key);
      this.applySeatsMap(objs.seats);
    } catch {
      /* transient — the socket delta stream keeps us fresh */
    }
  }

  /**
   * Re-pull the status snapshot on demand. Live surfaces rarely need this (the
   * socket keeps them fresh); local/mock transports with no socket call it
   * after they mutate state (e.g. the demo books a hold) so the renderer and
   * every onStatusChange consumer repaint from the new truth.
   */
  async refresh(): Promise<void> {
    await this.resnapshot();
  }

  // ---- realtime socket ------------------------------------------------------

  /**
   * Buyer catch-up on tab regain. While a tab is hidden Chrome pauses rAF, so
   * seat-status deltas that arrived over the WS mutated the scene graph but the
   * canvas colors never repainted. When the tab becomes visible again we (1)
   * resnapshot to pull authoritative state for anything the socket may have
   * missed while backgrounded, then (2) forceDraw() a synchronous repaint so the
   * seat colors are correct immediately rather than on the next incidental draw.
   *
   * Attached once per mount; guarded against double-attach and non-DOM
   * environments; detached in destroy() (no leaks).
   */
  private attachVisibilityListener(): void {
    if (this.onVisibilityChange) return; // already attached (guard double mount)
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const handler = (): void => {
      if (this.closed) return;
      if (document.visibilityState !== 'visible') return;
      // Re-fetch authoritative state, then paint it synchronously.
      void this.resnapshot().then(() => {
        if (!this.closed) this.renderer?.forceDraw();
      });
    };
    this.onVisibilityChange = handler;
    document.addEventListener('visibilitychange', handler);
  }

  private detachVisibilityListener(): void {
    if (!this.onVisibilityChange) return;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.onVisibilityChange = null;
  }

  private connect(): void {
    if (this.closed) return;
    // A transport may be fully local (demo/mock) — an empty socketUrl means
    // "no live feed"; skip the connection instead of retrying forever.
    const url = this.api.socketUrl(this.key);
    if (!url) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      void this.resnapshot();
    };
    ws.onmessage = (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      const r = this.renderer;
      if (!r || !msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; hidden?: string[]; closed?: string[]; seats?: Record<string, string>; changes?: { label: string; status: string }[] };
      // Reconcile hidden sections whenever they arrive (dedicated 'hidden' message
      // OR a snapshot that carries them). Only rebuilds the chart when it changed.
      if (Array.isArray(m.hidden) && this.syncHidden(m.hidden)) {
        void this.resnapshot(); // repaint statuses onto the rebuilt chart
        this.opts.onStatusChange?.();
      }
      // Reconcile closed sections (Phase 2). Cheap grey restyle, no chart rebuild —
      // so flipping a section open/closed mid-sale repaints for connected buyers.
      if (Array.isArray(m.closed) && this.syncClosed(m.closed)) {
        this.opts.onStatusChange?.();
      }
      if (m.type === 'hidden') return; // dedicated hidden message carries no seats
      if (m.seats && typeof m.seats === 'object') {
        this.applySeatsMap(m.seats);
      } else if (Array.isArray(m.changes)) {
        for (const ch of m.changes) {
          this.liveStatuses.set(ch.label, ch.status);
          const ids = this.idsForLabel(ch.label);
          if (!ids.length) continue;
          const next = mapStatus(ch.status);
          // Flash a live free→taken change — but not the buyer's OWN just-held
          // seats (a manual hold leaves them 'free' locally, so the server's
          // held-delta would otherwise flash them as if someone else grabbed them).
          if (
            this.opts.flashOnLiveChange &&
            next !== 'free' &&
            ids.some((id) => r.getStatus(id) === 'free') &&
            !this.hold_?.labels.includes(ch.label)
          ) {
            // Pulse color mirrors the manager board's status language:
            // amber for a hold landing, red for a booking.
            ids.forEach((id) => r.flashSeat(id, next === 'held' ? '#f4b740' : '#f43f5e'));
          }
          r.setStatus(ids, next);
        }
        // Stay-live-while-hidden (opt-in, default OFF). setStatus paints via
        // batchDraw (rAF), which Chrome pauses on a hidden tab — so an always-on
        // board (the future organizer control room) would freeze while
        // backgrounded. When enabled, force a synchronous repaint so a hidden
        // board keeps painting. The buyer widget leaves this off and relies on
        // the visibilitychange catch-up instead.
        if (
          this.opts.keepLiveWhileHidden &&
          typeof document !== 'undefined' &&
          document.visibilityState === 'hidden'
        ) {
          r.forceDraw();
        }
        this.clearBookedHoldIfSettled();
        this.opts.onStatusChange?.();
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose drives reconnect */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const attempt = Math.min(this.attempt++, 5);
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
