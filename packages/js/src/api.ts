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

export interface HoldConflict {
  label: string;
  reason: string;
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
  event: { key: string; name: string };
  doc: ChartDoc;
}

export interface PubObjectsResult {
  /** Every non-free seat's status, keyed by seat label. */
  seats: Record<string, string>;
  updatedAt: number;
}

export interface HoldResult {
  holdId: string;
  expiresAt: number;
  /** The held seats with the buyer's chosen ticket tier per seat (present on hold). */
  seats?: SelectedSeat[];
}

/** Best-available response — the server-picked seats plus the hold they landed in. */
export interface BestAvailableResult {
  holdId: string;
  expiresAt: number;
  labels: string[];
  seats?: SelectedSeat[];
}

async function request<T>(
  base: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }

  const res = await fetch(`${base}${path}`, { method, headers, body, credentials: 'omit' });

  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const err = data as
      | { error?: string; code?: string; conflicts?: HoldConflict[]; reason?: string }
      | null;
    throw new ApiError(res.status, err?.error ?? `request_failed_${res.status}`, err?.code, err?.conflicts, err?.reason);
  }
  return data as T;
}

/** Public-surface client bound to one apiBase (e.g. https://api.seatlayer.io). */
export class PubApi {
  constructor(private readonly base: string) {}

  chart(key: string): Promise<PubChartResult> {
    return request(this.base, `/pub/events/${encodeURIComponent(key)}/chart`);
  }

  objects(key: string): Promise<PubObjectsResult> {
    return request(this.base, `/pub/events/${encodeURIComponent(key)}/objects`);
  }

  hold(key: string, labels: string[]): Promise<HoldResult> {
    return request(this.base, `/pub/events/${encodeURIComponent(key)}/hold`, {
      method: 'POST',
      body: { labels },
    });
  }

  bestAvailable(key: string, qty: number, categoryKey?: string): Promise<BestAvailableResult> {
    return request(this.base, `/pub/events/${encodeURIComponent(key)}/best-available`, {
      method: 'POST',
      body: { qty, ...(categoryKey ? { categoryKey } : {}) },
    });
  }

  release(key: string, labels: string[], holdId: string): Promise<{ ok: true }> {
    return request(this.base, `/pub/events/${encodeURIComponent(key)}/release`, {
      method: 'POST',
      body: { labels, holdId },
    });
  }

  socketUrl(key: string): string {
    const wsBase = this.base.replace(/^http/, 'ws');
    return `${wsBase}/pub/events/${encodeURIComponent(key)}/subscribe`;
  }
}
