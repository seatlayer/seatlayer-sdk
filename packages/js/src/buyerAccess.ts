/**
 * Buyer access context — the browser half of the Sales Channels contract
 * (`docs/sales-channels-integration-guide-2026-08-01.md` §6, §9, §10).
 *
 * A promoter's own backend mints a short-lived, opaque buyer-access session
 * (`bse_…`) that grants exactly one event's private channel scope. That bearer
 * reaches the browser, and only the browser — this module is where it lives,
 * and the rules it enforces are the ones the guide states outright:
 *
 *   - the token is held in memory on a private field. It is never written to
 *     localStorage/sessionStorage/cookies, never appended to a URL, and never
 *     placed in a log, an Error message, telemetry, or JSON. `toJSON()` and
 *     `toString()` are overridden so an accidental `JSON.stringify(context)` or
 *     template interpolation cannot leak it;
 *   - refresh goes through the host's `buyerAccessTokenProvider`, which is
 *     called with a `reason` so the host can distinguish a first acquisition
 *     from an expiry from a 401;
 *   - **a configured context never falls back to anonymous Public sale.** When
 *     no bearer can be obtained the operation fails with a typed access error
 *     instead of going out unauthenticated. Sending the request without the
 *     bearer would silently widen the buyer's scope to Public — the exact
 *     failure the feature exists to prevent (guide §7).
 *
 * Deliberately free of any `@seatlayer/core` import: it deals in tokens, HTTP
 * status codes and callbacks only, so it vendors into the app's widget copy
 * with no engine coupling.
 */

/** Why the SDK is asking the host for a token. Passed to the provider. */
export type BuyerAccessRefreshReason =
  /** First acquisition, before the chart is fetched. */
  | 'initial'
  /** Proactive: the held token is inside the renewal skew. */
  | 'expiring'
  /** Reactive: the held token's own expiry has passed. */
  | 'expired'
  /** Reactive: the server answered 401 `buyer_access_expired`. */
  | 'unauthorized'
  /** A realtime reconnect needs a live bearer to mint a subscribe ticket. */
  | 'reconnect'
  /** The host called `refreshAccess()`. */
  | 'manual';

/** What a `buyerAccessTokenProvider` resolves to — the response body of the
 *  host's own mint endpoint, unchanged. */
export interface BuyerAccessToken {
  /** The opaque `bse_…` buyer-access session bearer. */
  token: string;
  /** Epoch ms. Optional — absent means "trust the server", and the SDK then
   *  refreshes only reactively on a 401. */
  expiresAt?: number;
}

export type BuyerAccessTokenProvider = (
  context: { reason: BuyerAccessRefreshReason },
) => BuyerAccessToken | Promise<BuyerAccessToken>;

/**
 * Why private inventory is not available. Never collapsed into a generic
 * network failure (guide §10) and never carrying channel identity — the buyer
 * is told the state, not which allocation they missed.
 */
export type BuyerAccessUnavailableReason =
  /** The session was revoked (HTTP 401 after refresh, or WS close 4401). */
  | 'revoked'
  /** The channel is paused — a legitimate, temporary organizer state. */
  | 'paused'
  /** 401 `buyer_access_invalid`: do not retry this bearer. */
  | 'invalid'
  /** 403 `buyer_access_origin_mismatch`. */
  | 'origin_mismatch'
  /** 403 `buyer_access_event_mismatch`. */
  | 'event_mismatch'
  /** 403 `buyer_access_mode_mismatch` (test bearer on a live event or v.v.). */
  | 'mode_mismatch'
  /** 403 `channel_access_denied`. */
  | 'channel_denied'
  /** 422 `invalid_channel_scope` — an integration configuration error. */
  | 'invalid_scope'
  /** The host's token provider threw or returned nothing usable. */
  | 'provider_failed'
  /** A one-shot `buyerAccessToken` lapsed and no provider was configured. */
  | 'no_token';

/** The access session expired. Carries whether the refresh recovered it. */
export interface BuyerAccessExpiredEvent {
  reason: BuyerAccessRefreshReason;
  /** The server's machine code when the expiry was observed over HTTP. */
  code?: string;
  /** True when the provider handed back a fresh token and work continues. */
  refreshed: boolean;
}

/** Private inventory is unavailable, and refreshing will not fix it. */
export interface BuyerAccessUnavailableEvent {
  reason: BuyerAccessUnavailableReason;
  /** The server's machine code, when there was one. */
  code?: string;
  /** The HTTP status, when the state came from an HTTP response. */
  status?: number;
  /** True only for states a later retry could clear (`paused`). */
  retryable: boolean;
}

/** One or more selected-but-unheld units stopped being selectable. */
export interface SelectedObjectUnavailableEvent {
  /** Inventory labels (never channel identity). */
  labels: string[];
  reason:
    /** An allocation change moved it out of this buyer's scope (guide §9). */
    | 'ineligible'
    /** Someone else held or booked it. */
    | 'taken'
    /** 409 `allocation_exhausted` — this private allocation has none left. */
    | 'exhausted';
  code?: string;
}

export interface BuyerAccessContextOptions {
  provider?: BuyerAccessTokenProvider;
  /** One-shot escape hatch for hosts that already own the token lifecycle. */
  token?: string | BuyerAccessToken;
  /** Renew this long before the stated expiry. Default 30s. */
  skewMs?: number;
  onExpired?: (event: BuyerAccessExpiredEvent) => void;
  onUnavailable?: (event: BuyerAccessUnavailableEvent) => void;
}

/**
 * Thrown instead of letting a scoped request go out unauthenticated. Carries no
 * bearer and no channel identity, so it is safe to log or hand to an error
 * reporter verbatim.
 */
export class BuyerAccessUnavailableError extends Error {
  readonly reason: BuyerAccessUnavailableReason;
  readonly code?: string;
  readonly status?: number;

  constructor(event: BuyerAccessUnavailableEvent) {
    super(`buyer_access_unavailable:${event.reason}`);
    this.name = 'BuyerAccessUnavailableError';
    this.reason = event.reason;
    this.code = event.code;
    this.status = event.status;
  }
}

/** Server error codes that mean "this session lapsed; run the refresh flow". */
const EXPIRED_CODES = new Set(['buyer_access_expired']);

/**
 * Guide §10 error table → an unavailable reason. Anything not in the table is
 * not an access failure and must stay an ordinary error, so this returns null.
 */
export function classifyAccessFailure(
  status: number,
  code: string | undefined,
): BuyerAccessUnavailableReason | null {
  switch (code) {
    case 'buyer_access_invalid':
      return 'invalid';
    case 'buyer_access_revoked':
      return 'revoked';
    case 'buyer_access_origin_mismatch':
      return 'origin_mismatch';
    case 'buyer_access_event_mismatch':
      return 'event_mismatch';
    case 'buyer_access_mode_mismatch':
      return 'mode_mismatch';
    case 'channel_access_denied':
      return 'channel_denied';
    case 'channel_paused':
      return 'paused';
    case 'invalid_channel_scope':
      return 'invalid_scope';
    default:
      break;
  }
  // An unnamed 401 on a scoped request is still an access failure; treat it as
  // the non-retryable kind rather than falling through to Public sale.
  if (status === 401) return 'invalid';
  return null;
}

/** True when this HTTP failure means "refresh the session and try again". */
export function isAccessExpiry(status: number, code: string | undefined): boolean {
  return status === 401 && !!code && EXPIRED_CODES.has(code);
}

const DEFAULT_SKEW_MS = 30_000;

export class BuyerAccessContext {
  /** Private field: not enumerable, not spreadable, not serializable. */
  #token: string | null = null;
  #expiresAt = 0;
  #provider?: BuyerAccessTokenProvider;
  #skewMs: number;
  #inflight: Promise<string | null> | null = null;
  #terminal: BuyerAccessUnavailableEvent | null = null;
  /** The most recent failure, terminal or not — so one cause reports once. */
  #lastFailure: BuyerAccessUnavailableEvent | null = null;
  #onExpired?: (event: BuyerAccessExpiredEvent) => void;
  #onUnavailable?: (event: BuyerAccessUnavailableEvent) => void;

  constructor(options: BuyerAccessContextOptions) {
    this.#provider = options.provider;
    this.#skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
    this.#onExpired = options.onExpired;
    this.#onUnavailable = options.onUnavailable;
    if (options.token) {
      const seed = typeof options.token === 'string' ? { token: options.token } : options.token;
      this.#accept(seed);
    }
  }

  /** True when this picker is access-scoped at all. A false here is the
   *  tokenless public picker, which must behave exactly as it always has. */
  get configured(): boolean {
    return !!this.#provider || !!this.#token;
  }

  /** Set once a state arrives that refreshing cannot clear. */
  get unavailable(): BuyerAccessUnavailableEvent | null {
    return this.#terminal;
  }

  /** True while a usable bearer is held (ignores skew). */
  get hasToken(): boolean {
    return !!this.#token && (this.#expiresAt === 0 || this.#expiresAt > Date.now());
  }

  /** Epoch ms the current token expires, or 0 when the host didn't say. */
  get expiresAt(): number {
    return this.#expiresAt;
  }

  /**
   * The `Authorization` header value for a scoped operation.
   *
   * Returns null only when this context is not configured at all (the ordinary
   * anonymous public picker). A configured context either returns a bearer or
   * throws `BuyerAccessUnavailableError` — it never returns null, because a
   * null here would send the request as anonymous Public sale.
   */
  async authorization(reason: BuyerAccessRefreshReason = 'initial'): Promise<string | null> {
    if (!this.configured) return null;
    if (this.#terminal) throw new BuyerAccessUnavailableError(this.#terminal);

    const now = Date.now();
    const stale = !this.#token || (this.#expiresAt > 0 && this.#expiresAt - this.#skewMs <= now);
    if (stale) {
      const expired = !!this.#token && this.#expiresAt > 0 && this.#expiresAt <= now;
      const why: BuyerAccessRefreshReason = this.#token ? (expired ? 'expired' : 'expiring') : reason;
      const token = await this.#renew(why);
      if (!token) {
        // #renew already classified and reported the failure; reuse that event
        // rather than raising a second one for the same cause.
        throw new BuyerAccessUnavailableError(
          this.#terminal ?? this.#lastFailure ?? this.#fail('provider_failed'),
        );
      }
      return `Bearer ${token}`;
    }
    return `Bearer ${this.#token}`;
  }

  /**
   * Handle a 401/403 from a scoped call. Returns true when the caller should
   * retry the same request once with the refreshed bearer.
   */
  async handleFailure(status: number, code: string | undefined): Promise<boolean> {
    if (!this.configured) return false;

    if (isAccessExpiry(status, code)) {
      this.#token = null;
      this.#expiresAt = 0;
      const token = await this.#renew('unauthorized', code);
      this.#onExpired?.({ reason: 'unauthorized', code, refreshed: !!token });
      return !!token;
    }

    const reason = classifyAccessFailure(status, code);
    if (reason) {
      this.#fail(reason, code, status);
      return false;
    }
    return false;
  }

  /** Host-driven re-acquisition (after the buyer signs in again, say). */
  async refresh(reason: BuyerAccessRefreshReason = 'manual'): Promise<boolean> {
    this.#terminal = null;
    this.#lastFailure = null;
    this.#token = null;
    this.#expiresAt = 0;
    return !!(await this.#renew(reason));
  }

  /** Drop the bearer. Called on destroy so nothing outlives the widget. */
  clear(): void {
    this.#token = null;
    this.#expiresAt = 0;
    this.#inflight = null;
  }

  /** Redaction: the bearer must not survive a stringify or an interpolation. */
  toJSON(): { configured: boolean; hasToken: boolean } {
    return { configured: this.configured, hasToken: this.hasToken };
  }

  toString(): string {
    return '[BuyerAccessContext redacted]';
  }

  // ---- internals ------------------------------------------------------------

  #accept(next: BuyerAccessToken | null | undefined): string | null {
    if (!next || typeof next.token !== 'string' || !next.token) return null;
    this.#token = next.token;
    this.#expiresAt = typeof next.expiresAt === 'number' ? next.expiresAt : 0;
    return this.#token;
  }

  /**
   * One provider call at a time. Several operations racing an expiry (chart +
   * objects + a socket ticket) must not mint several sessions — the guide's
   * rotate-on-retry rule would revoke the ones they didn't observe.
   */
  #renew(reason: BuyerAccessRefreshReason, code?: string): Promise<string | null> {
    if (this.#inflight) return this.#inflight;
    const provider = this.#provider;
    if (!provider) {
      // A one-shot token with no provider cannot be renewed. That is a legal
      // host choice, so it is a typed state, not a crash.
      this.#fail('no_token', code);
      return Promise.resolve(null);
    }
    const run = (async (): Promise<string | null> => {
      try {
        const next = await provider({ reason });
        const token = this.#accept(next);
        if (!token) {
          this.#fail('provider_failed', code);
          return null;
        }
        return token;
      } catch {
        // The provider's own error text may contain host detail; it is not
        // rethrown and not logged. The host already saw its own failure.
        this.#fail('provider_failed', code);
        return null;
      } finally {
        this.#inflight = null;
      }
    })();
    this.#inflight = run;
    return run;
  }

  #fail(
    reason: BuyerAccessUnavailableReason,
    code?: string,
    status?: number,
  ): BuyerAccessUnavailableEvent {
    const event: BuyerAccessUnavailableEvent = {
      reason,
      code,
      status,
      retryable: reason === 'paused',
    };
    // `paused` and `provider_failed` are recoverable: a later refresh may work,
    // so they do not latch the context into a terminal state.
    this.#lastFailure = event;
    if (reason !== 'paused' && reason !== 'provider_failed') this.#terminal = event;
    this.#token = null;
    this.#expiresAt = 0;
    this.#onUnavailable?.(event);
    return event;
  }
}

/** Build a context from widget options, or null for the tokenless public path. */
export function createBuyerAccessContext(
  options: {
    buyerAccessTokenProvider?: BuyerAccessTokenProvider;
    buyerAccessToken?: string | BuyerAccessToken;
  },
  hooks: Pick<BuyerAccessContextOptions, 'onExpired' | 'onUnavailable'> = {},
): BuyerAccessContext | null {
  if (!options.buyerAccessTokenProvider && !options.buyerAccessToken) return null;
  return new BuyerAccessContext({
    provider: options.buyerAccessTokenProvider,
    token: options.buyerAccessToken,
    ...hooks,
  });
}
