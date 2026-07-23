import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PubApi } from '../src/api';

/**
 * The best-available request contract. Both `zoneId` and `ttlMs` are part of the
 * route, and the transport used to send neither: the pick silently went
 * venue-wide and the resulting hold used the server's default checkout window
 * rather than the host's. A clicked selection honoured `holdTtlMs` and a
 * "find best seats" pick did not — same hold, two different clocks.
 */
describe('PubApi.bestAvailable request body', () => {
  let calls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ holdId: 'h1', expiresAt: 1, labels: ['A-1'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends zoneId and ttlMs when the caller supplies them', async () => {
    await new PubApi('https://api.example.test').bestAvailable('evt', 2, 'vip', 'zone-a', 4 * 60 * 1000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/pub/events/evt/best-available');
    expect(calls[0].body).toEqual({ qty: 2, categoryKey: 'vip', zoneId: 'zone-a', ttlMs: 240000 });
  });

  it('omits both when the caller supplies neither, leaving the server defaults in charge', async () => {
    await new PubApi('https://api.example.test').bestAvailable('evt', 2);

    expect(calls[0].body).toEqual({ qty: 2 });
  });
});
