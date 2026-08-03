/**
 * What a buyer gets when the checkout chunk does not arrive.
 *
 * Splitting payment UI out of the main bundle buys every buyer ~4 KB gzipped and
 * costs one network request at the exact moment a buyer is trying to give
 * someone money. On a hotel wifi, a corporate proxy, or a CDN blip, that request
 * fails — and the failure mode must be "your seats are still held, try again",
 * never a CTA that has stopped doing anything.
 *
 * Its own file because the mock has to replace the module for the whole module
 * graph, which no other test in this suite wants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatPicker } from '../src/SeatPicker';
import type { HoldResult } from '../src/api';

vi.mock('../src/hostedCheckout', () => Promise.reject(new Error('chunk_unreachable')));

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

const hold: HoldResult = {
  holdId: 'h_1',
  expiresAt: Date.now() + 600_000,
  seats: [],
  items: [{
    label: 'A1', objectId: 'r1', objectType: 'seat', categoryKey: 'std',
    tierId: null, unitPrice: 45, currency: 'USD',
  }],
};

describe('a checkout chunk that never loads', () => {
  it('tells the buyer their seats are still held instead of swallowing the press', async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- private state */
    const picker = new SeatPicker({ event: 'ev_test', container, checkout: 'hosted' }) as any;
    picker.root = document.createElement('div');
    container.appendChild(picker.root);
    Object.assign(picker.pubApi, {
      paymentOptions: vi.fn().mockResolvedValue({ providers: ['stripe'], currency: 'USD', reason: null }),
    });
    const errors: unknown[] = [];
    picker.opts.onError = (err: unknown) => errors.push(err);
    const toasts: string[] = [];
    picker.toast = (message: string) => toasts.push(message);
    picker.setCtaPhase = vi.fn();

    await picker.startHostedCheckout(hold, []);

    expect(errors.length).toBe(1);
    expect(toasts[0]).toContain('seats are still held');
    expect(picker.root.querySelector('.sl-hco')).toBeNull();
    // The CTA is stood back down so the buyer can press it again.
    expect(picker.setCtaPhase).toHaveBeenCalledWith('idle');
  });
});
