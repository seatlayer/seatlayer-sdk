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
 *   - Realtime read (`/pub/events/:key/subscribe`, `/objects`, `/chart`) is
 *     PUBLIC (wildcard CORS, no token) — the live board subscribes with no auth.
 *
 * `box-book` is intentionally omitted for M1 (box office ships in M2, and the
 * route is still session-only server-side).
 */
import type { ChartDoc } from '@seatlayer/core';

export class ManageApiError extends Error {
  status: number;
  code?: string;
  /** Present when a block/unbook 409s because seats were just taken. */
  conflicts?: { label: string; reason?: string }[];

  constructor(status: number, message: string, code?: string, conflicts?: { label: string; reason?: string }[]) {
    super(message);
    this.name = 'ManageApiError';
    this.status = status;
    this.code = code;
    this.conflicts = conflicts;
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
}

export interface ReportCategoryMeta {
  key: string;
  label: string;
  color: string;
  price: number;
}

export interface ReportResult {
  report: { byStatus: ReportByStatus; byCategory: ReportCategoryRow[] };
  event: { key: string; name: string; seatTotal: number; currency?: string };
  categories: ReportCategoryMeta[];
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
    const err = data as { error?: string; code?: string; conflicts?: { label: string; reason?: string }[] } | null;
    throw new ManageApiError(res.status, err?.error ?? `request_failed_${res.status}`, err?.code, err?.conflicts);
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

  private auth<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
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

  // ---- realtime read (public, no token) ----

  chart(key: string): Promise<PubChartResult> {
    return this.pub(`/pub/events/${encodeURIComponent(key)}/chart`);
  }

  objects(key: string): Promise<PubObjectsResult> {
    return this.pub(`/pub/events/${encodeURIComponent(key)}/objects`);
  }

  socketUrl(key: string): string {
    return `${this.base.replace(/^http/, 'ws')}/pub/events/${encodeURIComponent(key)}/subscribe`;
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

  // ---- reports (token) ----

  report(key: string): Promise<ReportResult> {
    return this.auth(`/v1/events/${encodeURIComponent(key)}/report`);
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
