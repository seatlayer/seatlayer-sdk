/**
 * Locale bundle loader — keeps non-English translations OUT of the initial
 * bundle — they are ~2.5 KB gzipped of the complete CDN artifact — and
 * code-splits each locale so a page/SDK only downloads the language it actually
 * uses. (The "150 KB product contract" this used to cite was never true of a
 * shipped bundle; see docs/hosted-checkout-programme-2026-08-03.md §W4.)
 *
 * `loadLocale('de')` dynamic-imports the German dictionary, registers it via
 * setLocale(), and resolves once it's active. English is built in, so
 * `loadLocale('en')` is synchronous and never fetches. Unknown/unsupported
 * codes fall back to English without throwing.
 */
import { setLocale, resolveLocale, type Dict, type Locale } from './index';

/** Dynamic importers per non-English locale (English ships in the core). */
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Dict }>> = {
  es: () => import('./locales/es').then((m) => ({ default: m.es })),
  de: () => import('./locales/de').then((m) => ({ default: m.de })),
  fr: () => import('./locales/fr').then((m) => ({ default: m.fr })),
};

const loaded = new Set<Locale>(['en']);

/**
 * Resolve `code` to a supported locale, load its bundle if needed, and make it
 * active. Returns the locale that ended up active (English on any failure).
 */
export async function loadLocale(code?: string | null): Promise<Locale> {
  const locale = resolveLocale(code);
  if (locale === 'en' || loaded.has(locale)) {
    setLocale(locale);
    return locale;
  }
  try {
    const mod = await LOADERS[locale]();
    setLocale(locale, mod.default);
    loaded.add(locale);
    return locale;
  } catch {
    setLocale('en');
    return 'en';
  }
}
