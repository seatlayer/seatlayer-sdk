/**
 * The hosted-checkout card itself — the lazy chunk, tested directly.
 *
 * It is worth testing apart from the picker because it is the only place in the
 * SDK where a buyer's money is at stake, and because its three states are the
 * same card: it is easy to make one of them silently render another's chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  errorCopy,
  mountCheckout,
  unavailableCopy,
  type CheckoutMount,
  type CheckoutOrderStatus,
  type CheckoutState,
} from '../src/hostedCheckout';

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  root.remove();
  document.getElementById('seatlayer-checkout-style')?.remove();
  vi.useRealTimers();
});

const order = {
  holdId: 'h_1', expiresAt: Date.now() + 600_000, currency: 'USD', total: 90, labels: ['A1', 'A2'],
};

const confirmedStatus: CheckoutOrderStatus = {
  orderId: 'or_1', status: 'confirmed', totalMinor: 9000,
  currency: 'USD', amountFormatted: '90.00', seatCount: 2,
};

function mount(state: CheckoutState, overrides: Partial<CheckoutMount> = {}) {
  const startSession = overrides.startSession
    ?? vi.fn().mockResolvedValue({ orderId: 'or_1', totalMinor: 9000, currency: 'USD', expiresAt: 0 });
  const orderStatus = overrides.orderStatus ?? vi.fn().mockResolvedValue(confirmedStatus);
  const onCancel = overrides.onCancel ?? vi.fn();
  const onConfirmed = overrides.onConfirmed ?? vi.fn();
  const handle = mountCheckout({
    root, state, startSession, orderStatus, onCancel, onConfirmed, onError: overrides.onError,
  });
  return { handle, startSession, orderStatus, onCancel, onConfirmed };
}

describe('the pay state', () => {
  it('cannot be paid until the email is usable', () => {
    mount({ kind: 'pay', order, provider: 'stripe' });
    const pay = root.querySelector<HTMLButtonElement>('.sl-hco-pay')!;
    const email = root.querySelector<HTMLInputElement>('.sl-hco-input')!;
    expect(pay.disabled).toBe(true);
    email.value = 'nope';
    email.dispatchEvent(new Event('input'));
    expect(pay.disabled).toBe(true);
    email.value = 'buyer@example.test';
    email.dispatchEvent(new Event('input'));
    expect(pay.disabled).toBe(false);
  });

  it('never names a provider in the session it starts', async () => {
    // The event row decides which gateway charges. Naming one from the browser
    // is the defect the server now 409s on, so the widget must not send it —
    // and this is the assert that keeps it that way.
    const { startSession } = mount({ kind: 'pay', order, provider: 'stripe' });
    const email = root.querySelector<HTMLInputElement>('.sl-hco-input')!;
    email.value = 'buyer@example.test';
    email.dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => expect(startSession).toHaveBeenCalled());
    const sent = (startSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent).toEqual({ holdId: 'h_1', buyerEmail: 'buyer@example.test' });
    expect('provider' in sent).toBe(false);
  });

  it('tells the buyer their money is safe when the server refuses', async () => {
    const onError = vi.fn();
    const startSession = vi.fn().mockRejectedValue(
      Object.assign(new Error('hold_not_active'), { code: 'hold_not_active' }),
    );
    mount({ kind: 'pay', order, provider: 'stripe' }, { startSession, onError });
    const email = root.querySelector<HTMLInputElement>('.sl-hco-input')!;
    email.value = 'buyer@example.test';
    email.dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => expect(root.querySelector('.sl-hco-error')).not.toBeNull());
    expect(root.querySelector('.sl-hco-error')!.textContent).toContain('Nothing was charged');
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('the resume state', () => {
  it('waits on the order and never offers to pay a second time', async () => {
    const { orderStatus, onConfirmed } = mount({ kind: 'resume', orderId: 'or_1' });
    // The buyer has already been to the gateway. A form here could take a second
    // payment for a purchase that may have already succeeded.
    expect(root.querySelector('form')).toBeNull();
    await vi.waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(confirmedStatus));
    expect(orderStatus).toHaveBeenCalledWith('or_1');
    expect(root.querySelector('.sl-hco-title')!.textContent).toBe('Your tickets are confirmed');
    expect(root.querySelector('.sl-hco-ref')!.textContent).toBe('or_1');
  });

  it('reports a released hold as released, not as a payment failure', async () => {
    const orderStatus = vi.fn().mockResolvedValue({ ...confirmedStatus, status: 'expired' });
    const { onConfirmed } = mount({ kind: 'resume', orderId: 'or_1' }, { orderStatus });
    await vi.waitFor(() => expect(root.querySelector('.sl-hco-error')).not.toBeNull());
    expect(root.querySelector('.sl-hco-error')!.textContent).toContain('released before payment');
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('stops polling once the card is destroyed', async () => {
    const orderStatus = vi.fn().mockResolvedValue({ ...confirmedStatus, status: 'pending' });
    const { handle } = mount({ kind: 'resume', orderId: 'or_1' }, { orderStatus });
    await vi.waitFor(() => expect(orderStatus).toHaveBeenCalled());
    handle.destroy();
    const seen = orderStatus.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(orderStatus.mock.calls.length).toBe(seen);
  });
});

describe('the unavailable state', () => {
  it('renders the reason it was given and leaves a way back', () => {
    const { onCancel } = mount({ kind: 'unavailable', reason: 'payments_off_for_event', seatCount: 2 });
    expect(root.querySelector('.sl-hco-title')!.textContent).toBe('This event isn’t sold online');
    expect(root.querySelector('.sl-hco-status')!.textContent).toContain('2 seats are held');
    root.querySelector<HTMLButtonElement>('.sl-hco-back')!.click();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(root.querySelector('.sl-hco')).toBeNull();
  });
});

describe('unavailableCopy', () => {
  it('never sends a buyer to complain about a deliberate decision', () => {
    const off = unavailableCopy('payments_off_for_event', 1);
    expect(off.detail).not.toContain('organiser know');
    expect(off.body).toContain('1 seat is held');
  });

  it('does send them to the organizer when the setup is genuinely broken', () => {
    expect(unavailableCopy('unavailable_for_event', 3).detail).toContain('let the organiser know');
  });

  it('points an API-integrated host\'s buyer at the host\'s own checkout', () => {
    expect(unavailableCopy('not_configured', 1).title).toBe('Finish in the ticketing checkout');
  });

  it('says nothing was charged in every one of the three', () => {
    for (const reason of ['not_configured', 'payments_off_for_event', 'unavailable_for_event'] as const) {
      expect(unavailableCopy(reason, 1).detail).toContain('Nothing has been charged');
    }
  });
});

describe('errorCopy', () => {
  it('answers the only question a buyer has, on every code and the unknown one', () => {
    for (const code of [
      undefined, 'gateway_not_connected', 'payments_not_enabled_for_event', 'provider_mismatch',
      'hold_not_found', 'checkout_already_started', 'gateway_currency_mismatch', 'rate_limited',
    ]) {
      const copy = errorCopy(code);
      expect(copy.length).toBeGreaterThan(0);
    }
    // The refund promise belongs only where a charge could not have happened.
    expect(errorCopy('hold_not_active')).toContain('Nothing was charged');
    expect(errorCopy(undefined)).toContain('Nothing was charged');
  });
});
