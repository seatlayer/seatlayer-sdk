/**
 * The cockpit's numbers — the four defects these cover were all invisible to a
 * green suite, because every one of them lived in the gap between what the
 * client models and what the server actually sells:
 *
 *   1. **GA units were counted in the numerator but not the denominator.**
 *      `expandChart` has no output for a GA area, so the client's seat universe
 *      excluded its capacity — while `applySnapshot` wrote every key of the
 *      server's seat map (GA labels included) into `status`. Free under-reported
 *      by the whole GA capacity, and once GA started selling SOLD% overstated
 *      and could pass 100%.
 *   2. **Presence frames before the first control-room fetch were dropped.**
 *      The handler was gated on a snapshot already existing — which is exactly
 *      false in the window right after connect.
 *   3. **Gross sales froze on a GA-only sale.** The refetch was gated on a
 *      delta producing renderer ids; GA labels produce none. Money now rides
 *      the delta frame and nothing polls for it.
 *   4. **Tallies re-walked the whole status Map per frame.** They are moved by
 *      each transition now, so this file pins the incremental counters against
 *      a full recompute over a random delta sequence.
 *
 * Style follows the repo's other wrapper tests: construct WITHOUT `render()`
 * (which would need the network and Konva) and drive the private surface, which
 * is the same code path `render()` runs. No Konva hit-testing, no text metrics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartDoc } from '@seatlayer/core';
import { gaUnitLabel } from '@seatlayer/core';
import { SeatManager } from '../src/SeatManager';
import type { ControlRoomSnapshot } from '../src/manageApi';

/* eslint-disable @typescript-eslint/no-explicit-any -- exercising private state, as the sibling wrapper tests do */

const GA_AREA_ID = 'ga-pit';

/** Four seats in one row plus a six-unit GA pit: ten sellable units, of which
 *  only four have geometry the renderer can bind to. */
function chartWithGA(gaCapacity = 6): ChartDoc {
  return {
    version: 1,
    name: 'Tally fixture',
    venueType: 'MIXED',
    focalPoint: { x: 0, y: -100 },
    categories: [{ key: 'std', label: 'Standard', color: '#6e7bff', price: 10 }],
    objects: [
      {
        type: 'row',
        id: 'row-a',
        label: 'A',
        origin: { x: 0, y: 0 },
        rotation: 0,
        curve: 0,
        seatCount: 4,
        seatSpacing: 10,
        categoryKey: 'std',
      },
      {
        type: 'gaArea',
        id: GA_AREA_ID,
        label: 'Pit',
        points: [{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 120 }, { x: 0, y: 120 }],
        capacity: gaCapacity,
        categoryKey: 'std',
      },
    ],
  } as ChartDoc;
}

/** A control-room snapshot whose totals are the server's own, GA-correct view. */
function snapshot(over: Partial<ControlRoomSnapshot> = {}): ControlRoomSnapshot {
  return {
    version: 1,
    currency: 'EUR',
    totals: { free: 10, held: 0, booked: 0, blocked: 0 },
    revenue: { gross: 0, bySection: [] },
    velocity: { windowMinutes: 15, bySection: [] },
    presence: { shoppingSessions: 0, activeHolds: 0 },
    event: { key: 'ev_1', name: 'Fixture', seatTotal: 10, currency: 'EUR' },
    ...over,
  };
}

let container: HTMLDivElement;

/** A manager with its unit universe built, and no socket or fetch anywhere. */
function manager(doc: ChartDoc | null = chartWithGA()): any {
  const m: any = new SeatManager({ container, eventKey: 'ev_1', token: 'mse_tok' });
  if (doc) m.buildUnitUniverse(doc);
  return m;
}

/** Feed one wire frame through the real socket handler. */
function frame(m: any, payload: unknown): void {
  m.onMessage({ data: JSON.stringify(payload) } as MessageEvent);
}

const gaLabels = (n: number): string[] =>
  Array.from({ length: n }, (_, index) => gaUnitLabel(GA_AREA_ID, index));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

describe('GA units are inventory, so they are in the denominator', () => {
  it('registers every GA unit label without giving it a render binding', () => {
    const m = manager();

    // Seats are the only thing the renderer can address.
    expect(m.labelToId.size).toBe(4);
    expect(m.allIds).toHaveLength(4);
    expect(m.labelToSeat.size).toBe(4);
    // GA capacity is modelled, but deliberately unpaintable.
    expect(m.gaUnitLabelSet.size).toBe(6);
    for (const label of gaLabels(6)) {
      expect(m.gaUnitLabelSet.has(label)).toBe(true);
      expect(m.labelToId.has(label)).toBe(false);
      expect(m.labelToSeat.has(label)).toBe(false);
    }
    expect(m.unitTotal()).toBe(10);
  });

  it('counts a GA sale in BOTH the numerator and the denominator', () => {
    const m = manager();
    const [ga1] = gaLabels(6);

    m.applySnapshot({ 'A-1': 'booked', [ga1]: 'booked' });

    const t = m.buildTallies();
    expect(t.total).toBe(10);
    expect(t.booked).toBe(2);
    // The defect: total was 4 (seats only) while booked was 2 → 50% and 2 free.
    expect(t.free).toBe(8);
    expect(t.capacityPct).toBe(20);
  });

  it('cannot report over 100% sold when only GA sells', () => {
    const m = manager();

    m.applySnapshot(Object.fromEntries(gaLabels(6).map((label) => [label, 'booked'])));

    const t = m.buildTallies();
    // Numerator 6 over a seats-only denominator of 4 used to be 150%.
    expect(t.capacityPct).toBe(60);
    expect(t.free).toBe(4);
    expect(t.booked).toBe(6);
  });

  it('gives GA units the compact snapshot\'s modal status like any other unit', () => {
    const m = manager();

    frame(m, { type: 'snapshot', default: 'blocked', seats: { 'A-1': 'free' } });

    const t = m.buildTallies();
    expect(t.blocked).toBe(9);
    expect(t.free).toBe(1);
  });

  it('paints no seat for a GA delta, and still moves the tally', () => {
    const m = manager();
    const setStatus = vi.fn();
    m.renderer = {
      setStatus, flashSeat: vi.fn(), forceDraw: vi.fn(),
      getFocusedSection: () => null, pulseSection: vi.fn(),
    };
    m.applySnapshot({});
    setStatus.mockClear(); // the snapshot's own full repaint is not what is under test

    frame(m, { type: 'delta', protocol: 1, changes: [{ label: gaLabels(1)[0], status: 'booked' }], ts: 1 });

    expect(setStatus).not.toHaveBeenCalled();
    expect(m.buildTallies().booked).toBe(1);
  });
});

describe('the server stays the authority for the KPI numbers', () => {
  it('renders the server totals and seatTotal once a snapshot has landed', () => {
    const m = manager();
    m.applySnapshot({});
    // A server that knows about inventory this client does not.
    m.controlRoomSnapshot = snapshot({
      totals: { free: 40, held: 5, booked: 50, blocked: 5 },
      event: { key: 'ev_1', name: 'Fixture', seatTotal: 100 },
    });
    m.rebaseServerTotals(m.controlRoomSnapshot);

    const t = m.buildTallies();
    expect(t).toMatchObject({ free: 40, held: 5, booked: 50, blocked: 5, total: 100, capacityPct: 50 });
  });

  it('lets deltas carry the server numbers forward between reads', () => {
    const m = manager();
    m.applySnapshot({});
    m.controlRoomSnapshot = snapshot({
      totals: { free: 40, held: 5, booked: 50, blocked: 5 },
      event: { key: 'ev_1', name: 'Fixture', seatTotal: 100 },
    });
    m.rebaseServerTotals(m.controlRoomSnapshot);

    frame(m, { type: 'delta', protocol: 1, changes: [{ label: 'A-1', status: 'booked' }], ts: 2 });

    // Not frozen at the read, and not reset to the client's own small model.
    expect(m.buildTallies()).toMatchObject({ booked: 51, free: 39 });
  });

  it('falls back to the client model before the first snapshot', () => {
    const m = manager();
    m.applySnapshot({ 'A-1': 'held' });

    expect(m.controlRoomSnapshot).toBeNull();
    expect(m.buildTallies()).toMatchObject({ total: 10, held: 1, free: 9 });
  });

  it('drops a baseline whose client model was replaced underneath it', () => {
    const m = manager();
    m.applySnapshot({});
    m.controlRoomSnapshot = snapshot({
      totals: { free: 40, held: 5, booked: 50, blocked: 5 },
      event: { key: 'ev_1', name: 'Fixture', seatTotal: 100 },
    });
    m.rebaseServerTotals(m.controlRoomSnapshot);

    // A fresh authenticated read replaces the whole model: the old pairing would
    // otherwise double-count, adding the new booked seats on top of the server's.
    m.applySnapshot({ 'A-1': 'booked', 'A-2': 'booked' });

    expect(m.buildTallies()).toMatchObject({ booked: 2, total: 100 });
  });
});

describe('presence arrives before the first control-room fetch', () => {
  it('keeps a presence frame that lands with no snapshot yet', () => {
    const m = manager();

    frame(m, { type: 'presence', shoppingSessions: 12, activeHolds: 5, ts: 1 });

    // The defect: gated on `this.controlRoomSnapshot`, so this frame vanished.
    expect(m.presenceCounts()).toEqual({ shoppingSessions: 12, activeHolds: 5 });
  });

  it('merges that presence into the snapshot the fetch then delivers', async () => {
    const m = manager();
    let resolveFetch: (value: ControlRoomSnapshot) => void = () => {};
    m.api.controlRoom = vi.fn(() => new Promise<ControlRoomSnapshot>((resolve) => { resolveFetch = resolve; }));

    const inFlight = m.refreshControlRoom();
    frame(m, { type: 'presence', shoppingSessions: 12, activeHolds: 5, ts: 1 });
    resolveFetch(snapshot({ presence: { shoppingSessions: 0, activeHolds: 0 } }));
    await inFlight;

    // The frame is newer than the response it raced, so it survives it.
    expect(m.controlRoomSnapshot.presence).toEqual({ shoppingSessions: 12, activeHolds: 5 });
    expect(m.presenceCounts()).toEqual({ shoppingSessions: 12, activeHolds: 5 });
  });

  it('defers to the fetch for presence recorded before the request started', async () => {
    const m = manager();
    frame(m, { type: 'presence', shoppingSessions: 12, activeHolds: 5, ts: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    m.api.controlRoom = vi.fn().mockResolvedValue(snapshot({ presence: { shoppingSessions: 3, activeHolds: 1 } }));

    await m.refreshControlRoom();

    expect(m.presenceCounts()).toEqual({ shoppingSessions: 3, activeHolds: 1 });
  });

  it('paints the live counts into the KPI bar with no snapshot at all', () => {
    const m = manager();
    m.els.kpis = document.createElement('div');

    frame(m, { type: 'presence', shoppingSessions: 12, activeHolds: 5, ts: 1 });
    m.flushTallies();

    const carts = m.els.kpis.querySelector('[data-kpi="carts"]');
    expect(carts?.querySelector('b')?.textContent).toContain('5');
    expect(m.els.kpis.querySelector('[data-kpi="buyers"] b')?.textContent).toContain('12');
  });
});

describe('gross sales rides the delta frame instead of a poll', () => {
  it('adopts revenue.gross without fetching the control room', async () => {
    const m = manager();
    m.api.controlRoom = vi.fn().mockResolvedValue(snapshot());
    m.applySnapshot({});

    frame(m, {
      type: 'delta',
      protocol: 1,
      snapshotVersion: 7,
      changes: [{ label: gaLabels(1)[0], status: 'booked' }],
      revenue: { gross: 4250 },
      ts: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 200)); // past the old 140ms debounce

    expect(m.api.controlRoom).not.toHaveBeenCalled();
    expect(m.buildTallies()).toMatchObject({ grossRevenue: 4250, revenueStatus: 'current' });
  });

  it('writes the live figure into the snapshot when one already exists', () => {
    const m = manager();
    const seen: ControlRoomSnapshot[] = [];
    m.opts.onControlRoom = (s: ControlRoomSnapshot) => seen.push(s);
    m.controlRoomSnapshot = snapshot({ revenue: { gross: 100, bySection: [] } });
    m.applySnapshot({});

    frame(m, { type: 'delta', protocol: 1, changes: [{ label: 'A-1', status: 'booked' }], revenue: { gross: 350 }, ts: 4 });

    expect(m.controlRoomSnapshot.revenue.gross).toBe(350);
    expect(seen.at(-1)?.revenue.gross).toBe(350);
  });

  it('stashes the figure when no snapshot exists yet and applies it on arrival', async () => {
    const m = manager();
    let resolveFetch: (value: ControlRoomSnapshot) => void = () => {};
    m.api.controlRoom = vi.fn(() => new Promise<ControlRoomSnapshot>((resolve) => { resolveFetch = resolve; }));
    m.applySnapshot({});

    const inFlight = m.refreshControlRoom();
    frame(m, { type: 'delta', protocol: 1, changes: [{ label: 'A-1', status: 'booked' }], revenue: { gross: 900 }, ts: 5 });
    resolveFetch(snapshot({ revenue: { gross: 100, bySection: [] } }));
    await inFlight;

    expect(m.controlRoomSnapshot.revenue.gross).toBe(900);
    expect(m.buildTallies().grossRevenue).toBe(900);
  });

  it('survives an older worker whose frames carry no revenue at all', () => {
    const m = manager();
    m.applySnapshot({});
    m.authoritativeGrossRevenue = 500;
    m.revenueStatus = 'current';

    frame(m, { type: 'delta', protocol: 1, changes: [{ label: 'A-1', status: 'booked' }], ts: 6 });

    expect(m.buildTallies()).toMatchObject({ grossRevenue: 500, revenueStatus: 'current' });
  });

  it('ignores a non-numeric revenue field rather than blanking the money', () => {
    const m = manager();
    m.applySnapshot({});
    m.authoritativeGrossRevenue = 500;
    m.revenueStatus = 'current';

    frame(m, { type: 'delta', protocol: 1, changes: [{ label: 'A-1', status: 'held' }], revenue: { gross: 'lots' }, ts: 7 });

    expect(m.buildTallies().grossRevenue).toBe(500);
  });
});

describe('the tallies are moved, not re-walked', () => {
  it('matches a full recompute after a random delta sequence', () => {
    const m = manager(chartWithGA(20));
    const labels = [...m.labelToId.keys(), ...m.gaUnitLabelSet];
    const statuses = ['free', 'held', 'booked', 'blocked'];
    // Deterministic pseudo-random: a failure has to be reproducible.
    let seed = 0x2f6e2b1;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };

    m.applySnapshot({ 'A-1': 'held', [labels[6]]: 'booked' });
    for (let round = 0; round < 60; round++) {
      const changes = Array.from({ length: 1 + next(5) }, () => ({
        label: labels[next(labels.length)],
        status: statuses[next(statuses.length)],
      }));
      frame(m, { type: 'delta', protocol: 1, changes, ts: round });
    }

    const walked = { held: 0, booked: 0, blocked: 0 };
    for (const status of m.status.values()) if (status !== 'free') walked[status as 'held'] += 1;
    expect(m.counts).toEqual(walked);

    const total = m.unitTotal();
    expect(m.buildTallies()).toMatchObject({
      ...walked,
      total,
      free: total - walked.held - walked.booked - walked.blocked,
    });
  });

  it('re-bases the counters when the whole model is replaced', () => {
    const m = manager();
    frame(m, { type: 'delta', protocol: 1, changes: [{ label: 'A-1', status: 'booked' }], ts: 1 });
    expect(m.counts.booked).toBe(1);

    m.applySnapshot({ 'A-2': 'held', 'A-3': 'held' });

    expect(m.counts).toEqual({ held: 2, booked: 0, blocked: 0 });
  });

  it('coalesces a burst of frames into one KPI repaint', async () => {
    const m = manager();
    m.els.kpis = document.createElement('div');
    m.applySnapshot({});
    const paint = vi.spyOn(m, 'paintKpis');

    for (let i = 1; i <= 4; i++) {
      frame(m, { type: 'delta', protocol: 1, changes: [{ label: `A-${i}`, status: 'booked' }], ts: i });
    }
    expect(paint).not.toHaveBeenCalled(); // nothing painted synchronously
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0][0]).toMatchObject({ booked: 4 });
  });

  it('cancels a queued repaint on destroy', async () => {
    const m = manager();
    m.els.kpis = document.createElement('div');
    m.applySnapshot({});
    const paint = vi.spyOn(m, 'paintKpis');

    frame(m, { type: 'delta', protocol: 1, changes: [{ label: 'A-1', status: 'booked' }], ts: 1 });
    m.destroy();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(m.paintHandle).toBeNull();
    expect(paint).not.toHaveBeenCalled();
  });
});

describe('the KPI bar names its units honestly', () => {
  it('groups the seat tallies together and the session-scale pair together', () => {
    const m = manager();
    m.els.kpis = document.createElement('div');
    m.applySnapshot({});
    m.flushTallies();

    const keys = [...m.els.kpis.querySelectorAll('[data-kpi]')]
      .map((node: Element) => (node as HTMLElement).dataset.kpi);
    expect(keys).toEqual([
      'sold-seats', 'held-seats', 'free-seats', 'blocked', 'buyers', 'carts', 'sold-pct', 'gross-sales',
    ]);
    // The defect: "Held seats" (seat units) sat directly beside "Active holds"
    // (checkout sessions) with nothing saying they were different quantities.
    expect(keys.indexOf('carts') - keys.indexOf('held-seats')).toBeGreaterThan(1);
  });

  it('calls the session count a Cart, never an unqualified hold', () => {
    const m = manager();
    m.els.kpis = document.createElement('div');
    m.applySnapshot({});
    m.flushTallies();

    expect(m.els.kpis.querySelector('[data-kpi="carts"] span')?.textContent).toBe('Carts');
    expect(m.els.kpis.textContent).not.toContain('Active holds');
    expect(m.els.kpis.querySelector('[data-kpi="held-seats"]')?.getAttribute('title'))
      .toContain('Seats');
    expect(m.els.kpis.querySelector('[data-kpi="carts"]')?.getAttribute('title'))
      .toContain('sessions, not seats');
  });

  it('uses the same two words on the Monitor rail', () => {
    const m = manager();
    m.els.presence = document.createElement('div');
    m.livePresence = { at: Date.now(), value: { shoppingSessions: 7, activeHolds: 2 } };

    m.paintMonitorInsights();

    const words = [...m.els.presence.querySelectorAll('span')].map((n: Element) => n.textContent);
    expect(words).toContain('Buyers');
    expect(words).toContain('Carts');
    expect(words).not.toContain('Active holds');
  });
});
