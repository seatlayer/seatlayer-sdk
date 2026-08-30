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
    expect(exposed.value?.getAvailability()).toEqual({ freeCount: 4 });

    seasonKey.value = 'sea_2';
    await nextTick();
    expect(constructed).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
  });
});
