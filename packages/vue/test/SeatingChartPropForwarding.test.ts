import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createApp, type App } from 'vue';

/**
 * Regression guard for a silent prop drop.
 *
 * The wrapper hand-copies each prop onto the core options object, so a new
 * option can typecheck on the component and then be discarded at runtime — the
 * exact failure the React wrapper shipped between 0.17 and 0.19, where a host
 * wiring up pricing got a green build and wrong prices with no signal anywhere.
 *
 * These tests assert against the options the core class actually receives.
 */

const constructorCalls: Array<Record<string, unknown>> = [];
const renderCalls: number[] = [];
const destroyCalls: number[] = [];

vi.mock('@seatlayer/js', () => ({
  SeatingChart: class {
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options);
    }

    render() {
      renderCalls.push(constructorCalls.length);
      return Promise.resolve();
    }

    destroy() {
      destroyCalls.push(constructorCalls.length);
    }

    hold() {
      return Promise.resolve(null);
    }
  },
  SeatPicker: class {},
  attachPickerFrame: () => undefined,
}));

const { SeatingChart } = await import('../src/index');

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  constructorCalls.length = 0;
  renderCalls.length = 0;
  destroyCalls.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

function mount(props: Record<string, unknown>, listeners: Record<string, unknown> = {}) {
  app = createApp(defineComponent({
    setup: () => () => h(SeatingChart, { ...props, ...listeners }),
  }));
  app.mount(host);
}

describe('SeatingChart prop forwarding', () => {
  it('forwards every declared prop to the core options', async () => {
    mount({
      event: 'summer-gala',
      apiBase: 'https://api.example',
      maxSelection: 4,
      publicKey: 'pk_test_x',
      locale: 'fr-FR',
      currency: 'EUR',
      colorblindSafe: true,
      seatTooltip: false,
      messages: { holdButton: 'Réserver' },
    });
    await nextTick();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toMatchObject({
      event: 'summer-gala',
      apiBase: 'https://api.example',
      maxSelection: 4,
      publicKey: 'pk_test_x',
      locale: 'fr-FR',
      currency: 'EUR',
      colorblindSafe: true,
      seatTooltip: false,
      messages: { holdButton: 'Réserver' },
    });
  });

  it('renders once on mount and destroys on unmount', async () => {
    mount({ event: 'summer-gala' });
    await nextTick();

    expect(renderCalls).toHaveLength(1);
    expect(destroyCalls).toHaveLength(0);

    app?.unmount();
    app = null;
    expect(destroyCalls).toHaveLength(1);
  });

  it('translates core callbacks into Vue events', async () => {
    const onSelectionChange = vi.fn();
    const onHint = vi.fn();
    mount({ event: 'summer-gala' }, {
      onSelectionChange,
      onHint,
    });
    await nextTick();

    const options = constructorCalls[0] as Record<string, (arg: unknown) => void>;
    options.onSelectionChange([{ id: 'A-1' }]);
    // onHint fires with null to clear a hint — the wrapper must not drop that.
    options.onHint(null);

    expect(onSelectionChange).toHaveBeenCalledWith([{ id: 'A-1' }]);
    expect(onHint).toHaveBeenCalledWith(null);
  });

  it('forwards the buyer access options and emits the access events', async () => {
    const buyerAccessTokenProvider = vi.fn(async () => ({ token: 'bse_x' }));
    const onAccessExpired = vi.fn();
    const onAccessUnavailable = vi.fn();
    const onSelectedObjectUnavailable = vi.fn();
    mount(
      { event: 'summer-gala', buyerAccessTokenProvider, buyerAccessToken: 'bse_seed' },
      { onAccessExpired, onAccessUnavailable, onSelectedObjectUnavailable },
    );
    await nextTick();

    expect(constructorCalls[0]).toMatchObject({
      buyerAccessTokenProvider,
      buyerAccessToken: 'bse_seed',
    });

    const options = constructorCalls[0] as Record<string, (arg: unknown) => void>;
    options.onAccessExpired({ reason: 'unauthorized', refreshed: false });
    options.onAccessUnavailable({ reason: 'revoked', retryable: false });
    options.onSelectedObjectUnavailable({ labels: ['A-1'], reason: 'ineligible' });

    expect(onAccessExpired).toHaveBeenCalledWith({ reason: 'unauthorized', refreshed: false });
    expect(onAccessUnavailable).toHaveBeenCalledWith({ reason: 'revoked', retryable: false });
    expect(onSelectedObjectUnavailable).toHaveBeenCalledWith({
      labels: ['A-1'],
      reason: 'ineligible',
    });
  });

  it('rebuilds only when an identity prop changes', async () => {
    const eventKey = ref('gala-one');
    const maxSelection = ref(2);

    app = createApp(defineComponent({
      setup: () => () => h(SeatingChart, { event: eventKey.value, maxSelection: maxSelection.value }),
    }));
    app.mount(host);
    await nextTick();
    expect(constructorCalls).toHaveLength(1);

    // An identity prop — must rebuild.
    eventKey.value = 'gala-two';
    await nextTick();
    expect(constructorCalls).toHaveLength(2);
    expect(constructorCalls[1]).toMatchObject({ event: 'gala-two' });
    // The old canvas is torn down rather than leaked.
    expect(destroyCalls).toHaveLength(1);
  });
});
