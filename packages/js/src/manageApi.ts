/**
 * Organizer manage-surface client for workers/api (the `/v1/events/:key/*`
 * inventory routes + the public realtime channel). Companion to api.ts (the
 * buyer `/pub/*` client) — kept separate because the manage surface is
 * token-authed (Bearer) and cross-origin from the CMS:
 *
 *   - Writes + reports send `Authorization: Bearer <token>` where the token is
 *     a short-lived, event-scoped organizer manage token (`mse_…`, minted by
 *     NestJS) OR a tenant secret key (`sk_…`). Both are accepted by the worker's
 *     `eitherAuth` on block / unblock / unblock-all / unbook / hold-ttl / report
 *     / log. The Authorization header also exempts the call from the worker's
 *     cookie-CSRF gate, so no extra client header is needed.
 *   - `credentials: 'omit'` — there is no session cookie; the CMS runs
 *     cross-origin. The worker's credentialed CORS still echoes the CMS origin.
 *   - `/pub/events/:key/chart` stays public: geometry is the same map buyers
 *     see. The seat STATE reads are not. `/pub/.../objects` and an unticketed
 *     `/pub/.../subscribe` both answer with the BUYER projection, which shows
 *     inventory the caller may not buy as a neutral `blocked` — so an organizer
 *     reading them sees its own channel allocations as blocked seats. Both now
 *     go through the token: `/v1/events/:key/objects` for the snapshot, and a
 *     `/v1/events/:key/subscribe-tickets` mint for the socket's scope.
 *
 * `box-book` is intentionally omitted for M1 (box office ships in M2, and the
 * route is still session-only server-side).
 */
import type { AvailabilityRule, ChartDoc } from '@seatlayer/core';
import type {
  AccessLinkRecord,
  AccessLinkReveal,
  AccessLinkStatusRecord,
  AssignmentResult,
  ChannelAccessIntent,
  ChannelListResult,
  ChannelRecord,
} from './channelPlan';

export type { AvailabilityRule } from '@seatlayer/core';

/** One page of the organizer-only label → channel projection. */
export interface ChannelAllocationPage {
  assignmentVersion: number;
  allocations: Array<{ label: string; channelId: string }>;
  nextAfterLabel: string | null;
}

export interface ChannelAuditEntry {
  id: number;
  at: number;
  actor: string | null;
  action: string;
  channelId: string | null;
  assignmentVersion: number;
  before: unknown;
  after: unknown;
  reason: string | null;
}

export interface ChannelAuditPage {
  entries: ChannelAuditEntry[];
  nextBefore: number | null;
}

/**
 * Buyer projection for a preview audience — the same scoped server view the
 * buyer SDK receives. When an audience cannot be previewed (a paused or
 * archived channel), the server answers `{available:false, unavailable:[…]}`
 * and the UI shows the real paused/unavailable landing state instead of
 * rendering those seats as eligible.
 *
 * Fields stay optional: a worker that predates the hardening merge 404s here,
 * and Channels mode says the preview needs a newer server rather than faking a
 * projection client-side.
 */
export interface ChannelPreviewProjection {
  available?: boolean;
  unavailable?: Array<{ channelId: string; state: 'paused' | 'archived' | string }>;
  channelIds?: string[];
  includePublic?: boolean;
  /** Labels this audience may buy. Everything else renders as ONE neutral
   *  unavailable state so preview never leaks which channel holds a seat. */
  eligible?: string[];
  counts?: { eligible?: number; free?: number; held?: number; booked?: number };
}

export class ManageApiError extends Error {
  status: number;
  code?: string;
  /** Present when a block/unbook 409s because seats were just taken. */
  conflicts?: { label: string; reason?: string }[];
  /**
   * Structured refusal detail. The channel routes use it for the two 409s a UI
   * must render rather than merely report: `channel_archive_blocked_by_holds`
   * carries {activeHolds, heldUnits, latestHoldExpiresAt, retryAfterMs}, and
   * `channel_assignment_conflict` carries the current assignmentVersion.
   */
  details?: Record<string, unknown>;
  /**
   * The server's own human sentence, when it sent one. `message` is the machine
   * code (that is what `error` carries), so a UI that wants to state a PLATFORM
   * RULE — "redemptions must be between 1 and 10 000" — reads this instead of
   * re-encoding the bound locally and risking disagreement with the server.
   */
  serverMessage?: string;

  constructor(
    status: number,
    message: string,
    code?: string,
    conflicts?: { label: string; reason?: string }[],
    details?: Record<string, unknown>,
    serverMessage?: string,
  ) {
    super(message);
    this.name = 'ManageApiError';
    this.status = status;
    this.code = code;
    this.conflicts = conflicts;
    this.details = details;
    this.serverMessage = serverMessage;
  }
}

export interface ReportByStatus {
  free: number;
  held: number;
  booked: number;
  not_for_sale: number;
}

export interface ReportCategoryRow {
  category: string;
  total: number;
  free: number;
  held: number;
  booked: number;
  not_for_sale: number;
  /** Exact sum of booked unit_price snapshots, in major currency units. */
  bookedRevenue: number;
}

export interface ReportCategoryMeta {
  key: string;
  label: string;
  color: string;
  price: number;
}

export interface ReportResult {
  report: { byStatus: ReportByStatus; byCategory: ReportCategoryRow[]; bySection?: ControlRoomSectionMetric[] };
  event: { key: string; name: string; seatTotal: number; currency?: string };
  categories: ReportCategoryMeta[];
}

export interface ControlRoomSectionMetric {
  sectionId: string;
  sectionLabel: string;
  zoneId: string | null;
  total: number;
  free: number;
  held: number;
  booked: number;
  not_for_sale: number;
  bookedRevenue: number;
}

/** Recent seat-state change safe for an event:view control-room grant. Full
 * audit references remain available only through the event:reports log API. */
export interface ControlRoomActivityEntry {
  id: number;
  at: number;
  action: string;
  labels: string[];
}

export interface ControlRoomSnapshot {
  version: number;
  currency: string;
  totals: { free: number; held: number; booked: number; blocked: number };
  revenue: { gross: number; bySection: ControlRoomSectionMetric[] };
  velocity: {
    windowMinutes: number;
    bySection: Array<{
      sectionId: string;
      netBooked: number;
      grossRevenue: number;
      previousNetBooked: number;
      trend: 'rising' | 'steady' | 'cooling';
    }>;
  };
  presence: { shoppingSessions: number; activeHolds: number };
  /** Present on workers that support reload-safe activity hydration. */
  activity?: ControlRoomActivityEntry[];
  event: { key: string; name: string; seatTotal: number; currency?: string };
}

export interface LogEntry {
  id: number;
  at: number;
  action: string;
  labels: string[];
  ref: string | null;
}

export interface LogPage {
  entries: LogEntry[];
  nextBefore: number | null;
}

/**
 * A one-use WebSocket subscribe ticket. `protocols` is exactly what to hand
 * `new WebSocket(url, protocols)` — the ticket rides in `Sec-WebSocket-Protocol`
 * because a browser socket cannot carry an Authorization header and a bearer
 * must never travel in a URL.
 */
export interface SubscribeTicket {
  ticket: string;
  expiresAt: number;
  protocol: string;
  protocols: string[];
}

export interface PubObjectsResult {
  /** Every non-free seat's status keyed by label (free seats omitted). */
  seats: Record<string, string>;
  hidden?: string[];
  closed?: string[];
  updatedAt: number;
}

export interface PubChartResult {
  event: {
    key: string;
    name: string;
    status?: string;
    venue?: string | null;
    startsAt?: number | null;
    currency?: string;
    mode?: string;
  };
  doc: ChartDoc;
}

async function parse<T>(res: Response): Promise<T> {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = data as {
      error?: string;
      code?: string;
      conflicts?: { label: string; reason?: string }[];
      details?: Record<string, unknown>;
      message?: string;
    } | null;
    throw new ManageApiError(
      res.status,
      err?.error ?? `request_failed_${res.status}`,
      err?.code,
      err?.conflicts,
      err?.details,
      typeof err?.message === 'string' ? err.message : undefined,
    );
  }
  return data as T;
}

/**
 * Bound to one apiBase + one event-scoped token. Rebuild (or `setToken`) when a
 * token is re-minted on 401.
 */
export class ManageApi {
  private base: string;
  private token: string;

  constructor(apiBase: string, token: string) {
    this.base = apiBase.replace(/\/+$/, '');
    this.token = token;
  }

  /** Swap the Bearer token in place (SeatManager re-mints on 401). */
  setToken(token: string): void {
    this.token = token;
  }

  private auth<T>(
    path: string,
    init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    return fetch(`${this.base}${path}`, { method, headers, body, credentials: 'omit' }).then((r) => parse<T>(r));
  }

  private pub<T>(path: string): Promise<T> {
    return fetch(`${this.base}${path}`, { credentials: 'omit' }).then((r) => parse<T>(r));
  }

  // ---- realtime read ----

  /** The chart geometry. Genuinely public — it is the same map buyers see. */
  chart(key: string): Promise<PubChartResult> {
    return this.pub(`/pub/events/${encodeURIComponent(key)}/chart`);
  }

  /**
   * The ORGANIZER's seat map: physical state, token-authed.
   *
   * This used to read `/pub/events/:key/objects` with no credential, which
   * answers with the BUYER projection — every unit the caller may not buy
   * collapses to a neutral `blocked`. An anonymous caller may buy only Public
   * sale inventory, so the cockpit rendered every channel-allocated seat as
   * blocked and then computed its KPIs, sell-through and (worse) its
   * block/unblock target sets from that. `/v1/events/:key/objects` returns the
   * unprojected snapshot the control-room read model already trusts.
   */
  objects(key: string): Promise<PubObjectsResult> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/objects`);
  }

  /**
   * Exchange the manage token for a one-use organizer socket ticket.
   *
   * A browser `WebSocket` cannot send an Authorization header, so the socket's
   * scope is established here, over ordinary HTTPS. Without it the DO treats a
   * manager socket as an anonymous public buyer and projects its deltas — so a
   * hold inside a private allocation is structurally suppressed and the map
   * drifts away from the truth `objects()` just established.
   *
   * Tickets are single-redemption and expire in ~30s: mint one per connect.
   */
  subscribeTicket(key: string): Promise<SubscribeTicket> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/subscribe-tickets`, { method: 'POST' });
  }

  socketUrl(key: string): string {
    return `${this.base.replace(/^http/, 'ws')}/pub/events/${encodeURIComponent(key)}/subscribe?surface=manager`;
  }

  // ---- inventory writes (token) ----

  /** Take FREE seats off sale in one batched call. Optional `releaseAt` (epoch
   *  ms, future) auto-returns them to sale; `reason` tags the block (M3 uses it).
   *  Throws ManageApiError 409 (conflicts) if any seat was just taken. */
  block(
    key: string,
    labels: string[],
    opts: { releaseAt?: number; reason?: string } = {},
  ): Promise<{ ok: true; blocked: string[] }> {
    const body: Record<string, unknown> = { labels };
    if (typeof opts.releaseAt === 'number') body.releaseAt = opts.releaseAt;
    if (opts.reason) body.reason = opts.reason;
    return this.auth(`/v1/events/${encodeURIComponent(key)}/block`, { method: 'POST', body });
  }

  /** Return specific blocked seats to sale (one batched call). */
  unblock(key: string, labels: string[]): Promise<{ ok: true; unblocked: string[] }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/unblock`, { method: 'POST', body: { labels } });
  }

  /** Return every blocked seat to sale; resolves with the freed count. */
  unblockAll(key: string): Promise<{ ok: true; freed: number }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/unblock-all`, { method: 'POST' });
  }

  /** Cancel bookings — return BOOKED seats to free (credit not refunded).
   *  Guarded by the original booking reference. */
  unbook(key: string, labels: string[], bookingRef: string): Promise<{ ok: true; unbooked: string[] }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/unbook`, { method: 'POST', body: { labels, bookingRef } });
  }

  /** Set (ms, clamped 1–60 min server-side) or clear (null) the hold TTL. */
  setHoldTtl(key: string, holdTtlMs: number | null): Promise<{ ok: true; holdTtlMs: number | null }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/hold-ttl`, { method: 'POST', body: { holdTtlMs } });
  }

  // ---- availability windows (token) ----

  /** The organizer's current per section/zone availability windows (needs
   *  `event:view`). Ids absent from `rules` are open / on sale. */
  availability(key: string): Promise<{ rules: Record<string, AvailabilityRule> }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/availability`);
  }

  /** Replace the availability windows for a set of section/zone ids (needs
   *  `event:block`). Ids absent from `rules` become open / on sale; a zone rule
   *  cascades to its sections. The worker derives each id's seat labels, so
   *  `labels` on the sent rules is best-effort. Resolves with the authoritative
   *  effective `hidden` set (a due rule may fire at once) and the server-cleaned
   *  `rules` map (fired timed/threshold windows dropped). */
  setAvailability(
    key: string,
    rules: Record<string, AvailabilityRule>,
  ): Promise<{ ok: true; hidden: string[]; rules: Record<string, AvailabilityRule> }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/availability`, { method: 'POST', body: { rules } });
  }

  // ---- sales channels (token, capability-gated) ----
  // Reads need `event:channels:view`, mutations `event:channels:manage`.
  // `event:block` grants NEITHER (spec §10), so a Block-only cockpit token gets
  // a 403 here and Channels mode never renders.

  /** Allocation list with exact per-channel counts. `includeArchived` adds the
   *  read-only archived rows behind the rail's "Show archived" control. */
  channels(key: string, opts: { includeArchived?: boolean } = {}): Promise<ChannelListResult> {
    const qs = opts.includeArchived ? '?includeArchived=1' : '';
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels${qs}`);
  }

  /** One page of the label → channel map that paints the allocation overlay.
   *  Paged by label; follow `nextAfterLabel` until it is null. */
  channelAllocation(
    key: string,
    opts: { afterLabel?: string; limit?: number } = {},
  ): Promise<ChannelAllocationPage> {
    const params = new URLSearchParams();
    if (opts.afterLabel) params.set('afterLabel', opts.afterLabel);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels/allocation${qs ? `?${qs}` : ''}`);
  }

  channelAudit(key: string, opts: { limit?: number; before?: number } = {}): Promise<ChannelAuditPage> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.before != null) params.set('before', String(opts.before));
    const qs = params.toString();
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels/audit${qs ? `?${qs}` : ''}`);
  }

  createChannel(
    key: string,
    input: { name: string; color?: string | null; marker?: string | null; externalRef?: string | null },
  ): Promise<{ ok: true; channel: ChannelRecord }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels`, { method: 'POST', body: input });
  }

  renameChannel(key: string, channelId: string, name: string): Promise<{ ok: true; channel: ChannelRecord }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH', body: { name },
    });
  }

  setChannelPaused(key: string, channelId: string, paused: boolean): Promise<{ ok: true; channel: ChannelRecord }> {
    const path = paused ? 'pause' : 'unpause';
    return this.auth(
      `/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}/${path}`,
      { method: 'POST', body: {} },
    );
  }

  /** Archive with a mandatory destination for the remaining allocation.
   *  Throws ManageApiError 409 `channel_archive_blocked_by_holds` while any hold
   *  is live; `err.details` carries the exact counts + retry window. */
  archiveChannel(
    key: string,
    channelId: string,
    destination: string | null,
  ): Promise<{ ok: true; channel: ChannelRecord; assignmentVersion: number; moved: number }> {
    return this.auth(
      `/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}/archive`,
      { method: 'POST', body: { destination } },
    );
  }

  /**
   * Versioned Apply. A stale `assignmentVersion` mutates NOTHING and throws
   * ManageApiError 409 `channel_assignment_conflict` — the caller keeps its
   * selection and offers "Refresh and review". There is no dry-run: the review
   * sheet previews locally, this call returns the authoritative buckets.
   */
  applyChannelAssignment(
    key: string,
    input: { targetChannelId: string | null; labels: string[]; assignmentVersion: number },
  ): Promise<AssignmentResult> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels/assignments`, {
      method: 'POST',
      body: {
        targetChannelId: input.targetChannelId || null,
        labels: input.labels,
        assignmentVersion: input.assignmentVersion,
      },
    });
  }

  /**
   * Read-only buyer projection for an audience (§8.6) — the SAME scoped server
   * view the buyer SDK receives, never a local approximation.
   *
   * Ships on the access-hardening branch. Older workers 404/405 here; callers
   * MUST feature-detect and quietly say the preview needs a newer server rather
   * than faking a projection client-side.
   */
  channelPreview(
    key: string,
    channelIds: string[],
    opts: { includePublic?: boolean } = {},
  ): Promise<ChannelPreviewProjection> {
    const params = new URLSearchParams();
    if (channelIds.length) params.set('channelIds', channelIds.join(','));
    if (opts.includePublic != null) params.set('includePublic', opts.includePublic ? '1' : '0');
    const qs = params.toString();
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels/preview${qs ? `?${qs}` : ''}`);
  }

  /**
   * Choose which sale route this channel opens.
   *
   * Since the server's 2026-08-06 change this is AUTHORIZATION, not a label:
   * exactly one of the four routes may mint buyer access for the channel and the
   * other three refuse with 409 `channel_access_intent_forbids`. The default is
   * `none`, which refuses all four — so a route has to be declared before any
   * buyer-facing action on the channel can succeed.
   *
   * Switching the route while buyers are already inside the current one is
   * refused with 409 `channel_intent_switch_blocked`, whose `details` name what
   * is live (`liveAccessLinks`, `activeSessions`). Retry with
   * `acknowledgeLiveAccess: true`: hosted links on the channel are revoked,
   * while sessions already minted keep their holds and drain on their own.
   * `intentSwitch` is present on the response ONLY when the switch disturbed
   * something, so the ordinary case stays the two-key body it has always been.
   */
  setChannelAccessIntent(
    key: string,
    channelId: string,
    accessIntent: ChannelAccessIntent,
    opts: { acknowledgeLiveAccess?: boolean; reason?: string } = {},
  ): Promise<{
    ok: true;
    channel: ChannelRecord;
    intentSwitch?: { closedLinks: number; keptSessions: number };
  }> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH',
      body: {
        accessIntent,
        ...(opts.acknowledgeLiveAccess ? { acknowledgeLiveAccess: true } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    });
  }

  // ---- hosted access links (M8) ----

  /**
   * Mint a hosted access link. The 201 is the ONE and ONLY time `url` and
   * `capability` exist outside the buyer's browser — SeatLayer keeps a hash, so
   * there is no route, cache, or support escalation that can produce this string
   * again. Callers must reveal it immediately and then let it go.
   *
   * Every omitted field takes the server's default: expiry = when the event
   * starts, 100 redemptions, 4 seats per buyer, this channel's allocation only.
   * Platform bounds are enforced server-side and reported as 422 with the rule
   * spelled out in `ManageApiError.serverMessage`.
   *
   * NOT a side effect any more. This used to SET the channel's access intent to
   * `hosted_link`; since 2026-08-06 it REQUIRES it, and a channel declaring any
   * other route refuses with 409 `channel_access_intent_forbids`. Callers must
   * declare the route first — `ChannelsMode` does exactly that before it
   * creates, so a first buyer link on a fresh channel is still one gesture.
   */
  createAccessLink(
    key: string,
    channelId: string,
    input: {
      label?: string | null;
      /** Absolute epoch ms. Omit for "when the event starts". */
      expiresAt?: number;
      maxRedemptions?: number;
      maxQuantity?: number;
      includePublic?: boolean;
    } = {},
  ): Promise<AccessLinkReveal> {
    return this.auth(
      `/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}/access-links`,
      { method: 'POST', body: input },
    );
  }

  /** Status only — label, expiry, redemptions, per-buyer cap, lineage, and the
   *  live session count. Never the url, never the capability. Needs `:view`. */
  accessLinks(key: string, channelId: string): Promise<{ links: AccessLinkStatusRecord[] }> {
    return this.auth(
      `/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}/access-links`,
    );
  }

  /**
   * Rotate — the ONLY recovery for a link nobody kept. The old URL stops opening
   * immediately and the response is a fresh one-time reveal.
   *
   * `endActiveSessions` is REQUIRED, not defaulted: the organizer must say
   * whether buyers already inside finish their checkout or lose access now. The
   * server answers 422 `end_active_sessions_required` if it is omitted, and that
   * refusal is correct — a UI must not pick either branch on their behalf.
   */
  rotateAccessLink(
    key: string,
    channelId: string,
    linkId: string,
    endActiveSessions: boolean,
  ): Promise<AccessLinkReveal & { previous: AccessLinkRecord; endedSessions: number }> {
    return this.auth(
      `/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}`
      + `/access-links/${encodeURIComponent(linkId)}/rotate`,
      { method: 'POST', body: { endActiveSessions } },
    );
  }

  /** Revoke. The link stops opening immediately; `endActiveSessions` decides
   *  whether the buyers already inside keep their sessions. */
  revokeAccessLink(
    key: string,
    channelId: string,
    linkId: string,
    endActiveSessions = false,
  ): Promise<{ ok: true; link: AccessLinkRecord; endedSessions: number }> {
    const qs = endActiveSessions ? '?endActiveSessions=1' : '';
    return this.auth(
      `/v1/events/${encodeURIComponent(key)}/channels/${encodeURIComponent(channelId)}`
      + `/access-links/${encodeURIComponent(linkId)}${qs}`,
      { method: 'DELETE' },
    );
  }

  // ---- reports (token) ----

  report(key: string): Promise<ReportResult> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/report`);
  }

  controlRoom(key: string, windowMinutes = 15): Promise<ControlRoomSnapshot> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/control-room?window=${windowMinutes}`);
  }

  log(key: string, opts: { limit?: number; before?: number } = {}): Promise<LogPage> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.before != null) params.set('before', String(opts.before));
    const qs = params.toString();
    return this.auth(`/v1/events/${encodeURIComponent(key)}/log${qs ? `?${qs}` : ''}`);
  }

  /** CSV report as a Blob (Bearer auth can't ride a plain <a href>). Host builds
   *  an object URL for download. */
  async reportCsv(key: string): Promise<Blob> {
    const res = await fetch(`${this.base}/v1/events/${encodeURIComponent(key)}/report.csv`, {
      headers: { Authorization: `Bearer ${this.token}` },
      credentials: 'omit',
    });
    if (!res.ok) throw new ManageApiError(res.status, `request_failed_${res.status}`);
    return res.blob();
  }
}
