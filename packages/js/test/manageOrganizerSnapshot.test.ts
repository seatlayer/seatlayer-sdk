/**
 * V1 — the cockpit's seat model must be PHYSICAL state, not the buyer's view.
 *
 * `ManageApi.objects()` used to read `/pub/events/:key/objects` with no
 * credential. That route answers with the buyer projection: every unit the
 * caller may not buy comes back as a neutral `blocked`, and an anonymous
 * caller may buy only Public sale inventory. So a cockpit with 24 seats
 * allocated to a travel agency rendered them as 24 blocked seats — and then
 * computed KPIs, sell-through AND its block/unblock target sets from that.
 *
 * These tests pin the wire contract on both sides of the boundary: the manager
 * authenticates, and the buyer picker still does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageApi } from '../src/manageApi';
import { PubApi } from '../src/api';

interface Call {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}

let calls: Call[] = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init: init as Call['init'] });
    return Promise.resolve(jsonResponse({ seats: {}, updatedAt: 1, ticket: 't', protocols: ['seatlayer.v1', 'tkt.t'] }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ManageApi.objects — the organizer inventory read', () => {
  it('hits the authenticated organizer route, never the buyer projection', async () => {
    const api = new ManageApi('https://api.seatlayer.io/', 'mse_tok');

    await api.objects('ev_1');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.seatlayer.io/v1/events/ev_1/objects');
    expect(calls[0].init.headers?.Authorization).toBe('Bearer mse_tok');
    expect(calls[0].init.credentials).toBe('omit');
    // The bug, as a regression guard: this must never be a /pub read again.
    expect(calls[0].url).not.toContain('/pub/');
  });

  it('follows a re-minted token, so a refresh does not silently drop to /pub', async () => {
    const api = new ManageApi('https://api.seatlayer.io', 'mse_first');
    await api.objects('ev_1');
    api.setToken('mse_second');
    await api.objects('ev_1');
    expect(calls.map((call) => call.init.headers?.Authorization))
      .toEqual(['Bearer mse_first', 'Bearer mse_second']);
  });

  it('leaves the chart read public — geometry is the same map buyers see', async () => {
    const api = new ManageApi('https://api.seatlayer.io', 'mse_tok');
    await api.chart('ev_1');
    expect(calls[0].url).toBe('https://api.seatlayer.io/pub/events/ev_1/chart');
    expect(calls[0].init.headers?.Authorization).toBeUndefined();
  });
});

describe('ManageApi.subscribeTicket — the organizer socket credential', () => {
  it('POSTs to the manage mint with the Bearer and returns what WebSocket wants', async () => {
    const api = new ManageApi('https://api.seatlayer.io', 'mse_tok');

    const ticket = await api.subscribeTicket('ev_1');

    expect(calls[0].url).toBe('https://api.seatlayer.io/v1/events/ev_1/subscribe-tickets');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers?.Authorization).toBe('Bearer mse_tok');
    expect(calls[0].init.credentials).toBe('omit');
    // The ticket rides in Sec-WebSocket-Protocol — never in the URL.
    expect(ticket.protocols).toEqual(['seatlayer.v1', 'tkt.t']);
    expect(api.socketUrl('ev_1')).not.toContain('tkt.');
    expect(api.socketUrl('ev_1')).not.toContain('mse_tok');
  });
});

describe('the buyer picker is untouched', () => {
  it('still reads /pub with no credential of any kind', async () => {
    const api = new PubApi('https://api.seatlayer.io');

    await api.objects('ev_1');
    await api.chart('ev_1');

    for (const call of calls) {
      expect(call.url).toContain('/pub/events/ev_1/');
      expect(call.url).not.toContain('/v1/');
      expect(call.init.headers?.Authorization).toBeUndefined();
    }
    expect(new PubApi('https://api.seatlayer.io').socketUrl('ev_1')).toContain('/pub/events/ev_1/subscribe');
  });
});
