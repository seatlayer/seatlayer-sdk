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
  ACCESS_LINK_DEFAULTS,
  PUBLIC_CHANNEL_ID,
  PUBLIC_CHANNEL_NAME,
  accessLine,
  accessLinkBadge,
  accessLinkErrorCopy,
  accessLinkIsLive,
  accessLinkPolicyLines,
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
  type AccessLinkReveal,
  type AccessLinkStatusRecord,
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

/** One row offered to the bulk assignment chooser. A physically segmented row
 * (one label split across several row objects) shares one logical id, so the
 * organizer picks "Row AA" once rather than three fragments of it. */
export interface ChannelsRowView {
  id: string;
  label: string;
  sectionId: string;
  sectionLabel: string;
  labels: string[];
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
  /** 201 with the ONE-TIME reveal. Every omitted field takes the server default
   *  (expiry = event start, 100 redemptions, 4 seats per buyer). */
  createAccessLink(
    key: string,
    channelId: string,
    input: {
      label?: string | null;
      expiresAt?: number;
      maxRedemptions?: number;
      maxQuantity?: number;
      includePublic?: boolean;
    },
  ): Promise<AccessLinkReveal>;
  /** Status only. This response has no url and no capability, by contract. */
  accessLinks(key: string, channelId: string): Promise<{ links: AccessLinkStatusRecord[] }>;
  /** `endActiveSessions` is required — the server 422s without it, deliberately. */
  rotateAccessLink(
    key: string,
    channelId: string,
    linkId: string,
    endActiveSessions: boolean,
  ): Promise<AccessLinkReveal>;
  revokeAccessLink(
    key: string,
    channelId: string,
    linkId: string,
    endActiveSessions?: boolean,
  ): Promise<{ ok: true; link: unknown; endedSessions: number }>;
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
  /** Every selectable label inside one section, for the additive scope chooser. */
  labelsInSection(sectionId: string): string[];
  /** Logical rows across the whole chart, grouped by their section. */
  rows(): ChannelsRowView[];
  categories(): Array<{ key: string; label: string; color?: string }>;
  labelsInCategory(key: string): string[];
  sectionOfLabel(label: string): { id: string; label: string } | null;
  /** Chart-space → container pixels. Null when there is no live renderer. */
  worldToScreen(point: { x: number; y: number }): { x: number; y: number } | null;
  /** Approximate on-screen seat size in CSS pixels, for the overlay marks. */
  seatPixelSize(): number;
  /** Whether the live renderer is currently showing individual seats. */
  isSeatDetail(): boolean;
  /** Return a sectional venue to its section-only overview. */
  showSectionOverview(): void;
  /** Focus one section using the renderer's real camera transition. */
  focusSection(sectionId: string): void;
  isCompact(): boolean;
  /** Make the canvas non-interactive behind a full-detent sheet (§13). */
  setMapInert(inert: boolean): void;
  toast(message: string, kind: 'ok' | 'err'): void;
  onError(err: unknown): void;
  /** Fired whenever the staged mutation count changes, for host telemetry. */
  onStagedChange?(staged: number): void;
}

/**
 * Live-count refresh cadence. Organizer realtime (M5's per-scope socket) plugs
 * in at `applyRealtimeHint`, so this clock is a safety net, not the transport —
 * it was 10s, which cost every idle cockpit six list+allocation walks a minute
 * for counts that rarely move. Ticks are skipped entirely while the tab is
 * hidden and one runs immediately when it comes back.
 */
const POLL_MS = 30_000;
const MAX_FLAGS = 8;
const SEAT_LIST_PAGE = 300;

/**
 * The most seats one Apply may carry. The assignment route rewrites every label
 * in a single transaction, so an unbounded selection is a request that times out
 * halfway and leaves the organizer guessing what moved. The ceiling is stated in
 * the UI *before* Apply — in the staged bar, the selection rail, the scope
 * chooser and the review sheet — so it is never discovered as a failure.
 */
const MAX_ASSIGNMENT_UNITS = 5_000;

/**
 * Buyer-preview colours are deliberately independent of a chart's category
 * palette. A channel is an access scope, not a price category: retaining the
 * underlying category colour made a buyer's eligible seats indistinguishable
 * from the rest of a section, while a square grey overlay left a coloured rim
 * around unavailable seats. The two explicit states below make the scope
 * readable without disclosing which other channel owns an unavailable seat.
 */
const PREVIEW_ELIGIBLE_FILL = '#6e7bff';
const PREVIEW_ELIGIBLE_STROKE = '#b9c0ff';
const PREVIEW_UNAVAILABLE_FILL = '#303846';
const PREVIEW_UNAVAILABLE_STROKE = '#4b5669';
const ALLOCATION_STROKE = '#101723';

/**
 * Motion tokens (motion-system §2) plus Channels choreography (§3). Declared on
 * the widget root as `--slm-mo-*` so an embed never inherits host motion CSS.
 * Every keyframe below has its `prefers-reduced-motion` override in this block.
 * `@sl-css` opts it into build-time minification (cdn/minifyCssLiterals.ts).
 */
export const CHANNELS_CSS = /* @sl-css */ `
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
.slm-ch-section-target{position:absolute;pointer-events:auto;padding:0;border:0;border-radius:8px;background:transparent;cursor:zoom-in}
.slm-ch-section-target:focus-visible{outline:2px solid var(--slm-accent);outline-offset:-3px;background:color-mix(in srgb,var(--slm-accent) 12%,transparent)}

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
.slm-ch-staged.shake{animation:slm-ch-shake var(--slm-mo-slow) var(--slm-mo-in-out) 2}
.slm-ch-staged b{font-variant-numeric:tabular-nums}
.slm-ch-staged .grow{flex:1}
.slm-ch-staged .go{padding:9px 16px;min-height:44px;display:inline-flex;align-items:center;border-radius:9px;
  background:#f4b740;color:#1a1200;font-weight:800;font-size:12.5px}
.slm-ch-staged .go:disabled{opacity:.48;cursor:not-allowed}
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
.slm-ch-mapnav{margin:-2px 0 12px;padding:10px;border:1px solid var(--slm-line);border-radius:10px;background:var(--slm-surface)}
.slm-ch-mapnav-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--slm-muted)}
.slm-ch-mapnav-head button{color:var(--slm-accent);font-size:11px;font-weight:800;letter-spacing:0;text-transform:none;min-height:30px}
.slm-ch-mapnav .slm-ch-viewseg{margin:8px 0 5px}
.slm-ch-mapnav p{margin:0;font-size:11px;line-height:1.45;color:var(--slm-muted)}
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
.slm-ch-counts b.bump{animation:slm-ch-bump var(--slm-mo-base) var(--slm-mo-spring)}
@keyframes slm-ch-bump{0%,100%{transform:none}35%{transform:translateY(-2px) scale(1.08)}}
.slm-ch-access{margin-top:6px;font-size:10.5px;color:var(--slm-muted)}
.slm-ch-more{flex:none;color:var(--slm-muted);font-weight:800;padding:0 4px;min-height:28px}
.slm-ch-selsrc{display:flex;flex-direction:column;gap:5px;margin:8px 0 12px}
.slm-ch-selsrc-row{display:flex;align-items:center;gap:8px;font-size:12px;font-variant-numeric:tabular-nums}
.slm-ch-selsrc-row .mk{width:15px;height:15px;border-radius:4px;display:grid;place-items:center;font-size:8px;
  font-weight:800;color:#0e1017}
.slm-ch-selsrc-row b{min-width:30px;text-align:right;font-weight:800}
.slm-ch-selsrc-row span{color:var(--slm-muted)}
.slm-ch-selnum.bump{animation:slm-ch-bump var(--slm-mo-base) var(--slm-mo-spring)}
.slm-ch-row2{display:flex;gap:8px;margin-top:8px}
.slm-ch-row2 .slm-btn{flex:1;min-width:0}
/* distribute options — two actions, each with the one sentence that explains it */
.slm-ch-dist{display:flex;flex-direction:column;gap:6px;padding:12px;margin-bottom:8px;border:1px solid var(--slm-line);
  border-radius:10px;background:var(--slm-surface)}
.slm-ch-dist b{font-size:13px;font-weight:800}
.slm-ch-dist .why{color:var(--slm-muted);font-size:11.5px;line-height:1.45}
.slm-ch-dist .slm-btn{width:100%;margin-top:2px}
.slm-ch-alert{display:flex;align-items:flex-start;gap:9px;padding:11px 13px;border-radius:10px;font-size:12.5px;
  line-height:1.5;margin-bottom:12px}
.slm-ch-alert.warn{background:rgba(244,183,64,.1);border:1px solid rgba(244,183,64,.4);color:#f4d58a}
.slm-ch-alert.info{background:rgba(110,123,255,.12);border:1px solid rgba(110,123,255,.44);color:#c5cbff}
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
.slm-ch-dialog{width:min(460px,100%);max-height:100%;overflow:auto;overscroll-behavior:contain;background:#12151f;border:1px solid var(--slm-line);
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

/* buyer links — STATUS only; there is no Copy control on this card */
.slm-ch-link{padding:10px 11px;border:1px solid var(--slm-line);border-radius:10px;background:var(--slm-surface);
  margin-bottom:8px}
.slm-ch-link .lk-head{display:flex;align-items:center;gap:8px}
.slm-ch-link .lk-name{flex:1;min-width:0;font-size:12.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.slm-ch-lkrow{display:flex;gap:8px;margin-top:5px;font-size:11px;color:var(--slm-muted)}
.slm-ch-lkrow .k{flex:none;min-width:104px}
.slm-ch-lkrow .v{color:var(--slm-text);font-variant-numeric:tabular-nums}
.slm-ch-meter{height:5px;border-radius:3px;background:rgba(255,255,255,.09);overflow:hidden;margin-top:8px}
.slm-ch-meter i{display:block;height:100%;background:var(--slm-accent);
  transition:width var(--slm-mo-base) var(--slm-mo-out)}
.slm-ch-radio{display:flex;gap:9px;align-items:flex-start;padding:11px 12px;border:1px solid var(--slm-line);
  border-radius:10px;margin-top:8px;font-size:12.5px;cursor:pointer;
  transition:border-color var(--slm-mo-quick) var(--slm-mo-out)}
.slm-ch-radio:hover{border-color:var(--slm-muted)}
.slm-ch-radio input{flex:none;margin-top:2px}
.slm-ch-radio b{display:block;font-weight:800;margin-bottom:2px}
.slm-ch-radio .why{display:block;color:var(--slm-muted);font-size:11.5px;line-height:1.45}
.slm-ch-seatlist{max-height:44vh;overflow:auto;overscroll-behavior:contain;border:1px solid var(--slm-line);
  border-radius:10px;background:var(--slm-surface);margin-top:10px}
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

/* scope chooser: whole sections or many rows in one additive pass */
.slm-ch-scopebar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px;margin-top:12px}
.slm-ch-scopebar label{display:grid;gap:5px;color:var(--slm-muted);font-size:10.5px;font-weight:800}
.slm-ch-scopebar input{width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--slm-line);border-radius:8px;
  background:var(--slm-surface);color:var(--slm-text);font:inherit}
.slm-ch-scopesummary{padding-bottom:10px;color:var(--slm-muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.slm-ch-scopegroup{position:sticky;top:0;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;
  gap:6px;padding:6px 8px;border-bottom:1px solid var(--slm-line);background:var(--slm-surface)}
.slm-ch-groupcheck{display:flex;min-width:0;align-items:center;gap:8px;padding:5px 2px;text-align:left;font-size:11px;font-weight:800}
.slm-ch-groupcheck .box{width:16px;height:16px;flex:none;display:grid;place-items:center;border:1px solid var(--slm-muted);border-radius:4px;
  color:transparent;font-size:10px}
.slm-ch-groupcheck[aria-checked="true"] .box,.slm-ch-groupcheck[aria-checked="mixed"] .box{border-color:var(--slm-accent);
  background:var(--slm-accent);color:var(--slm-accent-ink)}
.slm-ch-groupcheck .meta{min-width:0;margin-left:auto;color:var(--slm-muted);font-size:10.5px;font-weight:600;white-space:nowrap}
.slm-ch-grouptoggle{min-height:32px;padding:5px 8px;color:var(--slm-accent);font-size:11px;font-weight:800}
.slm-ch-scopehint{padding:8px 10px;color:var(--slm-muted);font-size:10.5px;border-bottom:1px solid var(--slm-line)}
.slm-ch-scope-empty{padding:18px 12px;color:var(--slm-muted);font-size:11.5px;text-align:center}
@media(max-width:560px){.slm-ch-scopebar{grid-template-columns:1fr}.slm-ch-scopesummary{padding-bottom:0}}

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
  .slm-ch-layer,.slm-ch-banner,.slm-ch-staged,.slm-ch-row,.slm.compact.ch-sheet .slm-rail,
  .slm-ch-meter i,.slm-ch-radio{transition:none!important}
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

/**
 * Website integration is a BACKEND integration, so there is no screen to build
 * and this block is deliberately informational.
 *
 * It replaces a disabled "Configure server integration · Coming soon" button
 * that promised a wizard which does not exist and is not planned. A control that
 * can never do anything is worse than a sentence explaining why it isn't there:
 * the honest answer is "nothing to configure here, and here is the guide".
 *
 * It is shown only once the organizer has chosen this route (`intent: 'server'`),
 * because that is also the flag the dashboard's Embed page reads to offer the
 * snippet. Before that choice it would be an unasked-for wall of backend talk.
 */
const SERVER_INTEGRATION_HTML = `
  <p class="slm-eyebrow" style="margin-top:18px">On your website</p>
  <p class="slm-hint">There is nothing more to set up on this screen. Your own server mints a short-lived buyer
    access session for this channel with the SeatLayer server SDK and hands it to the widget. A channel name
    on its own never grants access.</p>
  <p class="slm-note"><a class="slm-linkbtn" href="https://docs.seatlayer.io/server-api/channels"
    target="_blank" rel="noreferrer noopener">Read the website integration guide →</a></p>`;

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** `<input type="datetime-local">` wants local wall-clock, not an ISO instant. */
function datetimeLocalValue(ms: number): string {
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** A whole number from a numeric field, or null when it is not one. This is the
 *  ONLY client-side validation on link policy — the ranges belong to the server. */
function intField(root: HTMLElement, selector: string): number | null {
  const raw = root.querySelector<HTMLInputElement>(selector)?.value.trim() ?? '';
  const value = Number(raw);
  return raw !== '' && Number.isInteger(value) ? value : null;
}

/** Clipboard-less fallback: put the revealed URL under the caret so it can still
 *  be copied by hand. Selection dies with the node, like the string itself. */
function selectSecret(dialog: HTMLElement): void {
  const node = dialog.querySelector<HTMLElement>('[data-ch-lk-url]');
  if (!node) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch { /* selection is a nicety; the URL is on screen regardless */ }
}

type Detent = 'collapsed' | 'medium' | 'full';

type DialogKind =
  | 'create' | 'review' | 'archive' | 'rename' | 'seatlist' | 'scope'
  | 'linkCreate' | 'linkRotate' | 'linkRevoke';

/**
 * There is deliberately NO `reveal` dialog kind. A one-time reveal is not a
 * re-renderable state: `renderDialog()` rebuilds a sheet from this object, so
 * anything reachable from here is by definition recoverable. The reveal is
 * mounted directly, holds its URL in a closure, and dies with its DOM node.
 */
interface DialogState {
  kind: DialogKind;
  channelId?: string;
  linkId?: string;
  /** Authoritative result rendered after Apply (review dialog only). */
  applied?: AssignmentResult | null;
  archiveBlocked?: ArchiveBlockedDetails | null;
  /** Which unit the scope chooser is picking (scope dialog only). */
  scope?: 'sections' | 'rows';
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
  /** Pan is intentionally the initial desktop interaction. Assignment's
   * marquee is powerful, but must never make an organizer lose map navigation. */
  private mapIntent: 'pan' | 'assign' = 'pan';
  private focusedSectionId: string | null = null;
  private showArchived = false;
  private detailChannelId: string | null = null;
  private targetChannelId = '';
  private conflict = false;
  private dialog: DialogState | null = null;
  private detent: Detent = 'medium';
  private seatListLimit = SEAT_LIST_PAGE;

  /**
   * Hosted-link STATUS for the channel whose detail panel is open. This is the
   * listing projection — it carries no url and no capability, because no route
   * returns one. `unsupported` is the honest answer for a worker that predates
   * M8, exactly like the buyer-preview probe.
   */
  private links: AccessLinkStatusRecord[] = [];
  private linksChannelId: string | null = null;
  private linksState: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error' = 'idle';

  /**
   * Monotonic read generations — one for the channel list + allocation, one for
   * the open channel's links. Reads are concurrent (a 10s poll versus a
   * mutation's own reload), and the network does not promise to answer them in
   * order. Only the NEWEST read of each kind may write to state; an older
   * answer that arrives late is dropped, never painted.
   */
  private listSeq = 0;
  private linksSeq = 0;

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
  /** Rows are structural chart data — they do not move while the organizer is
   * allocating. Deriving them walks every seat, so the view is cached for the
   * lifetime of this mode entry and ordinary selection repaints stay O(1). */
  private assignmentRowsCache: ChannelsRowView[] | null = null;
  /** The markup currently in the rail. An identical repaint is skipped, which is
   *  what keeps the organizer's scroll position (and open <select>) alive. */
  private railHtml: string | null = null;
  /**
   * The `assignmentVersion` the allocation map was built from. Walking every
   * allocation page is the expensive half of a refresh and the server already
   * tells us, in the channels response, whether ANY seat moved. Unchanged
   * version, unchanged allocation — so the walk is skipped entirely.
   */
  private allocationVersion: number | null = null;
  private onVisibility: (() => void) | null = null;

  constructor(host: ChannelsModeHost, capabilities: ChannelsCapabilities) {
    this.host = host;
    this.caps = capabilities;
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Called when the cockpit switches into Channels mode. */
  enter(): void {
    if (this.active) return;
    this.active = true;
    this.mapIntent = 'pan';
    this.focusedSectionId = null;
    this.assignmentRowsCache = null; // the chart may have changed since last entry
    this.railHtml = null; // the rail belonged to another mode a moment ago
    this.ensureLayer();
    this.host.root.classList.add('ch-mode');
    this.applySheetClasses();
    // A sectioned venue begins at semantic overview. The renderer owns the
    // camera and turns this into a real section-only rung, not a fake card UI.
    if (this.host.sections().length > 1) this.host.showSectionOverview();
    this.paintRail();
    this.onInteractionChange?.();
    void this.refresh();
    // A hidden tab has no organizer looking at it. Polling it burns the event's
    // rate budget to repaint pixels nobody can see — and browsers throttle the
    // timer anyway, so the ticks that do land arrive in a clump. Skip them, and
    // catch up with exactly one read when the tab comes back.
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.refresh({ quiet: true });
    }, POLL_MS);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.onVisibility = () => {
        if (this.active && !document.hidden) void this.refresh({ quiet: true });
      };
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  /** Called when the cockpit leaves Channels mode. Everything this mode painted
   *  over the map goes with it — no other tool ever inherits a channel overlay. */
  leave(): void {
    if (!this.active) return;
    this.active = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.onVisibility = null;
    this.railHtml = null;
    this.closeDialog({ restoreFocus: false });
    // Link status is per-channel and short-lived; nothing about it survives the
    // mode, and there was never a secret in it to survive.
    this.links = [];
    this.linksChannelId = null;
    this.linksState = 'idle';
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

  /** Bulk seat assignment is explicit. In Pan map, clicks can still inspect a
   * single seat, while a primary-button drag always moves the camera. */
  usesMarqueeSelection(): boolean {
    return this.canSelect() && this.mapIntent === 'assign';
  }

  /** The renderer calls this when the organizer opens a section from overview. */
  handleSectionFocus(sectionId: string): void {
    if (!this.active) return;
    this.focusedSectionId = sectionId;
    this.paintRail();
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
    // A ten-second poll runs alongside every mutation, so two refreshes are
    // routinely in flight at once. Without a generation the slower FIRST one
    // lands last and repaints the panel with what the channel looked like
    // BEFORE the mutation — the create/rotate/revoke result silently reverts.
    const seq = ++this.listSeq;
    const superseded = (): boolean => seq !== this.listSeq;
    try {
      const list = await this.host.api.channels(this.host.eventKey, { includeArchived: this.showArchived });
      if (superseded()) return;
      this.list = list;
      this.assignmentVersion = list.assignmentVersion;
      this.loadError = null;
      if (!this.targetChannelId) {
        this.targetChannelId = list.channels.find((c) => c.state === 'active')?.id ?? PUBLIC_CHANNEL_ID;
      }
      // The allocation walk is the expensive half of this refresh (one request
      // per 1,000 seats). `assignmentVersion` is bumped by the server on every
      // assignment, so an unchanged version means an unchanged map — re-reading
      // it would spend an arena's worth of round trips to rebuild an identical
      // Map every poll tick.
      if (this.allocationVersion !== list.assignmentVersion) {
        await this.loadAllocation(seq);
        if (superseded()) return;
        this.allocationVersion = list.assignmentVersion;
      }
      // Redemptions and live-session counts move on their own, so the open
      // channel's link status rides the same clock as its seat counts.
      if (this.detailChannelId) await this.loadLinks(this.detailChannelId);
      if (superseded()) return;
      this.loading = false;
      if (this.active) {
        this.paintRail();
        this.paintOverlay();
      }
    } catch (err) {
      if (superseded()) return;
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
  private async loadAllocation(seq?: number): Promise<void> {
    const next = new Map<string, string>();
    let afterLabel: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      // A superseded walk stops paging rather than finishing a read nobody will use.
      if (seq !== undefined && seq !== this.listSeq) return;
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
    if (seq !== undefined && seq !== this.listSeq) return;
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
   * letter flags below — never color alone. In buyer preview the map instead
   * uses two explicit, channel-neutral access states. Physical status keeps its
   * own cue: only FREE units are repainted, so sold/held/blocked seats still
   * read exactly as they do in every other tool.
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

    const seatDetail = this.host.isSeatDetail();
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
    const sectionTargets = !seatDetail && this.host.sections().length > 1
      ? new Map<string, { label: string; minX: number; minY: number; maxX: number; maxY: number }>()
      : null;
    // At a wide zoom the renderer centres section names over the seat field.
    // Re-draw those names above the access marks so visual availability never
    // competes with the section identity the organizer needs to navigate.
    const previewSections = this.view === 'preview' && seatDetail && size <= 15
      ? new Map<string, { label: string; minX: number; minY: number; maxX: number; maxY: number }>()
      : null;

    for (const seat of this.host.seats()) {
      const status = this.host.statusOf(seat.label) ?? 'free';
      const channelId = this.allocation.get(seat.label) ?? PUBLIC_CHANNEL_ID;
      if (channelId !== PUBLIC_CHANNEL_ID) {
        const cluster = clusters.get(channelId) ?? { x: 0, y: 0, n: 0 };
        cluster.x += seat.x; cluster.y += seat.y; cluster.n += 1;
        clusters.set(channelId, cluster);
      }
      // The base renderer presents named section shells at the overview rung.
      // Do not redraw thousands of seat dots above those shells; click a
      // section to enter its seats, where the precise allocation paint resumes.
      if (!seatDetail) {
        const section = this.host.sectionOfLabel(seat.label);
        const point = section ? this.host.worldToScreen({ x: seat.x, y: seat.y }) : null;
        if (sectionTargets && section && point) {
          const bounds = sectionTargets.get(section.id) ?? {
            label: section.label, minX: point.x, minY: point.y, maxX: point.x, maxY: point.y,
          };
          bounds.minX = Math.min(bounds.minX, point.x);
          bounds.minY = Math.min(bounds.minY, point.y);
          bounds.maxX = Math.max(bounds.maxX, point.x);
          bounds.maxY = Math.max(bounds.maxY, point.y);
          sectionTargets.set(section.id, bounds);
        }
        continue;
      }
      if (status !== 'free') continue; // physical state always wins the paint
      let fill: string | null = null;
      let stroke: string | null = null;
      if (this.view === 'preview') {
        // ONE neutral unavailable state for everything this audience can't buy —
        // preview must never leak which private channel holds a seat. Both
        // states are painted, rather than leaving eligible seats in their
        // category colour: the exact allocation must be obvious at a glance.
        if (eligible?.has(seat.label)) {
          fill = PREVIEW_ELIGIBLE_FILL;
          stroke = PREVIEW_ELIGIBLE_STROKE;
        } else {
          fill = PREVIEW_UNAVAILABLE_FILL;
          stroke = PREVIEW_UNAVAILABLE_STROKE;
        }
      } else if (channelId !== PUBLIC_CHANNEL_ID) {
        fill = this.markerFor(channelId).color;
        stroke = ALLOCATION_STROKE;
      }
      if (!fill) continue;
      const point = this.host.worldToScreen({ x: seat.x, y: seat.y });
      if (!point) continue;
      if (point.x < -size || point.y < -size || point.x > width + size || point.y > height + size) continue;
      if (previewSections) {
        const section = this.host.sectionOfLabel(seat.label);
        if (section) {
          const bounds = previewSections.get(section.id) ?? {
            label: section.label, minX: point.x, minY: point.y, maxX: point.x, maxY: point.y,
          };
          bounds.minX = Math.min(bounds.minX, point.x);
          bounds.minY = Math.min(bounds.minY, point.y);
          bounds.maxX = Math.max(bounds.maxX, point.x);
          bounds.maxY = Math.max(bounds.maxY, point.y);
          previewSections.set(section.id, bounds);
        }
      }
      ctx.fillStyle = fill;
      if (this.view === 'preview' || channelId !== PUBLIC_CHANNEL_ID) {
        // Seats in the shared 2D renderer are circular. A generously covering
        // circular paint keeps Inspect allocation's channel colour independent
        // of the chart category, and replaces preview's former inner square so
        // there is no coloured rim or distracting grey-box effect.
        // `seatPixelSize` is the renderer's actual seat diameter. Match that
        // geometry (with only the stroke allowance), rather than inflating a
        // little status marker. That preserves the chart's configured row and
        // column gaps at every zoom and prevents category-colour rims leaking
        // through around a buyer-preview state.
        const radius = Math.max(2, half + Math.min(1.5, half * 0.06));
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = stroke ?? fill;
        ctx.lineWidth = this.view === 'preview'
          ? Math.max(1, Math.min(1.75, size * 0.13))
          : Math.max(1, Math.min(1.5, size * 0.1));
        ctx.stroke();
        // The overlay sits above the renderer, so it must restore the chart's
        // real label after painting an eligible buyer seat. Use the source
        // label verbatim and only when it remains legible inside the seat.
        if (this.view === 'preview' && eligible?.has(seat.label) && size >= 22) {
          this.paintPreviewSeatLabel(ctx, seat.label, point.x, point.y, radius);
        }
      } else {
        ctx.globalAlpha = 0.85;
        ctx.fillRect(point.x - half, point.y - half, size, size);
      }
    }
    ctx.globalAlpha = 1;
    if (previewSections) this.paintPreviewSectionLabels(ctx, previewSections);
    this.paintSectionTargets(sectionTargets);
    this.paintFlags(clusters);
  }

  /** Draw an eligible seat's actual chart label without inventing a new buyer
   * identifier. Long labels scale down and are omitted rather than overflowing
   * into an adjacent seat. */
  private paintPreviewSeatLabel(
    ctx: CanvasRenderingContext2D,
    label: string,
    x: number,
    y: number,
    radius: number,
  ): void {
    const maxWidth = radius * 1.55;
    let fontSize = Math.min(13, Math.max(7, radius * 0.55));
    const minFontSize = 6;
    while (fontSize >= minFontSize) {
      ctx.font = `800 ${fontSize}px var(--slm-font, system-ui, sans-serif)`;
      if (ctx.measureText(label).width <= maxWidth) break;
      fontSize -= 0.5;
    }
    if (fontSize < minFontSize) return;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }

  /** A section overview is a navigation map. These transparent, keyboardable
   * hit areas sit over the renderer's section shells so both mouse and keyboard
   * always take the organizer into the real focused-section camera state. */
  private paintSectionTargets(
    sections: Map<string, { label: string; minX: number; minY: number; maxX: number; maxY: number }> | null,
  ): void {
    const layer = this.layer;
    if (!layer) return;
    layer.querySelectorAll('.slm-ch-section-target').forEach((el) => el.remove());
    if (!sections) return;
    for (const [id, section] of sections) {
      const width = section.maxX - section.minX;
      const height = section.maxY - section.minY;
      if (width < 20 || height < 20) continue;
      const target = document.createElement('button');
      target.type = 'button';
      target.className = 'slm-ch-section-target';
      target.style.left = `${section.minX - 8}px`;
      target.style.top = `${section.minY - 8}px`;
      target.style.width = `${width + 16}px`;
      target.style.height = `${height + 16}px`;
      target.setAttribute('aria-label', `Open ${section.label} seats`);
      target.addEventListener('click', () => {
        this.focusedSectionId = id;
        this.host.focusSection(id);
        this.paintRail();
      });
      layer.appendChild(target);
    }
  }

  /** Keep renderer section names legible over a dense, zoomed-out preview. */
  private paintPreviewSectionLabels(
    ctx: CanvasRenderingContext2D,
    sections: Map<string, { label: string; minX: number; minY: number; maxX: number; maxY: number }>,
  ): void {
    for (const section of sections.values()) {
      const width = section.maxX - section.minX;
      const height = section.maxY - section.minY;
      // A single row/seat has no overlaid central renderer label to protect.
      if (width < 52 || height < 26) continue;
      const centerX = (section.minX + section.maxX) / 2;
      const centerY = (section.minY + section.maxY) / 2;
      const fontSize = Math.max(11, Math.min(15, height * 0.16));
      ctx.font = `800 ${fontSize}px var(--slm-font, system-ui, sans-serif)`;
      const labelWidth = Math.min(width - 8, ctx.measureText(section.label).width + 18);
      const labelHeight = fontSize + 10;
      // This small backplate deliberately covers the renderer's original
      // label before the high-contrast replacement is drawn above it.
      ctx.fillStyle = 'rgba(11, 16, 28, .88)';
      ctx.fillRect(centerX - labelWidth / 2, centerY - labelHeight / 2, labelWidth, labelHeight);
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(section.label, centerX, centerY);
    }
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
    const tooLarge = labels.length > MAX_ASSIGNMENT_UNITS;
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
      <button type="button" class="go" data-ch-act="review"${tooLarge ? ' disabled' : ''}>
        ${tooLarge ? `Maximum ${MAX_ASSIGNMENT_UNITS.toLocaleString()} seats` : 'Review changes'}
      </button>`);
    this.stagedEl?.querySelectorAll<HTMLElement>('[data-ch-act]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.chAct === 'discard') this.host.clearSelection();
        else this.openDialog({ kind: 'review' });
      });
    });
  }

  private setBanner(on: boolean, name = '', eligibleSeats?: number): void {
    const banner = this.bannerEl;
    if (!banner) return;
    this.host.root.classList.toggle('ch-preview', on);
    if (!on) { banner.classList.remove('on'); banner.innerHTML = ''; return; }
    const marker = this.previewAudience.length === 1
      ? this.markerFor(this.previewAudience[0])
      : { color: 'var(--slm-accent)', letter: '' };
    const availability = eligibleSeats == null
      ? ''
      : ` · ${eligibleSeats.toLocaleString()} ${eligibleSeats === 1 ? 'seat' : 'seats'} available now`;
    banner.innerHTML = `<span class="dot" style="background:${esc(marker.color)}"></span>
      Previewing buyer access · ${esc(name)}${availability} · read-only
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
      // `eligible` is the server's exact current buyer scope. Older workers may
      // omit its redundant aggregate count, so use the returned label count
      // rather than hiding the organiser's most useful confirmation.
      const eligibleSeats = this.previewProjection.available === false
        ? undefined
        : this.previewProjection.counts?.eligible ?? this.previewProjection.eligible?.length;
      this.setBanner(true, names, eligibleSeats);
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

  /**
   * Replace the rail's markup — but only when it actually differs, and never at
   * the cost of where the organizer had scrolled to.
   *
   * The rail repaints on a clock, on every selection change and after every
   * mutation. Rewriting `innerHTML` each time resets `scrollTop`, which is
   * exactly what "the rail gets stuck" was: scroll down to Create channel, the
   * poll ticks, and the list snaps back to the top under the cursor. So skip the
   * write when the markup is byte-identical, and restore the offset when it is
   * not.
   *
   * Returns whether the DOM was rewritten. Callers must only re-wire listeners
   * when it was — a skipped paint keeps the old nodes AND their listeners, so
   * re-wiring would double every handler.
   */
  private setRailHtml(html: string): boolean {
    if (html === this.railHtml) return false;
    const rail = this.host.rail;
    const scrollTop = rail.scrollTop;
    rail.innerHTML = html;
    this.railHtml = html;
    if (scrollTop) rail.scrollTop = scrollTop;
    return true;
  }

  paintRail(): void {
    if (!this.active) return;
    const rail = this.host.rail;
    if (!this.caps.view) {
      this.setRailHtml(`<p class="slm-eyebrow">Sales channels</p>
        <p class="slm-hint">You need channel-management permission on this event to see allocations.</p>`);
      return;
    }
    if (this.loading && !this.list) {
      this.setRailHtml(`<p class="slm-eyebrow">Sales channels</p>
        <div class="slm-empty">Loading allocations…</div>`);
      return;
    }
    if (!this.list && this.loadError) {
      if (this.setRailHtml(`<p class="slm-eyebrow">Sales channels</p>
        <div class="slm-ch-alert err" role="alert"><span>⚠</span>
        <span><b>Couldn't load sales channels.</b> Everything else on this event still works.
        <button type="button" data-ch-act="retry">Try again</button></span></div>`)) {
        rail.querySelector('[data-ch-act="retry"]')?.addEventListener('click', () => { void this.refresh(); });
      }
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
    if (this.setRailHtml(`${grab}${segment}${body}`)) this.wireRail();
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
    </div>${this.mapNavigationHtml()}`;
  }

  private mapNavigationHtml(): string {
    if (this.host.sections().length < 2) return '';
    const focused = this.focusedSectionId
      ? this.host.sections().find((section) => section.id === this.focusedSectionId)?.label ?? 'section'
      : null;
    const panOn = this.mapIntent === 'pan' ? ' on' : '';
    const assignOn = this.mapIntent === 'assign' ? ' on' : '';
    const intent = this.view === 'inspect' && this.caps.manage
      ? `<div class="slm-ch-viewseg" role="group" aria-label="Map interaction">
          <button type="button" class="${panOn.trim()}" data-ch-map="pan" aria-pressed="${this.mapIntent === 'pan'}">Pan map</button>
          <button type="button" class="${assignOn.trim()}" data-ch-map="assign" aria-pressed="${this.mapIntent === 'assign'}">Assign seats</button>
        </div>
        <p>${this.mapIntent === 'pan'
          ? 'Drag to explore. Click a section to open its seats.'
          : 'Drag across seats to select them for allocation.'}</p>`
      : '<p>Drag to explore. Click a section to open its seats.</p>';
    return `<div class="slm-ch-mapnav">
      <div class="slm-ch-mapnav-head"><span>${focused ? `Viewing ${esc(focused)}` : 'Section overview'}</span>
        <button type="button" data-ch-act="sections">All sections</button></div>
      ${intent}
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
      ${this.caps.manage ? this.assignmentToolsHtml() : ''}
      <p class="slm-eyebrow">Sales channels</p>
      <p class="slm-hint">Channel colours and names are only visible to organizers, never to buyers.</p>
      <div class="slm-ch-list">${rows}</div>
      ${create}
      ${readOnly}
      <p class="slm-note" style="margin-top:10px">
        <button type="button" class="slm-linkbtn" data-ch-act="toggle-archived" aria-pressed="${this.showArchived}"
          style="text-align:left">${this.showArchived ? 'Hide' : 'Show'} archived${archivedCount ? ` (${archivedCount})` : ''}</button>
      </p>`;
  }

  /**
   * Destination-first assignment controls.
   *
   * These used to live only inside the selection rail, which meant every route
   * into them was gated behind "select a seat on the map first" — the section,
   * row and category choosers were invisible until the organizer had already
   * done the work by hand. They now paint above the channel list too, so the
   * destination is chosen first and whole sections and rows are discoverable
   * without learning a hidden seat-first workflow.
   */
  private assignmentToolsHtml(): string {
    const options = this.assignableChannels()
      .map((channel) => `<option value="${esc(channel.id)}"${channel.id === this.targetChannelId ? ' selected' : ''}>${esc(channel.name)}</option>`)
      .join('');
    const sections = this.host.sections().length
      ? '<button type="button" class="slm-btn ghost" data-ch-act="pick-sections">Sections</button>' : '';
    const rows = this.assignmentRows().length
      ? '<button type="button" class="slm-btn ghost" data-ch-act="pick-rows">Rows</button>' : '';
    // Drag box is a map INTENT, not a dialog: it arms the marquee, so it shows
    // its armed state the same way the map-navigation segment does.
    const dragClass = this.mapIntent === 'assign' ? 'slm-btn' : 'slm-btn ghost';
    return `
      <p class="slm-eyebrow">Assign inventory</p>
      <div class="slm-field">
        <label for="slm-ch-target">Assign to</label>
        <select class="slm-select" id="slm-ch-target" data-ch-target>${options}</select>
      </div>
      <p class="slm-eyebrow" style="margin-top:12px">Select by</p>
      <div class="slm-ch-row2" style="margin-top:2px">
        ${sections}${rows}
        <button type="button" class="${dragClass}" data-ch-act="drag-select">Drag box</button>
      </div>
      <div class="slm-ch-row2">
        <button type="button" class="slm-btn ghost" data-ch-act="pick-category">Category</button>
        <button type="button" class="slm-btn ghost" data-ch-act="seatlist">Seat list ⌨</button>
      </div>
      <p class="slm-note">Choose a destination, then add whole sections, multiple rows, a dragged area, or individual seats.</p>`;
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
    const tooLarge = selection.length > MAX_ASSIGNMENT_UNITS;
    const sourceRows = sources.map((row) => {
      const marker = this.markerFor(row.channelId);
      return `<div class="slm-ch-selsrc-row">
        <span class="mk" style="background:${esc(marker.color)}" aria-hidden="true">${esc(marker.letter)}</span>
        <b>${row.count.toLocaleString()}</b><span>${esc(row.name)}</span></div>`;
    }).join('');
    return `
      ${conflict}
      ${this.assignmentToolsHtml()}
      <div class="slm-selbar"><span class="slm-selnum slm-ch-selnum${bump}">${selection.length.toLocaleString()}</span>
        <span class="slm-sellabel">selected</span></div>
      <div class="slm-ch-selsrc" aria-live="polite" aria-label="Selection sources">${sourceRows}</div>
      ${tooLarge ? `<div class="slm-ch-alert warn" role="alert"><span>ℹ</span><span>
        <b>This selection is too large to apply at once.</b> Choose at most ${MAX_ASSIGNMENT_UNITS.toLocaleString()}
        seats, for example by splitting the venue into row groups.</span></div>` : ''}
      <p class="slm-note">Changes are staged — nothing moves until you review and apply.
        Seats in checkout or already sold are never moved.</p>
      <div class="slm-ch-row2">
        <button type="button" class="slm-btn ghost" data-ch-act="discard">Clear selection</button>
        <button type="button" class="slm-btn" data-ch-act="review"${tooLarge ? ' disabled' : ''}>Review changes</button>
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
    const access = this.caps.manage ? this.distributeHtml(channel) : '';
    return `
      <p class="slm-eyebrow">
        <button type="button" class="slm-linkbtn" data-ch-act="back" style="text-align:left">‹ All channels</button>
      </p>
      <p class="slm-eyebrow">Channel · ${esc(channel.name)}</p>
      <div class="slm-ch-list">${this.channelRowHtml(channel)}</div>
      ${access}
      ${lifecycle}`;
  }

  /**
   * "Distribute" — how the seats in this channel actually reach a buyer.
   *
   * This replaced a four-value "access intent" picker (none / internal /
   * hosted_link / server). Two of those values did nothing anywhere: no buyer or
   * inventory path reads `access_intent`, so `none` and `internal` were labels an
   * organizer could set and then wait forever for something to happen. A third,
   * `hosted_link`, is not the organizer's to choose at all — the server sets it
   * when a buyer link is created and clears it when the last live one is revoked.
   *
   * So this is two ACTIONS, not a setting: create a buyer link, or point the
   * channel at a website integration. Both of them do something the moment they
   * are pressed. A legacy row still carrying `none` or `internal` renders the
   * neutral "not distributed yet" state with both actions offered — the stored
   * value is left alone (it is organizer-declared metadata and the API that
   * writes it is unchanged), it simply no longer has a control of its own.
   */
  private distributeHtml(channel: ChannelRecord): string {
    const intent = (channel.access?.intent ?? 'none') as ChannelAccessIntent;
    const live = channel.access?.hasActiveGrants === true;
    // The one honest sentence about this channel's current reach. "Seats stay
    // reserved" is not a consolation: an allocated seat is withheld from public
    // sale whether or not anyone can buy it yet, and that IS the useful fact.
    const state = live
      ? intent === 'server'
        ? 'Your website is letting buyers in. Only they can buy these seats.'
        : 'A buyer link is live. Only people with that link can buy these seats.'
      : intent === 'server'
        ? 'Set up for your website — no buyer has come through yet. Seats stay reserved.'
        : 'Not distributed yet — seats stay reserved.';
    const option = (
      title: string, why: string, action: string, cta: string, primary: boolean,
    ): string => `<div class="slm-ch-dist">
      <b>${esc(title)}</b>
      <span class="why">${esc(why)}</span>
      <button type="button" class="slm-btn${primary ? '' : ' ghost'}" data-ch-act="${esc(action)}">${esc(cta)}</button>
    </div>`;
    // A worker that predates buyer links answers 404 on the listing route, and
    // would answer 404 on the create too. Offering the action there would be a
    // button that can only fail; the status block below says why it is absent.
    const linksSupported = this.linksState !== 'unsupported';
    return `
      <p class="slm-eyebrow" style="margin-top:14px">Distribute</p>
      <p class="slm-hint">${esc(state)}</p>
      ${linksSupported ? option(
        'Sell with a buyer link',
        'SeatLayer makes a link you send to a named group. They open it and buy only these seats.',
        'link-create', this.links.some(accessLinkIsLive) ? 'Create another buyer link' : 'Create buyer link', true,
      ) : ''}
      ${option(
        'Integrate a website or app',
        "Your website's backend grants each buyer access — set up on the Embed page.",
        'embed-code', 'Get embed code', false,
      )}
      ${this.hostedLinksHtml()}
      ${intent === 'server' ? SERVER_INTEGRATION_HTML : ''}`;
  }

  // ---- buyer links ----------------------------------------------------------

  /**
   * Read the status projection for the open channel. Never paints — the caller
   * decides when the rail repaints, so a poll-driven reload does not fight a
   * user-driven one. A worker without M8 answers 404/405 and gets the honest
   * "needs a newer server" line rather than an error toast.
   */
  private async loadLinks(channelId: string): Promise<void> {
    if (!this.caps.view) return;
    const seq = ++this.linksSeq;
    // Superseded by a newer read of the same channel — a poll that started
    // before the mutation must not overwrite the mutation's own answer.
    const superseded = (): boolean => seq !== this.linksSeq || this.linksChannelId !== channelId;
    if (this.linksChannelId !== channelId) {
      this.links = [];
      this.linksChannelId = channelId;
      this.linksState = 'loading';
    }
    try {
      const res = await this.host.api.accessLinks(this.host.eventKey, channelId);
      if (superseded()) return; // the organizer moved on, or a fresher read won
      this.links = res.links ?? [];
      this.linksState = 'ready';
    } catch (err) {
      if (superseded()) return;
      const status = err instanceof ManageApiError ? err.status : 0;
      this.links = [];
      this.linksState = status === 404 || status === 405 || status === 501 ? 'unsupported' : 'error';
      if (this.linksState === 'error') this.host.onError(err);
    }
  }

  /**
   * The buyer-link status section of the detail panel.
   *
   * STATUS ONLY, by design (comp 06 `hosted`): label, state, expiry,
   * redemptions, seats per buyer, live sessions. There is no Copy control here
   * and no field to hang one on — the URL was shown once at creation and cannot
   * be produced again. Rotation is the recovery path, and it says so.
   *
   * Creating a link is the Distribute card's action, not this section's, so a
   * channel with no links renders nothing here rather than an empty heading and
   * a second button saying the same thing.
   */
  private hostedLinksHtml(): string {
    const eyebrow = `<p class="slm-eyebrow" style="margin-top:18px">Buyer links</p>`;
    if (this.linksState === 'unsupported') {
      return `${eyebrow}<div class="slm-ch-alert warn"><span>ℹ</span>
        <span><b>Buyer links need a newer server.</b> Everything else on this channel works normally.</span></div>`;
    }
    if (this.linksState === 'error') {
      return `${eyebrow}<div class="slm-ch-alert err" role="alert"><span>⚠</span>
        <span><b>Couldn't load this channel's links.</b>
        <button type="button" data-ch-act="link-reload">Try again</button></span></div>`;
    }
    if (this.linksState === 'loading' && !this.links.length) {
      return `${eyebrow}<div class="slm-empty">Loading links…</div>`;
    }
    if (!this.links.length) return '';
    return `${eyebrow}
      ${this.links.map((link) => this.linkCardHtml(link)).join('')}
      <p class="slm-note">A link is shown once, when you create it. SeatLayer keeps only a fingerprint of it, so it
        can never be shown again — if a link is lost, rotate it and send the fresh one.</p>`;
  }

  private linkCardHtml(link: AccessLinkStatusRecord): string {
    const badge = accessLinkBadge(link);
    const used = link.maxRedemptions > 0
      ? Math.min(100, Math.round((link.redemptions / link.maxRedemptions) * 100))
      : 0;
    const rows = accessLinkPolicyLines(link)
      .map((row) => `<div class="slm-ch-lkrow"><span class="k">${esc(row.k)}</span>
        <span class="v">${esc(row.v)}</span></div>`).join('');
    const sessions = link.activeSessions
      ? `<div class="slm-ch-lkrow"><span class="k">Buyers inside now</span>
          <span class="v">${link.activeSessions.toLocaleString()}</span></div>`
      : '';
    const lastUsed = link.lastRedeemedAt
      ? `<div class="slm-ch-lkrow"><span class="k">Last opened</span>
          <span class="v">${esc(new Date(link.lastRedeemedAt).toLocaleString())}</span></div>`
      : '';
    const actions = this.caps.manage && accessLinkIsLive(link)
      ? `<div class="slm-ch-row2">
          <button type="button" class="slm-btn ghost" data-ch-rotate="${esc(link.id)}">Rotate</button>
          <button type="button" class="slm-btn ghost" data-ch-revoke="${esc(link.id)}">Revoke</button>
        </div>`
      : '';
    return `<div class="slm-ch-link">
      <span class="lk-head">
        <span class="lk-name">${esc(link.label || 'Buyer link')}</span>
        <span class="slm-ch-badge ${badge.kind}">${esc(badge.text)}</span>
      </span>
      <div class="slm-ch-meter" role="img"
        aria-label="${link.redemptions.toLocaleString()} of ${link.maxRedemptions.toLocaleString()} redemptions used">
        <i style="width:${used}%"></i></div>
      ${rows}${sessions}${lastUsed}
      <div class="slm-ch-lkrow"><span class="k">The URL</span>
        <span class="v">Revealed once at creation — not recoverable</span></div>
      ${actions}
    </div>`;
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
    const eligibleSeats = this.previewProjection?.counts?.eligible ?? this.previewProjection?.eligible?.length;
    const summary = eligibleSeats != null && this.previewProjection?.available !== false
      ? `<div class="slm-ch-alert info"><span>✓</span><span><b>${eligibleSeats.toLocaleString()} ${eligibleSeats === 1 ? 'seat is' : 'seats are'} available now.</b>
          This is the exact buyer-visible allocation.${this.previewProjection?.includePublic === false
            ? ' Public sale seats are <b>not</b> included in this access.' : ''}</span></div>`
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
    rail.querySelectorAll<HTMLElement>('[data-ch-map]').forEach((button) => {
      button.addEventListener('click', () => {
        this.mapIntent = button.dataset.chMap === 'assign' ? 'assign' : 'pan';
        this.paintRail();
        this.onInteractionChange?.();
      });
    });
    rail.querySelectorAll<HTMLElement>('[data-ch-detail]').forEach((button) => {
      button.addEventListener('click', () => {
        const channelId = button.dataset.chDetail!;
        this.detailChannelId = channelId;
        this.paintRail();
        void this.loadLinks(channelId).then(() => this.paintRail());
      });
    });
    rail.querySelectorAll<HTMLElement>('[data-ch-rotate]').forEach((button) => {
      button.addEventListener('click', () => this.openDialog({
        kind: 'linkRotate', channelId: this.detailChannelId!, linkId: button.dataset.chRotate!,
      }));
    });
    rail.querySelectorAll<HTMLElement>('[data-ch-revoke]').forEach((button) => {
      button.addEventListener('click', () => this.openDialog({
        kind: 'linkRevoke', channelId: this.detailChannelId!, linkId: button.dataset.chRevoke!,
      }));
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
    const grab = rail.querySelector<HTMLElement>('.slm-ch-grab');
    grab?.addEventListener('click', () => this.cycleDetent());
    rail.querySelectorAll<HTMLElement>('[data-ch-act]').forEach((button) => {
      button.addEventListener('click', () => this.railAction(button.dataset.chAct!));
    });
  }

  private railAction(action: string): void {
    switch (action) {
      case 'sections':
        this.focusedSectionId = null;
        this.host.showSectionOverview();
        this.paintRail();
        break;
      case 'create': this.openDialog({ kind: 'create' }); break;
      case 'review': this.openDialog({ kind: 'review' }); break;
      case 'rename': this.openDialog({ kind: 'rename', channelId: this.detailChannelId! }); break;
      case 'archive': this.openDialog({ kind: 'archive', channelId: this.detailChannelId! }); break;
      case 'seatlist': this.openDialog({ kind: 'seatlist' }); break;
      case 'pause': void this.togglePause(); break;
      case 'discard': this.host.clearSelection(); break;
      case 'back':
        this.detailChannelId = null;
        this.linksChannelId = null;
        this.links = [];
        this.linksState = 'idle';
        this.paintRail();
        break;
      case 'link-create':
        this.openDialog({ kind: 'linkCreate', channelId: this.detailChannelId! });
        break;
      // The one thing this screen can actually do for a website integration is
      // record that the channel is meant for one — which is exactly the flag the
      // dashboard's Embed page reads before it offers the snippet. Saying so is
      // honest; a fake "copy code" button on a screen with no code would not be.
      case 'embed-code': void this.chooseWebsiteIntegration(); break;
      case 'link-reload':
        if (this.detailChannelId) void this.reloadLinks();
        break;
      case 'retry': void this.refresh(); break;
      case 'toggle-archived':
        this.showArchived = !this.showArchived;
        void this.refresh();
        break;
      case 'refresh-review':
        this.conflict = false;
        void this.refresh().then(() => this.openDialog({ kind: 'review' }));
        break;
      case 'pick-sections': this.openDialog({ kind: 'scope', scope: 'sections' }); break;
      case 'pick-rows': this.openDialog({ kind: 'scope', scope: 'rows' }); break;
      case 'drag-select':
        this.mapIntent = 'assign';
        this.paintRail();
        this.onInteractionChange?.();
        break;
      case 'pick-category': this.pickCategory(); break;
      default: break;
    }
  }

  // ---- selection helpers ----------------------------------------------------

  /** Derived once per mode entry — see `assignmentRowsCache`. */
  private assignmentRows(): ChannelsRowView[] {
    if (!this.assignmentRowsCache) this.assignmentRowsCache = this.host.rows();
    return this.assignmentRowsCache;
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

  /**
   * Add several whole sections, or several whole rows, in one operation.
   *
   * ADDITIVE by contract: the chooser starts from the labels already selected
   * and only ever grows that set, so opening it never destroys a hard-won
   * marquee or seat-list selection. The confirm button always states the net
   * number of seats it will add, and refuses to exceed `MAX_ASSIGNMENT_UNITS`.
   *
   * Rows get the richer variant. A large venue has thousands of them, so they
   * arrive collapsed under their section, with a section-level tri-state
   * checkbox, a search across every row, and a render cap — the flat list used
   * for sections would be an unusable wall of buttons.
   */
  private renderScopeDialog(state: DialogState): void {
    const scope = state.scope === 'rows' ? 'rows' : 'sections';
    const options = scope === 'sections'
      ? this.host.sections().map((section) => ({
        id: section.id,
        label: section.label,
        group: 'Sections',
        labels: this.host.labelsInSection(section.id),
      }))
      : this.assignmentRows().map((row) => ({
        id: row.id,
        label: row.label,
        group: row.sectionLabel,
        labels: row.labels,
      }));
    // A section or row with nothing selectable in it is a dead entry, not a
    // choice — offering it would produce an "Add 0 seats" button.
    const available = options.filter((option) => option.labels.length > 0);
    const grouped = new Map<string, typeof available>();
    for (const option of available) {
      const group = grouped.get(option.group) ?? [];
      group.push(option);
      grouped.set(option.group, group);
    }

    if (scope === 'rows') {
      const groups = [...grouped.entries()];
      this.renderScrim(`
        <h3 id="slm-ch-dlg-title">Add multiple rows</h3>
        <p class="sub">Sections stay collapsed for speed. Select a whole section, expand only the rows you need, or search across every row.</p>
        <div class="slm-ch-scopebar">
          <label>Find section or row<input type="search" data-ch-scope-search placeholder="e.g. Orchestra or AA"></label>
          <span class="slm-ch-scopesummary" data-ch-scope-summary aria-live="polite">0 rows selected</span>
        </div>
        <p class="slm-ch-scopehint" data-ch-scope-filter>Showing section groups. Expand one or search to see rows.</p>
        <div class="slm-ch-seatlist" data-ch-scope-list></div>
        <p class="slm-ch-err" data-ch-error hidden></p>
        <div class="foot">
          <button type="button" class="quiet" data-ch-close>Cancel</button>
          <button type="button" class="slm-btn" data-ch-add-scope disabled>Add seats</button>
        </div>`, (dialog) => {
        const byId = new Map(available.map((option) => [option.id, option]));
        const picked = new Set<string>();
        const expanded = new Set<number>();
        const current = new Set(this.host.selectionLabels());
        const confirm = dialog.querySelector<HTMLButtonElement>('[data-ch-add-scope]')!;
        const error = dialog.querySelector<HTMLElement>('[data-ch-error]')!;
        const list = dialog.querySelector<HTMLElement>('[data-ch-scope-list]')!;
        const search = dialog.querySelector<HTMLInputElement>('[data-ch-scope-search]')!;
        const summary = dialog.querySelector<HTMLElement>('[data-ch-scope-summary]')!;
        const filterHint = dialog.querySelector<HTMLElement>('[data-ch-scope-filter]')!;
        const renderLimit = 200;
        let query = '';

        const selectedLabels = (): Set<string> => {
          const labels = new Set(current);
          for (const id of picked) for (const label of byId.get(id)?.labels ?? []) labels.add(label);
          return labels;
        };
        const update = (): void => {
          const labels = selectedLabels();
          const added = labels.size - current.size;
          const tooLarge = labels.size > MAX_ASSIGNMENT_UNITS;
          confirm.disabled = added === 0 || tooLarge;
          confirm.textContent = tooLarge
            ? `Maximum ${MAX_ASSIGNMENT_UNITS.toLocaleString()} seats`
            : `Add ${added.toLocaleString()} seat${added === 1 ? '' : 's'}`;
          error.hidden = !tooLarge;
          error.textContent = tooLarge
            ? `That would make ${labels.size.toLocaleString()} selected seats. Choose fewer rows or sections.`
            : '';
          summary.textContent = `${picked.size.toLocaleString()} row${picked.size === 1 ? '' : 's'} · ${added.toLocaleString()} seat${added === 1 ? '' : 's'} added`;
        };
        const renderList = (): void => {
          const blocks: string[] = [];
          let totalMatches = 0;
          let rendered = 0;
          groups.forEach(([group, items], groupIndex) => {
            const normalizedGroup = group.toLocaleLowerCase();
            const matches = query
              ? items.filter((item) => `${normalizedGroup} ${item.label.toLocaleLowerCase()}`.includes(query))
              : items;
            if (query && !matches.length) return;
            totalMatches += matches.length;
            const allPicked = items.every((item) => picked.has(item.id));
            const somePicked = !allPicked && items.some((item) => picked.has(item.id));
            const open = Boolean(query) || expanded.has(groupIndex);
            const room = Math.max(0, renderLimit - rendered);
            const visible = open ? matches.slice(0, room) : [];
            rendered += visible.length;
            const seatCount = items.reduce((sum, item) => sum + item.labels.length, 0);
            blocks.push(`<div class="slm-ch-scopegroup">
              <button type="button" class="slm-ch-groupcheck" role="checkbox" aria-checked="${allPicked ? 'true' : somePicked ? 'mixed' : 'false'}"
                aria-label="Select all ${items.length.toLocaleString()} rows in ${esc(group)}" data-ch-scope-group="${groupIndex}">
                <span class="box" aria-hidden="true">✓</span><span>${esc(group)}</span>
                <span class="meta">${items.length.toLocaleString()} rows · ${seatCount.toLocaleString()} seats</span>
              </button>
              <button type="button" class="slm-ch-grouptoggle" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} rows in ${esc(group)}"
                data-ch-scope-toggle="${groupIndex}">${open ? 'Hide' : 'Show'}</button>
            </div>`);
            blocks.push(...visible.map((option) => `<button type="button" class="slm-ch-seatitem" role="checkbox"
              aria-checked="${picked.has(option.id)}" data-ch-scope-id="${esc(option.id)}">
              <span class="box" aria-hidden="true">✓</span><span>${esc(option.label)}</span>
              <span class="meta">${option.labels.length.toLocaleString()} seat${option.labels.length === 1 ? '' : 's'}</span>
            </button>`));
            if (open && matches.length > visible.length) {
              blocks.push(`<p class="slm-ch-scopehint">${(matches.length - visible.length).toLocaleString()} more row${matches.length - visible.length === 1 ? '' : 's'}. Search to narrow the list.</p>`);
            }
          });
          list.innerHTML = blocks.join('')
            || `<div class="slm-ch-scope-empty">No sections or rows match “${esc(query)}”.</div>`;
          filterHint.textContent = query
            ? `Showing ${rendered.toLocaleString()} of ${totalMatches.toLocaleString()} matching rows. Section checkboxes still select every row in that section.`
            : 'Showing section groups. Expand one or search to see rows.';
          list.querySelectorAll<HTMLElement>('[data-ch-scope-group]').forEach((button) => button.addEventListener('click', () => {
            const items = groups[Number(button.dataset.chScopeGroup)]?.[1] ?? [];
            const remove = items.every((item) => picked.has(item.id));
            for (const item of items) remove ? picked.delete(item.id) : picked.add(item.id);
            renderList();
            update();
          }));
          list.querySelectorAll<HTMLElement>('[data-ch-scope-toggle]').forEach((button) => button.addEventListener('click', () => {
            const index = Number(button.dataset.chScopeToggle);
            if (expanded.has(index)) expanded.delete(index);
            else expanded.add(index);
            renderList();
          }));
          list.querySelectorAll<HTMLElement>('[data-ch-scope-id]').forEach((button) => button.addEventListener('click', () => {
            const id = button.dataset.chScopeId!;
            if (picked.has(id)) picked.delete(id);
            else picked.add(id);
            renderList();
            update();
          }));
        };

        search.addEventListener('input', () => {
          query = search.value.trim().toLocaleLowerCase();
          renderList();
          update();
        });
        confirm.addEventListener('click', () => {
          const labels = [...selectedLabels()];
          if (!picked.size || labels.length > MAX_ASSIGNMENT_UNITS) return;
          this.closeDialog();
          this.host.selectByLabels(labels);
        });
        renderList();
        update();
      });
      return;
    }

    const body = [...grouped.entries()].map(([group, items]) => `
      <div class="slm-ch-seatgroup"><span>${esc(group)}</span></div>
      ${items.map((option) => `<button type="button" class="slm-ch-seatitem" role="checkbox"
        aria-checked="false" data-ch-scope-id="${esc(option.id)}">
        <span class="box" aria-hidden="true">✓</span>
        <span>${esc(option.label)}</span>
        <span class="meta">${option.labels.length.toLocaleString()} seat${option.labels.length === 1 ? '' : 's'}</span>
      </button>`).join('')}`).join('');
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Add whole sections</h3>
      <p class="sub">Choose one or more. They are added to the seats already selected on the map.</p>
      <div class="slm-ch-seatlist">${body || `<div class="slm-empty">No sections are available.</div>`}</div>
      <p class="slm-ch-err" data-ch-error hidden></p>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn" data-ch-add-scope disabled>Add seats</button>
      </div>`, (dialog) => {
      const byId = new Map(available.map((option) => [option.id, option]));
      const picked = new Set<string>();
      const current = new Set(this.host.selectionLabels());
      const confirm = dialog.querySelector<HTMLButtonElement>('[data-ch-add-scope]')!;
      const error = dialog.querySelector<HTMLElement>('[data-ch-error]')!;
      const selectedLabels = (): Set<string> => {
        const labels = new Set(current);
        for (const id of picked) for (const label of byId.get(id)?.labels ?? []) labels.add(label);
        return labels;
      };
      const update = (): void => {
        const labels = selectedLabels();
        const added = labels.size - current.size;
        const tooLarge = labels.size > MAX_ASSIGNMENT_UNITS;
        confirm.disabled = added === 0 || tooLarge;
        confirm.textContent = tooLarge
          ? `Maximum ${MAX_ASSIGNMENT_UNITS.toLocaleString()} seats`
          : `Add ${added.toLocaleString()} seat${added === 1 ? '' : 's'}`;
        error.hidden = !tooLarge;
        error.textContent = tooLarge
          ? `That would make ${labels.size.toLocaleString()} selected seats. Choose fewer rows or sections.`
          : '';
      };
      dialog.querySelectorAll<HTMLElement>('[data-ch-scope-id]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.chScopeId!;
          if (picked.has(id)) picked.delete(id);
          else picked.add(id);
          button.setAttribute('aria-checked', String(picked.has(id)));
          update();
        });
      });
      confirm.addEventListener('click', () => {
        const labels = [...selectedLabels()];
        if (!picked.size || labels.length > MAX_ASSIGNMENT_UNITS) return;
        this.closeDialog();
        this.host.selectByLabels(labels);
      });
      update();
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
    else if (state.kind === 'scope') this.renderScopeDialog(state);
    else if (state.kind === 'archive') this.renderArchiveDialog(state);
    else if (state.kind === 'rename') this.renderRenameDialog(state);
    else if (state.kind === 'seatlist') this.renderSeatListDialog();
    else if (state.kind === 'linkCreate') this.renderLinkCreateDialog(state);
    else if (state.kind === 'linkRotate') this.renderLinkRotateDialog(state);
    else if (state.kind === 'linkRevoke') this.renderLinkRevokeDialog(state);
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
          <span class="slm-note" style="margin:0">Letter comes from the name; colour is chosen automatically from the next available palette. Buyers never see either.</span>
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
    // An authoritative result names the channel the SERVER moved seats into.
    // Reading `targetChannelId` off the mode would relabel a completed result
    // if the organizer changed the destination picker before opening Details.
    const targetName = this.nameOf(authoritative?.targetChannelId ?? this.targetChannelId) ?? PUBLIC_CHANNEL_NAME;
    const rows = bucketRows(shown, targetName);
    const mutations = authoritative ? authoritative.applied : mutationCount(buckets);
    const allSkipped = !authoritative && labels.length > 0 && mutations === 0;
    const tooLarge = !authoritative && labels.length > MAX_ASSIGNMENT_UNITS;
    const rowsHtml = bucketRowsHtml(rows);

    const foot = authoritative
      ? `<div class="foot"><button type="button" class="slm-btn" data-ch-close>Done</button></div>`
      : `<div class="foot">
          <button type="button" class="quiet" data-ch-close>Back</button>
          <button type="button" class="slm-btn" data-ch-apply ${allSkipped || tooLarge || state.busy ? 'disabled' : ''}>
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
    const limitNote = tooLarge
      ? `<div class="slm-ch-alert warn" role="alert"><span>ℹ</span><span><b>Choose fewer seats.</b>
          One Apply can cover at most ${MAX_ASSIGNMENT_UNITS.toLocaleString()} seats.</span></div>`
      : '';

    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">${authoritative
        ? `Moved ${authoritative.applied.toLocaleString()} seat${authoritative.applied === 1 ? '' : 's'} to ${esc(targetName)}`
        : `Move ${labels.length.toLocaleString()} selected seat${labels.length === 1 ? '' : 's'} to ${esc(targetName)}`}</h3>
      <p class="sub">${authoritative
        ? 'These are the exact counts the server applied.'
        : 'Every selected seat is in exactly one line below.'}</p>
      ${skippedNote}
      ${limitNote}
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
   * Apply. On success the sheet CLOSES and the staged bar confirms what moved,
   * naming the destination and any skipped seats, with the AUTHORITATIVE server
   * buckets still one Details press away. Leaving the modal up on success made
   * the organizer dismiss a sheet to get back to a map they had just changed.
   * On a stale version the server mutated nothing: keep the selection, shake
   * the bar once, and offer exactly one action — Refresh and review.
   */
  private async apply(): Promise<void> {
    if (!this.dialog || !this.caps.manage) return;
    const { labels } = this.currentPlan();
    if (!labels.length) return;
    if (labels.length > MAX_ASSIGNMENT_UNITS) {
      this.showDialogError(`Choose at most ${MAX_ASSIGNMENT_UNITS.toLocaleString()} seats for one Apply.`);
      return;
    }
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
      await this.refresh({ quiet: true });
      this.closeDialog({ restoreFocus: false });
      this.host.clearSelection();
      this.showApplied(result);
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

  /**
   * The success receipt, now that the review sheet closes on Apply. It names the
   * destination and the seats that could not move, keeps the authoritative
   * buckets reachable through Details, and stays up long enough to be read —
   * 1.2s was tuned for a confirmation the organizer was already looking at.
   */
  private showApplied(result: AssignmentResult): void {
    const targetName = this.nameOf(result.targetChannelId) ?? PUBLIC_CHANNEL_NAME;
    const skipped = result.buckets.skippedHeld.count + result.buckets.skippedBooked.count
      + result.buckets.notFound.count;
    this.setStaged(`<span class="slm-ch-tick" aria-hidden="true">✓</span>
      <span>Assigned <b>${result.applied.toLocaleString()}</b> seat${result.applied === 1 ? '' : 's'} to ${esc(targetName)}
        ${skipped ? ` · ${skipped.toLocaleString()} skipped` : ''}</span>
      <span class="grow"></span>
      <button type="button" class="drop" data-ch-applied-details>Details</button>`, 'done');
    this.stagedEl?.querySelector<HTMLElement>('[data-ch-applied-details]')?.addEventListener('click', () => {
      this.openDialog({ kind: 'review', applied: result });
    });
    this.announce(`Assigned ${result.applied} seat${result.applied === 1 ? '' : 's'} to ${targetName}${skipped ? `; ${skipped} skipped` : ''}.`);
    if (this.stagedDoneTimer) clearTimeout(this.stagedDoneTimer);
    this.stagedDoneTimer = setTimeout(() => this.setStaged(null), 5_000);
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

  /**
   * "Get embed code" — mark the channel as reached through the organizer's own
   * backend. The write itself is `setChannelAccessIntent(…, 'server')`, the same
   * API the old picker called; the difference is that it is now a deliberate
   * action with a consequence the organizer is told about, rather than one of
   * four dropdown values with no observable effect.
   */
  private async chooseWebsiteIntegration(): Promise<void> {
    const channelId = this.detailChannelId;
    if (!channelId) return;
    await this.setAccessIntent('server');
  }

  private async setAccessIntent(accessIntent: ChannelAccessIntent): Promise<void> {
    const channelId = this.detailChannelId;
    if (!channelId || !this.caps.manage) return;
    try {
      await this.host.api.setChannelAccessIntent(this.host.eventKey, channelId, accessIntent);
      await this.refresh();
      if (accessIntent === 'server') {
        this.host.toast('Marked for your website. The embed code is on the Embed page.', 'ok');
      }
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

  // ---- buyer-link dialogs ---------------------------------------------------

  private async reloadLinks(): Promise<void> {
    const channelId = this.detailChannelId;
    if (!channelId) return;
    this.linksState = this.links.length ? this.linksState : 'loading';
    await this.loadLinks(channelId);
    this.paintRail();
  }

  /**
   * The reload EVERY link mutation owes the panel.
   *
   * A create/rotate/revoke changes two things the detail panel renders: the
   * channel's access line (the server sets `access.intent` on create, and clears
   * it when the last live link goes) and the link status list. Both are re-read
   * here and the rail repainted, so the panel the organizer is already looking
   * at is current the moment the mutation lands — no reload, and no dependence
   * on HOW the one-time reveal was dismissed (the button, Escape, or never).
   */
  private async reloadAfterLinkChange(channelId: string): Promise<void> {
    // `refresh` re-reads the links of the OPEN channel as part of its pass, so
    // the common case is one round of reads, not two.
    if (this.detailChannelId === channelId) {
      await this.refresh({ quiet: true });
      return;
    }
    await this.loadLinks(channelId);
    if (this.active) this.paintRail();
  }

  private linkById(linkId: string | undefined): AccessLinkStatusRecord | null {
    return this.links.find((link) => link.id === linkId) ?? null;
  }

  /**
   * Create. The three policy fields carry the owner's defaults and every one of
   * them is editable; the PLATFORM bounds (60s–180d, 1–10 000, 1–100, 20 live
   * links) are the server's to enforce and the server's to explain, so this form
   * checks only that a number is a number and surfaces the server's sentence for
   * everything else.
   */
  private renderLinkCreateDialog(state: DialogState): void {
    const channel = this.list?.channels.find((item) => item.id === state.channelId);
    if (!channel || !this.caps.manage) { this.closeDialog(); return; }
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Create a buyer link for ${esc(channel.name)}</h3>
      <p class="sub">Anyone who opens the link can buy from this channel's allocation — and only from it.
        You'll see the link once, right after you create it.</p>
      <div class="slm-field">
        <label for="slm-ch-lk-label">Label <span style="text-transform:none;font-weight:500">(optional)</span></label>
        <input class="slm-input" id="slm-ch-lk-label" maxlength="80" placeholder="e.g. VIP list Nov 14" />
        <p class="slm-note">So you can tell your links apart later. Buyers never see it.</p>
      </div>
      <div class="slm-field">
        <label for="slm-ch-lk-expiry">Stops working</label>
        <select class="slm-select" id="slm-ch-lk-expiry" data-ch-lk-expiry>
          <option value="event" selected>When the event starts</option>
          <option value="custom">On a date I choose</option>
        </select>
      </div>
      <div class="slm-field" data-ch-lk-when-field hidden>
        <label for="slm-ch-lk-when">Date and time</label>
        <input class="slm-input" type="datetime-local" id="slm-ch-lk-when" />
      </div>
      <div class="slm-field">
        <label for="slm-ch-lk-redemptions">How many people can use it</label>
        <input class="slm-input" type="number" id="slm-ch-lk-redemptions" inputmode="numeric"
          value="${ACCESS_LINK_DEFAULTS.maxRedemptions}" />
        <p class="slm-note">Each buyer who opens the link uses one.</p>
      </div>
      <div class="slm-field">
        <label for="slm-ch-lk-quantity">Seats per buyer</label>
        <input class="slm-input" type="number" id="slm-ch-lk-quantity" inputmode="numeric"
          value="${ACCESS_LINK_DEFAULTS.maxQuantity}" />
      </div>
      <label class="slm-note" style="display:flex;gap:8px;align-items:center;margin:2px 0 6px">
        <input type="checkbox" id="slm-ch-lk-public" />
        Also let this link buy Public sale seats
      </label>
      <p class="slm-ch-err" data-ch-error ${state.error ? '' : 'hidden'}>${esc(state.error ?? '')}</p>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn" data-ch-lk-create>Create link</button>
      </div>`, (dialog) => {
      const expiry = dialog.querySelector<HTMLSelectElement>('[data-ch-lk-expiry]')!;
      const whenField = dialog.querySelector<HTMLElement>('[data-ch-lk-when-field]')!;
      const when = dialog.querySelector<HTMLInputElement>('#slm-ch-lk-when')!;
      expiry.addEventListener('change', () => {
        const custom = expiry.value === 'custom';
        whenField.hidden = !custom;
        if (custom && !when.value) when.value = datetimeLocalValue(Date.now() + 7 * 86_400_000);
      });
      dialog.querySelector('[data-ch-lk-create]')?.addEventListener('click', () => {
        const maxRedemptions = intField(dialog, '#slm-ch-lk-redemptions');
        const maxQuantity = intField(dialog, '#slm-ch-lk-quantity');
        if (maxRedemptions == null || maxQuantity == null) {
          this.showDialogError('Those two settings need to be whole numbers.');
          return;
        }
        let expiresAt: number | undefined;
        if (expiry.value === 'custom') {
          expiresAt = Date.parse(when.value);
          if (!Number.isFinite(expiresAt)) {
            this.showDialogError('Pick the date and time the link should stop working.');
            return;
          }
        }
        void this.createLink(channel.id, {
          label: dialog.querySelector<HTMLInputElement>('#slm-ch-lk-label')?.value.trim() || null,
          includePublic: dialog.querySelector<HTMLInputElement>('#slm-ch-lk-public')?.checked ?? false,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          maxRedemptions,
          maxQuantity,
        });
      });
    });
  }

  private async createLink(
    channelId: string,
    input: {
      label: string | null; includePublic: boolean;
      expiresAt?: number; maxRedemptions: number; maxQuantity: number;
    },
  ): Promise<void> {
    try {
      const reveal = await this.host.api.createAccessLink(this.host.eventKey, channelId, input);
      this.revealLink(reveal, { channelId });
      await this.reloadAfterLinkChange(channelId);
    } catch (err) {
      this.showDialogError(accessLinkErrorCopy(err instanceof ManageApiError ? err : undefined));
      if (!(err instanceof ManageApiError)) this.host.onError(err);
    }
  }

  /**
   * The ONE-TIME reveal.
   *
   * Three things make this unrecoverable rather than merely "not shown twice":
   *
   *   1. `url` is a local const. It is never assigned to a field on this class,
   *      never handed to the host, never put in a `DialogState`.
   *   2. `this.dialog` is cleared FIRST, so `renderDialog()` — the only function
   *      that rebuilds a sheet — has nothing to rebuild this one from.
   *   3. The string exists in exactly one DOM node inside the scrim. Dismissing
   *      the dialog removes the scrim, and the closure goes with it.
   *
   * The server holds only a hash, so even a compromised client cannot ask for it
   * again. Rotation is the recovery path, and the copy says so.
   */
  private revealLink(reveal: AccessLinkReveal, opts: { channelId: string; rotated?: boolean }): void {
    const url = reveal.url;
    this.dialog = null;
    const rotated = opts.rotated
      ? `<div class="slm-ch-alert warn" role="status"><span>⚠</span><span>
          <b>The old link has stopped working.</b> ${reveal.endedSessions
            ? `${reveal.endedSessions.toLocaleString()} buyer${reveal.endedSessions === 1 ? '' : 's'} lost access immediately.`
            : 'Buyers who already came in can finish; every new visit needs this link.'}</span></div>`
      : '';
    const policy = accessLinkPolicyLines(reveal.link)
      .map((row) => `<div class="slm-ch-lkrow"><span class="k">${esc(row.k)}</span>
        <span class="v">${esc(row.v)}</span></div>`).join('');
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Copy this link now</h3>
      <p class="sub">This is the only time SeatLayer can show it. We keep just a fingerprint, so it cannot be
        shown again — if it is lost, rotate the link for a fresh one.</p>
      ${rotated}
      <div class="slm-ch-secret" data-ch-lk-url>${esc(url)}</div>
      <div class="slm-ch-row2" style="margin-top:8px">
        <button type="button" class="slm-btn" data-ch-lk-copy>Copy link</button>
      </div>
      <div class="slm-ch-alert warn" style="margin-top:12px"><span>⚠</span>
        <span>Anyone who opens this link can buy from this allocation. Send it only to the people it is meant
        for — forwarding it hands on the same access, and SeatLayer cannot tell the difference.</span></div>
      <p class="slm-eyebrow" style="margin-top:14px">What this link allows</p>
      ${policy}
      <div class="foot">
        <button type="button" class="slm-btn" data-ch-close data-ch-lk-done>I've copied it</button>
      </div>`, (dialog) => {
      const copy = dialog.querySelector<HTMLElement>('[data-ch-lk-copy]');
      copy?.addEventListener('click', () => {
        const ok = (): void => {
          copy.textContent = 'Copied';
          this.announce('Buyer link copied.');
        };
        const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
        if (clipboard?.writeText) {
          clipboard.writeText(url).then(ok, () => selectSecret(dialog));
          return;
        }
        // No clipboard API (older embeds, insecure context): select the text so
        // the organizer can copy it by hand rather than lose it entirely.
        selectSecret(dialog);
      });
      // Dismissal only dismisses. The mutation that opened this sheet already
      // owns the reload (`reloadAfterLinkChange`), so the panel behind the scrim
      // is current whichever way the organizer leaves — including Escape.
    });
    this.announce('Your buyer link is ready and is shown once.');
  }

  /**
   * Rotate. The organizer must SAY what happens to the buyers already inside —
   * the confirm stays disabled until one of the two choices is picked, because
   * the gentle branch and the destructive branch are both real decisions and the
   * server refuses (422 `end_active_sessions_required`) to guess either.
   */
  private renderLinkRotateDialog(state: DialogState): void {
    const link = this.linkById(state.linkId);
    if (!link || !this.caps.manage) { this.closeDialog(); return; }
    const sessions = link.activeSessions ?? 0;
    const warning = sessions
      ? `<div class="slm-ch-alert warn"><span>⚠</span>
          <span><b>${sessions.toLocaleString()} buyer${sessions === 1 ? '' : 's'}</b> got in with the current link
          and still ${sessions === 1 ? 'has' : 'have'} active access.</span></div>`
      : '';
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Rotate the ${esc(link.label || 'buyer')} link?</h3>
      <p class="sub">The current link stops opening immediately and cannot be restored. You will get a new
        link to copy — shown once.</p>
      ${warning}
      <label class="slm-ch-radio">
        <input type="radio" name="slm-ch-rot" value="keep" data-ch-rot />
        <span><b>Let them finish</b><span class="why">Access already handed out expires on its own; seats in
          checkout are untouched. Every new visit needs the new link.</span></span>
      </label>
      <label class="slm-ch-radio">
        <input type="radio" name="slm-ch-rot" value="end" data-ch-rot />
        <span><b>End their access now</b><span class="why">All access from the old link ends immediately.
          Buyers part-way through choosing seats lose access.</span></span>
      </label>
      <p class="slm-note">Choose one — SeatLayer will not decide this for you.</p>
      <p class="slm-ch-err" data-ch-error ${state.error ? '' : 'hidden'}>${esc(state.error ?? '')}</p>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn" data-ch-lk-rotate disabled>Rotate and copy new link</button>
      </div>`, (dialog) => {
      const confirm = dialog.querySelector<HTMLButtonElement>('[data-ch-lk-rotate]')!;
      dialog.querySelectorAll<HTMLInputElement>('[data-ch-rot]').forEach((radio) => {
        radio.addEventListener('change', () => { confirm.disabled = false; });
      });
      confirm.addEventListener('click', () => {
        const picked = [...dialog.querySelectorAll<HTMLInputElement>('[data-ch-rot]')]
          .find((radio) => radio.checked);
        // Belt and braces: the button is disabled until a choice exists, and a
        // programmatic path still cannot skip the decision.
        if (!picked) {
          this.showDialogError(accessLinkErrorCopy({ code: 'end_active_sessions_required' }));
          return;
        }
        void this.rotateLink(state.channelId!, link.id, picked.value === 'end');
      });
    });
  }

  private async rotateLink(channelId: string, linkId: string, endActiveSessions: boolean): Promise<void> {
    try {
      const reveal = await this.host.api.rotateAccessLink(
        this.host.eventKey, channelId, linkId, endActiveSessions,
      );
      this.revealLink(reveal, { channelId, rotated: true });
      await this.reloadAfterLinkChange(channelId);
    } catch (err) {
      this.showDialogError(accessLinkErrorCopy(err instanceof ManageApiError ? err : undefined));
      if (!(err instanceof ManageApiError)) this.host.onError(err);
    }
  }

  private renderLinkRevokeDialog(state: DialogState): void {
    const link = this.linkById(state.linkId);
    if (!link || !this.caps.manage) { this.closeDialog(); return; }
    const sessions = link.activeSessions ?? 0;
    this.renderScrim(`
      <h3 id="slm-ch-dlg-title">Revoke the ${esc(link.label || 'buyer')} link?</h3>
      <p class="sub">It stops opening immediately and cannot be restored — there is no undo, and no way to
        bring the same URL back. Seats already bought through it keep their sale.</p>
      ${sessions ? `<label class="slm-ch-radio">
        <input type="checkbox" data-ch-lk-endsessions />
        <span><b>Also end access for the ${sessions.toLocaleString()}
          buyer${sessions === 1 ? '' : 's'} already inside</b><span class="why">Leave this off and they can
          finish what they started; new visits are refused either way.</span></span>
      </label>` : ''}
      <p class="slm-ch-err" data-ch-error ${state.error ? '' : 'hidden'}>${esc(state.error ?? '')}</p>
      <div class="foot">
        <button type="button" class="quiet" data-ch-close>Cancel</button>
        <button type="button" class="slm-btn danger" data-ch-lk-revoke>Revoke link</button>
      </div>`, (dialog) => {
      dialog.querySelector('[data-ch-lk-revoke]')?.addEventListener('click', () => {
        const end = dialog.querySelector<HTMLInputElement>('[data-ch-lk-endsessions]')?.checked ?? false;
        void this.revokeLink(state.channelId!, link.id, end);
      });
    });
  }

  private async revokeLink(channelId: string, linkId: string, endActiveSessions: boolean): Promise<void> {
    try {
      const res = await this.host.api.revokeAccessLink(
        this.host.eventKey, channelId, linkId, endActiveSessions,
      );
      this.closeDialog();
      await this.reloadAfterLinkChange(channelId);
      this.host.toast(res.endedSessions
        ? `Link revoked. ${res.endedSessions.toLocaleString()} buyer${res.endedSessions === 1 ? '' : 's'} lost access.`
        : 'Link revoked. It no longer opens for anyone.', 'ok');
    } catch (err) {
      this.showDialogError(accessLinkErrorCopy(err instanceof ManageApiError ? err : undefined));
      if (!(err instanceof ManageApiError)) this.host.onError(err);
    }
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
