import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
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
  setMaxSelectedObjects = vi.fn();
  setNumberOfPlacesToSelect = vi.fn();
  setObjectSelectable = vi.fn();

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
