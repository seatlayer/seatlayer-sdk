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
import type {
  ChartDoc,
  ExpandedSeat,
  ISeatmapRenderer,
  RendererCallbacks,
  SeatStatus,
} from '../core/types';

const DEFAULT_MAX_SELECTION = 10;
const MAX_BACKOFF_MS = 15_000;

export interface PickerSeat {
  id: string;
  label: string;
  categoryKey: string;
  price: number;
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
    event: { key: string; name: string; salesClosed?: boolean; venue?: string | null; startsAt?: number | null };
  }>;
  objects(key: string): Promise<{ seats: Record<string, string> }>;
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
  onError?: (err: unknown) => void;
}

export interface PickerOptions extends PickerCallbacks {
  transport: PickerTransport;
  eventKey: string;
  maxSelection?: number;
  /** Renderer confirm-card mode (host shows a confirm popover instead of instant cart add). */
  confirmSelection?: boolean;
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

  /** label ⇄ id maps — backend speaks labels, the engine speaks ids. */
  private labelToId = new Map<string, string>();
  private labelToSeat = new Map<string, ExpandedSeat>();
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
    this.allIds = [];
    for (const s of expandChart(res.doc)) {
      this.labelToId.set(s.label, s.id);
      this.labelToSeat.set(s.label, s);
      this.allIds.push(s.id);
    }

    const renderer = createRenderer(host, {
      maxSelection: this.maxSelection,
      confirmSelection: this.opts.confirmSelection,
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
      onFps: this.opts.onFps,
    });
    if (this.closed) {
      renderer.destroy(); // destroyed during createRenderer — don't leak the stage
      return null;
    }
    this.renderer = renderer;
    renderer.setChart(res.doc);

    await this.resnapshot();
    this.connect();
    return {
      doc: res.doc,
      salesClosed: !!res.event.salesClosed,
      eventName: res.event.name,
      venue: res.event.venue,
      startsAt: res.event.startsAt,
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
    return { id: s.id, label: s.label, categoryKey: s.categoryKey, price: this.priceFor(s.categoryKey) };
  }
  private priceFor(categoryKey: string): number {
    return this._doc?.categories.find((c) => c.key === categoryKey)?.price ?? 0;
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
  private setHold(hold: HoldInfo): void {
    this.hold_ = hold;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const ms = Math.max(0, hold.expiresAt - Date.now());
    this.expiryTimer = setTimeout(() => this.onHoldExpired(), ms);
    this.opts.onHold?.(hold);
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
      const m = msg as { seats?: Record<string, string>; changes?: { label: string; status: string }[] };
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
