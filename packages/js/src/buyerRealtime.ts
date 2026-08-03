/**
 * BuyerRealtimeClient — the client half of `docs/realtime-protocol-2026-08-01.md`.
 *
 * Why this exists as a separate socket rather than inside PickerController:
 * a private scope authenticates with a one-use **subscribe ticket** carried in
 * `Sec-WebSocket-Protocol`, and a browser can only set that at construction —
 * `new WebSocket(url, protocols)`. The controller's socket is built from a URL
 * alone (`PickerTransport.socketUrl`), and a bearer must never travel in a URL
 * because URLs are routinely logged. So an access-scoped picker asks the
 * transport for an empty `socketUrl()` (the controller then skips its own
 * connection entirely) and this client owns the wire instead.
 *
 * A tokenless public picker never reaches this file. It keeps the controller's
 * original socket, offers no subprotocol, and therefore receives byte-for-byte
 * the frames it received before this module existed (protocol doc §1).
 *
 * What it implements:
 *  - protocol negotiation: offer `seatlayer.v1`, believe the 101 echo, and fall
 *    back to legacy frame handling when the server (or a proxy) does not echo;
 *  - the ticket exchange, one mint per connection attempt, ticket in the
 *    subprotocol list and never in the URL;
 *  - compact `{default, exceptions}` snapshot reconstruction;
 *  - `sv.<n>` resume, handling BOTH outcomes (a `resumed` delta or a full
 *    snapshot) on every reconnect;
 *  - close code 4401 as a typed access-revoked state, never a reconnect loop;
 *  - liveness by ping/pong only. Silence is normal and carries no information
 *    (protocol doc §5) — a quiet socket is never treated as a dead one.
 */
import type { BuyerAccessUnavailableEvent } from './buyerAccess';

/** The projected status of one unit, as the server words it on the wire. */
export type WireStatus = string;

/** A scope's projection: one default plus the units that differ from it. */
export interface Projection {
  default: WireStatus;
  exceptions: Record<string, WireStatus>;
}

export interface StatusChange {
  label: string;
  status: WireStatus;
}

/** Where reconstructed inventory goes. Implemented over PickerController. */
export interface RealtimeSink {
  /** Apply a batch of label→status changes. Implementations must paint this as
   *  ONE pass, not one pass per label (motion system §4 rule 2). */
  applyStatuses(changes: StatusChange[]): void;
  /** Re-pull authoritative state over the scoped HTTP route. Used when a frame
   *  cannot be diffed against what we hold (first snapshot, or the scope's
   *  default itself changed, which redefines every unit we were never told
   *  about). */
  resync(): void | Promise<void>;
  /** Section availability changed (channel-agnostic; identical for every scope). */
  onSections?(hidden: string[], closed: string[]): void;
  /** Scope-projected presence counters. */
  onPresence?(counts: { shoppingSessions: number; activeHolds: number }): void;
}

export interface SubscribeTicket {
  ticket?: string;
  /** Exactly what to hand `new WebSocket(url, protocols)`, per protocol doc §3. */
  protocols?: string[];
}

export interface BuyerRealtimeOptions {
  /** The subscribe URL. Must never carry a credential — asserted below. */
  url: string;
  sink: RealtimeSink;
  /** Mint a one-use ticket for THIS connection attempt. Returns null for the
   *  anonymous public case (no ticket needed). Throwing stops the client. */
  mintTicket?: () => Promise<SubscribeTicket | null>;
  /** Typed access states. 4401 arrives here as `revoked`. */
  onAccessUnavailable?: (event: BuyerAccessUnavailableEvent) => void;
  /** Test seam. Defaults to the global WebSocket. */
  socketFactory?: (url: string, protocols: string[]) => WebSocket;
  /** Test seam for the keepalive/backoff timers. */
  now?: () => number;
}

export const SEATLAYER_V1 = 'seatlayer.v1';
/**
 * Join separator for the section-visibility dedupe keys. A NUL can never occur
 * in a section id, so two different arrays can never collide on one key. It is
 * written as an escape deliberately: a literal NUL byte in the source made the
 * whole file read as binary to grep, diff, and review tooling.
 */
const SEP = '\u0000';

/** Protocol doc §3: revocation closes the socket with this code. */
export const CLOSE_ACCESS_REVOKED = 4401;

const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const PONG_GRACE_MS = 10_000;
/** Only armed when we offered a resume; the server always answers a resume. */
const RESUME_ANSWER_GRACE_MS = 5_000;

/**
 * Turn a snapshot frame into a projection. Handles both wire forms: the v1
 * compact frame states its `default` and lists only the exceptions; the legacy
 * verbose frame lists every non-free unit, which is the same thing with an
 * implicit default of `free`.
 */
export function projectionFromSnapshot(frame: {
  default?: unknown;
  seats?: unknown;
}): Projection {
  const fallback = typeof frame.default === 'string' ? frame.default : 'free';
  const exceptions: Record<string, WireStatus> = {};
  if (frame.seats && typeof frame.seats === 'object') {
    for (const [label, status] of Object.entries(frame.seats as Record<string, unknown>)) {
      if (typeof status === 'string' && status !== fallback) exceptions[label] = status;
    }
  }
  return { default: fallback, exceptions };
}

/**
 * The changes needed to move a renderer from `prev` to `next`.
 *
 * Returns null when the two projections have different defaults: the default
 * describes every unit the frame does NOT name, and the client does not hold
 * that universe, so the move cannot be expressed as a bounded diff. The caller
 * resyncs over HTTP instead — correct, and rare (it means a channel pause or an
 * allocation change moved the whole scope).
 */
export function diffProjections(prev: Projection | null, next: Projection): StatusChange[] | null {
  if (!prev || prev.default !== next.default) return null;
  const changes: StatusChange[] = [];
  for (const [label, status] of Object.entries(next.exceptions)) {
    if (prev.exceptions[label] !== status) changes.push({ label, status });
  }
  for (const label of Object.keys(prev.exceptions)) {
    if (!(label in next.exceptions)) changes.push({ label, status: next.default });
  }
  return changes;
}

/** Fold a delta batch into a projection (an exception equal to the default
 *  stops being an exception, so the model cannot grow without bound). */
export function applyChanges(projection: Projection, changes: StatusChange[]): void {
  for (const change of changes) {
    if (change.status === projection.default) delete projection.exceptions[change.label];
    else projection.exceptions[change.label] = change.status;
  }
}

/** Belt and braces for the "no bearer in a URL" rule — cheap, and it turns a
 *  future refactor that reintroduces one into a thrown error, not a silent leak. */
export function assertCredentialFreeUrl(url: string): void {
  if (/(?:^|[?&#])(?:token|access_token|bearer|authorization|ticket|tkt|bse)=/i.test(url)) {
    throw new Error('seatlayer: refusing to open a socket with a credential in the URL');
  }
  if (/\bbse_[A-Za-z0-9._-]+/.test(url)) {
    throw new Error('seatlayer: refusing to open a socket with a credential in the URL');
  }
}

export class BuyerRealtimeClient {
  private readonly opts: BuyerRealtimeOptions;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Our model of this scope's projection. Null until the first snapshot. */
  private projection: Projection | null = null;
  /** Last `snapshotVersion` seen on any frame that carried one — the resume point. */
  private version: number | null = null;
  /** True once the 101 echoed `seatlayer.v1`. */
  private v1 = false;
  /** Set when we offered v1 and the handshake came back without it — a proxy
   *  most likely stripped the header, so the next attempt selects the v1 frame
   *  format with the `?pv=1` marker instead (protocol doc §1). The marker
   *  selects a format and can never carry a credential or widen a scope. */
  private useQueryMarker = false;
  private hidden: string | null = null;
  private closedSections: string | null = null;

  constructor(options: BuyerRealtimeOptions) {
    this.opts = options;
    assertCredentialFreeUrl(options.url);
  }

  /** Negotiated protocol, for tests and diagnostics. */
  get protocol(): 'v1' | 'legacy' | null {
    return this.ws ? (this.v1 ? 'v1' : 'legacy') : null;
  }

  get snapshotVersion(): number | null {
    return this.version;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  /** Stop for good (destroy, or a revocation). Safe to call twice. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  /** Restart after the host re-authorized a revoked buyer (`refreshAccess()`). */
  restart(): void {
    this.stop();
    this.projection = null;
    this.version = null;
    this.attempt = 0;
    this.start();
  }

  // ---- connection -----------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let protocols: string[] = [SEATLAYER_V1];
    if (this.opts.mintTicket) {
      let minted: SubscribeTicket | null;
      try {
        // One mint per connection attempt, including every reconnect. Tickets
        // are TTL ≤ 30s and single-redemption, so reusing one cannot work.
        minted = await this.opts.mintTicket();
      } catch (err) {
        // The mint is an ordinary scoped HTTP call: the transport has already
        // classified and reported any access failure. A transport-level failure
        // is transient, so back off rather than give up.
        this.reportIfAccessError(err);
        this.scheduleReconnect();
        return;
      }
      if (this.stopped) return;
      if (minted?.protocols?.length) {
        protocols = [...minted.protocols];
        if (!protocols.includes(SEATLAYER_V1)) protocols.unshift(SEATLAYER_V1);
      } else if (minted?.ticket) {
        protocols = [SEATLAYER_V1, `tkt.${minted.ticket}`];
      }
    }

    // Resume from the last version we actually saw. Both outcomes — a `resumed`
    // delta or a full snapshot — are handled in onmessage.
    const offeredResume = this.version !== null;
    if (offeredResume) protocols.push(`sv.${this.version}`);

    const url = this.useQueryMarker
      ? `${this.opts.url}${this.opts.url.includes('?') ? '&' : '?'}pv=1`
      : this.opts.url;
    assertCredentialFreeUrl(url);

    let ws: WebSocket;
    try {
      const make = this.opts.socketFactory ?? ((u: string, p: string[]) => new WebSocket(u, p));
      ws = make(url, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.v1 = ws.protocol === SEATLAYER_V1;
      // We asked for v1 and the server did not echo it. Either it is a
      // pre-M5 server (legacy frames are correct and byte-compatible) or a
      // proxy ate the header — the next attempt tries the query marker.
      if (!this.v1) this.useQueryMarker = true;
      this.startKeepalive(ws);
      if (offeredResume) {
        // The server always answers a resume with a delta or a snapshot. If
        // neither lands, fall back to authoritative HTTP rather than sit on a
        // possibly stale map. This timer is NOT a liveness check — ordinary
        // silence on a live socket never triggers it.
        this.resumeTimer = setTimeout(() => {
          this.resumeTimer = null;
          void this.opts.sink.resync();
        }, RESUME_ANSWER_GRACE_MS);
      } else {
        // Parity with the controller's own socket: pull authoritative state on
        // every fresh connection.
        void this.opts.sink.resync();
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      this.handleFrame(parsed as Record<string, unknown>);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (event?.code === CLOSE_ACCESS_REVOKED) {
        // Retrying with the same credential is guaranteed to fail, so this is
        // a typed terminal state, not a reconnect loop (protocol doc §3).
        this.stopped = true;
        this.opts.onAccessUnavailable?.({
          reason: 'revoked',
          code: 'access_revoked',
          retryable: false,
        });
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose drives the reconnect */
      }
    };
  }

  private handleFrame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : '';

    // A frame carrying `protocol: 1` proves v1 even when the 101 echo was
    // stripped in transit (the `?pv=1` path).
    if (frame.protocol === 1) this.v1 = true;

    if (typeof frame.snapshotVersion === 'number') this.version = frame.snapshotVersion;

    if (type === 'pong') {
      this.clearPongTimer();
      return;
    }

    // Section availability rides on `hidden`/`closed`, either on its own frame
    // or alongside a snapshot. Identical for every scope.
    if (Array.isArray(frame.hidden) || Array.isArray(frame.closed)) {
      const hidden = Array.isArray(frame.hidden) ? (frame.hidden as string[]) : [];
      const closed = Array.isArray(frame.closed) ? (frame.closed as string[]) : [];
      const hKey = hidden.join(SEP);
      const cKey = closed.join(SEP);
      if (hKey !== this.hidden || cKey !== this.closedSections) {
        this.hidden = hKey;
        this.closedSections = cKey;
        this.opts.sink.onSections?.(hidden, closed);
      }
    }
    if (type === 'hidden') return; // carries no inventory

    if (type === 'presence') {
      this.opts.sink.onPresence?.({
        shoppingSessions: Number(frame.shoppingSessions) || 0,
        activeHolds: Number(frame.activeHolds) || 0,
      });
      return;
    }

    if (type === 'allocation') {
      // Always followed by a fresh snapshot, which is authoritative. Nothing to
      // do here — and deliberately NO dedupe on allocationVersion: a pause or
      // unpause changes the projection without moving that number.
      return;
    }

    if (type === 'snapshot' || (!type && frame.seats)) {
      this.answered();
      const next = projectionFromSnapshot(frame);
      const changes = diffProjections(this.projection, next);
      this.projection = next;
      if (changes === null) void this.opts.sink.resync();
      else if (changes.length) this.opts.sink.applyStatuses(changes);
      return;
    }

    if (type === 'delta' && Array.isArray(frame.changes)) {
      this.answered();
      const changes = (frame.changes as Array<Record<string, unknown>>)
        .filter((c) => typeof c?.label === 'string' && typeof c?.status === 'string')
        .map((c) => ({ label: c.label as string, status: c.status as string }));
      if (!changes.length) return;
      if (this.projection) applyChanges(this.projection, changes);
      this.opts.sink.applyStatuses(changes);
    }
  }

  /** The server answered our resume; cancel the fallback resync. */
  private answered(): void {
    if (!this.resumeTimer) return;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  private reportIfAccessError(err: unknown): void {
    const reason = (err as { reason?: string } | null)?.reason;
    if ((err as { name?: string } | null)?.name !== 'BuyerAccessUnavailableError') return;
    this.stopped = true;
    this.opts.onAccessUnavailable?.({
      reason: (reason ?? 'invalid') as BuyerAccessUnavailableEvent['reason'],
      code: (err as { code?: string }).code,
      status: (err as { status?: number }).status,
      retryable: reason === 'paused',
    });
  }

  // ---- keepalive & backoff --------------------------------------------------

  /**
   * Liveness is ping/pong, and only ping/pong. A socket that receives nothing
   * for minutes is the normal, correct state for a narrowly-scoped buyer on a
   * busy event (protocol doc §5), so quiet time never triggers a reconnect.
   */
  private startKeepalive(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return;
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        return;
      }
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        try {
          ws.close();
        } catch {
          /* onclose drives the reconnect */
        }
      }, PONG_GRACE_MS);
    }, PING_INTERVAL_MS);
  }

  /**
   * FULL jitter, not plain exponential backoff.
   *
   * A deterministic `2**attempt` schedule makes every browser that lost the same
   * socket — a worker redeploy, a DO eviction, a flaky edge PoP — come back in
   * the same millisecond, and an on-sale crowd reconnecting in lockstep is the
   * thing that turns one blip into a self-sustaining thundering herd. Full
   * jitter (`random() * ceiling`) spreads the same crowd across the whole
   * window; the ceiling still doubles, so a persistent outage still backs off.
   *
   * `Math.random` is correct here: this is client code choosing a delay, not a
   * Workflow step that has to replay deterministically.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = Math.min(this.attempt++, 5);
    const ceiling = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    const delay = Math.random() * ceiling;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearPongTimer(): void {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Controller sink
// ---------------------------------------------------------------------------

/**
 * The slice of PickerController this module drives. Structural on purpose — it
 * keeps this file free of an `@seatlayer/core` import, and every member here is
 * public controller API, so nothing in the engine mirror has to change.
 */
export interface PickerControllerLike {
  idForLabel(label: string): string | undefined;
  tableSelection(seatIdOrLabel: string): { physicalSeatIds: string[] } | null;
  setStatus(ids: string[], status: 'free' | 'held' | 'booked' | 'not_for_sale'): void;
  getStatus(id: string): string | undefined;
  flashSeat(id: string, color?: string): void;
  currentHold(): { labels: string[] } | null;
  getSelection(): Array<{ id: string; label: string }>;
  deselect(ids: string[]): void;
  refresh(): Promise<void>;
}

/** Wire status → renderer status. `blocked` is the one neutral unavailable
 *  value an out-of-scope unit reads as; the buyer must not be able to tell it
 *  apart from ordinary off-sale inventory (protocol doc §5). */
function rendererStatus(wire: string): 'free' | 'held' | 'booked' | 'not_for_sale' {
  if (wire === 'blocked') return 'not_for_sale';
  if (wire === 'held' || wire === 'booked' || wire === 'free' || wire === 'not_for_sale') return wire;
  return 'free';
}

export interface ControllerSinkOptions {
  /** Pulse seats other buyers take, as the controller's own socket does. */
  flashOnLiveChange?: boolean;
  /** Selected-but-unheld units that stopped being selectable. */
  onSelectedObjectUnavailable?: (labels: string[], reason: 'ineligible' | 'taken') => void;
  /** Section availability changed and the chart itself needs rebuilding. */
  onSections?: (hidden: string[], closed: string[]) => void;
  onStatusChange?: () => void;
}

export function createControllerSink(
  controller: PickerControllerLike,
  options: ControllerSinkOptions = {},
): RealtimeSink {
  const idsForLabel = (label: string): string[] => {
    const table = controller.tableSelection(label);
    if (table) return table.physicalSeatIds;
    const id = controller.idForLabel(label);
    return id ? [id] : [];
  };

  return {
    applyStatuses(changes) {
      const held = controller.currentHold()?.labels ?? [];
      // Bucket the whole batch and paint one call per status: a 256-label
      // delta must animate as ONE canvas pass, never one per seat.
      const buckets: Record<string, string[]> = {
        free: [], held: [], booked: [], not_for_sale: [],
      };
      const flashes: Array<{ id: string; color: string }> = [];
      const lost: string[] = [];
      const selected = new Map(controller.getSelection().map((s) => [s.label, s.id]));

      for (const change of changes) {
        const ids = idsForLabel(change.label);
        if (!ids.length) continue;
        const next = rendererStatus(change.status);
        buckets[next].push(...ids);
        if (
          options.flashOnLiveChange &&
          next !== 'free' &&
          !held.includes(change.label) &&
          ids.some((id) => controller.getStatus(id) === 'free')
        ) {
          const color = next === 'held' ? '#f4b740' : '#f43f5e';
          for (const id of ids) flashes.push({ id, color });
        }
        if (next !== 'free' && !held.includes(change.label) && selected.has(change.label)) {
          lost.push(change.label);
        }
      }

      for (const status of ['free', 'held', 'booked', 'not_for_sale'] as const) {
        if (buckets[status].length) controller.setStatus(buckets[status], status);
      }
      for (const flash of flashes) controller.flashSeat(flash.id, flash.color);

      if (lost.length) {
        // One deselect call, so the map cross-fades in a single pass rather
        // than blinking seat by seat (motion system §3, buyer picker).
        const ids = lost.flatMap((label) => idsForLabel(label));
        if (ids.length) controller.deselect(ids);
        const ineligible = changes.some(
          (c) => c.status === 'blocked' && lost.includes(c.label),
        );
        options.onSelectedObjectUnavailable?.(lost, ineligible ? 'ineligible' : 'taken');
      }
      options.onStatusChange?.();
    },

    async resync() {
      await controller.refresh();
    },

    /**
     * Section availability moved. Statuses are re-pulled so the map repaints.
     *
     * Known limit: rebuilding the chart when a section is newly HIDDEN (its
     * seats are stripped, not greyed) lives inside PickerController's own
     * socket handler and has no public entry point, so an access-scoped picker
     * repaints statuses but does not restructure the chart until its next
     * mount. Closing/opening a section — the common mid-sale move — is a
     * status-level change and is handled here in full.
     */
    onSections(hidden, closed) {
      void controller.refresh();
      options.onSections?.(hidden, closed);
    },
  };
}
