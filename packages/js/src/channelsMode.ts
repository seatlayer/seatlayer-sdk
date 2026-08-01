/**
 * Channels mode — the sales-channel management surface inside the SeatManager
 * cockpit. It ships in the SDK, so every embedding platform (and our own Control
 * Room) gets the same organizer experience.
 *
 * Design contract: `SeatmapUX/05 Event Manager.dc.html` (all 8 desktop states +
 * the mobile artboard). Behaviour: sales-channels-product-ux-spec §8 (states),
 * §9 (language), §13 (a11y + compact detents). Motion: motion-system §2 tokens,
 * mirrored here as `--slm-mo-*` so an embed is self-contained, and §3 cockpit
 * choreography.
 *
 * Boundaries this module keeps:
 *
 *   - **Capability gating is fail-closed.** Without `event:channels:view` the
 *     cockpit never renders the pill (SeatManager's job). Without
 *     `event:channels:manage` every mutation control is ABSENT — not disabled —
 *     so a read-only operator is never shown authority they do not have.
 *   - **Nothing here mutates physical inventory.** Assignment moves an
 *     allocation; held and booked units are never rewritten.
 *   - **Staging is local, truth is the server.** There is no dry-run endpoint,
 *     so the Review sheet previews the buckets client-side and then re-renders
 *     the AUTHORITATIVE bucket counts from the Apply response. A stale
 *     `assignmentVersion` mutates nothing: the selection survives and the only
 *     action offered is Refresh and review.
 *   - **Forward-compatible reads.** The `access` field and the buyer-preview
 *     projection land on the access-hardening branch. Both are feature-detected;
 *     absent, the access line reads "—" and the Preview segment says it needs a
 *     newer server. Neither ever blocks allocation work.
 */
import {
  PUBLIC_CHANNEL_ID,
  PUBLIC_CHANNEL_NAME,
  accessIntentLabel,
  accessLine,
  bucketRows,
  isPublicChannelId,
  markerLetter,
  markerOf,
  mutationCount,
  needsMoveConfirmation,
  planAssignment,
  retryAfterCopy,
  selectionSources,
  stateBadge,
  suggestMarker,
  type AssignmentBuckets,
  type AssignmentResult,
  type ArchiveBlockedDetails,
  type BucketRow,
  type ChannelAccessIntent,
  type ChannelListResult,
  type ChannelRecord,
  type ChannelSeatStatus,
} from './channelPlan';
import type {
  ChannelAllocationPage,
  ChannelPreviewProjection,
} from './manageApi';
import { ManageApiError } from './manageApi';

/** The seat facts the overlay needs. Chart space, not screen space. */
export interface ChannelsSeatView {
  id: string;
  label: string;
  x: number;
  y: number;
}

/** The `ManageApi` subset Channels mode uses — structural so tests can pass a
 *  hand-rolled double without constructing a real client. */
export interface ChannelsClient {
  channels(key: string, opts?: { includeArchived?: boolean }): Promise<ChannelListResult>;
  channelAllocation(key: string, opts?: { afterLabel?: string; limit?: number }): Promise<ChannelAllocationPage>;
  createChannel(
    key: string,
    input: { name: string; color?: string | null; marker?: string | null; externalRef?: string | null },
  ): Promise<{ ok: true; channel: ChannelRecord }>;
  renameChannel(key: string, channelId: string, name: string): Promise<{ ok: true; channel: ChannelRecord }>;
  setChannelPaused(key: string, channelId: string, paused: boolean): Promise<{ ok: true; channel: ChannelRecord }>;
  archiveChannel(
    key: string,
    channelId: string,
    destination: string | null,
  ): Promise<{ ok: true; channel: ChannelRecord; assignmentVersion: number; moved: number }>;
  applyChannelAssignment(
    key: string,
    input: { targetChannelId: string | null; labels: string[]; assignmentVersion: number },
  ): Promise<AssignmentResult>;
  channelPreview(
    key: string,
    channelIds: string[],
    opts?: { includePublic?: boolean },
  ): Promise<ChannelPreviewProjection>;
  setChannelAccessIntent(
    key: string,
    channelId: string,
    accessIntent: ChannelAccessIntent,
  ): Promise<{ ok: true; channel: ChannelRecord }>;
}

export interface ChannelsCapabilities {
  view: boolean;
  manage: boolean;
}

/** Everything Channels mode needs from the cockpit around it. */
export interface ChannelsModeHost {
  eventKey: string;
  api: ChannelsClient;
  /** The rail scroll container the mode paints into. */
  rail: HTMLElement;
  /** An absolutely-positioned layer over the map (overlay canvas, flags, bars). */
  mapLayer: HTMLElement;
  /** The widget root — dialogs mount here so they inherit the widget's tokens. */
  root: HTMLElement;
  seats(): ChannelsSeatView[];
  statusOf(label: string): ChannelSeatStatus | undefined;
  selectionLabels(): string[];
  selectByLabels(labels: string[]): void;
  clearSelection(): void;
  selectSection(sectionId: string): void;
  sections(): Array<{ id: string; label: string }>;
  categories(): Array<{ key: string; label: string; color?: string }>;
  labelsInCategory(key: string): string[];
  sectionOfLabel(label: string): { id: string; label: string } | null;
  /** Chart-space → container pixels. Null when there is no live renderer. */
  worldToScreen(point: { x: number; y: number }): { x: number; y: number } | null;
  /** Approximate on-screen seat size in CSS pixels, for the overlay marks. */
  seatPixelSize(): number;
  isCompact(): boolean;
  /** Make the canvas non-interactive behind a full-detent sheet (§13). */
  setMapInert(inert: boolean): void;
  toast(message: string, kind: 'ok' | 'err'): void;
  onError(err: unknown): void;
  /** Fired whenever the staged mutation count changes, for host telemetry. */
  onStagedChange?(staged: number): void;
}

/** Live-count refresh cadence. Matches the cockpit's existing STATS clock.
 *  Organizer realtime (M5's per-scope socket) plugs in at `applyRealtimeHint`. */
const POLL_MS = 10_000;
const MAX_FLAGS = 8;
const SEAT_LIST_PAGE = 300;

/**
 * Motion tokens (motion-system §2) plus Channels choreography (§3). Declared on
 * the widget root as `--slm-mo-*` so an embed never inherits host motion CSS.
 * Every keyframe below has its `prefers-reduced-motion` override in this block.
 */
export const CHANNELS_CSS = `
.slm{--slm-mo-instant:80ms;--slm-mo-quick:140ms;--slm-mo-base:200ms;--slm-mo-slow:320ms;--slm-mo-ambient:2000ms;
  --slm-mo-out:cubic-bezier(.2,.8,.2,1);--slm-mo-in-out:cubic-bezier(.4,0,.2,1);--slm-mo-exit:cubic-bezier(.4,0,1,1);
  --slm-mo-spring:cubic-bezier(.34,1.3,.64,1)}

/* map overlay: ONE layer, faded in as a whole (never per seat) */
.slm-ch-layer{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity var(--slm-mo-base) var(--slm-mo-out)}
.slm-ch-layer.on{opacity:1}
.slm-ch-canvas{position:absolute;inset:0;width:100%;height:100%}
.slm-ch-flag{position:absolute;display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;
  background:rgba(14,16,23,.88);border:1px solid var(--slm-line);font-size:10px;font-weight:800;letter-spacing:.04em;
  transform:translate(-50%,-50%);white-space:nowrap}
.slm-ch-flag .mk{width:14px;height:14px;border-radius:4px;display:grid;place-items:center;font-size:8.5px;font-weight:800;color:#0e1017}

/* preview banner — raised with the organizer chrome dim, as one transition */
.slm-ch-banner{position:absolute;left:50%;top:14px;z-index:6;display:flex;align-items:center;gap:9px;padding:8px 14px;
  border-radius:999px;background:rgba(14,16,23,.92);border:1px solid var(--slm-line);font-size:12px;font-weight:700;
  transform:translate(-50%,-8px);opacity:0;pointer-events:none;
  transition:opacity var(--slm-mo-base) var(--slm-mo-out),transform var(--slm-mo-base) var(--slm-mo-out)}
.slm-ch-banner.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}
.slm-ch-banner .dot{width:8px;height:8px;border-radius:50%}
.slm-ch-banner button{color:var(--slm-accent);font-weight:800;font-size:11.5px;min-height:32px}
.slm.ch-preview .slm-ch-flag{opacity:0;transition:opacity var(--slm-mo-base) var(--slm-mo-out)}

/* sticky staged bar */
.slm-ch-staged{position:absolute;left:12px;right:12px;bottom:12px;z-index:6;display:flex;align-items:center;gap:12px;
  padding:10px 14px;min-height:44px;border-radius:12px;background:rgba(24,27,36,.96);border:1px solid var(--slm-line);
  box-shadow:0 12px 34px rgba(0,0,0,.45);font-size:12.5px;pointer-events:auto;
  transform:translateY(calc(100% + 18px));opacity:0;
  transition:transform var(--slm-mo-slow) var(--slm-mo-out),opacity var(--slm-mo-base) var(--slm-mo-out)}
.slm-ch-staged.on{transform:none;opacity:1}
.slm-ch-staged.done{background:rgba(31,122,77,.96);border-color:#1f7a4d}
.slm-ch-staged.shake{animation:slm-ch-shake 320ms var(--slm-mo-in-out) 2}
.slm-ch-staged b{font-variant-numeric:tabular-nums}
.slm-ch-staged .grow{flex:1}
.slm-ch-staged .go{padding:9px 16px;min-height:44px;display:inline-flex;align-items:center;border-radius:9px;
  background:#f4b740;color:#1a1200;font-weight:800;font-size:12.5px}
.slm-ch-staged .drop{color:var(--slm-muted);font-weight:700;font-size:11.5px;min-height:44px;padding-inline:8px}
.slm-ch-tick{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;
  background:#fff;color:#1f7a4d;font-weight:900;font-size:11px;animation:slm-ch-tick var(--slm-mo-base) var(--slm-mo-spring)}
@keyframes slm-ch-shake{0%,100%{transform:none}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@keyframes slm-ch-tick{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}

/* rail */
.slm-ch-viewseg{display:flex;gap:3px;padding:3px;border:1px solid var(--slm-line);border-radius:9px;
  background:var(--slm-surface);margin-bottom:12px}
.slm-ch-viewseg button{flex:1;padding:6px 8px;min-height:34px;border-radius:7px;font-size:11px;font-weight:800;color:var(--slm-muted)}
.slm-ch-viewseg button.on{background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-ch-viewseg button:disabled{opacity:.5;cursor:not-allowed}
.slm-ch-list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.slm-ch-row{padding:10px 11px;border:1px solid var(--slm-line);border-radius:10px;background:var(--slm-surface);
  text-align:left;width:100%;display:block;transition:border-color var(--slm-mo-quick) var(--slm-mo-out)}
.slm-ch-row:hover{border-color:var(--slm-muted)}
.slm-ch-row.on{border-color:var(--slm-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--slm-accent) 40%,transparent)}
.slm-ch-row.public{background:linear-gradient(100deg,rgba(244,183,64,.09),var(--slm-surface) 60%)}
.slm-ch-row.archived{opacity:.68}
.slm-ch-head{display:flex;align-items:center;gap:8px}
.slm-ch-mk{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-size:10px;font-weight:800;
  color:#0e1017;flex:none}
.slm-ch-mk.dim{opacity:.55}
.slm-ch-name{flex:1;min-width:0;font-size:13px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slm-ch-badge{flex:none;font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:999px}
.slm-ch-badge.active{background:rgba(34,160,107,.16);color:#5bd39b}
.slm-ch-badge.paused,.slm-ch-badge.builtin{background:rgba(244,183,64,.15);color:#f7ca6b}
.slm-ch-badge.archived{background:rgba(139,148,172,.18);color:#c2c9d8}
.slm-ch-counts{display:flex;gap:10px;flex-wrap:wrap;margin-top:7px;font-size:11px;color:var(--slm-muted);
  font-variant-numeric:tabular-nums}
.slm-ch-counts b{color:var(--slm-text);font-weight:800}
.slm-ch-counts .free b{color:#5bd39b}
.slm-ch-counts b.bump{animation:slm-ch-bump .58s var(--slm-mo-spring)}
@keyframes slm-ch-bump{0%,100%{transform:none}35%{transform:translateY(-2px) scale(1.08)}}
.slm-ch-access{margin-top:6px;font-size:10.5px;color:var(--slm-muted)}
.slm-ch-more{flex:none;color:var(--slm-muted);font-weight:800;padding:0 4px;min-height:28px}
.slm-ch-selsrc{display:flex;flex-direction:column;gap:5px;margin:8px 0 12px}
.slm-ch-selsrc-row{display:flex;align-items:center;gap:8px;font-size:12px;font-variant-numeric:tabular-nums}
.slm-ch-selsrc-row .mk{width:15px;height:15px;border-radius:4px;display:grid;place-items:center;font-size:8px;
  font-weight:800;color:#0e1017}
.slm-ch-selsrc-row b{min-width:30px;text-align:right;font-weight:800}
.slm-ch-selsrc-row span{color:var(--slm-muted)}
.slm-ch-selnum.bump{animation:slm-ch-bump .58s var(--slm-mo-spring)}
.slm-ch-row2{display:flex;gap:8px;margin-top:8px}
.slm-ch-row2 .slm-btn{flex:1;min-width:0}
.slm-ch-alert{display:flex;align-items:flex-start;gap:9px;padding:11px 13px;border-radius:10px;font-size:12.5px;
  line-height:1.5;margin-bottom:12px}
.slm-ch-alert.warn{background:rgba(244,183,64,.1);border:1px solid rgba(244,183,64,.4);color:#f4d58a}
.slm-ch-alert.err{background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.45);color:#f1a4a6}
.slm-ch-alert b{color:#fff}
.slm-ch-alert button{display:block;margin-top:6px;color:#fff;font-weight:800;min-height:36px}
.slm-ch-legend{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.slm-ch-legend .r{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--slm-muted)}
.slm-ch-legend .sw{width:13px;height:13px;border-radius:3.5px;flex:none}
.slm-ch-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* dialogs */
.slm-ch-scrim{position:absolute;inset:0;z-index:12;background:rgba(4,6,12,.62);display:grid;place-items:center;
  padding:18px;animation:slm-ch-fade var(--slm-mo-quick) var(--slm-mo-out)}
.slm-ch-dialog{width:min(460px,100%);max-height:100%;overflow:auto;background:#12151f;border:1px solid var(--slm-line);
  border-radius:14px;padding:20px;box-shadow:0 24px 70px rgba(0,0,0,.6);
  animation:slm-ch-rise var(--slm-mo-base) var(--slm-mo-out)}
.slm-ch-dialog h3{margin:0 0 4px;font-size:16px;font-weight:800;letter-spacing:-.01em}
.slm-ch-dialog .sub{font-size:12.5px;color:var(--slm-muted);line-height:1.5;margin-bottom:14px}
.slm-ch-dialog .foot{display:flex;gap:8px;margin-top:16px}
.slm-ch-dialog .foot .slm-btn{flex:1;min-width:0}
.slm-ch-dialog .foot .quiet{flex:none;padding:10px 14px;min-height:44px;color:var(--slm-muted);font-weight:700;font-size:13px}
@keyframes slm-ch-fade{from{opacity:0}to{opacity:1}}
@keyframes slm-ch-rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.slm-ch-bucket{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:10px;padding:9px 4px;
  border-top:1px solid var(--slm-line);font-size:12.5px;animation:slm-ch-bucket var(--slm-mo-base) var(--slm-mo-out) both}
.slm-ch-bucket:first-of-type{border-top:0}
.slm-ch-bucket .ico{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-size:10px;font-weight:800}
.slm-ch-bucket .ico.add{background:rgba(34,160,107,.18);color:#5bd39b}
.slm-ch-bucket .ico.move{background:rgba(167,139,250,.18);color:#c4b5fd}
.slm-ch-bucket .ico.same{background:rgba(139,148,172,.14);color:#aab2c4}
.slm-ch-bucket .ico.skip{background:rgba(244,183,64,.16);color:#f7ca6b}
.slm-ch-bucket b{font-variant-numeric:tabular-nums;font-weight:800}
.slm-ch-bucket .why{color:var(--slm-muted);font-size:11px}
.slm-ch-bucket .peek{color:var(--slm-muted);font-size:11px;font-variant-numeric:tabular-nums}
@keyframes slm-ch-bucket{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.slm-ch-secret{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px dashed rgba(244,183,64,.55);
  border-radius:10px;background:rgba(244,183,64,.06);font-family:ui-monospace,Menlo,monospace;font-size:11px;
  overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.slm-ch-err{color:#f1a4a6;font-size:11.5px;margin-top:6px}
.slm-ch-seatlist{max-height:44vh;overflow:auto;border:1px solid var(--slm-line);border-radius:10px;
  background:var(--slm-surface);margin-top:10px}
.slm-ch-seatgroup{padding:8px 10px;border-bottom:1px solid var(--slm-line);display:flex;align-items:center;
  justify-content:space-between;gap:8px;font-size:11px;font-weight:800;color:var(--slm-muted);position:sticky;top:0;
  background:var(--slm-surface)}
.slm-ch-seatgroup button{color:var(--slm-accent);font-weight:800;font-size:11px;min-height:32px}
.slm-ch-seatitem{display:flex;width:100%;align-items:center;gap:9px;padding:8px 10px;border-bottom:1px solid var(--slm-line);
  text-align:left;font-size:12px}
.slm-ch-seatitem .box{width:16px;height:16px;border-radius:4px;border:1px solid var(--slm-muted);display:grid;
  place-items:center;font-size:10px;font-weight:900;color:transparent;flex:none}
.slm-ch-seatitem[aria-checked="true"] .box{border-color:var(--slm-accent);background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-ch-seatitem .meta{margin-left:auto;color:var(--slm-muted);font-size:10.5px}

/* compact: bottom sheet with three detents (§13) */
.slm.compact.ch-sheet .slm-rail{position:absolute;left:0;right:0;bottom:0;z-index:8;border-top:1px solid var(--slm-line);
  border-radius:18px 18px 0 0;background:#12151f;
  transition:height var(--slm-mo-slow) var(--slm-mo-in-out)}
.slm.compact.ch-sheet.detent-collapsed .slm-rail{height:132px}
.slm.compact.ch-sheet.detent-medium .slm-rail{height:46%}
.slm.compact.ch-sheet.detent-full .slm-rail{height:92%}
.slm.compact.ch-sheet .slm-railscroll{padding:8px 14px calc(12px + env(safe-area-inset-bottom,0px))}
.slm-ch-grab{display:none}
.slm.compact.ch-sheet .slm-ch-grab{display:flex;align-items:center;gap:10px;width:100%;padding:6px 0 10px}
.slm-ch-grabbar{width:42px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:0 auto}
.slm.compact .slm-ch-staged{bottom:auto;top:8px}
.slm.compact .slm-btn,.slm.compact .slm-ch-row,.slm.compact .slm-ch-viewseg button{min-height:44px}
.slm-tools{display:none}
.slm.compact .slm-tools{display:block;width:100%;padding:9px 13px;min-height:44px;border:1px solid var(--slm-line);
  border-radius:10px;background:var(--slm-surface);color:var(--slm-text);font-size:13px;font-weight:800}
.slm.compact .slm-modes{display:none}

@media (prefers-reduced-motion:reduce){
  .slm-ch-layer,.slm-ch-banner,.slm-ch-staged,.slm-ch-row,.slm.compact.ch-sheet .slm-rail{transition:none!important}
  .slm-ch-staged.shake,.slm-ch-tick,.slm-ch-bucket,.slm-ch-scrim,.slm-ch-dialog,
  .slm-ch-counts b.bump,.slm-ch-selnum.bump{animation:none!important}
  .slm-ch-staged.shake{outline:2px solid #e5484d;outline-offset:2px}
  .slm-ch-staged.done{outline:2px solid #5bd39b;outline-offset:2px}
}
`;

/**
 * Render bucket rows to markup. Deliberately generic over `BucketRow`, because
 * three different refusals share this exact presentation: the local staged
 * preview, the authoritative Apply response, and the chart-update
 * `channel_assignment_would_drop` review (via `dropReviewRows`). One component,
 * one visual language for "here is every affected unit, in exactly one line".
 */
export function bucketRowsHtml(rows: BucketRow[]): string {
  return rows.map((row, index) => `
    <div class="slm-ch-bucket" style="animation-delay:${Math.min(index, 4) * 30}ms">
      <span class="ico ${row.kind}" aria-hidden="true">${esc(row.icon)}</span>
      <span><b>${row.count.toLocaleString()}</b> ${esc(row.text.replace(/^[\d,.\s]+/, ''))}
        ${row.why ? `<span class="why">— ${esc(row.why)}</span>` : ''}</span>
      ${row.peek ? `<span class="peek">${esc(row.peek)}</span>` : '<span></span>'}
    </div>`).join('');
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

type Detent = 'collapsed' | 'medium' | 'full';

type DialogKind = 'create' | 'review' | 'archive' | 'rename' | 'link' | 'seatlist';

interface DialogState {
  kind: DialogKind;
  channelId?: string;
  /** Authoritative result rendered after Apply (review dialog only). */
  applied?: AssignmentResult | null;
  archiveBlocked?: ArchiveBlockedDetails | null;
  busy?: boolean;
  error?: string | null;
}

export class ChannelsMode {
  private readonly host: ChannelsModeHost;
  private caps: ChannelsCapabilities;

  private active = false;
  private list: ChannelListResult | null = null;
  private allocation = new Map<string, string>();
  private assignmentVersion = 0;
  private loadError: unknown = null;
  private loading = true;

  private view: 'inspect' | 'preview' = 'inspect';
  private showArchived = false;
  private detailChannelId: string | null = null;
  private targetChannelId = '';
  private conflict = false;
  private dialog: DialogState | null = null;
  private detent: Detent = 'medium';
  private seatListLimit = SEAT_LIST_PAGE;

  private previewAudience: string[] = [];
  private previewIncludePublic = false;
  private previewProjection: ChannelPreviewProjection | null = null;
  private previewSupported: boolean | null = null; // null = not yet probed

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private layer: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** undefined = not resolved yet, null = this environment has no 2d canvas. */
  private ctx: CanvasRenderingContext2D | null | undefined = undefined;
  private bannerEl: HTMLDivElement | null = null;
  private stagedEl: HTMLDivElement | null = null;
  private liveEl: HTMLDivElement | null = null;
  private scrimEl: HTMLDivElement | null = null;
  private lastFocus: HTMLElement | null = null;
  private stagedDoneTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSelectionCount = 0;
  private lastCounts = new Map<string, number>();

  constructor(host: ChannelsModeHost, capabilities: ChannelsCapabilities) {
    this.host = host;
    this.caps = capabilities;
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Called when the cockpit switches into Channels mode. */
  enter(): void {
    if (this.active) return;
    this.active = true;
    this.ensureLayer();
    this.host.root.classList.add('ch-mode');
    this.applySheetClasses();
    this.paintRail();
    void this.refresh();
    this.pollTimer = setInterval(() => { void this.refresh({ quiet: true }); }, POLL_MS);
  }

  /** Called when the cockpit leaves Channels mode. Everything this mode painted
   *  over the map goes with it — no other tool ever inherits a channel overlay. */
  leave(): void {
    if (!this.active) return;
    this.active = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.closeDialog({ restoreFocus: false });
    this.layer?.classList.remove('on');
    this.host.root.classList.remove('ch-mode', 'ch-preview', 'ch-sheet',
      'detent-collapsed', 'detent-medium', 'detent-full');
    this.setBanner(false);
    this.setStaged(null);
  }

  destroy(): void {
    this.leave();
    if (this.stagedDoneTimer) clearTimeout(this.stagedDoneTimer);
    this.layer?.remove();
    this.layer = null;
  }

  /** Capabilities can change when a token rotates. Re-render, fail-closed. */
  setCapabilities(capabilities: ChannelsCapabilities): void {
    this.caps = capabilities;
    if (this.active) this.paintRail();
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Whether the map should accept bulk selection right now. Preview is a
   * read-only simulation of somebody else's view, and a view-only token has no
   * assignment to stage — in both cases the canvas must not offer selection at
   * all rather than collect a selection nothing can act on.
   */
  canSelect(): boolean {
    return this.caps.manage && this.view === 'inspect';
  }

  /**
   * Organizer realtime integration point. M5 ships a per-scope socket for
   * buyers; the organizer channel-count stream is a later milestone. When it
   * arrives, call this from the cockpit's WS handler instead of waiting for the
   * poll — everything downstream already reacts to a fresh list.
   */
  applyRealtimeHint(): void {
    if (this.active) void this.refresh({ quiet: true });
  }

  /** The cockpit's selection changed (marquee / click / section / category). */
  handleSelectionChange(): void {
    if (!this.active) return;
    this.paintSelection();
    this.paintStagedBar();
  }

  /** Camera moved or the container resized — the overlay is screen-space. */
  handleViewChange(): void {
    if (this.active) this.paintOverlay();
  }

  handleLayoutChange(): void {
    if (!this.active) return;
    this.applySheetClasses();
    this.paintOverlay();
  }

  // ---- data -----------------------------------------------------------------

  private async refresh(opts: { quiet?: boolean } = {}): Promise<void> {
    if (!this.caps.view) return;
    try {
      const list = await this.host.api.channels(this.host.eventKey, { includeArchived: this.showArchived });
      this.list = list;
      this.assignmentVersion = list.assignmentVersion;
      this.loadError = null;
      if (!this.targetChannelId) {
        this.targetChannelId = list.channels.find((c) => c.state === 'active')?.id ?? PUBLIC_CHANNEL_ID;
      }
      await this.loadAllocation();
      this.loading = false;
      if (this.active) {
        this.paintRail();
        this.paintOverlay();
      }
    } catch (err) {
      this.loading = false;
      // A 403 on a mutation route means the token lost manage authority; a 403
      // here means it lost view. Either way, fail closed rather than guess.
      if (err instanceof ManageApiError && err.status === 403) {
        this.caps = { view: false, manage: false };
      }
      this.loadError = err;
      if (!opts.quiet) this.host.onError(err);
      if (this.active) this.paintRail();
    }
  }

  /** Walk every allocation page. Bounded by the event's seat count, and the
   *  server caps each page, so an arena is a handful of round trips. */
  private async loadAllocation(): Promise<void> {
    const next = new Map<string, string>();
    let afterLabel: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const res: ChannelAllocationPage = await this.host.api.channelAllocation(this.host.eventKey, {
        afterLabel, limit: 1000,
      });
      for (const row of res.allocations) {
        // The server names public sale explicitly on every row, so the map holds
        // PRIVATE ids only — absence is what "on public sale" means downstream.
        if (!isPublicChannelId(row.channelId)) next.set(row.label, row.channelId);
      }
      this.assignmentVersion = res.assignmentVersion;
      if (!res.nextAfterLabel) break;
      afterLabel = res.nextAfterLabel;
    }
    this.allocation = next;
  }

  // ---- lookups --------------------------------------------------------------

  private channelById(id: string): { id: string; name: string; marker: string | null; color: string | null } | null {
    if (isPublicChannelId(id)) {
      return {
        id: PUBLIC_CHANNEL_ID,
        name: this.list?.publicSale?.name ?? PUBLIC_CHANNEL_NAME,
        marker: 'P',
        color: null,
      };
    }
    const found = this.list?.channels.find((channel) => channel.id === id);
    return found ? { id, name: found.name, marker: found.marker, color: found.color } : null;
  }

  private nameOf(id: string): string | null {
    return this.channelById(id)?.name ?? null;
  }

  private markerFor(id: string): { letter: string; color: string } {
    const index = Math.max(0, this.list?.channels.findIndex((channel) => channel.id === id) ?? 0);
    const channel = this.channelById(id);
    return markerOf(channel ?? { id, name: '?', marker: null, color: null }, index);
  }

  /** Channels an organizer may assign INTO: public sale plus every live channel. */
  private assignableChannels(): Array<{ id: string; name: string }> {
    return [
      { id: PUBLIC_CHANNEL_ID, name: this.list?.publicSale.name ?? PUBLIC_CHANNEL_NAME },
      ...(this.list?.channels ?? [])
        .filter((channel) => channel.state !== 'archived')
        .map((channel) => ({ id: channel.id, name: channel.name })),
    ];
  }

  private currentPlan(): { labels: string[]; buckets: AssignmentBuckets; target: string } {
    const labels = this.host.selectionLabels();
    const buckets = planAssignment({
      labels,
      targetChannelId: this.targetChannelId,
      allocation: this.allocation,
      statusOf: (label) => this.host.statusOf(label),
      nameOf: (id) => this.nameOf(id),
    });
    return { labels, buckets, target: this.targetChannelId };
  }

  // ---- map overlay ----------------------------------------------------------

  private ensureLayer(): void {
    if (this.layer) return;
    const layer = document.createElement('div');
    layer.className = 'slm-ch-layer';
    layer.innerHTML = `
      <canvas class="slm-ch-canvas" data-ch="canvas" aria-hidden="true"></canvas>
      <div class="slm-ch-banner" data-ch="banner" role="status"></div>
      <div class="slm-ch-staged" data-ch="staged" role="group" aria-label="Staged channel changes"></div>
      <div class="slm-ch-live" data-ch="live" role="status" aria-live="polite"></div>`;
    this.host.mapLayer.appendChild(layer);
    this.layer = layer;
    this.canvas = layer.querySelector('[data-ch="canvas"]');
    this.bannerEl = layer.querySelector('[data-ch="banner"]');
    this.stagedEl = layer.querySelector('[data-ch="staged"]');
    this.liveEl = layer.querySelector('[data-ch="live"]');
    requestAnimationFrame(() => layer.classList.add('on'));
  }

  private announce(message: string): void {
    if (this.liveEl) this.liveEl.textContent = message;
  }

  /**
   * Repaint the allocation (or preview) overlay in ONE canvas pass.
   *
   * Channel identity on the map is a fill in the administrative color PLUS the
   * letter flags below — never color alone. Physical status keeps its own cue:
   * only FREE units take a channel fill, so sold/held/blocked seats still read
   * exactly as they do in every other tool.
   */
  private paintOverlay(): void {
    const canvas = this.canvas;
    const layer = this.layer;
    if (!canvas || !layer) return;
    const rect = this.host.mapLayer.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = typeof devicePixelRatio === 'number' ? Math.min(3, Math.max(1, devicePixelRatio)) : 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    // jsdom (and any canvas-less environment) has no 2d context; the overlay is
    // purely decorative there and the rail stays fully functional. Resolve it
    // once so a headless run is not spammed on every repaint.
    if (this.ctx === undefined) {
      try { this.ctx = canvas.getContext('2d'); } catch { this.ctx = null; }
    }
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const size = Math.max(3, this.host.seatPixelSize());
    const half = size / 2;
    // A paused/archived audience answers `available:false`: nothing is buyable
    // through it, so every seat takes the one neutral unavailable treatment
    // rather than rendering the allocation as if it were on sale.
    const projection = this.view === 'preview' ? this.previewProjection : null;
    const eligible = projection
      ? new Set(projection.available === false ? [] : projection.eligible ?? [])
      : null;
    const clusters = new Map<string, { x: number; y: number; n: number }>();

    for (const seat of this.host.seats()) {
      const status = this.host.statusOf(seat.label) ?? 'free';
      const channelId = this.allocation.get(seat.label) ?? PUBLIC_CHANNEL_ID;
      if (channelId !== PUBLIC_CHANNEL_ID) {
        const cluster = clusters.get(channelId) ?? { x: 0, y: 0, n: 0 };
        cluster.x += seat.x; cluster.y += seat.y; cluster.n += 1;
        clusters.set(channelId, cluster);
      }
      if (status !== 'free') continue; // physical state always wins the paint
      let fill: string | null = null;
      if (this.view === 'preview') {
        // ONE neutral unavailable state for everything this audience can't buy —
        // preview must never leak which private channel holds a seat.
        fill = eligible ? (eligible.has(seat.label) ? null : '#3a4051') : null;
      } else if (channelId !== PUBLIC_CHANNEL_ID) {
        fill = this.markerFor(channelId).color;
      }
      if (!fill) continue;
      const point = this.host.worldToScreen({ x: seat.x, y: seat.y });
      if (!point) continue;
      if (point.x < -size || point.y < -size || point.x > width + size || point.y > height + size) continue;
      ctx.fillStyle = fill;
      ctx.globalAlpha = this.view === 'preview' ? 0.9 : 0.85;
      ctx.fillRect(point.x - half, point.y - half, size, size);
    }
    ctx.globalAlpha = 1;
    this.paintFlags(clusters);
  }

  /** Letter flags at each channel's centroid — the non-color identity cue. */
  private paintFlags(clusters: Map<string, { x: number; y: number; n: number }>): void {
    const layer = this.layer;
    if (!layer) return;
    layer.querySelectorAll('.slm-ch-flag').forEach((el) => el.remove());
    if (this.view === 'preview') return;
    const ranked = [...clusters.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, MAX_FLAGS);
    for (const [channelId, cluster] of ranked) {
      const channel = this.list?.channels.find((item) => item.id === channelId);
      if (!channel) continue;
      const point = this.host.worldToScreen({ x: cluster.x / cluster.n, y: cluster.y / cluster.n });
      if (!point) continue;
      const marker = this.markerFor(channelId);
      const flag = document.createElement('span');
      flag.className = 'slm-ch-flag';
      flag.style.left = `${point.x}px`;
      flag.style.top = `${point.y}px`;
      flag.innerHTML = `<span class="mk" style="background:${esc(marker.color)}">${esc(marker.letter)}</span>`
        + `${esc(channel.name)}${channel.state === 'paused' ? ' · Paused' : ''}`;
      layer.appendChild(flag);
    }
  }

  // ---- staged bar -----------------------------------------------------------

  private setStaged(html: string | null, cls = ''): void {
    const bar = this.stagedEl;
    if (!bar) return;
    if (!html) {
      bar.classList.remove('on', 'done', 'shake');
      bar.innerHTML = '';
      return;
    }
    bar.innerHTML = html;
    bar.className = `slm-ch-staged on${cls ? ` ${cls}` : ''}`;
  }

  private paintStagedBar(): void {
    if (!this.active || this.view === 'preview' || !this.caps.manage) { this.setStaged(null); return; }
    const { labels, buckets } = this.currentPlan();
    this.host.onStagedChange?.(mutationCount(buckets));
    if (!labels.length) { this.setStaged(null); return; }
    const target = this.nameOf(this.targetChannelId) ?? PUBLIC_CHANNEL_NAME;
    const mutations = mutationCount(buckets);
    const skipped = buckets.skippedHeld.count + buckets.skippedBooked.count;
    const parts = [
      `<b>${labels.length.toLocaleString()}</b> selected`,
      `<b>+${mutations.toLocaleString()}</b> to ${esc(target)}`,
    ];
    if (buckets.alreadyInTarget.count) parts.push(`<b>${buckets.alreadyInTarget.count.toLocaleString()}</b> already in`);
    if (skipped) parts.push(`<b>${skipped.toLocaleString()}</b> can't move now`);
    this.setStaged(`
      <span>${parts.join(' · ')}</span>
      <span class="grow"></span>
      <button type="button" class="drop" data-ch-act="discard">Discard</button>
      <button type="button" class="go" data-ch-act="review">Review changes</button>`);
    this.stagedEl?.querySelectorAll<HTMLElement>('[data-ch-act]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.chAct === 'discard') this.host.clearSelection();
        else this.openDialog({ kind: 'review' });
      });
    });
  }

  private setBanner(on: boolean, name = ''): void {
    const banner = this.bannerEl;
    if (!banner) return;
    this.host.root.classList.toggle('ch-preview', on);
    if (!on) { banner.classList.remove('on'); banner.innerHTML = ''; return; }
    const marker = this.previewAudience.length === 1
      ? this.markerFor(this.previewAudience[0])
      : { color: 'var(--slm-accent)', letter: '' };
    banner.innerHTML = `<span class="dot" style="background:${esc(marker.color)}"></span>
      Previewing buyer access · ${esc(name)} · read-only
      <button type="button" data-ch-act="exit-preview">Exit preview</button>`;
    banner.classList.add('on');
    banner.querySelector('[data-ch-act="exit-preview"]')
      ?.addEventListener('click', () => this.setView('inspect'));
  }

  // ---- rail -----------------------------------------------------------------

  private setView(view: 'inspect' | 'preview'): void {
    this.view = view;
    if (view === 'inspect') {
      this.previewProjection = null;
      this.setBanner(false);
    } else {
      if (!this.previewAudience.length) {
        const first = this.list?.channels.find((channel) => channel.state === 'active');
        this.previewAudience = [first ? first.id : PUBLIC_CHANNEL_ID];
      }
      void this.loadPreview();
    }
    this.paintRail();
    this.paintOverlay();
    this.paintStagedBar();
    this.onInteractionChange?.();
  }

  /** Set by the cockpit so a view switch can re-arm canvas selection. */
  onInteractionChange?: () => void;

  private async loadPreview(): Promise<void> {
    const audience = [...this.previewAudience];
    const names = audience.map((id) => this.nameOf(id) ?? PUBLIC_CHANNEL_NAME).join(' + ');
    this.setBanner(true, names);
    try {
      this.previewProjection = await this.host.api.channelPreview(this.host.eventKey, audience, {
        // Naming Public sale as the audience IS asking for public inventory; the
        // route filters the 'public' sentinel out of `channelIds`, so without
        // this the request would resolve to an empty scope and 422.
        includePublic: this.previewIncludePublic || audience.some(isPublicChannelId),
      });
      this.previewSupported = true;
    } catch (err) {
      // 404/405 = the projection endpoint has not shipped on this worker yet.
      // Say so plainly; never substitute a local approximation for a server view.
      const status = err instanceof ManageApiError ? err.status : 0;
      this.previewSupported = !(status === 404 || status === 405 || status === 501);
      this.previewProjection = null;
      if (this.previewSupported) this.host.onError(err);
    }
    if (this.active) { this.paintRail(); this.paintOverlay(); }
  }

  paintRail(): void {
    if (!this.active) return;
    const rail = this.host.rail;
    if (!this.caps.view) {
      rail.innerHTML = `<p class="slm-eyebrow">Sales channels</p>
        <p class="slm-hint">You need channel-management permission on this event to see allocations.</p>`;
      return;
    }
    if (this.loading && !this.list) {
      rail.innerHTML = `<p class="slm-eyebrow">Sales channels</p>
        <div class="slm-empty">Loading allocations…</div>`;
      return;
    }
    if (!this.list && this.loadError) {
      rail.innerHTML = `<p class="slm-eyebrow">Sales channels</p>
        <div class="slm-ch-alert err" role="alert"><span>⚠</span>
        <span><b>Couldn't load sales channels.</b> Everything else on this event still works.
        <button type="button" data-ch-act="retry">Try again</button></span></div>`;
      rail.querySelector('[data-ch-act="retry"]')?.addEventListener('click', () => { void this.refresh(); });
      return;
    }

    const selection = this.host.selectionLabels();
    const grab = this.host.isCompact()
      ? `<div class="slm-ch-grab"><span class="slm-ch-grabbar"></span></div>`
      : '';
    const segment = this.viewSegmentHtml();
    const body = this.view === 'preview'
      ? this.previewRailHtml()
      : this.detailChannelId
        ? this.detailRailHtml(this.detailChannelId)
        : selection.length && this.caps.manage
          ? this.selectionRailHtml(selection)
          : this.listRailHtml();
    rail.innerHTML = `${grab}${segment}${body}`;
    this.wireRail();
    this.paintStagedBar();
  }

  private viewSegmentHtml(): string {
    // The preview segment is offered even before the projection endpoint exists —
    // choosing it explains the gap rather than hiding the concept.
    const inspectOn = this.view === 'inspect' ? ' on' : '';
    const previewOn = this.view === 'preview' ? ' on' : '';
    return `<div class="slm-ch-viewseg" role="group" aria-label="Channels view">
      <button type="button" class="${inspectOn.trim()}" data-ch-view="inspect"
        aria-pressed="${this.view === 'inspect'}">Inspect allocation</button>
      <button type="button" class="${previewOn.trim()}" data-ch-view="preview"
        aria-pressed="${this.view === 'preview'}">Preview buyer access</button>
    </div>`;
  }

  private countsHtml(counts: { allocated: number; free: number; booked: number; held: number }, key: string): string {
    const cell = (id: string, value: number, label: string, cls = ''): string => {
      const previous = this.lastCounts.get(`${key}:${id}`);
      const bump = previous != null && previous !== value ? ' bump' : '';
      this.lastCounts.set(`${key}:${id}`, value);
      return `<span class="${cls}"><b class="${bump.trim()}">${value.toLocaleString()}</b> ${label}</span>`;
    };
    return `<span class="slm-ch-counts">
      ${cell('allocated', counts.allocated, 'allocated')}
      ${cell('free', counts.free, 'free', 'free')}
      ${cell('booked', counts.booked, 'sold')}
      ${counts.held ? cell('held', counts.held, 'held') : ''}
    </span>`;
  }

  private channelRowHtml(
    channel: { id: string; name: string; state: string; counts: ChannelRecord['counts']; access?: ChannelRecord['access'] },
    opts: { builtin?: boolean; index?: number } = {},
  ): string {
    const marker = this.markerFor(channel.id);
    const badgeKind = opts.builtin ? 'builtin' : channel.state;
    const dim = channel.state === 'paused' || channel.state === 'archived' ? ' dim' : '';
    const cls = `slm-ch-row${opts.builtin ? ' public' : ''}${channel.state === 'archived' ? ' archived' : ''}`
      + `${this.detailChannelId === channel.id ? ' on' : ''}`;
    // Mutation affordances are ABSENT for a view-only token, never disabled.
    const more = !opts.builtin && this.caps.manage
      ? `<button type="button" class="slm-ch-more" data-ch-detail="${esc(channel.id)}"
          aria-label="Manage ${esc(channel.name)}">⋯</button>`
      : '';
    return `<div class="${cls}">
      <span class="slm-ch-head">
        <span class="slm-ch-mk${dim}" style="background:${esc(marker.color)}" aria-hidden="true">${esc(marker.letter)}</span>
        <span class="slm-ch-name">${esc(channel.name)}</span>
        <span class="slm-ch-badge ${badgeKind}">${esc(stateBadge(opts.builtin ? 'builtin' : channel.state as 'active'))}</span>
        ${more}
      </span>
      ${this.countsHtml(channel.counts, channel.id || 'public')}
      ${opts.builtin ? '' : `<span class="slm-ch-access">${esc(accessLine(channel.access))}</span>`}
    </div>`;
  }

  private listRailHtml(): string {
    const list = this.list!;
    const archivedCount = list.channels.filter((channel) => channel.state === 'archived').length;
    const rows = [
      this.channelRowHtml(list.publicSale, { builtin: true }),
      ...list.channels
        .filter((channel) => this.showArchived || channel.state !== 'archived')
        .map((channel, index) => this.channelRowHtml(channel, { index })),
    ].join('');
    const create = this.caps.manage
      ? `<button type="button" class="slm-btn ghost" style="width:100%" data-ch-act="create">+ Create channel</button>`
      : '';
    const readOnly = this.caps.manage ? '' :
      `<p class="slm-note">You can see how inventory is allocated. Changing it needs channel-management permission.</p>`;
    return `
      <p class="slm-eyebrow">Sales channels</p>
      <p class="slm-hint">Select seats on the map, then assign them. Channel colours and names are never shown to buyers.</p>
      <div class="slm-ch-list">${rows}</div>
      ${create}
      ${readOnly}
      <p class="slm-note" style="margin-top:10px">
        <button type="button" class="slm-linkbtn" data-ch-act="toggle-archived" aria-pressed="${this.showArchived}"
          style="text-align:left">${this.showArchived ? 'Hide' : 'Show'} archived${archivedCount ? ` (${archivedCount})` : ''}</button>
      </p>`;
  }

  private selectionRailHtml(selection: string[]): string {
    const sources = selectionSources(selection, this.allocation, this.list);
    const conflict = this.conflict
      ? `<div class="slm-ch-alert err" role="alert"><span>⚠</span>
          <span><b>Assignments changed while you were editing.</b> Nothing was applied.
          Your ${selection.length.toLocaleString()}-seat selection is kept.
          <button type="button" data-ch-act="refresh-review">Refresh and review →</button></span></div>`
      : '';
    const bump = selection.length !== this.lastSelectionCount ? ' bump' : '';
    this.lastSelectionCount = selection.length;
    const options = this.assignableChannels()
      .map((channel) => `<option value="${esc(channel.id)}"${channel.id === this.targetChannelId ? ' selected' : ''}>${esc(channel.name)}</option>`)
      .join('');
    const sourceRows = sources.map((row) => {
      const marker = this.markerFor(row.channelId);
      return `<div class="slm-ch-selsrc-row">
        <span class="mk" style="background:${esc(marker.color)}" aria-hidden="true">${esc(marker.letter)}</span>
        <b>${row.count.toLocaleString()}</b><span>${esc(row.name)}</span></div>`;
    }).join('');
    const sectionSelect = this.host.sections().length
      ? `<button type="button" class="slm-btn ghost" data-ch-act="pick-section">Section</button>` : '';
    return `
      ${conflict}
      <div class="slm-selbar"><span class="slm-selnum slm-ch-selnum${bump}">${selection.length.toLocaleString()}</span>
        <span class="slm-sellabel">selected</span></div>
      <div class="slm-ch-selsrc" aria-live="polite" aria-label="Selection sources">${sourceRows}</div>
      <div class="slm-field">
        <label for="slm-ch-target">Assign to</label>
        <select class="slm-select" id="slm-ch-target" data-ch-target>${options}</select>
      </div>
      <p class="slm-note">Changes are staged — nothing moves until you review and apply.
        Seats in checkout or already sold are never moved.</p>
      <div class="slm-ch-row2">
        <button type="button" class="slm-btn ghost" data-ch-act="discard">Clear selection</button>
        <button type="button" class="slm-btn" data-ch-act="review">Review changes</button>
      </div>
      <p class="slm-eyebrow" style="margin-top:18px">Select by</p>
      <div class="slm-ch-row2" style="margin-top:2px">
        ${sectionSelect}
        <button type="button" class="slm-btn ghost" data-ch-act="pick-category">Category</button>
        <button type="button" class="slm-btn ghost" data-ch-act="seatlist">List ⌨</button>
      </div>
      <p class="slm-note">The seat list offers the same selection with checkboxes for keyboard and screen-reader use.</p>`;
  }

  private detailRailHtml(channelId: string): string {
    const channel = this.list?.channels.find((item) => item.id === channelId);
    if (!channel) return this.listRailHtml();
    const lifecycle = this.caps.manage ? `
      <p class="slm-eyebrow" style="margin-top:18px">Lifecycle</p>
      <div class="slm-ch-row2" style="margin-top:2px">
        <button type="button" class="slm-btn ghost" data-ch-act="rename">Rename</button>
        <button type="button" class="slm-btn ghost" data-ch-act="pause">${channel.state === 'paused' ? 'Resume' : 'Pause'}</button>
        <button type="button" class="slm-btn ghost" data-ch-act="archive">Archive…</button>
      </div>
      <p class="slm-note">Archive returns the allocation to a destination you choose. Nothing is ever deleted silently.</p>` : '';
    const intent = (channel.access?.intent ?? 'none') as ChannelAccessIntent;
    const intents: ChannelAccessIntent[] = ['none', 'internal', 'server', 'hosted_link'];
    // "No buyer access configured" is INFORMATION for a deliberate reserve. It
    // only becomes a warning once the organizer says the channel is meant for
    // buyer self-service (§8.2).
    const selfServiceGap = (intent === 'server' || intent === 'hosted_link') && !channel.access?.hasActiveGrants;
    const access = this.caps.manage ? `
      <p class="slm-eyebrow" style="margin-top:14px">Buyer access</p>
      <div class="slm-field">
        <label for="slm-ch-intent">How should buyers reach this channel?</label>
        <select class="slm-select" id="slm-ch-intent" data-ch-intent>
          ${intents.map((value) => `<option value="${value}"${value === intent ? ' selected' : ''}>${esc(accessIntentLabel(value))}</option>`).join('')}
        </select>
      </div>
      <p class="slm-hint">${channel.access?.hasActiveGrants
        ? 'Buyer access is live. Only this audience can buy from the allocation.'
        : 'No buyer access is configured yet. The allocation is protected — it is not available to Public sale.'}</p>
      ${selfServiceGap ? `<div class="slm-ch-alert warn"><span>⚠</span>
        <span>This channel is marked for buyer self-service but no buyer has been let in yet.</span></div>` : ''}
      <button type="button" class="slm-btn" data-ch-act="hosted-link" disabled
        title="Hosted access links ship in the next milestone">Create hosted access link · Coming soon</button>
      <div class="slm-ch-row2"><button type="button" class="slm-btn ghost" data-ch-act="server-access" disabled
        title="Guided server setup ships in the next milestone">Configure server integration · Coming soon</button></div>
      <p class="slm-note">Your own server can already mint buyer access sessions for this channel with the server SDK.</p>` : '';
    return `
      <p class="slm-eyebrow">
        <button type="button" class="slm-linkbtn" data-ch-act="back" style="text-align:left">‹ All channels</button>
      </p>
      <p class="slm-eyebrow">Channel · ${esc(channel.name)}</p>
      <div class="slm-ch-list">${this.channelRowHtml(channel)}</div>
      ${access}
      ${lifecycle}`;
  }

  private previewRailHtml(): string {
    const audienceOptions = [
      { id: PUBLIC_CHANNEL_ID, name: this.list?.publicSale.name ?? PUBLIC_CHANNEL_NAME },
      ...(this.list?.channels ?? [])
        .filter((channel) => channel.state !== 'archived')
        .map((channel) => ({ id: channel.id, name: channel.name })),
    ];
    const current = this.previewAudience[0] ?? PUBLIC_CHANNEL_ID;
    const options = audienceOptions
      .map((entry) => `<option value="${esc(entry.id)}"${entry.id === current ? ' selected' : ''}>${esc(entry.name)}</option>`)
      .join('');
    const unsupported = this.previewSupported === false
      ? `<div class="slm-ch-alert warn"><span>ℹ</span>
          <span><b>Preview needs a newer server.</b> Allocation management works normally;
          the buyer-view simulation will appear once this event's API is updated.</span></div>`
      : '';
    // The server decides an audience is unpreviewable, not the client: a paused
    // or archived channel comes back `available:false` and we show the landing
    // state a real buyer would hit.
    const unavailable = this.previewProjection?.available === false
      ? `<div class="slm-ch-alert warn" role="status"><span>⏸</span>
          <span><b>This private sale is not available.</b> ${esc((this.previewProjection.unavailable ?? [])
            .map((entry) => `${this.nameOf(entry.channelId) ?? 'This channel'} is ${entry.state}`)
            .join('; ') || 'The audience cannot buy right now')}.
          A buyer arriving with this access sees this message, not these seats.</span></div>`
      : '';
    const counts = this.previewProjection?.counts;
    const summary = counts?.eligible != null && this.previewProjection?.available !== false
      ? `<div class="slm-ch-alert warn"><span>ℹ</span><span>${counts.eligible.toLocaleString()} seats are buyable
          through this access.${this.previewProjection?.includePublic === false
            ? ' Public sale seats are <b>not</b> included in this grant.' : ''}</span></div>`
      : '';
    const includePublic = isPublicChannelId(current) ? '' : `
      <label class="slm-note" style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input type="checkbox" data-ch-includepublic ${this.previewIncludePublic ? 'checked' : ''} />
        Also include Public sale seats in this grant
      </label>`;
    return `
      <p class="slm-eyebrow">Preview buyer access</p>
      <div class="slm-field">
        <label for="slm-ch-audience">Audience</label>
        <select class="slm-select" id="slm-ch-audience" data-ch-audience>${options}</select>
      </div>
      ${includePublic}
      <p class="slm-hint">This is the same projection the buyer SDK receives for this audience — not a local
        approximation. It is read-only: clicks open seat details, and no holds are created.</p>
      ${unsupported}${unavailable}
      <div class="slm-ch-legend">
        <div class="r"><span class="sw" style="background:#6e7bff"></span> Eligible &amp; free — buyable by this audience</div>
        <div class="r"><span class="sw" style="background:#3a4051"></span> Unavailable to this audience (one neutral state)</div>
        <div class="r"><span class="sw" style="background:#22a06b"></span> Sold — same as any buyer sees</div>
      </div>
      ${summary}`;
  }

  private paintSelection(): void {
    // A selection change swaps the rail between list and staged-selection bodies,
    // so repaint rather than patch — the rail is small and this keeps one path.
    if (this.view === 'inspect' && !this.detailChannelId) this.paintRail();
  }

  private wireRail(): void {
    const rail = this.host.rail;
    rail.querySelectorAll<HTMLElement>('[data-ch-view]').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.chView as 'inspect' | 'preview'));
    });
    rail.querySelectorAll<HTMLElement>('[data-ch-detail]').forEach((button) => {
      button.addEventListener('click', () => {
        this.detailChannelId = button.dataset.chDetail!;
        this.paintRail();
      });
    });
    const target = rail.querySelector<HTMLSelectElement>('[data-ch-target]');
    target?.addEventListener('change', () => {
      this.targetChannelId = target.value;
      this.conflict = false;
      this.paintRail();
    });
    const audience = rail.querySelector<HTMLSelectElement>('[data-ch-audience]');
    audience?.addEventListener('change', () => {
      this.previewAudience = [audience.value];
      void this.loadPreview();
    });
    const includePublic = rail.querySelector<HTMLInputElement>('[data-ch-includepublic]');
    includePublic?.addEventListener('change', () => {
      this.previewIncludePublic = includePublic.checked;
      void this.loadPreview();
    });
    const intent = rail.querySelector<HTMLSelectElement>('[data-ch-intent]');
    intent?.addEventListener('change', () => {
      void this.setAccessIntent(intent.value as ChannelAccessIntent);
    });
    const grab = rail.querySelector<HTMLElement>('.slm-ch-grab');
    grab?.addEventListener('click', () => this.cycleDetent());
    rail.querySelectorAll<HTMLElement>('[data-ch-act]').forEach((button) => {
      button.addEventListener('click', () => this.railAction(button.dataset.chAct!));
    });
  }

  private railAction(action: string): void {
    switch (action) {
      case 'create': this.openDialog({ kind: 'create' }); break;
      case 'review': this.openDialog({ kind: 'review' }); break;
      case 'rename': this.openDialog({ kind: 'rename', channelId: this.detailChannelId! }); break;
      case 'archive': this.openDialog({ kind: 'archive', channelId: this.detailChannelId! }); break;
      case 'seatlist': this.openDialog({ kind: 'seatlist' }); break;
      case 'pause': void this.togglePause(); break;
      case 'discard': this.host.clearSelection(); break;
      case 'back': this.detailChannelId = null; this.paintRail(); break;
      case 'retry': void this.refresh(); break;
      case 'toggle-archived':
        this.showArchived = !this.showArchived;
        void this.refresh();
        break;
      case 'refresh-review':
        this.conflict = false;
        void this.refresh().then(() => this.openDialog({ kind: 'review' }));
        break;
      case 'pick-section': this.pickSection(); break;
      case 'pick-category': this.pickCategory(); break;
      default: break;
    }
  }

  // ---- selection helpers ----------------------------------------------------

  private pickSection(): void {
    const sections = this.host.sections();
    if (!sections.length) return;
    this.promptChoice('Select a whole section', sections.map((s) => ({ value: s.id, label: s.label })), (value) => {
      this.host.selectSection(value);
    });
  }

  private pickCategory(): void {
    const categories = this.host.categories();
    if (!categories.length) return;
    this.promptChoice('Select a whole category', categories.map((c) => ({ value: c.key, label: c.label })), (value) => {
      this.host.selectByLabels(this.host.labelsInCategory(value));
    });
  }

  /** A tiny modal chooser reusing the dialog primitive (focus trap + Escape). */
  private promptChoice(
    title: string,
    options: Array<{ value: string; label: string }>,
    onPick: (value: string) => void,
  ): void {
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">${esc(title)}</h3>
      <div class="slm-field">
        <label for="slm-ch-choice">Choose one</label>
        <select class="slm-select" id="slm-ch-choice">
          ${options.map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`).join('')}
        </select>
      </div>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn" data-ch-confirm>Select</button>
      </div>`, (root) => {
      root.querySelector('[data-ch-confirm]')?.addEventListener('click', () => {
        const select = root.querySelector<HTMLSelectElement>('#slm-ch-choice');
        const value = select?.value;
        this.closeDialog();
        if (value) onPick(value);
      });
    });
  }

  // ---- dialogs --------------------------------------------------------------

  private openDialog(state: DialogState): void {
    this.dialog = state;
    this.renderDialog();
  }

  private renderDialog(): void {
    const state = this.dialog;
    if (!state) return;
    if (state.kind === 'create') this.renderCreateDialog(state);
    else if (state.kind === 'review') this.renderReviewDialog(state);
    else if (state.kind === 'archive') this.renderArchiveDialog(state);
    else if (state.kind === 'rename') this.renderRenameDialog(state);
    else if (state.kind === 'seatlist') this.renderSeatListDialog();
  }

  /**
   * Mount a modal: `aria-modal` dialog, programmatic name, focus moved inside,
   * Tab trapped, Escape closes WITHOUT mutating, focus restored on close (§13).
   */
  private renderScrim(inner: string, wire: (dialog: HTMLElement) => void): void {
    const existing = this.scrimEl;
    if (!existing) this.lastFocus = (document.activeElement as HTMLElement | null) ?? null;
    existing?.remove();
    const scrim = document.createElement('div');
    scrim.className = 'slm-ch-scrim';
    scrim.innerHTML = `<div class="slm-ch-dialog" role="dialog" aria-modal="true"
      aria-labelledby="slm-ch-dlg-title" tabindex="-1">${inner}</div>`;
    this.host.root.appendChild(scrim);
    this.scrimEl = scrim;
    const dialog = scrim.firstElementChild as HTMLElement;
    dialog.querySelectorAll<HTMLElement>('[data-ch-close]').forEach((button) => {
      button.addEventListener('click', () => this.closeDialog());
    });
    scrim.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); this.closeDialog(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]),select,input,textarea,a[href],[tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    wire(dialog);
    const autofocus = dialog.querySelector<HTMLElement>('input,select,button');
    (autofocus ?? dialog).focus();
  }

  private closeDialog(opts: { restoreFocus?: boolean } = {}): void {
    this.dialog = null;
    this.scrimEl?.remove();
    this.scrimEl = null;
    if (opts.restoreFocus !== false) this.lastFocus?.focus?.();
    this.lastFocus = null;
  }

  private renderCreateDialog(state: DialogState): void {
    // Markers are compared as the single letter each one RENDERS as, so a stored
    // "star" occupies 'S' and the next channel is offered a free letter instead.
    const taken = (this.list?.channels ?? []).map((channel) => markerLetter(channel.marker || channel.name, ''));
    const suggestion = suggestMarker('', taken);
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Create channel</h3>
      <p class="sub">A named allocation only the right audience can buy from. You'll pick the seats next.</p>
      <div class="slm-field">
        <label for="slm-ch-name">Name</label>
        <input class="slm-input" id="slm-ch-name" maxlength="80" />
        <p class="slm-note">Shown to your team and in reports — never to buyers.</p>
      </div>
      <div class="slm-field">
        <label>Marker</label>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="slm-ch-mk" data-ch-marker style="background:${esc(suggestion.color)};width:28px;height:28px;font-size:13px">${esc(suggestion.letter)}</span>
          <span class="slm-note" style="margin:0">Letter + colour suggested from the name. Buyers never see either.</span>
        </div>
      </div>
      <div class="slm-field">
        <label for="slm-ch-ref">Reference <span style="text-transform:none;font-weight:500">(optional)</span></label>
        <input class="slm-input" id="slm-ch-ref" maxlength="120" placeholder="e.g. travel-agency-a" />
        <p class="slm-note">A stable ID for your own system and webhooks.</p>
      </div>
      <p class="slm-ch-err" data-ch-error ${state.error ? '' : 'hidden'}>${esc(state.error ?? '')}</p>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn ghost" data-ch-create="plain">Create without allocating</button>
        <button type="button" class="slm-btn" data-ch-create="allocate">Create and allocate seats</button>
      </div>`, (dialog) => {
      const name = dialog.querySelector<HTMLInputElement>('#slm-ch-name')!;
      const marker = dialog.querySelector<HTMLElement>('[data-ch-marker]')!;
      name.addEventListener('input', () => {
        const next = suggestMarker(name.value, taken);
        marker.textContent = next.letter;
        marker.style.background = next.color;
      });
      dialog.querySelectorAll<HTMLElement>('[data-ch-create]').forEach((button) => {
        button.addEventListener('click', () => {
          const allocate = button.dataset.chCreate === 'allocate';
          void this.createChannel(
            name.value,
            marker.textContent ?? '',
            marker.style.background,
            dialog.querySelector<HTMLInputElement>('#slm-ch-ref')?.value ?? '',
            allocate,
          );
        });
      });
    });
  }

  private async createChannel(
    name: string,
    letter: string,
    color: string,
    externalRef: string,
    allocate: boolean,
  ): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      this.showDialogError('Give the channel a name your team will recognise.');
      return;
    }
    try {
      const res = await this.host.api.createChannel(this.host.eventKey, {
        name: trimmed,
        // The column is free text; we only ever store what the chip can draw.
        marker: markerLetter(letter, '') || null,
        color: color || null,
        externalRef: externalRef.trim() || null,
      });
      this.closeDialog();
      await this.refresh();
      this.targetChannelId = res.channel.id;
      this.detailChannelId = allocate ? null : res.channel.id;
      this.announce(`Channel ${trimmed} created with 0 seats allocated.`);
      this.host.toast(allocate
        ? `${trimmed} created. Select seats on the map to allocate them.`
        : `${trimmed} created.`, 'ok');
      this.paintRail();
    } catch (err) {
      const code = err instanceof ManageApiError ? err.code : undefined;
      this.showDialogError(code === 'channel_name_taken'
        ? 'That name is already used on this event. Pick another.'
        : "Couldn't create the channel. Try again.");
      this.host.onError(err);
    }
  }

  private showDialogError(message: string): void {
    const field = this.scrimEl?.querySelector<HTMLElement>('[data-ch-error]');
    if (!field) return;
    field.textContent = message;
    field.hidden = false;
  }

  private renderReviewDialog(state: DialogState): void {
    const { labels, buckets } = this.currentPlan();
    const authoritative = state.applied;
    const shown = authoritative ? authoritative.buckets : buckets;
    const targetName = this.nameOf(this.targetChannelId) ?? PUBLIC_CHANNEL_NAME;
    const rows = bucketRows(shown, targetName);
    const mutations = authoritative ? authoritative.applied : mutationCount(buckets);
    const allSkipped = !authoritative && labels.length > 0 && mutations === 0;
    const rowsHtml = bucketRowsHtml(rows);

    const foot = authoritative
      ? `<div class="foot"><button type="button" class="slm-btn" data-ch-close>Done</button></div>`
      : `<div class="foot">
          <button type="button" class="quiet" data-ch-close>Back</button>
          <button type="button" class="slm-btn" data-ch-apply ${allSkipped || state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Applying…' : `Apply ${mutations.toLocaleString()} change${mutations === 1 ? '' : 's'}`}
          </button>
        </div>`;
    const confirmNote = !authoritative && needsMoveConfirmation(buckets)
      ? `<p class="slm-note">Applying moves inventory out of another private channel. That is the line marked above.</p>`
      : '';
    const skippedNote = allSkipped
      ? `<div class="slm-ch-alert warn"><span>ℹ</span><span>Nothing in this selection can move right now —
          every seat is in a buyer's checkout, already sold, or already in ${esc(targetName)}.</span></div>`
      : '';

    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">${authoritative
        ? `Moved ${authoritative.applied.toLocaleString()} seat${authoritative.applied === 1 ? '' : 's'} to ${esc(targetName)}`
        : `Move ${labels.length.toLocaleString()} selected seat${labels.length === 1 ? '' : 's'} to ${esc(targetName)}`}</h3>
      <p class="sub">${authoritative
        ? 'These are the exact counts the server applied.'
        : 'Every selected seat is in exactly one line below.'}</p>
      ${skippedNote}
      ${rowsHtml || '<div class="slm-empty">Nothing selected.</div>'}
      ${confirmNote}
      <p class="slm-ch-err" data-ch-error ${state.error ? '' : 'hidden'}>${esc(state.error ?? '')}</p>
      ${foot}`, (dialog) => {
      dialog.querySelector('[data-ch-apply]')?.addEventListener('click', () => void this.apply());
    });
    if (authoritative) {
      this.announce(`Applied ${authoritative.applied} change${authoritative.applied === 1 ? '' : 's'} to ${targetName}.`);
    }
  }

  /**
   * Apply. On success the review sheet re-renders with the AUTHORITATIVE server
   * buckets and the staged bar morphs to a ✓ for 1.2s. On a stale version the
   * server mutated nothing: keep the selection, shake the bar once, and offer
   * exactly one action — Refresh and review.
   */
  private async apply(): Promise<void> {
    if (!this.dialog || !this.caps.manage) return;
    const { labels } = this.currentPlan();
    if (!labels.length) return;
    this.dialog = { ...this.dialog, busy: true, error: null };
    this.renderDialog();
    try {
      const result = await this.host.api.applyChannelAssignment(this.host.eventKey, {
        // `null` is the wire spelling of "back to public sale" every worker
        // accepts, including ones that predate the 'public' sentinel.
        targetChannelId: isPublicChannelId(this.targetChannelId) ? null : this.targetChannelId,
        labels,
        assignmentVersion: this.assignmentVersion,
      });
      this.assignmentVersion = result.assignmentVersion;
      this.conflict = false;
      this.dialog = { kind: 'review', applied: result };
      await this.refresh({ quiet: true });
      this.renderDialog();
      this.showApplied(result);
      this.host.clearSelection();
    } catch (err) {
      const conflict = err instanceof ManageApiError && err.status === 409
        && err.code === 'channel_assignment_conflict';
      if (conflict) {
        this.conflict = true;
        this.closeDialog();
        this.shakeStaged();
        this.paintRail();
        this.announce('Assignments changed while you were editing. Nothing was applied and your selection is kept.');
        return;
      }
      if (err instanceof ManageApiError && err.status === 403) {
        this.caps = { view: this.caps.view, manage: false };
        this.closeDialog();
        this.paintRail();
        this.host.toast('Changing channels needs channel-management permission.', 'err');
        return;
      }
      this.dialog = { kind: 'review', busy: false, error: "Couldn't apply those changes. Try again." };
      this.renderDialog();
      this.host.onError(err);
    }
  }

  private showApplied(result: AssignmentResult): void {
    this.setStaged(`<span class="slm-ch-tick" aria-hidden="true">✓</span>
      <span>Applied <b>${result.applied.toLocaleString()}</b> change${result.applied === 1 ? '' : 's'}</span>
      <span class="grow"></span>`, 'done');
    if (this.stagedDoneTimer) clearTimeout(this.stagedDoneTimer);
    this.stagedDoneTimer = setTimeout(() => this.setStaged(null), 1200);
  }

  private shakeStaged(): void {
    const bar = this.stagedEl;
    if (!bar || !bar.classList.contains('on')) return;
    bar.classList.remove('shake');
    void bar.offsetWidth; // restart the animation
    bar.classList.add('shake');
  }

  private renderRenameDialog(state: DialogState): void {
    const channel = this.list?.channels.find((item) => item.id === state.channelId);
    if (!channel) { this.closeDialog(); return; }
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Rename ${esc(channel.name)}</h3>
      <p class="sub">Only your team and your reports see this name.</p>
      <div class="slm-field">
        <label for="slm-ch-newname">Name</label>
        <input class="slm-input" id="slm-ch-newname" maxlength="80" value="${esc(channel.name)}" />
      </div>
      <p class="slm-ch-err" data-ch-error ${state.error ? '' : 'hidden'}>${esc(state.error ?? '')}</p>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn" data-ch-rename>Save name</button>
      </div>`, (dialog) => {
      dialog.querySelector('[data-ch-rename]')?.addEventListener('click', () => {
        const value = dialog.querySelector<HTMLInputElement>('#slm-ch-newname')?.value ?? '';
        if (!value.trim()) { this.showDialogError('A channel needs a name.'); return; }
        void this.host.api.renameChannel(this.host.eventKey, channel.id, value.trim())
          .then(() => { this.closeDialog(); return this.refresh(); })
          .catch((err) => {
            this.showDialogError(err instanceof ManageApiError && err.code === 'channel_name_taken'
              ? 'That name is already used on this event.'
              : "Couldn't rename the channel.");
            this.host.onError(err);
          });
      });
    });
  }

  private async setAccessIntent(accessIntent: ChannelAccessIntent): Promise<void> {
    const channelId = this.detailChannelId;
    if (!channelId || !this.caps.manage) return;
    try {
      await this.host.api.setChannelAccessIntent(this.host.eventKey, channelId, accessIntent);
      await this.refresh();
    } catch (err) {
      this.host.toast("Couldn't save how buyers reach this channel.", 'err');
      this.host.onError(err);
    }
  }

  private async togglePause(): Promise<void> {
    const channel = this.list?.channels.find((item) => item.id === this.detailChannelId);
    if (!channel) return;
    const paused = channel.state !== 'paused';
    try {
      await this.host.api.setChannelPaused(this.host.eventKey, channel.id, paused);
      await this.refresh();
      this.host.toast(paused
        ? `${channel.name} paused. Existing checkouts can finish; no new buyer access is issued.`
        : `${channel.name} resumed.`, 'ok');
    } catch (err) {
      this.host.toast("Couldn't change that channel.", 'err');
      this.host.onError(err);
    }
  }

  private renderArchiveDialog(state: DialogState): void {
    const channel = this.list?.channels.find((item) => item.id === state.channelId);
    if (!channel) { this.closeDialog(); return; }
    // The server is the authority on whether archive is possible. The rail's
    // poll can be seconds stale, so a local hold count is a WARNING; only the
    // server's 409 (which carries the exact retry window) disables the action.
    const blocked = state.archiveBlocked ?? null;
    const heads_up = !blocked && channel.counts.held > 0;
    const destinations = this.assignableChannels().filter((entry) => entry.id !== channel.id);
    const blockedAlert = blocked
      ? `<div class="slm-ch-alert warn" role="alert"><span>⏳</span>
          <span><b>${(blocked.heldUnits ?? blocked.activeHolds ?? 0).toLocaleString()} seats are in a buyer's checkout right now.</b>
          Archive is unavailable while seats are held — try again ${esc(retryAfterCopy(blocked))}.</span></div>`
      : heads_up
        ? `<div class="slm-ch-alert warn"><span>⏳</span>
            <span>${channel.counts.held.toLocaleString()} seats are in a buyer's checkout right now.
            Archive is refused while any seat is held — you can try, and we'll tell you when to come back.</span></div>`
        : '';
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Archive ${esc(channel.name)}</h3>
      <p class="sub">The channel closes for good. Its seats move to a destination you choose;
        sales history keeps its attribution.</p>
      ${blockedAlert}
      <div class="slm-field">
        <label for="slm-ch-dest">Move the ${channel.counts.free.toLocaleString()} remaining free seats to</label>
        <select class="slm-select" id="slm-ch-dest">
          ${destinations.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.name)}</option>`).join('')}
        </select>
      </div>
      <p class="slm-note">${channel.counts.booked.toLocaleString()} sold seats keep "${esc(channel.name)}" on their sale
        record. If one is cancelled later it returns to the destination above. Any buyer access for this channel
        stops working.</p>
      <p class="slm-ch-err" data-ch-error ${state.error ? '' : 'hidden'}>${esc(state.error ?? '')}</p>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn danger" data-ch-archive ${blocked ? 'disabled' : ''}>Archive channel</button>
      </div>`, (dialog) => {
      dialog.querySelector('[data-ch-archive]')?.addEventListener('click', () => {
        const destination = dialog.querySelector<HTMLSelectElement>('#slm-ch-dest')?.value ?? '';
        void this.archive(channel.id, destination || null);
      });
    });
  }

  private async archive(channelId: string, destination: string | null): Promise<void> {
    try {
      await this.host.api.archiveChannel(this.host.eventKey, channelId, destination);
      this.closeDialog();
      this.detailChannelId = null;
      await this.refresh();
      this.host.toast('Channel archived. Its remaining seats moved to the destination you chose.', 'ok');
    } catch (err) {
      if (err instanceof ManageApiError && err.status === 409
        && err.code === 'channel_archive_blocked_by_holds') {
        this.dialog = {
          kind: 'archive',
          channelId,
          archiveBlocked: (err.details ?? {}) as ArchiveBlockedDetails,
        };
        this.renderDialog();
        return;
      }
      this.showDialogError("Couldn't archive that channel. Try again.");
      this.host.onError(err);
    }
  }

  /**
   * The synchronized inventory list (§13): the keyboard and screen-reader
   * equivalent of canvas click / marquee / brush, grouped by section with
   * per-section select actions.
   */
  private renderSeatListDialog(): void {
    const selected = new Set(this.host.selectionLabels());
    const groups = new Map<string, { label: string; seats: Array<{ label: string; status: string }> }>();
    let total = 0;
    for (const seat of this.host.seats()) {
      total += 1;
      if (total > this.seatListLimit) break;
      const section = this.host.sectionOfLabel(seat.label);
      const key = section?.id ?? '';
      const group = groups.get(key) ?? { label: section?.label ?? 'Other seats', seats: [] };
      group.seats.push({ label: seat.label, status: this.host.statusOf(seat.label) ?? 'free' });
      groups.set(key, group);
    }
    const body = [...groups.entries()].map(([id, group]) => `
      <div class="slm-ch-seatgroup">
        <span>${esc(group.label)}</span>
        ${id ? `<button type="button" data-ch-section="${esc(id)}">Select section</button>` : ''}
      </div>
      ${group.seats.map((seat) => {
        const channelId = this.allocation.get(seat.label) ?? PUBLIC_CHANNEL_ID;
        const channelName = this.nameOf(channelId) ?? PUBLIC_CHANNEL_NAME;
        return `<button type="button" class="slm-ch-seatitem" role="checkbox"
          aria-checked="${selected.has(seat.label)}" data-ch-seat="${esc(seat.label)}">
          <span class="box" aria-hidden="true">✓</span>
          <span>${esc(seat.label)}</span>
          <span class="meta">${esc(channelName)} · ${esc(seat.status)}</span>
        </button>`;
      }).join('')}`).join('');
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Seat list</h3>
      <p class="sub">The same selection as the map, with checkboxes. Space or Enter toggles a seat.</p>
      <div class="slm-ch-seatlist">${body || '<div class="slm-empty">No seats on this chart.</div>'}</div>
      ${total > this.seatListLimit
        ? `<div class="foot"><button type="button" class="slm-btn ghost" data-ch-more>Show more seats</button></div>` : ''}
      <div class="foot"><button type="button" class="slm-btn" data-ch-close>Done</button></div>`, (dialog) => {
      dialog.querySelectorAll<HTMLElement>('[data-ch-seat]').forEach((button) => {
        button.addEventListener('click', () => {
          const label = button.dataset.chSeat!;
          const next = new Set(this.host.selectionLabels());
          if (next.has(label)) next.delete(label);
          else next.add(label);
          this.host.clearSelection();
          if (next.size) this.host.selectByLabels([...next]);
          this.renderSeatListDialog();
        });
      });
      dialog.querySelectorAll<HTMLElement>('[data-ch-section]').forEach((button) => {
        button.addEventListener('click', () => {
          this.host.selectSection(button.dataset.chSection!);
          this.renderSeatListDialog();
        });
      });
      dialog.querySelector('[data-ch-more]')?.addEventListener('click', () => {
        this.seatListLimit += SEAT_LIST_PAGE;
        this.renderSeatListDialog();
      });
    });
  }

  // ---- compact detents ------------------------------------------------------

  private applySheetClasses(): void {
    const root = this.host.root;
    const compact = this.host.isCompact();
    root.classList.toggle('ch-sheet', compact && this.active);
    for (const detent of ['collapsed', 'medium', 'full'] as Detent[]) {
      root.classList.toggle(`detent-${detent}`, compact && this.active && this.detent === detent);
    }
    // At the full detent the map behind the sheet is inert: selection is
    // preserved, but the background cannot be touched until Back/Close.
    this.host.setMapInert(compact && this.active && this.detent === 'full');
  }

  private cycleDetent(): void {
    const order: Detent[] = ['collapsed', 'medium', 'full'];
    this.detent = order[(order.indexOf(this.detent) + 1) % order.length];
    this.applySheetClasses();
  }

  /** Back/Close from the full detent returns to the previous one and keeps the
   *  selection — losing a hard-won selection to a Back press is unforgivable. */
  handleBack(): boolean {
    if (this.scrimEl) { this.closeDialog(); return true; }
    if (this.host.isCompact() && this.detent === 'full') {
      this.detent = 'medium';
      this.applySheetClasses();
      return true;
    }
    return false;
  }
}
