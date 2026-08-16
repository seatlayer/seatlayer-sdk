/**
 * @seatlayer/angular had ZERO tests. These are the same three properties the
 * React and Vue suites pin: every handle method is forwarded, an identity input
 * rebuilds the canvas, a non-identity input does not.
 *
 * NO TestBed, deliberately. Driving a real component would need
 * `@angular/platform-browser` + `@angular/platform-browser-dynamic`, which this
 * package does not depend on (it ships a standalone component and nothing else),
 * and adding two Angular runtimes as devDependencies to unit-test 30 lines of
 * delegation is a bad trade. Instead the class is built with `Object.create`,
 * which skips only the constructor's `inject(DestroyRef)` — nothing these tests
 * are about. `ngOnChanges`, the rebuild decision, the options assembly and every
 * imperative method are the component's real code, running.
 *
 * What this does NOT cover, and the browser pass must: NgZone re-entry on emit,
 * and `@ViewChild` timing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  destroyed: [] as unknown[],
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));
const { constructed, destroyed, calls } = state;

vi.mock('@seatlayer/js', async () => {
  const actual = await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js');
  class FakeSeatingChart {
    constructor(options: Record<string, unknown>) { state.constructed.push(options); }
    render() { return Promise.resolve(); }
    destroy() { state.destroyed.push(this); }
  }
  for (const method of actual.SEATING_CHART_HANDLE_METHODS) {
    (FakeSeatingChart.prototype as unknown as Record<string, unknown>)[method] =
      (...args: unknown[]) => {
        state.calls.push({ method, args });
        return `called:${method}`;
      };
  }
  return { ...actual, SeatingChart: FakeSeatingChart };
});

const { SEATING_CHART_HANDLE_METHODS, SEATING_CHART_IDENTITY_PROPS } =
  await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js');

// Angular renames exactly one method, because `hold` is taken by its @Output.
// The map is asserted complete against the shared list below, so a method added
// to the contract fails here until the component forwards it.
const ANGULAR_METHOD_NAMES: Record<string, string> = {
  hold: 'holdSelection',
};

/** Handle methods declared `: void` — they forward the call and return nothing. */
const VOID_METHODS = new Set<string>([
  'setSeatTier', 'setFloor', 'setColorblindSafe', 'zoomIn', 'zoomOut', 'zoomToFit',
]);

type Component = Record<string, unknown> & {
  ngOnChanges(changes: Record<string, unknown>): void;
};

async function makeComponent(inputs: Record<string, unknown> = {}): Promise<Component> {
  const { SeatLayerSeatingChartComponent } = await import('../src/seating-chart.component');
  const element = document.createElement('div');
  const component = Object.create(SeatLayerSeatingChartComponent.prototype) as Component;
  Object.assign(component, {
    // What the constructor and @ViewChild would have provided.
    zone: { runOutsideAngular: (fn: () => void) => fn(), run: (fn: () => void) => fn() },
    container: { nativeElement: element },
    chart: null,
    ...inputs,
  });
  // `handle` is a field initialiser, so Object.create skipped it.
  const { bindSeatingChartHandle } = await import('@seatlayer/js');
  Object.assign(component, { handle: bindSeatingChartHandle(() => component.chart as never) });
  // Every @Output the build path emits through.
  for (const output of [
    'selectionChange', 'hold', 'holdRestored', 'holdExpired', 'gaClick', 'errored',
    'deckTap', 'hint', 'seatHover', 'accessExpired', 'accessUnavailable',
    'selectedObjectUnavailable',
  ]) {
    if (!(output in component)) component[output] = { emit: vi.fn() };
  }
  return component;
}

/** Angular hands ngOnChanges a SimpleChanges map; only the KEYS matter here. */
const changes = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { currentValue: undefined }]));

beforeEach(() => {
  constructed.length = 0;
  destroyed.length = 0;
  calls.length = 0;
});

describe('@seatlayer/angular SeatingChart — handle forwarding', () => {
  it('renames exactly the methods ANGULAR_METHOD_NAMES claims, and nothing else', () => {
    for (const key of Object.keys(ANGULAR_METHOD_NAMES)) {
      expect(SEATING_CHART_HANDLE_METHODS as readonly string[]).toContain(key);
    }
  });

  it('exposes every method in SEATING_CHART_HANDLE_METHODS, and each reaches the chart', async () => {
    const component = await makeComponent({ event: 'ev_1' });
    component.ngOnChanges(changes('event'));
    expect(constructed).toHaveLength(1);

    // Angular's delegates have DECLARED arity (`holdSelection(options?)` passes
    // exactly one argument on), unlike Vue's rest-args handle — so this loop
    // pins reachability and the returned value, and argument fidelity is pinned
    // below on the two methods that carry the most parameters.
    for (const method of SEATING_CHART_HANDLE_METHODS) {
      const name = ANGULAR_METHOD_NAMES[method] ?? method;
      expect(typeof component[name], `${name} is not on the component`).toBe('function');
      const result = (component[name] as (...a: unknown[]) => unknown).call(component, 'arg-a', 'arg-b');
      expect(calls.at(-1)?.method, `${name} did not reach the chart`).toBe(method);
      // The six `: void` methods deliberately return nothing; the rest must
      // hand back what the chart said, not a fallback.
      if (!VOID_METHODS.has(method)) {
        expect(result, `${name} did not return the chart's answer`).toBe(`called:${method}`);
      }
    }
    expect(calls).toHaveLength(SEATING_CHART_HANDLE_METHODS.length);
  });

  it('passes every declared argument through, not just the first', async () => {
    const component = await makeComponent({ event: 'ev_1' });
    component.ngOnChanges(changes('event'));

    (component.holdGA as (a: string, b: number, c: unknown) => unknown)
      .call(component, 'ga_1', 3, { tierId: 't_child', ttlMs: 900 });
    expect(calls.at(-1)).toEqual({
      method: 'holdGA',
      args: ['ga_1', 3, { tierId: 't_child', ttlMs: 900 }],
    });

    (component.setSeatTier as (a: string, b: string | null) => void).call(component, 'seat_9', null);
    expect(calls.at(-1)).toEqual({ method: 'setSeatTier', args: ['seat_9', null] });

    (component.bestAvailable as (a: number, b?: string) => unknown).call(component, 4, 'vip');
    expect(calls.at(-1)).toEqual({ method: 'bestAvailable', args: [4, 'vip'] });
  });

  it('answers an empty value instead of throwing before the chart is built', async () => {
    const component = await makeComponent({ event: 'ev_1' });
    expect(component.getCurrentHold as () => unknown).toBeTypeOf('function');
    expect((component.getCurrentHold as () => unknown)()).toBeNull();
    expect((component.getGAAreas as () => unknown)()).toEqual([]);
    await expect((component.holdSelection as () => Promise<unknown>)()).resolves.toBeNull();
  });
});

describe('@seatlayer/angular SeatingChart — rebuild policy', () => {
  it('rebuilds on every identity input, including initialView and errorDisplay', async () => {
    for (const prop of SEATING_CHART_IDENTITY_PROPS) {
      constructed.length = 0;
      destroyed.length = 0;
      const component = await makeComponent({ event: 'ev_1' });
      component.ngOnChanges(changes('event'));
      expect(constructed).toHaveLength(1);

      component.ngOnChanges(changes(prop));
      expect(constructed, `${prop} did not rebuild the canvas`).toHaveLength(2);
      expect(destroyed, `${prop} rebuilt without tearing the old canvas down`).toHaveLength(1);
    }
  });

  it('does NOT rebuild when a non-identity input changes', async () => {
    const component = await makeComponent({ event: 'ev_1' });
    component.ngOnChanges(changes('event'));
    expect(constructed).toHaveLength(1);

    component.ngOnChanges(changes('seatTooltip'));
    component.ngOnChanges(changes('messages'));
    component.ngOnChanges(changes('buyerAccessToken'));

    expect(constructed).toHaveLength(1);
    expect(destroyed).toHaveLength(0);
  });

  it('forwards initialView and errorDisplay into the core options', async () => {
    const component = await makeComponent({
      event: 'ev_1', initialView: 'flat', errorDisplay: 'none', seatTooltip: false,
    });
    component.ngOnChanges(changes('event'));
    expect(constructed[0]).toMatchObject({
      event: 'ev_1', initialView: 'flat', errorDisplay: 'none', seatTooltip: false,
    });
  });
});
