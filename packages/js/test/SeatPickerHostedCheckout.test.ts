/**
 * `checkout: 'hosted'` — the routing decision the widget makes once seats are
 * held.
 *
 * Two things are being pinned here, and the first matters more than the second.
 *
 * ONE: the default did not move. Every integration that has ever embedded this
 * widget is on `onCheckout`, and the whole option is only defensible if that
 * path is byte-for-byte what it was — including asking the server nothing.
 *
 * TWO: an event that cannot take money never dead-ends the buyer. `payment-
 * options` has three ways of saying "no", two of which give opposite advice, so
 * each is checked separately rather than as "the empty case".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatPicker, type SeatPickerOptions } from '../src/SeatPicker';
import type { HoldResult } from '../src/api';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  document.getElementById('seatlayer-checkout-style')?.remove();
  vi.restoreAllMocks();
});

const hold: HoldResult = {
  holdId: 'h_1',
  expiresAt: Date.now() + 600_000,
  seats: [{ id: 's1', label: 'A1' } as never],
  items: [{
    label: 'A1', objectId: 'r1', objectType: 'seat', categoryKey: 'std',
    tierId: null, unitPrice: 45, currency: 'USD',
  }],
};

/* eslint-disable @typescript-eslint/no-explicit-any -- exercising private state */
interface Harness { picker: any; root: HTMLDivElement; pub: Record<string, any> }

/**
 * A picker with a root and a stubbed public client, but no chart: the checkout
 * decision runs entirely off a hold the CTA already produced, so mounting Konva
 * would only add a fetch this has no opinion about.
 */
function mounted(overrides: Partial<SeatPickerOptions> = {}, pubOverrides: Record<string, any> = {}): Harness {
  const picker = new SeatPicker({ event: 'ev_test', container, ...overrides }) as any;
  const root = document.createElement('div');
  container.appendChild(root);
  picker.root = root;
  const pub = {
    paymentOptions: vi.fn().mockResolvedValue({ providers: ['stripe'], currency: 'USD', reason: null }),
    startCheckout: vi.fn().mockResolvedValue({
      orderId: 'or_1', totalMinor: 4500, currency: 'USD', expiresAt: 0,
      redirectUrl: 'https://checkout.stripe.test/pay',
    }),
    orderStatus: vi.fn().mockResolvedValue({
      orderId: 'or_1', status: 'confirmed', totalMinor: 4500,
      currency: 'USD', amountFormatted: '45.00', seatCount: 1,
    }),
    ...pubOverrides,
  };
  if (picker.pubApi) Object.assign(picker.pubApi, pub);
  return { picker, root, pub };
}

describe('the default is untouched', () => {
  it('hands off to onCheckout and asks the server nothing about payment', async () => {
    const onCheckout = vi.fn();
    const { picker, pub, root } = mounted({ onCheckout });
    picker.checkoutHandoff(hold, hold.seats);
    await Promise.resolve();
    expect(onCheckout).toHaveBeenCalledOnce();
    expect(onCheckout.mock.calls[0][2].holdId).toBe('h_1');
    expect(pub.paymentOptions).not.toHaveBeenCalled();
    expect(root.querySelector('.sl-hco')).toBeNull();
  });

  it('resolves the mode once, in the constructor', () => {
    // Every later read is a field comparison. Re-deriving it per call is how a
    // widget ends up in one mode for the CTA and another for the return URL.
    expect((mounted().picker).checkoutMode).toBe('handoff');
    expect((mounted({ checkout: 'hosted' }).picker).checkoutMode).toBe('hosted');
  });
});

describe('hosted checkout, when the event can take money', () => {
  it('opens the card with the priced hold and never fires onCheckout', async () => {
    const onCheckout = vi.fn();
    const { picker, pub, root } = mounted({ checkout: 'hosted', onCheckout });
    await picker.startHostedCheckout(hold, hold.seats);
    expect(pub.paymentOptions).toHaveBeenCalledWith('ev_test');
    const card = root.querySelector('.sl-hco');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.sl-hco-seat')!.textContent).toBe('A1');
    // Two checkouts for one hold is exactly the double-charge shape hosted mode
    // exists to remove.
    expect(onCheckout).not.toHaveBeenCalled();
  });

  it('carries the buyer to the gateway and reports a confirmed order', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location, search: '', assign,
    } as unknown as Location);
    const onOrderConfirmed = vi.fn();
    const { picker, pub, root } = mounted({ checkout: 'hosted', onOrderConfirmed });
    await picker.startHostedCheckout(hold, hold.seats);
    const email = root.querySelector<HTMLInputElement>('.sl-hco-input')!;
    email.value = 'buyer@example.test';
    email.dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/pay'));
    expect(pub.startCheckout).toHaveBeenCalledWith('ev_test', {
      holdId: 'h_1', buyerEmail: 'buyer@example.test',
    });
    expect(onOrderConfirmed).not.toHaveBeenCalled(); // nothing is paid yet
  });
});

describe('hosted checkout, when the event cannot', () => {
  const reasons = ['not_configured', 'payments_off_for_event', 'unavailable_for_event'] as const;

  it.each(reasons)('reports %s to the host and still hands the hold over', async (reason) => {
    const onCheckout = vi.fn();
    const onCheckoutUnavailable = vi.fn();
    const { picker, root } = mounted(
      { checkout: 'hosted', onCheckout, onCheckoutUnavailable },
      { paymentOptions: vi.fn().mockResolvedValue({ providers: [], currency: null, reason }) },
    );
    await picker.startHostedCheckout(hold, hold.seats);
    expect(onCheckoutUnavailable).toHaveBeenCalledOnce();
    expect(onCheckoutUnavailable.mock.calls[0][0].reason).toBe(reason);
    expect(onCheckoutUnavailable.mock.calls[0][0].handoff.holdId).toBe('h_1');
    // The fallback IS the default path, with the same three arguments. A host
    // that never enabled hosted checkout and one whose event turned out not to
    // support it get identical calls.
    expect(onCheckout).toHaveBeenCalledOnce();
    expect(onCheckout.mock.calls[0][2].holdId).toBe('h_1');
    // The host was told; the widget does not also take over the screen.
    expect(root.querySelector('.sl-hco')).toBeNull();
  });

  it.each(reasons)('shows its own honest card for %s when the host handles neither', async (reason) => {
    const { picker, root } = mounted(
      { checkout: 'hosted' },
      { paymentOptions: vi.fn().mockResolvedValue({ providers: [], currency: null, reason }) },
    );
    await picker.startHostedCheckout(hold, hold.seats);
    await vi.waitFor(() => expect(root.querySelector('.sl-hco')).not.toBeNull());
    // Whatever it says, it must not be a form: there is nothing to pay here.
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('.sl-hco-note')!.textContent).toContain('Nothing has been charged');
  });

  it('blames nobody when the lookup itself fails', async () => {
    // A failed read is not evidence about the organizer's setup, so it must fall
    // to the reason that asserts the least about them — never to a story.
    const onError = vi.fn();
    const onCheckoutUnavailable = vi.fn();
    const { picker } = mounted(
      { checkout: 'hosted', onError, onCheckoutUnavailable },
      { paymentOptions: vi.fn().mockRejectedValue(new Error('offline')) },
    );
    await picker.startHostedCheckout(hold, hold.seats);
    expect(onCheckoutUnavailable.mock.calls[0][0].reason).toBe('not_configured');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('treats a reason it has never heard of the same way', async () => {
    // A newer worker naming a fourth reason must not become a fourth sentence
    // invented by an older widget.
    const onCheckoutUnavailable = vi.fn();
    const { picker } = mounted(
      { checkout: 'hosted', onCheckoutUnavailable },
      { paymentOptions: vi.fn().mockResolvedValue({ providers: [], reason: 'refunds_only' }) },
    );
    await picker.startHostedCheckout(hold, hold.seats);
    expect(onCheckoutUnavailable.mock.calls[0][0].reason).toBe('not_configured');
  });

});

describe('a host-supplied transport keeps hosted checkout off', () => {
  it('warns once and stays on the default rather than reaching past it', () => {
    // A transport owns its own backend and credentials. Silently talking to
    // api.seatlayer.io anyway would be the widget deciding where money goes.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { picker } = mounted({ checkout: 'hosted', transport: {} as never });
    expect(picker.checkoutMode).toBe('handoff');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('coming back from a hosted gateway page', () => {
  const withSearch = (search: string) => {
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location, search, pathname: '/tickets', hash: '',
    } as unknown as Location);
  };

  it('resumes the order and clears the one-shot parameters', async () => {
    withSearch('?order=or_1&status=success&utm=x');
    const replaceState = vi.spyOn(history, 'replaceState').mockImplementation(() => {});
    const onOrderConfirmed = vi.fn();
    const { picker, pub, root } = mounted({ checkout: 'hosted', onOrderConfirmed });
    picker.controller.refresh = vi.fn().mockResolvedValue(undefined);
    picker.resumeHostedOrder();
    await vi.waitFor(() => expect(onOrderConfirmed).toHaveBeenCalledOnce());
    expect(pub.orderStatus).toHaveBeenCalledWith('or_1');
    expect(root.querySelector('.sl-hco-ref')!.textContent).toBe('or_1');
    // The host's own parameters survive; ours do not.
    expect(replaceState.mock.calls[0][2]).toBe('/tickets?utm=x');
    // The seats are sold — the map must be re-read rather than left stale.
    expect(picker.controller.refresh).toHaveBeenCalled();
  });

  it('says nothing when the buyer cancelled at the gateway', async () => {
    // Their seats are still held, so the map IS the right screen. A card saying
    // "you cancelled" is noise over the thing they need.
    withSearch('?order=or_1&status=cancelled');
    vi.spyOn(history, 'replaceState').mockImplementation(() => {});
    const { picker, pub, root } = mounted({ checkout: 'hosted' });
    picker.resumeHostedOrder();
    await Promise.resolve();
    expect(pub.orderStatus).not.toHaveBeenCalled();
    expect(root.querySelector('.sl-hco')).toBeNull();
  });

  it('ignores a return URL entirely on the default path', () => {
    withSearch('?order=or_1&status=success');
    const replaceState = vi.spyOn(history, 'replaceState').mockImplementation(() => {});
    const { picker, pub } = mounted({});
    picker.resumeHostedOrder();
    expect(pub.orderStatus).not.toHaveBeenCalled();
    // And it does not touch a handoff host's URL, which is none of its business.
    expect(replaceState).not.toHaveBeenCalled();
  });
});
