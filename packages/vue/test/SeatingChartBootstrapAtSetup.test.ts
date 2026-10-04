/**
 * The wrapper starts the chart's first request from setup, ahead of the
 * post-flush build that adopts it (the page still makes one request).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ref } from 'vue';
import { createApp, type App } from 'vue';

const order: string[] = [];
const prewarms: Array<Record<string, unknown>> = [];

vi.mock('@seatlayer/js', async () => ({
  ...(await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js')),
  prewarmSeatPicker: (options: Record<string, unknown>) => {
    order.push(`prewarm:${String(options.event)}`);
    prewarms.push(options);
  },
  SeatingChart: class {
    constructor(options: Record<string, unknown>) { order.push(`construct:${String(options.event)}`); }
    render() { return Promise.resolve(); }
    destroy() { order.push('destroy'); }
  },
  SeatPicker: class {},
  attachPickerFrame: () => undefined,
}));

const { SeatingChart } = await import('../src/index');
const PK = `pk_live_${'a'.repeat(48)}`;

let host: HTMLDivElement;
let app: App | null = null;

beforeEach(() => {
  order.length = 0;
  prewarms.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('Vue SeatingChart starts its bootstrap from setup', () => {
  it('prewarms before the first build, and again (once) when the event changes', async () => {
    const props = ref<Record<string, unknown>>({ event: 'ev_1', publicKey: PK, apiBase: 'https://api.example.test' });
    app = createApp({ render: () => h(SeatingChart, props.value) });
    app.mount(host);
    await nextTick();
    expect(order).toEqual(['prewarm:ev_1', 'construct:ev_1']);
    expect(prewarms[0]).toEqual({ event: 'ev_1', publicKey: PK, apiBase: 'https://api.example.test' });

    props.value = { ...props.value, event: 'ev_2' };
    await nextTick();
    await nextTick();
    expect(order).toEqual(['prewarm:ev_1', 'construct:ev_1', 'prewarm:ev_2', 'destroy', 'construct:ev_2']);
  });

  it('never prewarms without a public key or with host-supplied buyer access', async () => {
    for (const extra of [{}, { publicKey: PK, buyerAccessToken: 'bse_x' }, { publicKey: PK, buyerAccessTokenProvider: async () => 'bse_y' }]) {
      const mounted = createApp({ render: () => h(SeatingChart, { event: 'ev_n', ...extra }) });
      const box = document.createElement('div');
      mounted.mount(box);
      await nextTick();
      mounted.unmount();
    }
    expect(prewarms).toEqual([]);
  });
});
