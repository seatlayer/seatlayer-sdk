import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Regression guard for a silent prop drop.
 *
 * `SeatPickerProps extends Omit<SeatPickerOptions, 'container'>`, so every core
 * option type-checks on the React component whether or not the wrapper actually
 * forwards it. Between 0.17 and 0.19 the wrapper destructured a hand-maintained
 * field list, so `pricing`, `hideBadge` and `transport` were accepted by the
 * compiler and then discarded at runtime — a host wiring up host-authoritative
 * pricing got a green build and wrong prices, with no signal anywhere.
 *
 * These tests assert against the options object the core class actually
 * receives, so any future option that the wrapper forgets fails here.
 */

const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock('@seatlayer/js', () => ({
  SeatPicker: class {
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options);
    }
    render() {
      return Promise.resolve();
    }
    destroy() {}
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  constructorCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mount the wrapper with `props` and return the options core was constructed with. */
async function mountWith(props: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { SeatPicker } = await import('../src/SeatPicker');
  await act(async () => {
    root.render(createElement(SeatPicker, { event: 'evt_test', ...props } as never));
  });
  expect(constructorCalls).toHaveLength(1);
  return constructorCalls[0]!;
}

describe('SeatPicker prop forwarding', () => {
  it('forwards pricing — the option whose loss silently mispriced tickets', async () => {
    const pricing = { categories: { vip: 12000 } };
    const options = await mountWith({ pricing });
    expect(options.pricing).toEqual(pricing);
  });

  it('forwards hideBadge and transport', async () => {
    const transport = { socketUrl: () => 'wss://example.test' };
    const options = await mountWith({ hideBadge: true, transport });
    expect(options.hideBadge).toBe(true);
    expect(options.transport).toBe(transport);
  });

  it('forwards an option the wrapper never names, so new core options cannot be dropped', async () => {
    // Stands in for whatever ships next: the wrapper must not filter by name.
    const options = await mountWith({ someFutureOption: 'forwarded' });
    expect(options.someFutureOption).toBe('forwarded');
  });

  it('keeps React-only props out of the core options', async () => {
    const options = await mountWith({ className: 'w-full', style: { height: 400 } });
    expect(options).not.toHaveProperty('className');
    expect(options).not.toHaveProperty('style');
  });

  it('passes the container element through', async () => {
    const options = await mountWith({});
    expect(options.container).toBeInstanceOf(HTMLElement);
  });

  it('forwards the buyer access options and the typed access callbacks', async () => {
    const buyerAccessTokenProvider = vi.fn(async () => ({ token: 'bse_x' }));
    const onAccessExpired = vi.fn();
    const onAccessUnavailable = vi.fn();
    const onSelectedObjectUnavailable = vi.fn();
    const options = await mountWith({
      buyerAccessTokenProvider,
      buyerAccessToken: 'bse_seed',
      onAccessExpired,
      onAccessUnavailable,
      onSelectedObjectUnavailable,
    });

    expect(options.buyerAccessToken).toBe('bse_seed');
    // The provider is wrapped (so an inline arrow never rebuilds the widget),
    // but it must still reach the host function it stands for.
    await (options.buyerAccessTokenProvider as (c: unknown) => Promise<unknown>)({ reason: 'initial' });
    expect(buyerAccessTokenProvider).toHaveBeenCalledWith({ reason: 'initial' });

    (options.onAccessExpired as (e: unknown) => void)({ reason: 'unauthorized', refreshed: false });
    (options.onAccessUnavailable as (e: unknown) => void)({ reason: 'revoked', retryable: false });
    (options.onSelectedObjectUnavailable as (e: unknown) => void)({ labels: ['A-1'], reason: 'taken' });
    expect(onAccessExpired).toHaveBeenCalledWith({ reason: 'unauthorized', refreshed: false });
    expect(onAccessUnavailable).toHaveBeenCalledWith({ reason: 'revoked', retryable: false });
    expect(onSelectedObjectUnavailable).toHaveBeenCalledWith({ labels: ['A-1'], reason: 'taken' });
  });

  it('leaves the provider undefined when the host did not pass one', async () => {
    const options = await mountWith({});
    expect(options.buyerAccessTokenProvider).toBeUndefined();
  });
});
