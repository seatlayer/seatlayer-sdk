/**
 * Buyer access sessions over HTTP — the scoped-transport half of M6a.
 *
 * The contracts under test come straight from the integration guide:
 *   §6  every scoped operation carries the bearer, and the bearer never leaves
 *       memory (no storage, no URL, no log, no JSON);
 *   §7  an invalid/expired/revoked token fails explicitly and NEVER falls
 *       through to anonymous Public sale;
 *   §9  refresh on expiry, without widening scope;
 *   §10 typed access-expired / access-unavailable / selected-object-unavailable,
 *       never collapsed into a generic network error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PubApi } from '../src/api';
import {
  BuyerAccessContext,
  BuyerAccessUnavailableError,
  classifyAccessFailure,
  createBuyerAccessContext,
  type BuyerAccessExpiredEvent,
  type BuyerAccessUnavailableEvent,
  type SelectedObjectUnavailableEvent,
} from '../src/buyerAccess';

const BASE = 'https://api.test.seatlayer.io';
const BEARER = 'bse_super_secret_value_01J';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
let respond: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  respond = () => json(200, { ok: true });
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const authOf = (call: Call): string | undefined =>
  (call.init.headers as Record<string, string> | undefined)?.Authorization;

describe('tokenless public picker — the compatibility contract', () => {
  it('sends no Authorization header on any operation', async () => {
    const api = new PubApi(BASE);
    await api.chart('ev_1');
    await api.objects('ev_1');
    await api.hold('ev_1', [{ label: 'A-1' }]);
    await api.bestAvailable('ev_1', 2);
    await api.resume('ev_1', 'hold_1');
    await api.release('ev_1', ['A-1'], 'hold_1');
    await api.extend('ev_1', 'hold_1');

    expect(calls).toHaveLength(7);
    for (const call of calls) expect(authOf(call)).toBeUndefined();
    expect(api.accessScoped).toBe(false);
  });

  it('returns the same subscribe URL it always has, so PickerController keeps its own socket', () => {
    const api = new PubApi(BASE);
    const url = api.socketUrl('ev_1');
    expect(url).toBe(api.subscribeUrl('ev_1'));
    expect(url).toMatch(/^wss:\/\/api\.test\.seatlayer\.io\/pub\/events\/ev_1\/subscribe\?/);
    expect(url).toContain('surface=picker');
  });

  it('builds no access context when neither option is given', () => {
    expect(createBuyerAccessContext({})).toBeNull();
  });
});

describe('scoped transport binding (guide §6)', () => {
  it('carries the bearer on chart, objects, hold, replace-hold, best-available, resume, release, extend and the subscribe ticket', async () => {
    const api = new PubApi(BASE, {
      access: new BuyerAccessContext({ token: { token: BEARER, expiresAt: Date.now() + 600_000 } }),
    });

    await api.chart('ev_1');
    await api.objects('ev_1');
    await api.hold('ev_1', [{ label: 'A-1' }]);
    await api.hold('ev_1', [{ label: 'A-2' }], undefined, 'hold_1'); // replace-hold
    await api.bestAvailable('ev_1', 2);
    await api.resume('ev_1', 'hold_1');
    await api.release('ev_1', ['A-1'], 'hold_1');
    await api.extend('ev_1', 'hold_1');
    await api.subscribeTicket('ev_1');

    expect(calls).toHaveLength(9);
    for (const call of calls) expect(authOf(call)).toBe(`Bearer ${BEARER}`);
  });

  it('never puts the bearer in a URL — not the HTTP path, not the socket URL', async () => {
    const access = new BuyerAccessContext({ token: BEARER });
    const api = new PubApi(BASE, { access });
    await api.chart('ev_1');
    await api.hold('ev_1', [{ label: 'A-1' }]);
    await api.subscribeTicket('ev_1');

    for (const call of calls) {
      expect(call.url).not.toContain(BEARER);
      expect(call.url).not.toMatch(/bse_/);
      expect(call.url).not.toMatch(/[?&](token|access_token|bearer|authorization|ticket)=/i);
    }
    expect(api.subscribeUrl('ev_1')).not.toContain(BEARER);
    // A private scope authenticates by subprotocol ticket, so the controller's
    // URL-only socket is deliberately switched off.
    expect(api.socketUrl('ev_1')).toBe('');
  });

  it('keeps the bearer out of JSON, string interpolation and request bodies', async () => {
    const access = new BuyerAccessContext({ token: BEARER });
    expect(JSON.stringify(access)).not.toContain(BEARER);
    expect(JSON.stringify({ access })).not.toContain(BEARER);
    expect(String(access)).toBe('[BuyerAccessContext redacted]');
    expect(`${access}`).not.toContain(BEARER);
    expect(Object.keys(access)).toEqual([]);

    const api = new PubApi(BASE, { access });
    await api.hold('ev_1', [{ label: 'A-1' }]);
    expect(String(calls[0].init.body)).not.toContain(BEARER);
  });

  it('asks the provider for the first token and holds it in memory afterwards', async () => {
    const provider = vi.fn(async () => ({ token: BEARER, expiresAt: Date.now() + 600_000 }));
    const api = new PubApi(BASE, { access: new BuyerAccessContext({ provider }) });

    await api.chart('ev_1');
    await api.objects('ev_1');

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith({ reason: 'initial' });
    expect(authOf(calls[1])).toBe(`Bearer ${BEARER}`);
  });

  it('renews proactively inside the skew rather than waiting for a 401', async () => {
    let issued = 0;
    const provider = vi.fn(async () => ({
      token: `bse_${++issued}`,
      // Always inside the default 30s skew, so every call renews.
      expiresAt: Date.now() + 5_000,
    }));
    const api = new PubApi(BASE, { access: new BuyerAccessContext({ provider }) });

    await api.chart('ev_1');
    await api.objects('ev_1');

    expect(provider.mock.calls.map((c) => c[0].reason)).toEqual(['initial', 'expiring']);
    expect(authOf(calls[1])).toBe('Bearer bse_2');
  });

  it('mints only one session when several operations race the same expiry', async () => {
    const provider = vi.fn(
      () =>
        new Promise<{ token: string; expiresAt: number }>((resolve) => {
          setTimeout(() => resolve({ token: BEARER, expiresAt: Date.now() + 600_000 }), 5);
        }),
    );
    const api = new PubApi(BASE, { access: new BuyerAccessContext({ provider }) });

    await Promise.all([api.chart('ev_1'), api.objects('ev_1'), api.subscribeTicket('ev_1')]);

    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('expiry and refresh (guide §9, §10)', () => {
  it('refreshes on 401 buyer_access_expired, retries once, and reports accessExpired{refreshed:true}', async () => {
    const expired: BuyerAccessExpiredEvent[] = [];
    let issued = 0;
    const provider = vi.fn(async () => ({ token: `bse_${++issued}` }));
    const access = new BuyerAccessContext({ provider, onExpired: (e) => expired.push(e) });
    const api = new PubApi(BASE, { access });

    respond = (call) =>
      authOf(call) === 'Bearer bse_1'
        ? json(401, { error: 'buyer_access_expired' })
        : json(200, { seats: {} });

    const result = await api.objects('ev_1');

    expect(result).toEqual({ seats: {} });
    expect(calls).toHaveLength(2);
    expect(authOf(calls[1])).toBe('Bearer bse_2');
    expect(provider.mock.calls.map((c) => c[0].reason)).toEqual(['initial', 'unauthorized']);
    expect(expired).toEqual([{ reason: 'unauthorized', code: 'buyer_access_expired', refreshed: true }]);
  });

  it('retries a refreshed 401 exactly once — a second failure is reported, not looped', async () => {
    let issued = 0;
    const access = new BuyerAccessContext({ provider: async () => ({ token: `bse_${++issued}` }) });
    const api = new PubApi(BASE, { access });
    respond = () => json(401, { error: 'buyer_access_expired' });

    await expect(api.objects('ev_1')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2);
  });

  it('reports accessUnavailable and stops when the provider fails — it never retries anonymously', async () => {
    const unavailable: BuyerAccessUnavailableEvent[] = [];
    const expired: BuyerAccessExpiredEvent[] = [];
    const access = new BuyerAccessContext({
      provider: vi.fn(async () => {
        throw new Error('host session cookie missing');
      }),
      onExpired: (e) => expired.push(e),
      onUnavailable: (e) => unavailable.push(e),
    });
    const api = new PubApi(BASE, { access });

    await expect(api.objects('ev_1')).rejects.toBeInstanceOf(BuyerAccessUnavailableError);

    // The decisive assertion: nothing went out. A request without the bearer
    // would have been served as anonymous Public sale — a silent scope widening.
    expect(calls).toHaveLength(0);
    expect(unavailable).toEqual([
      { reason: 'provider_failed', code: undefined, status: undefined, retryable: false },
    ]);
    expect(expired).toEqual([]);
  });

  it('reports accessExpired{refreshed:false} when the refresh after a 401 fails', async () => {
    const expired: BuyerAccessExpiredEvent[] = [];
    let issued = 0;
    const access = new BuyerAccessContext({
      provider: async () => {
        if (issued++ === 0) return { token: 'bse_1' };
        throw new Error('re-auth required');
      },
      onExpired: (e) => expired.push(e),
    });
    const api = new PubApi(BASE, { access });
    respond = () => json(401, { error: 'buyer_access_expired' });

    await expect(api.objects('ev_1')).rejects.toBeInstanceOf(ApiError);
    expect(expired).toEqual([
      { reason: 'unauthorized', code: 'buyer_access_expired', refreshed: false },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('cannot renew a one-shot buyerAccessToken, and says so rather than going anonymous', async () => {
    const unavailable: BuyerAccessUnavailableEvent[] = [];
    const access = new BuyerAccessContext({
      token: { token: BEARER, expiresAt: Date.now() - 1 },
      onUnavailable: (e) => unavailable.push(e),
    });
    const api = new PubApi(BASE, { access });

    await expect(api.objects('ev_1')).rejects.toBeInstanceOf(BuyerAccessUnavailableError);
    expect(calls).toHaveLength(0);
    expect(unavailable[0].reason).toBe('no_token');
  });

  it('re-acquires on an explicit refresh, clearing a terminal state', async () => {
    let issued = 0;
    const access = new BuyerAccessContext({ provider: async () => ({ token: `bse_${++issued}` }) });
    const api = new PubApi(BASE, { access });
    respond = () => json(403, { error: 'buyer_access_origin_mismatch' });
    await expect(api.objects('ev_1')).rejects.toBeInstanceOf(ApiError);
    expect(access.unavailable?.reason).toBe('origin_mismatch');

    respond = () => json(200, { seats: {} });
    expect(await access.refresh('manual')).toBe(true);
    expect(access.unavailable).toBeNull();
    await api.objects('ev_1');
    expect(authOf(calls[calls.length - 1])).toBe('Bearer bse_2');
  });
});

describe('the error contract (guide §10) is typed, not collapsed', () => {
  const table: Array<[number, string, string]> = [
    [401, 'buyer_access_invalid', 'invalid'],
    [403, 'buyer_access_origin_mismatch', 'origin_mismatch'],
    [403, 'buyer_access_event_mismatch', 'event_mismatch'],
    [403, 'buyer_access_mode_mismatch', 'mode_mismatch'],
    [403, 'channel_access_denied', 'channel_denied'],
    [422, 'invalid_channel_scope', 'invalid_scope'],
  ];

  it.each(table)('maps %s %s to a typed unavailable state', async (status, code, reason) => {
    const unavailable: BuyerAccessUnavailableEvent[] = [];
    const provider = vi.fn(async () => ({ token: BEARER }));
    const api = new PubApi(BASE, {
      access: new BuyerAccessContext({ provider, onUnavailable: (e) => unavailable.push(e) }),
    });
    respond = () => json(status, { error: code });

    await expect(api.objects('ev_1')).rejects.toMatchObject({ status, code });
    expect(unavailable).toEqual([{ reason, code, status, retryable: false }]);
    // Not an expiry: the provider is never asked to mint a second session.
    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('treats an unnamed 401 as an access failure, never as anonymous Public sale', () => {
    expect(classifyAccessFailure(401, undefined)).toBe('invalid');
    expect(classifyAccessFailure(404, 'not_found')).toBeNull();
    expect(classifyAccessFailure(409, 'seat_conflict')).toBeNull();
  });

  it('reports a paused channel as retryable, and does not latch the context', async () => {
    const unavailable: BuyerAccessUnavailableEvent[] = [];
    const access = new BuyerAccessContext({
      provider: async () => ({ token: BEARER }),
      onUnavailable: (e) => unavailable.push(e),
    });
    const api = new PubApi(BASE, { access });
    respond = () => json(403, { error: 'channel_paused' });

    await expect(api.objects('ev_1')).rejects.toBeInstanceOf(ApiError);
    expect(unavailable[0]).toMatchObject({ reason: 'paused', retryable: true });
    expect(access.unavailable).toBeNull();
  });

  it('raises selectedObjectUnavailable for a 409 that names inventory', async () => {
    const lost: SelectedObjectUnavailableEvent[] = [];
    const api = new PubApi(BASE, {
      access: new BuyerAccessContext({ token: BEARER }),
      onObjectUnavailable: (e) => lost.push(e),
    });

    respond = () => json(409, { error: 'seat_conflict', conflicts: [{ label: 'A-1', status: 'held' }] });
    await expect(api.hold('ev_1', [{ label: 'A-1' }])).rejects.toBeInstanceOf(ApiError);
    expect(lost).toEqual([{ labels: ['A-1'], reason: 'taken', code: 'seat_conflict' }]);

    respond = () => json(409, { error: 'allocation_exhausted' });
    await expect(api.hold('ev_1', [{ label: 'B-2' }])).rejects.toBeInstanceOf(ApiError);
    // No conflict list on this one, so the attempted labels stand in.
    expect(lost[1]).toEqual({ labels: ['B-2'], reason: 'exhausted', code: 'allocation_exhausted' });
  });

  it('leaves ordinary failures alone — they stay ApiError and raise no access event', async () => {
    const unavailable: BuyerAccessUnavailableEvent[] = [];
    const api = new PubApi(BASE, {
      access: new BuyerAccessContext({ token: BEARER, onUnavailable: (e) => unavailable.push(e) }),
    });
    respond = () => json(404, { error: 'not_found' });

    await expect(api.objects('ev_1')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(unavailable).toEqual([]);
  });
});
