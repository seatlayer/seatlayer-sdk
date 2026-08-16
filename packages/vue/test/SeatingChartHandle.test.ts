/**
 * @seatlayer/vue had ZERO tests. These are the three properties the wrapper
 * exists to guarantee, and the two that had already silently broken:
 * every handle method reaches the chart, an identity prop rebuilds the canvas,
 * and a non-identity prop does not.
 *
 * The SDK is mocked, so this exercises the wrapper and nothing else. The mock
 * records every constructed options object and every call made on the instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type App } from 'vue';
import { createApp } from 'vue';
import { SEATING_CHART_HANDLE_METHODS } from '@seatlayer/js';

const constructed: Array<Record<string, unknown>> = [];
const destroyed: unknown[] = [];
const calls: Array<{ method: string; args: unknown[] }> = [];

vi.mock('@seatlayer/js', async () => {
  // The binding contract itself is real — only the chart class is faked.
  const actual = await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js');
  class FakeSeatingChart {
    constructor(options: Record<string, unknown>) { constructed.push(options); }
    render() { return Promise.resolve(); }
    destroy() { destroyed.push(this); }
  }
  // Every forwarded method answers a recognisable value so the test can prove
  // the wrapper returned the CHART's answer rather than the null-instance one.
  for (const method of actual.SEATING_CHART_HANDLE_METHODS) {
    (FakeSeatingChart.prototype as unknown as Record<string, unknown>)[method] =
      (...args: unknown[]) => {
        calls.push({ method, args });
        return `called:${method}`;
      };
  }
  return { ...actual, SeatingChart: FakeSeatingChart };
});

let host: HTMLDivElement;
let app: App | null = null;

beforeEach(() => {
  constructed.length = 0;
  destroyed.length = 0;
  calls.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

/** Mount the wrapper inside a parent that owns its props and its template ref. */
async function mount(initial: Record<string, unknown>) {
  const { SeatingChart } = await import('../src/SeatingChart');
  const props = ref<Record<string, unknown>>(initial);
  const chartRef = ref<Record<string, (...args: unknown[]) => unknown> | null>(null);
  const Parent = defineComponent({
    setup: () => () => h(SeatingChart as never, { ...props.value, ref: chartRef }),
  });
  app = createApp(Parent);
  app.mount(host);
  await nextTick();
  return {
    chartRef,
    async setProps(next: Record<string, unknown>) {
      props.value = { ...props.value, ...next };
      await nextTick();
      await nextTick();
    },
  };
}

describe('@seatlayer/vue SeatingChart — handle forwarding', () => {
  it('exposes every method in SEATING_CHART_HANDLE_METHODS, and each reaches the chart', async () => {
    const { chartRef } = await mount({ event: 'ev_1' });
    const exposed = chartRef.value!;
    expect(exposed).toBeTruthy();

    for (const method of SEATING_CHART_HANDLE_METHODS) {
      expect(typeof exposed[method], `${method} is not exposed`).toBe('function');
      const result = exposed[method]('arg-a', 'arg-b');
      expect(calls.at(-1), `${method} did not reach the chart`).toEqual({
        method,
        args: ['arg-a', 'arg-b'],
      });
      expect(result, `${method} did not return the chart's answer`).toBe(`called:${method}`);
    }
    expect(calls).toHaveLength(SEATING_CHART_HANDLE_METHODS.length);
  });

  it('answers an empty value instead of throwing before the chart exists', async () => {
    const { bindSeatingChartHandle } = await import('@seatlayer/js');
    const handle = bindSeatingChartHandle(() => null);
    expect(handle.getCurrentHold()).toBeNull();
    expect(handle.getGAAreas()).toEqual([]);
    expect(handle.getSelection()).toEqual([]);
    expect(handle.getFloors()).toEqual([]);
    await expect(handle.hold()).resolves.toBeNull();
    await expect(handle.release()).resolves.toBeUndefined();
    await expect(handle.releaseLabels([])).resolves.toBe(false);
    await expect(handle.refreshAccess()).resolves.toBe(false);
    expect(handle.zoomIn()).toBeUndefined();
  });
});

describe('@seatlayer/vue SeatingChart — rebuild policy', () => {
  it('rebuilds the canvas when an identity prop changes', async () => {
    const { setProps } = await mount({ event: 'ev_1' });
    expect(constructed).toHaveLength(1);

    await setProps({ event: 'ev_2' });
    expect(constructed).toHaveLength(2);
    expect(destroyed).toHaveLength(1);
    expect(constructed[1]).toMatchObject({ event: 'ev_2' });
  });

  it('rebuilds on initialView and errorDisplay — the two props Vue used to ignore', async () => {
    const { setProps } = await mount({ event: 'ev_1', initialView: 'flat', errorDisplay: 'none' });
    expect(constructed[0]).toMatchObject({ initialView: 'flat', errorDisplay: 'none' });

    await setProps({ initialView: 'isometric' });
    expect(constructed).toHaveLength(2);
    expect(constructed[1]).toMatchObject({ initialView: 'isometric', errorDisplay: 'none' });

    await setProps({ errorDisplay: 'message' });
    expect(constructed).toHaveLength(3);
    expect(constructed[2]).toMatchObject({ errorDisplay: 'message' });
  });

  it('does NOT rebuild when a non-identity prop changes', async () => {
    const { setProps } = await mount({ event: 'ev_1', seatTooltip: true });
    expect(constructed).toHaveLength(1);

    await setProps({ seatTooltip: false });
    await setProps({ messages: { 'map.fromPrice': 'ab {price}' } });

    expect(constructed).toHaveLength(1);
    expect(destroyed).toHaveLength(0);
  });
});
