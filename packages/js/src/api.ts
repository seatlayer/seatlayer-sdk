/**
 * Minimal client for the public embed surface of workers/api (the `/pub/*`
 * routes). Deliberately self-contained — it does NOT reuse src/lib/api.ts,
 * which bakes in a build-time API base and dashboard session credentials. The
 * SDK runs cross-origin on a third-party ticketing page, so:
 *   - apiBase is per-instance (constructor option), not a build constant;
 *   - credentials are omitted (no cookie to send, avoids CORS-credential setup);
 *   - no custom headers on mutating calls (keeps the CORS preflight trivial).
 */
import type { ChartDoc, PickerSeat as SelectedSeat } from '@seatlayer/core';
import type {
  BuyerAccessContext,
  SelectedObjectUnavailableEvent,
} from './buyerAccess';
import { BuyerRealtimeClient, SEATLAYER_V1, type RealtimeSink } from './buyerRealtime';

export interface HoldConflict {
  label: string;
  status: string;
}

export interface HoldLineItem {
  label: string; objectId: string; objectType: 'seat' | 'booth' | 'ga' | 'table'; categoryKey: string;
  tierId: string | null;
  /** Price in major currency units (for example 45 means $45.00). */
  unitPrice: number;
  currency: string;
  quantity?: number;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  /** Present when a hold 409s because seats were just taken/held. */
  conflicts?: HoldConflict[];
  /** Present when best-available 409s ('not_enough_together' | 'sold_out'). */
  reason?: string;
  /**
   * Seconds the server asked the caller to wait, off a 429's `Retry-After`.
   *
   * Present ONLY on a rate-limit error, and it is the server's number — never a
   * guess. A widget that catches this can say "try again in N seconds" instead
   * of rendering the blank map a swallowed 429 used to produce.
   */
  retryAfterS?: number;

  constructor(
    status: number,
    message: string,
    code?: string,
    conflicts?: HoldConflict[],
    reason?: string,
    retryAfterS?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.conflicts = conflicts;
    this.reason = reason;
    this.retryAfterS = retryAfterS;
  }
}

/**
 * Longest advertised delay we will sit out inside a request.
 *
 * A rate limit the buyer can wait through invisibly is worth absorbing; one
 * that is 30 seconds long is not — sleeping that long inside `chart()` looks
 * like a hung widget, and the retry would very likely 429 again anyway. Past
 * the cap the error is thrown WITH `retryAfterS`, so the host decides.
 */
const MAX_RATE_LIMIT_WAIT_S = 10;
/** What to assume when a 429 names no delay at all. */
const DEFAULT_RATE_LIMIT_WAIT_S = 1;

/**
 * `Retry-After` in seconds. RFC 9110 allows either a delta-seconds integer or
 * an HTTP-date; the API sends the integer, and the date form is handled so a
 * proxy that rewrites it cannot turn a well-formed 429 into an untyped one.
 * Returns undefined when neither the header nor the body says anything.
 */
export function parseRetryAfter(header: string | null, bodyValue?: unknown): number | undefined {
  const raw = (header ?? '').trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  if (typeof bodyValue === 'number' && Number.isFinite(bodyValue) && bodyValue >= 0) {
    return Math.ceil(bodyValue);
  }
  return undefined;
}

export interface PubChartResult {
  event: { key: string; name: string; inventoryModelVersion?: 1 | 2 };
  doc: ChartDoc;
}

export interface PubObjectsResult {
  /** Every non-free seat's status, keyed by seat label. */
  seats: Record<string, string>;
  /** Section/zone ids hidden from buyers this event (seats stripped from the map). */
  hidden?: string[];
  /** Section/zone ids in the `closed` state (Phase 2): rendered grey + not purchasable. */
  closed?: string[];
  updatedAt: number;
}

export interface HoldResult {
  holdId: string;
  expiresAt: number;
  /** The held seats with the buyer's chosen ticket tier per seat (present on hold). */
  seats?: SelectedSeat[];
  items?: HoldLineItem[];
}

/** Browser-safe active-hold projection returned by the resume endpoint. */
export interface ResumedHoldResult extends HoldResult {
  items: HoldLineItem[];
}

/** Best-available response — the server-picked seats plus the hold they landed in. */
export interface BestAvailableResult {
  holdId: string;
  expiresAt: number;
  labels: string[];
  seats?: SelectedSeat[];
  items?: HoldResult['items'];
  zoneId?: string;
}

/** A gateway the organizer can be connected to. */
export type PaymentProviderName = 'stripe' | 'razorpay';

/**
 * Why `payment-options` came back with an empty list.
 *
 * The three are NOT interchangeable and two of them give opposite advice:
 * `not_configured` means the organizer takes payment somewhere else,
 * `payments_off_for_event` means they deliberately do not sell THIS event
 * online, and `unavailable_for_event` means they switched it on and it is
 * broken. Collapsing them makes the widget blame a working integration for a
 * decision that was made on purpose.
 */
export type PaymentOptionsReason =
  | 'not_configured'
  | 'payments_off_for_event'
  | 'unavailable_for_event';

/**
 * What this event can take money through. Since the per-event gateway column
 * landed, `providers` holds AT MOST ONE entry — the gateway the organizer
 * assigned — so no browser can choose which one charges.
 *
 * `reason` is optional on the wire: a widget pinned against an older worker
 * still parses, and its absence means what that worker meant by an empty list.
 */
export interface PaymentOptionsResult {
  providers: PaymentProviderName[];
  currency: string | null;
  reason?: PaymentOptionsReason | null;
}

/** A started payment. Exactly one of the two handoffs comes back. */
export interface CheckoutSessionResult {
  orderId: string;
  totalMinor: number;
  currency: string;
  expiresAt: number;
  /** Hosted gateway page — navigate to it. */
  redirectUrl?: string;
  /** In-page modal gateway — open it without leaving the page. */
  clientPayload?: Record<string, unknown>;
}

/** An order's state while its gateway webhook is in flight. */
export interface OrderStatusResult {
  orderId: string;
  status: string;
  totalMinor: number;
  currency: string;
  amountFormatted: string;
  seatCount: number;
}

/** Codes a 409 uses to say "the unit you picked is no longer yours to pick". */
const OBJECT_UNAVAILABLE_CODES: Record<string, SelectedObjectUnavailableEvent['reason']> = {
  seat_conflict: 'taken',
  conflict: 'taken',
  channel_assignment_conflict: 'ineligible',
  allocation_exhausted: 'exhausted',
};

export interface PubApiOptions {
  /**
   * Buyer access session. When present, EVERY scoped operation on this client
   * carries `Authorization: Bearer bse_…` — chart, objects, hold, replace-hold,
   * best-available, resume, release, extend, resnapshot and the realtime
   * subscribe ticket. The binding is immutable for the client's lifetime: there
   * is no method that turns it off, so no operation can silently downgrade to
   * anonymous Public sale (guide §6, §7).
   */
  access?: BuyerAccessContext;
  /** A 409 named specific inventory the buyer can no longer have. */
  onObjectUnavailable?: (event: SelectedObjectUnavailableEvent) => void;
}

/** Public-surface client bound to one apiBase (e.g. https://api.seatlayer.io). */
export class PubApi {
  private readonly viewerId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `viewer_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  private readonly access?: BuyerAccessContext;
  private readonly onObjectUnavailable?: (event: SelectedObjectUnavailableEvent) => void;

  constructor(private readonly base: string, options: PubApiOptions = {}) {
    this.access = options.access;
    this.onObjectUnavailable = options.onObjectUnavailable;
  }

  /** True when this client is bound to a buyer access session. */
  get accessScoped(): boolean {
    return !!this.access?.configured;
  }

  private async request<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; labels?: string[] } = {},
    retried: { auth?: boolean; rateLimit?: boolean } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    // Throws BuyerAccessUnavailableError rather than returning undefined when a
    // configured session cannot produce a bearer — the request must not go out
    // anonymous, because anonymous means Public sale.
    const authorization = await this.access?.authorization(retried.auth ? 'unauthorized' : 'initial');
    if (authorization) headers.Authorization = authorization;

    const res = await fetch(`${this.base}${path}`, { method, headers, body, credentials: 'omit' });

    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const err = data as
        | {
          error?: string; code?: string; conflicts?: HoldConflict[]; reason?: string;
          retryAfterSeconds?: number;
        }
        | null;
      // The public API names its machine code in `error` (`conflict`, `event_closed`,
      // …); older/other routes may send `code`. Carry whichever into ApiError.code so
      // the code is populated (it was previously always undefined — nothing reads it
      // yet) and the bridge can pass it through. The specific 409 discriminator still
      // rides in `reason` (`sold_out` | `not_enough_together`) and wins downstream.
      const code = err?.code ?? err?.error;

      if (this.access?.configured && (res.status === 401 || res.status === 403 || res.status === 422)) {
        const refreshed = await this.access.handleFailure(res.status, code);
        // Exactly one retry, and only for an expiry the provider just renewed.
        // A refresh returns the same or a narrower scope; it never widens, and
        // a second failure is reported rather than looped.
        if (refreshed && !retried.auth) return this.request<T>(path, init, { ...retried, auth: true });
      }
      if (res.status === 409) {
        const reason = code ? OBJECT_UNAVAILABLE_CODES[code] : undefined;
        const labels = err?.conflicts?.map((c) => c.label) ?? init.labels ?? [];
        if (reason) this.onObjectUnavailable?.({ labels, reason, code });
      }

      let retryAfterS: number | undefined;
      if (res.status === 429) {
        retryAfterS = parseRetryAfter(res.headers.get('Retry-After'), err?.retryAfterSeconds)
          ?? DEFAULT_RATE_LIMIT_WAIT_S;
        // One automatic retry, and only for a READ.
        //
        // A rate-limited `chart()`/`objects()` is what turns an on-sale spike
        // into a blank widget, and re-reading is free of consequence — the same
        // GET twice is the same GET. A hold, a best-available, a checkout or an
        // extend is NOT: replaying one can take a second seat, start a second
        // payment, or burn an extend allowance, so a 429 on those is reported to
        // the caller with the server's delay attached and never replayed here.
        if (
          method === 'GET'
          && !retried.rateLimit
          && retryAfterS <= MAX_RATE_LIMIT_WAIT_S
        ) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterS! * 1000));
          return this.request<T>(path, init, { ...retried, rateLimit: true });
        }
      }

      throw new ApiError(
        res.status,
        err?.error ?? `request_failed_${res.status}`,
        code,
        err?.conflicts,
        err?.reason,
        retryAfterS,
      );
    }
    return data as T;
  }

  chart(key: string): Promise<PubChartResult> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/chart`);
  }

  objects(key: string): Promise<PubObjectsResult> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/objects`);
  }

  hold(key: string, selections: Array<{ label: string; tierId?: string | null; quantity?: number }>, ttlMs?: number, replaceHoldId?: string): Promise<HoldResult> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/hold`, {
      method: 'POST',
      body: { selections, ...(ttlMs ? { ttlMs } : {}), ...(replaceHoldId ? { replaceHoldId } : {}) },
      labels: selections.map((s) => s.label),
    });
  }

  // `zoneId` scopes the pick to one zone and `ttlMs` carries the host's checkout
  // window — both are part of the route contract, and dropping either here made
  // the SDK quietly pick venue-wide and hold for the server default instead.
  bestAvailable(key: string, qty: number, categoryKey?: string, zoneId?: string, ttlMs?: number): Promise<BestAvailableResult> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/best-available`, {
      method: 'POST',
      body: { qty, ...(categoryKey ? { categoryKey } : {}), ...(zoneId ? { zoneId } : {}), ...(ttlMs ? { ttlMs } : {}) },
    });
  }

  resume(key: string, holdId: string): Promise<ResumedHoldResult> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/hold/resume`, {
      method: 'POST',
      body: { holdId },
    });
  }

  release(key: string, labels: string[], holdId: string): Promise<{ ok: true; released?: string[] }> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/release`, {
      method: 'POST',
      body: { labels, holdId },
    });
  }

  /** P4 "need more time?": push an active hold's expiry out. Throws ApiError 409
   *  (reason: expired | extend_limit | not_found | not_active) if it can't. */
  extend(key: string, holdId: string, ttlMs?: number): Promise<{ holdId: string; expiresAt: number; extends: number }> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/extend`, {
      method: 'POST',
      body: { holdId, ...(ttlMs ? { ttlMs } : {}) },
    });
  }

  /**
   * Which gateways this event can actually take money through — the question
   * `checkout: 'hosted'` has to answer BEFORE it shows a buyer a Pay button, so
   * the answer is never discovered by failing a payment.
   *
   * Anonymous, and it discloses no account, key, mode or currency for a gateway
   * that did not match.
   */
  paymentOptions(key: string): Promise<PaymentOptionsResult> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/payment-options`);
  }

  /**
   * Turn a live hold into an order and start a payment.
   *
   * The amount is NOT sent: the server recomputes it from the hold's own items,
   * which is the only reason a browser cannot alter what it pays. Nor is the
   * PROVIDER — the event row decides which gateway charges, and a `provider` in
   * the body is checked rather than obeyed (409 `provider_mismatch`). Omitting
   * it is the shape that cannot disagree.
   */
  startCheckout(
    key: string,
    input: { holdId: string; buyerEmail: string; buyerName?: string; returnUrl?: string },
  ): Promise<CheckoutSessionResult> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/checkout`, {
      method: 'POST',
      body: input,
    });
  }

  /**
   * Poll an order while its gateway webhook lands. The order id is an
   * unguessable token the buyer already holds, so it acts as the capability —
   * which is also why a buyer returning from a gateway page can be told what
   * happened with nothing but the id in the return URL.
   */
  orderStatus(orderId: string): Promise<OrderStatusResult> {
    return this.request(`/pub/orders/${encodeURIComponent(orderId)}/status`);
  }

  /**
   * Mint a one-use subscribe ticket for the next socket attempt (protocol doc
   * §3). The bearer travels here, over ordinary HTTPS where CORS and Origin
   * already apply; the socket then carries only the short-lived ticket, in its
   * subprotocol list. TTL ≤ 30s, single redemption — mint one per attempt.
   */
  subscribeTicket(key: string): Promise<{ ticket?: string; protocols?: string[] } | null> {
    return this.request(`/pub/events/${encodeURIComponent(key)}/subscribe-tickets`, {
      method: 'POST',
      body: {},
    });
  }

  /**
   * The subscribe URL. Never carries a credential — not the bearer, not the
   * ticket. Query parameters are diagnostics only.
   */
  subscribeUrl(key: string): string {
    const wsBase = this.base.replace(/^http/, 'ws');
    const params = new URLSearchParams({ surface: 'picker', viewerId: this.viewerId });
    return `${wsBase}/pub/events/${encodeURIComponent(key)}/subscribe?${params}`;
  }

  /**
   * What PickerController opens its own socket with.
   *
   * Empty for an access-scoped client: a private scope authenticates with a
   * subprotocol ticket, which a URL-only constructor cannot carry, so the SDK's
   * BuyerRealtimeClient owns that socket instead and the controller skips its
   * own (an empty URL is its documented "no live feed" contract). A tokenless
   * public client returns exactly the URL it always has, so nothing about the
   * public picker's realtime path changes.
   */
  socketUrl(key: string): string {
    return this.accessScoped ? '' : this.subscribeUrl(key);
  }

  /**
   * The subprotocol list a PLAIN `new WebSocket(url, protocols)` must offer for
   * this transport — `PickerTransport.socketProtocols`, which PickerController
   * calls optionally and which nothing implemented until now.
   *
   * Offering `seatlayer.v1` is the whole point: without it the DO answers an
   * anonymous socket with the LEGACY verbose frame — every unit of a 10k-seat
   * event, on connect and on every reconnect — instead of the compact
   * `{default, exceptions}` form. Empty for an access-scoped client, which
   * authenticates with a one-use ticket a URL-only constructor cannot carry and
   * whose socket BuyerRealtimeClient owns instead (see `socketUrl`).
   *
   * `createRealtime` below is the preferred path and supersedes this for any
   * host that can use it; this stays the correct answer for a host that builds
   * the socket itself from the transport contract.
   */
  socketProtocols(key: string): string[] {
    void key; // same answer for every event; the parameter is the interface's
    return this.accessScoped ? [] : [SEATLAYER_V1];
  }

  /**
   * Hand PickerController the v1 realtime client instead of letting it open a
   * bare socket — `PickerTransport.createRealtime`.
   *
   * This is what puts an ANONYMOUS buyer (the on-sale case) on the same wire as
   * a private-channel one: compact snapshots, `sv.<n>` resume so a reconnect
   * inside the ring costs a delta rather than a full re-snapshot, ping/pong
   * liveness, and one jittered backoff implementation shared by both. The
   * anonymous case simply passes no `mintTicket` — the `/pub/events/:key/
   * subscribe` upgrade requires no ticket, and the DO resolves a ticketless
   * socket to the public scope.
   *
   * Null when access-scoped: that socket is owned by the widget's own
   * BuyerRealtimeClient (with the ticket exchange), and `socketUrl()` already
   * returns '' so the controller opens nothing.
   */
  createRealtime(key: string, sink: RealtimeSink): BuyerRealtimeClient | null {
    if (this.accessScoped) return null;
    return new BuyerRealtimeClient({ url: this.subscribeUrl(key), sink });
  }
}
