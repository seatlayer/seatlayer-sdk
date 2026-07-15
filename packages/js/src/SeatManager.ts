/**
 * SeatManager — the organizer manage surface, packaged for the SDK.
 *
 * Productizes the SeatLayer dashboard's ManageEventPage into a framework-
 * agnostic class (mirrors how SeatPicker productized the buyer flow). It mounts
 * the shared engine in `manageMode`, subscribes to the event's realtime channel
 * and drives three control-room tools on one persistent canvas:
 *
 *   - **view**  — a live board: realtime seat repaint (flash on hold/book),
 *                 live KPI tallies + gross revenue, and a streaming activity
 *                 feed derived from the delta stream + audit log. Read-only.
 *   - **inspect** — select one seat to read its live inventory context.
 *   - **block** — bulk-first block/unblock: marquee-drag, ⌘A select-all,
 *                 whole-category / whole-section select, single-seat fallback →
 *                 one batched block/unblock (optimistic, reconciled by the WS),
 *                 and timed auto-release.
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
import {
  ManageApi,
  ManageApiError,
  type ControlRoomSnapshot,
  type LogEntry,
  type ReportResult,
} from './manageApi';

export type SeatManagerMode = 'view' | 'inspect' | 'block';

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
  /** Exact Σ booked unit_price snapshots from the authenticated report. */
  grossRevenue: number;
  /** Revenue is never reconstructed from chart list price. */
  revenueStatus: 'loading' | 'current' | 'stale';
  /** ISO-4217 currency for grossRevenue. */
  currency: string;
}

/** One streamed activity line for the live feed. */
export interface SeatManagerActivity {
  id: string;
  at: number;
  label: string;
  /** Full labels affected by this one backend/realtime operation. */
  labels: string[];
  count: number;
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
  /** Absolute token expiry (epoch ms). Enables proactive in-place rotation. */
  tokenExpiresAt?: number;
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
  /** A grouped live/audit activity item arrived. */
  onActivity?: (activity: SeatManagerActivity) => void;
  /** Exact private control-room projection changed. */
  onControlRoom?: (snapshot: ControlRoomSnapshot) => void;
  /** Called before token expiry. The manager swaps the result without remounting. */
  onTokenRefresh?: () => Promise<{ token: string; expiresAt: number }>;
  /** Tool/mode changed from inside the shared cockpit. */
  onModeChange?: (mode: SeatManagerMode) => void;
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

/* control-room actions + insights */
.slm-bar-actions{display:flex;align-items:center;gap:7px}
.slm-barbtn.on{background:rgba(244,183,64,.13);border-color:#f4b740;color:#f7ca6b}
.slm-sectionlist{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.slm-sectionlist + .slm-eyebrow{margin-top:18px}
.slm-sectionrow{padding:10px;border:1px solid var(--slm-line);border-radius:10px;background:var(--slm-surface)}
.slm-sectiontop,.slm-sectionmeta{display:flex;align-items:center;justify-content:space-between;gap:10px}
.slm-sectiontop{font-size:12.5px;font-weight:800}.slm-sectionmeta{margin-top:5px;color:var(--slm-muted);font-size:11px}
.slm-trend{font-size:10px;text-transform:uppercase;letter-spacing:.08em}.slm-trend.rising{color:#22a06b}.slm-trend.cooling{color:#f4b740}
.slm-health{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.slm-healthitem{padding:10px;border:1px solid var(--slm-line);border-radius:10px;background:var(--slm-surface)}
.slm-healthitem b{display:block;font-size:17px;font-variant-numeric:tabular-nums}.slm-healthitem span{display:block;margin-top:2px;color:var(--slm-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
.slm-sectionhead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-top:18px}
.slm-windows{display:flex;gap:3px;padding:2px;border:1px solid var(--slm-line);border-radius:8px;background:var(--slm-surface)}
.slm-window{padding:4px 6px;border-radius:6px;font-size:10px;font-weight:800;color:var(--slm-muted)}.slm-window.on{background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-momentumhelp{margin:10px 0 14px;padding:10px;border:1px solid rgba(244,183,64,.28);border-radius:10px;background:rgba(244,183,64,.07)}
.slm-momentumhelp[hidden]{display:none}.slm-momentumscale{display:flex;align-items:center;gap:7px;color:var(--slm-muted);font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.07em}
.slm-momentumgradient{height:6px;min-width:64px;flex:1;border-radius:999px;background:linear-gradient(90deg,#f4b740,#ef4444)}
.slm-momentumcopy{margin-top:7px;color:var(--slm-muted);font-size:11px;line-height:1.45}
.slm-inspect-card{padding:12px;border:1px solid var(--slm-line);border-radius:12px;background:var(--slm-surface)}
.slm-inspect-label{font-size:24px;font-weight:850;letter-spacing:-.02em}.slm-inspect-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.slm-inspect-grid span{display:block;color:var(--slm-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.slm-inspect-grid b{display:block;margin-top:3px;font-size:12.5px}
.slm:fullscreen{border-radius:0;min-height:100vh;background:var(--slm-bg)}
.slm:fullscreen .slm-bar{padding:14px 22px}.slm:fullscreen .slm-kpi b{font-size:21px}.slm:fullscreen .slm-rail{width:360px}

.slm.compact .slm-rail{width:100%;border-left:0;border-top:1px solid var(--slm-line);height:44%}
.slm.compact .slm-body{flex-direction:column}
.slm.compact .slm-bar{gap:8px;padding:8px}.slm.compact .slm-barbtn{padding:6px 9px}
.slm.compact .slm-kpis{gap:9px}.slm.compact .slm-kpi:nth-child(n+5){display:none}
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

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
  private currency = 'USD';
  private authoritativeGrossRevenue = 0;
  private revenueStatus: SeatManagerTallies['revenueStatus'] = 'loading';
  private revenueRequest = 0;
  private revenueRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private controlRoomSnapshot: ControlRoomSnapshot | null = null;
  private trendWindowMinutes = 15;
  private heatEnabled = false;

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
  private layoutObserver: ResizeObserver | null = null;
  private tokenExpiresAt: number | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshInFlight = false;
  private sectionByObject = new Map<string, string>();
  private sectionLabelById = new Map<string, string>();
  private lastSyncedAt: number | null = null;

  private readonly onFullscreenChange = (): void => {
    this.paintFullscreenButton();
    this.updateContainerLayout();
    this.renderer?.forceDraw();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.matches('input,select,textarea,[contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'm') this.setMode('view');
    else if (key === 'i') this.setMode('inspect');
    else if (key === 'b') this.setMode('block');
    else if (key === 'f') this.toggleFullscreen();
    else return;
    event.preventDefault();
  };

  constructor(options: SeatManagerOptions) {
    this.opts = options;
    this.key = options.eventKey;
    this.mode = options.mode ?? 'view';
    this.keepLive = options.keepLiveWhileHidden ?? true;
    this.currency = options.currency ?? 'USD';
    this.tokenExpiresAt = options.tokenExpiresAt ?? null;
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
      const seats = expandChart(res.doc);
      for (const s of seats) {
        this.labelToId.set(s.label, s.id);
        this.labelToSeat.set(s.label, s);
        this.allIds.push(s.id);
      }
      this.buildRenderer();
      this.buildSectionOptions();
      await Promise.all([
        this.resnapshot(),
        this.refreshControlRoom().catch((err) => this.opts.onError?.(err)),
      ]);
      // Seed the activity feed from the audit log (best-effort; token-gated).
      this.api.log(this.key, { limit: 24 }).then((page) => this.seedFeed(page.entries)).catch(() => {});
      this.connect();
      this.startFeedClock();
      this.ready = true;
      this.setMode(this.mode); // paint the right rail
      this.scheduleTokenRefresh();
      this.opts.onReady?.();
    } catch (err) {
      this.fail(err);
    }
    return this;
  }

  // ---- public API -----------------------------------------------------------

  setMode(mode: SeatManagerMode): void {
    const changed = mode !== this.mode;
    this.mode = mode;
    if (!this.renderer && this.doc) this.buildRenderer();
    else this.updateRendererInteraction();
    if (changed) this.renderer?.clearSelection();
    this.paintModeTabs();
    this.paintRail();
    if (changed) this.opts.onModeChange?.(mode);
  }

  /** Toggle the normalized sales-velocity outline overlay without changing seat colors. */
  setHeatOverlay(enabled: boolean): void {
    this.heatEnabled = enabled;
    this.applyHeatOverlay();
    this.paintHeatButton();
  }

  /** Change the current-vs-previous sales window and refresh the private projection. */
  setTrendWindow(windowMinutes: number): Promise<ControlRoomSnapshot> {
    const normalized = Number.isFinite(windowMinutes) ? Math.floor(windowMinutes) : 15;
    this.trendWindowMinutes = Math.max(5, Math.min(60, normalized));
    this.paintTrendWindow();
    return this.refreshControlRoom();
  }

  async enterFullscreen(): Promise<void> {
    if (!this.root?.requestFullscreen || this.isFullscreen()) return;
    await this.root.requestFullscreen();
    this.root.focus({ preventScroll: true });
  }

  async exitFullscreen(): Promise<void> {
    if (typeof document === 'undefined' || !this.isFullscreen()) return;
    await document.exitFullscreen();
  }

  isFullscreen(): boolean {
    return typeof document !== 'undefined' && document.fullscreenElement === this.root;
  }

  private toggleFullscreen(): void {
    const request = this.isFullscreen() ? this.exitFullscreen() : this.enterFullscreen();
    void request.catch((err) => this.opts.onError?.(err));
  }

  /** Rotate the delegated credential without rebuilding DOM, canvas or socket. */
  setToken(token: string, expiresAt?: number): void {
    this.api.setToken(token);
    this.tokenExpiresAt = expiresAt ?? null;
    this.scheduleTokenRefresh();
  }

  private scheduleTokenRefresh(): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = null;
    const refresh = this.opts.onTokenRefresh;
    const expiresAt = this.tokenExpiresAt;
    if (this.closed || !refresh || !expiresAt || !Number.isFinite(expiresAt)) return;
    const remaining = expiresAt - Date.now();
    const lead = Math.min(120_000, Math.max(30_000, remaining * 0.2));
    const delay = Math.max(0, remaining - lead);
    this.tokenRefreshTimer = setTimeout(() => {
      this.tokenRefreshTimer = null;
      void this.rotateToken();
    }, delay);
  }

  private async rotateToken(): Promise<void> {
    if (this.closed || this.tokenRefreshInFlight || !this.opts.onTokenRefresh) return;
    this.tokenRefreshInFlight = true;
    try {
      const next = await this.opts.onTokenRefresh();
      if (!next?.token || !Number.isFinite(next.expiresAt)) throw new Error('invalid_token_refresh_result');
      this.setToken(next.token, next.expiresAt);
    } catch (err) {
      this.opts.onError?.(err);
      if (!this.closed) {
        this.tokenRefreshTimer = setTimeout(() => {
          this.tokenRefreshTimer = null;
          void this.rotateToken();
        }, 30_000);
      }
    } finally {
      this.tokenRefreshInFlight = false;
    }
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
    return this.api.report(this.key).then((report) => {
      this.applyReportRevenue(report);
      return report;
    });
  }

  getControlRoomSnapshot(windowMinutes = this.trendWindowMinutes): Promise<ControlRoomSnapshot> {
    return this.setTrendWindow(windowMinutes);
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
    if (this.revenueRefreshTimer) clearTimeout(this.revenueRefreshTimer);
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.root?.removeEventListener('keydown', this.onKeyDown);
    if (typeof document !== 'undefined') document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.renderer?.destroy();
    this.renderer = null;
    if (this.root && this.root.parentNode === this.host) this.host.removeChild(this.root);
  }

  // ---- renderer lifecycle ---------------------------------------------------

  private buildRenderer(): void {
    if (!this.doc) return;
    const block = this.mode === 'block';
    const inspect = this.mode === 'inspect';
    this.renderer = new SeatmapRenderer(this.mapHost, {
      manageMode: true,
      marqueeSelect: block,
      maxSelection: 1_000_000,
      selectableStatuses: block
        ? ['free', 'not_for_sale']
        : inspect ? ['free', 'held', 'booked', 'not_for_sale'] : [],
      currency: this.currency,
      onSelect: (seat) => this.handleSeatSelect(seat),
      onDeselect: () => this.syncSelection(),
      onMarquee: () => this.syncSelection(),
      onViewChange: () => this.updateZoomHint(),
    });
    this.renderer.setChart(this.doc);
    this.repaintAll();
    this.applyHeatOverlay();
    this.updateZoomHint();
  }

  private updateRendererInteraction(): void {
    const block = this.mode === 'block';
    const inspect = this.mode === 'inspect';
    this.renderer?.setManageInteraction({
      manageMode: true,
      marqueeSelect: block,
      maxSelection: 1_000_000,
      selectableStatuses: block
        ? ['free', 'not_for_sale']
        : inspect ? ['free', 'held', 'booked', 'not_for_sale'] : [],
    });
    this.updateZoomHint();
  }

  private handleSeatSelect(seat: ExpandedSeat): void {
    if (this.mode === 'inspect') {
      const others = this.getSelection()
        .filter((selected) => selected.id !== seat.id)
        .map((selected) => selected.id);
      if (others.length) this.renderer?.deselect(others);
    }
    this.syncSelection();
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
      void this.resnapshot().then(() => this.scheduleRevenueRefresh(0));
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
    const m = msg as {
      type?: string;
      seats?: Record<string, string>;
      changes?: { label: string; status: string }[];
      shoppingSessions?: number;
      activeHolds?: number;
    };
    if (m.type === 'presence') {
      if (
        this.controlRoomSnapshot &&
        typeof m.shoppingSessions === 'number' &&
        typeof m.activeHolds === 'number'
      ) {
        this.controlRoomSnapshot = {
          ...this.controlRoomSnapshot,
          presence: { shoppingSessions: m.shoppingSessions, activeHolds: m.activeHolds },
        };
        this.lastSyncedAt = Date.now();
        this.recomputeTallies();
        this.paintMonitorInsights();
        this.opts.onControlRoom?.(this.controlRoomSnapshot);
      }
      return;
    }
    if (m.type === 'hidden') return;
    if (m.seats && typeof m.seats === 'object') {
      this.applySnapshot(m.seats);
    } else if (Array.isArray(m.changes)) {
      const ids: string[] = [];
      const groups = new Map<string, { labels: string[]; verb: string; status: DoStatus }>();
      for (const ch of m.changes) {
        const st = (['free', 'held', 'booked', 'blocked'].includes(ch.status) ? ch.status : 'free') as DoStatus;
        const prev = this.status.get(ch.label) ?? 'free';
        if (prev === st) continue;
        this.status.set(ch.label, st);
        const id = this.labelToId.get(ch.label);
        if (id) { this.renderer?.setStatus([id], toRenderStatus(st)); this.flash(id, st); ids.push(id); }
        const verb = this.verbFor(prev, st);
        const groupKey = `${verb}:${st}`;
        const group = groups.get(groupKey) ?? { labels: [], verb, status: st };
        group.labels.push(ch.label);
        groups.set(groupKey, group);
      }
      for (const group of groups.values()) this.pushActivity(group.labels, group.verb, group.status);
      if (ids.length) {
        this.lastSyncedAt = Date.now();
        this.afterPaint();
      }
      this.recomputeTallies();
      if (ids.length) this.scheduleRevenueRefresh();
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
    this.lastSyncedAt = Date.now();
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

  private applyReportRevenue(report: ReportResult): void {
    this.authoritativeGrossRevenue = report.report.byCategory.reduce(
      (sum, row) => sum + (Number.isFinite(row.bookedRevenue) ? row.bookedRevenue : 0),
      0,
    );
    this.revenueStatus = 'current';
    this.recomputeTallies();
  }

  private async refreshControlRoom(): Promise<ControlRoomSnapshot> {
    const request = ++this.revenueRequest;
    try {
      const snapshot = await this.api.controlRoom(this.key, this.trendWindowMinutes);
      if (request === this.revenueRequest) {
        this.controlRoomSnapshot = snapshot;
        this.lastSyncedAt = Date.now();
        this.authoritativeGrossRevenue = snapshot.revenue.gross;
        this.currency = snapshot.currency;
        this.revenueStatus = 'current';
        this.recomputeTallies();
        this.applyHeatOverlay();
        this.paintMonitorInsights();
        this.opts.onControlRoom?.(snapshot);
      }
      return snapshot;
    } catch (err) {
      if (request === this.revenueRequest) {
        this.revenueStatus = 'stale';
        this.recomputeTallies();
      }
      throw err;
    }
  }

  private scheduleRevenueRefresh(delay = 140): void {
    this.revenueStatus = 'stale';
    this.recomputeTallies();
    if (this.revenueRefreshTimer) clearTimeout(this.revenueRefreshTimer);
    this.revenueRefreshTimer = setTimeout(() => {
      this.revenueRefreshTimer = null;
      void this.refreshControlRoom().catch((err) => this.opts.onError?.(err));
    }, delay);
  }

  private recomputeTallies(): void {
    const t: SeatManagerTallies = {
      free: 0, held: 0, booked: 0, blocked: 0,
      total: this.allIds.length, capacityPct: 0, sellThroughPct: 0,
      grossRevenue: this.authoritativeGrossRevenue,
      revenueStatus: this.revenueStatus,
      currency: this.currency,
    };
    // free = total − (held+booked+blocked); the snapshot only carries non-free.
    let nonFree = 0;
    for (const st of this.status.values()) {
      t[st] += 1;
      if (st !== 'free') nonFree += 1;
    }
    t.free = Math.max(0, t.total - nonFree);
    t.capacityPct = t.total ? Math.round((t.booked / t.total) * 100) : 0;
    const sellable = t.total - t.blocked;
    t.sellThroughPct = sellable > 0 ? Math.round((t.booked / sellable) * 100) : 0;
    this.paintKpis(t);
    if (this.mode === 'view') {
      this.paintLegend(t);
      this.paintMonitorInsights();
    } else if (this.mode === 'inspect') this.renderInspectRail(this.getSelection());
    this.opts.onTallies?.(t);
  }

  private verbFor(prev: DoStatus, next: DoStatus): string {
    if (next === 'held') return 'held';
    if (next === 'booked') return 'booked';
    if (next === 'blocked') return 'blocked';
    if (next === 'free') return prev === 'blocked' ? 'unblocked' : prev === 'booked' ? 'cancelled' : 'released';
    return next;
  }

  private pushActivity(labels: string[], verb: string, status: DoStatus, at = Date.now()): void {
    const label = labels[0];
    if (!label) return;
    const item: SeatManagerActivity = {
      id: `${label}:${at}:${Math.random().toString(36).slice(2, 6)}`,
      at,
      label,
      labels: [...labels],
      count: labels.length,
      verb,
      status,
    };
    this.feed.unshift(item);
    if (this.feed.length > FEED_CAP) this.feed.length = FEED_CAP;
    if (this.mode === 'view') this.paintFeed();
    this.opts.onActivity?.(item);
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
      const item: SeatManagerActivity = {
        id: `log:${e.id}`,
        at: e.at,
        label,
        labels: [...e.labels],
        count: e.labels.length,
        verb: verbByAction[e.action] ?? e.action,
        status: stByAction[e.action] ?? 'free',
      };
      this.feed.push(item);
      this.opts.onActivity?.(item);
    }
    this.feed.sort((a, b) => b.at - a.at);
    if (this.feed.length > FEED_CAP) this.feed.length = FEED_CAP;
    if (this.mode === 'view') this.paintFeed();
  }

  private startFeedClock(): void {
    this.feedTimer = setInterval(() => {
      if (this.mode === 'view') {
        this.paintFeed();
        this.paintMonitorInsights();
      }
    }, 10000);
  }

  // ---- selection ------------------------------------------------------------

  private selectionLabels(): string[] {
    return this.getSelection().map((s) => s.label);
  }

  private syncSelection(): void {
    const seats = this.getSelection();
    if (this.mode === 'block') this.paintSelBar(seats);
    else if (this.mode === 'inspect') this.renderInspectRail(seats);
    this.opts.onSelectionChange?.(seats);
  }

  // ---- DOM: chrome ----------------------------------------------------------

  private buildChrome(): void {
    const root = document.createElement('div');
    root.className = 'slm';
    root.tabIndex = 0;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'SeatLayer live control room');
    const vars = themeVars(this.opts.theme);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.innerHTML = `
      <div class="slm-bar">
        <div class="slm-modes" data-ref="modes">
          <button class="slm-mode" data-mode="view" title="Monitor (M)" aria-keyshortcuts="M">Monitor</button>
          <button class="slm-mode" data-mode="inspect" title="Inspect (I)" aria-keyshortcuts="I">Inspect</button>
          <button class="slm-mode" data-mode="block" title="Block (B)" aria-keyshortcuts="B">Block</button>
        </div>
        <span class="slm-live"><span class="slm-live-dot"></span><span data-ref="livetext">CONNECTING</span></span>
        <div class="slm-bar-actions">
          <button class="slm-barbtn" data-ref="heat" aria-pressed="false"
            aria-label="Sales momentum overlay off"
            title="Highlight sections selling fastest in the selected time window">Sales momentum</button>
          <button class="slm-barbtn" data-ref="fullscreen" title="Full screen (F)" aria-keyshortcuts="F">Full screen</button>
        </div>
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
    this.updateContainerLayout();
    if (typeof ResizeObserver !== 'undefined') {
      this.layoutObserver = new ResizeObserver(() => this.updateContainerLayout());
      this.layoutObserver.observe(root);
    }
    const ref = (n: string) => root.querySelector(`[data-ref="${n}"]`) as HTMLElement;
    this.mapHost = ref('maphost') as HTMLDivElement;
    this.els = {
      modes: ref('modes'), livetext: ref('livetext'), kpis: ref('kpis'),
      heat: ref('heat'), fullscreen: ref('fullscreen'),
      zoomhint: ref('zoomhint'), rail: ref('rail'), toast: ref('toast'), zfit: ref('zfit'),
    };
    this.els.modes.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.setMode((b as HTMLElement).dataset.mode as SeatManagerMode)));
    this.els.zfit.addEventListener('click', () => this.zoomToFit());
    this.els.heat.addEventListener('click', () => this.setHeatOverlay(!this.heatEnabled));
    this.els.fullscreen.addEventListener('click', () => this.toggleFullscreen());
    root.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.paintModeTabs();
    this.paintHeatButton();
    this.paintFullscreenButton();
  }

  private updateContainerLayout(): void {
    const width = this.root?.getBoundingClientRect().width || this.host.clientWidth;
    this.root?.classList.toggle('compact', width > 0 && width < 800);
  }

  private sectionOptions: { id: string; label: string }[] = [];

  private buildSectionOptions(): void {
    if (!this.doc) return;
    try {
      const secs = computeSections(this.doc);
      this.sectionOptions = [];
      this.sectionByObject = new Map(secs.objectToSection);
      this.sectionLabelById.clear();
      for (const s of secs.sections) {
        this.sectionOptions.push({ id: s.id, label: s.label });
        this.sectionLabelById.set(s.id, s.label);
      }
      if (secs.ungrouped) {
        this.sectionOptions.push({ id: UNGROUPED_ID, label: secs.ungrouped.label });
        this.sectionLabelById.set(UNGROUPED_ID, secs.ungrouped.label);
      }
    } catch { /* no sections */ }
  }

  private paintModeTabs(): void {
    this.els.modes?.querySelectorAll('[data-mode]').forEach((b) => {
      const el = b as HTMLElement;
      el.classList.toggle('on', el.dataset.mode === this.mode);
    });
    this.root?.classList.toggle('block-mode', this.mode === 'block');
  }

  private paintHeatButton(): void {
    const button = this.els.heat;
    if (!button) return;
    button.classList.toggle('on', this.heatEnabled);
    button.setAttribute('aria-pressed', String(this.heatEnabled));
    button.setAttribute('aria-label', `Sales momentum overlay ${this.heatEnabled ? 'on' : 'off'}`);
    button.setAttribute('title', `${this.heatEnabled ? 'Hide' : 'Highlight'} sections selling fastest in the selected time window`);
    button.textContent = 'Sales momentum';
    this.paintMomentumHelp();
  }

  private paintMomentumHelp(): void {
    const help = this.els.rail?.querySelector('[data-ref="momentumhelp"]') as HTMLElement | null;
    if (!help) return;
    help.hidden = !this.heatEnabled;
    const copy = help.querySelector('[data-ref="momentumcopy"]');
    if (!copy) return;
    const hasRecentSales = this.controlRoomSnapshot?.velocity.bySection.some((row) => row.netBooked > 0);
    copy.textContent = hasRecentSales
      ? 'Warmer sections have more completed bookings, adjusted for section size. Holds and viewers are not counted.'
      : `No completed bookings in the last ${this.trendWindowMinutes} minutes.`;
  }

  private paintFullscreenButton(): void {
    if (!this.els.fullscreen) return;
    this.els.fullscreen.textContent = this.isFullscreen() ? 'Exit full screen' : 'Full screen';
  }

  private paintTrendWindow(): void {
    this.els.rail?.querySelectorAll('[data-window]').forEach((button) => {
      const value = Number((button as HTMLElement).dataset.window);
      button.classList.toggle('on', value === this.trendWindowMinutes);
    });
  }

  private setLive(on: boolean): void {
    this.root?.classList.toggle('live', on);
    if (this.els.livetext) this.els.livetext.textContent = on ? 'LIVE' : 'RECONNECTING';
    this.paintMonitorInsights();
  }

  private updateZoomHint(): void {
    const hint = this.els.zoomhint;
    if (!hint) return;
    const show = this.mode === 'block' && this.renderer?.getRung?.() !== 'seats';
    hint.classList.toggle('on', !!show);
  }

  private paintKpis(t: SeatManagerTallies): void {
    if (!this.els.kpis) return;
    const rev = t.revenueStatus === 'current' ? fmtMoney(t.grossRevenue, t.currency) : '—';
    const presence = this.controlRoomSnapshot?.presence;
    this.els.kpis.innerHTML = [
      { n: t.booked.toLocaleString(), l: 'Sold', dot: '#22a06b' },
      { n: t.held.toLocaleString(), l: 'Held', dot: '#f4b740' },
      { n: presence ? presence.shoppingSessions.toLocaleString() : '—', l: 'Shopping' },
      { n: presence ? presence.activeHolds.toLocaleString() : '—', l: 'Live holds' },
      { n: t.free.toLocaleString(), l: 'Free', dot: '#6e7bff' },
      { n: t.blocked.toLocaleString(), l: 'Blocked', dot: '#8b94ac' },
      { n: `${t.capacityPct}%`, l: 'Capacity' },
      { n: rev, l: 'Gross' },
    ].map((k) => `<div class="slm-kpi"><b>${k.dot ? `<span class="dot" style="background:${k.dot}"></span>` : ''}${k.n}</b><span>${k.l}</span></div>`).join('');
  }

  // ---- DOM: rails -----------------------------------------------------------

  private paintRail(): void {
    if (this.mode === 'view') this.renderViewRail();
    else if (this.mode === 'inspect') this.renderInspectRail(this.getSelection());
    else this.renderBlockRail();
    this.updateZoomHint();
  }

  private renderViewRail(): void {
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">Monitor</p>
      <p class="slm-hint">Read-only. Inventory, buyer presence and sales movement update on the same live board.</p>
      <div class="slm-health" data-ref="presence"></div>
      <div class="slm-legend" data-ref="legend"></div>
      <div class="slm-sectionhead">
        <div><p class="slm-eyebrow">Section performance</p><p class="slm-note">Exact booked revenue · net sales velocity</p></div>
        <div class="slm-windows" aria-label="Sales velocity window">
          ${[5, 15, 30, 60].map((window) => `<button class="slm-window" data-window="${window}">${window}m</button>`).join('')}
        </div>
      </div>
      <div class="slm-momentumhelp" data-ref="momentumhelp" ${this.heatEnabled ? '' : 'hidden'}>
        <div class="slm-momentumscale"><span>Warm</span><span class="slm-momentumgradient"></span><span>Hot</span></div>
        <p class="slm-momentumcopy" data-ref="momentumcopy"></p>
      </div>
      <div class="slm-sectionlist" data-ref="sections"></div>
      <p class="slm-eyebrow">Activity</p>
      <div class="slm-feed" data-ref="feed"></div>
    `;
    this.els.presence = this.els.rail.querySelector('[data-ref="presence"]') as HTMLElement;
    this.els.legend = this.els.rail.querySelector('[data-ref="legend"]') as HTMLElement;
    this.els.sections = this.els.rail.querySelector('[data-ref="sections"]') as HTMLElement;
    this.els.feed = this.els.rail.querySelector('[data-ref="feed"]') as HTMLElement;
    this.els.rail.querySelectorAll('[data-window]').forEach((button) => button.addEventListener('click', () => {
      const windowMinutes = Number((button as HTMLElement).dataset.window);
      void this.setTrendWindow(windowMinutes).catch((err) => this.opts.onError?.(err));
    }));
    this.recomputeTallies();
    this.paintMonitorInsights();
    this.paintTrendWindow();
    this.paintMomentumHelp();
    this.paintFeed();
  }

  private paintMonitorInsights(): void {
    if (this.mode !== 'view') return;
    const snapshot = this.controlRoomSnapshot;
    if (this.els.presence) {
      const connected = this.root?.classList.contains('live');
      const sync = this.lastSyncedAt ? relTime(this.lastSyncedAt, Date.now()) : 'waiting';
      this.els.presence.innerHTML = `
        <div class="slm-healthitem"><b>${snapshot ? snapshot.presence.shoppingSessions.toLocaleString() : '—'}</b><span>Buyer sessions</span></div>
        <div class="slm-healthitem"><b>${snapshot ? snapshot.presence.activeHolds.toLocaleString() : '—'}</b><span>Active holds</span></div>
        <div class="slm-healthitem"><b>${connected ? 'Healthy' : 'Reconnecting'}</b><span>Live connection</span></div>
        <div class="slm-healthitem"><b>${sync}</b><span>Last sync</span></div>`;
    }
    if (!this.els.sections) return;
    if (!snapshot) {
      this.els.sections.innerHTML = '<div class="slm-empty">Loading authoritative section metrics…</div>';
      return;
    }
    const velocity = new Map(snapshot.velocity.bySection.map((row) => [row.sectionId, row]));
    const rows = [...snapshot.revenue.bySection].sort((a, b) => {
      const av = velocity.get(a.sectionId)?.netBooked ?? 0;
      const bv = velocity.get(b.sectionId)?.netBooked ?? 0;
      return bv - av || b.bookedRevenue - a.bookedRevenue;
    });
    this.els.sections.innerHTML = rows.length ? rows.map((row) => {
      const speed = velocity.get(row.sectionId);
      const net = speed?.netBooked ?? 0;
      const netLabel = `${net > 0 ? '+' : ''}${net}`;
      const trend = speed?.trend === 'rising' || speed?.trend === 'cooling' ? speed.trend : 'steady';
      return `<div class="slm-sectionrow">
        <div class="slm-sectiontop"><span>${esc(row.sectionLabel)}</span><span>${fmtMoney(row.bookedRevenue, snapshot.currency)}</span></div>
        <div class="slm-sectionmeta"><span>${row.booked.toLocaleString()}/${row.total.toLocaleString()} sold · ${netLabel} in ${snapshot.velocity.windowMinutes}m</span><span class="slm-trend ${trend}">${trend}</span></div>
      </div>`;
    }).join('') : '<div class="slm-empty">No section metrics are available for this chart.</div>';
    this.paintTrendWindow();
    this.paintMomentumHelp();
  }

  private applyHeatOverlay(): void {
    const snapshot = this.controlRoomSnapshot;
    if (!this.heatEnabled || !snapshot) {
      this.renderer?.setSectionHeat(null);
      return;
    }
    const capacity = new Map(snapshot.revenue.bySection.map((row) => [row.sectionId, Math.max(1, row.total)]));
    const rates = snapshot.velocity.bySection.map((row) => ({
      sectionId: row.sectionId,
      rate: Math.max(0, row.netBooked) / (capacity.get(row.sectionId) ?? 1) / snapshot.velocity.windowMinutes,
    }));
    const max = Math.max(0, ...rates.map((row) => row.rate));
    const scores: Record<string, number> = {};
    for (const row of rates) scores[row.sectionId] = max > 0 ? Math.sqrt(row.rate / max) : 0;
    this.renderer?.setSectionHeat(scores);
  }

  private renderInspectRail(seats: ExpandedSeat[]): void {
    const seat = seats[seats.length - 1];
    if (!seat) {
      this.els.rail.innerHTML = `
        <p class="slm-eyebrow">Inspect</p>
        <p class="slm-hint">Select any seat to see its live inventory context. Inspect is read-only and never changes availability.</p>
        <div class="slm-empty">Choose a seat on the map.</div>`;
      return;
    }
    const status = this.status.get(seat.label) ?? 'free';
    const statusLabel: Record<DoStatus, string> = { free: 'Free', held: 'Held', booked: 'Booked', blocked: 'Blocked' };
    const sectionId = this.sectionByObject.get(seat.rowId) ?? UNGROUPED_ID;
    const sectionLabel = this.sectionLabelById.get(sectionId) ?? 'Other seats';
    const category = this.doc?.categories.find((item) => item.key === seat.categoryKey);
    const sectionMetric = this.controlRoomSnapshot?.revenue.bySection.find((row) => row.sectionId === sectionId);
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">Inspect</p>
      <p class="slm-hint">Live inventory context. Booked seats remain read-only; order and payment actions belong to the host commerce system.</p>
      <div class="slm-inspect-card">
        <div class="slm-inspect-label">${esc(seat.label)}</div>
        <div class="slm-inspect-grid">
          <div><span>Status</span><b>${statusLabel[status]}</b></div>
          <div><span>Section</span><b>${esc(sectionLabel)}</b></div>
          <div><span>Row</span><b>${esc(seat.rowId)}</b></div>
          <div><span>Category</span><b>${esc(category?.label ?? seat.categoryKey)}</b></div>
          <div><span>Section sold</span><b>${sectionMetric ? `${sectionMetric.booked}/${sectionMetric.total}` : '—'}</b></div>
          <div><span>Section revenue</span><b>${sectionMetric && this.controlRoomSnapshot ? fmtMoney(sectionMetric.bookedRevenue, this.controlRoomSnapshot.currency) : '—'}</b></div>
        </div>
      </div>`;
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
    this.els.feed.innerHTML = this.feed.map((a) => {
      const extra = a.count > 1 ? ` +${a.count - 1}` : '';
      return `<div class="slm-feedrow"><span class="slm-feeddot" style="background:${color[a.status]}"></span>
        <span class="slm-feedtext">${a.count === 1 ? 'Seat' : 'Seats'} <b>${esc(a.label)}${extra}</b> ${esc(a.verb)}</span>
        <span class="slm-feedtime">${relTime(a.at, now)}</span></div>`;
    }).join('');
  }

  private renderBlockRail(): void {
    const cats = this.doc?.categories ?? [];
    const catChips = cats.map((c) =>
      `<button class="slm-chip" data-cat="${esc(c.key)}"><span class="dot" style="background:${esc(c.color ?? '#6e7bff')}"></span>${esc(c.label ?? c.key)}</button>`).join('');
    const sectionField = this.sectionOptions.length
      ? `<div class="slm-field"><label>Select a whole section</label>
          <select class="slm-select" data-ref="section"><option value="">Choose a section…</option>
          ${this.sectionOptions.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}</select></div>`
      : '';
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">Block &amp; unblock</p>
      <p class="slm-hint">Drag a box on the map to marquee-select, ⌘A for all, or pick a category/section. Booked and held inventory is never actionable here.</p>
      <div class="slm-selbar"><span class="slm-selnum" data-ref="selnum">0</span><span class="slm-sellabel">selected</span></div>
      <div class="slm-row">
        <button class="slm-btn" data-ref="doblock" disabled>Block</button>
        <button class="slm-btn ghost" data-ref="dounblock" disabled>Unblock</button>
      </div>
      <div class="slm-row">
        <button class="slm-btn ghost" data-ref="selall">Select all</button>
        <button class="slm-btn ghost" data-ref="clearsel">Clear</button>
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
    r('doblock').addEventListener('click', () => void this.block());
    r('dounblock').addEventListener('click', () => void this.unblock());
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

  private paintSelBar(seats: ExpandedSeat[]): void {
    if (!this.els.selnum) return;
    this.els.selnum.textContent = seats.length.toLocaleString();
    const hasFree = seats.some((s) => this.status.get(s.label) === 'free');
    const hasBlocked = seats.some((s) => this.status.get(s.label) === 'blocked');
    (this.els.doblock as HTMLButtonElement).disabled = !hasFree;
    (this.els.dounblock as HTMLButtonElement).disabled = !hasBlocked;
  }

  // ---- toast / done / fail --------------------------------------------------

  private done(action: SeatManagerActionResult['action'], labels: string[], msg: string): void {
    this.toastOk(msg);
    if (action !== 'setHoldTtl') this.scheduleRevenueRefresh(0);
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
