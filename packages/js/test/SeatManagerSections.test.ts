import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvailabilityRule } from '@seatlayer/core';
import { ManageApi } from '../src/manageApi';
import { availabilityModeOf, availabilityRuleForMode } from '../src/SeatManager';

/** A minimal JSON Response stand-in for the fetch mock (ManageApi.parse reads
 *  `ok`, `status`, `headers.get('content-type')` and `json()`). */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ManageApi availability windows', () => {
  it('GET /availability sends the Bearer token and returns the rules map', async () => {
    const rules: Record<string, AvailabilityRule> = {
      'zone-a': { mode: 'hidden', labels: ['A1', 'A2'] },
      'sec-9': { mode: 'threshold', thresholdPct: 80, labels: ['B1'] },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ rules }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ManageApi('https://api.seatlayer.io/', 'mse_tok');

    const res = await api.availability('west-end-p3');

    expect(res.rules).toEqual(rules);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.seatlayer.io/v1/events/west-end-p3/availability');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer mse_tok');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
  });

  it('POST /availability sends {rules} as JSON and returns the cleaned map + hidden set', async () => {
    const sent: Record<string, AvailabilityRule> = {
      'zone-a': { mode: 'closed', labels: ['A1'] },
      'sec-9': { mode: 'timed', revealAt: 1_900_000_000_000, labels: ['B1'] },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, hidden: ['sec-9'], rules: sent }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = new ManageApi('https://api.seatlayer.io', 'sk_secret');

    const res = await api.setAvailability('ev_1', sent);

    expect(res.ok).toBe(true);
    expect(res.hidden).toEqual(['sec-9']);
    expect(res.rules).toEqual(sent);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.seatlayer.io/v1/events/ev_1/availability');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ rules: sent });
  });

  it('URL-encodes the event key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ rules: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ManageApi('https://api.seatlayer.io', 'mse_tok');

    await api.availability('a/b c');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.seatlayer.io/v1/events/a%2Fb%20c/availability');
  });
});

describe('rules → select-state mapping', () => {
  it('an absent rule is the "open" (on-sale) select state', () => {
    expect(availabilityModeOf(null)).toBe('open');
    expect(availabilityModeOf(undefined)).toBe('open');
  });

  it('a rule maps to its own mode', () => {
    expect(availabilityModeOf({ mode: 'hidden' })).toBe('hidden');
    expect(availabilityModeOf({ mode: 'closed' })).toBe('closed');
    expect(availabilityModeOf({ mode: 'timed', revealAt: 1 })).toBe('timed');
    expect(availabilityModeOf({ mode: 'threshold', thresholdPct: 80 })).toBe('threshold');
  });
});

describe('select-state → rule mapping', () => {
  const labels = ['A1', 'A2', 'A3'];

  it('"open" clears the rule (null → id dropped from the map)', () => {
    expect(availabilityRuleForMode('open', labels)).toBeNull();
  });

  it('hidden / closed carry the seat labels only', () => {
    expect(availabilityRuleForMode('hidden', labels)).toEqual({ mode: 'hidden', labels });
    expect(availabilityRuleForMode('closed', labels)).toEqual({ mode: 'closed', labels });
  });

  it('threshold defaults to 80% and preserves an existing percent', () => {
    const fresh = availabilityRuleForMode('threshold', labels);
    expect(fresh).toEqual({ mode: 'threshold', thresholdPct: 80, labels });
    const kept = availabilityRuleForMode('threshold', labels, { mode: 'threshold', thresholdPct: 55 });
    expect(kept).toEqual({ mode: 'threshold', thresholdPct: 55, labels });
  });

  it('timed defaults to a future reveal time and preserves an existing one', () => {
    const before = Date.now();
    const fresh = availabilityRuleForMode('timed', labels) as AvailabilityRule;
    expect(fresh.mode).toBe('timed');
    expect(fresh.revealAt!).toBeGreaterThan(before);
    expect(fresh.labels).toEqual(labels);
    const kept = availabilityRuleForMode('timed', labels, { mode: 'timed', revealAt: 1_900_000_000_000 });
    expect(kept).toEqual({ mode: 'timed', revealAt: 1_900_000_000_000, labels });
  });

  it('switching modes carries prior tuning over from the previous rule', () => {
    // threshold→timed keeps nothing threshold-specific, but timed→timed keeps revealAt
    const prev: AvailabilityRule = { mode: 'threshold', thresholdPct: 42, labels };
    const toTimed = availabilityRuleForMode('timed', labels, prev) as AvailabilityRule;
    expect(toTimed.revealAt).toBeGreaterThan(Date.now()); // no revealAt on prev → default
  });
});
