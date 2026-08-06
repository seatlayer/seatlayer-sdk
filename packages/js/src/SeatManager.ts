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
  gaAreasOf,
  gaUnitLabels,
  UNGROUPED_ID,
  type AvailabilityRule,
  type ChartDoc,
  type ChartTheme,
  type ExpandedSeat,
  type SeatStatus,
  type SectionNode,
} from '@seatlayer/core';
import { CHANNELS_CSS, ChannelsMode, type ChannelsCapabilities } from './channelsMode';
import type { ChannelSeatStatus } from './channelPlan';
import {
  ManageApi,
  ManageApiError,
  type ControlRoomActivityEntry,
  type ControlRoomSnapshot,
  type LogEntry,
  type ReportResult,
} from './manageApi';

export type SeatManagerMode = 'view' | 'inspect' | 'block' | 'sections' | 'channels';

/**
 * Capabilities the cockpit's token was minted with. Channels mode is gated on
 * these and fails CLOSED: no `event:channels:view` ⇒ no Channels pill at all;
 * view without `event:channels:manage` ⇒ read-only inspection with every
 * mutation control absent, not merely disabled.
 */
export type SeatManagerCapability =
  | 'event:view' | 'event:block' | 'event:cancel' | 'event:reports'
  | 'event:channels:view' | 'event:channels:manage';

/** The select-state of a Sections-mode availability row. An absent rule is
 *  `open` (on sale); otherwise the rule's own mode. */
export type AvailabilityMode = 'open' | 'closed' | 'hidden' | 'timed' | 'threshold';

/** One row of the Sections rail — a zone header or a single section. */
interface SectionRow {
  kind: 'zone' | 'section';
  id: string;
  label: string;
  seatCount: number;
  /** Seat labels the id governs (sent as the rule's `labels`). */
  seatLabels: string[];
  rule: AvailabilityRule | null;
  /** Effective-hidden right now (manual hide, or a timed/threshold window not yet due). */
  hidden: boolean;
  /** Effective-closed right now — visible to buyers but off sale. */
  closed: boolean;
  /** A section whose parent zone carries a rule — its own control is a muted "Follows zone". */
  followsZone: boolean;
}

/** Map an availability rule to its Sections-rail select value (null rule = on sale). */
export function availabilityModeOf(rule: AvailabilityRule | null | undefined): AvailabilityMode {
  return rule ? rule.mode : 'open';
}

/**
 * Build the rule a chosen select mode implies for a set of seat labels, reusing
 * an existing rule's tuning where it carries over (a timed reveal time, a
 * threshold percent). `open` clears the rule (returns null → id dropped from the
 * map). Wire-identical to the EventDO's accepted rule shapes.
 */
export function availabilityRuleForMode(
  mode: AvailabilityMode,
  seatLabels: string[],
  prev?: AvailabilityRule | null,
): AvailabilityRule | null {
  switch (mode) {
    case 'open':
      return null;
    case 'hidden':
      return { mode: 'hidden', labels: seatLabels };
    case 'closed':
      return { mode: 'closed', labels: seatLabels };
    case 'timed':
      return { mode: 'timed', revealAt: prev?.revealAt ?? Date.now() + 3_600_000, labels: seatLabels };
    case 'threshold':
      return { mode: 'threshold', thresholdPct: prev?.thresholdPct ?? 80, labels: seatLabels };
  }
}

/** epoch ms → a `datetime-local` input value (local time, minute precision). */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

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
  /**
   * The capability set this token was minted with. Supply it whenever you mint
   * an `mse_…` grant — it is the only way the widget can know a delegated token
   * carries `event:channels:manage`, and without it Channels mode stays
   * read-only (fail-closed). A tenant secret (`sk_…`) is org authority and is
   * never narrowed server-side, so it is treated as fully capable.
   */
  capabilities?: SeatManagerCapability[] | string[];
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
  /**
   * The realtime link connected or dropped, with the moment the numbers on
   * screen were last known good.
   *
   * A host embedding this cockpit renders its own chrome around it, and until
   * now had no way to know the board had gone stale: the manager tracked the
   * drop internally (its own LIVE/RECONNECTING pill) and told nobody. A host
   * that polls on a timer and pauses while the tab is hidden therefore showed
   * arbitrarily old numbers that looked exactly like fresh ones.
   */
  onConnectionChange?: (state: SeatManagerConnection) => void;
  onError?: (err: unknown) => void;
}

/** Realtime link state, as reported to the embedding host. */
export interface SeatManagerConnection {
  /** `live` while the socket is open; `reconnecting` from drop until reopen. */
  status: 'live' | 'reconnecting';
  /**
   * `Date.now()` of the last snapshot or delta accepted from the server, or
   * null before the first one. This is the honest "as of" for whatever the host
   * is displaying — NOT the time the connection dropped, which is later and
   * would overstate freshness.
   */
  lastMessageAt: number | null;
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

/** Exported so the motion contract can be asserted without a real browser —
 *  see `SeatManagerMotion.test.ts`. Not part of the public package surface.
 *  `@sl-css` opts it into build-time minification (cdn/minifyCssLiterals.ts). */
export const MANAGER_CSS = /* @sl-css */ `
/* The floor was 480px, which trapped the cockpit in any host shorter than that:
   every ancestor here is overflow:hidden, so the bottom of the rail (Create
   channel, Show archived) was rendered but clipped away by the host and could
   not be reached by scrolling anything. 320px still keeps an unsized host from
   collapsing to the top bar, and the rail scrolls to its full content below. */
.slm{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:320px;overflow:hidden;
  background:var(--slm-bg);color:var(--slm-text);font-family:var(--slm-font);border-radius:var(--slm-radius);
  /* Motion tokens (motion-system §2), declared by the cockpit ROOT rather than
     borrowed from CHANNELS_CSS. The base cockpit animates whether or not
     Channels mode is in use, so owning its own tokens is what stops a token
     edit from silently changing only half the surface. Channels mode declares
     the identical values so an embed of it stays self-contained. */
  --slm-mo-instant:80ms;--slm-mo-quick:140ms;--slm-mo-base:200ms;--slm-mo-slow:320ms;--slm-mo-ambient:2000ms;
  --slm-mo-out:cubic-bezier(.2,.8,.2,1);--slm-mo-in-out:cubic-bezier(.4,0,.2,1);--slm-mo-exit:cubic-bezier(.4,0,1,1);
  --slm-mo-spring:cubic-bezier(.34,1.3,.64,1)}
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
.slm.live .slm-live-dot{background:#22a06b;box-shadow:0 0 0 0 rgba(34,160,107,.55);
  animation:slm-pulse var(--slm-mo-ambient) infinite}
@keyframes slm-pulse{0%{box-shadow:0 0 0 0 rgba(34,160,107,.5)}70%{box-shadow:0 0 0 7px rgba(34,160,107,0)}100%{box-shadow:0 0 0 0 rgba(34,160,107,0)}}
.slm-kpis{grid-column:1/-1;display:grid;grid-template-columns:repeat(8,minmax(0,1fr));width:100%;padding-top:10px;
  border-top:1px solid var(--slm-line)}
.slm-kpi{position:relative;display:flex;min-width:0;flex-direction:column;align-items:center;padding:0 5px;line-height:1.15;text-align:center}
.slm-kpi b{display:flex;min-width:0;align-items:baseline;justify-content:center;font-size:17px;font-weight:800;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.slm-kpi span{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--slm-muted);font-weight:700}
.slm-kpi .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:baseline}
/* The one playful moment this surface is allowed (§2 --mo-spring). It ran at
   .58s against a 200ms catalog, which read as a different design language from
   the dashboard tile it mirrors; Channels mode's own count bump is the same
   pattern and must stay in step with it. */
.slm-kpi.changed b{animation:slm-kpi-bump var(--slm-mo-base) var(--slm-mo-spring)}
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
  background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:700;pointer-events:none;opacity:0;
  transition:opacity var(--slm-mo-base) var(--slm-mo-out)}
.slm-zoomhint.on{opacity:1}
.slm-liveevent{position:absolute;left:50%;top:14px;z-index:4;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100% - 32px));
  padding:8px 12px;border:1px solid var(--slm-line);border-radius:999px;background:color-mix(in srgb,var(--slm-surface) 92%,transparent);
  box-shadow:0 10px 34px rgba(0,0,0,.32);opacity:0;transform:translate(-50%,-8px);pointer-events:none;
  transition:opacity var(--slm-mo-quick) var(--slm-mo-out),transform var(--slm-mo-base) var(--slm-mo-out);
  backdrop-filter:blur(10px)}
.slm-liveevent.on{opacity:1;transform:translate(-50%,0)}
.slm.block-mode .slm-liveevent{top:52px}
.slm-liveeventdot{width:8px;height:8px;border-radius:50%;flex:none}.slm-liveeventcopy{min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;font-weight:800}.slm-liveeventhint{color:var(--slm-muted);font-size:10px;white-space:nowrap}
.slm-rail{width:320px;flex:none;border-left:1px solid var(--slm-line);display:flex;flex-direction:column;min-height:0}
.slm-railscroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px}
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
  border-radius:6px;font-size:12.5px;text-align:left!important;
  animation:slm-in var(--slm-mo-quick) var(--slm-mo-out)}
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
.slm-blockedlist{max-height:246px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--slm-line);
  border-radius:10px;background:var(--slm-surface)}
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
  font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;pointer-events:none;
  transition:opacity var(--slm-mo-base) var(--slm-mo-out);
  background:var(--slm-surface);color:var(--slm-text);border:1px solid var(--slm-line);z-index:5}
.slm-toast.on{opacity:1}
.slm-toast.err{background:#c0392b;color:#fff;border-color:#c0392b}
.slm-toast.ok{background:#1f7a4d;color:#fff;border-color:#1f7a4d}

/* control-room actions + insights */
.slm-bar-actions{display:flex;align-items:center;justify-self:end;gap:7px}
.slm-barbtn.on{background:rgba(244,183,64,.13);border-color:#f4b740;color:#f7ca6b}
.slm-sectionlist{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.slm-sectionlist + .slm-eyebrow{margin-top:18px}
.slm-sectionrow{width:100%;padding:10px!important;border:1px solid var(--slm-line)!important;border-radius:10px;
  background:var(--slm-surface)!important;text-align:left!important;
  transition:border-color var(--slm-mo-quick) var(--slm-mo-out),transform var(--slm-mo-quick) var(--slm-mo-out)}
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
/* sections: availability windows */
.slm-availlist{display:flex;flex-direction:column;gap:8px;margin:2px 0 12px}
.slm-availrow{padding:10px;border:1px solid var(--slm-line);border-radius:10px;background:var(--slm-surface);
  transition:border-color var(--slm-mo-quick) var(--slm-mo-out),opacity var(--slm-mo-quick) var(--slm-mo-out)}
.slm-availrow.zone{background:color-mix(in srgb,var(--slm-surface) 82%,#000)}
.slm-availrow.hidden{opacity:.62}.slm-availrow.closed{opacity:.82}
.slm-availhead{display:flex;align-items:center;gap:8px}
.slm-availlabel{display:flex;align-items:center;gap:5px;flex:1;min-width:0;font-size:12.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slm-availcaret{flex:none;color:var(--slm-muted);font-size:10px}
.slm-availcount{flex:none;font-size:11px;font-weight:700;color:var(--slm-muted);font-variant-numeric:tabular-nums}
.slm-availbadge{flex:none;font-size:9px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:2px 6px;border-radius:999px}
.slm-availbadge.hidden{background:rgba(139,148,172,.18);color:#c2c9d8}
.slm-availbadge.closed{background:rgba(244,183,64,.16);color:#f7ca6b}
.slm-availselwrap{position:relative;flex:none;display:inline-flex}
.slm-availmode{width:auto;max-width:190px;padding:6px 8px;font-size:11.5px;font-weight:700;cursor:pointer}
.slm-availmode.on{border-color:var(--slm-accent);color:var(--slm-text)}
.slm-availmode:disabled{opacity:.55;cursor:progress}
.slm-availfollows{flex:none;padding:5px 10px;border:1px solid var(--slm-line);border-radius:7px;background:var(--slm-surface);color:var(--slm-muted);font-size:11px;font-weight:600;white-space:nowrap}
.slm-availdetail{display:flex;align-items:center;gap:8px;margin-top:9px}
.slm-availdetail .slm-input{flex:1}
.slm-availpct{max-width:74px;flex:none!important}
.slm-availpctlabel{font-size:11px;color:var(--slm-muted);font-weight:600;white-space:nowrap}
.slm-availsummary{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--slm-line);border-radius:9px;color:var(--slm-muted);font-size:12.5px}
.slm-availdot{width:9px;height:9px;border-radius:50%;flex:none;background:#22a06b}.slm-availdot.warn{background:#f4b740}
.slm-availcallout{display:flex;align-items:flex-start;gap:8px;margin-top:10px;padding:10px 12px;border:1px solid rgba(244,183,64,.45);border-radius:9px;background:rgba(244,183,64,.1)}
.slm-availstar{flex:none;margin-top:1px;color:#f4b740;font-size:13px;line-height:1}
.slm-availcallout p{font-size:11.5px;line-height:1.55;color:#f4d58a}.slm-availcallout b{color:#ffe4a3;font-weight:800}
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
/* Reduced motion, as a BLANKET over the cockpit subtree rather than a list of
   selectors. The list this replaces named four animations and two transitions,
   and had silently fallen behind the stylesheet: the zoom hint, the toast and
   the availability rows all still animated for a user who had asked the OS for
   none. An enumerated list has to be edited every time a rule is added, and
   nothing fails when it isn't — so it drifts. This cannot.

   Motion is removed, never the information it carried: Channels mode's own
   block substitutes static outlines for its shake and success states, and it
   stays authoritative for those. No JS here waits on animationend or
   transitionend, so cutting them outright strands no state. */
@media (prefers-reduced-motion:reduce){
  .slm,.slm *,.slm *::before,.slm *::after{
    animation:none!important;
    transition:none!important;
    scroll-behavior:auto!important}
}
${CHANNELS_CSS}`;

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = MANAGER_CSS;
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
  /**
   * GA inventory units — real sellable labels the server counts, with NO seat
   * geometry and therefore no renderer binding. They live here rather than in
   * `labelToId`/`allIds` so every paint path keeps addressing paintable nodes
   * only, while the tally denominator finally covers the same universe the
   * numerator does. Without them a GA sale hit `booked` but not `total`:
   * Free under-reported by GA capacity and SOLD% could exceed 100%.
   */
  private gaUnitLabelSet = new Set<string>();
  private status = new Map<string, DoStatus>();
  /** Live non-free counters, moved by each delta rather than re-walked. */
  private counts: Record<Exclude<DoStatus, 'free'>, number> = { held: 0, booked: 0, blocked: 0 };
  /** Bumped whenever the seat model is replaced wholesale (a full snapshot). */
  private modelVersion = 0;
  private currency = 'USD';
  private authoritativeGrossRevenue = 0;
  private revenueStatus: SeatManagerTallies['revenueStatus'] = 'loading';
  private revenueRequest = 0;
  private controlRoomSnapshot: ControlRoomSnapshot | null = null;
  /**
   * The server's own totals, pinned to the client model they were read against.
   * Display = server baseline + (client now − client then), so the authoritative
   * numbers land exactly on arrival and deltas still move them between reads.
   * A wholesale model replacement invalidates the pairing (`model`), and the
   * client tallies — themselves a fresh authenticated read — take over.
   */
  private serverBaseline: {
    model: number;
    server: { free: number; held: number; booked: number; blocked: number };
    client: { free: number; held: number; booked: number; blocked: number };
  } | null = null;
  /** Latest presence frame, held whether or not a snapshot has landed yet. */
  private livePresence: { at: number; value: { shoppingSessions: number; activeHolds: number } } | null = null;
  /** Latest cumulative booked gross pushed on a delta frame. */
  private liveGross: { at: number; value: number } | null = null;
  /** Coalesces a burst of deltas into one KPI/rail repaint. */
  private paintHandle: number | null = null;
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
  /** Mirrors the `live` root class, so the getter never has to read the DOM. */
  private connectionStatus: SeatManagerConnection['status'] = 'reconnecting';
  /** When the server last told us something. Stamped on accepted traffic only —
   *  a socket that opens and says nothing has not refreshed anything. */
  private lastMessageAt: number | null = null;
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
  private sectionsBase: ReturnType<typeof computeSections> | null = null;
  // Sections mode (availability windows): organizer rules + the live effective
  // hidden/closed sets from the snapshot + WS (a timed/threshold rule fires DO-side).
  private availabilityRules: Record<string, AvailabilityRule> = {};
  private effectiveHidden = new Set<string>();
  private effectiveClosed = new Set<string>();
  private availabilitySaving = false;
  private lastSyncedAt: number | null = null;
  private blockedQuery = '';
  private blockedSection = '';
  private blockedResultLimit = 100;
  private unblockAllConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  // Sales channels (M6b). The mode object is built only once the token is known
  // to carry `event:channels:view`; until then there is no pill and no rail.
  private channels: ChannelsMode | null = null;
  private channelCaps: ChannelsCapabilities = { view: false, manage: false };

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
    else if (key === 's') this.setMode('sections');
    else if (key === 'c') { if (!this.channels) return; this.setMode('channels'); }
    else if (key === 'f') this.toggleFullscreen();
    else if (key === 'escape') { if (!this.channels?.handleBack()) return; }
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
      this.buildUnitUniverse(res.doc);
      this.buildRenderer();
      this.buildSectionOptions();
      const [, controlRoom] = await Promise.all([
        this.resnapshot(),
        this.refreshControlRoom().catch((err) => this.opts.onError?.(err)),
        this.refreshAvailability(),
      ]);
      // Restore recent activity through the view-safe control-room projection.
      // Older workers lack this field, so privileged/secret-key hosts retain the
      // legacy best-effort audit-log fallback during rolling upgrades.
      if (controlRoom?.activity) this.seedFeed(controlRoom.activity);
      else this.api.log(this.key, { limit: 24 }).then((page) => this.seedFeed(page.entries)).catch(() => {});
      void this.connect();
      this.startFeedClock();
      this.ready = true;
      // Resolve channel authority BEFORE the first rail paint so the pill either
      // exists from the start or never appears — a pill that pops in later reads
      // as a permission change that did not happen.
      await this.resolveChannelCapabilities();
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
    // Fail closed: a host asking for a mode this token cannot use gets the
    // read-only board, never a half-rendered management surface.
    if (mode === 'channels' && !this.channels) mode = 'view';
    const changed = mode !== this.mode;
    const wasChannels = this.mode === 'channels';
    this.mode = mode;
    if (!this.renderer && this.doc) this.buildRenderer();
    else this.updateRendererInteraction();
    if (changed) this.renderer?.clearSelection();
    if (wasChannels && mode !== 'channels') this.channels?.leave();
    this.paintModeTabs();
    this.paintRail();
    this.applySectionCanvasTreatment();
    if (mode === 'channels') this.channels?.enter();
    if (changed) this.opts.onModeChange?.(mode);
  }

  /**
   * Decide what this token may do with sales channels.
   *
   * Declared capabilities win — a host that mints an `mse_…` grant knows exactly
   * what it asked for. Otherwise a tenant secret (`sk_…`) is org authority the
   * worker never narrows, so it is fully capable; and a delegated token with no
   * declaration is probed for read access and then treated as READ-ONLY, because
   * "we could not tell" must never render mutation controls.
   */
  private async resolveChannelCapabilities(): Promise<void> {
    const declared = this.opts.capabilities;
    if (declared) {
      const set = new Set(declared as string[]);
      this.channelCaps = {
        view: set.has('event:channels:view'),
        manage: set.has('event:channels:view') && set.has('event:channels:manage'),
      };
    } else if (/^sk_/.test(this.opts.token)) {
      this.channelCaps = { view: true, manage: true };
    } else {
      this.channelCaps = { view: false, manage: false };
    }
    if (!this.channelCaps.view && !declared && !/^sk_/.test(this.opts.token)) {
      // Undeclared delegated token: probe read access once. Read-only either way.
      try {
        await this.api.channels(this.key);
        this.channelCaps = { view: true, manage: false };
      } catch {
        this.channelCaps = { view: false, manage: false };
      }
    }
    if (!this.channelCaps.view) {
      this.channels?.destroy();
      this.channels = null;
      this.paintModeTabs();
      return;
    }
    if (this.channels) {
      this.channels.setCapabilities(this.channelCaps);
    } else {
      this.channels = new ChannelsMode(this.buildChannelsHost(), this.channelCaps);
      // Entering/leaving buyer preview flips the canvas between selectable and
      // strictly read-only, so re-arm the renderer when the view changes.
      this.channels.onInteractionChange = () => this.updateRendererInteraction();
    }
    this.paintModeTabs();
  }

  /** The adapter between the cockpit's internals and Channels mode. */
  private buildChannelsHost() {
    return {
      eventKey: this.key,
      api: this.api,
      rail: this.els.rail,
      mapLayer: this.root.querySelector('.slm-map') as HTMLElement,
      root: this.root,
      seats: () => [...this.labelToSeat.values()].map((seat) => ({
        id: seat.id, label: seat.label, x: seat.x, y: seat.y,
      })),
      statusOf: (label: string): ChannelSeatStatus | undefined => this.status.get(label)
        ?? (this.labelToSeat.has(label) ? 'free' : undefined),
      selectionLabels: () => this.selectionLabels(),
      selectByLabels: (labels: string[]) => { this.selectByLabels(labels); },
      clearSelection: () => this.clearSelection(),
      selectSection: (sectionId: string) => { this.selectSection(sectionId); },
      sections: () => this.sectionOptions,
      categories: () => (this.doc?.categories ?? []).map((category) => ({
        key: category.key, label: category.label ?? category.key, color: category.color,
      })),
      labelsInCategory: (key: string) => [...this.labelToSeat.entries()]
        .filter(([, seat]) => seat.categoryKey === key).map(([label]) => label),
      sectionOfLabel: (label: string) => {
        const seat = this.labelToSeat.get(label);
        if (!seat) return null;
        const id = this.sectionByObject.get(seat.rowId) ?? UNGROUPED_ID;
        return { id, label: this.sectionLabelById.get(id) ?? 'Other seats' };
      },
      worldToScreen: (point: { x: number; y: number }) => this.renderer?.worldToScreen(point) ?? null,
      seatPixelSize: () => this.seatPixelSize(),
      isSeatDetail: () => this.renderer?.getRung?.() === 'seats',
      showSectionOverview: () => {
        this.renderer?.clearSectionFocus();
        this.renderer?.setRung?.('sections');
      },
      focusSection: (sectionId: string) => this.renderer?.focusSection(sectionId),
      isCompact: () => !!this.root?.classList.contains('compact'),
      setMapInert: (inert: boolean) => {
        this.mapHost.toggleAttribute('inert', inert);
        this.mapHost.setAttribute('aria-hidden', String(inert));
      },
      toast: (message: string, kind: 'ok' | 'err') => this.toast(message, kind),
      onError: (err: unknown) => this.opts.onError?.(err),
    };
  }

  /** Actual on-screen seat diameter, for the channel overlay's marks. The
   * renderer's base seat radius is 9 chart units; retaining the camera scale
   * (rather than capping it) keeps every preview paint aligned with the real
   * chart geometry at deep zoom. */
  private seatPixelSize(): number {
    const rect = this.renderer?.getVisibleWorldRect?.();
    const width = this.mapHost?.clientWidth ?? 0;
    if (!rect?.width || !width) return 6;
    return Math.max(3, (width / rect.width) * 18);
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
    if (this.ready) void this.resolveChannelCapabilities();
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

  /**
   * The realtime link's current state and the "as of" behind it.
   *
   * Pair with `onConnectionChange` for the edges: a host that mounts after a
   * drop, or re-reads on tab focus, needs to be able to ASK rather than wait
   * for the next transition that may never come.
   */
  getConnection(): SeatManagerConnection {
    return { status: this.connectionStatus, lastMessageAt: this.lastMessageAt };
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
    if (this.paintHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.paintHandle);
    }
    this.paintHandle = null;
    this.channels?.destroy();
    this.channels = null;
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
    const bulk = this.isBulkSelectMode();
    this.renderer = new SeatmapRenderer(this.mapHost, {
      manageMode: true,
      marqueeSelect: bulk,
      maxSelection: 1_000_000,
      selectableStatuses: this.selectableStatuses(),
      currency: this.currency,
      onSelect: (seat) => this.handleSeatSelect(seat),
      onDeselect: () => this.syncSelection(),
      onMarquee: () => this.syncSelection(),
      onSectionTap: (sectionId) => {
        this.renderer?.focusSection(sectionId);
        this.channels?.handleSectionFocus(sectionId);
      },
      onViewChange: () => { this.updateZoomHint(); this.channels?.handleViewChange(); },
    });
    this.renderer.setChart(this.doc);
    this.repaintAll();
    this.applyHeatOverlay();
    this.updateZoomHint();
  }

  /** Block always uses a marquee. Channels only enables its marquee after the
   * organizer deliberately chooses Assign seats; Pan map keeps desktop drag
   * available for large charts. */
  private isBulkSelectMode(): boolean {
    return this.mode === 'block' || (this.mode === 'channels' && this.channels?.usesMarqueeSelection() === true);
  }

  /**
   * Block never touches held or booked inventory, so it cannot select it.
   * Channels must be able to select it — the Review sheet's honesty depends on
   * counting the held and sold units inside a marquee and saying they will not
   * move, rather than silently omitting them from the selection.
   */
  private selectableStatuses(): SeatStatus[] {
    if (this.mode === 'block') return ['free', 'not_for_sale'];
    if (this.mode === 'inspect' || this.isBulkSelectMode()
      || (this.mode === 'channels' && this.channels?.canSelect() === true)) {
      return ['free', 'held', 'booked', 'not_for_sale'];
    }
    return [];
  }

  private updateRendererInteraction(): void {
    const bulk = this.isBulkSelectMode();
    this.renderer?.setManageInteraction({
      manageMode: true,
      marqueeSelect: bulk,
      maxSelection: 1_000_000,
      selectableStatuses: this.selectableStatuses(),
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

  /**
   * Build the client's inventory universe from the chart.
   *
   * `expandChart` yields SEATS — it has no output for a GA area, whose capacity
   * is sold as N synthetic unit labels. The server's seat map keys, its deltas
   * and its `totals` all speak those labels, so a client that only knows seats
   * counts GA sales in the numerator (every key of the snapshot is written into
   * `status`) while leaving them out of the denominator. Registering the GA
   * units here — labels only, never a render binding — is what makes the two
   * agree.
   */
  private buildUnitUniverse(doc: ChartDoc): void {
    for (const seat of expandChart(doc)) {
      this.labelToId.set(seat.label, seat.id);
      this.labelToSeat.set(seat.label, seat);
      this.allIds.push(seat.id);
    }
    for (const area of gaAreasOf(doc)) {
      for (const label of gaUnitLabels(area)) {
        // A GA unit never shadows a seat label, and a joined area's provenance
        // can name the same unit twice across segments — the Set settles both.
        if (!this.labelToId.has(label)) this.gaUnitLabelSet.add(label);
      }
    }
  }

  /** Every sellable unit the client knows: seats + GA capacity. */
  private unitTotal(): number {
    return this.allIds.length + this.gaUnitLabelSet.size;
  }

  /** Every label the client models, whether or not it can be painted. */
  private knownLabels(): Iterable<string> {
    return [...this.labelToId.keys(), ...this.gaUnitLabelSet];
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

  /**
   * Open the cockpit's realtime socket AS THE ORGANIZER.
   *
   * The scope has to be established before the upgrade, because a browser
   * `WebSocket` cannot send an Authorization header: the manage token is traded
   * over HTTPS for a one-use ticket which rides in `Sec-WebSocket-Protocol`.
   * Without it the server treats this socket as an anonymous public buyer and
   * projects its deltas, so any change inside a private channel allocation is
   * structurally suppressed and the map silently drifts.
   *
   * If the mint fails (an expired token, a worker that predates the route) we
   * still connect unticketed rather than going dark — the public-sale stream is
   * worth having, and every `resnapshot()` re-establishes physical truth from
   * the authenticated HTTP read.
   */
  private async connect(): Promise<void> {
    if (this.closed) return;
    let protocols: string[] | undefined;
    try {
      protocols = (await this.api.subscribeTicket(this.key)).protocols;
    } catch {
      protocols = undefined;
    }
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = protocols
        ? new WebSocket(this.api.socketUrl(this.key), protocols)
        : new WebSocket(this.api.socketUrl(this.key));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setLive(true);
      // Connect (and every reconnect) is where the server's own totals, gross
      // and section metrics are re-established. Between connects the delta
      // stream carries both the counts and the money, so nothing polls.
      void this.resnapshot()
        .then(() => this.refreshControlRoom())
        .catch((err) => this.opts.onError?.(err));
      void this.refreshAvailability();
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
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
  }

  private onMessage(e: MessageEvent): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // Stamped here, after parsing: unreadable frames prove the socket is open
    // but prove nothing about the numbers, and "as of" must mean the data.
    this.lastMessageAt = Date.now();
    const m = msg as {
      type?: string;
      seats?: Record<string, string>;
      /** Compact (protocol 1) snapshots send the modal status once and list
       *  only the seats that differ from it. Absent on legacy frames. */
      default?: string;
      changes?: { label: string; status: string }[];
      /** Organizer-scope protocol-1 deltas carry cumulative booked gross, in the
       *  same unit as `ControlRoomSnapshot.revenue.gross`. Buyer scopes never
       *  see it, and a worker that predates it simply omits the field. */
      revenue?: { gross?: number };
      shoppingSessions?: number;
      activeHolds?: number;
      hidden?: string[];
      closed?: string[];
    };
    // Availability state (effective hidden/closed) can ride any message and is the
    // dedicated payload of the 'hidden' broadcast — keep the Sections rail + canvas fresh.
    if (Array.isArray(m.hidden) || Array.isArray(m.closed)) {
      this.updateEffectiveAvailability(m.hidden, m.closed);
    }
    if (m.type === 'presence') {
      // Presence used to be gated on a control-room snapshot already existing,
      // which silently dropped every frame in the window right after connect —
      // the exact window the cockpit is watched in. The counts are held on their
      // own field now and merged into the snapshot whenever one lands.
      if (typeof m.shoppingSessions === 'number' && typeof m.activeHolds === 'number') {
        this.livePresence = {
          at: Date.now(),
          value: { shoppingSessions: m.shoppingSessions, activeHolds: m.activeHolds },
        };
        if (this.controlRoomSnapshot) {
          this.controlRoomSnapshot = { ...this.controlRoomSnapshot, presence: this.livePresence.value };
          this.opts.onControlRoom?.(this.controlRoomSnapshot);
        }
        this.lastSyncedAt = Date.now();
        this.recomputeTallies();
        this.paintMonitorInsights();
      }
      return;
    }
    if (m.type === 'hidden') return;
    if (m.seats && typeof m.seats === 'object') {
      this.applySnapshot(m.seats, typeof m.default === 'string' ? m.default : undefined);
    } else if (Array.isArray(m.changes)) {
      const ids: string[] = [];
      const groups = new Map<string, { labels: string[]; verb: string; status: DoStatus }>();
      for (const ch of m.changes) {
        const st = (['free', 'held', 'booked', 'blocked'].includes(ch.status) ? ch.status : 'free') as DoStatus;
        const prev = this.status.get(ch.label) ?? 'free';
        if (prev === st) continue;
        this.setStatusLabel(ch.label, st, prev);
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
      // Money rides the frame now. GA-only sales register no renderer id, so a
      // refresh gated on `ids.length` never fired for them and GROSS SALES sat
      // frozen; a frame that carries the figure needs no fetch at all.
      if (typeof m.revenue?.gross === 'number' && Number.isFinite(m.revenue.gross)) {
        this.applyLiveGross(m.revenue.gross);
      }
      this.recomputeTallies();
    }
  }

  /**
   * Adopt the cumulative booked gross a delta frame carried.
   *
   * Stashed with its arrival time so an in-flight control-room read can decide
   * whether it is holding the newer number: a frame that landed after the
   * request started is newer than the response, one that landed before is not.
   */
  private applyLiveGross(gross: number): void {
    this.liveGross = { at: Date.now(), value: gross };
    this.authoritativeGrossRevenue = gross;
    this.revenueStatus = 'current';
    if (this.controlRoomSnapshot) {
      this.controlRoomSnapshot = {
        ...this.controlRoomSnapshot,
        revenue: { ...this.controlRoomSnapshot.revenue, gross },
      };
      this.opts.onControlRoom?.(this.controlRoomSnapshot);
    }
  }

  /** The single writer for a label's status, so the counters never drift. */
  private setStatusLabel(label: string, next: DoStatus, prev = this.status.get(label) ?? 'free'): void {
    this.status.set(label, next);
    if (prev === next) return;
    if (prev !== 'free') this.counts[prev] -= 1;
    if (next !== 'free') this.counts[next] += 1;
  }

  private async resnapshot(): Promise<void> {
    try {
      const objs = await this.api.objects(this.key);
      this.applySnapshot(objs.seats);
      this.updateEffectiveAvailability(objs.hidden, objs.closed);
      // A full snapshot over HTTP is server truth just as much as a delta is —
      // "as of" would otherwise ignore the freshest read the cockpit ever does.
      this.lastMessageAt = Date.now();
    } catch {
      /* transient — the delta stream keeps us fresh */
    }
  }

  /**
   * Replace the whole seat model.
   *
   * `fallback` is the compact frame's modal status: those snapshots list only
   * the seats that DIFFER from it, so every other known label takes it. Without
   * this the omitted majority would silently fall back to `free` — fine when
   * the mode really is free, wrong the moment it is not.
   */
  private applySnapshot(seats: Record<string, string>, fallback?: string): void {
    const known = (st: string): DoStatus =>
      (['free', 'held', 'booked', 'blocked'].includes(st) ? st : 'free') as DoStatus;
    const next = new Map<string, DoStatus>();
    if (fallback !== undefined) {
      const base = known(fallback);
      // GA units take the modal status too — they are inventory the server sells.
      for (const label of this.knownLabels()) next.set(label, base);
    }
    for (const [label, st] of Object.entries(seats)) {
      next.set(label, known(st));
    }
    this.status = next;
    this.modelVersion += 1;
    this.recountAll();
    this.lastSyncedAt = Date.now();
    this.repaintAll();
    this.afterPaint();
    this.recomputeTallies();
  }

  /** The one O(n) walk left: a wholesale model replacement re-bases the counters. */
  private recountAll(): void {
    const counts: Record<Exclude<DoStatus, 'free'>, number> = { held: 0, booked: 0, blocked: 0 };
    for (const st of this.status.values()) if (st !== 'free') counts[st] += 1;
    this.counts = counts;
  }

  /** Optimistic local write shared by organizer actions. Paint and tally once,
   * even when an arena-sized operation changes hundreds of seats. */
  private setSeatsLocal(labels: string[], st: DoStatus): void {
    const ids: string[] = [];
    for (const label of labels) {
      this.setStatusLabel(label, st);
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

  /**
   * Read the server's own control-room projection.
   *
   * Called on mount, on every socket (re)connect and after an organizer action —
   * never on a timer and never per delta frame. Presence and gross that arrived
   * on the socket AFTER this request started are newer than the response, so
   * they survive it; anything older defers to the read.
   */
  private async refreshControlRoom(): Promise<ControlRoomSnapshot> {
    const request = ++this.revenueRequest;
    const requestedAt = Date.now();
    try {
      const fetched = await this.api.controlRoom(this.key, this.trendWindowMinutes);
      let snapshot = fetched;
      if (request === this.revenueRequest) {
        if (this.livePresence && this.livePresence.at >= requestedAt) {
          snapshot = { ...snapshot, presence: this.livePresence.value };
        } else {
          this.livePresence = null;
        }
        if (this.liveGross && this.liveGross.at >= requestedAt) {
          snapshot = { ...snapshot, revenue: { ...snapshot.revenue, gross: this.liveGross.value } };
        } else {
          this.liveGross = null;
        }
        this.controlRoomSnapshot = snapshot;
        this.rebaseServerTotals(snapshot);
        this.lastSyncedAt = Date.now();
        this.authoritativeGrossRevenue = snapshot.revenue.gross;
        this.currency = snapshot.currency;
        this.revenueStatus = 'current';
        this.recomputeTallies();
        this.applyHeatOverlay();
        this.paintMonitorInsights();
        this.opts.onControlRoom?.(snapshot);
      }
      // The host is handed the same object the cockpit adopted — a public
      // getter that disagreed with `onControlRoom` would be its own defect.
      return snapshot;
    } catch (err) {
      if (request === this.revenueRequest) {
        this.revenueStatus = 'stale';
        this.recomputeTallies();
      }
      throw err;
    }
  }

  /** Pin the server's totals to the client model they were read against. */
  private rebaseServerTotals(snapshot: ControlRoomSnapshot): void {
    const totals = snapshot.totals;
    if (!totals || ['free', 'held', 'booked', 'blocked'].some(
      (key) => !Number.isFinite((totals as unknown as Record<string, number>)[key]),
    )) {
      this.serverBaseline = null;
      return;
    }
    this.serverBaseline = {
      model: this.modelVersion,
      server: { free: totals.free, held: totals.held, booked: totals.booked, blocked: totals.blocked },
      client: this.clientTallies(),
    };
  }

  /** What the client's own model says — GA units included since `render()`. */
  private clientTallies(): { free: number; held: number; booked: number; blocked: number } {
    const { held, booked, blocked } = this.counts;
    // The snapshot only carries non-free, so free is what is left over.
    return { held, booked, blocked, free: Math.max(0, this.unitTotal() - held - booked - blocked) };
  }

  /**
   * The numbers the KPI bar and rail render.
   *
   * The server is the authority: its totals land exactly as read, and the
   * delta-driven client model carries them forward until the next read. Before
   * the first snapshot — and after a wholesale model replacement invalidates the
   * pairing — the client model stands alone.
   */
  private buildTallies(): SeatManagerTallies {
    const client = this.clientTallies();
    const baseline = this.serverBaseline?.model === this.modelVersion ? this.serverBaseline : null;
    const of = (key: 'free' | 'held' | 'booked' | 'blocked'): number => (baseline
      ? Math.max(0, baseline.server[key] + (client[key] - baseline.client[key]))
      : client[key]);
    const seatTotal = this.controlRoomSnapshot?.event?.seatTotal;
    const t: SeatManagerTallies = {
      free: of('free'), held: of('held'), booked: of('booked'), blocked: of('blocked'),
      total: Number.isFinite(seatTotal) ? (seatTotal as number) : this.unitTotal(),
      capacityPct: 0,
      sellThroughPct: 0,
      grossRevenue: this.authoritativeGrossRevenue,
      revenueStatus: this.revenueStatus,
      currency: this.currency,
    };
    t.capacityPct = t.total ? Math.round((t.booked / t.total) * 100) : 0;
    const sellable = t.total - t.blocked;
    t.sellThroughPct = sellable > 0 ? Math.round((t.booked / sellable) * 100) : 0;
    return t;
  }

  /**
   * Queue one KPI/rail repaint for this burst of changes.
   *
   * A delta frame can carry hundreds of seats and `paintKpis` rebuilds eight
   * nodes from scratch, so painting per change is what made an arena-sized
   * frame expensive. Coalescing on a frame keeps the burst to a single rebuild;
   * without `requestAnimationFrame` (SSR, an older test env) it paints inline
   * rather than dropping the update.
   */
  private recomputeTallies(): void {
    if (this.closed) return;
    if (typeof requestAnimationFrame !== 'function') { this.flushTallies(); return; }
    if (this.paintHandle !== null) return;
    this.paintHandle = requestAnimationFrame(() => {
      this.paintHandle = null;
      this.flushTallies();
    });
  }

  private flushTallies(): void {
    if (this.closed) return;
    const t = this.buildTallies();
    this.paintKpis(t);
    if (this.mode === 'view') {
      this.paintLegend(t);
      this.paintMonitorInsights();
    } else if (this.mode === 'inspect') this.renderInspectRail(this.getSelection());
    else if (this.mode === 'block') this.paintSelBar(this.getSelection());
    else if (this.mode === 'channels') this.channels?.handleSelectionChange();
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
    else if (this.mode === 'channels') this.channels?.handleSelectionChange();
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
          <button class="slm-mode" role="tab" data-mode="sections" title="Sections (S)" aria-keyshortcuts="S">Sections</button>
          <button class="slm-mode" role="tab" data-mode="channels" title="Channels (C)" aria-keyshortcuts="C" hidden>Channels</button>
        </div>
        <select class="slm-tools" data-ref="tools" aria-label="Manager tools"></select>
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
      modes: ref('modes'), tools: ref('tools'), livetext: ref('livetext'), kpis: ref('kpis'),
      follow: ref('follow'), heat: ref('heat'), fullscreen: ref('fullscreen'),
      zoomhint: ref('zoomhint'), liveevent: ref('liveevent'), rail: ref('rail'), toast: ref('toast'), zfit: ref('zfit'),
    };
    this.els.modes.querySelectorAll('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.setMode((b as HTMLElement).dataset.mode as SeatManagerMode)));
    // Below the compact breakpoint the pills collapse into ONE accessible Tools
    // picker (§13) — never a tab strip plus a second scrolling mechanism.
    this.els.tools.addEventListener('change', () =>
      this.setMode((this.els.tools as HTMLSelectElement).value as SeatManagerMode));
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
    this.channels?.handleLayoutChange();
  }

  private sectionOptions: { id: string; label: string }[] = [];

  private buildSectionOptions(): void {
    if (!this.doc) return;
    try {
      const secs = computeSections(this.doc);
      this.sectionsBase = secs;
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
    const available: Array<{ mode: SeatManagerMode; label: string }> = [];
    this.els.modes?.querySelectorAll('[data-mode]').forEach((b) => {
      const el = b as HTMLElement;
      const mode = el.dataset.mode as SeatManagerMode;
      // No channel-view capability ⇒ the pill is not rendered at all. A hidden
      // control is honest about authority; a disabled one advertises it.
      const permitted = mode !== 'channels' || !!this.channels;
      el.hidden = !permitted;
      if (!permitted) return;
      available.push({ mode, label: el.textContent ?? mode });
      const active = mode === this.mode;
      el.classList.toggle('on', active);
      el.setAttribute('aria-selected', String(active));
      el.tabIndex = active ? 0 : -1;
    });
    const tools = this.els.tools as HTMLSelectElement | undefined;
    if (tools) {
      tools.innerHTML = available.map((entry) =>
        `<option value="${entry.mode}"${entry.mode === this.mode ? ' selected' : ''}>${esc(entry.label)}</option>`).join('');
      tools.value = this.mode;
    }
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

    // Tell the host only on a real edge. `connect()` can call this with the
    // same value it already had (an open that follows a reconnect attempt),
    // and a banner that re-announces itself on every retry is noise.
    const next: SeatManagerConnection['status'] = on ? 'live' : 'reconnecting';
    if (next === this.connectionStatus) return;
    this.connectionStatus = next;
    try {
      this.opts.onConnectionChange?.(this.getConnection());
    } catch (err) {
      // A host callback must never take the socket down with it.
      this.opts.onError?.(err);
    }
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
    const presence = this.presenceCounts();
    // Two different units share this bar and used to be interleaved: "Held
    // seats" (seat units) sat next to "Active holds" (checkout sessions), which
    // read as the same quantity counted twice. Seat tallies are grouped, the
    // session-scale pair is grouped, and the session one is named for what it
    // is — a cart.
    const items: { key: string; raw: number | null; n: string; l: string; dot?: string; title: string }[] = [
      { key: 'sold-seats', raw: t.booked, n: t.booked.toLocaleString(), l: 'Sold seats', dot: '#22a06b', title: 'Seats booked' },
      { key: 'held-seats', raw: t.held, n: t.held.toLocaleString(), l: 'Held seats', dot: '#f4b740', title: 'Seats held in a checkout right now' },
      { key: 'free-seats', raw: t.free, n: t.free.toLocaleString(), l: 'Free seats', dot: '#6e7bff', title: 'Seats on sale and unsold' },
      { key: 'blocked', raw: t.blocked, n: t.blocked.toLocaleString(), l: 'Blocked', dot: '#8b94ac', title: 'Seats withheld from sale' },
      { key: 'buyers', raw: presence?.shoppingSessions ?? null, n: presence ? presence.shoppingSessions.toLocaleString() : '—', l: 'Buyers', title: 'People on the map right now' },
      { key: 'carts', raw: presence?.activeHolds ?? null, n: presence ? presence.activeHolds.toLocaleString() : '—', l: 'Carts', title: 'Checkouts holding seats right now — sessions, not seats' },
      { key: 'sold-pct', raw: t.capacityPct, n: `${t.capacityPct}%`, l: 'Sold', title: 'Sold seats as a share of the whole event' },
      { key: 'gross-sales', raw: t.revenueStatus === 'current' ? t.grossRevenue : null, n: rev, l: 'Gross sales', title: 'Exact booked gross' },
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
      return `<div class="slm-kpi${activeDelta ? ' changed' : ''}" data-kpi="${item.key}" title="${esc(item.title)}">
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
    else if (this.mode === 'sections') this.renderSectionsRail();
    else if (this.mode === 'channels') this.channels?.paintRail();
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

  /** Live presence wins over the snapshot's copy — it is the fresher channel,
   *  and it exists from the first frame rather than the first fetch. */
  private presenceCounts(): { shoppingSessions: number; activeHolds: number } | null {
    return this.livePresence?.value ?? this.controlRoomSnapshot?.presence ?? null;
  }

  private paintMonitorInsights(): void {
    if (this.mode !== 'view') return;
    const snapshot = this.controlRoomSnapshot;
    if (this.els.presence) {
      const connected = this.root?.classList.contains('live');
      const sync = this.lastSyncedAt ? relTime(this.lastSyncedAt, Date.now()) : 'waiting';
      const presence = this.presenceCounts();
      this.els.presence.innerHTML = `
        <div class="slm-healthitem" title="People on the map right now"><b>${presence ? presence.shoppingSessions.toLocaleString() : '—'}</b><span>Buyers</span></div>
        <div class="slm-healthitem" title="Checkouts holding seats right now — sessions, not seats"><b>${presence ? presence.activeHolds.toLocaleString() : '—'}</b><span>Carts</span></div>
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

  // ---- sections: availability windows --------------------------------------

  /** Pull the organizer's availability rules (event:view). Called on load and on
   *  every WS (re)connect, mirroring how the other panels re-hydrate. `closed` is
   *  deterministic from the rules; `hidden` (which folds in already-due timed /
   *  threshold windows) comes from the snapshot + WS effective set. */
  private async refreshAvailability(): Promise<void> {
    try {
      const res = await this.withAuthRetry(() => this.api.availability(this.key));
      this.availabilityRules = res.rules ?? {};
      this.effectiveClosed = new Set(this.closedIdsFromRules(this.availabilityRules));
      if (this.mode === 'sections') this.renderSectionsRail();
      this.applySectionCanvasTreatment();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /** Run a token-authed op; on a 401 re-mint via onTokenRefresh and retry once. */
  private async withAuthRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof ManageApiError && err.status === 401 && this.opts.onTokenRefresh && !this.tokenRefreshInFlight) {
        await this.rotateToken();
        return op();
      }
      throw err;
    }
  }

  private closedIdsFromRules(rules: Record<string, AvailabilityRule>): string[] {
    return Object.entries(rules).filter(([, r]) => r.mode === 'closed').map(([id]) => id);
  }

  /** Adopt a new effective hidden/closed set (from a snapshot or WS broadcast) and
   *  repaint the rail + canvas when it actually moves. */
  private updateEffectiveAvailability(hidden?: string[], closed?: string[]): void {
    let changed = false;
    if (Array.isArray(hidden)) {
      this.effectiveHidden = new Set(hidden.filter((x): x is string => typeof x === 'string'));
      changed = true;
    }
    if (Array.isArray(closed)) {
      this.effectiveClosed = new Set(closed.filter((x): x is string => typeof x === 'string'));
      changed = true;
    }
    if (!changed) return;
    if (this.mode === 'sections') this.renderSectionsRail();
    this.applySectionCanvasTreatment();
  }

  /** Canvas read of the availability state: dim hidden sections to a whisper,
   *  half-light closed sections, leave open sections normal. Only in Sections mode;
   *  cleared in every other tool. */
  private applySectionCanvasTreatment(): void {
    if (!this.renderer) return;
    if (this.mode === 'sections') {
      this.renderer.setDimmedSections([...this.effectiveHidden]);
      this.renderer.setClosedSections([...this.effectiveClosed]);
    } else {
      this.renderer.setDimmedSections(null);
      this.renderer.setClosedSections(null);
    }
  }

  /** Zone-grouped render tree: each zone header then its sections (which follow the
   *  zone window), then loose sections + the ungrouped bucket. Effective hidden /
   *  closed come from the live sets, rules from the organizer map. */
  private buildSectionRows(): { rows: SectionRow[]; hiddenSections: number; closedSections: number } {
    const base = this.sectionsBase;
    if (!base) return { rows: [], hiddenSections: 0, closedSections: 0 };
    const zones = this.doc?.zones ?? [];
    const byZone = new Map<string, SectionNode[]>();
    const loose: SectionNode[] = [];
    for (const s of base.sections) {
      if (s.zone && zones.some((z) => z.id === s.zone)) {
        const list = byZone.get(s.zone) ?? [];
        list.push(s);
        byZone.set(s.zone, list);
      } else {
        loose.push(s);
      }
    }
    const rows: SectionRow[] = [];
    let hiddenSections = 0;
    let closedSections = 0;
    const push = (
      kind: 'zone' | 'section',
      node: { id: string; label: string; seatCount: number; seatLabels: string[] },
      zoneRuled: boolean,
      parentClosed = false,
    ): void => {
      const rule = this.availabilityRules[node.id] ?? null;
      const effClosed = this.effectiveClosed.has(node.id) || parentClosed;
      // A closed section stays visible-but-off-sale, never counted as hidden.
      const effHidden = this.effectiveHidden.has(node.id) || (zoneRuled && !effClosed);
      if (kind === 'section' && effHidden) hiddenSections += 1;
      if (kind === 'section' && effClosed) closedSections += 1;
      rows.push({
        kind, id: node.id, label: node.label, seatCount: node.seatCount, seatLabels: node.seatLabels,
        rule, hidden: effHidden, closed: effClosed, followsZone: kind === 'section' && zoneRuled,
      });
    };
    for (const z of zones) {
      const secs = byZone.get(z.id);
      if (!secs || !secs.length) continue;
      const zoneNode = {
        id: z.id,
        label: z.label || 'Zone',
        seatCount: secs.reduce((sum, s) => sum + s.seatCount, 0),
        seatLabels: secs.flatMap((s) => s.seatLabels),
      };
      const zoneRuled = !!this.availabilityRules[z.id];
      const zoneClosed = this.availabilityRules[z.id]?.mode === 'closed';
      push('zone', zoneNode, false);
      for (const s of secs) push('section', s, zoneRuled, zoneClosed);
    }
    for (const s of loose) push('section', s, false);
    if (base.ungrouped) {
      const u = base.ungrouped;
      push('section', { id: UNGROUPED_ID, label: u.label, seatCount: u.seatCount, seatLabels: u.seatLabels }, false);
    }
    return { rows, hiddenSections, closedSections };
  }

  private renderSectionsRail(): void {
    const { rows, hiddenSections, closedSections } = this.buildSectionRows();
    if (!rows.length) {
      this.els.rail.innerHTML = `
        <p class="slm-eyebrow">Availability windows</p>
        <p class="slm-hint">Draw sections or zones in the designer to schedule availability per area. This chart has none yet.</p>
        <div class="slm-empty">No sections on this chart.</div>`;
      return;
    }
    const parts: string[] = [];
    if (hiddenSections) parts.push(`${hiddenSections} hidden`);
    if (closedSections) parts.push(`${closedSections} closed`);
    const summary = parts.length ? parts.join(' · ') : 'All sections open and on sale';
    const warn = hiddenSections > 0 || closedSections > 0;
    this.els.rail.innerHTML = `
      <p class="slm-eyebrow">Availability windows</p>
      <p class="slm-hint">Control when each zone or section goes on sale. Keep it hidden, reveal it at a set time, or <b>auto-reveal once the rest sells past a threshold</b>. Hidden seats vanish for buyers; closed seats stay on the map (flat grey) but can't be bought.</p>
      <div class="slm-availlist" data-ref="availlist">${rows.map((row) => this.sectionRowHtml(row)).join('')}</div>
      <div class="slm-availsummary">
        <span class="slm-availdot${warn ? ' warn' : ''}"></span>
        <span>${esc(summary)}</span>
      </div>
      <div class="slm-availcallout">
        <span class="slm-availstar" aria-hidden="true">✦</span>
        <p><b>Auto-reveal at % sold</b> is our differentiator — demand-triggered release: the balcony opens itself the moment the stalls hit the threshold. Neither seats.io nor Ticketmaster ships this.</p>
      </div>`;
    this.wireSectionRail();
    this.applySectionCanvasTreatment();
  }

  private sectionRowHtml(row: SectionRow): string {
    const mode = availabilityModeOf(row.rule);
    const cls = `slm-availrow${row.kind === 'zone' ? ' zone' : ''}${row.hidden ? ' hidden' : ''}${row.closed ? ' closed' : ''}`;
    const disabled = this.availabilitySaving ? ' disabled' : '';
    const option = (value: AvailabilityMode, text: string): string =>
      `<option value="${value}"${mode === value ? ' selected' : ''}>${text}</option>`;
    const control = row.followsZone
      ? '<span class="slm-availfollows">Follows zone</span>'
      : `<span class="slm-availselwrap">
          <select class="slm-select slm-availmode${mode !== 'open' ? ' on' : ''}" data-avail-id="${esc(row.id)}"${disabled} aria-label="Availability for ${esc(row.label)}">
            ${option('open', 'Open — on sale')}
            ${option('closed', 'Closed — visible, not on sale')}
            ${option('hidden', 'Hidden — off the buyer map')}
            ${option('timed', 'Reveal at a time')}
            ${option('threshold', 'Auto-reveal at % sold')}
          </select>
        </span>`;
    let detail = '';
    if (!row.followsZone && mode === 'timed') {
      const value = row.rule?.revealAt ? esc(toLocalInput(row.rule.revealAt)) : '';
      detail = `<div class="slm-availdetail">
        <input type="datetime-local" class="slm-input" data-avail-reveal="${esc(row.id)}" value="${value}"${disabled} aria-label="Reveal time for ${esc(row.label)}" />
      </div>`;
    } else if (!row.followsZone && mode === 'threshold') {
      const pct = row.rule?.thresholdPct ?? 80;
      detail = `<div class="slm-availdetail">
        <span class="slm-availpctlabel">Reveal at</span>
        <input type="number" min="1" max="100" class="slm-input slm-availpct" data-avail-pct="${esc(row.id)}" value="${esc(pct)}"${disabled} aria-label="Percent sold to reveal ${esc(row.label)}" />
        <span class="slm-availpctlabel">% sold</span>
      </div>`;
    }
    const badge = row.closed
      ? '<span class="slm-availbadge closed">Closed</span>'
      : row.hidden ? '<span class="slm-availbadge hidden">Hidden</span>' : '';
    const caret = row.kind === 'zone' ? `<span class="slm-availcaret" aria-hidden="true">${row.hidden ? '▸' : '▾'}</span>` : '';
    return `<div class="${cls}">
      <div class="slm-availhead">
        <span class="slm-availlabel">${caret}${esc(row.label)}</span>
        ${badge}
        <span class="slm-availcount">${row.seatCount.toLocaleString()}</span>
        ${control}
      </div>
      ${detail}
    </div>`;
  }

  private wireSectionRail(): void {
    const rail = this.els.rail;
    if (!rail) return;
    rail.querySelectorAll<HTMLSelectElement>('[data-avail-id]').forEach((select) => {
      select.addEventListener('change', () => this.setSectionMode(select.dataset.availId!, select.value as AvailabilityMode));
    });
    rail.querySelectorAll<HTMLInputElement>('[data-avail-reveal]').forEach((input) => {
      input.addEventListener('change', () => {
        const ms = new Date(input.value).getTime();
        if (Number.isFinite(ms)) this.setSectionRulePatch(input.dataset.availReveal!, { revealAt: ms });
      });
    });
    rail.querySelectorAll<HTMLInputElement>('[data-avail-pct]').forEach((input) => {
      input.addEventListener('change', () => {
        const pct = Math.max(1, Math.min(100, Number(input.value) || 0));
        this.setSectionRulePatch(input.dataset.availPct!, { thresholdPct: pct });
      });
    });
  }

  /** Change one row's availability mode. A zone rule subsumes its child section
   *  rules, so those are dropped from the map (the zone window is the truth). */
  private setSectionMode(id: string, mode: AvailabilityMode): void {
    const row = this.buildSectionRows().rows.find((r) => r.id === id);
    const seatLabels = row?.seatLabels ?? this.availabilityRules[id]?.labels ?? [];
    const next = { ...this.availabilityRules };
    const rule = availabilityRuleForMode(mode, seatLabels, this.availabilityRules[id]);
    if (rule) next[id] = rule;
    else delete next[id];
    if (row?.kind === 'zone' && this.sectionsBase) {
      for (const s of this.sectionsBase.sections) if (s.zone === id) delete next[s.id];
    }
    void this.persistAvailability(next);
  }

  /** Edit a timed reveal time / threshold percent on an existing row rule. */
  private setSectionRulePatch(id: string, patch: Partial<AvailabilityRule>): void {
    const cur = this.availabilityRules[id];
    if (!cur) return;
    const row = this.buildSectionRows().rows.find((r) => r.id === id);
    const labels = row?.seatLabels ?? cur.labels ?? [];
    void this.persistAvailability({ ...this.availabilityRules, [id]: { ...cur, ...patch, labels } });
  }

  /** Optimistically adopt the new rules, then reconcile with the server-cleaned
   *  map + effective hidden/closed sets. Rolls back the rules on failure. */
  private async persistAvailability(next: Record<string, AvailabilityRule>): Promise<void> {
    const prev = this.availabilityRules;
    this.availabilityRules = next;
    this.availabilitySaving = true;
    if (this.mode === 'sections') this.renderSectionsRail();
    try {
      const res = await this.withAuthRetry(() => this.api.setAvailability(this.key, next));
      this.availabilityRules = res.rules;
      this.effectiveHidden = new Set(res.hidden);
      this.effectiveClosed = new Set(this.closedIdsFromRules(res.rules));
      this.availabilitySaving = false;
      if (this.mode === 'sections') this.renderSectionsRail();
      this.applySectionCanvasTreatment();
    } catch (err) {
      this.availabilityRules = prev;
      this.availabilitySaving = false;
      if (this.mode === 'sections') this.renderSectionsRail();
      this.toastErr("Couldn't update availability. Try again.");
      this.opts.onError?.(err);
    }
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
    // An explicit organizer action is one of the three moments the server's own
    // totals and money are re-read (mount, (re)connect, action) — the cockpit
    // does not poll for them.
    if (action !== 'setHoldTtl') void this.refreshControlRoom().catch((err) => this.opts.onError?.(err));
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
