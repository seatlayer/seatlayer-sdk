import { beforeEach, describe, expect, it } from 'vitest';
import { SeatPicker, type SeatPickerOptions } from '../src/SeatPicker';

let container: HTMLDivElement;

/** Construct without render() — the pricing helpers are pure over options. */
function picker(overrides: Partial<SeatPickerOptions> = {}): SeatPicker {
  return new SeatPicker({ event: 'ev_test', container, ...overrides });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- exercising private helpers */
const paid = (p: SeatPicker, cat: string | undefined, tier: string | null, fallback: number): number =>
  (p as any).paidPrice(cat, tier, fallback);
const catPrice = (p: SeatPicker, c: unknown): number | undefined => (p as any).catPrice(c);
const money = (p: SeatPicker, n: number): string => (p as any).money(n);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('host pricing overrides (A8)', () => {
  it('falls back to the chart price when no pricing option is set', () => {
    const p = picker();
    expect(paid(p, 'vip', null, 120)).toBe(120);
    expect(paid(p, 'vip', 'adult', 120)).toBe(120);
    expect(paid(p, undefined, null, 45)).toBe(45);
  });

  it('flat per-category override wins over the chart price', () => {
    const p = picker({ pricing: { prices: { vip: 50 } } });
    expect(paid(p, 'vip', null, 120)).toBe(50);
    expect(paid(p, 'vip', 'any-tier', 120)).toBe(50);
    // unlisted categories keep the chart price
    expect(paid(p, 'standard', null, 45)).toBe(45);
  });

  it('per-tier overrides nest under a category and fall back to base', () => {
    const p = picker({ pricing: { prices: { stalls: { base: 60, tiers: { child: 30 } } } } });
    expect(paid(p, 'stalls', 'child', 80)).toBe(30);
    expect(paid(p, 'stalls', 'adult', 80)).toBe(60); // unlisted tier → base
    expect(paid(p, 'stalls', null, 80)).toBe(60);
  });

  it('a tiers-only entry keeps the chart price for unlisted tiers', () => {
    const p = picker({ pricing: { prices: { stalls: { tiers: { child: 30 } } } } });
    expect(paid(p, 'stalls', 'adult', 80)).toBe(80);
    expect(paid(p, 'stalls', 'child', 80)).toBe(30);
  });

  it('catPrice resolves a category through the override (first tier identity)', () => {
    const p = picker({ pricing: { prices: { vip: { base: 99, tiers: { t1: 55 } } } } });
    expect(catPrice(p, { key: 'vip', price: 120 })).toBe(99);
    expect(catPrice(p, { key: 'vip', price: 120, tiers: [{ id: 't1', price: 110 }] })).toBe(55);
    expect(catPrice(p, { key: 'other', price: 45 })).toBe(45);
    expect(catPrice(p, { key: 'unpriced' })).toBeUndefined();
  });

  it('pricing.formatter takes over money rendering', () => {
    const p = picker({ pricing: { formatter: (n, cur) => `${n}!${cur}` } });
    expect(money(p, 50)).toBe('50!USD');
  });
});
