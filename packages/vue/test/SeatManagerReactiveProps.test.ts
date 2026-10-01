import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, shallowRef, type App } from 'vue';

/**
 * The Vue SeatManager against the same contract as
 * packages/react/test/SeatManagerReactiveProps.test.ts: every option reaches
 * the core at mount, live props reach their setter without a rebuild, the
 * room's links are only offered when the host can follow them, and the handle
 * forwards. Assertions read what the core class actually received, because a
 * prop that type-checks and is then dropped is the failure this guards.
 */

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
  getConnection = vi.fn(() => ({ status: 'live', lastMessageAt: 1 }));

  constructor(options: Record<string, unknown>) {
    this.options = options;
    instances.push(this);
  }
}

vi.mock('@seatlayer/js/manager', () => ({ SeatManager: MockManager }));

const { SeatManager } = await import('../src/manager');

type Exposed = import('../src/manager').SeatManagerExposed;

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  instances.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

/** Mount with a props object the test can swap, like a React re-render. */
async function mount(initial: Record<string, unknown>) {
  const props = shallowRef<Record<string, unknown>>(initial);
  const handle = ref<Exposed | null>(null);
  app = createApp(defineComponent({
    setup: () => () => h(SeatManager, { ...props.value, ref: handle } as never),
  }));
  app.mount(host);
  await nextTick();
  return {
    instance: () => instances[0]!,
    handle: () => handle.value!,
    async update(next: Record<string, unknown>) {
      props.value = next;
      await nextTick();
    },
  };
}

describe('Vue SeatManager reactive props', () => {
  it('updates authority, display, and liveness options without rebuilding the board', async () => {
    const view = await mount({
      eventKey: 'ev_1', token: 'mse_one', capabilities: ['event:channels:view'],
      currency: 'USD', theme: { accent: '#111111' }, keepLiveWhileHidden: true,
    });
    const instance = view.instance();

    const nextCapabilities = ['event:view'];
    const nextTheme = { accent: '#222222' };
    await view.update({
      eventKey: 'ev_1', token: 'mse_two', tokenExpiresAt: 1234,
      capabilities: nextCapabilities, currency: 'EUR', theme: nextTheme,
      keepLiveWhileHidden: false,
    });

    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
    expect(instance.setToken).toHaveBeenCalledWith('mse_two', 1234);
    expect(instance.setCapabilities).toHaveBeenCalledWith(nextCapabilities);
    expect(instance.setCurrency).toHaveBeenCalledWith('EUR');
    expect(instance.setTheme).toHaveBeenCalledWith(nextTheme);
    expect(instance.setKeepLiveWhileHidden).toHaveBeenCalledWith(false);
  });

  it('updates mode, follow-live and the selection rules in place', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse' });
    const instance = view.instance();
    const predicate = () => true;
    await view.update({
      eventKey: 'ev_1', token: 'mse', mode: 'block', followLive: true,
      selectableObjects: ['A-1'], unavailableObjectsSelectable: false,
      maxSelectedObjects: 4, numberOfPlacesToSelect: 2, isObjectSelectable: predicate,
    });
    expect(instance.setMode).toHaveBeenCalledWith('block');
    expect(instance.setFollowLive).toHaveBeenCalledWith(true);
    expect(instance.setSelectableObjects).toHaveBeenCalledWith(['A-1']);
    expect(instance.setUnavailableObjectsSelectable).toHaveBeenCalledWith(false);
    expect(instance.setMaxSelectedObjects).toHaveBeenCalledWith(4);
    expect(instance.setNumberOfPlacesToSelect).toHaveBeenCalledWith(2);
    expect(instance.setObjectSelectable).toHaveBeenCalledWith(predicate);

    // Cleared the way React clears them.
    await view.update({ eventKey: 'ev_1', token: 'mse', mode: 'block' });
    expect(instance.setSelectableObjects).toHaveBeenLastCalledWith([]);
    expect(instance.setUnavailableObjectsSelectable).toHaveBeenLastCalledWith(true);
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('rebuilds on a new event, and only then', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse', kpis: false });
    await view.update({ eventKey: 'ev_1', token: 'mse', kpis: false, currency: 'EUR' });
    expect(instances).toHaveLength(1);
    await view.update({ eventKey: 'ev_2', token: 'mse', kpis: false });
    expect(instances).toHaveLength(2);
    expect(instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(instances[1]!.options).toMatchObject({ eventKey: 'ev_2', kpis: false });
  });

  it('carries the light/dark/auto mode to the cockpit at mount and on every change', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse_one', themeMode: 'light' });
    const instance = view.instance();
    expect(instance.options.themeMode).toBe('light');
    await view.update({ eventKey: 'ev_1', token: 'mse_one', themeMode: 'auto' });
    expect(instance.setThemeMode).toHaveBeenCalledWith('auto');
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('reactively installs and removes token refresh while retaining the latest callback', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse_one' });
    const instance = view.instance();
    expect(instance.options.onTokenRefresh).toBeUndefined();
    const refresh = vi.fn(async () => ({ token: 'mse_two', expiresAt: 2000 }));

    await view.update({ eventKey: 'ev_1', token: 'mse_one', onTokenRefresh: refresh });
    const proxy = instance.setTokenRefresh.mock.calls.at(-1)![0];
    await expect(proxy()).resolves.toEqual({ token: 'mse_two', expiresAt: 2000 });
    expect(refresh).toHaveBeenCalledOnce();

    await view.update({ eventKey: 'ev_1', token: 'mse_one' });
    expect(instance.setTokenRefresh).toHaveBeenLastCalledWith(undefined);
  });

  it('passes unavailable seats at mount and repaints them in place when the list changes', async () => {
    const first = ['A-1', 'A-2'];
    const view = await mount({
      eventKey: 'ev_1', token: 'mse_one', unavailableObjects: first, unavailableObjectsReason: 'Kept for renewal',
    });
    const instance = view.instance();
    expect(instance.options.unavailableObjects).toEqual(first);
    expect(instance.options.unavailableObjectsReason).toBe('Kept for renewal');

    await view.update({
      eventKey: 'ev_1', token: 'mse_one', unavailableObjects: ['A-2', 'B-7'], unavailableObjectsReason: 'Kept for renewal',
    });
    expect(instance.setUnavailableObjects).toHaveBeenCalledWith(['A-2', 'B-7'], 'Kept for renewal');

    await view.update({ eventKey: 'ev_1', token: 'mse_one' });
    expect(instance.setUnavailableObjects).toHaveBeenLastCalledWith([], undefined);
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('passes hover prices at mount and changes them in place', async () => {
    const season = { prem: 300, std: { min: 150, max: 220 } };
    const view = await mount({ eventKey: 'ev_1', token: 'mse_one', categoryPrices: season });
    const instance = view.instance();
    expect(instance.options.categoryPrices).toEqual(season);

    await view.update({ eventKey: 'ev_1', token: 'mse_one', categoryPrices: null });
    expect(instance.setCategoryPrices).toHaveBeenCalledWith(null);

    await view.update({ eventKey: 'ev_1', token: 'mse_one' });
    expect(instance.setCategoryPrices).toHaveBeenLastCalledWith(undefined);
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('forwards the 0.105 room options at mount, and calls the host back through them', async () => {
    // Regression guard, as in React: wrappers 0.105.0 dropped every one of
    // these, so a host's kpis: false, clock and room-state wiring type-checked
    // and then did nothing.
    const onRoomStateChange = vi.fn();
    const onOpenOrder = vi.fn();
    const onOpenTrend = vi.fn();
    const onOpenDesigner = vi.fn();
    const arrivedFrom = { from: 'Performance', where: 'Stalls' };
    const view = await mount({
      eventKey: 'ev_1', token: 'mse',
      kpis: false, timeZone: 'Europe/London', colourBy: 'channel',
      focusSection: 'stalls', focusSeat: 'A-1', focusCategory: 'vip', arrivedFrom,
      // Vue's listener spelling: `@room-state-change` / `@open-order` / `@open-trend`.
      onRoomStateChange, onOpenOrder, onOpenTrend, onOpenDesigner,
    });
    const options = view.instance().options;
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
    (options.onOpenDesigner as () => void)();
    expect(onOpenDesigner).toHaveBeenCalled();
  });

  it('turns every reporting callback into a Vue event', async () => {
    const listeners = {
      onReady: vi.fn(), onTallies: vi.fn(), onActivity: vi.fn(), onControlRoom: vi.fn(),
      onModeChange: vi.fn(), onFollowLiveChange: vi.fn(), onSelectionChange: vi.fn(),
      onObjectSelected: vi.fn(), onObjectDeselected: vi.fn(), onSelectionValidityChange: vi.fn(),
      onSelectionValid: vi.fn(), onSelectionInvalid: vi.fn(), onSelectionLimit: vi.fn(),
      onFilteredSectionChange: vi.fn(), onAreaClick: vi.fn(), onActionComplete: vi.fn(),
      onConnectionChange: vi.fn(), onRoomStateChange: vi.fn(), onError: vi.fn(),
    };
    const view = await mount({ eventKey: 'ev_1', token: 'mse', ...listeners });
    const options = view.instance().options;
    for (const [name, listener] of Object.entries(listeners)) {
      expect(typeof options[name], `${name} is not wired to the core`).toBe('function');
      (options[name] as (value: unknown) => void)(`payload:${name}`);
      if (name === 'onReady') expect(listener).toHaveBeenCalledOnce();
      else expect(listener, `${name} did not reach the host`).toHaveBeenCalledWith(`payload:${name}`);
    }
  });

  it('lights the host’s own seats through the handle (showObjects)', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse' });
    view.handle().showObjects(['A-2', 'A-3'], 'Resale');
    expect(view.instance().showObjects).toHaveBeenCalledWith(['A-2', 'A-3'], 'Resale');
    view.handle().showObjects(null);
    expect(view.instance().showObjects).toHaveBeenLastCalledWith(null, undefined);
    expect(view.handle().getConnection()).toEqual({ status: 'live', lastMessageAt: 1 });
  });

  it('leaves onOpenOrder unset when the host has no orders page, so the room offers no dead link', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse' });
    expect(view.instance().options.onOpenOrder).toBeUndefined();
    expect(view.instance().options.onOpenTrend).toBeUndefined();
  });

  it('forwards the organisation name at mount (CR16)', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse', organizationName: 'Jazz Nights Ltd' });
    expect(view.instance().options.organizationName).toBe('Jazz Nights Ltd');
  });

  it('passes the sale facts at mount and changes them in place, by value (CR18)', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse', sale: { status: 'On sale', pageUrl: 'https://x.test/e' } });
    const instance = view.instance();
    expect(instance.options.sale).toEqual({ status: 'On sale', pageUrl: 'https://x.test/e' });
    // A new object with the same facts: nothing to repaint.
    await view.update({ eventKey: 'ev_1', token: 'mse', sale: { status: 'On sale', pageUrl: 'https://x.test/e' } });
    expect(instance.setSale).not.toHaveBeenCalled();
    await view.update({ eventKey: 'ev_1', token: 'mse', sale: { status: 'Paused', tone: 'warn' } });
    expect(instance.setSale).toHaveBeenLastCalledWith({ status: 'Paused', tone: 'warn' });
    expect(instances).toHaveLength(1);
  });

  it('passes the host’s map insets at mount and changes them in place, by value (CR18)', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse', mapInsets: { bottom: 124 } });
    const instance = view.instance();
    expect(instance.options.mapInsets).toEqual({ bottom: 124 });
    await view.update({ eventKey: 'ev_1', token: 'mse', mapInsets: { bottom: 124 } });
    expect(instance.setMapInsets).not.toHaveBeenCalled();
    await view.update({ eventKey: 'ev_1', token: 'mse' });
    expect(instance.setMapInsets).toHaveBeenLastCalledWith(null);
  });

  it('forwards an order’s seats for arrival at mount (m43)', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse', focusSeat: 'A-1', focusSeats: ['A-1', 'A-2'] });
    expect(view.instance().options).toMatchObject({ focusSeat: 'A-1', focusSeats: ['A-1', 'A-2'] });
  });

  it('forwards the `tools` list and the rest of the read-once options at mount', async () => {
    const view = await mount({
      eventKey: 'ev_1', token: 'mse_one', apiBase: 'https://api.example', tokenExpiresAt: 99,
      tools: ['view', 'block', 'categories'], chrome: 'minimal', selectedObjects: ['A-9'], mode: 'select',
    });
    expect(view.instance().options).toMatchObject({
      apiBase: 'https://api.example', tokenExpiresAt: 99,
      tools: ['view', 'block', 'categories'], chrome: 'minimal', selectedObjects: ['A-9'], mode: 'select',
    });
  });

  it('destroys the board on unmount', async () => {
    const view = await mount({ eventKey: 'ev_1', token: 'mse' });
    app!.unmount();
    app = null;
    expect(view.instance().destroy).toHaveBeenCalledOnce();
  });
});
