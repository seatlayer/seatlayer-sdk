/**
 * Money formatting — the ONE place currency rendering happens.
 *
 * Ticket money is multi-currency: the org sets a default and each event can
 * override it (ISO 4217 code delivered with the event/chart payload). Until
 * those backend fields land, callers fall back to DEFAULT_CURRENCY, which is
 * kept at EUR so live buyer pages render exactly what they rendered when the
 * symbol was hardcoded. Flipping an org to USD/INR/… later is data, not code.
 *
 * Amounts are in MAJOR units (45 === €45) matching Category.price in
 * src/core/types.ts. If/when backend money fields arrive in minor units,
 * convert at the API boundary, not here.
 */

// App-wide fallback when no org currency is available (unauthed/demo surfaces).
// Owner decision 2026-07-08: USD default (orgs.currency also defaults to USD).
export const DEFAULT_CURRENCY = 'USD';

/** BCP 47 locale used for number/date rendering; kept in sync by src/i18n. */
let displayLocale: string | undefined;

export function setMoneyLocale(locale: string | undefined): void {
  displayLocale = locale;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, digits: number | undefined): Intl.NumberFormat {
  const key = `${displayLocale ?? ''}|${currency}|${digits ?? 'auto'}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(displayLocale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatterCache.set(key, fmt);
  }
  return fmt;
}

/**
 * "€45" / "$1,500" / "45 €" (locale-dependent placement).
 * Whole amounts render without ".00" (design shows "$45", "$120"); pass
 * `fractionDigits` for fixed precision (e.g. 3 for "$0.045 / credit").
 */
export function formatMoney(
  amount: number,
  currency: string = DEFAULT_CURRENCY,
  fractionDigits?: number,
): string {
  const digits = fractionDigits ?? (Number.isInteger(amount) ? 0 : undefined);
  return formatter(currency, digits).format(amount);
}

/**
 * How many decimal places a currency has — 2 for USD/EUR, 0 for JPY/KRW/VND,
 * 3 for KWD/BHD/JOD.
 *
 * Derived from Intl rather than from a table, because ICU already carries ISO
 * 4217's exponents and a second hand-maintained list is a second thing to get
 * wrong. (`workers/api/src/payments/money.ts` DOES keep a table, on purpose: it
 * must THROW for a currency checkout cannot transact. Display has no such duty
 * — it renders whatever the ledger already recorded, including a currency
 * checkout would refuse.)
 *
 * Falls back to 2 for a code Intl rejects, so a bad row cannot blank a chart.
 */
export function currencyExponent(currency: string = DEFAULT_CURRENCY): number {
  try {
    return formatter(currency, undefined).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Minor units → major units. `9000` USD cents is `90`; `9000` JPY is `9000`.
 *
 * Every money field the API returns is an integer in the currency's smallest
 * unit (`grossMinor`, `total_minor`). Dividing by 100 at a call site is right
 * for most currencies and silently wrong for the rest — 100x wrong for yen.
 */
export function fromMinorUnits(minor: number, currency: string = DEFAULT_CURRENCY): number {
  return minor / 10 ** currencyExponent(currency);
}

/** "$90" / "¥9,000" — a minor-unit integer rendered for display. */
export function formatMinor(minor: number, currency: string = DEFAULT_CURRENCY): string {
  return formatMoney(fromMinorUnits(minor, currency), currency);
}

/** Bare symbol for input adornments ("€", "$", "₹"). */
export function currencySymbol(currency: string = DEFAULT_CURRENCY): string {
  const part = formatter(currency, 0)
    .formatToParts(0)
    .find((p) => p.type === 'currency');
  return part?.value ?? currency;
}
