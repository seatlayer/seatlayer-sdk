/**
 * The component starts the chart's first request from ngOnChanges (the first
 * one runs before the view exists, so ahead of the first build); the build
 * adopts it, so the page still makes one request. Same Object.create harness
 * as SeatingChartComponent.test.ts: ngOnChanges and the build are real code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ order: [] as string[], prewarms: [] as Array<Record<string, unknown>> }));

vi.mock('@seatlayer/js', async () => {
  const actual = await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js');
  class FakeSeatingChart {
    constructor(options: Record<string, unknown>) { state.order.push(`construct:${String(options.event)}`); }
    render() { return Promise.resolve(); }
    destroy() { state.order.push('destroy'); }
  }
  return {
    ...actual,
    SeatingChart: FakeSeatingChart,
    prewarmSeatPicker: (options: Record<string, unknown>) => {
      state.order.push(`prewarm:${String(options.event)}`);
      state.prewarms.push(options);
    },
  };
});

type Component = Record<string, unknown> & { ngOnChanges(changes: Record<string, unknown>): void };
const PK = `pk_live_${'a'.repeat(48)}`;

async function makeComponent(inputs: Record<string, unknown>, withView = true): Promise<Component> {
  const { SeatLayerSeatingChartComponent } = await import('../src/seating-chart.component');
  const component = Object.create(SeatLayerSeatingChartComponent.prototype) as Component;
  Object.assign(component, {
    zone: { runOutsideAngular: (fn: () => void) => fn(), run: (fn: () => void) => fn() },
    // The first ngOnChanges runs before @ViewChild resolves.
    container: withView ? { nativeElement: document.createElement('div') } : undefined,
    chart: null,
    ...inputs,
  });
  return component;
}

const changes = (...names: string[]) => Object.fromEntries(names.map((name) => [name, { currentValue: undefined }]));

beforeEach(() => { state.order.length = 0; state.prewarms.length = 0; });

describe('@seatlayer/angular SeatingChart starts its bootstrap from ngOnChanges', () => {
  it('prewarms on the first ngOnChanges, before any view or build exists', async () => {
    const component = await makeComponent({ event: 'ev_1', publicKey: PK, apiBase: 'https://api.example.test' }, false);
    component.ngOnChanges(changes('event', 'publicKey', 'apiBase'));
    expect(state.order).toEqual(['prewarm:ev_1']);
    expect(state.prewarms[0]).toEqual({ event: 'ev_1', publicKey: PK, apiBase: 'https://api.example.test' });
  });

  it('a new event prewarms once, ahead of its rebuild; a non-fetching input does not', async () => {
    const component = await makeComponent({ event: 'ev_1', publicKey: PK });
    component.ngOnChanges(changes('event', 'publicKey'));
    expect(state.order).toEqual(['prewarm:ev_1', 'construct:ev_1']);
    component.locale = 'de';
    component.ngOnChanges(changes('locale'));
    expect(state.order.filter((line) => line.startsWith('prewarm'))).toEqual(['prewarm:ev_1']);
    component.event = 'ev_2';
    component.ngOnChanges(changes('event'));
    expect(state.order.slice(-3)).toEqual(['prewarm:ev_2', 'destroy', 'construct:ev_2']);
  });

  it('never prewarms without a public key or with host-supplied buyer access', async () => {
    for (const inputs of [{ event: 'ev_n' }, { event: 'ev_n', publicKey: PK, buyerAccessToken: 'bse_x' }, { event: 'ev_n', publicKey: PK, buyerAccessTokenProvider: async () => 'bse_y' }]) {
      const component = await makeComponent(inputs);
      component.ngOnChanges(changes('event', 'publicKey'));
    }
    expect(state.prewarms).toEqual([]);
  });
});
