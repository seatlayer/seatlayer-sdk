/**
 * SeatManager — the organizer manage surface, packaged for the SDK.
 *
 * Productizes the SeatLayer dashboard's ManageEventPage into a framework-
 * agnostic class (mirrors how SeatPicker productized the buyer flow). It mounts
 * the shared engine in `manageMode`, subscribes to the event's realtime channel
 * and drives two M1 modes on one canvas:
 *
 *   - **view**  — a live board: realtime seat repaint (flash on hold/book),
 *                 live KPI tallies + gross revenue, and a streaming activity
 *                 feed derived from the delta stream + audit log. Read-only.
 *   - **block** — bulk-first block/unblock: marquee-drag, ⌘A select-all,
 *                 whole-category / whole-section select, single-seat fallback →
 *                 one batched block/unblock (optimistic, reconciled by the WS),
 *                 timed auto-release, and cancel-a-booking.
 *
 * Auth: reads (chart/objects/WS) are public; writes/reports carry a Bearer
 * event-scoped manage token (`mse_…`) or a tenant secret key (`sk_…`) via
 * {@link ManageApi}. Box office + Sections + full Reports UI are M2/M3.
 */
import {
  SeatmapRenderer,
  expandChart,
  computeSections,
  UNGROUPED_ID,
  type ChartDoc,
  type ChartTheme,
  type ExpandedSeat,
  type SeatStatus,
} from '@seatlayer/core';
import { ManageApi, ManageApiError, type LogEntry, type ReportResult } from './manageApi';

export type SeatManagerMode = 'view' | 'block';

/** DO seat status — 'blocked' has no engine analogue (→ 'not_for_sale'). */
type DoStatus = 'free' | 'held' | 'booked' | 'blocked';

/** Live KPI snapshot pushed to `onTallies` on every state change. */
export interface SeatManagerTallies {
  free: number;
  held: number;
  booked: number;
  blocked: number;
  /** Total seats on the chart. */
  total: number;
  /** booked / total, 0–100. */
  capacityPct: number;
  /** booked / (total − blocked), 0–100 — sell-through of sellable inventory. */
  sellThroughPct: number;
  /** Σ price(booked seat), major units. */
  grossRevenue: number;
  /** ISO-4217 currency for grossRevenue. */
  currency: string;
}

/** One streamed activity line for the live feed. */
export interface SeatManagerActivity {
  id: string;
  at: number;
  label: string;
  /** Human verb: held / booked / released / blocked / unblocked. */
  verb: string;
  status: DoStatus;
}

/** Fired after a successful organizer action, for host toasts/telemetry. */
export interface SeatManagerActionResult {
  action: 'block' | 'unblock' | 'unblockAll' | 'cancelBooking' | 'setHoldTtl';
  labels: string[];
  count: number;
}

export interface SeatManagerOptions {
  /** CSS selector or element to mount into. */
  container: string | HTMLElement;
  /** API origin. Defaults to https://api.seatlayer.io. */
  apiBase?: string;
  /** Event key (e.g. `ev_xxx` / `west-end-p3`). */
  eventKey: string;
  /** Bearer manage token — event-scoped `mse_…` or a tenant secret `sk_…`. */
  token: string;
  /** Initial mode. Default 'view'. */
  mode?: SeatManagerMode;
  /** ISO-4217 fallback currency for revenue (chart/event currency wins). */
  currency?: string;
  /** Chart theme override for the chrome (rails/bar). Chart colors come from the doc. */
  theme?: ChartTheme;
  /**
   * Keep the canvas painting even when the tab is hidden/backgrounded (a war-room
   * board on a second monitor). Calls `forceDraw()` after each delta so Chrome's
   * rAF throttling on occluded tabs never leaves the board stale. Default true.
   */
  keepLiveWhileHidden?: boolean;
  /** Chart + first snapshot are loaded and the board is live. */
  onReady?: () => void;
  /** Live KPI tallies changed. */
  onTallies?: (tallies: SeatManagerTallies) => void;
  /** Block-mode selection changed (marquee / ⌘A / category / section / tap). */
  onSelectionChange?: (seats: ExpandedSeat[]) => void;
  /** A block/unblock/cancel action completed successfully. */
  onActionComplete?: (result: SeatManagerActionResult) => void;
  onError?: (err: unknown) => void;
}

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (!el) throw new Error(`seatmanager: container "${container}" not found`);
    return el as HTMLElement;
  }
  if (!(container instanceof HTMLElement)) {
    throw new Error('seatmanager: container must be a CSS selector or an HTMLElement');
  }
  return container;
}

/** 'blocked' → renderer 'not_for_sale'; the rest pass through. */
function toRenderStatus(s: DoStatus): SeatStatus {
  return s === 'blocked' ? 'not_for_sale' : s;
}

const DEFAULT_API_BASE = 'https://api.seatlayer.io';
const STYLE_ID = 'seatlayer-manager-style';
const FEED_CAP = 80;

const LEGEND: { key: 'free' | 'held' | 'booked' | 'blocked'; label: string; color: string }[] = [
  { key: 'free', label: 'Free', color: '#6e7bff' },
  { key: 'held', label: 'Held', color: '#f4b740' },
  { key: 'booked', label: 'Booked', color: '#22a06b' },
  { key: 'blocked', label: 'Blocked', color: '#8b94ac' },
];

const CSS = `
.slm{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:480px;overflow:hidden;
  background:var(--slm-bg);color:var(--slm-text);font-family:var(--slm-font);border-radius:var(--slm-radius)}
.slm *{box-sizing:border-box;margin:0;padding:0}
.slm button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.slm input{font:inherit}

/* top bar */
.slm-bar{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--slm-line);flex:none;flex-wrap:wrap}
.slm-modes{display:inline-flex;background:var(--slm-surface);border:1px solid var(--slm-line);border-radius:999px;padding:3px}
.slm-mode{padding:6px 16px;border-radius:999px;font-weight:700;font-size:13px;color:var(--slm-muted)}
.slm-mode.on{background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.12em;font-weight:800;color:var(--slm-muted)}
.slm-live-dot{width:8px;height:8px;border-radius:50%;background:#8b94ac}
.slm.live .slm-live-dot{background:#22a06b;box-shadow:0 0 0 0 rgba(34,160,107,.55);animation:slm-pulse 2s infinite}
@keyframes slm-pulse{0%{box-shadow:0 0 0 0 rgba(34,160,107,.5)}70%{box-shadow:0 0 0 7px rgba(34,160,107,0)}100%{box-shadow:0 0 0 0 rgba(34,160,107,0)}}
.slm-kpis{display:flex;align-items:center;gap:16px;margin-left:auto;flex-wrap:wrap}
.slm-kpi{display:flex;flex-direction:column;line-height:1.15}
.slm-kpi b{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums}
.slm-kpi span{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--slm-muted);font-weight:700}
.slm-kpi .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:baseline}
.slm-barbtn{padding:7px 13px;border-radius:9px;border:1px solid var(--slm-line);color:var(--slm-text);font-weight:700;font-size:12.5px}
.slm-barbtn:hover{border-color:var(--slm-muted)}

/* body */
.slm-body{display:flex;flex:1;min-height:0}
.slm-map{position:relative;flex:1;min-width:0}
.slm-map-host{position:absolute;inset:0}
.slm-hud{position:absolute;left:12px;bottom:12px;display:flex;gap:8px}
.slm-hud-chip{padding:6px 11px;border-radius:999px;font-size:12px;font-weight:700;background:var(--slm-surface);
  border:1px solid var(--slm-line);color:var(--slm-text)}
.slm-zoomhint{position:absolute;left:50%;top:14px;transform:translateX(-50%);padding:6px 13px;border-radius:999px;
  background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:700;pointer-events:none;opacity:0;transition:opacity .2s}
.slm-zoomhint.on{opacity:1}
.slm-rail{width:320px;flex:none;border-left:1px solid var(--slm-line);display:flex;flex-direction:column;min-height:0}
.slm-railscroll{flex:1;overflow-y:auto;padding:16px}
.slm-eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--slm-muted);font-weight:800;margin-bottom:6px}
.slm-hint{font-size:12.5px;color:var(--slm-muted);line-height:1.5;margin-bottom:14px}

/* legend rows */
.slm-legend{display:flex;flex-direction:column;gap:2px;margin-bottom:16px}
.slm-legrow{display:flex;align-items:center;gap:9px;padding:7px 2px;border-bottom:1px solid var(--slm-line)}
.slm-legdot{width:10px;height:10px;border-radius:50%;flex:none}
.slm-leglabel{flex:1;font-size:13px;font-weight:600}
.slm-legcount{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums}

/* activity feed */
.slm-feed{display:flex;flex-direction:column;gap:0}
.slm-feedrow{display:flex;align-items:center;gap:9px;padding:8px 2px;border-bottom:1px solid var(--slm-line);
  font-size:12.5px;animation:slm-in .35s ease}
@keyframes slm-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.slm-feeddot{width:8px;height:8px;border-radius:50%;flex:none}
.slm-feedtext{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slm-feedtext b{font-weight:800}
.slm-feedtime{font-size:11px;color:var(--slm-muted);font-variant-numeric:tabular-nums;flex:none}
.slm-empty{font-size:12.5px;color:var(--slm-muted);padding:12px 0}

/* block toolbar */
.slm-selbar{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}
.slm-selnum{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums}
.slm-sellabel{font-size:12px;color:var(--slm-muted);font-weight:600}
.slm-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.slm-btn{flex:1;min-width:120px;padding:10px 14px;border-radius:10px;background:var(--slm-accent);color:var(--slm-accent-ink);
  font-weight:800;font-size:13px;text-align:center}
.slm-btn:disabled{opacity:.45;cursor:not-allowed}
.slm-btn.ghost{background:var(--slm-surface);border:1px solid var(--slm-line);color:var(--slm-text)}
.slm-btn.danger{background:#c0392b;color:#fff}
.slm-chiprow{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.slm-chip{padding:6px 11px;border-radius:999px;border:1px solid var(--slm-line);background:var(--slm-surface);
  font-size:12px;font-weight:700;color:var(--slm-text);display:inline-flex;align-items:center;gap:6px}
.slm-chip:hover{border-color:var(--slm-muted)}
.slm-chip .dot{width:8px;height:8px;border-radius:50%}
.slm-field{margin:14px 0}
.slm-field label{display:block;font-size:11px;font-weight:700;color:var(--slm-muted);margin-bottom:5px}
.slm-input,.slm-select{width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--slm-line);
  background:var(--slm-surface);color:var(--slm-text)}
.slm-note{font-size:11.5px;color:var(--slm-muted);margin-top:5px}

/* toast */
.slm-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:10px 16px;border-radius:10px;
  font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;pointer-events:none;transition:opacity .2s;
  background:var(--slm-surface);color:var(--slm-text);border:1px solid var(--slm-line);z-index:5}
.slm-toast.on{opacity:1}
.slm-toast.err{background:#c0392b;color:#fff;border-color:#c0392b}
.slm-toast.ok{background:#1f7a4d;color:#fff;border-color:#1f7a4d}

@media (max-width:720px){.slm-rail{width:100%;border-left:0;border-top:1px solid var(--slm-line);height:44%}.slm-body{flex-direction:column}}
`;

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Resolve chrome tokens from a chart theme (dark war-room defaults). */
function themeVars(theme: ChartTheme | undefined): Record<string, string> {
  const t = theme ?? {};
  return {
    '--slm-bg': t.background ?? '#0e1017',
    '--slm-surface': '#181b24',
    '--slm-text': '#eef1f7',
    '--slm-muted': '#8b93a7',
    '--slm-line': 'rgba(255,255,255,.09)',
    '--slm-accent': t.accent ?? '#6e7bff',
    '--slm-accent-ink': t.accentInk ?? '#ffffff',
    '--slm-font': "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    '--slm-radius': '14px',
  };
}

function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
}

export class SeatManager {
  private readonly opts: SeatManagerOptions;
  private readonly api: ManageApi;
  private readonly key: string;
  private readonly keepLive: boolean;

  private host: HTMLElement;
  private root!: HTMLDivElement;
  private mapHost!: HTMLDivElement;
  private els: Record<string, HTMLElement> = {};

  private renderer: SeatmapRenderer | null = null;
  private doc: ChartDoc | null = null;
  private mode: SeatManagerMode;

  // label ⇄ id + status truth (backend speaks labels, engine speaks ids).
  private labelToId = new Map<string, string>();
  private labelToSeat = new Map<string, ExpandedSeat>();
  private allIds: string[] = [];
  private status = new Map<string, DoStatus>();
  private priceByCat = new Map<string, number>();
  private currency = 'USD';

  // realtime socket
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private ready = false;

  private feed: SeatManagerActivity[] = [];
  private feedTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseAt: number | null = null;

  constructor(options: SeatManagerOptions) {
    this.opts = options;
    this.key = options.eventKey;
    this.mode = options.mode ?? 'view';
    this.keepLive = options.keepLiveWhileHidden ?? true;
    this.currency = options.currency ?? 'USD';
    this.api = new ManageApi(options.apiBase ?? DEFAULT_API_BASE, options.token);
    this.host = resolveContainer(options.container);
  }

  /** Build the DOM, load the chart, subscribe to realtime, mount the board. */
  async render(): Promise<this> {
    injectStyle();
    this.buildChrome();
    try {
      const res = await this.api.chart(this.key);
      this.doc = res.doc;
      this.currency = res.event.currency ?? this.opts.currency ?? this.currency;
      for (const cat of res.doc.categories) this.priceByCat.set(cat.key, cat.price ?? 0);
      const seats = expandChart(res.doc);
      for (const s of seats) {
        this.labelToId.set(s.label, s.id);
        this.labelToSeat.set(s.label, s);
        this.allIds.push(s.id);
      }
      this.buildRenderer();
      this.buildSectionOptions();
      await this.resnapshot();
      // Seed the activity feed from the audit log (best-effort; token-gated).
      this.api.log(this.key, { limit: 24 }).then((page) => this.seedFeed(page.entries)).catch(() => {});
      this.connect();
      this.startFeedClock();
      this.ready = true;
      this.setMode(this.mode); // paint the right rail
      this.opts.onReady?.();
    } catch (err) {
      this.fail(err);
    }
    return this;
  }

  // ---- public API -----------------------------------------------------------

  setMode(mode: SeatManagerMode): void {
    const changed = mode !== this.mode || !this.renderer;
    this.mode = mode;
    if (changed && this.doc) this.buildRenderer();
    this.paintModeTabs();
    this.paintRail();
  }

  /** Bulk block the given labels (or the current selection when omitted). */
  async block(labels?: string[], opts: { releaseAt?: number; reason?: string } = {}): Promise<void> {
    const targets = (labels ?? this.selectionLabels()).filter((l) => this.status.get(l) === 'free');
    if (!targets.length) return;
    const releaseAt = opts.releaseAt ?? this.releaseAt ?? undefined;
    // optimistic
    for (const l of targets) this.setSeatLocal(l, 'blocked');
    try {
      await this.api.block(this.key, targets, { ...opts, releaseAt });
      this.clearSelection();
      this.done('block', targets, releaseAt
        ? `Blocked ${targets.length} — auto-release ${new Date(releaseAt).toLocaleString()}.`
        : `Blocked ${targets.length} seat${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      for (const l of targets) this.setSeatLocal(l, 'free'); // revert
      this.toastErr(err instanceof ManageApiError && err.status === 409
        ? 'Some seats were just taken. Try again.'
        : "Couldn't block those seats.");
      this.opts.onError?.(err);
    }
  }

  async unblock(labels?: string[]): Promise<void> {
    const targets = (labels ?? this.selectionLabels()).filter((l) => this.status.get(l) === 'blocked');
    if (!targets.length) return;
    for (const l of targets) this.setSeatLocal(l, 'free');
    try {
      await this.api.unblock(this.key, targets);
      this.clearSelection();
      this.done('unblock', targets, `Unblocked ${targets.length} seat${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      for (const l of targets) this.setSeatLocal(l, 'blocked');
      this.toastErr("Couldn't unblock those seats.");
      this.opts.onError?.(err);
    }
  }

  async unblockAll(): Promise<void> {
    const blocked = [...this.status.entries()].filter(([, s]) => s === 'blocked').map(([l]) => l);
    if (!blocked.length) return;
    for (const l of blocked) this.setSeatLocal(l, 'free');
    try {
      const res = await this.api.unblockAll(this.key);
      this.done('unblockAll', blocked, `Unblocked ${res.freed} seat${res.freed === 1 ? '' : 's'}.`);
    } catch (err) {
      await this.resnapshot();
      this.toastErr("Couldn't mark everything for sale.");
      this.opts.onError?.(err);
    }
  }

  /** Cancel bookings (BOOKED → free), guarded by the original booking ref. */
  async cancelBooking(labels: string[], bookingRef: string): Promise<void> {
    const targets = labels.filter((l) => this.status.get(l) === 'booked');
    if (!targets.length || !bookingRef) return;
    for (const l of targets) this.setSeatLocal(l, 'free');
    try {
      await this.api.unbook(this.key, targets, bookingRef);
      this.clearSelection();
      this.done('cancelBooking', targets, `Cancelled ${targets.length} booking${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      for (const l of targets) this.setSeatLocal(l, 'booked');
      this.toastErr("Couldn't cancel that booking. Check the reference.");
      this.opts.onError?.(err);
    }
  }

  selectAll(): ExpandedSeat[] {
    const seats = this.renderer?.selectAllSelectable() ?? [];
    this.syncSelection();
    return seats;
  }

  selectSection(sectionId: string): ExpandedSeat[] {
    if (!this.renderer) return [];
    const seats = this.renderer.getSelectableInSection(sectionId);
    this.renderer.selectByLabels(seats.map((s) => s.label));
    this.syncSelection();
    return this.renderer.getSelection();
  }

  selectByLabels(labels: string[]): ExpandedSeat[] {
    const seats = this.renderer?.selectByLabels(labels) ?? [];
    this.syncSelection();
    return seats;
  }

  clearSelection(): void {
    this.renderer?.clearSelection();
    this.syncSelection();
  }

  getSelection(): ExpandedSeat[] {
    return this.renderer?.getSelection() ?? [];
  }

  getReport(): Promise<ReportResult> {
    return this.api.report(this.key);
  }

  getLog(opts: { limit?: number; before?: number } = {}): Promise<{ entries: LogEntry[]; nextBefore: number | null }> {
    return this.api.log(this.key, opts);
  }

  async setHoldTtl(ms: number | null): Promise<void> {
    try {
      await this.api.setHoldTtl(this.key, ms);
      this.done('setHoldTtl', [], ms ? `Checkout window set to ${Math.round(ms / 60000)} min.` : 'Checkout window reset.');
    } catch (err) {
      this.toastErr("Couldn't update the checkout window.");
      this.opts.onError?.(err);
    }
  }

  /** M2 — box-office booking from free seats. Stubbed (route is session-only today). */
  boxBook(_labels: string[], _bookingRef: string): Promise<void> {
    this.toastErr('Box office ships in a later milestone.');
    return Promise.resolve();
  }

  zoomToFit(): void {
    this.renderer?.zoomToFit();
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.feedTimer) clearInterval(this.feedTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.renderer?.destroy();
    this.renderer = null;
    if (this.root && this.root.parentNode === this.host) this.host.removeChild(this.root);
  }

  // ---- renderer lifecycle (rebuilt per mode, like ManageEventPage) ----------

  private buildRenderer(): void {
    if (!this.doc) return;
    this.renderer?.destroy();
    const block = this.mode === 'block';
    this.renderer = new SeatmapRenderer(this.mapHost, {
      manageMode: true,
      marqueeSelect: block,
      maxSelection: 1_000_000,
      selectableStatuses: block ? ['free', 'not_for_sale', 'booked'] : [],
      currency: this.currency,
      onSelect: () => this.syncSelection(),
      onDeselect: () => this.syncSelection(),
      onMarquee: () => this.syncSelection(),
      onViewChange: () => this.updateZoomHint(),
    });
    this.renderer.setChart(this.doc);
    this.repaintAll();
    this.updateZoomHint();
  }

  private repaintAll(): void {
    const r = this.renderer;
    if (!r) return;
    if (this.allIds.length) r.setStatus(this.allIds, 'free');
    const byStatus: Record<SeatStatus, string[]> = { free: [], held: [], booked: [], not_for_sale: [] };
    for (const [label, st] of this.status.entries()) {
      const id = this.labelToId.get(label);
      if (id) byStatus[toRenderStatus(st)].push(id);
    }
    (['held', 'booked', 'not_for_sale'] as SeatStatus[]).forEach((st) => {
      if (byStatus[st].length) r.setStatus(byStatus[st], st);
    });
  }

  // ---- realtime -------------------------------------------------------------

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
      this.setLive(true);
      void this.resnapshot();
    };
    ws.onmessage = (e) => this.onMessage(e);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setLive(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt++, 5), 15000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private onMessage(e: MessageEvent): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; seats?: Record<string, string>; changes?: { label: string; status: string }[] };
    if (m.type === 'hidden') return;
    if (m.seats && typeof m.seats === 'object') {
      this.applySnapshot(m.seats);
    } else if (Array.isArray(m.changes)) {
      const ids: string[] = [];
      for (const ch of m.changes) {
        const st = (['free', 'held', 'booked', 'blocked'].includes(ch.status) ? ch.status : 'free') as DoStatus;
        const prev = this.status.get(ch.label) ?? 'free';
        if (prev === st) continue;
        this.status.set(ch.label, st);
        const id = this.labelToId.get(ch.label);
        if (id) { this.renderer?.setStatus([id], toRenderStatus(st)); this.flash(id, st); ids.push(id); }
        this.pushActivity(ch.label, prev, st);
      }
      if (ids.length) this.afterPaint();
      this.recomputeTallies();
    }
  }

  private async resnapshot(): Promise<void> {
    try {
      const objs = await this.api.objects(this.key);
      this.applySnapshot(objs.seats);
    } catch {
      /* transient — the delta stream keeps us fresh */
    }
  }

  private applySnapshot(seats: Record<string, string>): void {
    const next = new Map<string, DoStatus>();
    for (const [label, st] of Object.entries(seats)) {
      next.set(label, (['free', 'held', 'booked', 'blocked'].includes(st) ? st : 'free') as DoStatus);
    }
    this.status = next;
    this.repaintAll();
    this.afterPaint();
    this.recomputeTallies();
  }

  /** Optimistic local write shared by delta stream + organizer actions. */
  private setSeatLocal(label: string, st: DoStatus): void {
    this.status.set(label, st);
    const id = this.labelToId.get(label);
    if (id) this.renderer?.setStatus([id], toRenderStatus(st));
    this.afterPaint();
    this.recomputeTallies();
  }

  /** Keep the canvas painting on hidden/occluded tabs (war-room second monitor). */
  private afterPaint(): void {
    if (this.keepLive && typeof document !== 'undefined' && document.hidden) {
      this.renderer?.forceDraw();
    }
  }

  private flash(id: string, st: DoStatus): void {
    if (st === 'held') this.renderer?.flashSeat(id, '#f4b740');
    else if (st === 'booked') this.renderer?.flashSeat(id, '#22a06b');
  }

  // ---- tallies + feed -------------------------------------------------------

  private recomputeTallies(): void {
    const t: SeatManagerTallies = {
      free: 0, held: 0, booked: 0, blocked: 0,
      total: this.allIds.length, capacityPct: 0, sellThroughPct: 0,
      grossRevenue: 0, currency: this.currency,
    };
    // free = total − (held+booked+blocked); the snapshot only carries non-free.
    let nonFree = 0;
    for (const [label, st] of this.status.entries()) {
      t[st] += 1;
      if (st !== 'free') nonFree += 1;
      if (st === 'booked') {
        const seat = this.labelToSeat.get(label);
        if (seat) t.grossRevenue += this.priceByCat.get(seat.categoryKey) ?? 0;
      }
    }
    t.free = Math.max(0, t.total - nonFree);
    t.capacityPct = t.total ? Math.round((t.booked / t.total) * 100) : 0;
    const sellable = t.total - t.blocked;
    t.sellThroughPct = sellable > 0 ? Math.round((t.booked / sellable) * 100) : 0;
    this.paintKpis(t);
    if (this.mode === 'view') this.paintLegend(t);
    this.opts.onTallies?.(t);
  }

  private verbFor(prev: DoStatus, next: DoStatus): string {
    if (next === 'held') return 'held';
    if (next === 'booked') return 'booked';
    if (next === 'blocked') return 'blocked';
    if (next === 'free') return prev === 'blocked' ? 'unblocked' : prev === 'booked' ? 'cancelled' : 'released';
    return next;
  }

  private pushActivity(label: string, prev: DoStatus, next: DoStatus): void {
    const item: SeatManagerActivity = {
      id: `${label}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
      label,
      verb: this.verbFor(prev, next),
      status: next,
    };
    this.feed.unshift(item);
    if (this.feed.length > FEED_CAP) this.feed.length = FEED_CAP;
    if (this.mode === 'view') this.paintFeed();
  }

  private seedFeed(entries: LogEntry[]): void {
    const verbByAction: Record<string, string> = {
      hold: 'held', book: 'booked', release: 'released', expire: 'expired', block: 'blocked', unblock: 'unblocked',
    };
    const stByAction: Record<string, DoStatus> = {
      hold: 'held', book: 'booked', release: 'free', expire: 'free', block: 'blocked', unblock: 'free',
    };
    for (const e of entries) {
      const label = e.labels[0];
      if (!label) continue;
      const extra = e.labels.length > 1 ? ` +${e.labels.length - 1}` : '';
      this.feed.push({
        id: `log:${e.id}`,
        at: e.at,
        label: label + extra,
        verb: verbByAction[e.action] ?? e.action,
        status: stByAction[e.action] ?? 'free',
      });
    }
    this.feed.sort((a, b) => b.at - a.at);
    if (this.feed.length > FEED_CAP) this.feed.length = FEED_CAP;
    if (this.mode === 'view') this.paintFeed();
  }

  private startFeedClock(): void {
    this.feedTimer = setInterval(() => { if (this.mode === 'view') this.paintFeed(); }, 10000);
  }

  // ---- selection ------------------------------------------------------------

  private selectionLabels(): string[] {
    return this.getSelection().map((s) => s.label);
  }

  private syncSelection(): void {
    const seats = this.getSelection();
    if (this.mode === 'block') this.paintSelBar(seats);
    this.opts.onSelectionChange?.(seats);
  }

  // ---- DOM: chrome ----------------------------------------------------------

  private buildChrome(): void {
    const root = document.createElement('div');
    root.className = 'slm';
    const vars = themeVars(this.opts.theme);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.innerHTML = `
      <div class="slm-bar">
        <div class="slm-modes" data-ref="modes">
          <button class="slm-mode" data-mode="view">View</button>
          <button class="slm-mode" data-mode="block">Block</button>
        </div>
        <span class="slm-live"><span class="slm-live-dot"></span><span data-ref="livetext">CONNECTING</span></span>
        <div class="slm-kpis" data-ref="kpis"></div>
      </div>
      <div class="slm-body">
        <div class="slm-map">
          <div class="slm-map-host" data-ref="maphost"></div>
          <div class="slm-zoomhint" data-ref="zoomhint">Zoom in to marquee-select</div>
          <div class="slm-hud"><button class="slm-hud-chip" data-ref="zfit">Zoom to fit</button></div>
        </div>
        <aside class="slm-rail"><div class="slm-railscroll" data-ref="rail"></div></aside>
      </div>
      <div class="slm-toast" data-ref="toast"></div>
    `;
    this.host.appendChild(root);
    this.root = root;
    const ref = (n: string) => root.querySelector(`[data-ref="${n}"]`) as HTMLElement;
    this.mapHost = ref('maphost') as HTMLDivElement;
    this.els = {
      modes: ref('modes'), livetext: ref('livetext'), kpis: ref('kpis'),
      zoomhint: ref('zoomhint'), rail: ref('rail'), toast: ref('toast'), zfit: ref('zfit'),
    };
    this.els.modes.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.setMode((b as HTMLElement).dataset.mode as SeatManagerMode)));
    this.els.zfit.addEventListener('click', () => this.zoomToFit());
    this.paintModeTabs();
  }

  private sectionOptions: { id: string; label: string }[] = [];

  private buildSectionOptions(): void {
    if (!this.doc) return;
    try {
      const secs = computeSections(this.doc);
      for (const s of secs.sections) this.sectionOptions.push({ id: s.id, label: s.label });
      if (secs.ungrouped) this.sectionOptions.push({ id: UNGROUPED_ID, label: secs.ungrouped.label });
    } catch { /* no sections */ }
  }

  private paintModeTabs(): void {
    this.els.modes?.querySelectorAll('[data-mode]').forEach((b) => {
      const el = b as HTMLElement;
      el.classList.toggle('on', el.dataset.mode === this.mode);
    });
    this.root?.classList.toggle('block-mode', this.mode === 'block');
  }

  private setLive(on: boolean): void {
    this.root?.classList.toggle('live', on);
    if (this.els.livetext) this.els.livetext.textContent = on ? 'LIVE' : 'RECONNECTING';
  }

  private updateZoomHint(): void {
    const hint = this.els.zoomhint;
    if (!hint) return;
    const show = this.mode === 'block' && this.renderer?.getRung?.() !== 'seats';
    hint.classList.toggle('on', !!show);
  }

  private paintKpis(t: SeatManagerTallies): void {
    if (!this.els.kpis) return;
    const rev = fmtMoney(t.grossRevenue, t.currency);
    this.els.kpis.innerHTML = [
      { n: t.booked.toLocaleString(), l: 'Sold', dot: '#22a06b' },
      { n: t.held.toLocaleString(), l: 'Held', dot: '#f4b740' },
      { n: t.free.toLocaleString(), l: 'Free', dot: '#6e7bff' },
      { n: t.blocked.toLocaleString(), l: 'Blocked', dot: '#8b94ac' },
      { n: `${t.capacityPct}%`, l: 'Capacity' },
      { n: rev, l: 'Gross' },
    ].map((k) => `<div class="slm-kpi"><b>${k.dot ? `<span class="dot" style="background:${k.dot}"></span>` : ''}${k.n}</b><span>${k.l}</span></div>`).join('');
  }

  // ---- DOM: rails -----------------------------------------------------------

  private paintRail(): void {
    if (this.mode === 'view') this.renderViewRail();
    else this.renderBlockRail();
    this.updateZoomHint();
  }

  private renderViewRail(): void {
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">Live board</p>
      <p class="slm-hint">Read-only. Seats repaint and flash as buyers hold and book — watch your event breathe.</p>
      <div class="slm-legend" data-ref="legend"></div>
      <p class="slm-eyebrow">Activity</p>
      <div class="slm-feed" data-ref="feed"></div>
    `;
    this.els.legend = this.els.rail.querySelector('[data-ref="legend"]') as HTMLElement;
    this.els.feed = this.els.rail.querySelector('[data-ref="feed"]') as HTMLElement;
    this.recomputeTallies();
    this.paintFeed();
  }

  private paintLegend(t: SeatManagerTallies): void {
    if (!this.els.legend) return;
    this.els.legend.innerHTML = LEGEND.map((l) =>
      `<div class="slm-legrow"><span class="slm-legdot" style="background:${l.color}"></span>
        <span class="slm-leglabel">${l.label}</span><span class="slm-legcount">${t[l.key].toLocaleString()}</span></div>`).join('');
  }

  private paintFeed(): void {
    if (!this.els.feed) return;
    if (!this.feed.length) { this.els.feed.innerHTML = `<div class="slm-empty">No activity yet — it'll stream in live.</div>`; return; }
    const now = Date.now();
    const color: Record<DoStatus, string> = { free: '#6e7bff', held: '#f4b740', booked: '#22a06b', blocked: '#8b94ac' };
    this.els.feed.innerHTML = this.feed.map((a) =>
      `<div class="slm-feedrow"><span class="slm-feeddot" style="background:${color[a.status]}"></span>
        <span class="slm-feedtext">Seat <b>${a.label}</b> ${a.verb}</span>
        <span class="slm-feedtime">${relTime(a.at, now)}</span></div>`).join('');
  }

  private renderBlockRail(): void {
    const cats = this.doc?.categories ?? [];
    const catChips = cats.map((c) =>
      `<button class="slm-chip" data-cat="${c.key}"><span class="dot" style="background:${c.color ?? '#6e7bff'}"></span>${c.label ?? c.key}</button>`).join('');
    const sectionField = this.sectionOptions.length
      ? `<div class="slm-field"><label>Select a whole section</label>
          <select class="slm-select" data-ref="section"><option value="">Choose a section…</option>
          ${this.sectionOptions.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select></div>`
      : '';
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">Block &amp; cancel</p>
      <p class="slm-hint">Drag a box on the map to marquee-select, ⌘A for all, or pick a category/section — then block, unblock, or cancel bookings in one action.</p>
      <div class="slm-selbar"><span class="slm-selnum" data-ref="selnum">0</span><span class="slm-sellabel">selected</span></div>
      <div class="slm-row">
        <button class="slm-btn" data-ref="doblock" disabled>Block</button>
        <button class="slm-btn ghost" data-ref="dounblock" disabled>Unblock</button>
      </div>
      <div class="slm-row">
        <button class="slm-btn ghost" data-ref="selall">Select all</button>
        <button class="slm-btn ghost" data-ref="clearsel">Clear</button>
        <button class="slm-btn danger" data-ref="docancel" disabled>Cancel booking</button>
      </div>
      <p class="slm-eyebrow" style="margin-top:8px">By category</p>
      <div class="slm-chiprow">${catChips || '<span class="slm-empty">No categories.</span>'}</div>
      ${sectionField}
      <div class="slm-field">
        <label>Auto-release blocks at (optional)</label>
        <input type="datetime-local" class="slm-input" data-ref="release" />
        <p class="slm-note" data-ref="releasenote">Leave empty to block permanently.</p>
      </div>
      <div class="slm-row"><button class="slm-btn ghost" data-ref="markall" style="flex:1">Mark everything for sale</button></div>
    `;
    const r = (n: string) => this.els.rail.querySelector(`[data-ref="${n}"]`) as HTMLElement;
    this.els.selnum = r('selnum'); this.els.doblock = r('doblock'); this.els.dounblock = r('dounblock');
    this.els.docancel = r('docancel');
    r('doblock').addEventListener('click', () => void this.block());
    r('dounblock').addEventListener('click', () => void this.unblock());
    r('docancel').addEventListener('click', () => this.promptCancel());
    r('selall').addEventListener('click', () => this.selectAll());
    r('clearsel').addEventListener('click', () => this.clearSelection());
    r('markall').addEventListener('click', () => void this.unblockAll());
    this.els.rail.querySelectorAll('[data-cat]').forEach((b) =>
      b.addEventListener('click', () => this.selectCategory((b as HTMLElement).dataset.cat!)));
    const sectionSel = this.els.rail.querySelector('[data-ref="section"]') as HTMLSelectElement | null;
    sectionSel?.addEventListener('change', () => { if (sectionSel.value) { this.selectSection(sectionSel.value); sectionSel.value = ''; } });
    const rel = r('release') as HTMLInputElement;
    rel.addEventListener('change', () => {
      const ms = rel.value ? new Date(rel.value).getTime() : NaN;
      this.releaseAt = Number.isFinite(ms) && ms > Date.now() ? ms : null;
      const note = r('releasenote');
      note.textContent = this.releaseAt
        ? `New blocks auto-release ${new Date(this.releaseAt).toLocaleString()}.`
        : rel.value ? 'Pick a time in the future.' : 'Leave empty to block permanently.';
    });
    this.paintSelBar(this.getSelection());
  }

  private selectCategory(catKey: string): void {
    const labels: string[] = [];
    for (const [label, seat] of this.labelToSeat.entries()) if (seat.categoryKey === catKey) labels.push(label);
    this.selectByLabels(labels);
  }

  private promptCancel(): void {
    const booked = this.getSelection().filter((s) => this.status.get(s.label) === 'booked');
    if (!booked.length) return;
    if (typeof window === 'undefined') return;
    if (!window.confirm(`Cancel ${booked.length} booking${booked.length === 1 ? '' : 's'}? Seats return to sale (credit not refunded).`)) return;
    const ref = window.prompt('Enter the original booking reference to cancel safely:')?.trim();
    if (!ref) return;
    void this.cancelBooking(booked.map((s) => s.label), ref);
  }

  private paintSelBar(seats: ExpandedSeat[]): void {
    if (!this.els.selnum) return;
    this.els.selnum.textContent = seats.length.toLocaleString();
    const hasFree = seats.some((s) => this.status.get(s.label) === 'free');
    const hasBlocked = seats.some((s) => this.status.get(s.label) === 'blocked');
    const hasBooked = seats.some((s) => this.status.get(s.label) === 'booked');
    (this.els.doblock as HTMLButtonElement).disabled = !hasFree;
    (this.els.dounblock as HTMLButtonElement).disabled = !hasBlocked;
    (this.els.docancel as HTMLButtonElement).disabled = !hasBooked;
  }

  // ---- toast / done / fail --------------------------------------------------

  private done(action: SeatManagerActionResult['action'], labels: string[], msg: string): void {
    this.toastOk(msg);
    this.opts.onActionComplete?.({ action, labels, count: labels.length });
  }

  private toastOk(msg: string): void { this.toast(msg, 'ok'); }
  private toastErr(msg: string): void { this.toast(msg, 'err'); }

  private toast(msg: string, kind: 'ok' | 'err'): void {
    const el = this.els.toast;
    if (!el) return;
    el.textContent = msg;
    el.className = `slm-toast on ${kind}`;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.className = 'slm-toast'; }, 3200);
  }

  private fail(err: unknown): void {
    this.opts.onError?.(err);
    if (this.els.rail) this.els.rail.innerHTML = `<div class="slm-empty">Couldn't load this event. Check the event key and token.</div>`;
  }
}
