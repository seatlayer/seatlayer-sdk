import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createElement, createRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SeatPickerHandle } from '../src/SeatPicker';

/**
 * Regression guard for a silent prop drop.
 *
 * `SeatPickerProps extends Omit<SeatPickerOptions, 'container'>`, so every core
 * option type-checks on the React component whether or not the wrapper actually
 * forwards it. Between 0.17 and 0.19 the wrapper destructured a hand-maintained
 * field list, so `pricing`, `hideBadge` and `transport` were accepted by the
 * compiler and then discarded at runtime — a host wiring up host-authoritative
 * pricing got a green build and wrong prices, with no signal anywhere.
 *
 * These tests assert against the options object the core class actually
 * receives, so any future option that the wrapper forgets fails here.
 */

const constructorCalls: Array<Record<string, unknown>> = [];
const imperativeCalls: Array<{ method: string; args: unknown[] }> = [];

vi.mock('@seatlayer/js', () => ({
  SeatPicker: class {
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options);
    }
    render() {
      return Promise.resolve();
    }
    close() { imperativeCalls.push({ method: 'close', args: [] }); }
    getSelection() { return []; }
    bestAvailable(...args: unknown[]) {
      imperativeCalls.push({ method: 'bestAvailable', args });
      return Promise.resolve({ holdId: 'hold-1', expiresAt: 123, seats: [] });
    }
    getCurrentHold() { return null; }
    resumeHold() { return Promise.resolve(null); }
    removeHeldTicket() { return Promise.resolve(false); }
    release() { return Promise.resolve(); }
    refreshAccess() {
      imperativeCalls.push({ method: 'refreshAccess', args: [] });
      return Promise.resolve(true);
    }
    setMapTheme(...args: unknown[]) { imperativeCalls.push({ method: 'setMapTheme', args }); }
    setEventDetailsHidden(...args: unknown[]) {
      imperativeCalls.push({ method: 'setEventDetailsHidden', args });
    }
    setPricing(...args: unknown[]) { imperativeCalls.push({ method: 'setPricing', args }); }
    isColorblindSafe() {
      imperativeCalls.push({ method: 'isColorblindSafe', args: [] });
      return true;
    }
    setColorblindSafe(...args: unknown[]) {
      imperativeCalls.push({ method: 'setColorblindSafe', args });
    }
    setViewMode(...args: unknown[]) { imperativeCalls.push({ method: 'setViewMode', args }); }
    getViewMode() {
      imperativeCalls.push({ method: 'getViewMode', args: [] });
      return 'isometric';
    }
    getBuyerView() {
      imperativeCalls.push({ method: 'getBuyerView', args: [] });
      return 'venue3d';
    }
    setBuyerView(...args: unknown[]) { imperativeCalls.push({ method: 'setBuyerView', args }); }
    destroy() { imperativeCalls.push({ method: 'destroy', args: [] }); }
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  constructorCalls.length = 0;
  imperativeCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mount the wrapper with `props` and return the options core was constructed with. */
async function mountWith(props: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { SeatPicker } = await import('../src/SeatPicker');
  await act(async () => {
    root.render(createElement(SeatPicker, { event: 'evt_test', ...props } as never));
  });
  expect(constructorCalls).toHaveLength(1);
  return constructorCalls[0]!;
}

describe('SeatPicker prop forwarding', () => {
  it('forwards pricing — the option whose loss silently mispriced tickets', async () => {
    const pricing = { categories: { vip: 12000 } };
    const options = await mountWith({ pricing });
    expect(options.pricing).toEqual(pricing);
  });

  it('forwards hideBadge and transport', async () => {
    const transport = { socketUrl: () => 'wss://example.test' };
    const options = await mountWith({ hideBadge: true, transport });
    expect(options.hideBadge).toBe(true);
    expect(options.transport).toBe(transport);
  });

  it('forwards an option the wrapper never names, so new core options cannot be dropped', async () => {
    // Stands in for whatever ships next: the wrapper must not filter by name.
    const options = await mountWith({ someFutureOption: 'forwarded' });
    expect(options.someFutureOption).toBe('forwarded');
  });

  it('forwards selection validators and rebuilds when their policy identity changes', async () => {
    const { SeatPicker } = await import('../src/SeatPicker');
    const initial = [{ type: 'minimumSelectedPlaces' as const, minimum: 2 }];
    await act(async () => {
      root.render(createElement(SeatPicker, { event: 'evt_test', selectionValidators: initial }));
    });
    expect(constructorCalls[0]).toMatchObject({ selectionValidators: initial });

    const next = [{ type: 'noOrphanSeats' as const }];
    await act(async () => {
      root.render(createElement(SeatPicker, { event: 'evt_test', selectionValidators: next }));
    });
    expect(constructorCalls).toHaveLength(2);
    expect(constructorCalls[1]).toMatchObject({ selectionValidators: next });
    expect(imperativeCalls).toContainEqual({ method: 'destroy', args: [] });
  });

  it('keeps React-only props out of the core options', async () => {
    const options = await mountWith({ className: 'w-full', style: { height: 400 } });
    expect(options).not.toHaveProperty('className');
    expect(options).not.toHaveProperty('style');
  });

  it('passes the container element through', async () => {
    const options = await mountWith({});
    expect(options.container).toBeInstanceOf(HTMLElement);
  });

  it('forwards the buyer access options and the typed access callbacks', async () => {
    const buyerAccessTokenProvider = vi.fn(async () => ({ token: 'bse_x' }));
    const onAccessExpired = vi.fn();
    const onAccessUnavailable = vi.fn();
    const onSelectedObjectUnavailable = vi.fn();
    const options = await mountWith({
      buyerAccessTokenProvider,
      buyerAccessToken: 'bse_seed',
      onAccessExpired,
      onAccessUnavailable,
      onSelectedObjectUnavailable,
    });

    expect(options.buyerAccessToken).toBe('bse_seed');
    // The provider is wrapped (so an inline arrow never rebuilds the widget),
    // but it must still reach the host function it stands for.
    await (options.buyerAccessTokenProvider as (c: unknown) => Promise<unknown>)({ reason: 'initial' });
    expect(buyerAccessTokenProvider).toHaveBeenCalledWith({ reason: 'initial' });

    (options.onAccessExpired as (e: unknown) => void)({ reason: 'unauthorized', refreshed: false });
    (options.onAccessUnavailable as (e: unknown) => void)({ reason: 'revoked', retryable: false });
    (options.onSelectedObjectUnavailable as (e: unknown) => void)({ labels: ['A-1'], reason: 'taken' });
    expect(onAccessExpired).toHaveBeenCalledWith({ reason: 'unauthorized', refreshed: false });
    expect(onAccessUnavailable).toHaveBeenCalledWith({ reason: 'revoked', retryable: false });
    expect(onSelectedObjectUnavailable).toHaveBeenCalledWith({ labels: ['A-1'], reason: 'taken' });
  });

  it('leaves the provider undefined when the host did not pass one', async () => {
    const options = await mountWith({});
    expect(options.buyerAccessTokenProvider).toBeUndefined();
  });

  it('forwards the safe imperative picker contract and best-available options', async () => {
    const { SeatPicker } = await import('../src/SeatPicker');
    const ref = createRef<SeatPickerHandle>();
    await act(async () => {
      root.render(createElement(SeatPicker, { event: 'evt_test', ref }));
    });
    const handle = ref.current!;
    const mapTheme = { background: '#101820', selectionColor: '#f6be00' };
    const pricing = { prices: { vip: 125 } };

    handle.setMapTheme(mapTheme);
    handle.setEventDetailsHidden(true);
    handle.setPricing(pricing);
    expect(handle.isColorblindSafe()).toBe(true);
    handle.setColorblindSafe(true);
    handle.setViewMode('isometric');
    expect(handle.getViewMode()).toBe('isometric');
    expect(handle.getBuyerView()).toBe('venue3d');
    handle.setBuyerView('venue3d', { flyToSeatId: 'seat-12', resetView: true });
    await expect(
      handle.bestAvailable(3, 'vip', { preferPremium: true, zoneId: 'floor' }),
    ).resolves.toMatchObject({ holdId: 'hold-1' });
    await expect(handle.refreshAccess()).resolves.toBe(true);
    handle.close();
    // A host normally follows logical close by removing/changing the component.
    // Cleanup must not destroy the already-closed core instance a second time.
    await act(async () => {
      root.render(createElement(SeatPicker, { event: 'evt_next', ref }));
    });

    expect(imperativeCalls).toEqual([
      { method: 'setMapTheme', args: [mapTheme] },
      { method: 'setEventDetailsHidden', args: [true] },
      { method: 'setPricing', args: [pricing] },
      { method: 'isColorblindSafe', args: [] },
      { method: 'setColorblindSafe', args: [true] },
      { method: 'setViewMode', args: ['isometric'] },
      { method: 'getViewMode', args: [] },
      { method: 'getBuyerView', args: [] },
      { method: 'setBuyerView', args: ['venue3d', { flyToSeatId: 'seat-12', resetView: true }] },
      { method: 'bestAvailable', args: [3, 'vip', { preferPremium: true, zoneId: 'floor' }] },
      { method: 'refreshAccess', args: [] },
      { method: 'close', args: [] },
    ]);
  });
});
