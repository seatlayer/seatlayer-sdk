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
    restoreOperation(...args: unknown[]) {
      state.calls.push({ method: 'restoreOperation', args });
      return Promise.resolve(null);
    }
    release(...args: unknown[]) { state.calls.push({ method: 'release', args }); return Promise.resolve(); }
    createRenewalIntent(...args: unknown[]) {
      state.calls.push({ method: 'createRenewalIntent', args });
      return Promise.resolve({ offerId: args[0] });
    }
    getDescriptor() { return { key: 'sea_1' }; }
    getAvailability() { return { freeCount: 4 }; }
    getHandoff() { return { operationId: 'sop_1' }; }
  },
}));

type Component = Record<string, unknown> & {
  ngOnChanges(changes: Record<string, unknown>): void;
  holdSameSeat(labels: readonly string[], operationId: string): Promise<unknown>;
  getDescriptor(): unknown;
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
    expect(component.getDescriptor()).toEqual({ key: 'sea_1' });

    component.season = 'sea_2';
    component.ngOnChanges({ season: { currentValue: 'sea_2' } });
    expect(state.constructed).toHaveLength(2);
    expect(state.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
  });
});
