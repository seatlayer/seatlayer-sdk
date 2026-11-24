/**
 * The wrapper starts the chart's first request during render, not after React
 * commits (the mount adopts it, so the page still makes one request).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const order: string[] = [];
const prewarms: Array<Record<string, unknown>> = [];
const realPrewarm = { fn: null as null | ((options: never) => void) };

vi.mock('@seatlayer/js', async () => {
  const actual = await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js');
  realPrewarm.fn = actual.prewarmSeatPicker as never;
  return {
    ...actual,
    prewarmSeatPicker: (options: Record<string, unknown>) => {
      order.push(`prewarm:${String(options.event)}`);
      prewarms.push(options);
      if (process.env.__REAL_PREWARM === '1') realPrewarm.fn!(options as never);
    },
    SeatingChart: class {
      constructor(options: Record<string, unknown>) { order.push(`construct:${String(options.event)}`); }
      render() { return Promise.resolve(); }
      destroy() { order.push('destroy'); }
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  order.length = 0;
  prewarms.length = 0;
  delete process.env.__REAL_PREWARM;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const PK = `pk_live_${'a'.repeat(48)}`;

describe('SeatingChart starts its bootstrap at render', () => {
  it('prewarms the exact identity before the chart is constructed, once per identity', async () => {
    const { SeatingChart } = await import('../src/SeatingChart');
    await act(async () => { root.render(createElement(SeatingChart, { event: 'ev_1', publicKey: PK, apiBase: 'https://api.example.test' })); });
    expect(order).toEqual(['prewarm:ev_1', 'construct:ev_1']);
    expect(prewarms[0]).toEqual({ event: 'ev_1', publicKey: PK, apiBase: 'https://api.example.test' });

    // A callback change re-renders without a rebuild: no new request.
    await act(async () => { root.render(createElement(SeatingChart, { event: 'ev_1', publicKey: PK, apiBase: 'https://api.example.test', onHold: () => undefined })); });
    expect(order).toEqual(['prewarm:ev_1', 'construct:ev_1']);

    // A new event: one prewarm, then its rebuild adopts it.
    await act(async () => { root.render(createElement(SeatingChart, { event: 'ev_2', publicKey: PK, apiBase: 'https://api.example.test' })); });
    expect(order).toEqual(['prewarm:ev_1', 'construct:ev_1', 'prewarm:ev_2', 'destroy', 'construct:ev_2']);
  });

  it('never prewarms without a public key or with host-supplied buyer access', async () => {
    const { SeatingChart } = await import('../src/SeatingChart');
    await act(async () => { root.render(createElement(SeatingChart, { event: 'ev_1' })); });
    await act(async () => { root.render(createElement(SeatingChart, { event: 'ev_2', publicKey: PK, buyerAccessToken: 'bse_x' })); });
    await act(async () => { root.render(createElement(SeatingChart, { event: 'ev_3', publicKey: PK, buyerAccessTokenProvider: async () => 'bse_y' })); });
    expect(prewarms).toEqual([]);
  });

  it('StrictMode double render starts ONE bootstrap request and nothing else (no hold)', async () => {
    process.env.__REAL_PREWARM = '1';
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
      return new Promise<Response>(() => undefined); // in flight for the whole test
    }));
    const { SeatingChart } = await import('../src/SeatingChart');
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(SeatingChart, { event: 'ev_strict', publicKey: PK, apiBase: 'https://api.example.test' })));
    });
    expect(calls).toEqual(['POST /pub/events/ev_strict/bootstrap']);
  });
});
