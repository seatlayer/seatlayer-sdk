import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const instances: MockManager[] = [];

class MockManager {
  options: Record<string, unknown>;
  render = vi.fn(() => Promise.resolve());
  destroy = vi.fn();
  setToken = vi.fn();
  setCapabilities = vi.fn();
  setCurrency = vi.fn();
  setTheme = vi.fn();
  setThemeMode = vi.fn();
  setKeepLiveWhileHidden = vi.fn();
  setTokenRefresh = vi.fn();
  setMode = vi.fn();
  setFollowLive = vi.fn();
  setSelectableObjects = vi.fn();
  setUnavailableObjectsSelectable = vi.fn();
  setUnavailableObjects = vi.fn();
  setCategoryPrices = vi.fn();
  setMaxSelectedObjects = vi.fn();
  setNumberOfPlacesToSelect = vi.fn();
  setObjectSelectable = vi.fn();
  setSale = vi.fn();
  setMapInsets = vi.fn();
  showObjects = vi.fn();

  constructor(options: Record<string, unknown>) {
    this.options = options;
    instances.push(this);
  }
}

vi.mock('@seatlayer/js/manager', () => ({ SeatManager: MockManager }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  instances.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SeatManager reactive props', () => {
  it('updates authority, display, and liveness options without rebuilding the board', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    const firstTheme = { accent: '#111111' };
    await act(async () => {
      root.render(createElement(SeatManager, {
        eventKey: 'ev_1', token: 'mse_one', capabilities: ['event:channels:view'],
        currency: 'USD', theme: firstTheme, keepLiveWhileHidden: true,
      }));
    });
    const instance = instances[0]!;
    instance.setToken.mockClear();
    instance.setCapabilities.mockClear();
    instance.setCurrency.mockClear();
    instance.setTheme.mockClear();
    instance.setKeepLiveWhileHidden.mockClear();

    const nextCapabilities = ['event:view'];
    const nextTheme = { accent: '#222222' };
    await act(async () => {
      root.render(createElement(SeatManager, {
        eventKey: 'ev_1', token: 'mse_two', tokenExpiresAt: 1234,
        capabilities: nextCapabilities, currency: 'EUR', theme: nextTheme,
        keepLiveWhileHidden: false,
      }));
    });

    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
    expect(instance.setToken).toHaveBeenCalledWith('mse_two', 1234);
    expect(instance.setCapabilities).toHaveBeenCalledWith(nextCapabilities);
    expect(instance.setCurrency).toHaveBeenCalledWith('EUR');
    expect(instance.setTheme).toHaveBeenCalledWith(nextTheme);
    expect(instance.setKeepLiveWhileHidden).toHaveBeenCalledWith(false);
  });

  it('carries the light/dark/auto mode to the cockpit at mount and on every change', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one', themeMode: 'light' }));
    });
    const instance = instances[0]!;
    // At MOUNT, not by a follow-up call — a cockpit asked for light must not
    // paint the war-room dark first and correct itself.
    expect(instance.options.themeMode).toBe('light');

    instance.setThemeMode.mockClear();
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one', themeMode: 'auto' }));
    });
    expect(instance.setThemeMode).toHaveBeenCalledWith('auto');
    // In place: switching sides must never tear down a live board.
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('reactively installs and removes token refresh while retaining the latest callback', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one' }));
    });
    const instance = instances[0]!;
    instance.setTokenRefresh.mockClear();
    const refresh = vi.fn(async () => ({ token: 'mse_two', expiresAt: 2000 }));

    await act(async () => {
      root.render(createElement(SeatManager, {
        eventKey: 'ev_1', token: 'mse_one', onTokenRefresh: refresh,
      }));
    });
    const proxy = instance.setTokenRefresh.mock.calls.at(-1)![0];
    await expect(proxy()).resolves.toEqual({ token: 'mse_two', expiresAt: 2000 });
    expect(refresh).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one' }));
    });
    expect(instance.setTokenRefresh).toHaveBeenLastCalledWith(undefined);
  });

  it('passes unavailable seats at mount and repaints them in place when the list changes', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    const first = ['A-1', 'A-2'];
    await act(async () => {
      root.render(createElement(SeatManager, {
        eventKey: 'ev_1', token: 'mse_one', unavailableObjects: first, unavailableObjectsReason: 'Kept for renewal',
      }));
    });
    const instance = instances[0]!;
    expect(instance.options.unavailableObjects).toBe(first);
    expect(instance.options.unavailableObjectsReason).toBe('Kept for renewal');

    instance.setUnavailableObjects.mockClear();
    await act(async () => {
      root.render(createElement(SeatManager, {
        eventKey: 'ev_1', token: 'mse_one', unavailableObjects: ['A-2', 'B-7'], unavailableObjectsReason: 'Kept for renewal',
      }));
    });
    expect(instance.setUnavailableObjects).toHaveBeenCalledWith(['A-2', 'B-7'], 'Kept for renewal');

    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one' }));
    });
    expect(instance.setUnavailableObjects).toHaveBeenLastCalledWith([], undefined);
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('passes hover prices at mount and changes them in place', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    const season = { prem: 300, std: { min: 150, max: 220 } };
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one', categoryPrices: season }));
    });
    const instance = instances[0]!;
    expect(instance.options.categoryPrices).toBe(season);

    instance.setCategoryPrices.mockClear();
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one', categoryPrices: null }));
    });
    expect(instance.setCategoryPrices).toHaveBeenCalledWith(null);

    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse_one' }));
    });
    expect(instance.setCategoryPrices).toHaveBeenLastCalledWith(undefined);
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('forwards the 0.105 room options at mount, and calls the host back through them', async () => {
    // Regression guard: wrappers 0.105.0 dropped every one of these, so a host's
    // kpis: false, clock and room-state wiring type-checked and then did nothing.
    const { SeatManager } = await import('../src/SeatManager');
    const onRoomStateChange = vi.fn();
    const onOpenOrder = vi.fn();
    const onOpenTrend = vi.fn();
    const arrivedFrom = { from: 'Performance', where: 'Stalls' };
    await act(async () => {
      root.render(createElement(SeatManager, {
        eventKey: 'ev_1', token: 'mse',
        kpis: false, timeZone: 'Europe/London', colourBy: 'channel',
        focusSection: 'stalls', focusSeat: 'A-1', focusCategory: 'vip', arrivedFrom,
        onRoomStateChange, onOpenOrder, onOpenTrend,
      } as never));
    });
    const options = instances[0]!.options;
    expect(options).toMatchObject({
      kpis: false, timeZone: 'Europe/London', colourBy: 'channel',
      focusSection: 'stalls', focusSeat: 'A-1', focusCategory: 'vip', arrivedFrom,
    });

    (options.onRoomStateChange as (state: string) => void)('paused');
    expect(onRoomStateChange).toHaveBeenCalledWith('paused');
    (options.onOpenOrder as (order: { id: string; displayRef: string }) => void)({ id: 'ord_1', displayRef: 'SL-1' });
    expect(onOpenOrder).toHaveBeenCalledWith({ id: 'ord_1', displayRef: 'SL-1' });
    (options.onOpenTrend as (focus: { kpi: string }) => void)({ kpi: 'sold' });
    expect(onOpenTrend).toHaveBeenCalledWith({ kpi: 'sold' });
  });

  it('lights the host’s own seats through the handle (showObjects)', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    const ref = createRef<{ showObjects(labels: readonly string[] | null, name?: string): void }>();
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', ref } as never));
    });
    ref.current!.showObjects(['A-2', 'A-3'], 'Resale');
    expect(instances[0]!.showObjects).toHaveBeenCalledWith(['A-2', 'A-3'], 'Resale');
    ref.current!.showObjects(null);
    expect(instances[0]!.showObjects).toHaveBeenLastCalledWith(null, undefined);
  });

  it('leaves onOpenOrder unset when the host has no orders page, so the room offers no dead link', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse' }));
    });
    expect(instances[0]!.options.onOpenOrder).toBeUndefined();
  });

  it('forwards the organisation name at mount (CR16)', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', organizationName: 'Jazz Nights Ltd' }));
    });
    expect(instances[0]!.options.organizationName).toBe('Jazz Nights Ltd');
  });

  it('passes the sale facts at mount and changes them in place, by value (CR18)', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', sale: { status: 'On sale', pageUrl: 'https://x.test/e' } }));
    });
    const instance = instances[0]!;
    expect(instance.options.sale).toEqual({ status: 'On sale', pageUrl: 'https://x.test/e' });
    instance.setSale.mockClear();
    // A new object with the same facts: nothing to repaint.
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', sale: { status: 'On sale', pageUrl: 'https://x.test/e' } }));
    });
    expect(instance.setSale).not.toHaveBeenCalled();
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', sale: { status: 'Paused', tone: 'warn' } }));
    });
    expect(instance.setSale).toHaveBeenLastCalledWith({ status: 'Paused', tone: 'warn' });
    expect(instances).toHaveLength(1);
  });

  it('passes the host’s map insets at mount and changes them in place, by value (CR18)', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', mapInsets: { bottom: 124 } }));
    });
    const instance = instances[0]!;
    expect(instance.options.mapInsets).toEqual({ bottom: 124 });
    instance.setMapInsets.mockClear();
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', mapInsets: { bottom: 124 } }));
    });
    expect(instance.setMapInsets).not.toHaveBeenCalled();
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse' }));
    });
    expect(instance.setMapInsets).toHaveBeenLastCalledWith(null);
  });

  it('forwards an order’s seats for arrival at mount (m43)', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, { eventKey: 'ev_1', token: 'mse', focusSeat: 'A-1', focusSeats: ['A-1', 'A-2'] }));
    });
    expect(instances[0]!.options).toMatchObject({ focusSeat: 'A-1', focusSeats: ['A-1', 'A-2'] });
  });

  it('forwards the `tools` list to the cockpit at mount', async () => {
    const { SeatManager } = await import('../src/SeatManager');
    await act(async () => {
      root.render(createElement(SeatManager, {
        eventKey: 'ev_1', token: 'mse_one', tools: ['view', 'block', 'categories'],
      }));
    });
    expect(instances[0]!.options.tools).toEqual(['view', 'block', 'categories']);
  });
});
