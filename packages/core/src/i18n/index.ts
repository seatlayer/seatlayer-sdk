/**
 * i18n core — deliberately tiny and framework-free so the embed SDK can share
 * it without dragging in a runtime library (the 60KB-gzipped SDK budget is a
 * product contract).
 *
 * Scope (docs/design-port-plan.md): the buyer surface (picker, public event
 * page, SDK) ships fully translated in en/es/de/fr; dashboard pages route
 * their strings through t() as they are rebuilt but ship English this round.
 *
 * Keys are flat dot-namespaced strings ("picker.holdSeats"). Interpolation
 * uses {name} placeholders. Missing keys fall back to English, then to the
 * key itself — a page never crashes over a translation.
 */

import { setMoneyLocale } from '../lib/money';
import { en } from './locales/en';

export type Locale = 'en' | 'es' | 'de' | 'fr';
export const SUPPORTED_LOCALES: Locale[] = ['en', 'es', 'de', 'fr'];

export type Dict = Record<string, string>;

const bundles: Partial<Record<Locale, Dict>> = { en };

/** Extra strings layered over the active bundle (SDK white-label overrides). */
let overrides: Dict = {};

let active: Locale = 'en';

/** explicit setting → stored preference → browser language → en */
export function resolveLocale(explicit?: string | null, stored?: string | null): Locale {
  for (const candidate of [explicit, stored, typeof navigator !== 'undefined' ? navigator.language : null]) {
    if (!candidate) continue;
    const base = candidate.toLowerCase().split('-')[0] as Locale;
    if (SUPPORTED_LOCALES.includes(base)) return base;
  }
  return 'en';
}

export function getLocale(): Locale {
  return active;
}

/**
 * Set the active locale. Locale bundles other than English are registered by
 * the surface that needs them (the picker imports its own es/de/fr bundles;
 * the dashboard stays English until its translations ship).
 */
export function setLocale(locale: Locale, bundle?: Dict): void {
  if (bundle) bundles[locale] = { ...bundles[locale], ...bundle };
  active = bundles[locale] ? locale : 'en';
  setMoneyLocale(active);
  if (typeof document !== 'undefined') document.documentElement.lang = active;
}

export function setStringOverrides(next: Dict): void {
  overrides = next;
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = overrides[key] ?? bundles[active]?.[key] ?? en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(PLACEHOLDER, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

/** "1 seat" / "3 seats" without hand-rolled concatenation. */
export function tCount(key: string, count: number, vars?: Record<string, string | number>): string {
  const rule = new Intl.PluralRules(active).select(count);
  const exact = overrides[`${key}.${rule}`] ?? bundles[active]?.[`${key}.${rule}`] ?? en[`${key}.${rule}`];
  const raw = exact ?? overrides[`${key}.other`] ?? bundles[active]?.[`${key}.other`] ?? en[`${key}.other`] ?? key;
  return raw.replace(PLACEHOLDER, (_, name: string) => String({ count, ...vars }[name] ?? `{${name}}`));
}

export function formatDate(value: number | Date, opts?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(active, opts ?? { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}
