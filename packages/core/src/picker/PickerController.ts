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
import { expandChart } from '../core/layout';
import { applyHidden } from '../core/sections';
import type {
  CategoryTier,
  ChartDoc,
  ExpandedSeat,
  ISeatmapRenderer,
  LodRung,
  RendererCallbacks,
  SeatStatus,
  SectionObject,
} from '../core/types';

const DEFAULT_MAX_SELECTION = 10;
const MAX_BACKOFF_MS = 15_000;

export interface PickerSeat {
  id: string;
  label: string;
  categoryKey: string;
  /** Price for the chosen tier when the category has tiers, else the base price. */
  price: number;
  /** Ticket tiers the seat's category offers (Adult/Child/…); absent when none. */
  tiers?: CategoryTier[];
  /** The chosen tier's id — defaults to the first tier; absent when no tiers. */
  tierId?: string;
}

export interface HoldConflict {
  label: string;
  reason: string;
}

/** An open hold — its id, the labels it covers, and the server's expiry time (ms epoch). */
export interface HoldInfo {
  holdId: string;
  labels: string[];
  expiresAt: number;
  /** The held seats with their chosen ticket tier — what the host books against. */
  seats: PickerSeat[];
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
  label: string;
  /** Zone label (from ChartDoc.zones); '' when the section has no zone. */
  zoneLabel: string;
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
}
interface BestAvailableResponse extends HoldResponse {
  labels: string[];
}

/** Swappable public-surface transport (SDK PubApi or a dashboard `api.pub.*` adapter). */
export interface PickerTransport {
  chart(key: string): Promise<{
    doc: ChartDoc;
    event: { key: string; name: string; salesClosed?: boolean; venue?: string | null; startsAt?: number | null; currency?: string };
  }>;
  objects(key: string): Promise<{ seats: Record<string, string>; hidden?: string[] }>;
  hold(key: string, labels: string[]): Promise<HoldResponse>;
  bestAvailable(key: string, qty: number, categoryKey?: string): Promise<BestAvailableResponse>;
  release(key: string, labels: string[], holdId: string): Promise<unknown>;
  /** Optional — the SDK omits booking (it hands the holdId to the host page). */
  book?(key: string, labels: string[], holdId: string, bookingRef: string): Promise<unknown>;
  socketUrl(key: string): string;
}

export interface PickerCallbacks extends RendererCallbacks {
  /** Selection changed (manual clicks or a server best-available pick). */
  onSelectionChange?: (seats: PickerSeat[]) => void;
  /** A hold opened (manual hold or best-available). */
  onHold?: (hold: HoldInfo) => void;
  /** The open hold expired server-side (the controller has already released it). */
  onHoldExpired?: () => void;
  /** A booking completed with this ref. */
  onBook?: (bookingRef: string) => void;
  /** Any live seat-status change arrived (delta or snapshot) — e.g. to recount "N left". */
  onStatusChange?: () => void;
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
  private readonly maxSelection: number;

  private renderer: ISeatmapRenderer | null = null;
  private _doc: ChartDoc | null = null;
  /** Section/zone ids hidden from buyers this event (3.3) — seats vanish, not grey. */
  private hidden = new Set<string>();

  /** label ⇄ id maps — backend speaks labels, the engine speaks ids. */
  private labelToId = new Map<string, string>();
  private labelToSeat = new Map<string, ExpandedSeat>();
  /** seatId → chosen ticket-tier id (absent ⇒ the category's first/default tier). */
  private seatTiers = new Map<string, string>();
  /** id → seat, for the section-summary breakdown (renderer members are ids). */
  private seatById = new Map<string, ExpandedSeat>();
  private allIds: string[] = [];

  // realtime socket
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;

  // hold state
  private hold_: HoldInfo | null = null;
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

  /** Fetch chart, build label maps, mount the renderer, seed statuses, go live. */
  async render(host: HTMLDivElement): Promise<{
    doc: ChartDoc;
    salesClosed: boolean;
    eventName: string;
    venue?: string | null;
    startsAt?: number | null;
    currency?: string;
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

    this.labelToId = new Map();
    this.labelToSeat = new Map();
    this.seatById = new Map();
    this.allIds = [];
    for (const s of expandChart(res.doc)) {
      this.labelToId.set(s.label, s.id);
      this.labelToSeat.set(s.label, s);
      this.seatById.set(s.id, s);
      this.allIds.push(s.id);
    }

    // The organizer's currency travels with the chart payload; it wins over any
    // option passed at construction (the SDK host may not know it up front).
    const currency = res.event.currency ?? this.opts.currency;
    const renderer = createRenderer(host, {
      maxSelection: this.maxSelection,
      confirmSelection: this.opts.confirmSelection,
      currency,
      onSelect: (seat) => {
        this.opts.onSelect?.(seat);
        this.emitSelectionChange();
      },
      onDeselect: (seat) => {
        this.opts.onDeselect?.(seat);
        this.emitSelectionChange();
      },
      onHover: this.opts.onHover,
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
    try {
      const objs = await this.api.objects(this.key);
      this.hidden = new Set(objs.hidden ?? []);
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
    if (seats) this.applySeatsMap(seats);
    this.connect();
    return {
      doc: res.doc,
      salesClosed: !!res.event.salesClosed,
      eventName: res.event.name,
      venue: res.event.venue,
      startsAt: res.event.startsAt,
      currency,
    };
  }

  // ---- selection ------------------------------------------------------------

  getSelection(): PickerSeat[] {
    if (!this.renderer) return [];
    return this.renderer.getSelection().map((s) => this.toSeat(s));
  }
  clearSelection(): void {
    this.renderer?.clearSelection();
    this.emitSelectionChange();
  }
  deselect(ids: string[]): void {
    this.renderer?.deselect(ids);
    this.emitSelectionChange();
  }

  // ---- booking machine ------------------------------------------------------

  /**
   * Hold the current selection (or a given label set). The controller does the
   * renderer/hold side (409 → deselect + repaint the taken seats held) and then
   * re-throws so the caller can choose the banner copy. Returns null only when
   * there's nothing to hold.
   */
  async hold(labelsArg?: string[]): Promise<HoldInfo | null> {
    const r = this.renderer;
    if (!r) return null;
    const labels = labelsArg ?? r.getSelection().map((s) => s.label);
    if (!labels.length) return null;

    // Reuse an existing hold that exactly covers this selection (re-holding 409s).
    if (this.hold_ && this.holdCovers(labels)) return this.hold_;

    try {
      const result = await this.api.hold(this.key, labels);
      this.setHold({ holdId: result.holdId, labels: [...labels], expiresAt: result.expiresAt });
      return this.hold_;
    } catch (err) {
      this.handle409Conflicts(err);
      throw err;
    }
  }

  /** Server-picks `qty` best free seats and holds them atomically. Throws on failure. */
  async bestAvailable(qty: number, categoryKey?: string): Promise<HoldInfo | null> {
    const r = this.renderer;
    if (!r) return null;
    // Drop any prior auto-hold first.
    if (this.hold_) await this.release();
    try {
      const result = await this.api.bestAvailable(this.key, qty, categoryKey);
      r.clearSelection();
      const ids = result.labels.map((l) => this.labelToId.get(l)).filter((v): v is string => !!v);
      if (ids.length) r.setStatus(ids, 'held');
      this.setHold({ holdId: result.holdId, labels: [...result.labels], expiresAt: result.expiresAt });
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
    const labels = labelsArg ?? r.getSelection().map((s) => s.label);
    if (!labels.length) return null;

    let holdId: string | undefined;
    try {
      if (this.hold_ && this.holdCovers(labels)) {
        holdId = this.hold_.holdId; // already held server-side — re-holding would 409
      } else {
        const h = await this.api.hold(this.key, labels);
        holdId = h.holdId;
        this.setHold({ holdId, labels: [...labels], expiresAt: h.expiresAt });
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
        const takenIds = [...takenLabels].map((l) => this.labelToId.get(l)).filter((v): v is string => !!v);
        if (takenIds.length) {
          r.setStatus(takenIds, 'booked');
          r.deselect(takenIds);
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
    const ids = labels.map((l) => this.labelToId.get(l)).filter((v): v is string => !!v);
    if (ids.length) {
      r.setStatus(ids, 'booked');
      r.deselect(ids);
    }
    this.clearHold();
    this.emitSelectionChange();
    this.opts.onBook?.(bookingRef);
    return labels;
  }

  /** Release the whole open hold (if any), repaint those seats free. */
  async release(): Promise<void> {
    const hold = this.hold_;
    if (!hold) return;
    this.clearHold();
    const ids = hold.labels.map((l) => this.labelToId.get(l)).filter((v): v is string => !!v);
    if (ids.length) this.renderer?.setStatus(ids, 'free');
    try {
      await this.api.release(this.key, hold.labels, hold.holdId);
    } catch (err) {
      this.emitError(err);
    }
  }

  /**
   * Release just some labels from the open hold, keeping the rest held (used when
   * a buyer removes one seat chip). Clears the hold entirely once it empties.
   */
  async releaseLabels(labels: string[]): Promise<void> {
    const hold = this.hold_;
    if (!hold) return;
    const drop = labels.filter((l) => hold.labels.includes(l));
    if (!drop.length) return;
    const remaining = hold.labels.filter((l) => !drop.includes(l));
    if (remaining.length) this.setHold({ ...hold, labels: remaining });
    else this.clearHold();
    const ids = drop.map((l) => this.labelToId.get(l)).filter((v): v is string => !!v);
    if (ids.length) this.renderer?.setStatus(ids, 'free');
    try {
      await this.api.release(this.key, drop, hold.holdId);
    } catch (err) {
      this.emitError(err);
    }
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
  setAccessibilityFilter(types: string[] | null): void {
    this.renderer?.setAccessibilityFilter?.(types as never);
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

  /** Switch the map projection (2D flat ⇄ 3D isometric). No-op on a flat renderer. */
  setViewMode(mode: 'flat' | 'isometric'): void {
    this.renderer?.setViewMode?.(mode);
  }
  getViewMode(): 'flat' | 'isometric' {
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
  /** Glide in on a section and surface its summary (same path as a section tap). */
  focusSection(id: string): void {
    this.handleSectionTap(id);
  }
  /** Zoom back out to the whole chart and clear the section-summary card. */
  overview(): void {
    this.renderer?.zoomToFit();
    this.opts.onSectionFocus?.(null);
  }

  /** Glide the camera into a tapped section and emit its computed summary. */
  private handleSectionTap(id: string): void {
    const r = this.renderer;
    if (!r) return;
    r.focusRegion?.(id);
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
    let seatsLeft = 0;
    for (const sid of memberIds) {
      const seat = this.seatById.get(sid);
      if (!seat) continue;
      byCat.set(seat.categoryKey, (byCat.get(seat.categoryKey) ?? 0) + 1);
      if (r.getStatus(sid) === 'free') seatsLeft++;
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
      label: sec.label,
      zoneLabel: zone?.label ?? '',
      color,
      seatsLeft,
      priceMin: prices.length ? prices[0] : 0,
      priceMax: prices.length ? prices[prices.length - 1] : 0,
      categories,
    };
  }

  destroy(): void {
    this.closed = true;
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
    const tiers = this.tiersFor(s.categoryKey);
    if (!tiers) {
      return { id: s.id, label: s.label, categoryKey: s.categoryKey, price: this.priceFor(s.categoryKey) };
    }
    const chosen = tiers.find((t) => t.id === this.seatTiers.get(s.id)) ?? tiers[0];
    return {
      id: s.id,
      label: s.label,
      categoryKey: s.categoryKey,
      price: chosen.price,
      tiers,
      tierId: chosen.id,
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
  }
  private emitError(err: unknown): void {
    if (this.opts.onError) this.opts.onError(err);
    else console.error('[picker]', err);
  }

  private holdCovers(labels: string[]): boolean {
    const h = this.hold_;
    return !!h && h.labels.length === labels.length && labels.every((l) => h.labels.includes(l));
  }

  private handle409Conflicts(err: unknown): void {
    const { status, conflicts } = errInfo(err);
    if (status !== 409 || !conflicts?.length) return;
    const r = this.renderer;
    if (!r) return;
    const takenIds = conflicts.map((c) => this.labelToId.get(c.label)).filter((v): v is string => !!v);
    if (takenIds.length) {
      r.deselect(takenIds);
      r.setStatus(takenIds, 'held');
    }
    this.emitSelectionChange();
  }

  /** Set the open hold + (re)arm the server-authoritative expiry timer. */
  private setHold(hold: Omit<HoldInfo, 'seats'> & { seats?: PickerSeat[] }): void {
    // Always resolve seats (with chosen tier) from the held labels so the host's
    // onHold — and any later book — carries the tier the buyer picked per seat.
    const full: HoldInfo = { ...hold, seats: this.seatsForLabels(hold.labels) };
    this.hold_ = full;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const ms = Math.max(0, full.expiresAt - Date.now());
    this.expiryTimer = setTimeout(() => this.onHoldExpired(), ms);
    this.opts.onHold?.(full);
  }
  private clearHold(): void {
    this.hold_ = null;
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
  private onHoldExpired(): void {
    const hold = this.hold_;
    this.clearHold();
    if (hold) {
      const ids = hold.labels.map((l) => this.labelToId.get(l)).filter((v): v is string => !!v);
      if (ids.length) this.renderer?.setStatus(ids, 'free');
    }
    this.opts.onHoldExpired?.();
  }

  private applySeatsMap(seats: Record<string, string>): void {
    const r = this.renderer;
    if (!r) return;
    if (this.allIds.length) r.setStatus(this.allIds, 'free');
    const byStatus: Record<SeatStatus, string[]> = { free: [], held: [], booked: [], not_for_sale: [] };
    for (const [label, st] of Object.entries(seats)) {
      const id = this.labelToId.get(label);
      if (id) byStatus[mapStatus(st)].push(id);
    }
    (['held', 'booked', 'not_for_sale'] as SeatStatus[]).forEach((st) => {
      if (byStatus[st].length) r.setStatus(byStatus[st], st);
    });
    this.opts.onStatusChange?.();
  }

  private async resnapshot(): Promise<void> {
    try {
      const objs = await this.api.objects(this.key);
      this.applySeatsMap(objs.seats);
    } catch {
      /* transient — the socket delta stream keeps us fresh */
    }
  }

  // ---- realtime socket ------------------------------------------------------

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.api.socketUrl(this.key));
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
      const m = msg as { type?: string; hidden?: string[]; seats?: Record<string, string>; changes?: { label: string; status: string }[] };
      // Reconcile hidden sections whenever they arrive (dedicated 'hidden' message
      // OR a snapshot that carries them). Only rebuilds the chart when it changed.
      if (Array.isArray(m.hidden) && this.syncHidden(m.hidden)) {
        void this.resnapshot(); // repaint statuses onto the rebuilt chart
        this.opts.onStatusChange?.();
      }
      if (m.type === 'hidden') return; // dedicated hidden message carries no seats
      if (m.seats && typeof m.seats === 'object') {
        this.applySeatsMap(m.seats);
      } else if (Array.isArray(m.changes)) {
        for (const ch of m.changes) {
          const id = this.labelToId.get(ch.label);
          if (!id) continue;
          const next = mapStatus(ch.status);
          // Flash a live free→taken change — but not the buyer's OWN just-held
          // seats (a manual hold leaves them 'free' locally, so the server's
          // held-delta would otherwise flash them as if someone else grabbed them).
          if (
            this.opts.flashOnLiveChange &&
            next !== 'free' &&
            r.getStatus(id) === 'free' &&
            !this.hold_?.labels.includes(ch.label)
          ) {
            r.flashSeat(id);
          }
          r.setStatus([id], next);
        }
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
