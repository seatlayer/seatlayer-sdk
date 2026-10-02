/**
 * The Angular SeatManager against the same contract as
 * packages/react/test/SeatManagerReactiveProps.test.ts: every option reaches
 * the core at mount, live inputs reach their setter without a rebuild, the
 * room's links are only offered when the host can follow them, and the
 * template-ref methods forward.
 *
 * NO TestBed, for the reason SeatingChartComponent.test.ts gives. Unlike that
 * suite, the component is built with its real constructor inside
 * `runInInjectionContext`, so the @Output emitters are the real field
 * initialisers and the DestroyRef hook is the real one (an environment
 * injector is its own DestroyRef). Only @ViewChild is
 * filled in by hand, and NgZone is a pass-through that counts re-entries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, NgZone, runInInjectionContext, type SimpleChanges } from '@angular/core';

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
  focusSection = vi.fn(() => [{ label: 'Stalls' }]);
  block = vi.fn(() => Promise.resolve());
  getConnection = vi.fn(() => ({ status: 'live', lastMessageAt: 1 }));

  constructor(options: Record<string, unknown>) {
    this.options = options;
    instances.push(this);
  }
}

vi.mock('@seatlayer/js/manager', () => ({ SeatManager: MockManager }));

const { SeatLayerSeatManagerComponent } = await import('../manager/src/index');

type Component = InstanceType<typeof SeatLayerSeatManagerComponent> & Record<string, unknown>;

let zoneRuns = 0;
let injector: Injector & { destroy(): void };

/** Build the component with its real constructor, then bind inputs and run ngOnChanges. */
function mount(inputs: Record<string, unknown>, subscribe: (c: Component) => void = () => {}) {
  // DestroyRef resolves to the injector itself, so destroying the injector is
  // what Angular does to the component's DestroyRef.
  injector = Injector.create({
    providers: [
      {
        provide: NgZone,
        useValue: {
          runOutsideAngular: <T>(fn: () => T) => fn(),
          run: <T>(fn: () => T) => { zoneRuns += 1; return fn(); },
        },
      },
    ],
  }) as Injector & { destroy(): void };
  const component = runInInjectionContext(injector, () => new SeatLayerSeatManagerComponent()) as Component;
  // What @ViewChild would have provided.
  Object.assign(component, { container: { nativeElement: document.createElement('div') } });
  // Template listeners subscribe before the first ngOnChanges, as in Angular.
  subscribe(component);
  set(component, inputs, true);
  return component;
}

/** Bind inputs and hand ngOnChanges the SimpleChanges Angular would. */
function set(component: Component, inputs: Record<string, unknown>, firstChange = false) {
  const changes: SimpleChanges = {};
  for (const [name, value] of Object.entries(inputs)) {
    changes[name] = {
      previousValue: component[name],
      currentValue: value,
      firstChange,
      isFirstChange: () => firstChange,
    };
    component[name] = value;
  }
  component.ngOnChanges(changes);
}

beforeEach(() => {
  instances.length = 0;
  zoneRuns = 0;
});

describe('Angular SeatManager inputs', () => {
  it('updates authority, display, and liveness inputs without rebuilding the board', () => {
    const component = mount({
      eventKey: 'ev_1', token: 'mse_one', capabilities: ['event:channels:view'],
      currency: 'USD', theme: { accent: '#111111' }, keepLiveWhileHidden: true,
    });
    const instance = instances[0]!;
    const nextCapabilities = ['event:view'];
    const nextTheme = { accent: '#222222' };
    set(component, {
      token: 'mse_two', tokenExpiresAt: 1234, capabilities: nextCapabilities,
      currency: 'EUR', theme: nextTheme, keepLiveWhileHidden: false,
    });

    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
    expect(instance.setToken).toHaveBeenCalledWith('mse_two', 1234);
    expect(instance.setCapabilities).toHaveBeenCalledWith(nextCapabilities);
    expect(instance.setCurrency).toHaveBeenCalledWith('EUR');
    expect(instance.setTheme).toHaveBeenCalledWith(nextTheme);
    expect(instance.setKeepLiveWhileHidden).toHaveBeenCalledWith(false);
  });

  it('updates mode, follow-live and the selection rules in place', () => {
    const component = mount({ eventKey: 'ev_1', token: 'mse' });
    const instance = instances[0]!;
    const predicate = () => true;
    set(component, {
      mode: 'block', followLive: true, selectableObjects: ['A-1'], unavailableObjectsSelectable: false,
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
    set(component, { selectableObjects: undefined, unavailableObjectsSelectable: undefined });
    expect(instance.setSelectableObjects).toHaveBeenLastCalledWith([]);
    expect(instance.setUnavailableObjectsSelectable).toHaveBeenLastCalledWith(true);
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('rebuilds on a new event, and only then', () => {
    const component = mount({ eventKey: 'ev_1', token: 'mse', kpis: false });
    set(component, { currency: 'EUR' });
    expect(instances).toHaveLength(1);
    set(component, { eventKey: 'ev_2' });
    expect(instances).toHaveLength(2);
    expect(instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(instances[1]!.options).toMatchObject({ eventKey: 'ev_2', kpis: false, currency: 'EUR' });
  });

  it('carries the light/dark/auto mode to the cockpit at mount and on every change', () => {
    const component = mount({ eventKey: 'ev_1', token: 'mse_one', themeMode: 'light' });
    const instance = instances[0]!;
    expect(instance.options.themeMode).toBe('light');
    set(component, { themeMode: 'auto' });
    expect(instance.setThemeMode).toHaveBeenCalledWith('auto');
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('reactively installs and removes token refresh while retaining the latest callback', async () => {
    const component = mount({ eventKey: 'ev_1', token: 'mse_one' });
    const instance = instances[0]!;
    expect(instance.options.onTokenRefresh).toBeUndefined();
    const refresh = vi.fn(async () => ({ token: 'mse_two', expiresAt: 2000 }));

    set(component, { onTokenRefresh: refresh });
    const proxy = instance.setTokenRefresh.mock.calls.at(-1)![0];
    await expect(proxy()).resolves.toEqual({ token: 'mse_two', expiresAt: 2000 });
    expect(refresh).toHaveBeenCalledOnce();

    // A different handler needs no setter: the proxy reads the current input.
    const later = vi.fn(async () => ({ token: 'mse_three', expiresAt: 3000 }));
    instance.setTokenRefresh.mockClear();
    set(component, { onTokenRefresh: later });
    expect(instance.setTokenRefresh).not.toHaveBeenCalled();
    await expect(proxy()).resolves.toEqual({ token: 'mse_three', expiresAt: 3000 });

    set(component, { onTokenRefresh: undefined });
    expect(instance.setTokenRefresh).toHaveBeenLastCalledWith(undefined);
  });

  it('passes unavailable seats at mount and repaints them in place when the list changes', () => {
    const first = ['A-1', 'A-2'];
    const component = mount({
      eventKey: 'ev_1', token: 'mse_one', unavailableObjects: first, unavailableObjectsReason: 'Kept for renewal',
    });
    const instance = instances[0]!;
    expect(instance.options.unavailableObjects).toBe(first);
    expect(instance.options.unavailableObjectsReason).toBe('Kept for renewal');

    set(component, { unavailableObjects: ['A-2', 'B-7'] });
    expect(instance.setUnavailableObjects).toHaveBeenCalledWith(['A-2', 'B-7'], 'Kept for renewal');

    set(component, { unavailableObjects: undefined, unavailableObjectsReason: undefined });
    expect(instance.setUnavailableObjects).toHaveBeenLastCalledWith([], undefined);
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
  });

  it('passes hover prices at mount and changes them in place', () => {
    const season = { prem: 300, std: { min: 150, max: 220 } };
    const component = mount({ eventKey: 'ev_1', token: 'mse_one', categoryPrices: season });
    const instance = instances[0]!;
    expect(instance.options.categoryPrices).toBe(season);

    set(component, { categoryPrices: null });
    expect(instance.setCategoryPrices).toHaveBeenCalledWith(null);
    set(component, { categoryPrices: undefined });
    expect(instance.setCategoryPrices).toHaveBeenLastCalledWith(undefined);
    expect(instances).toHaveLength(1);
  });

  it('forwards the 0.105 room options at mount, and calls the host back through them', () => {
    // Regression guard, as in React: wrappers 0.105.0 dropped every one of
    // these, so a host's kpis: false, clock and room-state wiring type-checked
    // and then did nothing.
    const onRoomStateChange = vi.fn();
    const onOpenOrder = vi.fn();
    const onOpenTrend = vi.fn();
    const onOpenDesigner = vi.fn();
    const arrivedFrom = { from: 'Performance', where: 'Stalls' };
    mount({
      eventKey: 'ev_1', token: 'mse',
      kpis: false, timeZone: 'Europe/London', colourBy: 'channel',
      // `[focusSection]` in a template; the class field is `focusSectionOnOpen`.
      focusSectionOnOpen: 'stalls', focusSeat: 'A-1', focusCategory: 'vip', arrivedFrom,
    }, (component) => {
      component.roomStateChange.subscribe(onRoomStateChange);
      component.openOrder.subscribe(onOpenOrder);
      component.openTrend.subscribe(onOpenTrend);
      component.openDesigner.subscribe(onOpenDesigner);
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
    (options.onOpenDesigner as () => void)();
    expect(onOpenDesigner).toHaveBeenCalled();
  });

  it('turns every reporting callback into an @Output, emitted inside the zone', () => {
    const outputs: Record<string, string> = {
      onReady: 'ready', onTallies: 'tallies', onActivity: 'activity', onControlRoom: 'controlRoom',
      onModeChange: 'modeChange', onFollowLiveChange: 'followLiveChange', onSelectionChange: 'selectionChange',
      onObjectSelected: 'objectSelected', onObjectDeselected: 'objectDeselected',
      onSelectionValidityChange: 'selectionValidityChange', onSelectionValid: 'selectionValid',
      onSelectionInvalid: 'selectionInvalid', onSelectionLimit: 'selectionLimit',
      onFilteredSectionChange: 'filteredSectionChange', onAreaClick: 'areaClick',
      onActionComplete: 'actionComplete', onConnectionChange: 'connectionChange',
      onRoomStateChange: 'roomStateChange', onError: 'errored',
    };
    const heard: Record<string, unknown[]> = {};
    mount({ eventKey: 'ev_1', token: 'mse' }, (component) => {
      for (const output of Object.values(outputs)) {
        heard[output] = [];
        (component[output] as { subscribe(fn: (v: unknown) => void): void }).subscribe((v) => heard[output]!.push(v));
      }
    });
    const options = instances[0]!.options;
    for (const [callback, output] of Object.entries(outputs)) {
      expect(typeof options[callback], `${callback} is not wired to the core`).toBe('function');
      const before = zoneRuns;
      (options[callback] as (value: unknown) => void)(`payload:${callback}`);
      expect(heard[output], `${callback} did not reach (${output})`).toHaveLength(1);
      if (callback !== 'onReady') expect(heard[output]![0]).toBe(`payload:${callback}`);
      expect(zoneRuns, `${callback} emitted outside the zone`).toBe(before + 1);
    }
  });

  it('leaves onOpenOrder unset when the host binds no (openOrder), so the room offers no dead link', () => {
    mount({ eventKey: 'ev_1', token: 'mse' });
    expect(instances[0]!.options.onOpenOrder).toBeUndefined();
    expect(instances[0]!.options.onOpenTrend).toBeUndefined();
    expect(instances[0]!.options.onOpenDesigner).toBeUndefined();
  });

  it('runs the way back inside the zone, since it is host code', () => {
    const go = vi.fn();
    mount({ eventKey: 'ev_1', token: 'mse', arrivedFrom: { from: 'Orders', back: { label: 'Orders', go } } });
    const arrived = instances[0]!.options.arrivedFrom as { from: string; back: { label: string; go(): void } };
    expect(arrived).toMatchObject({ from: 'Orders', back: { label: 'Orders' } });
    arrived.back.go();
    expect(go).toHaveBeenCalledOnce();
    expect(zoneRuns).toBe(1);
  });

  it('lights the host’s own seats through the template ref (showObjects)', () => {
    const component = mount({ eventKey: 'ev_1', token: 'mse' });
    component.showObjects(['A-2', 'A-3'], 'Resale');
    expect(instances[0]!.showObjects).toHaveBeenCalledWith(['A-2', 'A-3'], 'Resale');
    component.showObjects(null);
    expect(instances[0]!.showObjects).toHaveBeenLastCalledWith(null, undefined);
    expect(component.focusSection('Stalls')).toEqual([{ label: 'Stalls' }]);
    expect(component.getConnection()).toEqual({ status: 'live', lastMessageAt: 1 });
  });

  it('answers safely before the board exists', async () => {
    const component = runInInjectionContext(
      Injector.create({ providers: [
        { provide: NgZone, useValue: { runOutsideAngular: (fn: () => void) => fn(), run: (fn: () => void) => fn() } },
      ] }),
      () => new SeatLayerSeatManagerComponent(),
    );
    expect(component.getConnection()).toBeNull();
    expect(component.selectAll()).toEqual([]);
    await expect(component.block(['A-1'])).resolves.toBeUndefined();
    await expect(component.getReport()).rejects.toThrow('not ready');
  });

  it('forwards the organisation name at mount (CR16)', () => {
    mount({ eventKey: 'ev_1', token: 'mse', organizationName: 'Jazz Nights Ltd' });
    expect(instances[0]!.options.organizationName).toBe('Jazz Nights Ltd');
  });

  it('passes the sale facts at mount and changes them in place, by value (CR18)', () => {
    const component = mount({ eventKey: 'ev_1', token: 'mse', sale: { status: 'On sale', pageUrl: 'https://x.test/e' } });
    const instance = instances[0]!;
    expect(instance.options.sale).toEqual({ status: 'On sale', pageUrl: 'https://x.test/e' });
    // A new object with the same facts: nothing to repaint.
    set(component, { sale: { status: 'On sale', pageUrl: 'https://x.test/e' } });
    expect(instance.setSale).not.toHaveBeenCalled();
    set(component, { sale: { status: 'Paused', tone: 'warn' } });
    expect(instance.setSale).toHaveBeenLastCalledWith({ status: 'Paused', tone: 'warn' });
    expect(instances).toHaveLength(1);
  });

  it('passes the host’s map insets at mount and changes them in place, by value (CR18)', () => {
    const component = mount({ eventKey: 'ev_1', token: 'mse', mapInsets: { bottom: 124 } });
    const instance = instances[0]!;
    expect(instance.options.mapInsets).toEqual({ bottom: 124 });
    set(component, { mapInsets: { bottom: 124 } });
    expect(instance.setMapInsets).not.toHaveBeenCalled();
    set(component, { mapInsets: undefined });
    expect(instance.setMapInsets).toHaveBeenLastCalledWith(null);
  });

  it('forwards an order’s seats for arrival at mount (m43)', () => {
    mount({ eventKey: 'ev_1', token: 'mse', focusSeat: 'A-1', focusSeats: ['A-1', 'A-2'] });
    expect(instances[0]!.options).toMatchObject({ focusSeat: 'A-1', focusSeats: ['A-1', 'A-2'] });
  });

  it('forwards the `tools` list and the rest of the read-once inputs at mount', () => {
    mount({
      eventKey: 'ev_1', token: 'mse_one', apiBase: 'https://api.example', tokenExpiresAt: 99,
      tools: ['view', 'block', 'categories'], chrome: 'minimal', selectedObjects: ['A-9'], mode: 'select',
    });
    expect(instances[0]!.options).toMatchObject({
      apiBase: 'https://api.example', tokenExpiresAt: 99,
      tools: ['view', 'block', 'categories'], chrome: 'minimal', selectedObjects: ['A-9'], mode: 'select',
    });
  });

  it('destroys the board when Angular destroys the component', () => {
    mount({ eventKey: 'ev_1', token: 'mse' });
    expect(instances[0]!.destroy).not.toHaveBeenCalled();
    injector.destroy();
    expect(instances[0]!.destroy).toHaveBeenCalledOnce();
  });
});
