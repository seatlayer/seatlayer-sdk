/**
 * PubApi's two on-sale behaviours: which wire an ANONYMOUS buyer gets, and what
 * happens to one who is rate limited.
 *
 * Both used to be silent failures. `socketProtocols()` was declared on
 * PickerTransport and implemented nowhere, so every anonymous socket opened with
 * no subprotocol and the DO answered with the legacy VERBOSE frame — the whole
 * event, on connect and on every reconnect. And a 429 threw an ApiError carrying
 * nothing about when to come back, which a widget rendered as a blank map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PubApi, parseRetryAfter } from '../src/api';
import { SEATLAYER_V1 } from '../src/buyerRealtime';
import type { BuyerAccessContext } from '../src/buyerAccess';

const BASE = 'https://api.test.seatlayer.io';

/** A queue of canned responses, plus the calls that consumed them. */
function stubFetch(responses: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra request to ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: {
        get: (name: string) => {
          const found = Object.entries(next.headers ?? { 'content-type': 'application/json' })
            .find(([key]) => key.toLowerCase() === name.toLowerCase());
          return found ? found[1] : (name.toLowerCase() === 'content-type' ? 'application/json' : null);
        },
      },
      json: async () => next.body ?? null,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** The smallest thing that reads as a configured buyer-access session. */
const scopedAccess = {
  configured: true,
  authorization: async () => 'Bearer bse_test',
  handleFailure: async () => false,
} as unknown as BuyerAccessContext;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseRetryAfter', () => {
  it('reads the delta-seconds form the API sends', () => {
    expect(parseRetryAfter('7')).toBe(7);
  });

  it('reads the HTTP-date form a proxy may rewrite it to', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    expect(parseRetryAfter('Tue, 04 Aug 2026 12:00:30 GMT')).toBe(30);
  });

  it('falls back to the JSON body when the header is missing', () => {
    expect(parseRetryAfter(null, 4)).toBe(4);
  });

  it('is undefined when neither says anything, rather than guessing', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('socketProtocols — the compact wire for anonymous buyers', () => {
  it('offers seatlayer.v1 for a tokenless public client', () => {
    expect(new PubApi(BASE).socketProtocols('ev_1')).toEqual([SEATLAYER_V1]);
  });

  it('offers nothing for an access-scoped client, whose socket is not this one', () => {
    // A private scope authenticates with a subprotocol TICKET, which is minted
    // per attempt; BuyerRealtimeClient owns that socket and socketUrl() is ''.
    expect(new PubApi(BASE, { access: scopedAccess }).socketProtocols('ev_1')).toEqual([]);
    expect(new PubApi(BASE, { access: scopedAccess }).socketUrl('ev_1')).toBe('');
  });
});

describe('createRealtime — one socket client for both buyer kinds', () => {
  it('hands the controller a v1 client for an anonymous buyer', () => {
    const client = new PubApi(BASE).createRealtime('ev_1', { applyStatuses: () => {}, resync: () => {} });
    expect(client).not.toBeNull();
    expect(typeof client!.start).toBe('function');
    expect(typeof client!.stop).toBe('function');
    // Nothing is connected until the controller starts it.
    expect(client!.protocol).toBeNull();
  });

  it('declines for an access-scoped client so no second socket opens', () => {
    const api = new PubApi(BASE, { access: scopedAccess });
    expect(api.createRealtime('ev_1', { applyStatuses: () => {}, resync: () => {} })).toBeNull();
  });

  it('builds it on the credential-free subscribe URL', () => {
    const api = new PubApi(BASE);
    expect(api.subscribeUrl('ev_1')).toMatch(/^wss:\/\/api\.test\.seatlayer\.io\/pub\/events\/ev_1\/subscribe\?/);
    // The constructor asserts this itself; a throw here would be the leak.
    expect(() => api.createRealtime('ev_1', { applyStatuses: () => {}, resync: () => {} })).not.toThrow();
  });
});

describe('429 handling', () => {
  it('retries an idempotent GET once, after the advertised delay', async () => {
    vi.useFakeTimers();
    const calls = stubFetch([
      { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '2' }, body: { error: 'rate_limited' } },
      { status: 200, body: { seats: { 'A-1': 'held' }, updatedAt: 1 } },
    ]);
    const pending = new PubApi(BASE).objects('ev_1');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1); // the delay the server named is honoured
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toMatchObject({ seats: { 'A-1': 'held' } });
    expect(calls).toHaveLength(2);
  });

  it('gives up after that one retry rather than looping', async () => {
    vi.useFakeTimers();
    const rateLimited = {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '1' },
      body: { error: 'rate_limited', retryAfterSeconds: 1 },
    };
    const calls = stubFetch([rateLimited, rateLimited]);
    const pending = new PubApi(BASE).chart('ev_1').catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_100);
    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).retryAfterS).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('never replays a hold — a 429 on a POST is reported, not retried', async () => {
    const calls = stubFetch([{
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '3' },
      body: { error: 'rate_limited' },
    }]);
    const err = await new PubApi(BASE).hold('ev_1', [{ label: 'A-1' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).retryAfterS).toBe(3);
    expect(calls).toEqual([{ url: `${BASE}/pub/events/ev_1/hold`, method: 'POST' }]);
  });

  it('does not sit out a long rate limit inside the request — it surfaces it', async () => {
    const calls = stubFetch([{
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '45' },
      body: { error: 'rate_limited' },
    }]);
    const err = await new PubApi(BASE).objects('ev_1').catch((e: unknown) => e);
    // Sleeping 45s inside objects() is a hung widget; the host gets the number
    // and can say "try again in 45 seconds" instead.
    expect((err as ApiError).retryAfterS).toBe(45);
    expect(calls).toHaveLength(1);
  });

  it('assumes a short wait when a 429 names no delay at all', async () => {
    vi.useFakeTimers();
    const calls = stubFetch([
      { status: 429, body: { error: 'rate_limited' } },
      { status: 200, body: { seats: {}, updatedAt: 1 } },
    ]);
    const pending = new PubApi(BASE).objects('ev_1');
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(pending).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('leaves every other error shape untouched (no retryAfterS on a 409)', async () => {
    stubFetch([{
      status: 409,
      body: { error: 'conflict', conflicts: [{ label: 'A-1', status: 'held' }] },
    }]);
    const err = await new PubApi(BASE).hold('ev_1', [{ label: 'A-1' }]).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).retryAfterS).toBeUndefined();
    expect((err as ApiError).conflicts).toEqual([{ label: 'A-1', status: 'held' }]);
  });
});
