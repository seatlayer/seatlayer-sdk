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
  type ControlRoomActivityEntry,
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
  /** Spatial context for grouped activity when the chart defines sections. */
  sectionIds?: string[];
  sectionLabels?: string[];
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
  /**
   * Opt in to camera-following for new buyer holds/bookings. Off by default so
   * a live event never steals an operator's current map context.
   */
  followLive?: boolean;
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
  /** Follow-live preference changed from inside the cockpit. */
  onFollowLiveChange?: (enabled: boolean) => void;
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
const MAX_LIVE_SEAT_PULSES = 16;
const MAX_LIVE_SECTION_PULSES = 4;

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
.slm-bar{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:center;column-gap:14px;row-gap:10px;
  padding:10px 16px;border-bottom:1px solid var(--slm-line);flex:none}
.slm-modes{display:inline-flex;background:var(--slm-surface);border:1px solid var(--slm-line);border-radius:999px;padding:3px}
.slm-mode{padding:6px 16px;border-radius:999px;font-weight:700;font-size:13px;color:var(--slm-muted)}
.slm-mode.on{background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.12em;font-weight:800;color:var(--slm-muted)}
.slm-live-dot{width:8px;height:8px;border-radius:50%;background:#8b94ac}
.slm.live .slm-live-dot{background:#22a06b;box-shadow:0 0 0 0 rgba(34,160,107,.55);animation:slm-pulse 2s infinite}
@keyframes slm-pulse{0%{box-shadow:0 0 0 0 rgba(34,160,107,.5)}70%{box-shadow:0 0 0 7px rgba(34,160,107,0)}100%{box-shadow:0 0 0 0 rgba(34,160,107,0)}}
.slm-kpis{grid-column:1/-1;display:grid;grid-template-columns:repeat(8,minmax(0,1fr));width:100%;padding-top:10px;
  border-top:1px solid var(--slm-line)}
.slm-kpi{position:relative;display:flex;min-width:0;flex-direction:column;align-items:center;padding:0 5px;line-height:1.15;text-align:center}
.slm-kpi b{display:flex;min-width:0;align-items:baseline;justify-content:center;font-size:17px;font-weight:800;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.slm-kpi span{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--slm-muted);font-weight:700}
.slm-kpi .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:baseline}
.slm-kpi.changed b{animation:slm-kpi-bump .58s cubic-bezier(.2,.8,.2,1)}
.slm-kpidelta{position:absolute;right:4px;top:-12px;padding:2px 5px;border-radius:999px;background:rgba(34,160,107,.17);
  color:#5bd39b!important;font-size:9px!important;letter-spacing:0!important;text-transform:none!important;white-space:nowrap;
  animation:slm-kpi-delta 1.45s ease-out both;pointer-events:none}
.slm-kpidelta.down{background:rgba(244,183,64,.14);color:#f7ca6b!important}
@keyframes slm-kpi-bump{0%,100%{transform:none}35%{transform:translateY(-2px) scale(1.08);text-shadow:0 0 18px rgba(255,255,255,.24)}}
@keyframes slm-kpi-delta{0%{opacity:0;transform:translateY(5px)}18%,72%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-5px)}}
.slm-barbtn{padding:7px 13px;border-radius:9px;border:1px solid var(--slm-line);color:var(--slm-text);font-weight:700;font-size:12.5px}
.slm-barbtn:hover{border-color:var(--slm-muted)}
.slm-barbtn.follow.on{background:rgba(34,160,107,.13);border-color:#22a06b;color:#5bd39b}

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
.slm-liveevent{position:absolute;left:50%;top:14px;z-index:4;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100% - 32px));
  padding:8px 12px;border:1px solid var(--slm-line);border-radius:999px;background:color-mix(in srgb,var(--slm-surface) 92%,transparent);
  box-shadow:0 10px 34px rgba(0,0,0,.32);opacity:0;transform:translate(-50%,-8px);pointer-events:none;
  transition:opacity .18s ease,transform .24s ease;backdrop-filter:blur(10px)}
.slm-liveevent.on{opacity:1;transform:translate(-50%,0)}
.slm.block-mode .slm-liveevent{top:52px}
.slm-liveeventdot{width:8px;height:8px;border-radius:50%;flex:none}.slm-liveeventcopy{min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;font-weight:800}.slm-liveeventhint{color:var(--slm-muted);font-size:10px;white-space:nowrap}
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
.slm-feedrow{display:flex!important;width:100%;align-items:center;gap:9px;padding:8px 2px!important;border-bottom:1px solid var(--slm-line)!important;
  border-radius:6px;font-size:12.5px;text-align:left!important;animation:slm-in .35s ease}
.slm-feedrow:hover{background:rgba(255,255,255,.035)!important}
@keyframes slm-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.slm-feeddot{width:8px;height:8px;border-radius:50%;flex:none}
.slm-feedtext{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slm-feedtext b{font-weight:800}
.slm-feedsection{display:block;overflow:hidden;text-overflow:ellipsis;color:var(--slm-muted);font-size:10px;font-weight:750}
.slm-feedmeta{display:flex;flex:none;flex-direction:column;align-items:flex-end;gap:1px}.slm-feedtime{font-size:10px;color:var(--slm-muted);font-variant-numeric:tabular-nums}
.slm-feedlocate{font-size:9.5px;color:var(--slm-accent);font-weight:800}
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
.slm-chip .slm-chipcount{min-width:18px;padding:1px 5px;border-radius:999px;background:rgba(255,255,255,.07);
  color:var(--slm-muted);font-size:10px;font-variant-numeric:tabular-nums;text-align:center}
.slm-chip .slm-chipcheck{display:none;font-size:11px;line-height:1}
.slm-chip.on{border-color:var(--slm-accent);background:color-mix(in srgb,var(--slm-accent) 20%,var(--slm-surface));
  box-shadow:0 0 0 1px color-mix(in srgb,var(--slm-accent) 45%,transparent)}
.slm-chip.on .slm-chipcount{background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-chip.on .slm-chipcheck{display:inline}
.slm-chip.partial{border-style:dashed;border-color:var(--slm-accent)}
.slm-chip:disabled{opacity:.42;cursor:not-allowed}
.slm-selecthelp{margin:-1px 0 9px;color:var(--slm-muted);font-size:11px;line-height:1.4}
.slm-field{margin:14px 0}
.slm-field label{display:block;font-size:11px;font-weight:700;color:var(--slm-muted);margin-bottom:5px}
.slm-input,.slm-select{width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--slm-line);
  background:var(--slm-surface);color:var(--slm-text)}
.slm-note{font-size:11.5px;color:var(--slm-muted);margin-top:5px}
.slm-blocked{margin-top:17px;padding-top:15px;border-top:1px solid var(--slm-line)}
.slm-blockedhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}
.slm-blockedhead .slm-eyebrow{margin-bottom:0}.slm-blockedtotal{font-size:11px;color:var(--slm-muted)}
.slm-blockedtotal b{color:var(--slm-text);font-variant-numeric:tabular-nums}
.slm-blockedtools{display:grid;grid-template-columns:minmax(0,1fr);gap:7px}
.slm-blockedsummary{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:9px 0 6px;
  color:var(--slm-muted);font-size:10.5px}
.slm-linkbtn{font-size:11px!important;font-weight:800!important;color:var(--slm-accent)!important;text-align:right}
.slm-linkbtn:disabled{opacity:.45;cursor:not-allowed}
.slm-blockedlist{max-height:246px;overflow:auto;border:1px solid var(--slm-line);border-radius:10px;background:var(--slm-surface)}
.slm-blockeditem{display:grid!important;grid-template-columns:18px minmax(0,1fr);width:100%;gap:8px;padding:8px 9px!important;
  border-bottom:1px solid var(--slm-line)!important;text-align:left!important}
.slm-blockeditem:last-child{border-bottom:0!important}.slm-blockeditem:hover{background:rgba(255,255,255,.035)!important}
.slm-blockeditem.on{background:color-mix(in srgb,var(--slm-accent) 13%,var(--slm-surface))!important}
.slm-blockedcheck{display:flex;align-items:center;justify-content:center;width:16px;height:16px;margin-top:1px;border-radius:4px;
  border:1px solid var(--slm-muted);color:transparent;font-size:10px;font-weight:900}
.slm-blockeditem.on .slm-blockedcheck{border-color:var(--slm-accent);background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-blockedcopy{min-width:0}.slm-blockedlabel{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;font-weight:800}.slm-blockedmeta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  margin-top:2px;color:var(--slm-muted);font-size:10px}
.slm-blockedmore{width:100%;padding:9px!important;color:var(--slm-accent)!important;font-size:11px!important;font-weight:800!important}
.slm-blockedempty{padding:12px;color:var(--slm-muted);font-size:11.5px;line-height:1.45}
.slm-allnote{margin-top:-4px;margin-bottom:10px}

/* toast */
.slm-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:10px 16px;border-radius:10px;
  font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;pointer-events:none;transition:opacity .2s;
  background:var(--slm-surface);color:var(--slm-text);border:1px solid var(--slm-line);z-index:5}
.slm-toast.on{opacity:1}
.slm-toast.err{background:#c0392b;color:#fff;border-color:#c0392b}
.slm-toast.ok{background:#1f7a4d;color:#fff;border-color:#1f7a4d}

/* control-room actions + insights */
.slm-bar-actions{display:flex;align-items:center;justify-self:end;gap:7px}
.slm-barbtn.on{background:rgba(244,183,64,.13);border-color:#f4b740;color:#f7ca6b}
.slm-sectionlist{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.slm-sectionlist + .slm-eyebrow{margin-top:18px}
.slm-sectionrow{width:100%;padding:10px!important;border:1px solid var(--slm-line)!important;border-radius:10px;background:var(--slm-surface)!important;text-align:left!important;transition:border-color .15s ease,transform .15s ease}
.slm-sectionrow:hover{border-color:var(--slm-muted)!important;transform:translateY(-1px)}
.slm-sectiontop,.slm-sectionmeta{display:flex;align-items:center;justify-content:space-between;gap:10px}
.slm-sectiontop{font-size:12.5px;font-weight:800}.slm-sectionmeta{margin-top:5px;color:var(--slm-muted);font-size:11px}
.slm-sectionmeta>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slm-trend{font-size:10px;text-transform:uppercase;letter-spacing:.08em}.slm-trend.rising{color:#22a06b}.slm-trend.cooling{color:#f4b740}
.slm-sectionlocate{color:var(--slm-accent);font-size:9.5px;font-weight:800}
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
.slm-inspect-card{padding:16px;border:1px solid var(--slm-line);border-radius:12px;background:var(--slm-surface)}
.slm-inspect-label{font-size:24px;font-weight:850;letter-spacing:-.02em;line-height:1.1}
.slm-inspect-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px;margin-top:18px}
.slm-inspect-grid>div{min-width:0}.slm-inspect-grid span{display:block;color:var(--slm-muted);font-size:10px;
  text-transform:uppercase;letter-spacing:.08em}.slm-inspect-grid b{display:block;margin-top:4px;font-size:13px;line-height:1.35;overflow-wrap:anywhere}
.slm:fullscreen{border-radius:0;min-height:100vh;background:var(--slm-bg)}
.slm:fullscreen .slm-bar{padding:14px 22px}.slm:fullscreen .slm-kpi b{font-size:21px}.slm:fullscreen .slm-rail{width:360px}

.slm.compact .slm-rail{width:100%;border-left:0;border-top:1px solid var(--slm-line);height:44%}
.slm.compact .slm-body{flex-direction:column}
.slm.compact .slm-bar{grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:8px}
.slm.compact .slm-modes{min-width:0}.slm.compact .slm-mode{padding-inline:11px}
.slm.compact .slm-live{justify-self:end}.slm.compact .slm-bar-actions{grid-column:1/-1;justify-self:stretch}
.slm.compact .slm-barbtn{flex:1;padding:6px 9px}.slm.compact .slm-kpis{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.slm.compact .slm-kpi[data-kpi="buyers"],.slm.compact .slm-kpi[data-kpi="active-holds"],
.slm.compact .slm-kpi[data-kpi="sold-pct"],.slm.compact .slm-kpi[data-kpi="gross-sales"]{display:none}
@media (prefers-reduced-motion:reduce){
  .slm.live .slm-live-dot,.slm-feedrow,.slm-kpi.changed b,.slm-kpidelta{animation:none!important}
  .slm-liveevent,.slm-sectionrow{transition:none!important}
}
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
  private followLive: boolean;
  private lastKpiValues = new Map<string, number>();
  private activeKpiDeltas = new Map<string, { text: string; down: boolean }>();

  // realtime socket
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private ready = false;

  private feed: SeatManagerActivity[] = [];
  private feedTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private liveEventTimer: ReturnType<typeof setTimeout> | null = null;
  private kpiCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private followLiveTimer: ReturnType<typeof setTimeout> | null = null;
  private followSeatTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseAt: number | null = null;
  private layoutObserver: ResizeObserver | null = null;
  private tokenExpiresAt: number | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRefreshInFlight = false;
  private sectionByObject = new Map<string, string>();
  private sectionLabelById = new Map<string, string>();
  private lastSyncedAt: number | null = null;
  private blockedQuery = '';
  private blockedSection = '';
  private blockedResultLimit = 100;
  private unblockAllConfirmTimer: ReturnType<typeof setTimeout> | null = null;

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

  private readonly onRailClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const sectionButton = target?.closest<HTMLElement>('[data-section-focus]');
    if (sectionButton?.dataset.sectionFocus) {
      this.locateSection(sectionButton.dataset.sectionFocus);
      return;
    }
    const feedButton = target?.closest<HTMLElement>('[data-feed-id]');
    if (feedButton?.dataset.feedId) this.locateActivity(feedButton.dataset.feedId);
  };

  constructor(options: SeatManagerOptions) {
    this.opts = options;
    this.key = options.eventKey;
    this.mode = options.mode ?? 'view';
    this.keepLive = options.keepLiveWhileHidden ?? true;
    this.followLive = options.followLive ?? false;
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
      const [, controlRoom] = await Promise.all([
        this.resnapshot(),
        this.refreshControlRoom().catch((err) => this.opts.onError?.(err)),
      ]);
      // Restore recent activity through the view-safe control-room projection.
      // Older workers lack this field, so privileged/secret-key hosts retain the
      // legacy best-effort audit-log fallback during rolling upgrades.
      if (controlRoom?.activity) this.seedFeed(controlRoom.activity);
      else this.api.log(this.key, { limit: 24 }).then((page) => this.seedFeed(page.entries)).catch(() => {});
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

  /** Toggle opt-in camera following for new buyer hold/book events. */
  setFollowLive(enabled: boolean): void {
    const changed = this.followLive !== enabled;
    this.followLive = enabled;
    if (!enabled) {
      if (this.followLiveTimer) clearTimeout(this.followLiveTimer);
      if (this.followSeatTimer) clearTimeout(this.followSeatTimer);
      this.followLiveTimer = null;
      this.followSeatTimer = null;
    }
    this.paintFollowLiveButton();
    if (changed) this.opts.onFollowLiveChange?.(enabled);
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
    this.setSeatsLocal(targets, 'blocked');
    try {
      await this.api.block(this.key, targets, { ...opts, releaseAt });
      this.clearSelection();
      this.done('block', targets, releaseAt
        ? `Blocked ${targets.length} — auto-release ${new Date(releaseAt).toLocaleString()}.`
        : `Blocked ${targets.length} seat${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      this.setSeatsLocal(targets, 'free'); // revert
      this.toastErr(err instanceof ManageApiError && err.status === 409
        ? 'Some seats were just taken. Try again.'
        : "Couldn't block those seats.");
      this.opts.onError?.(err);
    }
  }

  async unblock(labels?: string[]): Promise<void> {
    const targets = (labels ?? this.selectionLabels()).filter((l) => this.status.get(l) === 'blocked');
    if (!targets.length) return;
    this.setSeatsLocal(targets, 'free');
    try {
      await this.api.unblock(this.key, targets);
      this.clearSelection();
      this.done('unblock', targets, `Unblocked ${targets.length} seat${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      this.setSeatsLocal(targets, 'blocked');
      this.toastErr("Couldn't unblock those seats.");
      this.opts.onError?.(err);
    }
  }

  async unblockAll(): Promise<void> {
    const blocked = [...this.status.entries()].filter(([, s]) => s === 'blocked').map(([l]) => l);
    if (!blocked.length) return;
    this.setSeatsLocal(blocked, 'free');
    try {
      const res = await this.api.unblockAll(this.key);
      this.clearSelection();
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
    this.setSeatsLocal(targets, 'free');
    try {
      await this.api.unbook(this.key, targets, bookingRef);
      this.clearSelection();
      this.done('cancelBooking', targets, `Cancelled ${targets.length} booking${targets.length === 1 ? '' : 's'}.`);
    } catch (err) {
      this.setSeatsLocal(targets, 'booked');
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
    this.renderer?.clearSectionFocus();
    this.renderer?.zoomToFit();
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.feedTimer) clearInterval(this.feedTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.liveEventTimer) clearTimeout(this.liveEventTimer);
    if (this.kpiCleanupTimer) clearTimeout(this.kpiCleanupTimer);
    if (this.followLiveTimer) clearTimeout(this.followLiveTimer);
    if (this.followSeatTimer) clearTimeout(this.followSeatTimer);
    if (this.unblockAllConfirmTimer) clearTimeout(this.unblockAllConfirmTimer);
    if (this.revenueRefreshTimer) clearTimeout(this.revenueRefreshTimer);
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.root?.removeEventListener('keydown', this.onKeyDown);
    this.els.rail?.removeEventListener('click', this.onRailClick);
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
        if (id) { this.renderer?.setStatus([id], toRenderStatus(st)); ids.push(id); }
        const verb = this.verbFor(prev, st);
        const groupKey = `${verb}:${st}`;
        const group = groups.get(groupKey) ?? { labels: [], verb, status: st };
        group.labels.push(ch.label);
        groups.set(groupKey, group);
      }
      for (const group of groups.values()) {
        const activity = this.pushActivity(group.labels, group.verb, group.status);
        if (activity) this.paintSpatialActivity(activity);
      }
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

  /** Optimistic local write shared by organizer actions. Paint and tally once,
   * even when an arena-sized operation changes hundreds of seats. */
  private setSeatsLocal(labels: string[], st: DoStatus): void {
    const ids: string[] = [];
    for (const label of labels) {
      this.status.set(label, st);
      const id = this.labelToId.get(label);
      if (id) ids.push(id);
    }
    if (ids.length) this.renderer?.setStatus(ids, toRenderStatus(st));
    this.afterPaint();
    this.recomputeTallies();
  }

  /** Keep the canvas painting on hidden/occluded tabs (war-room second monitor). */
  private afterPaint(): void {
    if (this.keepLive && typeof document !== 'undefined' && document.hidden) {
      this.renderer?.forceDraw();
    }
  }

  private activityColor(status: DoStatus): string {
    return status === 'held' ? '#f4b740'
      : status === 'booked' ? '#22a06b'
        : status === 'blocked' ? '#8b94ac'
          : '#6e7bff';
  }

  private sectionsForLabels(labels: string[]): { ids: string[]; labels: string[] } {
    const ids = new Set<string>();
    for (const label of labels) {
      const seat = this.labelToSeat.get(label);
      if (!seat) continue;
      const sectionId = this.sectionByObject.get(seat.rowId);
      if (sectionId && sectionId !== UNGROUPED_ID) ids.add(sectionId);
    }
    const sectionIds = [...ids];
    return {
      ids: sectionIds,
      labels: sectionIds.map((id) => this.sectionLabelById.get(id) ?? id),
    };
  }

  private pulseSeatLabels(labels: string[], status: DoStatus): void {
    const color = this.activityColor(status);
    for (const label of labels.slice(0, MAX_LIVE_SEAT_PULSES)) {
      const id = this.labelToId.get(label);
      if (id) this.renderer?.flashSeat(id, color);
    }
  }

  /** Render one grouped realtime operation at the right semantic zoom level. */
  private paintSpatialActivity(activity: SeatManagerActivity): void {
    const sectionIds = activity.sectionIds ?? this.sectionsForLabels(activity.labels).ids;
    const focused = this.renderer?.getFocusedSection() ?? null;
    const followable = this.followLive && sectionIds.length === 1 &&
      (activity.status === 'held' || activity.status === 'booked');

    if (followable && focused === sectionIds[0]) {
      this.pulseSeatLabels(activity.labels, activity.status);
      return;
    }
    if (followable) {
      if (this.followLiveTimer) clearTimeout(this.followLiveTimer);
      if (this.followSeatTimer) clearTimeout(this.followSeatTimer);
      this.followLiveTimer = setTimeout(() => {
        this.followLiveTimer = null;
        this.renderer?.focusSection(sectionIds[0]);
        this.followSeatTimer = setTimeout(() => {
          this.followSeatTimer = null;
          this.pulseSeatLabels(activity.labels, activity.status);
        }, 520);
      }, 220);
      return;
    }

    if (!focused && sectionIds.length) {
      const color = this.activityColor(activity.status);
      for (const sectionId of sectionIds.slice(0, MAX_LIVE_SECTION_PULSES)) {
        this.renderer?.flashSection(sectionId, color);
      }
      return;
    }
    if (!sectionIds.length || (focused && sectionIds.includes(focused))) {
      this.pulseSeatLabels(activity.labels, activity.status);
    }
  }

  private locateSection(sectionId: string): void {
    this.renderer?.focusSection(sectionId);
  }

  private locateActivity(activityId: string): void {
    const activity = this.feed.find((item) => item.id === activityId);
    if (!activity) return;
    const sectionIds = activity.sectionIds ?? this.sectionsForLabels(activity.labels).ids;
    if (this.followSeatTimer) clearTimeout(this.followSeatTimer);
    if (sectionIds.length === 1) {
      this.locateSection(sectionIds[0]);
      this.followSeatTimer = setTimeout(() => {
        this.followSeatTimer = null;
        this.pulseSeatLabels(activity.labels, activity.status);
      }, 520);
      return;
    }
    this.zoomToFit();
    this.followSeatTimer = setTimeout(() => {
      this.followSeatTimer = null;
      if (sectionIds.length) {
        const color = this.activityColor(activity.status);
        for (const sectionId of sectionIds.slice(0, MAX_LIVE_SECTION_PULSES)) {
          this.renderer?.flashSection(sectionId, color);
        }
      } else {
        this.pulseSeatLabels(activity.labels, activity.status);
      }
    }, 280);
  }

  private showLiveEvent(activity: SeatManagerActivity): void {
    const element = this.els.liveevent;
    if (!element) return;
    const sections = activity.sectionLabels ?? [];
    const place = sections.length === 1 ? sections[0]
      : sections.length > 1 ? `${sections.length} sections`
        : activity.label;
    const noun = activity.count === 1 ? 'seat' : 'seats';
    element.innerHTML = `<span class="slm-liveeventdot" style="background:${this.activityColor(activity.status)}"></span>
      <span class="slm-liveeventcopy">${esc(place)} · ${activity.count.toLocaleString()} ${noun} ${esc(activity.verb)}</span>
      <span class="slm-liveeventhint">Live</span>`;
    element.classList.add('on');
    if (this.liveEventTimer) clearTimeout(this.liveEventTimer);
    this.liveEventTimer = setTimeout(() => {
      this.liveEventTimer = null;
      element.classList.remove('on');
      element.innerHTML = '';
    }, 2800);
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
    else if (this.mode === 'block') this.paintSelBar(this.getSelection());
    this.opts.onTallies?.(t);
  }

  private verbFor(prev: DoStatus, next: DoStatus): string {
    if (next === 'held') return 'held';
    if (next === 'booked') return 'booked';
    if (next === 'blocked') return 'blocked';
    if (next === 'free') return prev === 'blocked' ? 'unblocked' : prev === 'booked' ? 'cancelled' : 'released';
    return next;
  }

  private pushActivity(labels: string[], verb: string, status: DoStatus, at = Date.now()): SeatManagerActivity | null {
    const label = labels[0];
    if (!label) return null;
    const sections = this.sectionsForLabels(labels);
    const item: SeatManagerActivity = {
      id: `${label}:${at}:${Math.random().toString(36).slice(2, 6)}`,
      at,
      label,
      labels: [...labels],
      count: labels.length,
      verb,
      status,
      sectionIds: sections.ids,
      sectionLabels: sections.labels,
    };
    this.feed.unshift(item);
    if (this.feed.length > FEED_CAP) this.feed.length = FEED_CAP;
    if (this.mode === 'view') this.paintFeed();
    this.showLiveEvent(item);
    this.opts.onActivity?.(item);
    return item;
  }

  private seedFeed(entries: ControlRoomActivityEntry[]): void {
    const verbByAction: Record<string, string> = {
      hold: 'held', book: 'booked', release: 'released', expire: 'expired', block: 'blocked', unblock: 'unblocked',
      unbook: 'cancelled',
    };
    const stByAction: Record<string, DoStatus> = {
      hold: 'held', book: 'booked', release: 'free', expire: 'free', block: 'blocked', unblock: 'free', unbook: 'free',
    };
    for (const e of entries) {
      const label = e.labels[0];
      if (!label) continue;
      const sections = this.sectionsForLabels(e.labels);
      const item: SeatManagerActivity = {
        id: `log:${e.id}`,
        at: e.at,
        label,
        labels: [...e.labels],
        count: e.labels.length,
        verb: verbByAction[e.action] ?? e.action,
        status: stByAction[e.action] ?? 'free',
        sectionIds: sections.ids,
        sectionLabels: sections.labels,
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
        <div class="slm-modes" data-ref="modes" role="tablist" aria-label="Manager tools">
          <button class="slm-mode" role="tab" data-mode="view" title="Monitor (M)" aria-keyshortcuts="M">Monitor</button>
          <button class="slm-mode" role="tab" data-mode="inspect" title="Inspect (I)" aria-keyshortcuts="I">Inspect</button>
          <button class="slm-mode" role="tab" data-mode="block" title="Block (B)" aria-keyshortcuts="B">Block</button>
        </div>
        <span class="slm-live"><span class="slm-live-dot"></span><span data-ref="livetext">CONNECTING</span></span>
        <div class="slm-bar-actions">
          <button class="slm-barbtn follow" data-ref="follow" aria-pressed="false"
            title="Stay on the current map view unless enabled">Follow live</button>
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
          <div class="slm-liveevent" data-ref="liveevent" role="status" aria-live="polite"></div>
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
      follow: ref('follow'), heat: ref('heat'), fullscreen: ref('fullscreen'),
      zoomhint: ref('zoomhint'), liveevent: ref('liveevent'), rail: ref('rail'), toast: ref('toast'), zfit: ref('zfit'),
    };
    this.els.modes.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.setMode((b as HTMLElement).dataset.mode as SeatManagerMode)));
    this.els.zfit.addEventListener('click', () => this.zoomToFit());
    this.els.follow.addEventListener('click', () => this.setFollowLive(!this.followLive));
    this.els.heat.addEventListener('click', () => this.setHeatOverlay(!this.heatEnabled));
    this.els.fullscreen.addEventListener('click', () => this.toggleFullscreen());
    root.addEventListener('keydown', this.onKeyDown);
    this.els.rail.addEventListener('click', this.onRailClick);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.paintModeTabs();
    this.paintFollowLiveButton();
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
      const active = el.dataset.mode === this.mode;
      el.classList.toggle('on', active);
      el.setAttribute('aria-selected', String(active));
      el.tabIndex = active ? 0 : -1;
    });
    this.root?.classList.toggle('block-mode', this.mode === 'block');
  }

  private paintFollowLiveButton(): void {
    const button = this.els.follow;
    if (!button) return;
    button.classList.toggle('on', this.followLive);
    button.setAttribute('aria-pressed', String(this.followLive));
    button.setAttribute('title', this.followLive
      ? 'Following new buyer holds and bookings. Turn off to keep the current view.'
      : 'Stay on the current map view. Enable to follow new buyer holds and bookings.');
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

  private formatKpiDelta(key: string, delta: number, currency: string): string {
    const sign = delta > 0 ? '+' : '−';
    const absolute = Math.abs(delta);
    if (key === 'gross-sales') return `${sign}${fmtMoney(absolute, currency)}`;
    if (key === 'sold-pct') return `${sign}${absolute.toLocaleString()}pt`;
    return `${sign}${absolute.toLocaleString()}`;
  }

  private paintKpis(t: SeatManagerTallies): void {
    if (!this.els.kpis) return;
    const rev = t.revenueStatus === 'current' ? fmtMoney(t.grossRevenue, t.currency) : '—';
    const presence = this.controlRoomSnapshot?.presence;
    const items: { key: string; raw: number | null; n: string; l: string; dot?: string }[] = [
      { key: 'sold-seats', raw: t.booked, n: t.booked.toLocaleString(), l: 'Sold seats', dot: '#22a06b' },
      { key: 'held-seats', raw: t.held, n: t.held.toLocaleString(), l: 'Held seats', dot: '#f4b740' },
      { key: 'buyers', raw: presence?.shoppingSessions ?? null, n: presence ? presence.shoppingSessions.toLocaleString() : '—', l: 'Buyers' },
      { key: 'active-holds', raw: presence?.activeHolds ?? null, n: presence ? presence.activeHolds.toLocaleString() : '—', l: 'Active holds' },
      { key: 'free-seats', raw: t.free, n: t.free.toLocaleString(), l: 'Free seats', dot: '#6e7bff' },
      { key: 'blocked', raw: t.blocked, n: t.blocked.toLocaleString(), l: 'Blocked', dot: '#8b94ac' },
      { key: 'sold-pct', raw: t.capacityPct, n: `${t.capacityPct}%`, l: 'Sold' },
      { key: 'gross-sales', raw: t.revenueStatus === 'current' ? t.grossRevenue : null, n: rev, l: 'Gross sales' },
    ];
    let hasChanges = false;
    this.els.kpis.innerHTML = items.map((item) => {
      const previous = this.lastKpiValues.get(item.key);
      const changed = item.raw != null && previous != null && item.raw !== previous;
      const delta = changed ? item.raw! - previous! : 0;
      if (changed) {
        hasChanges = true;
        this.activeKpiDeltas.set(item.key, {
          text: this.formatKpiDelta(item.key, delta, t.currency),
          down: delta < 0,
        });
      }
      if (item.raw != null) this.lastKpiValues.set(item.key, item.raw);
      const activeDelta = this.activeKpiDeltas.get(item.key);
      return `<div class="slm-kpi${activeDelta ? ' changed' : ''}" data-kpi="${item.key}">
        <b>${item.dot ? `<span class="dot" style="background:${item.dot}"></span>` : ''}${item.n}</b><span>${item.l}</span>
        ${activeDelta ? `<span class="slm-kpidelta${activeDelta.down ? ' down' : ''}">${activeDelta.text}</span>` : ''}
      </div>`;
    }).join('');
    if (hasChanges) {
      // The map above has already adopted the new values, so detect the rendered
      // change markers directly and remove their accessibility footprint after
      // the visual cue completes.
      if (this.kpiCleanupTimer) clearTimeout(this.kpiCleanupTimer);
      this.kpiCleanupTimer = setTimeout(() => {
        this.kpiCleanupTimer = null;
        this.activeKpiDeltas.clear();
        this.els.kpis?.querySelectorAll('.slm-kpidelta').forEach((element) => element.remove());
        this.els.kpis?.querySelectorAll('.slm-kpi.changed').forEach((element) => element.classList.remove('changed'));
      }, 1500);
    }
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
      return `<button type="button" class="slm-sectionrow" data-section-focus="${esc(row.sectionId)}" title="Focus ${esc(row.sectionLabel)} on the map">
        <span class="slm-sectiontop"><span>${esc(row.sectionLabel)}</span><span>${fmtMoney(row.bookedRevenue, snapshot.currency)}</span></span>
        <span class="slm-sectionmeta"><span>${row.booked.toLocaleString()}/${row.total.toLocaleString()} sold · ${netLabel} in ${snapshot.velocity.windowMinutes}m</span><span class="slm-trend ${trend}">${trend}</span><span class="slm-sectionlocate">Locate</span></span>
      </button>`;
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
        <p class="slm-eyebrow">Inspect seats</p>
        <p class="slm-hint">Select a seat to see its availability and sales context. Nothing changes in this view.</p>
        <div class="slm-empty">Select a seat on the map.</div>`;
      return;
    }
    const status = this.status.get(seat.label) ?? 'free';
    const statusLabel: Record<DoStatus, string> = { free: 'Free', held: 'Held', booked: 'Booked', blocked: 'Blocked' };
    const sectionId = this.sectionByObject.get(seat.rowId) ?? UNGROUPED_ID;
    const sectionLabel = this.sectionLabelById.get(sectionId) ?? 'Other seats';
    const category = this.doc?.categories.find((item) => item.key === seat.categoryKey);
    const sectionMetric = this.controlRoomSnapshot?.revenue.bySection.find((row) => row.sectionId === sectionId);
    const object = this.doc?.objects.find((item) => item.id === seat.rowId);
    const location = object?.type === 'row'
      ? { label: 'Row', value: object.label }
      : object?.type === 'table'
        ? { label: 'Table', value: object.label }
        : seat.kind === 'booth'
          ? { label: 'Type', value: 'Booth' }
          : null;
    const itemKind = seat.kind === 'booth' ? 'Booth' : 'Seat';
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">${itemKind} details</p>
      <p class="slm-hint">Live availability and section performance.</p>
      <div class="slm-inspect-card">
        <div class="slm-inspect-label">${esc(seat.label)}</div>
        <div class="slm-inspect-grid">
          <div><span>Status</span><b>${statusLabel[status]}</b></div>
          <div><span>Section</span><b>${esc(sectionLabel)}</b></div>
          ${location ? `<div><span>${location.label}</span><b>${esc(location.value)}</b></div>` : ''}
          <div><span>Category</span><b>${esc(category?.label ?? seat.categoryKey)}</b></div>
          <div><span>Sold in section</span><b>${sectionMetric ? `${sectionMetric.booked} of ${sectionMetric.total}` : '—'}</b></div>
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
      const sections = a.sectionLabels ?? [];
      const sectionCopy = sections.length === 1 ? sections[0] : sections.length > 1 ? `${sections.length} sections` : '';
      return `<button type="button" class="slm-feedrow" data-feed-id="${esc(a.id)}" title="Locate this activity on the map">
        <span class="slm-feeddot" style="background:${color[a.status]}"></span>
        <span class="slm-feedtext">${sectionCopy ? `<span class="slm-feedsection">${esc(sectionCopy)}</span>` : ''}${a.count === 1 ? 'Seat' : 'Seats'} <b>${esc(a.label)}${extra}</b> ${esc(a.verb)}</span>
        <span class="slm-feedmeta"><span class="slm-feedtime">${relTime(a.at, now)}</span><span class="slm-feedlocate">Locate</span></span>
      </button>`;
    }).join('');
  }

  private renderBlockRail(): void {
    const cats = this.doc?.categories ?? [];
    const catChips = cats.map((c) =>
      `<button class="slm-chip" type="button" data-cat="${esc(c.key)}" aria-pressed="false">
        <span class="dot" style="background:${esc(c.color ?? '#6e7bff')}"></span>
        <span>${esc(c.label ?? c.key)}</span>
        <span class="slm-chipcount" data-cat-count>0</span>
        <span class="slm-chipcheck" aria-hidden="true">✓</span>
      </button>`).join('');
    const sectionField = this.sectionOptions.length
      ? `<div class="slm-field"><label>Select a whole section</label>
          <select class="slm-select" data-ref="section"><option value="">Choose a section…</option>
          ${this.sectionOptions.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}</select></div>`
      : '';
    const blockedSectionOptions = this.sectionOptions.map((s) =>
      `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">Block &amp; unblock</p>
      <p class="slm-hint">Drag a box on the map to marquee-select, ⌘A for all, or pick a category/section. Booked and held inventory is never actionable here.</p>
      <div class="slm-selbar" aria-live="polite"><span class="slm-selnum" data-ref="selnum">0</span><span class="slm-sellabel" data-ref="selmeta">selected</span></div>
      <div class="slm-row">
        <button class="slm-btn" data-ref="doblock" disabled>Block</button>
        <button class="slm-btn ghost" data-ref="dounblock" disabled>Put back on sale</button>
      </div>
      <div class="slm-row">
        <button class="slm-btn ghost" data-ref="selall">Select all</button>
        <button class="slm-btn ghost" data-ref="clearsel">Clear</button>
      </div>
      <p class="slm-eyebrow" style="margin-top:8px">Select by category</p>
      <p class="slm-selecthelp">Choose one or more. A checked category is selected; click it again to remove it.</p>
      <div class="slm-chiprow">${catChips || '<span class="slm-empty">No categories.</span>'}</div>
      ${sectionField}
      <div class="slm-field">
        <label>Auto-release blocks at (optional)</label>
        <input type="datetime-local" class="slm-input" data-ref="release" />
        <p class="slm-note" data-ref="releasenote">Leave empty to block permanently.</p>
      </div>
      <section class="slm-blocked" aria-labelledby="slm-blocked-title">
        <div class="slm-blockedhead">
          <p class="slm-eyebrow" id="slm-blocked-title">Blocked inventory</p>
          <span class="slm-blockedtotal"><b data-ref="blockedcount">0</b> out of sale</span>
        </div>
        <p class="slm-selecthelp">Find blocked seats, select only the ones you need, then use “Put back on sale”.</p>
        <div class="slm-blockedtools">
          <input type="search" class="slm-input" data-ref="blockedsearch" placeholder="Find seat, row or category" aria-label="Search blocked seats" />
          <select class="slm-select" data-ref="blockedsection" aria-label="Filter blocked seats by section">
            <option value="">All sections</option>${blockedSectionOptions}
          </select>
        </div>
        <div class="slm-blockedsummary">
          <span data-ref="blockedshowing">No blocked seats</span>
          <button type="button" class="slm-linkbtn" data-ref="selblocked" disabled>Select results</button>
        </div>
        <div class="slm-blockedlist" data-ref="blockedlist"></div>
      </section>
      <div class="slm-field">
        <button class="slm-btn ghost" data-ref="markall" style="width:100%" disabled>Put all blocked seats on sale</button>
        <p class="slm-note slm-allnote" data-ref="markallnote">For a full reset only. You will be asked to confirm.</p>
      </div>
    `;
    const r = (n: string) => this.els.rail.querySelector(`[data-ref="${n}"]`) as HTMLElement;
    this.els.selnum = r('selnum'); this.els.doblock = r('doblock'); this.els.dounblock = r('dounblock');
    this.els.selmeta = r('selmeta'); this.els.blockedcount = r('blockedcount');
    this.els.blockedshowing = r('blockedshowing'); this.els.blockedlist = r('blockedlist');
    this.els.selblocked = r('selblocked'); this.els.markall = r('markall'); this.els.markallnote = r('markallnote');
    r('doblock').addEventListener('click', () => void this.block());
    r('dounblock').addEventListener('click', () => void this.unblock());
    r('selall').addEventListener('click', () => this.selectAll());
    r('clearsel').addEventListener('click', () => this.clearSelection());
    r('markall').addEventListener('click', () => this.confirmUnblockAll());
    this.els.rail.querySelectorAll('[data-cat]').forEach((b) =>
      b.addEventListener('click', () => this.toggleCategory((b as HTMLElement).dataset.cat!)));
    const sectionSel = this.els.rail.querySelector('[data-ref="section"]') as HTMLSelectElement | null;
    sectionSel?.addEventListener('change', () => { if (sectionSel.value) { this.selectSection(sectionSel.value); sectionSel.value = ''; } });
    const blockedSearch = r('blockedsearch') as HTMLInputElement;
    const blockedSection = r('blockedsection') as HTMLSelectElement;
    blockedSearch.value = this.blockedQuery;
    blockedSection.value = this.blockedSection;
    blockedSearch.addEventListener('input', () => {
      this.blockedQuery = blockedSearch.value;
      this.blockedResultLimit = 100;
      this.paintBlockedInventory();
    });
    blockedSection.addEventListener('change', () => {
      this.blockedSection = blockedSection.value;
      this.blockedResultLimit = 100;
      this.paintBlockedInventory();
    });
    r('selblocked').addEventListener('click', () => {
      this.toggleLabels(this.filteredBlockedSeats().map((seat) => seat.label));
    });
    r('blockedlist').addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const seatButton = target.closest<HTMLElement>('[data-blocked-label]');
      if (seatButton?.dataset.blockedLabel) this.toggleLabels([seatButton.dataset.blockedLabel]);
      else if (target.closest('[data-blocked-more]')) {
        this.blockedResultLimit += 100;
        this.paintBlockedInventory();
      }
    });
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

  private toggleCategory(catKey: string): void {
    const labels: string[] = [];
    for (const [label, seat] of this.labelToSeat.entries()) {
      if (seat.categoryKey === catKey && this.isBlockSelectable(label)) labels.push(label);
    }
    this.toggleLabels(labels);
  }

  /** A category/filter is a real toggle: add the missing seats, or remove the
   * whole group when every eligible seat in it is already selected. */
  private toggleLabels(labels: string[]): void {
    if (!this.renderer) return;
    const eligible = labels.filter((label) => this.labelToSeat.has(label) && this.isBlockSelectable(label));
    if (!eligible.length) return;
    const selected = new Set(this.selectionLabels());
    const allSelected = eligible.every((label) => selected.has(label));
    if (allSelected) {
      const ids = eligible.map((label) => this.labelToId.get(label)).filter((id): id is string => Boolean(id));
      this.renderer.deselect(ids);
    } else {
      this.renderer.selectByLabels(eligible);
    }
    this.syncSelection();
  }

  private isBlockSelectable(label: string): boolean {
    const status = this.status.get(label) ?? 'free';
    return status === 'free' || status === 'blocked';
  }

  private paintSelBar(seats: ExpandedSeat[]): void {
    if (!this.els.selnum) return;
    this.els.selnum.textContent = seats.length.toLocaleString();
    const freeCount = seats.filter((s) => (this.status.get(s.label) ?? 'free') === 'free').length;
    const blockedCount = seats.filter((s) => this.status.get(s.label) === 'blocked').length;
    this.els.selmeta.textContent = seats.length
      ? `${freeCount.toLocaleString()} available · ${blockedCount.toLocaleString()} blocked`
      : 'selected';
    const blockButton = this.els.doblock as HTMLButtonElement;
    const unblockButton = this.els.dounblock as HTMLButtonElement;
    blockButton.disabled = freeCount === 0;
    unblockButton.disabled = blockedCount === 0;
    blockButton.textContent = freeCount ? `Block ${freeCount.toLocaleString()}` : 'Block selected';
    unblockButton.textContent = blockedCount ? `Put ${blockedCount.toLocaleString()} on sale` : 'Put back on sale';
    this.paintCategoryControls(seats);
    this.paintBlockedInventory();
  }

  private paintCategoryControls(seats: ExpandedSeat[]): void {
    const selected = new Set(seats.map((seat) => seat.label));
    this.els.rail?.querySelectorAll<HTMLButtonElement>('[data-cat]').forEach((button) => {
      const catKey = button.dataset.cat;
      const labels: string[] = [];
      for (const [label, seat] of this.labelToSeat.entries()) {
        if (seat.categoryKey === catKey && this.isBlockSelectable(label)) labels.push(label);
      }
      const picked = labels.filter((label) => selected.has(label)).length;
      const full = labels.length > 0 && picked === labels.length;
      const partial = picked > 0 && !full;
      button.disabled = labels.length === 0;
      button.classList.toggle('on', full);
      button.classList.toggle('partial', partial);
      button.setAttribute('aria-pressed', full ? 'true' : partial ? 'mixed' : 'false');
      button.setAttribute('title', full
        ? `Remove all ${labels.length.toLocaleString()} seats in this category from the selection`
        : partial
          ? `Select the remaining ${(labels.length - picked).toLocaleString()} seats in this category`
          : `Select all ${labels.length.toLocaleString()} seats in this category`);
      const count = button.querySelector<HTMLElement>('[data-cat-count]');
      if (count) count.textContent = picked ? `${picked.toLocaleString()}/${labels.length.toLocaleString()}` : labels.length.toLocaleString();
    });
  }

  private filteredBlockedSeats(): ExpandedSeat[] {
    const query = this.blockedQuery.trim().toLocaleLowerCase();
    const seats: ExpandedSeat[] = [];
    for (const [label, seat] of this.labelToSeat.entries()) {
      if (this.status.get(label) !== 'blocked') continue;
      const sectionId = this.sectionByObject.get(seat.rowId) ?? UNGROUPED_ID;
      if (this.blockedSection && sectionId !== this.blockedSection) continue;
      if (query) {
        const category = this.doc?.categories.find((item) => item.key === seat.categoryKey)?.label ?? seat.categoryKey;
        const section = this.sectionLabelById.get(sectionId) ?? 'Other seats';
        const object = this.doc?.objects.find((item) => item.id === seat.rowId);
        const objectLabel = object?.type === 'row' || object?.type === 'table' ? object.label : '';
        const haystack = `${label} ${category} ${section} ${objectLabel}`.toLocaleLowerCase();
        if (!haystack.includes(query)) continue;
      }
      seats.push(seat);
    }
    return seats.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  }

  private paintBlockedInventory(): void {
    if (!this.els.blockedlist) return;
    const allBlocked = [...this.status.entries()].filter(([, status]) => status === 'blocked').length;
    const filtered = this.filteredBlockedSeats();
    const visible = filtered.slice(0, this.blockedResultLimit);
    const selected = new Set(this.selectionLabels());
    const selectedResults = filtered.filter((seat) => selected.has(seat.label)).length;
    const allResultsSelected = filtered.length > 0 && selectedResults === filtered.length;
    this.els.blockedcount.textContent = allBlocked.toLocaleString();
    this.els.blockedshowing.textContent = filtered.length
      ? `Showing ${visible.length.toLocaleString()} of ${filtered.length.toLocaleString()}`
      : allBlocked ? 'No matches' : 'No blocked seats';
    const selectResults = this.els.selblocked as HTMLButtonElement;
    selectResults.disabled = filtered.length === 0;
    selectResults.textContent = allResultsSelected
      ? `Remove ${filtered.length.toLocaleString()} results`
      : `Select ${filtered.length.toLocaleString()} results`;

    this.els.blockedlist.innerHTML = visible.length ? visible.map((seat) => {
      const sectionId = this.sectionByObject.get(seat.rowId) ?? UNGROUPED_ID;
      const section = this.sectionLabelById.get(sectionId) ?? 'Other seats';
      const category = this.doc?.categories.find((item) => item.key === seat.categoryKey)?.label ?? seat.categoryKey;
      const isSelected = selected.has(seat.label);
      return `<button type="button" class="slm-blockeditem${isSelected ? ' on' : ''}" data-blocked-label="${esc(seat.label)}" aria-pressed="${isSelected}">
        <span class="slm-blockedcheck" aria-hidden="true">✓</span>
        <span class="slm-blockedcopy"><span class="slm-blockedlabel">${esc(seat.label)}</span>
          <span class="slm-blockedmeta">${esc(section)} · ${esc(category)}</span></span>
      </button>`;
    }).join('') + (filtered.length > visible.length
      ? `<button type="button" class="slm-blockedmore" data-blocked-more>Show 100 more</button>` : '')
      : `<div class="slm-blockedempty">${allBlocked
        ? 'No blocked seats match this search or section.'
        : 'No seats are blocked. Newly blocked seats will appear here.'}</div>`;

    const markAll = this.els.markall as HTMLButtonElement;
    const armed = markAll.dataset.confirm === 'true';
    markAll.disabled = allBlocked === 0;
    markAll.textContent = armed
      ? `Confirm: put all ${allBlocked.toLocaleString()} on sale`
      : `Put all ${allBlocked.toLocaleString()} blocked seats on sale`;
  }

  private confirmUnblockAll(): void {
    const button = this.els.markall as HTMLButtonElement;
    if (!button || button.disabled) return;
    if (button.dataset.confirm === 'true') {
      this.resetUnblockAllConfirm();
      void this.unblockAll();
      return;
    }
    button.dataset.confirm = 'true';
    button.classList.add('danger');
    this.els.markallnote.textContent = 'This changes every blocked seat. Click the red button again to confirm.';
    this.paintBlockedInventory();
    if (this.unblockAllConfirmTimer) clearTimeout(this.unblockAllConfirmTimer);
    this.unblockAllConfirmTimer = setTimeout(() => this.resetUnblockAllConfirm(), 6000);
  }

  private resetUnblockAllConfirm(): void {
    if (this.unblockAllConfirmTimer) clearTimeout(this.unblockAllConfirmTimer);
    this.unblockAllConfirmTimer = null;
    const button = this.els.markall as HTMLButtonElement | undefined;
    if (!button) return;
    delete button.dataset.confirm;
    button.classList.remove('danger');
    if (this.els.markallnote) this.els.markallnote.textContent = 'For a full reset only. You will be asked to confirm.';
    this.paintBlockedInventory();
  }

  // ---- toast / done / fail --------------------------------------------------

  private done(action: SeatManagerActionResult['action'], labels: string[], msg: string): void {
    this.toastOk(msg);
    if (labels.length) {
      const activity = action === 'block'
        ? this.pushActivity(labels, 'blocked', 'blocked')
        : action === 'unblock' || action === 'unblockAll'
          ? this.pushActivity(labels, 'unblocked', 'free')
          : action === 'cancelBooking'
            ? this.pushActivity(labels, 'cancelled', 'free')
            : null;
      if (activity) this.paintSpatialActivity(activity);
    }
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
