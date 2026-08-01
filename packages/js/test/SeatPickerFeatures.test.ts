import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SeatPicker, type SeatPickerOptions } from '../src/SeatPicker';
import type { ChartTheme } from '@seatlayer/core';

let container: HTMLDivElement;

/** Construct without render() — these helpers are pure over options/state. */
function picker(overrides: Partial<SeatPickerOptions> = {}): SeatPicker {
  return new SeatPicker({ event: 'ev_test', container, ...overrides });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- exercising private helpers */
const cbSafe = (p: SeatPicker): boolean => (p as any).cbSafe;
const badgeHidden = (p: SeatPicker, theme?: ChartTheme): boolean => (p as any).badgeHidden(theme);
const isSoldOut = (
  p: SeatPicker,
  cats: Array<{ key: string }>,
  left: Record<string, number>,
  hasGA: boolean,
): boolean => (p as any).isSoldOut(cats, left, hasGA);
const tf = (p: SeatPicker, key: string, fallback: string): string => (p as any).tf(key, fallback);

const CB_KEY = 'seatmap.a11y.cb';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  try { window.localStorage.removeItem(CB_KEY); } catch { /* ignore */ }
});

afterEach(() => {
  try { window.localStorage.removeItem(CB_KEY); } catch { /* ignore */ }
});

describe('colorblind persistence (Gap 4)', () => {
  it('falls back to the colorblindSafe option when nothing is stored', () => {
    expect(cbSafe(picker())).toBe(false);
    expect(cbSafe(picker({ colorblindSafe: true }))).toBe(true);
  });

  it('stored preference wins over the option (both directions)', () => {
    window.localStorage.setItem(CB_KEY, '1');
    expect(cbSafe(picker({ colorblindSafe: false }))).toBe(true);
    window.localStorage.setItem(CB_KEY, '0');
    expect(cbSafe(picker({ colorblindSafe: true }))).toBe(false);
  });

  it('uses the SAME key the public page persists under', () => {
    window.localStorage.setItem(CB_KEY, '1');
    expect(cbSafe(picker())).toBe(true);
  });
});

describe('badge visibility (Gap 7)', () => {
  it('shows the badge by default (no option, no theme flag)', () => {
    expect(badgeHidden(picker())).toBe(false);
    expect(badgeHidden(picker(), {})).toBe(false);
  });

  it('hides when the host option is set', () => {
    expect(badgeHidden(picker({ hideBadge: true }))).toBe(true);
  });

  it('hides when the chart theme sets hideBadge (paid orgs)', () => {
    expect(badgeHidden(picker(), { hideBadge: true })).toBe(true);
  });

  it('either flag being true hides it', () => {
    expect(badgeHidden(picker({ hideBadge: true }), { hideBadge: false })).toBe(true);
    expect(badgeHidden(picker({ hideBadge: false }), { hideBadge: true })).toBe(true);
  });
});

describe('sold-out predicate (Gap 2)', () => {
  const cats = [{ key: 'vip' }, { key: 'std' }];

  it('is sold out when every seated category is 0 free', () => {
    expect(isSoldOut(picker(), cats, { vip: 0, std: 0 }, false)).toBe(true);
  });

  it('a fully-booked tier absent from the map still counts as 0', () => {
    // `left` only carries categories with free seats; a missing key = 0 free.
    expect(isSoldOut(picker(), cats, {}, false)).toBe(true);
    expect(isSoldOut(picker(), cats, { vip: 0 }, false)).toBe(true);
  });

  it('is NOT sold out while any seated category has inventory', () => {
    expect(isSoldOut(picker(), cats, { vip: 0, std: 3 }, false)).toBe(false);
  });

  it('is suppressed when GA areas exist (GA capacity is not seat-counted)', () => {
    expect(isSoldOut(picker(), cats, { vip: 0, std: 0 }, true)).toBe(false);
  });

  it('is never sold out with no seated categories', () => {
    expect(isSoldOut(picker(), [], {}, false)).toBe(false);
  });
});

describe('localized fallback helper (tf)', () => {
  it('uses a known key from the bundle over the fallback literal', () => {
    // picker.poweredBy ships in en.ts.
    expect(tf(picker(), 'picker.poweredBy', 'FALLBACK')).toBe('Powered by SeatLayer');
  });

  it('returns the literal fallback for an unknown key', () => {
    expect(tf(picker(), 'picker.__nope__', 'Sold out')).toBe('Sold out');
  });
});

describe('buyer access wiring (M6a)', () => {
  const accessOf = (p: SeatPicker): any => (p as any).access;
  const apiOf = (p: SeatPicker): any => (p as any).api;
  const realtimeOf = (p: SeatPicker): any => (p as any).realtime;

  it('the tokenless picker builds no access context and keeps the original socket URL', () => {
    const p = picker();
    expect(accessOf(p)).toBeNull();
    expect(realtimeOf(p)).toBeNull();
    // PickerController still opens its own legacy socket from this URL.
    expect(apiOf(p).socketUrl('ev_test')).toMatch(/\/pub\/events\/ev_test\/subscribe\?/);
    expect(apiOf(p).accessScoped).toBe(false);
  });

  it('an access-scoped picker binds the transport and hands the socket to the realtime client', () => {
    const p = picker({ buyerAccessToken: 'bse_secret_value' });
    expect(accessOf(p).configured).toBe(true);
    expect(apiOf(p).accessScoped).toBe(true);
    // Empty on purpose: the controller must not race our subprotocol socket.
    expect(apiOf(p).socketUrl('ev_test')).toBe('');
    expect(apiOf(p).subscribeUrl('ev_test')).not.toContain('bse_');
  });

  it('never persists the bearer to storage or cookies', () => {
    picker({ buyerAccessToken: 'bse_secret_value' });
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)!;
      expect(key).not.toContain('bse_');
      expect(window.localStorage.getItem(key)).not.toContain('bse_');
    }
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain('bse_');
  });

  it('leaves a host-supplied transport in charge of its own credentials', () => {
    const transport = { socketUrl: () => 'wss://host.example' } as any;
    const p = picker({ transport, buyerAccessToken: 'bse_secret_value' });
    expect(accessOf(p)).toBeNull();
    expect(apiOf(p)).toBe(transport);
  });

  it('refreshAccess() resolves false on a picker with no access context', async () => {
    await expect(picker().refreshAccess()).resolves.toBe(false);
  });
});
