import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock('@seatlayer/js', () => ({
  SeasonPicker: class {
    constructor(options: Record<string, unknown>) { state.constructed.push(options); }
    render() { state.calls.push({ method: 'render', args: [] }); return Promise.resolve(this); }
    destroy() { state.calls.push({ method: 'destroy', args: [] }); }
    holdSameSeat(...args: unknown[]) {
      state.calls.push({ method: 'holdSameSeat', args });
      return Promise.resolve({ operationId: args[1] });
    }
    holdBestAvailable(...args: unknown[]) {
      state.calls.push({ method: 'holdBestAvailable', args });
      return Promise.resolve({ operationId: args[1] });
    }
    restoreOperation(...args: unknown[]) {
      state.calls.push({ method: 'restoreOperation', args });
      return Promise.resolve(null);
    }
    markBooked() { return Promise.resolve(true); }
    release(...args: unknown[]) { state.calls.push({ method: 'release', args }); return Promise.resolve(); }
    createRenewalIntent(...args: unknown[]) {
      state.calls.push({ method: 'createRenewalIntent', args });
      return Promise.resolve({ offerId: args[0] });
    }
    getDescriptor() { return { key: 'sea_1' }; }
    getAvailability() { return { freeCount: 4 }; }
    getHandoff() { return { operationId: 'sop_1' }; }
    getHeldOrder() { return { operationId: 'sop_1', expiresAt: 1, currency: 'USD', seats: [], totalMinor: 0 }; }
    startDatesCheckout(...args: unknown[]) {
      state.calls.push({ method: 'startDatesCheckout', args });
      return Promise.resolve({ sessionId: 'cs_1' });
    }
  },
}));

type Component = Record<string, unknown> & {
  ngOnChanges(changes: Record<string, unknown>): void;
  holdSameSeat(labels: readonly string[], operationId: string, priceTypes?: unknown): Promise<unknown>;
  holdBestAvailable(qty: number, operationId: string, options?: unknown): Promise<unknown>;
  markBooked(): Promise<boolean>;
  getDescriptor(): unknown;
  startDatesCheckout(input: unknown): Promise<unknown>;
};

async function makeComponent(): Promise<Component> {
  const { SeatLayerSeasonPickerComponent } = await import('../src/season-picker.component');
  const component = Object.create(SeatLayerSeasonPickerComponent.prototype) as Component;
  Object.assign(component, {
    season: 'sea_1',
    buyerAccessToken: 'bss_secret',
    zone: { runOutsideAngular: (fn: () => void) => fn(), run: (fn: () => void) => fn() },
    container: { nativeElement: document.createElement('div') },
    picker: null,
  });
  for (const output of [
    'hold', 'holdChange', 'continued', 'renewalIntent', 'accessExpired',
    'accessUnavailable', 'statusChange', 'errored',
  ]) {
    component[output] = { emit: vi.fn() };
  }
  return component;
}

beforeEach(() => {
  state.constructed.length = 0;
  state.calls.length = 0;
});

describe('@seatlayer/angular SeasonPicker', () => {
  it('forwards inputs, outputs and imperative operations with owned rebuilds', async () => {
    const component = await makeComponent();
    component.ngOnChanges({ season: { currentValue: 'sea_1' } });
    expect(state.constructed).toHaveLength(1);
    expect(state.constructed[0]).toMatchObject({ season: 'sea_1', buyerAccessToken: 'bss_secret' });

    (state.constructed[0]?.onContinue as (value: unknown) => void)({ operationId: 'sop_1' });
    expect((component.continued as { emit: ReturnType<typeof vi.fn> }).emit)
      .toHaveBeenCalledWith({ operationId: 'sop_1' });
    await expect(component.holdSameSeat(['A-1'], 'sop_1'))
      .resolves.toEqual({ operationId: 'sop_1' });
    const bestAvailable = { categoryKey: 'stalls', zoneId: 'zone_lower', accessibility: ['wheelchair'] as const, requireContiguous: true };
    await expect(component.holdBestAvailable(2, 'sop_2', bestAvailable))
      .resolves.toEqual({ operationId: 'sop_2' });
    await component.holdBestAvailable(1, 'sop_3');
    expect(state.calls.filter((call) => call.method === 'holdBestAvailable').map((call) => call.args))
      .toEqual([[2, 'sop_2', bestAvailable], [1, 'sop_3', undefined]]);
    await expect(component.markBooked()).resolves.toBe(true);
    expect(component.getDescriptor()).toEqual({ key: 'sea_1' });
    expect(component.getHeldOrder()).toEqual({ operationId: 'sop_1', expiresAt: 1, currency: 'USD', seats: [], totalMinor: 0 });

    component.season = 'sea_2';
    component.ngOnChanges({ season: { currentValue: 'sea_2' } });
    expect(state.constructed).toHaveLength(2);
    expect(state.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
  });

  it('forwards priceTypes, rebuilds when they change, and passes a type map to holdSameSeat', async () => {
    const component = await makeComponent();
    component.priceTypes = ['adult', 'child'];
    component.ngOnChanges({ season: { currentValue: 'sea_1' }, priceTypes: { currentValue: ['adult', 'child'] } });
    expect(state.constructed[0]).toMatchObject({ priceTypes: ['adult', 'child'] });
    component.priceTypes = ['adult', 'child', 'senior'];
    component.ngOnChanges({ priceTypes: { currentValue: ['adult', 'child', 'senior'] } });
    expect(state.constructed).toHaveLength(2);
    expect(state.constructed[1]).toMatchObject({ priceTypes: ['adult', 'child', 'senior'] });
    await component.holdSameSeat(['A-1', 'A-2'], 'sop_1', { 'A-2': 'child' });
    expect(state.calls.filter((call) => call.method === 'holdSameSeat').at(-1)?.args)
      .toEqual([['A-1', 'A-2'], 'sop_1', { 'A-2': 'child' }]);
  });

  it('forwards `package`, and opens on another package when it changes', async () => {
    const component = await makeComponent();
    component.package = 'spl_half';
    component.ticketsByEmail = true;
    component.ngOnChanges({ season: { currentValue: 'sea_1' }, package: { currentValue: 'spl_half' } });
    expect(state.constructed[0]).toMatchObject({ package: 'spl_half', ticketsByEmail: true });
    component.package = 'spl_full';
    component.ngOnChanges({ package: { currentValue: 'spl_full' } });
    expect(state.constructed).toHaveLength(2);
    expect(state.constructed[1]).toMatchObject({ package: 'spl_full' });
  });

  it('forwards `buyerEmail` and `buyerName` for the checkout card', async () => {
    const component = await makeComponent();
    component.buyerEmail = 'member@example.com';
    component.buyerName = 'Asha Rao';
    component.ngOnChanges({ season: { currentValue: 'sea_1' } });
    expect(state.constructed[0]).toMatchObject({ buyerEmail: 'member@example.com', buyerName: 'Asha Rao' });
  });

  it('forwards the three 3D options, and rebuilds when one changes', async () => {
    const value = await makeComponent();
    Object.assign(value, { enable3D: false, enable3DCrowd: false, touchNavigation3D: 'classic' });
    value.ngOnChanges({ season: { currentValue: 'sea_1' } });
    expect(state.constructed[0]).toMatchObject({
      enable3D: false, enable3DCrowd: false, touchNavigation3D: 'classic',
    });
    for (const [prop, next] of [
      ['enable3D', true], ['enable3DCrowd', true], ['touchNavigation3D', 'map'],
    ] as const) {
      const before = state.constructed.length;
      value[prop] = next;
      value.ngOnChanges({ [prop]: { currentValue: next } });
      expect(state.constructed, `${prop} did not rebuild`).toHaveLength(before + 1);
      expect(state.constructed.at(-1)).toMatchObject({ [prop]: next });
    }
  });

  it('sends the three 3D options as undefined when the host sets none', async () => {
    const value = await makeComponent();
    value.ngOnChanges({ season: { currentValue: 'sea_1' } });
    expect(state.constructed[0]?.enable3D).toBeUndefined();
    expect(state.constructed[0]?.enable3DCrowd).toBeUndefined();
    expect(state.constructed[0]?.touchNavigation3D).toBeUndefined();
  });

  it('forwards releaseHoldOnDestroy (off unless set), never rebuilds on it, and the picker reads the current input', async () => {
    const value = await makeComponent();
    value.ngOnChanges({ season: { currentValue: 'sea_1' } });
    expect(state.constructed[0]?.releaseHoldOnDestroy).toBeUndefined();
    value.releaseHoldOnDestroy = true;
    value.ngOnChanges({ releaseHoldOnDestroy: { currentValue: true } });
    expect(state.constructed).toHaveLength(1);
    expect(state.constructed[0]).toMatchObject({ season: 'sea_1', releaseHoldOnDestroy: true });
    value.releaseHoldOnDestroy = false;
    value.ngOnChanges({ releaseHoldOnDestroy: { currentValue: false } });
    expect(state.constructed).toHaveLength(1);
    expect(state.constructed[0]?.releaseHoldOnDestroy).toBe(false);
    // One render and no destroy: the picker was never rebuilt for this option.
    expect(state.calls.map((c) => c.method)).toEqual(['render']);
  });

  it('forwards singleDates (unset unless given), and rebuilds when it changes', async () => {
    const value = await makeComponent();
    value.ngOnChanges({ season: { currentValue: 'sea_1' } });
    expect(state.constructed[0]?.singleDates).toBeUndefined();
    value.singleDates = true;
    value.ngOnChanges({ singleDates: { currentValue: true } });
    expect(state.constructed).toHaveLength(2);
    expect(state.constructed[1]).toMatchObject({ season: 'sea_1', singleDates: true });
  });

  it('delegates startDatesCheckout, and throws before the picker exists, as the other holds do', async () => {
    const value = await makeComponent();
    expect(() => value.startDatesCheckout({ buyerEmail: 'member@example.com' }))
      .toThrow('seatlayer: Angular SeasonPicker is not mounted');
    value.ngOnChanges({ season: { currentValue: 'sea_1' } });
    const input = { buyerEmail: 'member@example.com', buyerName: 'Asha Rao', returnUrl: 'https://tickets.example.com/done' };
    await expect(value.startDatesCheckout(input)).resolves.toEqual({ sessionId: 'cs_1' });
    expect(state.calls.filter((call) => call.method === 'startDatesCheckout').map((call) => call.args))
      .toEqual([[input]]);
  });
});
