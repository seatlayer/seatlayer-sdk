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

  constructor(status: number, message: string, code?: string, conflicts?: HoldConflict[], reason?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.conflicts = conflicts;
    this.reason = reason;
  }
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
    retried = false,
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
    const authorization = await this.access?.authorization(retried ? 'unauthorized' : 'initial');
    if (authorization) headers.Authorization = authorization;

    const res = await fetch(`${this.base}${path}`, { method, headers, body, credentials: 'omit' });

    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const err = data as
        | { error?: string; code?: string; conflicts?: HoldConflict[]; reason?: string }
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
        if (refreshed && !retried) return this.request<T>(path, init, true);
      }
      if (res.status === 409) {
        const reason = code ? OBJECT_UNAVAILABLE_CODES[code] : undefined;
        const labels = err?.conflicts?.map((c) => c.label) ?? init.labels ?? [];
        if (reason) this.onObjectUnavailable?.({ labels, reason, code });
      }

      throw new ApiError(
        res.status,
        err?.error ?? `request_failed_${res.status}`,
        code,
        err?.conflicts,
        err?.reason,
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
}
