import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import type { SeasonPickerExposed } from '../src/SeasonPicker';

const constructed: Array<Record<string, unknown>> = [];
const calls: Array<{ method: string; args: unknown[] }> = [];

vi.mock('@seatlayer/js', () => ({
  SeasonPicker: class {
    constructor(options: Record<string, unknown>) { constructed.push(options); }
    render() { calls.push({ method: 'render', args: [] }); return Promise.resolve(this); }
    destroy() { calls.push({ method: 'destroy', args: [] }); }
    holdSameSeat(...args: unknown[]) {
      calls.push({ method: 'holdSameSeat', args });
      return Promise.resolve({ operationId: args[1] });
    }
    holdBestAvailable(...args: unknown[]) {
      calls.push({ method: 'holdBestAvailable', args });
      return Promise.resolve({ operationId: args[1] });
    }
    restoreOperation() { return Promise.resolve(null); }
    release() { return Promise.resolve(); }
    createRenewalIntent(...args: unknown[]) { return Promise.resolve({ offerId: args[0] }); }
    getDescriptor() { return { key: 'sea_1' }; }
    getAvailability() { return { freeCount: 4 }; }
    getHandoff() { return { operationId: 'sop_1' }; }
  },
}));

const { SeasonPicker } = await import('../src/SeasonPicker');
let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  constructed.length = 0;
  calls.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('@seatlayer/vue SeasonPicker', () => {
  it('maps events and handle methods while rebuilding only on identity changes', async () => {
    const seasonKey = ref('sea_1');
    const exposed = ref<SeasonPickerExposed | null>(null);
    const onHoldChange = vi.fn();
    app = createApp(defineComponent({
      setup: () => () => h(SeasonPicker, {
        ref: exposed,
        season: seasonKey.value,
        buyerAccessToken: 'bss_secret',
        onHoldChange,
      }),
    }));
    app.mount(host);
    await nextTick();

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ season: 'sea_1', buyerAccessToken: 'bss_secret' });
    (constructed[0]?.onHoldChange as (value: unknown) => void)({ operationId: 'sop_1' });
    expect(onHoldChange).toHaveBeenCalledWith({ operationId: 'sop_1' });
    await expect(exposed.value?.holdSameSeat(['A-1'], 'sop_1'))
      .resolves.toEqual({ operationId: 'sop_1' });
    const bestAvailable = { categoryKey: 'stalls', zoneId: 'zone_lower', accessibility: ['wheelchair'] as const, requireContiguous: true };
    await expect(exposed.value!.holdBestAvailable(2, 'sop_2', bestAvailable))
      .resolves.toEqual({ operationId: 'sop_2' });
    await exposed.value!.holdBestAvailable(1, 'sop_3');
    expect(calls.filter((call) => call.method === 'holdBestAvailable').map((call) => call.args))
      .toEqual([[2, 'sop_2', bestAvailable], [1, 'sop_3', undefined]]);
    expect(exposed.value?.getAvailability()).toEqual({ freeCount: 4 });

    seasonKey.value = 'sea_2';
    await nextTick();
    expect(constructed).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
  });

  it('forwards priceTypes, rebuilds only when they change, and passes a type map to holdSameSeat', async () => {
    const priceTypes = ref<Array<'adult' | 'child' | 'senior'>>(['adult', 'child']);
    const exposed = ref<SeasonPickerExposed | null>(null);
    app = createApp(defineComponent({
      setup: () => () => h(SeasonPicker, {
        ref: exposed, season: 'sea_1', buyerAccessToken: 'bss_secret', priceTypes: priceTypes.value,
      }),
    }));
    app.mount(host);
    await nextTick();
    expect(constructed[0]).toMatchObject({ priceTypes: ['adult', 'child'] });
    // A fresh array with the same types, as an inline prop is: same picker.
    priceTypes.value = ['adult', 'child'];
    await nextTick();
    expect(constructed).toHaveLength(1);
    priceTypes.value = ['adult', 'child', 'senior'];
    await nextTick();
    expect(constructed).toHaveLength(2);
    expect(constructed[1]).toMatchObject({ priceTypes: ['adult', 'child', 'senior'] });
    await exposed.value!.holdSameSeat(['A-1', 'A-2'], 'sop_1', { 'A-2': 'child' });
    expect(calls.filter((call) => call.method === 'holdSameSeat').at(-1)?.args)
      .toEqual([['A-1', 'A-2'], 'sop_1', { 'A-2': 'child' }]);
  });

  it('forwards `package`, and opens on another package when it changes', async () => {
    const chosen = ref('spl_half');
    app = createApp(defineComponent({
      setup: () => () => h(SeasonPicker, { season: 'sea_1', package: chosen.value, ticketsByEmail: true }),
    }));
    app.mount(host);
    await nextTick();
    expect(constructed[0]).toMatchObject({ package: 'spl_half', ticketsByEmail: true });
    chosen.value = 'spl_full';
    await nextTick();
    expect(constructed).toHaveLength(2);
    expect(constructed[1]).toMatchObject({ package: 'spl_full' });
  });
});
