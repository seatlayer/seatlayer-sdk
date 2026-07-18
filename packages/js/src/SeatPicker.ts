/**
 * SeatPicker — the full buyer experience as a widget.
 *
 * Where `SeatingChart` is canvas-only, SeatPicker owns the complete chrome
 * from the canonical UX (SeatmapUX/11 Buyer Picker.dc.html): branded header,
 * live price panel, selection tray with GA steppers, hold countdown, snipe
 * toasts and expiry recovery — all on top of the shared PickerController, so
 * every host gets the whole experience with one mount.
 *
 * Render contexts (owner requirement): the SAME widget adapts to a full-screen
 * takeover, an inline <div> in a content page, or a popup — breakpoints key
 * off the CONTAINER via ResizeObserver, never the viewport. `SeatPicker.open()`
 * mounts a document-level modal (scrim, ESC, focus restore) in one call.
 *
 * Theming (owner requirement): org account customization flows automatically —
 * the chart payload's ChartTheme (accent, accentInk, logoUrl, brand name,
 * fontFamily, …) seeds the look; the host `theme` option overrides any subset;
 * and every value lands as a `--sl-*` CSS custom property on the widget root
 * so plain host CSS can restyle too.
 */
import {
  PickerController,
  expandChart,
  generateSeatPanorama,
  loadLocale,
  setStringOverrides,
  t,
  tCount,
  type AccessibilityType,
  type ChartTheme,
  type ExpandedSeat,
  type LodRung,
  type PickerSeat,
  type PickerTransport,
  type SeatHoverDetails,
  type SectionSummary,
} from '@seatlayer/core';
import { PubApi, type HoldLineItem, type HoldResult } from './api';

const DEFAULT_API_BASE = 'https://api.seatlayer.io';
const DEFAULT_MAX_SELECTION = 10;
/** Show the "Need more time?" prompt when the hold has this long (ms) left. */
const EXTEND_PROMPT_MS = 60_000;

/** Minimal shape of a section object read off the ChartDoc for the minimap. */
interface SectionLike {
  type: string;
  id: string;
  outline?: { x: number; y: number }[];
  color?: string;
  zone?: string;
}

/** Even-odd point-in-polygon test in world units (minimap click → section). */
function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** One price band in the F4 filter — a set of category keys within a price range. */
interface PriceBand {
  id: string;
  label: string;
  keys: string[];
  min: number;
  max: number;
}

/**
 * Stable checkout-handoff contract (P4). Passed as the THIRD argument to
 * `onCheckout(hold, seats, handoff)` — additive, so the legacy `(hold, seats)`
 * shape used by DesiPass web-v2 (SDK 0.7.3+) is untouched. This is the object to
 * build your order against: it is self-contained (holdId, expiry, currency, and
 * per-line tier + price) and never changes shape across minor releases.
 */
export interface CheckoutLineItem {
  /** Seat label (or GA synthetic-unit label). */
  label: string;
  /** Chart object id (row/booth/GA area) the unit belongs to. */
  objectId: string;
  objectType: 'seat' | 'booth' | 'ga';
  categoryKey: string;
  /** Chosen ticket tier id (Adult/Child/…), or null when the category has no tiers. */
  tierId: string | null;
  /** Unit price in MAJOR currency units (e.g. 45 = 45.00). Server-authoritative. */
  unitPrice: number;
  /** ISO-4217, resolved server-side (per-event override → org → USD). */
  currency: string;
  quantity: number;
}

export interface CheckoutHandoff {
  /** Server hold id — pass this to YOUR book call. */
  holdId: string;
  /** Epoch ms the hold expires (after any extensions). */
  expiresAt: number;
  /** ISO-4217 currency for the whole order. */
  currency: string;
  /** Priced line items (tier + unit price + currency), server-authoritative. */
  lineItems: CheckoutLineItem[];
  /** Convenience total in major units (Σ unitPrice × quantity). */
  total: number;
}

/** Host-authoritative pricing — see {@link SeatPickerOptions.pricing}. */
export interface SeatPickerPricing {
  /** Unit prices by category key: a flat number, or `{ base, tiers: { tierId: price } }`. */
  prices?: Record<string, number | { base?: number; tiers?: Record<string, number> }>;
  /** Custom money renderer (e.g. `(n) => n + '€'`). Defaults to Intl currency formatting. */
  formatter?: (amount: number, currency: string) => string;
}

/** Host theme overrides — any subset; unset keys fall back to the org's chart theme, then defaults. */
export interface SeatPickerTheme {
  /** Brand accent (CTA, active chips, hold pill). */
  accent?: string;
  /** Ink on the accent (button labels). */
  accentInk?: string;
  /** Widget background. */
  background?: string;
  /** Panel/card surface color. */
  surface?: string;
  /** Primary text color. */
  text?: string;
  /** Secondary text color. */
  muted?: string;
  /** Hairline/border color. */
  line?: string;
  /** Font stack for all widget chrome. */
  fontFamily?: string;
  /** Corner radius base (px). */
  radius?: number;
  /** Header logo URL (falls back to the org logo from the chart theme, then a monogram). */
  logoUrl?: string;
  /** Brand/event fallback name for the monogram. */
  brandName?: string;
}

export interface SeatPickerOptions {
  /** CSS selector or element to mount into. Omit when using SeatPicker.open(). */
  container?: string | HTMLElement;
  /** Event key, e.g. `ev_xxx`. */
  event: string;
  /** API origin. Defaults to https://api.seatlayer.io. */
  apiBase?: string;
  /**
   * Custom data transport. Defaults to the CORS-trivial PubApi against
   * `apiBase`. Inject to run the widget against another backend adapter (the
   * SeatLayer dashboard's own transport) or a fully local mock (demos).
   */
  transport?: PickerTransport;
  /** Reserved for future authenticated rendering. */
  publicKey?: string;
  /** Max seats selectable at once (default 10). */
  maxSelection?: number;
  /** BCP 47 language for the widget UI. Built-in: en, es, de, fr. */
  locale?: string;
  /** Per-key string overrides layered over the active locale. */
  messages?: Record<string, string>;
  /** ISO 4217 currency fallback (the org/event currency on the chart wins). */
  currency?: string;
  /** Colorblind-safe rendering (Okabe-Ito palette, hollow booked seats). */
  colorblindSafe?: boolean;
  /** Host theme overrides — see SeatPickerTheme. */
  theme?: SeatPickerTheme;
  /**
   * Host-authoritative pricing. When your shop charges different prices than
   * the chart's stored category prices, pass them here so the buyer sees the
   * price they will actually pay — on the map tooltip, confirm popover, price
   * panel, tray, totals, and in the checkout handoff's line items. Keyed by
   * category key; per-tier overrides nest under `tiers`. Unlisted categories
   * fall back to the chart price.
   */
  pricing?: SeatPickerPricing;
  /** Hold TTL in ms passed to hold(); server clamps to its own limits. */
  holdTtlMs?: number;
  /**
   * An opaque hold id supplied by the host to restore after navigation. It is
   * verified against the event and active server state before anything renders
   * as owned by this buyer.
   */
  initialHoldId?: string;
  /**
   * Automatically remember the active hold id in sessionStorage and restore it
   * when this event's picker mounts again. Default true. Set false when the host
   * owns hold persistence and supplies initialHoldId itself.
   */
  restoreHold?: boolean;
  /**
   * Confirm mode: tapping a seat shows a confirmation card with section, row,
   * seat, category, price and Select/Cancel before it enters the tray. Default
   * true for the full buyer picker; set false only when the host supplies its
   * own equivalent confirmation UI.
   */
  confirmSelection?: boolean;
  /**
   * Offer a "View from seat" 360° preview (confirm popover + tray chips). The
   * panorama is generated from the chart geometry, or the organizer's uploaded
   * photo when a seat carries one. Default true; set false to hide the affordance.
   */
  seatView?: boolean;
  /**
   * Buyer pressed the CTA and the hold succeeded — hand off to YOUR checkout.
   * `hold` and `seats` are the legacy args (unchanged since 0.6). `handoff` (P4)
   * is the stable, self-contained {@link CheckoutHandoff} to build your order
   * against — holdId, expiry, currency and priced line items. Prefer it.
   */
  onCheckout?: (hold: HoldResult, seats: PickerSeat[], handoff: CheckoutHandoff) => void;
  /**
   * The held seats were BOOKED (P4) — your server completed payment and the
   * booking landed over the realtime channel while the widget was still open.
   * The widget shows a success state; use this to advance your own UI (receipt,
   * redirect). Fires once per hold.
   */
  onBooked?: (handoff: CheckoutHandoff) => void;
  /** Selection changed (tap or best-available). */
  onSelectionChange?: (seats: PickerSeat[]) => void;
  /**
   * Active hold changed because it was created, restored, extended, partially
   * released, or fully released. Hosts should persist this state for route
   * navigation and clear their checkout cart when `hold` becomes null.
   */
  onHoldChange?: (hold: HoldResult | null, seats: PickerSeat[], handoff: CheckoutHandoff | null) => void;
  /** The open hold expired server-side (widget already reset itself). */
  onHoldExpired?: () => void;
  /** A prior active hold was verified and restored into the tray. */
  onHoldRestored?: (hold: HoldResult, seats: PickerSeat[], handoff: CheckoutHandoff) => void;
  /** Modal only: the buyer closed the picker (ESC / scrim / ✕). */
  onClose?: () => void;
  onError?: (err: unknown) => void;
}

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (!el) throw new Error(`seatmap: container "${container}" not found`);
    return el as HTMLElement;
  }
  if (!(container instanceof HTMLElement)) {
    throw new Error('seatmap: container must be a CSS selector or an HTMLElement');
  }
  return container;
}

/** Widget stylesheet — injected once per document. Every color/font/radius is a --sl-* token. */
const STYLE_ID = 'seatlayer-picker-style';
const CSS = `
.sl-picker{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:420px;overflow:hidden;
  background:var(--sl-bg);color:var(--sl-text);font-family:var(--sl-font);border-radius:var(--sl-radius);
  --sl-r-sm:calc(var(--sl-radius) * .55)}
.sl-picker *{box-sizing:border-box;margin:0;padding:0}
.sl-picker button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}

/* header */
.sl-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--sl-line);flex:none}
.sl-logo{width:34px;height:34px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;
  background:var(--sl-accent);color:var(--sl-accent-ink);font-weight:800;font-size:15px;overflow:hidden}
.sl-logo img{width:100%;height:100%;object-fit:cover;display:block}
.sl-head-info{min-width:0;flex:1}
.sl-head-name{font-weight:700;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-head-meta{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--sl-muted);margin-top:3px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.sl-hold-pill{display:none;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;flex:none;
  background:var(--sl-accent);color:var(--sl-accent-ink);font-weight:700;font-size:12px;font-variant-numeric:tabular-nums;
  transform-origin:right center}
.sl-hold-pill.on{display:inline-flex;animation:slPillIn .34s cubic-bezier(.2,.8,.2,1) both}
.sl-hold-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.78;box-shadow:0 0 0 0 currentColor}
.sl-hold-pill.is-expiring .sl-hold-dot{animation:slHoldPulse 1.4s ease-out infinite}
.sl-hold-time{min-width:3.35em;text-align:left}
.sl-close{width:32px;height:32px;border-radius:999px;flex:none;display:none;align-items:center;justify-content:center;
  border:1px solid var(--sl-line);color:var(--sl-muted);transition:color .15s,border-color .15s}
.sl-close:hover{color:var(--sl-text);border-color:var(--sl-muted)}
.sl-close.on{display:inline-flex}
.sl-close svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round}

/* body */
.sl-body{display:flex;flex:1;min-height:0}
.sl-map{position:relative;flex:1;min-width:0}
.sl-map-host{position:absolute;inset:0}
.sl-side{width:300px;flex:none;border-left:1px solid var(--sl-line);display:flex;flex-direction:column;min-height:0;overflow:hidden}

/* narrow (container < 640px): map-first — the map claims ~80-85% of the
   container and the side panel becomes a PEEKING bottom sheet (AXS/Ticketmaster
   mobile pattern). data-sheet on the root: "peek" (default: grab handle + one
   summary line) / "open" (room for rows + checkout, swipe up to open).
   Swipe handling lives on the sheet head ONLY — never the map host, so the
   map's raw-pointer gesture pipeline is untouched. */
.sl-picker[data-layout="narrow"] .sl-body{flex-direction:column}
.sl-picker[data-layout="narrow"] .sl-map{min-height:0;flex:1}
.sl-picker[data-layout="narrow"] .sl-side{width:100%;border-left:0;border-top:1px solid var(--sl-line);
  flex:none;height:min(72%,480px);overflow:hidden;transition:height .3s cubic-bezier(.2,.8,.2,1);overscroll-behavior:contain}
.sl-picker[data-layout="narrow"][data-sheet="open"][data-has-selection="false"] .sl-side{height:min(252px,52%)}
.sl-picker[data-layout="narrow"][data-sheet="peek"] .sl-side{height:86px;overflow:hidden}
.sl-picker[data-layout="narrow"][data-sheet="peek"] .sl-side > :not(.sl-sheet-head){display:none}
.sl-picker[data-layout="narrow"] .sl-tray{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.sl-picker[data-layout="narrow"] .sl-foot{position:static;background:var(--sl-bg)}
.sl-picker[data-layout="narrow"] .sl-foot.empty{display:none}
.sl-picker[data-layout="narrow"] .sl-sheet-head{order:0}
.sl-picker[data-layout="narrow"] .sl-seats-sec{display:none}
.sl-picker[data-layout="narrow"] .sl-tray{order:2}
.sl-picker[data-layout="narrow"] .sl-filtersec{order:3}
.sl-picker[data-layout="narrow"] .sl-filters{order:4}
.sl-picker[data-layout="narrow"] .sl-prices-sec{order:5}
.sl-picker[data-layout="narrow"] .sl-pricef{order:6}
.sl-picker[data-layout="narrow"] .sl-prices{order:7}
.sl-picker[data-layout="narrow"] .sl-foot{order:8}
.sl-picker[data-layout="narrow"] .sl-tray-hint,
.sl-picker[data-layout="narrow"] .sl-filtersec,
.sl-picker[data-layout="narrow"] .sl-filters,
.sl-picker[data-layout="narrow"] .sl-prices-sec,
.sl-picker[data-layout="narrow"] .sl-prices{display:none!important}
.sl-picker[data-layout="narrow"][data-has-selection="true"] .sl-filtersec,
.sl-picker[data-layout="narrow"][data-has-selection="true"] .sl-filters,
.sl-picker[data-layout="narrow"][data-has-selection="true"] .sl-prices-sec{display:none}
/* touch chrome: pinch-zoom exists — hide +/− on the sheet layout (keep fit) */
.sl-picker[data-layout="narrow"] .sl-zoom [data-ref="zin"],
.sl-picker[data-layout="narrow"] .sl-zoom [data-ref="zout"]{display:none}

/* bottom-sheet head: grab handle + one-line summary (narrow only). The WHOLE
   head is the tap/swipe toggle target (min 44px), so it reads as one control. */
.sl-sheet-head{display:none;flex-direction:column;justify-content:center;padding:6px 12px 8px;min-height:56px;
  cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;flex:none}
.sl-picker[data-layout="narrow"] .sl-sheet-head{display:flex}
.sl-sheet-grab{width:36px;height:4px;border-radius:999px;background:var(--sl-muted);opacity:.55;margin:2px auto 7px}
.sl-sheet-bar{display:flex;align-items:center;gap:10px;min-height:26px}
.sl-sheet-peek{display:flex;align-items:center;gap:7px;flex:1;min-width:0;font-size:13px;font-weight:700;color:var(--sl-text);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-sheet-peek .sub{color:var(--sl-muted);font-weight:600}
/* collapsed-peek "Continue" affordance: a real accent pill, not plain text */
.sl-sheet-peek .go{margin-left:auto;flex:none;display:inline-flex;align-items:center;min-height:30px;
  padding:6px 13px;border-radius:999px;background:var(--sl-accent);color:var(--sl-accent-ink);
  font-weight:800;font-size:12.5px}
/* state chevron: points UP while peeking, rotates to point DOWN when open.
   Base keeps an explicit rotate(0) — transitioning to/from a bare 'none' leaves
   the value stuck in some engines, so both endpoints must be real transforms. */
.sl-sheet-toggle{width:44px;height:44px;margin:-8px -8px -8px 0;border-radius:999px;flex:none;display:flex;
  align-items:center;justify-content:center;color:var(--sl-muted);transition:color .15s,background .15s}
.sl-sheet-toggle:hover,.sl-sheet-toggle:focus-visible{color:var(--sl-text);background:color-mix(in srgb,var(--sl-line) 44%,transparent)}
.sl-sheet-toggle svg{width:21px;height:21px;stroke:currentColor;stroke-width:2.4;fill:none;
  stroke-linecap:round;stroke-linejoin:round}
.sl-sheet-toggle svg{transform:rotate(0deg);transition:transform .24s cubic-bezier(.2,.8,.2,1)}
.sl-picker[data-sheet="open"] .sl-sheet-toggle svg{transform:rotate(180deg)}

/* consolidated Filters row inside the sheet (a11y chips + colorblind toggle
   dock here on narrow; they live on the map / zoom column on wide) */
.sl-filtersec{display:none}
.sl-filters{display:none;gap:6px;flex-wrap:wrap;align-items:center;padding:2px 16px 10px}
.sl-picker[data-layout="narrow"] .sl-filtersec.has,
.sl-picker[data-layout="narrow"] .sl-filters.has{display:none}
.sl-picker[data-layout="narrow"][data-has-selection="true"] .sl-filtersec.has,
.sl-picker[data-layout="narrow"][data-has-selection="true"] .sl-filters.has{display:none}
.sl-cbbtn{width:32px;height:32px;border-radius:999px;background:var(--sl-surface);border:1px solid var(--sl-line);
  color:var(--sl-text);display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.sl-cbbtn:hover{border-color:var(--sl-muted)}
.sl-cbbtn svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}

/* price panel — one compact filter control replaces the wrapping price-chip row. */
.sl-sec{padding:14px 14px 4px;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--sl-muted);font-weight:700}
.sl-prices-sec{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:13px}
.sl-price-select{min-height:32px;max-width:130px;padding:5px 28px 5px 9px;border:1px solid var(--sl-line);border-radius:9px;
  background:var(--sl-surface);color:var(--sl-text);font:inherit;font-size:11px;font-weight:750;letter-spacing:0;text-transform:none}
.sl-prices{padding:5px 14px 10px;border-bottom:1px solid var(--sl-line)}
.sl-prices-sec,.sl-prices,.sl-seats-sec{flex:none}
.sl-price-row{display:flex;align-items:center;gap:7px;min-height:28px;font-size:12px}
.sl-dot{width:9px;height:9px;border-radius:50%;flex:none}
.sl-price-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.sl-price-left{font-size:11px;color:var(--sl-muted);font-variant-numeric:tabular-nums}
.sl-price-amt{font-weight:800;font-variant-numeric:tabular-nums}
.sl-status-key{display:flex;gap:13px;flex-wrap:wrap;padding:8px 0 2px;margin-top:5px;border-top:1px solid var(--sl-line);color:var(--sl-muted);font-size:10.5px}
.sl-status-item{display:inline-flex;align-items:center;gap:6px}
.sl-status-icon{width:17px;height:17px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;
  color:#fff;background:#6b7280;line-height:1}
.sl-status-icon svg{width:10px;height:10px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}
.sl-status-icon.sold{background:#8b93a0}
.sl-status-icon.sold svg{width:11px;height:11px;stroke-width:2.4}

/* tray */
.sl-seats-sec{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:13px}
.sl-seat-summary{font-size:10px;letter-spacing:0;text-transform:none;white-space:nowrap}
.sl-tray{flex:1;padding:10px 14px 14px;display:flex;flex-direction:column;gap:7px;min-height:0;overflow-y:auto;
  overscroll-behavior:contain;scrollbar-gutter:stable}
.sl-tray-hint{font-size:12.5px;color:var(--sl-muted);line-height:1.5}
.sl-chip{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 34px;align-items:stretch;
  min-height:53px;border:1px solid var(--sl-line);border-radius:var(--sl-r-sm);overflow:hidden;
  background:var(--sl-surface);font-size:13px;transform-origin:center;transition:border-color .15s,background .15s}
.sl-chip:hover{border-color:color-mix(in srgb,var(--sl-accent) 38%,var(--sl-line))}
.sl-chip.sl-enter{animation:slChipIn .38s cubic-bezier(.2,.8,.2,1) both}
.sl-chip.sl-leave{pointer-events:none;animation:slChipOut .16s ease-in both}
.sl-chip.sl-held{border-color:var(--sl-line);background:color-mix(in srgb,var(--sl-accent) 7%,var(--sl-surface));
  box-shadow:inset 3px 0 0 color-mix(in srgb,var(--sl-accent) 72%,transparent)}
.sl-ticket-state{width:17px;height:17px;border-radius:999px;flex:none;display:flex;align-items:center;justify-content:center;
  background:var(--sl-accent);color:var(--sl-accent-ink)}
.sl-ticket-state.held{background:color-mix(in srgb,var(--sl-accent) 18%,var(--sl-surface));color:var(--sl-accent)}
.sl-ticket-state svg{width:10px;height:10px;stroke:currentColor;stroke-width:2.6;fill:none;stroke-linecap:round;stroke-linejoin:round}
.sl-chip-main{min-width:0;padding:8px 10px 8px 11px;display:flex;flex-direction:column;justify-content:center;gap:5px}
.sl-chip-id{display:flex;gap:12px;min-width:0}
.sl-chip-id .fld{min-width:0}
.sl-chip-id .fld.sec{flex:1}
.sl-chip-id .fld.mid{flex:none;text-align:center}
.sl-chip-eb{display:block;font-size:8px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--sl-muted);margin-bottom:1px}
.sl-chip-id .val{display:block;font-weight:800;font-size:13px;line-height:1.25;white-space:nowrap}
.sl-chip-id .fld.sec .val{overflow:hidden;text-overflow:ellipsis}
.sl-chip-sub{display:flex;align-items:center;gap:6px;min-width:0}
.sl-chip .cat{color:var(--sl-muted);font-size:10.5px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-chip .amt{font-weight:700;font-variant-numeric:tabular-nums;flex:none;white-space:nowrap}
.sl-chip-rail{display:flex;flex-direction:column;border-left:1px solid var(--sl-line)}
.sl-chip .rm,.sl-chip .view{flex:1;min-height:26px;border-radius:0;display:flex;align-items:center;justify-content:center;
  color:var(--sl-muted);transition:color .15s,background .15s}
.sl-chip .view{border-top:1px solid var(--sl-line)}
.sl-chip .rm:hover,.sl-chip .rm:focus-visible{color:#e5484d;background:color-mix(in srgb,#e5484d 9%,transparent)}
.sl-chip .view:hover,.sl-chip .view:focus-visible{color:var(--sl-text);background:color-mix(in srgb,var(--sl-accent) 10%,transparent)}
.sl-chip .rm svg{width:11px;height:11px;stroke:currentColor;stroke-width:2.4;fill:none;stroke-linecap:round}
.sl-chip .view svg{width:13px;height:13px;stroke:currentColor;stroke-width:1.8;fill:none}
/* live-activity strip — narrates WS availability deltas (social proof + urgency) */
.sl-live{display:flex;align-items:center;gap:7px;margin:10px 14px 0;padding:7px 9px;flex:none;
  border:1px solid var(--sl-line);border-radius:8px;background:color-mix(in srgb,var(--sl-accent) 4%,var(--sl-surface));
  font-size:11px;color:var(--sl-muted)}
.sl-live .dot{width:6px;height:6px;border-radius:999px;background:#22a06b;box-shadow:0 0 6px rgba(34,160,107,.75);flex:none}
.sl-live span:last-child{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* GA rows */
.sl-ga{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px dashed var(--sl-line);border-radius:var(--sl-r-sm)}
.sl-ga-info{flex:1;min-width:0}
.sl-ga-name{font-weight:700;font-size:13px}
.sl-ga-sub{font-size:11px;color:var(--sl-muted);margin-top:2px}
.sl-ga-qty{display:flex;align-items:center;gap:8px}
.sl-ga-qty button{width:26px;height:26px;border-radius:999px;background:var(--sl-surface);border:1px solid var(--sl-line);
  font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.sl-ga-qty button:hover{border-color:var(--sl-muted)}
.sl-ga-qty span{min-width:16px;text-align:center;font-weight:800;font-variant-numeric:tabular-nums}

/* footer */
.sl-foot{position:relative;z-index:2;padding:12px 16px 14px;border-top:1px solid var(--sl-line);flex:none;
  background:var(--sl-bg);box-shadow:0 -10px 24px -22px rgba(0,0,0,.72)}
.sl-hold-note{display:none;align-items:center;gap:7px;margin-bottom:8px;padding:7px 8px;border-radius:var(--sl-r-sm);
  border:1px solid var(--sl-line);background:color-mix(in srgb,var(--sl-accent) 7%,var(--sl-surface));
  box-shadow:inset 3px 0 0 color-mix(in srgb,var(--sl-accent) 72%,transparent);
  font-size:11.5px;line-height:1.35;color:var(--sl-muted)}
.sl-hold-note.on{display:flex;animation:slNoticeIn .38s cubic-bezier(.2,.8,.2,1) both}
.sl-hold-note svg{width:16px;height:16px;flex:none;stroke:var(--sl-accent);stroke-width:2.4;fill:none;
  stroke-linecap:round;stroke-linejoin:round}
.sl-hold-note b{display:block;color:var(--sl-text);font-size:11.5px;white-space:nowrap}
.sl-hold-copy{display:block;white-space:nowrap;font-size:10.5px}
.sl-hold-note>span{flex:1;min-width:0}
.sl-hold-change{flex:none;min-height:30px;padding:5px 8px;border-radius:8px;border:1px solid var(--sl-line);
  color:var(--sl-text);font-size:10.5px;font-weight:750;white-space:nowrap}
.sl-hold-change:hover,.sl-hold-change:focus-visible{border-color:var(--sl-accent);color:var(--sl-accent)}
.sl-hold-change:disabled{opacity:.58;cursor:wait}
.sl-total{display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:10px}
.sl-total b{font-size:17px;font-variant-numeric:tabular-nums}
.sl-value-pop{animation:slValuePop .32s cubic-bezier(.2,.8,.2,1)}
/* Primary checkout CTA. Scoped under .sl-picker so it OUTWEIGHS the
   '.sl-picker button' reset (0,1,1) — an unscoped '.sl-cta' (0,1,0) loses to it
   and the button renders as plain text with no accent fill. */
.sl-picker .sl-cta{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;
  padding:12px 16px;border-radius:var(--sl-r-sm);font-weight:800;font-size:14px;line-height:1.1;
  background:var(--sl-accent);color:var(--sl-accent-ink);
  transition:filter .15s,background .22s,color .22s,transform .12s,box-shadow .22s;gap:8px}
.sl-picker .sl-cta:hover{filter:brightness(1.08)}
.sl-picker .sl-cta:active{transform:translateY(1px);filter:brightness(.94)}
.sl-picker .sl-cta.sl-ready{animation:slCtaReady .42s cubic-bezier(.2,.8,.2,1)}
.sl-cta-spin,.sl-ba-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;
  animation:slspin .7s linear infinite;flex:none}
/* Disabled ("Select seats"): quieter, but still a full-width button shape. */
.sl-picker .sl-cta:disabled{background:var(--sl-surface);color:var(--sl-muted);opacity:1;
  cursor:not-allowed;filter:none;transform:none}

/* Chrome anchor regions (Feature 6) — every persistent map overlay is APPENDED
   INTO one of these positioned flex containers and flows/stacks within it, so no
   two pieces of chrome free-float on top of each other. Regions never overlap:
   the top strip splits into left/center/right; rails + corners own their edge. */
.sl-anchor{position:absolute;z-index:5;display:flex;gap:8px;pointer-events:none}
.sl-anchor > *{pointer-events:auto}
.sl-anchor[data-region="top-left"]{top:12px;left:12px;flex-wrap:wrap;max-width:38%}
.sl-anchor[data-region="top-center"]{top:12px;left:50%;transform:translateX(-50%);flex-direction:column;
  align-items:center;max-width:44%}
.sl-anchor[data-region="top-right"]{top:12px;right:12px;justify-content:flex-end;flex-wrap:wrap;max-width:38%}
.sl-anchor[data-region="left-rail"]{top:50%;left:12px;transform:translateY(-50%);flex-direction:column;max-width:42%;gap:6px}
.sl-anchor[data-region="bottom-left"]{left:12px;bottom:12px;flex-direction:column;align-items:flex-start}
.sl-anchor[data-region="bottom-center"]{left:50%;bottom:14px;transform:translateX(-50%);z-index:9;
  flex-direction:column;align-items:center;gap:8px;max-width:92%}
.sl-anchor[data-region="bottom-right"]{right:12px;bottom:12px;flex-direction:column;align-items:flex-end;gap:6px}
/* narrow: tighten the top strip so left/center can't crowd each other */
.sl-picker[data-layout="narrow"] .sl-anchor[data-region="top-left"]{max-width:30%}
.sl-picker[data-layout="narrow"] .sl-anchor[data-region="top-center"]{max-width:44%}

/* TEST MODE badge — a small pill in the top-right region (shrinks on narrow) */
.sl-testbadge{padding:5px 11px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.1em;
  text-transform:uppercase;white-space:nowrap;background:var(--sl-accent);color:var(--sl-accent-ink);
  box-shadow:0 2px 8px rgba(0,0,0,.25)}
.sl-picker[data-layout="narrow"] .sl-testbadge{padding:3px 8px;font-size:8.5px;letter-spacing:.06em}

/* zoom column (flows within the bottom-right region) */
.sl-zoom{display:flex;flex-direction:column;gap:6px}
.sl-zoom button{width:36px;height:36px;border-radius:999px;background:var(--sl-surface);border:1px solid var(--sl-line);
  color:var(--sl-text);font-size:17px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.sl-zoom button:hover{border-color:var(--sl-muted)}
.sl-zoom svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}

/* toast + boot states (toast flows in the bottom-center region) */
.sl-toast{transform:translateY(6px) scale(.98);max-width:100%;
  background:var(--sl-surface);border:1px solid var(--sl-line);color:var(--sl-text);border-radius:999px;padding:9px 16px;
  font-size:12.5px;font-weight:600;opacity:0;pointer-events:none;transition:opacity .22s,transform .22s;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.sl-toast.on{opacity:1;transform:translateY(0) scale(1)}
.sl-toast.has-action{pointer-events:auto;display:flex;align-items:center;gap:12px;padding-right:8px}
.sl-toast-action{min-height:30px;padding:5px 10px;border-radius:999px;background:var(--sl-accent);color:var(--sl-accent-ink);
  font:inherit;font-weight:800}
.sl-toast[data-tone="error"]{border-color:#ef4444}
.sl-toast[data-tone="warning"]{border-color:var(--sl-accent)}
.sl-toast[data-tone="success"]{border-color:#22c55e}
.sl-toast.on[data-tone="error"]{animation:slToastNudge .32s ease-out}
.sl-boot{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;background:var(--sl-bg);font-size:13px;font-weight:600;color:var(--sl-muted)}
.sl-boot-spin{width:24px;height:24px;border-radius:50%;border:3px solid var(--sl-line);border-top-color:var(--sl-accent);
  animation:slspin .8s linear infinite}
@keyframes slspin{to{transform:rotate(360deg)}}
.sl-boot-title{font-weight:800;font-size:15px;color:var(--sl-text)}
.sl-boot-retry{margin-top:4px;padding:9px 20px;border-radius:var(--sl-r-sm);background:var(--sl-accent);
  color:var(--sl-accent-ink);font-weight:700;font-size:13px}

/* "Need more time?" extend prompt (flows in the bottom-center region, above the toast) */
.sl-extend{transform:translateY(6px);
  display:none;align-items:center;gap:12px;max-width:100%;background:var(--sl-surface);border:1px solid var(--sl-line);
  color:var(--sl-text);border-radius:14px;padding:10px 12px 10px 16px;box-shadow:0 18px 50px -18px rgba(0,0,0,.6);
  opacity:0;transition:opacity .2s,transform .2s}
.sl-extend.on{display:flex;opacity:1;transform:translateY(0)}
.sl-extend-txt{font-size:12.5px;font-weight:600;line-height:1.35}
.sl-extend-txt b{font-variant-numeric:tabular-nums}
.sl-extend-btn{flex:none;padding:8px 14px;border-radius:999px;font-weight:800;font-size:12.5px;
  background:var(--sl-accent);color:var(--sl-accent-ink);transition:filter .15s,opacity .15s}
.sl-extend-btn:hover{filter:brightness(1.08)}
.sl-extend-btn:disabled{opacity:.5;cursor:not-allowed}

/* booked confirmation overlay (covers the widget once the held seats are sold) */
.sl-booked{position:absolute;inset:0;z-index:11;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:12px;text-align:center;padding:28px;background:var(--sl-bg);opacity:0;visibility:hidden;
  pointer-events:none;transition:opacity .34s ease,visibility 0s linear .34s}
.sl-booked.on{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .34s ease,visibility 0s}
.sl-booked-badge{width:60px;height:60px;border-radius:999px;display:flex;align-items:center;justify-content:center;
  background:var(--sl-accent);color:var(--sl-accent-ink);transform:scale(.72)}
.sl-booked.on .sl-booked-badge{animation:slSuccessPop .58s cubic-bezier(.2,1.25,.3,1) .08s both}
.sl-booked-badge svg{width:30px;height:30px;stroke:currentColor;stroke-width:2.6;fill:none;stroke-linecap:round;stroke-linejoin:round;
  stroke-dasharray:30;stroke-dashoffset:30}
.sl-booked.on .sl-booked-badge svg{animation:slCheckDraw .42s ease-out .32s forwards}
.sl-booked-title{font-weight:800;font-size:19px;color:var(--sl-text)}
.sl-booked-sub{font-size:13px;color:var(--sl-muted);line-height:1.5;max-width:320px}
.sl-booked-seats{font-weight:700;color:var(--sl-text)}
.sl-booked.on .sl-booked-title,.sl-booked.on .sl-booked-sub{animation:slCopyRise .42s ease-out both}
.sl-booked.on .sl-booked-title{animation-delay:.22s}
.sl-booked.on .sl-booked-sub{animation-delay:.3s}

/* a11y filter chips (flow within the top-left region) */
.sl-chips{display:flex;gap:6px;flex-wrap:wrap}
.sl-chip-f{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;font-size:12px;font-weight:700;
  background:var(--sl-surface);border:1px solid var(--sl-line);color:var(--sl-muted);transition:color .15s,border-color .15s}
.sl-chip-f:hover{color:var(--sl-text)}
.sl-chip-f.on{background:var(--sl-accent);color:var(--sl-accent-ink);border-color:transparent}

/* confirm card: a candidate is not in the tray until Select. Map gestures and
   floating chrome pause while the card owns focus, keeping the camera stable. */
.sl-picker[data-confirming="true"] .sl-map-host>:not(.sl-confirm){pointer-events:none}
.sl-picker[data-confirming="true"] .sl-anchor{pointer-events:none;opacity:.28;transition:opacity .16s}
.sl-picker[data-confirming="true"] .sl-side{pointer-events:none;opacity:.58;transition:opacity .16s}
.sl-confirm{position:absolute;z-index:10;width:276px;max-width:calc(100% - 24px);overflow:hidden;pointer-events:auto;
  background:var(--sl-surface);border:1px solid color-mix(in srgb,var(--sl-line) 70%,var(--sl-text));
  border-radius:15px;box-shadow:0 24px 64px -18px rgba(0,0,0,.72);transform:translate(-50%,calc(-100% - 16px));
  animation:slConfirmIn .24s cubic-bezier(.2,.8,.2,1) both}
.sl-confirm[data-placement="below"]{transform:translate(-50%,16px);animation:slConfirmBelowIn .24s cubic-bezier(.2,.8,.2,1) both}
.sl-confirm-grid{display:grid;grid-template-columns:1.2fr .8fr .8fr;border-bottom:1px solid var(--sl-line)}
.sl-confirm-field{min-width:0;padding:12px 11px 10px;border-right:1px solid var(--sl-line)}
.sl-confirm-field:last-child{border-right:0;text-align:center}
.sl-confirm-field:nth-child(2){text-align:center}
.sl-confirm-key{display:block;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--sl-muted);font-weight:800}
.sl-confirm-value{display:block;margin-top:4px;color:var(--sl-text);font-size:17px;line-height:1.1;font-weight:850;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-confirm-cat{display:flex;align-items:center;gap:8px;padding:10px 12px;background:color-mix(in srgb,var(--sl-cat) 76%,var(--sl-surface))}
.sl-confirm-cat .sl-dot{border:2px solid rgba(255,255,255,.78);width:11px;height:11px}
.sl-confirm-cat-name{font-size:13.5px;font-weight:800;color:#fff;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-confirm-price{font-size:17px;font-weight:850;color:#fff;font-variant-numeric:tabular-nums}
.sl-confirm-body{padding:11px 12px 12px}
.sl-confirm-row{display:flex;gap:8px;margin-top:10px}
.sl-confirm-row button{flex:1;min-height:44px;padding:9px 12px;border-radius:9px;font-weight:800;font-size:13px}
.sl-confirm-add{background:var(--sl-accent)!important;color:var(--sl-accent-ink)!important;display:flex;align-items:center;justify-content:center;gap:7px}
.sl-confirm-add svg{width:16px;height:16px;stroke:currentColor;stroke-width:2.8;fill:none;stroke-linecap:round;stroke-linejoin:round}
.sl-confirm-cancel{background:color-mix(in srgb,var(--sl-line) 44%,transparent)!important;border:1px solid var(--sl-line)!important;color:var(--sl-muted)!important}
.sl-confirm-cancel:hover{color:var(--sl-text)}
.sl-picker[data-layout="narrow"] .sl-confirm{left:50%!important;top:auto!important;bottom:14px;width:min(342px,calc(100% - 24px));
  transform:translateX(-50%);animation:slConfirmMobileIn .24s cubic-bezier(.2,.8,.2,1) both}

/* Best available is a first-class shortcut, not an anonymous utility row. */
.sl-ba{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:7px;
  padding:13px;border:1px solid color-mix(in srgb,var(--sl-accent) 34%,var(--sl-line));border-radius:13px;
  background:linear-gradient(135deg,color-mix(in srgb,var(--sl-accent) 5%,var(--sl-surface)),color-mix(in srgb,var(--sl-accent) 11%,var(--sl-surface)))}
.sl-ba::after{content:'✦';position:absolute;right:10px;top:3px;color:color-mix(in srgb,var(--sl-accent) 20%,transparent);font-size:42px;line-height:1}
.sl-ba-title,.sl-ba-copy,.sl-ba select,.sl-ba-qty,.sl-ba-go{position:relative;z-index:1}
.sl-ba-title{grid-column:1/-1;display:flex;align-items:center;gap:7px;font-size:13px;font-weight:850}
.sl-ba-title .spark{color:var(--sl-accent);font-size:16px}
.sl-ba-copy{grid-column:1/-1;margin:-4px 0 2px 23px;color:var(--sl-muted);font-size:10.5px;line-height:1.35}
.sl-ba-copy .narrow{display:none}
.sl-ba select{background:var(--sl-surface);color:var(--sl-text);border:1px solid var(--sl-line);border-radius:8px;
  font:inherit;font-size:11px;padding:7px 8px;min-width:0;width:100%;max-width:none}
.sl-ba-qty{display:flex;align-items:center;gap:7px;padding:3px;border:1px solid var(--sl-line);border-radius:9px;background:var(--sl-surface)}
.sl-ba-qty button{width:25px;height:25px;border-radius:7px;background:color-mix(in srgb,var(--sl-line) 35%,transparent);border:0;
  font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center}
.sl-ba-qty span{min-width:14px;text-align:center;font-weight:800}
.sl-picker .sl-ba-go{grid-column:1/-1;width:100%;min-height:37px;padding:7px 12px;border-radius:9px;background:var(--sl-accent);
  color:var(--sl-accent-ink);font-weight:800;font-size:12px;transition:filter .15s,opacity .15s;display:flex;align-items:center;justify-content:center;gap:6px;
  box-shadow:0 8px 18px color-mix(in srgb,var(--sl-accent) 18%,transparent)}
.sl-picker .sl-ba-go:hover{filter:brightness(1.06)}
.sl-picker .sl-ba-go:disabled{opacity:.62;cursor:wait}
.sl-ba-replace{grid-column:1/-1;padding:3px 0 1px}
.sl-ba-replace b{display:block;font-size:12.5px}
.sl-ba-replace span{display:block;margin-top:3px;color:var(--sl-muted);font-size:10.5px;line-height:1.35}
.sl-ba-actions{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:7px}
.sl-ba-actions button{min-height:36px;border-radius:9px;border:1px solid var(--sl-line);font-size:11.5px;font-weight:800}
.sl-ba-actions .replace{border-color:var(--sl-accent);background:var(--sl-accent);color:var(--sl-accent-ink)}
.sl-picker[data-layout="narrow"] .sl-ba{padding:11px}
.sl-picker[data-layout="narrow"] .sl-ba-copy .wide{display:none}
.sl-picker[data-layout="narrow"] .sl-ba-copy .narrow{display:inline}

/* screen-reader live region */
.sl-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* per-seat ticket-tier select + view-from-seat button in tray chips */
.sl-chip .tier{background:var(--sl-bg);color:var(--sl-text);border:1px solid var(--sl-line);border-radius:6px;
  font:inherit;font-size:10px;padding:2px 4px;min-width:0;max-width:100%;cursor:pointer}

/* arena: LOD rung pills (flow within the top-center region) */
.sl-rungs{display:none;background:var(--sl-surface);border:1px solid var(--sl-line);border-radius:999px;padding:3px}
.sl-rungs.on{display:inline-flex;gap:2px}
.sl-rungs button{padding:6px 13px;border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.07em;
  color:var(--sl-muted);white-space:nowrap;transition:color .15s}
.sl-rungs button:hover{color:var(--sl-text)}
.sl-rungs button.on{background:var(--sl-accent);color:var(--sl-accent-ink)}
/* narrow: shrink the rung pills so the centered row can't reach the corner regions */
.sl-picker[data-layout="narrow"] .sl-rungs button{padding:5px 9px;font-size:9px;letter-spacing:.03em}

/* multi-floor switcher (flows within the left-rail region) */
.sl-floors{display:none;flex-direction:column;gap:6px;max-width:100%}
.sl-floors.on{display:flex}
.sl-floors button{padding:7px 13px;border-radius:999px;font-size:12px;font-weight:700;background:var(--sl-surface);
  border:1px solid var(--sl-line);color:var(--sl-muted);white-space:nowrap;max-width:100%;overflow:hidden;
  text-overflow:ellipsis;transition:color .15s,border-color .15s}
.sl-floors button:hover{color:var(--sl-text)}
.sl-floors button.on{background:var(--sl-accent);color:var(--sl-accent-ink);border-color:transparent}

/* tapped-section summary card — docks INSIDE the top-center anchor region on
   wide (flows below the rung pills, never over them, never floating over the
   seats at the tap point). Auto-collapses to a slim pill once seat-picking
   begins (first seat select, or a pan/zoom after the focus glide); tapping the
   pill re-expands; ✕ closes in both states. On narrow it renders as a compact
   strip inside the bottom sheet's peek head — never over the canvas. */
.sl-seccard{width:250px;max-width:100%;background:var(--sl-surface);border:1px solid var(--sl-line);border-radius:12px;
  padding:12px 14px;box-shadow:0 18px 50px -18px rgba(0,0,0,.6);display:none}
.sl-seccard.on{display:block}
/* collapsed pill (wide) */
.sl-seccard.mini{width:auto;padding:5px 7px 5px 12px;border-radius:999px;cursor:pointer}
.sl-seccard.mini.on{display:inline-flex;align-items:center;gap:7px}
.sl-seccard.mini .sl-seccard-name{font-size:12px;flex:none;max-width:120px}
.sl-seccard.mini .sl-seccard-left{font-size:11px}
/* narrow: compact strip inside the sheet head (peek area) */
.sl-seccard.strip{width:100%;padding:7px 0 0;border:0;border-radius:0;box-shadow:none;background:none;cursor:default}
.sl-seccard.strip.on{display:flex;align-items:center;gap:7px;font-size:12.5px}
.sl-seccard.strip .sl-seccard-name{font-size:12.5px}
.sl-seccard.strip .sl-seccard-price{margin-left:auto}
.sl-seccard-head{display:flex;align-items:center;gap:8px}
.sl-seccard-dot{width:10px;height:10px;border-radius:50%;flex:none}
.sl-seccard-name{font-weight:800;font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-seccard-price{font-weight:800;font-size:12.5px;font-variant-numeric:tabular-nums}
.sl-seccard-x{width:22px;height:22px;border-radius:999px;flex:none;display:flex;align-items:center;justify-content:center;
  color:var(--sl-muted);font-size:12px}
.sl-seccard-x:hover{color:var(--sl-text)}
.sl-seccard-zone{font-size:11.5px;color:var(--sl-muted);margin-top:6px}
.sl-seccard-left{color:var(--sl-text);font-weight:700}
.sl-seccard-mix{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px}
.sl-seccard-mix-item{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--sl-muted)}
.sl-seccard-mix-dot{width:8px;height:8px;border-radius:50%;flex:none}
.sl-seccard-mix-price{font-weight:700;color:var(--sl-text)}
.sl-seccard-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
.sl-seccard-overview{font-size:12px;font-weight:800;color:var(--sl-accent)}
.sl-seccard-hint{font-size:10.5px;color:var(--sl-muted)}

/* view-from-seat button on the confirm popover */
.sl-confirm-view{width:100%;margin-top:9px;padding:8px;border-radius:8px;border:1px solid var(--sl-line);
  color:var(--sl-text);font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;gap:7px}
.sl-confirm-view:hover{border-color:var(--sl-muted)}
.sl-confirm-view svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}

/* 360° seat-view modal (fills the widget; drag-to-look-around equirectangular) */
.sl-view{position:absolute;inset:0;z-index:12;display:flex;flex-direction:column;background:var(--sl-bg)}
.sl-view-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--sl-line);flex:none}
.sl-view-title{font-weight:800;font-size:15px}
.sl-view-cap{font-size:11px;color:var(--sl-muted)}
.sl-view-x{margin-left:auto;width:32px;height:32px;border-radius:999px;border:1px solid var(--sl-line);color:var(--sl-muted);
  flex:none;display:flex;align-items:center;justify-content:center;transition:color .15s,border-color .15s}
.sl-view-x:hover{color:var(--sl-text);border-color:var(--sl-muted)}
.sl-view-x svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round}
.sl-view-pano{position:relative;flex:1;min-height:0;overflow:hidden;cursor:grab;background-color:#05070c;
  background-repeat:repeat-x;touch-action:none;user-select:none}
.sl-view-pano.drag{cursor:grabbing}
.sl-view-badge{position:absolute;top:12px;left:12px;padding:5px 11px;border-radius:999px;font-size:10px;font-weight:800;
  letter-spacing:.08em;background:var(--sl-surface);border:1px solid var(--sl-line);color:var(--sl-muted)}
.sl-view-hint{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);padding:6px 14px;border-radius:999px;
  font-size:11.5px;font-weight:600;background:var(--sl-surface);border:1px solid var(--sl-line);color:var(--sl-muted);
  white-space:nowrap;pointer-events:none;max-width:90%;overflow:hidden;text-overflow:ellipsis}

/* F3 minimap — venue overview + live viewport rect (flows in the bottom-left region) */
.sl-minimap{border:1px solid var(--sl-line);border-radius:9px;
  overflow:hidden;background:var(--sl-surface);box-shadow:0 12px 34px -14px rgba(0,0,0,.55);line-height:0;cursor:pointer}
.sl-minimap canvas{display:block}
.sl-picker[data-layout="narrow"] .sl-minimap{display:none}

/* F4 legend reflection: rows + counts for out-of-band categories read muted */
.sl-price-row.sl-dim{opacity:.4}
.sl-seccard-mix-item.sl-dim{opacity:.4}

/* Buyer-journey motion: every animation explains a state transition (selected,
   held, checkout handoff, conflict or booked). No decorative infinite motion
   except the expiring-hold pulse and active progress spinners. */
@keyframes slPillIn{from{opacity:0;transform:translateX(7px) scale(.9)}to{opacity:1;transform:translateX(0) scale(1)}}
@keyframes slHoldPulse{0%{box-shadow:0 0 0 0 currentColor;opacity:.9}75%,100%{box-shadow:0 0 0 7px transparent;opacity:.55}}
@keyframes slChipIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes slChipOut{to{opacity:0;transform:translateX(10px) scale(.98)}}
@keyframes slNoticeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes slValuePop{0%{opacity:.6;transform:translateY(3px)}55%{transform:translateY(-1px) scale(1.05)}100%{opacity:1;transform:none}}
@keyframes slCtaReady{0%{transform:scale(.98);box-shadow:0 0 0 0 transparent}55%{transform:scale(1.01);box-shadow:0 0 0 5px color-mix(in srgb,var(--sl-accent) 18%,transparent)}100%{transform:none;box-shadow:none}}
@keyframes slToastNudge{0%,100%{margin-left:0}30%{margin-left:-4px}60%{margin-left:3px}}
@keyframes slSuccessPop{0%{opacity:0;transform:scale(.72)}65%{opacity:1;transform:scale(1.08)}100%{opacity:1;transform:scale(1)}}
@keyframes slCheckDraw{to{stroke-dashoffset:0}}
@keyframes slCopyRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes slConfirmIn{from{opacity:0;transform:translate(-50%,calc(-100% - 8px)) scale(.96)}to{opacity:1;transform:translate(-50%,calc(-100% - 14px)) scale(1)}}
@keyframes slConfirmBelowIn{from{opacity:0;transform:translate(-50%,8px) scale(.96)}to{opacity:1;transform:translate(-50%,16px) scale(1)}}
@keyframes slConfirmMobileIn{from{opacity:0;transform:translate(-50%,10px) scale(.97)}to{opacity:1;transform:translate(-50%,0) scale(1)}}

@media(prefers-reduced-motion:reduce){
  .sl-picker *,.sl-modal-scrim *{animation-duration:.001ms!important;animation-iteration-count:1!important;
    transition-duration:.001ms!important;scroll-behavior:auto!important}
}

/* modal host */
.sl-modal-scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(5,7,12,.66);display:flex;align-items:center;justify-content:center;padding:18px}
.sl-modal-frame{width:min(1200px,100%);height:min(820px,100%);border-radius:16px;overflow:hidden;box-shadow:0 40px 120px -30px rgba(0,0,0,.8)}
@media(max-width:640px){.sl-modal-scrim{padding:0}.sl-modal-frame{width:100%;height:100%;border-radius:0}}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Merge order: defaults ← org chart theme ← host overrides. */
function resolveTokens(chart: ChartTheme | undefined, host: SeatPickerTheme | undefined): Record<string, string> {
  const accent = host?.accent ?? chart?.accent ?? '#f4b740';
  const accentInk = host?.accentInk ?? chart?.accentInk ?? '#1a1200';
  return {
    '--sl-accent': accent,
    '--sl-accent-ink': accentInk,
    '--sl-bg': host?.background ?? chart?.background ?? '#0f1522',
    '--sl-surface': host?.surface ?? '#1a2234',
    '--sl-text': host?.text ?? chart?.textColor ?? '#eef1f8',
    '--sl-muted': host?.muted ?? '#8b93a7',
    '--sl-line': host?.line ?? 'rgba(139,147,167,.22)',
    '--sl-font': host?.fontFamily ?? chart?.fontFamily ?? "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif",
    '--sl-radius': `${host?.radius ?? 14}px`,
  };
}

export class SeatPicker {
  private readonly opts: SeatPickerOptions;
  private readonly api: PickerTransport;
  private readonly apiBase: string;
  private readonly controller: PickerController;
  private readonly maxTickets: number;

  private root: HTMLDivElement | null = null;
  private mapHost: HTMLDivElement | null = null;
  private rendered = false;
  private destroyed = false;

  // chrome refs
  private els: Record<string, HTMLElement> = {};
  /** Feature 6 anchor regions — positioned flex containers over the map. */
  private regions: Record<string, HTMLElement> = {};
  private ro: ResizeObserver | null = null;
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Short-lived UI motion timers; all are cancelled on destroy. */
  private motionTimers = new Set<ReturnType<typeof setTimeout>>();

  // state
  private currency = 'USD';
  private hold: HoldResult | null = null;
  /** Latest server expiry for the open hold (moves on extend). */
  private holdExpiresAt = 0;
  /** True once we handed off to checkout — arms booked-confirmation detection. */
  private handedOff = false;
  /** Guards single onBooked + single success overlay per hold. */
  private bookedShown = false;
  private extendEl: HTMLDivElement | null = null;
  private bookedEl: HTMLDivElement | null = null;
  private gaQty = new Map<string, number>();
  private tipEl: HTMLDivElement | null = null;
  private tipPos = { x: 0, y: 0 };
  private confirmEl: HTMLDivElement | null = null;
  private confirmSeat: ExpandedSeat | null = null;
  private srEl: HTMLDivElement | null = null;
  private baQty = 2;
  private baCat = '';
  private bestAvailableConfirm = false;
  private releasingHold = false;

  // arena / multi-floor / seat-view chrome
  private rungsEl: HTMLDivElement | null = null;
  private floorsEl: HTMLDivElement | null = null;
  private secCardEl: HTMLDivElement | null = null;
  private viewEl: HTMLDivElement | null = null;
  private viewCleanup: (() => void) | null = null;
  private allSeatsCache: ExpandedSeat[] | null = null;

  // F3 minimap
  private miniCanvas: HTMLCanvasElement | null = null;
  private miniBase: HTMLCanvasElement | null = null;
  private miniTf: { scale: number; offX: number; offY: number; dpr: number } | null = null;

  // F4 price-band filter — active band's category keys (null = all prices)
  private priceBandKeys: Set<string> | null = null;
  /** Last surfaced section summary (re-rendered when the price band changes). */
  private lastSection: SectionSummary | null = null;
  /** Section card collapsed to its slim pill (seat-picking has begun). */
  private secCardCollapsed = false;
  /** When the card was (re)shown — the focus glide's own view change must not collapse it. */
  private secCardShownAt = 0;
  /** Previous tray ticket count — first 0→n transition auto-expands the mobile sheet. */
  private lastTrayCount = 0;
  /** Previous computed total — drives a single explanatory value bump. */
  private lastTrayTotal = 0;
  /** Stable item keys prevent tray chips re-animating on unrelated realtime syncs. */
  private lastTrayKeys = new Set<string>();
  private bestAvailableBusy = false;
  private releasingLabels = new Set<string>();
  /** Selected labels awaiting the hold response; their own realtime echo can arrive first. */
  private holdingLabels = new Set<string>();
  private ctaPhase: 'idle' | 'holding' | 'checkout' = 'idle';
  // narrow-layout chrome that docks into the sheet's Filters row on mobile
  private a11yChipsEl: HTMLDivElement | null = null;
  private cbEl: HTMLButtonElement | null = null;

  // modal plumbing (set by open())
  private modalScrim: HTMLElement | null = null;
  private prevFocus: Element | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

  /** Set by open(): closes the modal (scroll restore + destroy + onClose). */
  private closeModal: (() => void) | null = null;

  /**
   * Close the picker. In modal mode (SeatPicker.open()) this dismisses the
   * modal exactly like ESC/scrim/✕ — restores page scroll and fires onClose.
   * For inline mounts it simply destroys the widget.
   */
  close(): void {
    if (this.closeModal) this.closeModal();
    else this.destroy();
  }

  /** Mount the full picker as a document-level modal. Resolves after render. */
  static async open(options: Omit<SeatPickerOptions, 'container'>): Promise<SeatPicker> {
    ensureStyle();
    const scrim = document.createElement('div');
    scrim.className = 'sl-modal-scrim';
    const frame = document.createElement('div');
    frame.className = 'sl-modal-frame';
    scrim.appendChild(frame);
    document.body.appendChild(scrim);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const picker = new SeatPicker({ ...options, container: frame });
    picker.modalScrim = scrim;
    picker.prevFocus = document.activeElement;
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      document.body.style.overflow = prevOverflow;
      // Visually dismiss immediately, but let an abandoned auto-hold finish its
      // release request before tearing down the transport. This keeps closing a
      // modal from stranding inventory until the normal hold expiry.
      scrim.style.opacity = '0';
      scrim.style.pointerEvents = 'none';
      const finish = (): void => {
        picker.destroy();
        options.onClose?.();
      };
      if (picker.hold && !picker.handedOff) void picker.release().finally(finish);
      else finish();
    };
    picker.closeModal = close;
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) close();
    });
    picker.escHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (picker.confirmSeat) {
        e.preventDefault();
        picker.cancelConfirm();
      } else if (picker.bestAvailableConfirm) {
        e.preventDefault();
        picker.bestAvailableConfirm = false;
        picker.syncTray();
      } else {
        close();
      }
    };
    document.addEventListener('keydown', picker.escHandler);
    await picker.render();
    picker.els.close?.classList.add('on');
    picker.els.close?.addEventListener('click', close);
    return picker;
  }

  constructor(options: SeatPickerOptions) {
    if (!options || typeof options !== 'object') throw new Error('seatmap: options object is required');
    if (!options.event || typeof options.event !== 'string') throw new Error('seatmap: `event` key is required');
    if (!options.container) throw new Error('seatmap: `container` is required (or use SeatPicker.open())');
    this.opts = { ...options, confirmSelection: options.confirmSelection ?? true };
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.api = options.transport ?? new PubApi(this.apiBase);
    this.maxTickets = Math.max(1, Math.floor(options.maxSelection ?? DEFAULT_MAX_SELECTION));
    this.controller = new PickerController({
      transport: this.api,
      eventKey: options.event,
      maxSelection: this.maxTickets,
      currency: options.currency,
      flashOnLiveChange: true,
      colorblindSafe: options.colorblindSafe,
      onSelectionChange: () => {
        this.syncTray();
        // Seat-picking has begun — collapse the section card out of the way.
        if (this.committedSelection().length) this.collapseSectionCard();
      },
      onStatusChange: () => {
        this.syncPrices();
        this.evictTakenSelections();
        this.detectBooked();
        // Live open/close of a section repaints the minimap's static overview.
        this.refreshMinimap();
      },
      onHoldExpired: () => {
        this.hold = null;
        this.forgetHold();
        this.handedOff = false;
        this.bookedShown = false;
        this.ctaPhase = 'idle';
        this.stopHoldTimer();
        this.gaQty.clear();
        this.toast(t('picker.holdExpired', undefined) || 'Your hold expired — seats released. Pick again.', 'warning');
        this.syncTray();
        this.emitHoldChange();
        this.opts.onHoldExpired?.();
      },
      confirmSelection: this.opts.confirmSelection,
      onSelect: (seat) => {
        this.flashPickedSeat(seat.id);
        if (this.opts.confirmSelection) this.showConfirm(seat);
      },
      onDeselect: (seat) => {
        if (this.confirmSeat?.id === seat.id) this.dismissConfirm();
      },
      onSelectionLimit: () => {
        this.toast(`You can select up to ${this.maxTickets} tickets for this order.`, 'warning');
      },
      onViewChange: () => {
        this.reanchorConfirm();
        this.syncRung();
        this.drawMinimapRect();
        this.sectionCardOnView();
      },
      // Tapped-section glide-in → surface (or clear) the section-summary card.
      onSectionFocus: (summary) => this.showSectionCard(summary),
      onFocusSeat: (seat) => this.announceSeat(seat),
      onSeatHover: (d) => this.updateTooltip(d),
      onHint: (m) => {
        if (m) this.toast(m);
      },
      onError: (err) => this.opts.onError?.(err),
    });
  }

  async render(): Promise<this> {
    if (this.rendered) return this;
    this.rendered = true;
    ensureStyle();
    await loadLocale(this.opts.locale);
    if (this.opts.messages) setStringOverrides(this.opts.messages);

    const mount = resolveContainer(this.opts.container!);
    const root = document.createElement('div');
    root.className = 'sl-picker';
    root.tabIndex = -1;
    this.root = root;
    mount.appendChild(root);
    root.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (this.confirmSeat) {
        e.preventDefault();
        e.stopPropagation();
        this.cancelConfirm();
      } else if (this.bestAvailableConfirm) {
        e.preventDefault();
        e.stopPropagation();
        this.bestAvailableConfirm = false;
        this.syncTray();
      }
    });

    // skeleton first — tokens get re-applied once the chart theme arrives
    Object.entries(resolveTokens(undefined, this.opts.theme)).forEach(([k, v]) => root.style.setProperty(k, v));
    root.innerHTML = `
      <div class="sl-head">
        <div class="sl-logo" data-ref="logo"></div>
        <div class="sl-head-info">
          <div class="sl-head-name" data-ref="name"></div>
          <div class="sl-head-meta" data-ref="meta"></div>
        </div>
        <span class="sl-hold-pill" data-ref="hold"></span>
        <button type="button" class="sl-close" data-ref="close" aria-label="Close">
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="sl-body">
        <div class="sl-map">
          <div class="sl-map-host" data-ref="map"></div>
          <div class="sl-zoom" data-ref="zoom">
            <button type="button" aria-label="Zoom in" data-ref="zin">+</button>
            <button type="button" aria-label="Zoom out" data-ref="zout">−</button>
            <button type="button" aria-label="Fit to screen" data-ref="zfit">
              <svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            </button>
          </div>
          <div class="sl-boot" data-ref="boot"><span class="sl-boot-spin"></span>Loading seat map…</div>
          <div class="sl-toast" data-ref="toast" role="status" aria-live="polite"></div>
        </div>
        <div class="sl-side" data-ref="side">
          <div class="sl-sheet-head" data-ref="sheetHead">
            <div class="sl-sheet-grab"></div>
            <div class="sl-sheet-bar">
              <div class="sl-sheet-peek" data-ref="peek"></div>
              <button type="button" class="sl-sheet-toggle" data-ref="sheetToggle" aria-label="Open ticket panel" aria-expanded="false">
                <svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>
              </button>
            </div>
          </div>
          <div class="sl-sec sl-filtersec" data-ref="filtersSec">Filters</div>
          <div class="sl-filters" data-ref="filters"></div>
          <div class="sl-sec sl-prices-sec" data-ref="pricesSec"><span>Ticket prices</span></div>
          <div class="sl-prices" data-ref="prices"></div>
          <div class="sl-live" data-ref="live" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span data-ref="liveText">Live availability — seats update in real time</span></div>
          <div class="sl-sec sl-seats-sec"><span>Your seats</span><span class="sl-seat-summary" data-ref="seatSummary"></span></div>
          <div class="sl-tray" data-ref="tray"></div>
          <div class="sl-foot" data-ref="foot">
            <div class="sl-hold-note" data-ref="holdNote" role="status" aria-live="polite">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
              <span><b data-ref="holdTitle">Seats secured</b><span class="sl-hold-copy" data-ref="holdCopy">Checkout timer is running.</span></span>
              <button type="button" class="sl-hold-change" data-ref="holdChange" aria-label="Release held tickets and choose different seats">Change</button>
            </div>
            <div class="sl-total"><span data-ref="count"></span><b data-ref="total"></b></div>
            <button type="button" class="sl-cta" data-ref="cta" disabled></button>
          </div>
        </div>
      </div>`;
    root.querySelectorAll<HTMLElement>('[data-ref]').forEach((el) => {
      this.els[el.dataset.ref!] = el;
    });
    this.mapHost = this.els.map as HTMLDivElement;

    // container-adaptive layout (breakpoint keys off the CONTAINER, not the viewport)
    const applyLayout = (): void => {
      const w = root.clientWidth;
      if (w <= 0) return;
      const next = w < 640 ? 'narrow' : 'wide';
      if (root.dataset.layout === next) return;
      root.dataset.layout = next;
      // Entering the mobile sheet layout: start in the peek state (map-first).
      if (next === 'narrow' && !root.dataset.sheet) root.dataset.sheet = 'peek';
      this.dockLayoutChrome();
    };
    this.ro = new ResizeObserver(applyLayout);
    this.ro.observe(root);
    // Some environments defer the ResizeObserver's initial callback (backgrounded
    // tabs throttle delivery). Seed the layout synchronously + next frame so a
    // container that mounts already-wide gets data-layout="wide" immediately,
    // instead of waiting on a resize that may never arrive.
    applyLayout();
    requestAnimationFrame(applyLayout);

    // zoom + tooltip wiring
    this.els.zin.addEventListener('click', () => this.controller.zoomIn());
    this.els.zout.addEventListener('click', () => this.controller.zoomOut());
    this.els.zfit.addEventListener('click', () => this.controller.zoomToFit());

    // Mobile bottom sheet: swipe/tap on the sheet HEAD only (never the map host,
    // so the map's raw-pointer gesture pipeline is untouched). Swipe up → open
    // (≤50%); swipe down → peek; a plain tap toggles. The section-card strip's
    // ✕ lives inside the head — taps on the card must not toggle the sheet.
    const head = this.els.sheetHead;
    if (head) {
      const toggle = this.els.sheetToggle as HTMLButtonElement | undefined;
      const setSheet = (open: boolean): void => {
        root.dataset.sheet = open ? 'open' : 'peek';
        toggle?.setAttribute('aria-expanded', String(open));
        toggle?.setAttribute('aria-label', open ? 'Collapse ticket panel' : 'Open ticket panel');
      };
      setSheet(root.dataset.sheet === 'open');
      toggle?.addEventListener('click', (e) => {
        e.stopPropagation();
        setSheet(root.dataset.sheet !== 'open');
      });
      let startY = 0;
      let swiped = false;
      let tracking = false;
      head.addEventListener('pointerdown', (e: PointerEvent) => {
        tracking = true;
        swiped = false;
        startY = e.clientY;
        head.setPointerCapture?.(e.pointerId);
      });
      head.addEventListener('pointermove', (e: PointerEvent) => {
        if (!tracking || swiped) return;
        const dy = e.clientY - startY;
        if (dy < -18) {
          setSheet(true);
          swiped = true;
        } else if (dy > 18) {
          setSheet(false);
          swiped = true;
        }
      });
      head.addEventListener('pointerup', (e: PointerEvent) => {
        if (tracking && !swiped && Math.abs(e.clientY - startY) < 6) {
          if (!(e.target as HTMLElement).closest('.sl-seccard,.sl-sheet-toggle')) setSheet(root.dataset.sheet !== 'open');
        }
        tracking = false;
        head.releasePointerCapture?.(e.pointerId);
      });
    }
    this.tipEl = document.createElement('div');
    this.tipEl.setAttribute('role', 'tooltip');
    this.tipEl.style.cssText =
      'position:absolute;z-index:7;pointer-events:none;display:none;max-width:240px;background:var(--sl-surface);' +
      'color:var(--sl-text);border:1px solid var(--sl-line);border-radius:10px;padding:9px 12px;font-size:12px;line-height:1.45;';
    this.els.map.appendChild(this.tipEl);
    this.els.map.addEventListener('mousemove', (e: MouseEvent) => {
      const r = this.els.map.getBoundingClientRect();
      this.tipPos = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.tipEl && this.tipEl.style.display !== 'none') this.placeTooltip();
    });

    this.els.cta.addEventListener('click', () => void this.handleCta());
    this.els.holdChange?.addEventListener('click', () => void this.handleChangeSeats());

    const canvasHost = document.createElement('div');
    canvasHost.style.cssText = 'position:absolute;inset:0';
    this.mapHost.appendChild(canvasHost);
    const info = await this.controller.render(canvasHost);
    if (this.destroyed) return this;
    if (!info) {
      this.els.boot.innerHTML =
        '<div class="sl-boot-title">The seat map didn’t load</div>' +
        '<div>Check your connection and try again.</div>' +
        '<button type="button" class="sl-boot-retry">Try again</button>';
      this.els.boot.querySelector('button')!.addEventListener('click', () => {
        // full remount: cheapest reliable recovery
        const container = this.opts.container!;
        const opts = this.opts;
        this.destroy();
        void new SeatPicker({ ...opts, container }).render();
      });
      return this;
    }
    this.els.boot.remove();

    // Feature 6: anchor regions for all persistent map chrome, then move the
    // pre-built zoom column + toast into their regions (both were in the skeleton).
    this.buildRegions();
    this.regions['bottom-right'].appendChild(this.els.zoom);
    this.regions['bottom-center'].appendChild(this.els.toast);

    if (info.mode === 'test') {
      // TEST MODE reads as a small badge in the top-right region (was a corner
      // ribbon that collided with the top-right control cluster on narrow widths).
      const badge = document.createElement('div');
      badge.className = 'sl-testbadge';
      badge.textContent = t('picker.testMode');
      badge.setAttribute('aria-label', t('picker.testMode'));
      this.regions['top-right'].appendChild(badge);
    }

    // theme: defaults ← org chart theme ← host overrides
    const chartTheme = this.controller.doc?.theme;
    Object.entries(resolveTokens(chartTheme, this.opts.theme)).forEach(([k, v]) => root.style.setProperty(k, v));
    this.currency = info.currency ?? this.opts.currency ?? 'USD';

    // header
    const logoUrl = this.opts.theme?.logoUrl ?? chartTheme?.logoUrl;
    if (logoUrl) this.els.logo.innerHTML = `<img src="${logoUrl}" alt="">`;
    else this.els.logo.textContent = (this.opts.theme?.brandName ?? chartTheme?.brandName ?? info.eventName ?? '?').slice(0, 1).toUpperCase();
    this.els.name.textContent = info.eventName ?? '';
    const when = info.startsAt
      ? new Date(info.startsAt).toLocaleString(this.opts.locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '';
    this.els.meta.textContent = [info.venue, when].filter(Boolean).join(' · ');

    // Accessibility filter chips — only for types actually present in the chart.
    const present = new Set<AccessibilityType>();
    if (this.controller.doc) {
      for (const seat of expandChart(this.controller.doc)) {
        for (const type of seat.accessibility ?? []) present.add(type);
        if (seat.accessible && !seat.accessibility?.length) present.add('wheelchair');
      }
    }
    if (present.size) {
      const chips = document.createElement('div');
      chips.className = 'sl-chips';
      const GLYPH: Partial<Record<AccessibilityType, string>> = { wheelchair: '♿', companion: '🧑‍🤝‍🧑' };
      const mk = (key: AccessibilityType | 'all', label: string): string =>
        `<button type="button" class="sl-chip-f${key === 'all' ? ' on' : ''}" data-f="${key}">${label}</button>`;
      chips.innerHTML =
        mk('all', 'All seats') +
        [...present]
          .map((type) => mk(type, `${GLYPH[type] ? GLYPH[type] + ' ' : ''}${type[0].toUpperCase()}${type.slice(1).replace(/-/g, ' ')}`))
          .join('');
      this.regions['top-left'].appendChild(chips);
      this.a11yChipsEl = chips;
      chips.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const f = btn.dataset.f as AccessibilityType | 'all';
          chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
          this.controller.setAccessibilityFilter(f === 'all' ? null : [f]);
        });
      });
    }

    // Colorblind-safe toggle rides in the zoom column (wide) or the sheet's
    // Filters row (narrow) — dockLayoutChrome moves it between the two.
    const cb = document.createElement('button');
    cb.type = 'button';
    cb.className = 'sl-cbbtn';
    this.cbEl = cb;
    cb.setAttribute('aria-label', 'Toggle colorblind-friendly colors');
    cb.setAttribute('aria-pressed', String(!!this.opts.colorblindSafe));
    cb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    this.els.zfit.parentElement!.appendChild(cb);
    let cbOn = !!this.opts.colorblindSafe;
    cb.addEventListener('click', () => {
      cbOn = !cbOn;
      cb.setAttribute('aria-pressed', String(cbOn));
      this.controller.setColorblindSafe(cbOn);
    });

    // Screen-reader announcements for keyboard seat focus.
    this.srEl = document.createElement('div');
    this.srEl.className = 'sl-sr';
    this.srEl.setAttribute('aria-live', 'polite');
    root.appendChild(this.srEl);

    // Big-venue chrome: LOD rung pills, multi-floor switcher, section card.
    // Appended AFTER controller.render() — render() wipes the map host's children.
    this.buildArenaChrome();

    // F3 minimap (venue overview + viewport rect) and F4 price-band filter.
    // Same post-render append (the map host was wiped by controller.render()).
    this.buildMinimap();
    this.buildPriceFilter();

    // "Need more time?" prompt (over the map) + booked-confirmation overlay (over
    // the whole widget). Both appended post-render for the same wipe reason.
    this.buildExtendPrompt();
    this.buildBookedOverlay();

    // Dock layout-dependent chrome (a11y chips + colorblind toggle) for the
    // CURRENT layout — the initial applyLayout ran before these were built.
    this.dockLayoutChrome();

    await this.restoreRememberedHold();
    if (this.destroyed) return this;

    this.syncPrices();
    this.syncTray();
    return this;
  }

  /**
   * Move layout-dependent chrome between its wide dock (map regions / zoom
   * column) and its narrow dock (the sheet's consolidated Filters row), and
   * re-render the section card in the form the layout wants (docked card/pill
   * on wide, sheet strip on narrow). Runs on every layout flip + once post-render.
   */
  private dockLayoutChrome(): void {
    const narrow = this.root?.dataset.layout === 'narrow';
    const filters = this.els.filters;
    if (filters) {
      if (narrow) {
        if (this.a11yChipsEl) filters.appendChild(this.a11yChipsEl);
        if (this.cbEl) filters.appendChild(this.cbEl);
      } else {
        if (this.a11yChipsEl) this.regions['top-left']?.appendChild(this.a11yChipsEl);
        if (this.cbEl) this.els.zoom?.appendChild(this.cbEl);
      }
      const has = narrow && filters.children.length > 0;
      filters.classList.toggle('has', has);
      this.els.filtersSec?.classList.toggle('has', has);
    }
    if (this.lastSection) this.renderSectionCard(this.lastSection);
  }

  /** The "Need more time?" prompt shown in the hold's final EXTEND_PROMPT_MS. */
  private buildExtendPrompt(): void {
    const el = document.createElement('div');
    el.className = 'sl-extend';
    el.setAttribute('role', 'status');
    el.innerHTML =
      `<span class="sl-extend-txt" data-ref="extendTxt"></span>` +
      `<button type="button" class="sl-extend-btn" data-ref="extendBtn"></button>`;
    (this.regions['bottom-center'] ?? this.els.map).appendChild(el);
    this.extendEl = el;
    this.els.extendTxt = el.querySelector('[data-ref="extendTxt"]') as HTMLElement;
    this.els.extendBtn = el.querySelector('[data-ref="extendBtn"]') as HTMLElement;
    this.els.extendBtn.textContent = 'Add time';
    this.els.extendBtn.addEventListener('click', () => void this.handleExtend());
  }

  /** Success overlay + onBooked fire when the held seats settle to booked. */
  private buildBookedOverlay(): void {
    const el = document.createElement('div');
    el.className = 'sl-booked';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      `<div class="sl-booked-badge"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></div>` +
      `<div class="sl-booked-title">You're all set</div>` +
      `<div class="sl-booked-sub" data-ref="bookedSub"></div>`;
    this.root!.appendChild(el);
    this.bookedEl = el;
    this.els.bookedSub = el.querySelector('[data-ref="bookedSub"]') as HTMLElement;
  }

  // ---- Feature 6: chrome anchor regions -------------------------------------

  /**
   * Create the positioned flex containers that own every persistent map overlay.
   * Appended once after controller.render(); each chrome piece is then appended
   * INTO its region and flows within it, so nothing free-floats over anything
   * else. Regions carve the map into non-overlapping zones (top strip split into
   * left/center/right, left rail, and the three used corners).
   */
  private buildRegions(): void {
    if (!this.els.map) return;
    const REGIONS = ['top-left', 'top-center', 'top-right', 'left-rail', 'bottom-left', 'bottom-center', 'bottom-right'];
    for (const region of REGIONS) {
      const el = document.createElement('div');
      el.className = 'sl-anchor';
      el.dataset.region = region;
      this.els.map.appendChild(el);
      this.regions[region] = el;
    }
  }

  // ---- F3 minimap -----------------------------------------------------------

  /** Read a resolved --sl-* token value (canvas needs a real color, not var()). */
  private cssVar(name: string): string {
    return this.root ? getComputedStyle(this.root).getPropertyValue(name).trim() : '';
  }

  /** Motion is progressive enhancement; all state remains legible when reduced. */
  private reducedMotion(): boolean {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private scheduleMotion(fn: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.motionTimers.delete(timer);
      if (!this.destroyed) fn();
    }, delay);
    this.motionTimers.add(timer);
  }

  /** Restart one finite CSS animation without leaving a permanent state class. */
  private animateOnce(el: HTMLElement | undefined, className: string, duration = 600): void {
    if (!el || this.reducedMotion()) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    this.scheduleMotion(() => el.classList.remove(className), duration);
  }

  /** Selection feedback belongs on the selected seat, not across the whole map. */
  private flashPickedSeat(id: string): void {
    if (this.reducedMotion()) return;
    this.controller.flashSeat(id, this.cssVar('--sl-accent') || '#f4b740');
  }

  /** A completed hold gets one short map ripple per concrete seat. */
  private flashHeldSeats(hold: HoldResult): void {
    if (this.reducedMotion()) return;
    const labels = (hold.items ?? []).filter((item) => item.objectType !== 'ga').map((item) => item.label);
    labels.slice(0, 10).forEach((label, index) => {
      const seat = this.controller.seatByLabel(label);
      if (!seat) return;
      this.scheduleMotion(
        () => this.controller.flashSeat(seat.id, this.cssVar('--sl-accent') || '#f4b740'),
        index * 55,
      );
    });
  }

  /** Update only the action affordance; selection callbacks must not refire. */
  private committedSelection(): PickerSeat[] {
    const candidateId = this.confirmSeat?.id;
    return this.controller.getSelection().filter((seat) => seat.id !== candidateId);
  }

  private pendingSelectionCount(): number {
    const heldItems = this.hold?.items ?? [];
    const heldLabels = new Set(heldItems.map((item) => item.label));
    const pendingSeats = this.committedSelection().filter((seat) => !heldLabels.has(seat.label)).length;
    return pendingSeats + this.pendingGACount();
  }

  private heldGACounts(): Map<string, number> {
    const heldGA = new Map<string, number>();
    for (const item of (this.hold?.items ?? []).filter((candidate) => candidate.objectType === 'ga')) {
      heldGA.set(item.objectId, (heldGA.get(item.objectId) ?? 0) + (item.quantity ?? 1));
    }
    return heldGA;
  }

  private pendingGACount(): number {
    const heldGA = this.heldGACounts();
    return [...this.gaQty.entries()].reduce(
      (sum, [areaId, qty]) => sum + Math.max(0, qty - (heldGA.get(areaId) ?? 0)),
      0,
    );
  }

  private heldTicketCount(): number {
    return (this.hold?.items ?? []).reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  }

  private totalTicketCount(): number {
    const heldLabels = new Set((this.hold?.items ?? []).map((item) => item.label));
    const freshSeats = this.committedSelection().filter((seat) => !heldLabels.has(seat.label)).length;
    return this.heldTicketCount() + freshSeats + this.pendingGACount();
  }

  /** Held tickets and standing quantities consume the same order-wide cap. */
  private updateSelectionCapacity(): void {
    const heldLabels = new Set((this.hold?.items ?? []).map((item) => item.label));
    const selectedHeld = this.committedSelection().filter((seat) => heldLabels.has(seat.label)).length;
    const remaining = Math.max(0, this.maxTickets - this.heldTicketCount() - this.pendingGACount());
    this.controller.setMaxSelection(selectedHeld + remaining);
  }

  private canAddTicket(): boolean {
    if (this.totalTicketCount() < this.maxTickets) return true;
    this.toast(`You can select up to ${this.maxTickets} tickets for this order.`, 'warning');
    return false;
  }

  private pendingGATotal(gaAreas: ReturnType<PickerController['getGAAreas']>): number {
    const heldGA = new Map<string, number>();
    for (const item of (this.hold?.items ?? []).filter((candidate) => candidate.objectType === 'ga')) {
      heldGA.set(item.objectId, (heldGA.get(item.objectId) ?? 0) + (item.quantity ?? 1));
    }
    return gaAreas.reduce(
      (sum, area) => sum + this.paidPrice(area.categoryKey, null, area.price) * Math.max(0, (this.gaQty.get(area.id) ?? 0) - (heldGA.get(area.id) ?? 0)),
      0,
    );
  }

  private syncCta(count = this.lastTrayCount, pending = this.pendingSelectionCount()): void {
    const cta = this.els.cta as HTMLButtonElement | undefined;
    if (!cta) return;
    if (this.confirmSeat) {
      cta.disabled = true;
      cta.textContent = 'Confirm or cancel this seat';
      return;
    }
    if (this.ctaPhase === 'holding') {
      cta.disabled = true;
      cta.innerHTML = '<span class="sl-cta-spin" aria-hidden="true"></span>Securing seats…';
      return;
    }
    if (this.ctaPhase === 'checkout') {
      cta.disabled = true;
      cta.innerHTML = '<span class="sl-cta-spin" aria-hidden="true"></span>Opening checkout…';
      return;
    }
    cta.disabled = count === 0;
    cta.textContent = this.hold
      ? pending
        ? `Secure ${pending} more & checkout`
        : 'Continue to checkout'
      : count
        ? 'Hold seats & checkout'
        : 'Select seats';
  }

  private setCtaPhase(phase: 'idle' | 'holding' | 'checkout'): void {
    this.ctaPhase = phase;
    this.syncCta();
    if (phase === 'checkout') {
      this.scheduleMotion(() => {
        if (this.ctaPhase !== 'checkout') return;
        this.ctaPhase = 'idle';
        this.syncCta();
      }, 1100);
    }
  }

  /** Session-scoped capability key: isolated by API origin and event. */
  private holdStorageKey(): string {
    return `@seatlayer/hold/v1/${encodeURIComponent(this.apiBase)}/${encodeURIComponent(this.opts.event)}`;
  }

  private rememberedHoldId(): string | null {
    if (this.opts.initialHoldId) return this.opts.initialHoldId;
    if (this.opts.restoreHold === false || typeof window === 'undefined') return null;
    try {
      return window.sessionStorage.getItem(this.holdStorageKey());
    } catch {
      return null;
    }
  }

  private rememberHold(hold: HoldResult): void {
    if (this.opts.restoreHold === false || typeof window === 'undefined') return;
    try {
      // Persist only the opaque capability. Labels, prices and expiry are
      // always reloaded from the authoritative server projection.
      window.sessionStorage.setItem(this.holdStorageKey(), hold.holdId);
    } catch {
      // Storage can be unavailable in privacy/sandboxed embeds; the live picker
      // remains fully functional for the current mount.
    }
  }

  private forgetHold(): void {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.removeItem(this.holdStorageKey());
    } catch {
      // Best-effort cleanup only.
    }
  }

  private async resumeHoldFromServer(holdId: string, automatic: boolean): Promise<HoldResult | null> {
    try {
      const h = await this.controller.resumeHold(holdId);
      if (!h) return null;
      const restored: HoldResult = {
        holdId: h.holdId,
        expiresAt: h.expiresAt,
        seats: h.seats,
        items: h.items,
      };
      this.hold = restored;
      // A resumed capability came from an earlier checkout handoff. Keep it
      // alive if this picker mount is refreshed or torn down before the buyer
      // explicitly removes/releases it.
      this.handedOff = true;
      this.bookedShown = false;
      this.ctaPhase = 'idle';
      this.startHoldTimer(restored.expiresAt);
      this.rememberHold(restored);
      this.syncTray();
      this.emitHoldChange();
      this.opts.onHoldRestored?.(restored, restored.seats ?? [], this.buildHandoff(restored));
      if (automatic) this.toast('Your held tickets have been restored.', 'success');
      return restored;
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 404 || status === 409) {
        // A stale/foreign/settled capability is expected recovery state, not a
        // picker failure. Drop it and let the buyer choose again.
        this.forgetHold();
      } else {
        this.opts.onError?.(error);
      }
      return null;
    }
  }

  private async restoreRememberedHold(): Promise<void> {
    const holdId = this.rememberedHoldId();
    if (holdId) await this.resumeHoldFromServer(holdId, true);
  }

  /** Section-bearing objects on the active floor (single-floor → doc.objects). */
  private activeFloorObjects(): SectionLike[] {
    const doc = this.controller.doc;
    if (!doc) return [];
    const floors = doc.floors;
    if (floors?.length) {
      const id = this.controller.getActiveFloorId();
      return ((floors.find((f) => f.id === id) ?? floors[0]).objects as unknown as SectionLike[]) ?? [];
    }
    return (doc.objects as unknown as SectionLike[]) ?? [];
  }

  /**
   * Build the overview minimap: a static venue thumbnail (section outlines, or
   * seat dots when the chart has no sections) with the live viewport rectangle
   * drawn on top. The rect tracks pan/zoom via the constructor's onViewChange.
   */
  private buildMinimap(): void {
    const vp = this.controller.getViewport();
    if (!vp || !this.els.map) return;
    const b = vp.bounds;
    if (!(b.width > 0 && b.height > 0)) return;

    const MAXW = 158;
    const MAXH = 118;
    const PAD = 6;
    const aspect = b.width / Math.max(1, b.height);
    let w = MAXW;
    let h = Math.round(MAXW / aspect);
    if (h > MAXH) {
      h = MAXH;
      w = Math.round(MAXH * aspect);
    }
    w = Math.max(64, w);
    h = Math.max(48, h);
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const wrap = document.createElement('div');
    wrap.className = 'sl-minimap';
    wrap.setAttribute('aria-hidden', 'true'); // decorative; the map itself is the keyboard surface
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    wrap.appendChild(canvas);
    (this.regions['bottom-left'] ?? this.els.map).appendChild(wrap);
    this.miniCanvas = canvas;

    // world → minimap (device px), contain + centre — matches thumb.ts.
    const scale = Math.min((w - PAD * 2) / Math.max(1, b.width), (h - PAD * 2) / Math.max(1, b.height)) * dpr;
    const offX = (w * dpr - b.width * scale) / 2 - b.x * scale;
    const offY = (h * dpr - b.height * scale) / 2 - b.y * scale;
    this.miniTf = { scale, offX, offY, dpr };

    const base = document.createElement('canvas');
    base.width = canvas.width;
    base.height = canvas.height;
    this.miniBase = base;

    // Click a section on the minimap → glide the camera into it (existing API).
    wrap.addEventListener('click', (e) => this.minimapJump(e));

    this.drawMinimapStatic();
    this.drawMinimapRect();
  }

  /** Repaint the static overview + rect (floor switch, live open/close). */
  private refreshMinimap(): void {
    if (!this.miniBase) return;
    this.drawMinimapStatic();
    this.drawMinimapRect();
  }

  /** Paint the venue overview into the offscreen base canvas. */
  private drawMinimapStatic(): void {
    const base = this.miniBase;
    const tf = this.miniTf;
    const doc = this.controller.doc;
    if (!base || !tf || !doc) return;
    const ctx = base.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, base.width, base.height);
    const fx = (x: number): number => x * tf.scale + tf.offX;
    const fy = (y: number): number => y * tf.scale + tf.offY;
    const line = this.cssVar('--sl-line') || 'rgba(139,147,167,.5)';
    const muted = this.cssVar('--sl-muted') || '#8b93a7';
    const accent = this.cssVar('--sl-accent') || '#6e7bff';
    const zoneColor = new Map((doc.zones ?? []).map((z) => [z.id, z.color] as const));

    let drewSection = false;
    for (const o of this.activeFloorObjects()) {
      if (o.type !== 'section' || !o.outline || o.outline.length < 3) continue;
      drewSection = true;
      const closed = this.controller.isSectionClosed(o.id);
      const fill = closed ? muted : o.color ?? (o.zone && zoneColor.get(o.zone)) ?? accent;
      ctx.beginPath();
      o.outline.forEach((p, i) => (i === 0 ? ctx.moveTo(fx(p.x), fy(p.y)) : ctx.lineTo(fx(p.x), fy(p.y))));
      ctx.closePath();
      ctx.globalAlpha = closed ? 0.26 : 0.42;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1, tf.dpr);
      ctx.strokeStyle = line;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Section-less charts: fall back to faint category-colored seat dots.
    if (!drewSection) {
      const r = Math.max(1, tf.dpr);
      for (const seat of expandChart(doc)) {
        const cat = doc.categories.find((c) => c.key === seat.categoryKey);
        ctx.fillStyle = cat?.color ?? accent;
        ctx.beginPath();
        ctx.arc(fx(seat.x), fy(seat.y), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Blit the base overview, then stroke the current viewport rectangle on top. */
  private drawMinimapRect(): void {
    const canvas = this.miniCanvas;
    const base = this.miniBase;
    const tf = this.miniTf;
    if (!canvas || !base || !tf) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    const vp = this.controller.getViewport();
    if (!vp) return;
    const v = vp.visible;
    const x = v.x * tf.scale + tf.offX;
    const y = v.y * tf.scale + tf.offY;
    const w = v.width * tf.scale;
    const h = v.height * tf.scale;
    const accent = this.cssVar('--sl-accent') || '#f4b740';
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(1.5, tf.dpr * 1.5);
    ctx.strokeStyle = accent;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  /** Minimap click → focus the section under the point (or overview on a miss). */
  private minimapJump(e: MouseEvent): void {
    const canvas = this.miniCanvas;
    const tf = this.miniTf;
    if (!canvas || !tf) return;
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * (canvas.width / r.width);
    const py = (e.clientY - r.top) * (canvas.height / r.height);
    const wx = (px - tf.offX) / tf.scale;
    const wy = (py - tf.offY) / tf.scale;
    for (const o of this.activeFloorObjects()) {
      if (o.type !== 'section' || !o.outline || o.outline.length < 3) continue;
      if (this.controller.isSectionClosed(o.id)) continue;
      if (pointInPolygon(wx, wy, o.outline)) {
        this.controller.focusSection(o.id);
        return;
      }
    }
    this.controller.overview();
  }

  // ---- F4 price-band filter -------------------------------------------------

  /** Effective display price of a category: host pricing override → first tier → base. */
  private catPrice(c: { key?: string; price?: number; tiers?: { id?: string; price: number }[] }): number | undefined {
    const chart = c.tiers?.length ? c.tiers[0].price : c.price;
    if (chart === undefined || !c.key) return chart;
    return this.paidPrice(c.key, c.tiers?.[0]?.id ?? null, chart);
  }

  /** Derive price bands: one chip per distinct price (≤5), else quantile ranges. */
  private priceBands(): PriceBand[] {
    const doc = this.controller.doc;
    if (!doc) return [];
    const priced = doc.categories
      .map((c) => ({ key: c.key, price: this.catPrice(c) }))
      .filter((x): x is { key: string; price: number } => x.price != null);
    if (!priced.length) return [];
    const distinct = [...new Set(priced.map((p) => p.price))].sort((a, b) => a - b);
    if (distinct.length <= 5) {
      return distinct.map((price) => ({
        id: `p${price}`,
        label: this.money(price),
        keys: priced.filter((p) => p.price === price).map((p) => p.key),
        min: price,
        max: price,
      }));
    }
    // Many distinct prices → ~4 contiguous quantile bands (ranges).
    const chunk = Math.ceil(distinct.length / 4);
    const bands: PriceBand[] = [];
    for (let i = 0; i < distinct.length; i += chunk) {
      const slice = distinct.slice(i, i + chunk);
      const lo = slice[0];
      const hi = slice[slice.length - 1];
      bands.push({
        id: `b${i}`,
        label: lo === hi ? this.money(lo) : `${this.money(lo)}–${this.money(hi)}`,
        keys: priced.filter((p) => p.price >= lo && p.price <= hi).map((p) => p.key),
        min: lo,
        max: hi,
      });
    }
    return bands;
  }

  /** Build the compact price selector in the panel header. Choosing a band both
   *  filters availability and smoothly frames the matching seats on the map. */
  private buildPriceFilter(): void {
    if (!this.els.prices || !this.els.pricesSec) return;
    const bands = this.priceBands();
    if (bands.length < 2) return;
    const select = document.createElement('select');
    select.className = 'sl-price-select';
    select.setAttribute('aria-label', 'Filter and focus seats by price');
    select.innerHTML = `<option value="all">All prices</option>` + bands
      .map((band) => `<option value="${band.id}">${band.label}</option>`)
      .join('');
    this.els.pricesSec.appendChild(select);
    select.addEventListener('change', () => {
      const band = bands.find((candidate) => candidate.id === select.value);
      const keys = band?.keys ?? null;
      this.priceBandKeys = keys ? new Set(keys) : null;
      this.controller.setCategoryFilter(keys);
      this.controller.focusCategoryFilter(keys);
      // Reflect the band in the legend rows + any open section card.
      this.syncPrices();
      if (this.lastSection) this.showSectionCard(this.lastSection);
    });
  }

  // ---- arena / multi-floor chrome -------------------------------------------

  /** Build the rung pills (charts with sections) and floor switcher (>1 floor). */
  private buildArenaChrome(): void {
    const doc = this.controller.doc;
    if (!doc || !this.els.map) return;
    const hasSections = doc.objects.some((o) => o.type === 'section')
      || (doc.floors ?? []).some((f) => f.objects.some((o) => o.type === 'section'));

    // LOD rung pills — jump straight between zones / sections / seats.
    if (hasSections) {
      const RUNGS: LodRung[] = ['zones', 'sections', 'seats'];
      const pills = document.createElement('div');
      pills.className = 'sl-rungs on';
      pills.setAttribute('role', 'group');
      pills.setAttribute('aria-label', t('picker.zoomLevel'));
      const LABEL: Record<LodRung, string> = {
        zones: t('picker.rungLabel.zones'),
        sections: t('picker.rungLabel.sections'),
        seats: t('picker.rungLabel.seats'),
      };
      const TIP: Record<LodRung, string> = {
        zones: t('picker.rungTip.zones'),
        sections: t('picker.rungTip.sections'),
        seats: t('picker.rungTip.seats'),
      };
      pills.innerHTML = RUNGS.map(
        (r) => `<button type="button" data-rung="${r}" title="${TIP[r]}" aria-pressed="false">${LABEL[r]}</button>`,
      ).join('');
      pills.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const rung = btn.dataset.rung as LodRung;
          this.controller.setRung(rung);
          if (rung === 'seats') this.collapseSectionCard();
        });
      });
      this.regions['top-center'].appendChild(pills);
      this.rungsEl = pills;
      this.syncRung();
    }

    // Multi-floor switcher — only when the chart truly has >1 floor.
    if (this.controller.isMultiFloor()) {
      const floors = this.controller.getFloors();
      const rail = document.createElement('div');
      rail.className = 'sl-floors on';
      rail.setAttribute('role', 'group');
      rail.setAttribute('aria-label', t('picker.floor'));
      rail.innerHTML = floors
        .map((f) => `<button type="button" data-floor="${f.id}">${f.name}</button>`)
        .join('');
      rail.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.controller.setFloor(btn.dataset.floor!);
          this.showSectionCard(null);
          this.syncFloors();
          this.syncRung();
          this.refreshMinimap();
        });
      });
      this.regions['left-rail'].appendChild(rail);
      this.floorsEl = rail;
      this.syncFloors();
    }
  }

  /** Reflect the engine's current LOD rung onto the pill group. */
  private syncRung(): void {
    if (!this.rungsEl) return;
    const active = this.controller.getRung();
    this.rungsEl.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      const on = btn.dataset.rung === active;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  /** Reflect the active floor onto the switcher rail. */
  private syncFloors(): void {
    if (!this.floorsEl) return;
    const active = this.controller.getActiveFloorId();
    this.floorsEl.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.floor === active);
    });
  }

  /** Show (or clear, on null) the tapped-section summary card. */
  private showSectionCard(summary: SectionSummary | null): void {
    this.lastSection = summary;
    this.secCardEl?.remove();
    this.secCardEl = null;
    if (!summary) return;
    // At seat level the summary is context, not a blocking decision surface.
    // Keep it as the compact pill from the first seat-level paint.
    this.secCardCollapsed = this.controller.getRung() === 'seats';
    this.secCardShownAt = Date.now();
    this.renderSectionCard(summary);
  }

  /**
   * Render the section card in the form the layout + state want: expanded card
   * or slim pill in the top-center anchor region (wide), or a compact strip in
   * the sheet head (narrow). Never floats over the seats at the tap point.
   */
  private renderSectionCard(summary: SectionSummary): void {
    if (!this.els.map) return;
    this.secCardEl?.remove();
    // min/max over the section's categories at the price the buyer will PAY
    // (host pricing override aware) — not the chart's stored range.
    const paid = summary.categories.length
      ? summary.categories.map((c) => this.paidPrice(c.key, null, c.price))
      : [summary.priceMin, summary.priceMax];
    const paidMin = Math.min(...paid);
    const paidMax = Math.max(...paid);
    const priceLabel =
      paidMin === paidMax
        ? this.money(paidMin)
        : `${this.money(paidMin)}–${this.money(paidMax)}`;
    const leftLabel = tCount('picker.seatsLeftInSection', summary.seatsLeft);
    const xBtn = `<button type="button" class="sl-seccard-x" aria-label="${t('picker.closeSectionSummary')}">✕</button>`;
    const card = document.createElement('div');
    const narrow = this.root?.dataset.layout === 'narrow';

    if (narrow) {
      // Compact strip inside the bottom sheet's peek head — never over the map.
      card.className = 'sl-seccard strip on';
      card.setAttribute('role', 'status');
      card.innerHTML =
        `<span class="sl-seccard-dot" style="background:${summary.color}"></span>` +
        `<span class="sl-seccard-name">${summary.label}</span>` +
        `<span class="sl-seccard-left">${leftLabel}</span>` +
        (summary.categories.length ? `<span class="sl-seccard-price">${priceLabel}</span>` : '') +
        xBtn;
      card.querySelector('.sl-seccard-x')!.addEventListener('click', () => this.controller.overview());
      (this.els.sheetHead ?? this.els.side ?? this.els.map).appendChild(card);
    } else if (this.secCardCollapsed) {
      // Slim pill — seat-picking has begun. Tap to re-expand; ✕ still closes.
      card.className = 'sl-seccard mini on';
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', t('picker.sectionSummaryAria', { label: summary.label }));
      card.innerHTML =
        `<span class="sl-seccard-dot" style="background:${summary.color}"></span>` +
        `<span class="sl-seccard-name">${summary.label}</span>` +
        `<span class="sl-seccard-left">${leftLabel}</span>` +
        xBtn;
      card.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.sl-seccard-x')) return;
        this.secCardCollapsed = false;
        this.secCardShownAt = Date.now();
        this.renderSectionCard(summary);
      });
      card.querySelector('.sl-seccard-x')!.addEventListener('click', () => this.controller.overview());
      (this.regions['top-center'] ?? this.els.map).appendChild(card);
    } else {
      card.className = 'sl-seccard on';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', t('picker.sectionSummaryAria', { label: summary.label }));
      const mix = summary.categories
        .map((c) => {
          const dim = this.priceBandKeys != null && !this.priceBandKeys.has(c.key);
          return (
            `<span class="sl-seccard-mix-item${dim ? ' sl-dim' : ''}"><span class="sl-seccard-mix-dot" style="background:${c.color}"></span>` +
            `${c.label} <span class="sl-seccard-mix-price">${this.money(this.paidPrice(c.key, null, c.price))}</span></span>`
          );
        })
        .join('');
      card.innerHTML =
        `<div class="sl-seccard-head"><span class="sl-seccard-dot" style="background:${summary.color}"></span>` +
        `<span class="sl-seccard-name">${summary.label}</span>` +
        (summary.categories.length ? `<span class="sl-seccard-price">${priceLabel}</span>` : '') +
        xBtn + `</div>` +
        `<div class="sl-seccard-zone">${summary.zoneLabel ? `${summary.zoneLabel} · ` : ''}` +
        `<span class="sl-seccard-left">${leftLabel}</span></div>` +
        (mix ? `<div class="sl-seccard-mix">${mix}</div>` : '') +
        `<div class="sl-seccard-foot">` +
        `<button type="button" class="sl-seccard-overview">← ${t('picker.overview')}</button>` +
        `<span class="sl-seccard-hint">${t('picker.tapSeatHint')}</span></div>`;
      card.querySelector('.sl-seccard-x')!.addEventListener('click', () => this.controller.overview());
      card.querySelector('.sl-seccard-overview')!.addEventListener('click', () => this.controller.overview());
      (this.regions['top-center'] ?? this.els.map).appendChild(card);
    }
    this.secCardEl = card;
  }

  /** Collapse the expanded card to its slim pill (seat-picking started). */
  private collapseSectionCard(): void {
    if (!this.secCardEl || this.secCardCollapsed || !this.lastSection) return;
    if (this.root?.dataset.layout === 'narrow') return; // strip is already compact
    this.secCardCollapsed = true;
    this.renderSectionCard(this.lastSection);
  }

  /**
   * onViewChange hook for the card. The focus glide's own settle (within the
   * grace window) enforces the ~25% coverage rule with the FINAL viewport; any
   * later pan/zoom means seat-picking has begun → collapse to the pill.
   */
  private sectionCardOnView(): void {
    if (!this.secCardEl || this.secCardCollapsed || !this.lastSection) return;
    if (this.root?.dataset.layout === 'narrow') return;
    if (this.controller.getRung() === 'seats') {
      this.collapseSectionCard();
      return;
    }
    if (Date.now() - this.secCardShownAt < 1400) {
      if (this.sectionCardCoverage() > 0.25) this.collapseSectionCard();
      return;
    }
    this.collapseSectionCard();
  }

  /** Fraction of the focused section's on-screen bbox covered by the card. */
  private sectionCardCoverage(): number {
    const card = this.secCardEl;
    const sec = this.lastSection;
    if (!card || !sec || !this.els.map) return 0;
    const outline = this.activeFloorObjects().find((o) => o.type === 'section' && o.id === sec.id)?.outline;
    if (!outline || outline.length < 3) return 0;
    const pts = outline.map((p) => this.controller.worldToScreen(p));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const bx = Math.min(...xs);
    const by = Math.min(...ys);
    const bw = Math.max(...xs) - bx;
    const bh = Math.max(...ys) - by;
    if (bw <= 0 || bh <= 0) return 0;
    const mapR = this.els.map.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const cx = cr.left - mapR.left;
    const cy = cr.top - mapR.top;
    const ox = Math.max(0, Math.min(cx + cr.width, bx + bw) - Math.max(cx, bx));
    const oy = Math.max(0, Math.min(cy + cr.height, by + bh) - Math.max(cy, by));
    return (ox * oy) / (bw * bh);
  }

  /** aria-live readout when keyboard focus lands on a seat. */
  private announceSeat(seat: ExpandedSeat | null): void {
    if (!this.srEl) return;
    if (!seat) {
      this.srEl.textContent = '';
      return;
    }
    const cat = this.controller.doc?.categories.find((c) => c.key === seat.categoryKey);
    const status = this.controller.getStatus(seat.id) ?? 'free';
    const statusText = status === 'free' ? 'available' : status === 'held' ? 'on hold' : 'taken';
    const price = cat ? this.catPrice(cat) : undefined;
    this.srEl.textContent = `Seat ${seat.label}, ${cat?.label ?? seat.categoryKey}${
      price != null ? `, ${this.money(price)}` : ''
    }, ${statusText}`;
  }

  // ---- seat candidate confirmation ------------------------------------------

  private showConfirm(seat: ExpandedSeat): void {
    const previousId = this.confirmSeat?.id;
    this.confirmEl?.remove();
    this.confirmEl = null;
    this.confirmSeat = seat;
    this.root?.setAttribute('data-confirming', 'true');
    this.controller.setSelectionFocus(seat.id);
    if (previousId && previousId !== seat.id) this.controller.deselect([previousId]);
    if (this.tipEl) this.tipEl.style.display = 'none';
    const details = this.controller.seatDetails(seat.id);
    const cat = this.controller.doc?.categories.find((c) => c.key === seat.categoryKey);
    const chartPrice = details?.price ?? (cat?.tiers?.length ? cat.tiers[0].price : cat?.price);
    const price = chartPrice != null
      ? this.paidPrice(seat.categoryKey, details?.tierId ?? cat?.tiers?.[0]?.id ?? null, chartPrice)
      : undefined;
    const safe = (value: unknown): string => String(value ?? '—').replace(/[&<>"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[char]!);
    const el = document.createElement('div');
    el.className = 'sl-confirm';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', `Confirm seat ${seat.label}`);
    el.style.setProperty('--sl-cat', cat?.color ?? '#6e7bff');
    el.innerHTML =
      `<div class="sl-confirm-grid">` +
      `<div class="sl-confirm-field"><span class="sl-confirm-key">Section</span><span class="sl-confirm-value">${safe(details?.sectionLabel)}</span></div>` +
      `<div class="sl-confirm-field"><span class="sl-confirm-key">Row</span><span class="sl-confirm-value">${safe(details?.rowLabel)}</span></div>` +
      `<div class="sl-confirm-field"><span class="sl-confirm-key">Seat</span><span class="sl-confirm-value">${safe(details?.seatNumber ?? seat.label)}</span></div>` +
      `</div>` +
      `<div class="sl-confirm-cat"><span class="sl-dot" style="background:${cat?.color ?? '#6e7bff'}"></span>` +
      `<span class="sl-confirm-cat-name">${safe(details?.categoryLabel ?? cat?.label ?? seat.categoryKey)}</span>` +
      (price != null ? `<span class="sl-confirm-price">${this.money(price)}</span>` : '') + `</div>` +
      `<div class="sl-confirm-body">` +
      (this.seatViewEnabled()
        ? `<button type="button" class="sl-confirm-view">` +
          `<svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>` +
          `${t('picker.open360')}</button>`
        : '') +
      `<div class="sl-confirm-row">` +
      `<button type="button" class="sl-confirm-cancel">Cancel</button>` +
      `<button type="button" class="sl-confirm-add"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4 4L19 7"/></svg>Select</button></div></div>`;
    this.els.map.appendChild(el);
    this.confirmEl = el;
    this.reanchorConfirm();
    el.querySelector('.sl-confirm-view')?.addEventListener('click', () => this.openSeatView(seat));
    el.querySelector('.sl-confirm-add')!.addEventListener('click', () => this.commitConfirm());
    el.querySelector('.sl-confirm-cancel')!.addEventListener('click', () => this.cancelConfirm());
    requestAnimationFrame(() => el.querySelector<HTMLButtonElement>('.sl-confirm-add')?.focus());
  }

  private reanchorConfirm(): void {
    if (!this.confirmEl || !this.confirmSeat) return;
    const p = this.controller.worldToScreen({ x: this.confirmSeat.x, y: this.confirmSeat.y });
    if (this.root?.dataset.layout === 'narrow') return;
    const mapWidth = this.els.map.clientWidth;
    const mapHeight = this.els.map.clientHeight;
    const cardWidth = this.confirmEl.offsetWidth || 276;
    const cardHeight = this.confirmEl.offsetHeight || 230;
    const half = cardWidth / 2 + 12;
    const x = Math.max(half, Math.min(mapWidth - half, p.x));
    const belowFits = p.y + cardHeight + 24 <= mapHeight;
    const placeBelow = p.y < cardHeight + 24 && belowFits;
    this.confirmEl.dataset.placement = placeBelow ? 'below' : 'above';
    this.confirmEl.style.left = `${x}px`;
    this.confirmEl.style.top = `${Math.max(8, Math.min(mapHeight - 8, p.y))}px`;
  }

  private dismissConfirm(): void {
    this.confirmEl?.remove();
    this.confirmEl = null;
    this.confirmSeat = null;
    this.root?.removeAttribute('data-confirming');
    this.controller.setSelectionFocus(null);
  }

  private commitConfirm(): void {
    if (!this.confirmSeat) return;
    this.dismissConfirm();
    this.collapseSectionCard();
    this.syncTray();
  }

  private cancelConfirm(): void {
    const seat = this.confirmSeat;
    if (!seat) return;
    this.controller.deselect([seat.id]);
    if (this.confirmSeat) this.dismissConfirm();
    this.root?.focus({ preventScroll: true });
  }

  private closeConfirm(): void {
    this.dismissConfirm();
  }

  // ---- 360° view-from-seat modal --------------------------------------------

  private seatViewEnabled(): boolean {
    return this.opts.seatView !== false;
  }

  /** Every bookable seat (cached) — neighbor heads for the generated panorama. */
  private allSeats(): ExpandedSeat[] {
    if (!this.allSeatsCache) {
      const doc = this.controller.doc;
      this.allSeatsCache = doc ? expandChart(doc) : [];
    }
    return this.allSeatsCache;
  }

  /**
   * Open the drag-to-look-around 360° preview for a seat. Uses the organizer's
   * uploaded photo (seat.viewUrl) when present, else a panorama generated from
   * the chart geometry — the stage placed at this seat's true bearing + size.
   * Zero extra dependencies: an equirectangular image panned with `repeat-x`.
   */
  private openSeatView(seat: ExpandedSeat): void {
    if (!this.root || !this.seatViewEnabled()) return;
    this.closeSeatView();

    const doc = this.controller.doc;
    const activeId = this.controller.getActiveFloorId();
    const focal = doc?.floors?.find((f) => f.id === activeId)?.focalPoint ?? doc?.focalPoint ?? { x: 0, y: 0 };
    let panoUrl: string;
    let caption: string;
    let real = false;
    if (seat.viewUrl) {
      panoUrl = seat.viewUrl;
      caption = t('picker.panorama360');
      real = true;
    } else {
      const pano = generateSeatPanorama(seat, focal, this.allSeats());
      panoUrl = pano.url;
      caption = t('picker.illustrationCaption', { m: pano.distanceM });
    }

    const el = document.createElement('div');
    el.className = 'sl-view';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('picker.viewFromSeat', { label: seat.label }));
    el.innerHTML =
      `<div class="sl-view-head">` +
      `<span class="sl-view-title">${t('picker.viewFromSeat', { label: seat.label })}</span>` +
      `<span class="sl-view-cap">${caption}</span>` +
      `<button type="button" class="sl-view-x" aria-label="Close">` +
      `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>` +
      `<div class="sl-view-pano">` +
      `<span class="sl-view-badge">${real ? t('picker.real360') : t('picker.preview')}</span>` +
      `<span class="sl-view-hint">Drag to look around · scroll to zoom</span>` +
      `</div>`;
    this.root.appendChild(el);
    this.viewEl = el;

    const pano = el.querySelector<HTMLDivElement>('.sl-view-pano')!;
    pano.style.backgroundImage = `url("${panoUrl}")`;

    // Equirectangular pan: repeat-x gives seamless 360° horizontal wrap; the
    // image is sized taller than the viewport so there's headroom to tilt.
    let zoom = 1.2;
    let posX = 0;
    let posY = 0;
    const apply = (): void => {
      const h = pano.clientHeight || 1;
      const bgH = h * zoom;
      const overV = Math.max(0, bgH - h);
      posY = Math.min(overV / 2, Math.max(-overV / 2, posY));
      pano.style.backgroundSize = `auto ${bgH}px`;
      pano.style.backgroundPosition = `${posX}px ${posY + overV / 2}px`;
    };
    apply();

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent): void => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      pano.classList.add('drag');
      pano.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      posX += e.clientX - lastX;
      posY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    };
    const onUp = (e: PointerEvent): void => {
      dragging = false;
      pano.classList.remove('drag');
      pano.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoom = Math.min(2.4, Math.max(1, zoom + (e.deltaY < 0 ? 0.12 : -0.12)));
      apply();
    };
    pano.addEventListener('pointerdown', onDown);
    pano.addEventListener('pointermove', onMove);
    pano.addEventListener('pointerup', onUp);
    pano.addEventListener('pointercancel', onUp);
    pano.addEventListener('wheel', onWheel, { passive: false });

    const closeBtn = el.querySelector<HTMLButtonElement>('.sl-view-x')!;
    closeBtn.addEventListener('click', () => this.closeSeatView());
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closeSeatView();
      }
    };
    el.addEventListener('keydown', onKey);
    closeBtn.focus();

    this.viewCleanup = () => {
      pano.removeEventListener('pointerdown', onDown);
      pano.removeEventListener('pointermove', onMove);
      pano.removeEventListener('pointerup', onUp);
      pano.removeEventListener('pointercancel', onUp);
      pano.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
    };
  }

  private closeSeatView(): void {
    this.viewCleanup?.();
    this.viewCleanup = null;
    this.viewEl?.remove();
    this.viewEl = null;
  }

  // ---- chrome sync ----------------------------------------------------------

  private money(n: number): string {
    const formatter = this.opts.pricing?.formatter;
    if (formatter) return formatter(n, this.currency);
    try {
      return new Intl.NumberFormat(this.opts.locale, { style: 'currency', currency: this.currency }).format(n);
    } catch {
      return `${n} ${this.currency}`;
    }
  }

  /**
   * The price the buyer will actually pay for a category (+tier): the host's
   * `pricing` override when present, else the chart's stored price. Every
   * price the widget DISPLAYS or hands off must flow through here — a map
   * that shows one price while checkout charges another destroys trust.
   */
  private paidPrice(categoryKey: string | undefined, tierId: string | null | undefined, fallback: number): number {
    const entry = categoryKey ? this.opts.pricing?.prices?.[categoryKey] : undefined;
    if (entry === undefined) return fallback;
    if (typeof entry === 'number') return entry;
    if (tierId && entry.tiers?.[tierId] !== undefined) return entry.tiers[tierId];
    return entry.base ?? fallback;
  }

  private syncPrices(): void {
    const doc = this.controller.doc;
    if (!doc || !this.els.prices) return;
    const left = this.controller.categoryAvailability();
    this.narrateAvailability(doc.categories, left);
    this.els.prices.innerHTML = doc.categories
      .map((c) => {
        const price = this.catPrice(c);
        const dim = this.priceBandKeys != null && !this.priceBandKeys.has(c.key);
        return (
          `<div class="sl-price-row${dim ? ' sl-dim' : ''}" data-cat="${c.key}"><span class="sl-dot" style="background:${c.color}"></span>` +
          `<span class="sl-price-label">${c.label}</span>` +
          `<span class="sl-price-left">${left[c.key] ?? 0} left</span>` +
          (price != null ? `<span class="sl-price-amt">${this.money(price)}</span>` : '') +
          `</div>`
        );
      })
      .join('') +
      `<div class="sl-status-key" aria-label="Seat status legend">` +
      `<span class="sl-status-item"><i class="sl-status-icon" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>` +
      `</i>Temporarily held</span>` +
      `<span class="sl-status-item"><i class="sl-status-icon sold" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24"><path d="M7 17L17 7"/></svg>` +
      `</i>Sold</span>` +
      `</div>`;
    // Legend-hover highlight: dim other categories on the map while hovering a row.
    this.els.prices.querySelectorAll<HTMLElement>('.sl-price-row').forEach((row) => {
      row.addEventListener('mouseenter', () => this.controller.getRenderer()?.setCategoryHighlight?.(row.dataset.cat ?? null));
      row.addEventListener('mouseleave', () => this.controller.getRenderer()?.setCategoryHighlight?.(null));
    });
  }

  /**
   * Live-activity strip: turn WS availability deltas into one quiet line of
   * social proof ("2 seats just taken in VIP · 118 left"). Diffs per-category
   * counts on every status change — no per-seat payload needed. Skips the very
   * first computation (initial load is not "activity").
   */
  private narrateAvailability(
    categories: Array<{ key: string; label: string }>,
    left: Record<string, number>,
  ): void {
    const textEl = this.els.liveText;
    const prev = this.lastCatAvail;
    this.lastCatAvail = { ...left };
    if (!textEl || !prev) return;
    for (const cat of categories) {
      const before = prev[cat.key];
      const now = left[cat.key] ?? 0;
      if (before === undefined || now >= before) continue;
      const taken = before - now;
      textEl.textContent = `${taken} seat${taken === 1 ? '' : 's'} just taken in ${cat.label} · ${now} left`;
      return;
    }
  }
  private lastCatAvail: Record<string, number> | null = null;

  /** A live delta took one of OUR selected (not yet held) seats — evict + tell the buyer. */
  private evictTakenSelections(): void {
    // Our own hold's WS echo paints our seats 'held' — never treat those as sniped.
    const ownLabels = new Set<string>([
      ...(this.controller.currentHold()?.labels ?? []),
      ...this.holdingLabels,
    ]);
    const gone = this.controller
      .getSelection()
      .filter((s) => !ownLabels.has(s.label) && (this.controller.getStatus(s.id) ?? 'free') !== 'free');
    if (!gone.length) return;
    this.controller.deselect(gone.map((s) => s.id));
    this.toast(`Seat ${gone[0].label} was just taken by another buyer.`, 'error');
  }

  private syncTray(): void {
    if (!this.els.tray) return;
    this.updateSelectionCapacity();
    const seats = this.committedSelection();
    const gaAreas = this.controller.getGAAreas();
    const heldItems = this.hold?.items ?? [];
    const parts: string[] = [];
    const nextTrayKeys = new Set<string>();

    if (!seats.length && !heldItems.length && !gaAreas.length) {
      parts.push(`<div class="sl-tray-hint">Tap a seat on the map, or let us pick the best available for you.</div>`);
    } else if (!seats.length && !heldItems.length) {
      parts.push(`<div class="sl-tray-hint">Tap a seat on the map — or grab standing tickets below.</div>`);
    }

    // Best available comes before manual choices: it is the fastest path for
    // buyers who care about sitting together more than inspecting every dot.
    if (!this.hold) {
      const cats = this.controller.doc?.categories ?? [];
      parts.push(this.bestAvailableConfirm
        ? `<div class="sl-ba" role="alert">` +
          `<div class="sl-ba-title"><span class="spark" aria-hidden="true">✦</span>Replace your current choices?</div>` +
          `<div class="sl-ba-replace"><b>We’ll find ${this.baQty} seats together.</b>` +
          `<span>Your manually selected tickets will be removed only after a new group is secured.</span></div>` +
          `<div class="sl-ba-actions"><button type="button" data-ba-cancel>Keep mine</button>` +
          `<button type="button" class="replace" data-ba-replace>Find new seats</button></div></div>`
        : `<div class="sl-ba">` +
          `<div class="sl-ba-title"><span class="spark" aria-hidden="true">✦</span>Find the best seats together</div>` +
          `<div class="sl-ba-copy"><span class="wide">We’ll choose the closest available group for you.</span>` +
          `<span class="narrow">Closest available group, chosen instantly.</span></div>` +
          (cats.length > 1
            ? `<select aria-label="Preferred ticket type" data-ba-cat>` +
              `<option value="">Any ticket type</option>` +
              cats.map((c) => `<option value="${c.key}"${this.baCat === c.key ? ' selected' : ''}>${c.label}</option>`).join('') +
              `</select>`
            : `<span aria-hidden="true"></span>`) +
          `<div class="sl-ba-qty">` +
          `<button type="button" data-ba="-1" aria-label="Fewer seats">−</button><span>${this.baQty}</span>` +
          `<button type="button" data-ba="1" aria-label="More seats">+</button></div>` +
          `<button type="button" class="sl-ba-go"${this.bestAvailableBusy ? ' disabled' : ''}>` +
          (this.bestAvailableBusy
            ? `<span class="sl-ba-spin" aria-hidden="true"></span>Finding the best seats…`
            : `Find ${this.baQty} best ${this.baQty === 1 ? 'seat' : 'seats'}`) +
          `</button></div>`);
    }

    // Held line items (best-available, completed, or restored). Tier is
    // server-committed, but each item can be released without discarding the
    // rest of the hold.
    // Ticket-card identity grid: SECTION | ROW | SEAT, echoing the confirm
    // popover so the buyer meets the same identity pattern at confirm and in
    // the cart. Falls back to the raw label when spatial context is missing
    // (GA lines, legacy labels).
    const idGrid = (seatId: string | null, label: string): string => {
      const d = seatId ? this.controller.seatDetails(seatId) : null;
      if (!d?.sectionLabel && !d?.rowLabel && !d?.seatNumber) {
        return `<div class="sl-chip-id"><span class="fld sec"><span class="sl-chip-eb">Seat</span><span class="val">${label}</span></span></div>`;
      }
      return (
        `<div class="sl-chip-id">` +
        `<span class="fld sec"><span class="sl-chip-eb">Section</span><span class="val">${d.sectionLabel ?? '—'}</span></span>` +
        (d.rowLabel ? `<span class="fld mid"><span class="sl-chip-eb">Row</span><span class="val">${d.rowLabel}</span></span>` : '') +
        (d.seatNumber ? `<span class="fld mid"><span class="sl-chip-eb">Seat</span><span class="val">${d.seatNumber}</span></span>` : '') +
        `</div>`
      );
    };
    // Right icon rail per the canonical mock: remove on top, seat view below.
    const iconRail = (rmAria: string, viewLabel: string | null): string =>
      `<div class="sl-chip-rail">` +
      `<button type="button" class="rm" aria-label="${rmAria}">` +
      `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` +
      (viewLabel
        ? `<button type="button" class="view" data-view-label="${viewLabel}" aria-label="${t('picker.viewFromSeat', { label: viewLabel })}">` +
          `<svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>`
        : '') +
      `</div>`;

    for (const item of heldItems) {
      const itemKey = `held:${item.label}`;
      nextTrayKeys.add(itemKey);
      const cat = this.controller.doc?.categories.find((c) => c.key === item.categoryKey);
      const tierName = item.tierId ? cat?.tiers?.find((ti) => ti.id === item.tierId)?.name : undefined;
      const heldSeat = item.objectType !== 'ga' ? this.controller.seatByLabel(item.label) : null;
      const canView = this.seatViewEnabled() && !!heldSeat;
      parts.push(
        `<div class="sl-chip sl-held${this.lastTrayKeys.has(itemKey) ? '' : ' sl-enter'}" data-key="${itemKey}" data-held="${encodeURIComponent(item.label)}"${heldSeat ? ` data-locate="${heldSeat.id}"` : ''}>` +
          `<div class="sl-chip-main">` +
          idGrid(heldSeat?.id ?? null, item.label) +
          `<div class="sl-chip-sub">` +
          `<span class="sl-ticket-state held" aria-label="Held for you" title="Held for you">` +
          `<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>` +
          `<span class="cat">${cat?.label ?? item.categoryKey}${tierName ? ` · ${tierName}` : ''}</span>` +
          `<span class="amt">${this.money(this.paidPrice(item.categoryKey, item.tierId, item.unitPrice) * (item.quantity ?? 1))}</span>` +
          `</div></div>` +
          iconRail(`Remove held ticket ${item.label}`, canView ? item.label : null) +
          `</div>`,
      );
    }

    const heldLabels = new Set(heldItems.map((item) => item.label));
    const canView = this.seatViewEnabled();
    for (const s of seats.filter((seat) => !heldLabels.has(seat.label))) {
      const itemKey = `seat:${s.id}`;
      nextTrayKeys.add(itemKey);
      const cat = this.controller.doc?.categories.find((c) => c.key === s.categoryKey);
      const tierSelect =
        s.tiers && s.tiers.length
          ? `<select class="tier" data-tier="${s.id}" aria-label="${t('picker.ticketTierFor', { label: s.label })}">` +
            s.tiers
              .map((ti) => `<option value="${ti.id}"${ti.id === s.tierId ? ' selected' : ''}>${ti.name} · ${this.money(this.paidPrice(s.categoryKey, ti.id, ti.price))}</option>`)
              .join('') +
            `</select>`
          : '';
      parts.push(
        `<div class="sl-chip${this.lastTrayKeys.has(itemKey) ? '' : ' sl-enter'}" data-key="${itemKey}" data-seat="${s.id}" data-locate="${s.id}">` +
          `<div class="sl-chip-main">` +
          idGrid(s.id, s.label) +
          `<div class="sl-chip-sub">` +
          `<span class="sl-ticket-state" aria-label="Selected" title="Selected">` +
          `<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/></svg></span>` +
          `<span class="cat">${cat?.label ?? s.categoryKey}</span>${tierSelect}` +
          `<span class="amt">${this.money(this.paidPrice(s.categoryKey, s.tierId ?? null, s.price))}</span>` +
          `</div></div>` +
          iconRail(`Remove ${s.label}`, canView ? s.label : null) +
          `</div>`,
      );
    }

    for (const area of gaAreas) {
      const qty = this.gaQty.get(area.id) ?? 0;
      parts.push(
        `<div class="sl-ga" data-ga="${area.id}"><div class="sl-ga-info">` +
          `<div class="sl-ga-name">${area.label}</div>` +
          `<div class="sl-ga-sub">${this.money(this.paidPrice(area.categoryKey, null, area.price))} · ${area.available} left</div></div>` +
          `<div class="sl-ga-qty">` +
          `<button type="button" data-d="-1" aria-label="Fewer">−</button><span>${qty}</span>` +
          `<button type="button" data-d="1" aria-label="More">+</button></div></div>`,
      );
    }

    this.els.tray.innerHTML = parts.join('');
    this.lastTrayKeys = nextTrayKeys;
    this.els.tray.querySelectorAll<HTMLButtonElement>('[data-ba]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.baQty = Math.max(1, Math.min(this.maxTickets, this.baQty + Number(btn.dataset.ba)));
        this.syncTray();
      });
    });
    this.els.tray.querySelector<HTMLSelectElement>('[data-ba-cat]')?.addEventListener('change', (e) => {
      this.baCat = (e.target as HTMLSelectElement).value;
    });
    this.els.tray.querySelector<HTMLButtonElement>('.sl-ba-go')?.addEventListener('click', () => {
      if (this.pendingSelectionCount() > 0) {
        this.bestAvailableConfirm = true;
        this.syncTray();
        this.els.tray.querySelector<HTMLButtonElement>('[data-ba-replace]')?.focus();
        return;
      }
      void this.bestAvailable(this.baQty, this.baCat || undefined);
    });
    this.els.tray.querySelector<HTMLButtonElement>('[data-ba-cancel]')?.addEventListener('click', () => {
      this.bestAvailableConfirm = false;
      this.syncTray();
      this.els.tray.querySelector<HTMLButtonElement>('.sl-ba-go')?.focus();
    });
    this.els.tray.querySelector<HTMLButtonElement>('[data-ba-replace]')?.addEventListener('click', () => {
      this.bestAvailableConfirm = false;
      void this.bestAvailable(this.baQty, this.baCat || undefined);
    });
    this.els.tray.querySelectorAll<HTMLElement>('.sl-chip .rm').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chip = btn.closest('.sl-chip') as HTMLElement;
        if (chip.dataset.held) {
          void this.removeHeldLabel(decodeURIComponent(chip.dataset.held), chip);
          return;
        }
        const id = chip.dataset.seat!;
        const label = this.controller.getSelection().find((sel) => sel.id === id)?.label ?? 'Seat';
        const remove = (): void => {
          this.controller.deselect([id]);
          this.toast(`${label} removed.`, 'neutral', {
            label: 'Undo',
            onClick: () => {
              const restored = this.controller.select([id]);
              this.toast(
                restored.length ? `${label} restored.` : `${label} is no longer available.`,
                restored.length ? 'success' : 'warning',
              );
            },
          });
        };
        if (this.reducedMotion()) {
          remove();
          return;
        }
        chip.classList.add('sl-leave');
        this.scheduleMotion(remove, 150);
      });
    });
    // Per-seat ticket-tier pick (Adult/Child/…) — updates price via onSelectionChange.
    this.els.tray.querySelectorAll<HTMLSelectElement>('.sl-chip .tier').forEach((sel) => {
      sel.addEventListener('change', () => this.controller.setSeatTier(sel.dataset.tier!, sel.value || null));
    });
    // View-from-seat button (data-view-label = seat label) on fresh + held chips.
    this.els.tray.querySelectorAll<HTMLElement>('.sl-chip .view[data-view-label]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const seat = this.controller.seatByLabel(btn.dataset.viewLabel!);
        if (seat) this.openSeatView(seat);
      });
    });
    // Card ↔ map linkage: hovering (or keyboard-focusing) a ticket card pulses
    // its seat on the map so the buyer can locate what they picked.
    this.els.tray.querySelectorAll<HTMLElement>('.sl-chip[data-locate]').forEach((chip) => {
      const locate = (): void => this.controller.flashSeat(chip.dataset.locate!, this.cssVar('--sl-accent') || '#f4b740');
      chip.addEventListener('mouseenter', locate);
      chip.addEventListener('focusin', locate);
    });
    this.els.tray.querySelectorAll<HTMLElement>('.sl-ga button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const areaEl = btn.closest('.sl-ga') as HTMLElement;
        const id = areaEl.dataset.ga!;
        const area = gaAreas.find((a) => a.id === id);
        const delta = Number(btn.dataset.d);
        if (delta > 0 && !this.canAddTicket()) return;
        const next = Math.max(0, Math.min(area?.available ?? 0, (this.gaQty.get(id) ?? 0) + delta));
        this.gaQty.set(id, next);
        this.syncTray();
      });
    });

    // totals + CTA (held lines + fresh selections + GA)
    const gaTotal = this.pendingGATotal(gaAreas);
    const gaCount = this.pendingGACount();
    const heldTotal = heldItems.reduce((sum, item) => sum + this.paidPrice(item.categoryKey, item.tierId, item.unitPrice) * (item.quantity ?? 1), 0);
    const heldCount = heldItems.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
    const freshSeats = seats.filter((seat) => !heldLabels.has(seat.label));
    const total = freshSeats.reduce((sum, s) => sum + this.paidPrice(s.categoryKey, s.tierId ?? null, s.price), 0) + gaTotal + heldTotal;
    const count = freshSeats.length + gaCount + heldCount;
    const pendingCount = this.pendingSelectionCount();
    const previousCount = this.lastTrayCount;
    const previousTotal = this.lastTrayTotal;
    this.els.count.textContent = count
      ? `${count} ${count === 1 ? 'ticket' : 'tickets'}`
      : 'No seats selected';
    this.els.total.textContent = count ? this.money(total) : '';
    this.root?.setAttribute('data-has-selection', String(count > 0));
    this.els.foot?.classList.toggle('empty', count === 0);
    if (this.els.seatSummary) {
      this.els.seatSummary.textContent = count ? `${count} selected` : '';
    }
    this.syncCta(count, pendingCount);
    if (this.hold) {
      const securedCount = heldCount || this.hold.seats?.length || 0;
      if (this.els.holdTitle) {
        this.els.holdTitle.textContent = `${securedCount} secured`;
      }
      if (this.els.holdCopy) {
        this.els.holdCopy.textContent = pendingCount
          ? `${pendingCount} more selected`
          : 'Checkout timer running';
      }
      const change = this.els.holdChange as HTMLButtonElement | undefined;
      if (change) {
        change.disabled = this.releasingHold;
        change.textContent = this.releasingHold ? 'Releasing…' : 'Change';
      }
    }
    if (count !== previousCount) this.animateOnce(this.els.count, 'sl-value-pop', 380);
    if (total !== previousTotal) this.animateOnce(this.els.total, 'sl-value-pop', 380);
    if (previousCount === 0 && count > 0) this.animateOnce(this.els.cta, 'sl-ready', 520);

    // Mobile sheet: one-line peek summary. Selected → "N tickets · $X · Continue";
    // empty → "From $min · Best available". Tap (sheet head) expands the sheet.
    if (this.els.peek) {
      if (count) {
        // Sheet state is shown by the persistent chevron in the head; the pill is
        // the action affordance ("Continue"/"Review") — no inline text arrow.
        this.els.peek.innerHTML =
          `<span>${count} ${count === 1 ? 'ticket' : 'tickets'} · ${this.money(total)}</span>` +
          `<span class="go">${this.hold ? (pendingCount ? 'Secure more' : 'Continue') : 'Review'}</span>`;
      } else {
        const prices = (this.controller.doc?.categories ?? [])
          .map((c) => this.catPrice(c))
          .filter((p): p is number => p != null);
        this.els.peek.innerHTML =
          (prices.length ? `<span>From ${this.money(Math.min(...prices))}</span>` : '<span>Pick your seats</span>') +
          `<span class="go">✦ Best seats</span>`;
      }
    }
    // Keep the mobile map stable after selection. The persistent Review pill
    // exposes the updated count/total without covering the seat the buyer just
    // confirmed; opening the sheet remains an explicit tap or swipe.
    this.lastTrayCount = count;
    this.lastTrayTotal = total;

    this.opts.onSelectionChange?.(seats);
  }

  private async removeHeldLabel(label: string, chip?: HTMLElement): Promise<boolean> {
    if (!label || this.releasingLabels.has(label)) return false;
    this.releasingLabels.add(label);
    chip?.setAttribute('aria-busy', 'true');
    const button = chip?.querySelector<HTMLButtonElement>('.rm');
    if (button) button.disabled = true;
    try {
      const preserveAcrossNavigation = this.handedOff;
      const released = await this.controller.releaseLabels([label]);
      if (!released) {
        this.toast(`Couldn't remove ${label}. Your hold is unchanged.`, 'error');
        return false;
      }
      const remaining = this.controller.currentHold();
      this.hold = remaining
        ? { holdId: remaining.holdId, expiresAt: remaining.expiresAt, seats: remaining.seats, items: remaining.items }
        : null;
      this.handedOff = !!this.hold && preserveAcrossNavigation;
      this.bookedShown = false;
      this.ctaPhase = 'idle';
      if (this.hold) {
        this.startHoldTimer(this.hold.expiresAt);
      } else {
        this.stopHoldTimer();
        this.forgetHold();
      }
      this.syncTray();
      this.emitHoldChange();
      this.toast(`${label} removed from your hold.`, 'success');
      return true;
    } finally {
      this.releasingLabels.delete(label);
      chip?.removeAttribute('aria-busy');
      if (button?.isConnected) button.disabled = false;
    }
  }

  private async handleChangeSeats(): Promise<void> {
    if (!this.hold || this.releasingHold) return;
    this.releasingHold = true;
    const button = this.els.holdChange as HTMLButtonElement | undefined;
    if (button) {
      button.disabled = true;
      button.textContent = 'Releasing…';
    }
    try {
      await this.release();
      if (!this.hold) this.toast('Held tickets released. Choose your new seats.', 'success');
    } finally {
      this.releasingHold = false;
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = 'Change';
      }
    }
  }

  private async handleCta(): Promise<void> {
    if (this.totalTicketCount() > this.maxTickets) {
      this.toast(`Remove tickets until your order has ${this.maxTickets} or fewer.`, 'warning');
      return;
    }
    // Best-available (or a prior CTA press) already holds the seats — hand off.
    // Held seats are NOT in the client selection (the server holds them), so
    // pass the hold's own seat list to the host.
    const committed = this.committedSelection();
    if (this.hold && !committed.some((s) => !(this.hold!.items ?? []).some((i) => i.label === s.label))) {
      const seats = this.hold.seats ?? committed;
      this.handedOff = true;
      this.setCtaPhase('checkout');
      this.opts.onCheckout?.(this.hold, seats, this.buildHandoff(this.hold));
      return;
    }
    this.holdingLabels = new Set(committed.map((seat) => seat.label));
    this.setCtaPhase('holding');
    try {
      // seats first (controller.hold covers selected seats); GA quantities ride along
      let hold: HoldResult | null = null;
      const gaEntries = [...this.gaQty.entries()].filter(([, q]) => q > 0);
      // Snapshot before hold — the hold's own WS echo repaints these seats.
      const chosenSeats = this.committedSelection();
      if (chosenSeats.length) {
        const h = await this.controller.hold(undefined, this.opts.holdTtlMs);
        hold = h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
      }
      for (const [areaId, qty] of gaEntries) {
        const h = await this.controller.holdGA(areaId, qty, { ttlMs: this.opts.holdTtlMs });
        hold = h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : hold;
      }
      if (!hold) {
        this.toast('One or more seats were just taken. Please pick again.', 'error');
        this.setCtaPhase('idle');
        this.syncTray();
        return;
      }
      this.hold = hold;
      this.handedOff = true;
      this.startHoldTimer(hold.expiresAt);
      this.flashHeldSeats(hold);
      this.setCtaPhase('checkout');
      this.emitHoldChange();
      // The replacement hold can combine an earlier best-available set with
      // newly selected seats. Hand the host the complete held seat set; the
      // server-priced line items remain authoritative for GA and totals.
      this.opts.onCheckout?.(hold, hold.seats ?? chosenSeats, this.buildHandoff(hold));
    } catch (err) {
      this.opts.onError?.(err);
      const problem = err as { reason?: string; conflicts?: Array<{ label?: string }> };
      const labels = (problem.conflicts ?? []).map((conflict) => conflict.label).filter(Boolean).slice(0, 3);
      const message = problem.reason === 'event_closed'
        ? 'Seat sales have closed for this event.'
        : labels.length
          ? `${labels.join(', ')} ${labels.length === 1 ? 'is' : 'are'} no longer available. Choose another ${labels.length === 1 ? 'seat' : 'group'}.`
          : 'One or more seats were just taken. Please pick again.';
      this.toast(message, 'error');
      this.setCtaPhase('idle');
    } finally {
      this.holdingLabels.clear();
      if (this.ctaPhase === 'holding') this.ctaPhase = 'idle';
      this.syncTray();
    }
  }

  private startHoldTimer(expiresAt: number): void {
    this.stopHoldTimer();
    this.holdExpiresAt = expiresAt;
    if (this.hold) this.rememberHold(this.hold);
    const pill = this.els.hold;
    pill.innerHTML =
      '<span class="sl-hold-dot" aria-hidden="true"></span><span>Held</span><span class="sl-hold-time" data-ref="holdTime"></span>';
    const time = pill.querySelector<HTMLElement>('[data-ref="holdTime"]');
    this.els.holdNote?.classList.add('on');
    const tick = (): void => {
      const ms = Math.max(0, this.holdExpiresAt - Date.now());
      const m = Math.floor(ms / 60000);
      const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      if (time) time.textContent = `${m}:${s}`;
      pill.classList.add('on');
      pill.classList.toggle('is-expiring', ms > 0 && ms <= EXTEND_PROMPT_MS);
      // Offer an extension in the final stretch (but not once it's booked/expired).
      this.setExtendPrompt(ms > 0 && ms <= EXTEND_PROMPT_MS, ms);
      if (ms <= 0) this.stopHoldTimer();
    };
    tick();
    this.holdTimer = setInterval(tick, 500);
  }

  private stopHoldTimer(): void {
    if (this.holdTimer) clearInterval(this.holdTimer);
    this.holdTimer = null;
    this.els.hold?.classList.remove('on', 'is-expiring');
    this.els.holdNote?.classList.remove('on');
    this.setExtendPrompt(false, 0);
  }

  /** Show/refresh (or hide) the "Need more time?" prompt with the live seconds left. */
  private setExtendPrompt(show: boolean, ms: number): void {
    if (!this.extendEl) return;
    if (show && this.controller.currentHold() && !this.bookedShown) {
      const secs = Math.ceil(ms / 1000);
      this.els.extendTxt.innerHTML = `Your seats are held for <b>0:${String(secs).padStart(2, '0')}</b>. Need more time?`;
      this.extendEl.classList.add('on');
    } else {
      this.extendEl.classList.remove('on');
    }
  }

  private async handleExtend(): Promise<void> {
    const btn = this.els.extendBtn as HTMLButtonElement;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Adding…';
    try {
      const h = await this.controller.extendHold(this.opts.holdTtlMs);
      if (h) {
        // The controller re-armed its own expiry; sync ours + the pill, hide prompt.
        this.hold = { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items };
        this.holdExpiresAt = h.expiresAt;
        this.extendEl?.classList.remove('on');
        this.rememberHold(this.hold);
        this.emitHoldChange();
        this.toast('More time added — your seats are still held.', 'success');
      } else {
        this.toast("Couldn't add more time — please head to checkout now.", 'warning');
      }
    } catch (err) {
      this.opts.onError?.(err);
      this.toast("Couldn't add more time — please head to checkout now.", 'warning');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  /**
   * Fire the booked-confirmation state once the buyer's held seats settle to
   * booked. The controller clears its own hold the moment every held label reads
   * 'booked' over the realtime channel (clearBookedHoldIfSettled), and this runs
   * on the same onStatusChange — so `currentHold() === null` while we still hold
   * a checkout handoff means "sold", not expired (expiry clears via onHoldExpired
   * on a different path, which nulls this.hold first).
   */
  private detectBooked(): void {
    if (this.bookedShown || !this.handedOff || !this.hold) return;
    if (this.controller.currentHold() !== null) return; // hold still open
    this.showBooked();
  }

  private showBooked(): void {
    if (this.bookedShown || !this.hold) return;
    this.bookedShown = true;
    const handoff = this.buildHandoff(this.hold);
    this.stopHoldTimer();
    this.forgetHold();
    const n = handoff.lineItems.reduce((sum, i) => sum + i.quantity, 0);
    if (this.els.bookedSub) {
      this.els.bookedSub.innerHTML =
        `<span class="sl-booked-seats">${n} ${n === 1 ? 'ticket' : 'tickets'}</span> confirmed. ` +
        `A confirmation is on its way.`;
    }
    this.bookedEl?.classList.add('on');
    this.opts.onBooked?.(handoff);
  }

  /** Assemble the stable {@link CheckoutHandoff} from a hold's server line items. */
  private buildHandoff(hold: HoldResult): CheckoutHandoff {
    const items = hold.items ?? [];
    // Host `pricing` overrides win in the handoff too — the host gets back the
    // prices it will actually charge, so map display and order total agree.
    const lineItems: CheckoutLineItem[] = items.map((it: HoldLineItem) => ({
      label: it.label,
      objectId: it.objectId,
      objectType: it.objectType,
      categoryKey: it.categoryKey,
      tierId: it.tierId,
      unitPrice: this.paidPrice(it.categoryKey, it.tierId, it.unitPrice),
      currency: it.currency ?? this.currency,
      quantity: it.quantity ?? 1,
    }));
    const currency = lineItems[0]?.currency ?? this.currency;
    const total = lineItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    return { holdId: hold.holdId, expiresAt: hold.expiresAt, currency, lineItems, total };
  }

  private emitHoldChange(): void {
    const hold = this.hold;
    this.opts.onHoldChange?.(
      hold,
      hold?.seats ?? [],
      hold ? this.buildHandoff(hold) : null,
    );
  }

  private toast(
    msg: string,
    tone: 'neutral' | 'success' | 'warning' | 'error' = 'neutral',
    action?: { label: string; onClick: () => void },
  ): void {
    const el = this.els.toast;
    if (!el) return;
    el.replaceChildren();
    const copy = document.createElement('span');
    copy.textContent = msg;
    el.appendChild(copy);
    el.classList.toggle('has-action', !!action);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sl-toast-action';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick, { once: true });
      el.appendChild(button);
    }
    el.dataset.tone = tone;
    el.classList.add('on');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.classList.remove('on');
      el.classList.remove('has-action');
      el.dataset.tone = 'neutral';
    }, 4200);
  }

  private placeTooltip(): void {
    if (!this.tipEl) return;
    const hw = this.els.map.clientWidth;
    const tw = this.tipEl.offsetWidth;
    const th = this.tipEl.offsetHeight;
    let x = this.tipPos.x + 14;
    let y = this.tipPos.y - th - 12;
    if (x + tw > hw - 8) x = this.tipPos.x - tw - 14;
    if (y < 8) y = this.tipPos.y + 18;
    this.tipEl.style.left = `${Math.max(8, x)}px`;
    this.tipEl.style.top = `${Math.max(8, y)}px`;
  }

  private updateTooltip(details: SeatHoverDetails | null): void {
    if (!this.tipEl) return;
    if (!details) {
      this.tipEl.style.display = 'none';
      return;
    }
    const statusLine =
      details.status === 'free'
        ? ''
        : `<div style="margin-top:5px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:700">${
            details.status === 'held' ? t('map.statusHeld') : t('map.statusTaken')
          }</div>`;
    const location = [
      details.sectionLabel ? `Section ${details.sectionLabel}` : '',
      details.rowLabel ? `Row ${details.rowLabel}` : '',
      details.seatNumber ? `Seat ${details.seatNumber}` : details.label,
    ].filter(Boolean).join(' · ');
    this.tipEl.innerHTML =
      `<div style="font-weight:800;font-size:13px">${location}</div>` +
      `<div style="display:flex;align-items:center;gap:6px;margin-top:4px">` +
      `<span style="width:9px;height:9px;border-radius:50%;flex:none;background:${details.categoryColor}"></span>` +
      `<span style="opacity:.75">${details.categoryLabel}</span>` +
      `<span style="margin-left:auto;font-weight:800">${this.money(this.paidPrice(details.categoryKey, details.tierId ?? null, details.price))}</span></div>` +
      statusLine;
    this.tipEl.style.display = 'block';
    this.placeTooltip();
  }

  // ---- public conveniences ----------------------------------------------------

  getSelection(): PickerSeat[] {
    return this.committedSelection();
  }

  /** Current active/restored hold reflected in the tray. */
  getCurrentHold(): HoldResult | null {
    return this.hold;
  }

  /** Explicit host-driven hold restore (automatic session restore is on by default). */
  async resumeHold(holdId: string): Promise<HoldResult | null> {
    return this.resumeHoldFromServer(holdId, false);
  }

  /** Remove one server-held ticket while keeping the rest of the hold active. */
  async removeHeldTicket(label: string): Promise<boolean> {
    return this.removeHeldLabel(label);
  }

  async bestAvailable(qty: number, categoryKey?: string): Promise<HoldResult | null> {
    if (this.bestAvailableBusy) return null;
    qty = Math.max(1, Math.min(this.maxTickets, Math.floor(qty)));
    if (this.confirmSeat) this.cancelConfirm();
    this.bestAvailableConfirm = false;
    this.bestAvailableBusy = true;
    const button = this.els.tray?.querySelector<HTMLButtonElement>('.sl-ba-go');
    if (button) {
      button.disabled = true;
      button.innerHTML = '<span class="sl-ba-spin" aria-hidden="true"></span>Finding…';
    }
    try {
      const h = await this.controller.bestAvailable(qty, categoryKey);
      if (h) {
        this.hold = { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items };
        this.handedOff = false;
        this.bookedShown = false;
        this.gaQty.clear();
        this.startHoldTimer(h.expiresAt);
        this.flashHeldSeats(this.hold);
        this.syncTray();
        this.emitHoldChange();
        return this.hold;
      }
      return null;
    } catch (err) {
      this.opts.onError?.(err);
      const reason = (err as { reason?: string })?.reason;
      const message = reason === 'not_enough_together'
        ? `We couldn't find ${qty} seats together. Try fewer seats or another ticket type.`
        : reason === 'sold_out'
          ? 'That ticket type is sold out. Try another ticket type.'
          : reason === 'event_closed'
            ? 'Seat sales have closed for this event.'
            : 'Those seats are no longer available. Try another quantity or ticket type.';
      this.toast(message, 'error');
      return null;
    } finally {
      this.bestAvailableBusy = false;
      this.syncTray();
    }
  }

  async release(): Promise<void> {
    const tracked = this.hold;
    const controllerHold = this.controller.currentHold();
    let released = true;
    if (controllerHold) {
      released = await this.controller.release();
    } else if (tracked) {
      // The live controller can legitimately settle/clear its local hold before
      // the shell finishes dismissing. The shell still owns the server handoff,
      // so release from that authoritative copy instead of silently no-oping.
      const labels = [...new Set([
        ...(tracked.items ?? []).map((item) => item.label),
        ...(tracked.seats ?? []).map((seat) => seat.label),
      ])];
      if (labels.length) {
        try {
          await this.api.release(this.opts.event, labels, tracked.holdId);
        } catch (error) {
          this.opts.onError?.(error);
          released = false;
        }
      }
    }
    if (!released) {
      this.toast("Couldn't release your tickets. Your hold is unchanged.", 'error');
      return;
    }
    this.hold = null;
    this.forgetHold();
    this.handedOff = false;
    this.bookedShown = false;
    this.ctaPhase = 'idle';
    this.stopHoldTimer();
    this.gaQty.clear();
    this.syncTray();
    this.emitHoldChange();
  }

  destroy(): void {
    this.destroyed = true;
    // Closing/tearing down before checkout means the buyer abandoned any
    // best-available hold. Release it server-side; a handed-off checkout keeps
    // its hold alive across the host's route transition.
    if (this.hold && !this.handedOff) void this.controller.release();
    this.closeConfirm();
    this.closeSeatView();
    this.stopHoldTimer();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    for (const timer of this.motionTimers) clearTimeout(timer);
    this.motionTimers.clear();
    this.ro?.disconnect();
    this.ro = null;
    if (this.escHandler) document.removeEventListener('keydown', this.escHandler);
    this.controller.destroy();
    this.root?.remove();
    this.root = null;
    if (this.modalScrim) {
      this.modalScrim.remove();
      this.modalScrim = null;
      (this.prevFocus as HTMLElement | null)?.focus?.();
    }
  }
}
