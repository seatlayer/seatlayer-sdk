import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SeasonPickerHandle } from '../src/SeasonPicker';

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
    holdBestAvailable(...args: unknown[]) {
      calls.push({ method: 'holdBestAvailable', args });
      return Promise.resolve({ operationId: args[1] });
    }
    restoreOperation(...args: unknown[]) {
      calls.push({ method: 'restoreOperation', args });
      return Promise.resolve(null);
    }
    markBooked() { return Promise.resolve(true); }
    release(...args: unknown[]) { calls.push({ method: 'release', args }); return Promise.resolve(); }
    createRenewalIntent(...args: unknown[]) {
      calls.push({ method: 'createRenewalIntent', args });
      return Promise.resolve({ offerId: args[0] });
    }
    getDescriptor() { return { key: 'sea_1' }; }
    getAvailability() { return { freeCount: 4 }; }
    getHandoff() { return { operationId: 'sop_1' }; }
    getHeldOrder() { return { operationId: 'sop_1', expiresAt: 1, currency: 'USD', seats: [], totalMinor: 0 }; }
    startDatesCheckout(...args: unknown[]) {
      calls.push({ method: 'startDatesCheckout', args });
      return Promise.resolve({ sessionId: 'cs_1' });
    }
  },
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  constructed.length = 0;
  calls.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('@seatlayer/react SeasonPicker', () => {
  it('forwards access/callbacks, exposes the safe handle, and owns teardown', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    const ref = createRef<SeasonPickerHandle>();
    const onContinue = vi.fn();
    await act(async () => {
      root.render(createElement(SeasonPicker, {
        ref,
        season: 'sea_1',
        buyerAccessToken: 'bss_secret',
        offer: { priceLabel: '$480' },
        className: 'season-host',
        onContinue,
      }));
    });

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ season: 'sea_1', buyerAccessToken: 'bss_secret' });
    expect(constructed[0]).not.toHaveProperty('className');
    expect(constructed[0]?.container).toBeInstanceOf(HTMLElement);
    (constructed[0]?.onContinue as (value: unknown) => void)({ operationId: 'sop_1' });
    expect(onContinue).toHaveBeenCalledWith({ operationId: 'sop_1' });

    await expect(ref.current?.holdSameSeat(['A-1'], 'sop_1'))
      .resolves.toEqual({ operationId: 'sop_1' });
    const bestAvailable = { categoryKey: 'stalls', zoneId: 'zone_lower', accessibility: ['wheelchair'] as const, requireContiguous: true };
    await expect(ref.current!.holdBestAvailable(2, 'sop_2', bestAvailable))
      .resolves.toEqual({ operationId: 'sop_2' });
    await ref.current!.holdBestAvailable(1, 'sop_3');
    expect(calls.filter((call) => call.method === 'holdBestAvailable').map((call) => call.args))
      .toEqual([[2, 'sop_2', bestAvailable], [1, 'sop_3', undefined]]);
    await expect(ref.current!.markBooked()).resolves.toBe(true);
    await ref.current?.release('sra_1');
    await expect(ref.current?.createRenewalIntent('sro_1'))
      .resolves.toEqual({ offerId: 'sro_1' });
    expect(ref.current?.getDescriptor()).toEqual({ key: 'sea_1' });
    expect(ref.current?.getHeldOrder()).toEqual({ operationId: 'sop_1', expiresAt: 1, currency: 'USD', seats: [], totalMinor: 0 });

    await act(async () => {
      root.render(createElement(SeasonPicker, {
        ref, season: 'sea_1', buyerAccessToken: 'bss_secret',
        offer: { priceLabel: '$480' },
      }));
    });
    expect(constructed).toHaveLength(1);

    await act(async () => {
      root.render(createElement(SeasonPicker, {
        ref, season: 'sea_2', buyerAccessToken: 'bss_secret',
      }));
    });
    expect(constructed).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
  });

  it('forwards priceTypes, rebuilds only when they change, and passes a type map to holdSameSeat', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    const ref = createRef<SeasonPickerHandle>();
    const props = { ref, season: 'sea_1', buyerAccessToken: 'bss_secret' };
    await act(async () => root.render(createElement(SeasonPicker, { ...props, priceTypes: ['adult', 'child'] })));
    expect(constructed[0]).toMatchObject({ priceTypes: ['adult', 'child'] });
    // A fresh array with the same types, as an inline prop is: same picker.
    await act(async () => root.render(createElement(SeasonPicker, { ...props, priceTypes: ['adult', 'child'] })));
    expect(constructed).toHaveLength(1);
    await act(async () => root.render(createElement(SeasonPicker, { ...props, priceTypes: ['adult', 'child', 'senior'] })));
    expect(constructed).toHaveLength(2);
    expect(constructed[1]).toMatchObject({ priceTypes: ['adult', 'child', 'senior'] });
    await ref.current!.holdSameSeat(['A-1', 'A-2'], 'sop_1', { 'A-2': 'child' });
    expect(calls.filter((call) => call.method === 'holdSameSeat').at(-1)?.args)
      .toEqual([['A-1', 'A-2'], 'sop_1', { 'A-2': 'child' }]);
  });

  it('forwards `package`, and opens on another package when it changes', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    const props = { season: 'sea_1' };
    await act(async () => root.render(createElement(SeasonPicker, { ...props, package: 'spl_half', ticketsByEmail: true })));
    expect(constructed[0]).toMatchObject({ package: 'spl_half', ticketsByEmail: true });
    await act(async () => root.render(createElement(SeasonPicker, { ...props, package: 'spl_half', ticketsByEmail: true })));
    expect(constructed).toHaveLength(1);
    await act(async () => root.render(createElement(SeasonPicker, { ...props, package: 'spl_full' })));
    expect(constructed).toHaveLength(2);
    expect(constructed[1]).toMatchObject({ package: 'spl_full' });
  });

  it('forwards `buyerEmail` and `buyerName` for the checkout card', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    await act(async () => root.render(createElement(SeasonPicker, {
      season: 'sea_1', buyerEmail: 'member@example.com', buyerName: 'Asha Rao',
    })));
    expect(constructed[0]).toMatchObject({ buyerEmail: 'member@example.com', buyerName: 'Asha Rao' });
  });

  it('forwards the three 3D options, and rebuilds when one changes', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    const three = { enable3D: false, enable3DCrowd: false, touchNavigation3D: 'classic' as const };
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', ...three })));
    expect(constructed[0]).toMatchObject(three);
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', ...three })));
    expect(constructed).toHaveLength(1);
    for (const [prop, value] of [
      ['enable3D', true], ['enable3DCrowd', true], ['touchNavigation3D', 'map'],
    ] as const) {
      const before = constructed.length;
      await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', ...three, [prop]: value })));
      expect(constructed, `${prop} did not rebuild`).toHaveLength(before + 1);
      expect(constructed.at(-1)).toMatchObject({ [prop]: value });
      await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', ...three })));
    }
  });

  it('sends none of the three 3D options when the host sets none', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1' })));
    expect(constructed[0]?.enable3D).toBeUndefined();
    expect(constructed[0]?.enable3DCrowd).toBeUndefined();
    expect(constructed[0]?.touchNavigation3D).toBeUndefined();
  });

  it('forwards releaseHoldOnDestroy (off unless set), never rebuilds on it, and the picker reads the latest value', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1' })));
    expect(constructed[0]?.releaseHoldOnDestroy).toBeUndefined();
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', releaseHoldOnDestroy: true })));
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.releaseHoldOnDestroy).toBe(true);
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', releaseHoldOnDestroy: false })));
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.releaseHoldOnDestroy).toBe(false);
    // One render and no destroy: the picker was never rebuilt for this option.
    expect(calls.map((c) => c.method)).toEqual(['render']);
  });

  it('releaseHoldOnDestroy set from the start reaches the picker options', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', releaseHoldOnDestroy: true })));
    expect(constructed[0]).toMatchObject({ season: 'sea_1', releaseHoldOnDestroy: true });
  });

  it('forwards singleDates (unset unless given), and rebuilds when it changes', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1' })));
    expect(constructed[0]?.singleDates).toBeUndefined();
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', singleDates: true })));
    expect(constructed).toHaveLength(2);
    expect(constructed[1]).toMatchObject({ season: 'sea_1', singleDates: true });
    await act(async () => root.render(createElement(SeasonPicker, { season: 'sea_1', singleDates: true })));
    expect(constructed).toHaveLength(2);
  });

  it('forwards startDatesCheckout, and throws once the picker is unmounted, as the other holds do', async () => {
    const { SeasonPicker } = await import('../src/SeasonPicker');
    const ref = createRef<SeasonPickerHandle>();
    await act(async () => root.render(createElement(SeasonPicker, { ref, season: 'sea_1', singleDates: true })));
    const handle = ref.current!;
    const input = { buyerEmail: 'member@example.com', buyerName: 'Asha Rao', returnUrl: 'https://tickets.example.com/done' };
    await expect(handle.startDatesCheckout!(input)).resolves.toEqual({ sessionId: 'cs_1' });
    expect(calls.filter((call) => call.method === 'startDatesCheckout').map((call) => call.args))
      .toEqual([[input]]);

    act(() => root.unmount());
    expect(() => handle.startDatesCheckout!({ buyerEmail: 'member@example.com' }))
      .toThrow('seatlayer: React SeasonPicker is not mounted');
    expect(() => handle.holdSameSeat(['A-1'], 'sop_1'))
      .toThrow('seatlayer: React SeasonPicker is not mounted');
  });
});
