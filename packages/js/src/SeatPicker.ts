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
  loadLocale,
  setStringOverrides,
  t,
  type AccessibilityType,
  type ChartTheme,
  type ExpandedSeat,
  type PickerSeat,
  type SeatHoverDetails,
} from '@seatlayer/core';
import { PubApi, type HoldResult } from './api';
import type { GAAreaAvailability } from './SeatingChart';

const DEFAULT_API_BASE = 'https://api.seatlayer.io';
const DEFAULT_MAX_SELECTION = 10;

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
  /** Hold TTL in ms passed to hold(); server clamps to its own limits. */
  holdTtlMs?: number;
  /**
   * Confirm mode: tapping a seat shows an anchored popover (seat · category ·
   * price · Add/Cancel) instead of adding straight to the tray. Default false.
   */
  confirmSelection?: boolean;
  /**
   * Buyer pressed the CTA and the hold succeeded — hand off to YOUR checkout.
   * The hold carries holdId, expiresAt, seat labels and priced line items.
   */
  onCheckout?: (hold: HoldResult, seats: PickerSeat[]) => void;
  /** Selection changed (tap or best-available). */
  onSelectionChange?: (seats: PickerSeat[]) => void;
  /** The open hold expired server-side (widget already reset itself). */
  onHoldExpired?: () => void;
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
  background:var(--sl-accent);color:var(--sl-accent-ink);font-weight:700;font-size:12px;font-variant-numeric:tabular-nums}
.sl-hold-pill.on{display:inline-flex}
.sl-close{width:32px;height:32px;border-radius:999px;flex:none;display:none;align-items:center;justify-content:center;
  border:1px solid var(--sl-line);color:var(--sl-muted);transition:color .15s,border-color .15s}
.sl-close:hover{color:var(--sl-text);border-color:var(--sl-muted)}
.sl-close.on{display:inline-flex}
.sl-close svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round}

/* body */
.sl-body{display:flex;flex:1;min-height:0}
.sl-map{position:relative;flex:1;min-width:0}
.sl-map-host{position:absolute;inset:0}
.sl-side{width:300px;flex:none;border-left:1px solid var(--sl-line);display:flex;flex-direction:column;min-height:0;overflow-y:auto}

/* narrow (container < 640px): side panel becomes a bottom sheet */
.sl-picker[data-layout="narrow"] .sl-body{flex-direction:column}
.sl-picker[data-layout="narrow"] .sl-map{min-height:0;flex:1}
.sl-picker[data-layout="narrow"] .sl-side{width:100%;max-height:46%;border-left:0;border-top:1px solid var(--sl-line)}
.sl-picker[data-layout="narrow"] .sl-tray{flex:none}
.sl-picker[data-layout="narrow"] .sl-foot{position:sticky;bottom:0;background:var(--sl-bg)}

/* price panel */
.sl-sec{padding:14px 16px 4px;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--sl-muted);font-weight:700}
.sl-prices{padding:4px 16px 10px;border-bottom:1px solid var(--sl-line)}
.sl-price-row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px}
.sl-dot{width:9px;height:9px;border-radius:50%;flex:none}
.sl-price-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.sl-price-left{font-size:11px;color:var(--sl-muted);font-variant-numeric:tabular-nums}
.sl-price-amt{font-weight:800;font-variant-numeric:tabular-nums}

/* tray */
.sl-tray{flex:1;padding:10px 16px;display:flex;flex-direction:column;gap:8px;min-height:0}
.sl-tray-hint{font-size:12.5px;color:var(--sl-muted);line-height:1.5}
.sl-chip{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--sl-line);
  border-radius:var(--sl-r-sm);background:var(--sl-surface);font-size:13px}
.sl-chip b{font-weight:800}
.sl-chip .cat{color:var(--sl-muted);font-size:11.5px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sl-chip .amt{font-weight:700;font-variant-numeric:tabular-nums}
.sl-chip .rm{width:22px;height:22px;border-radius:999px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--sl-muted)}
.sl-chip .rm:hover{color:var(--sl-text)}
.sl-chip .rm svg{width:11px;height:11px;stroke:currentColor;stroke-width:2.4;fill:none;stroke-linecap:round}

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
.sl-foot{padding:12px 16px 14px;border-top:1px solid var(--sl-line);flex:none}
.sl-total{display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:10px}
.sl-total b{font-size:17px;font-variant-numeric:tabular-nums}
.sl-cta{width:100%;padding:13px;border-radius:var(--sl-r-sm);font-weight:800;font-size:14px;
  background:var(--sl-accent);color:var(--sl-accent-ink);transition:filter .15s,opacity .15s}
.sl-cta:hover{filter:brightness(1.08)}
.sl-cta:disabled{opacity:.45;cursor:not-allowed}

/* zoom column */
.sl-zoom{position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;gap:6px;z-index:5}
.sl-zoom button{width:36px;height:36px;border-radius:999px;background:var(--sl-surface);border:1px solid var(--sl-line);
  color:var(--sl-text);font-size:17px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:border-color .15s}
.sl-zoom button:hover{border-color:var(--sl-muted)}
.sl-zoom svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}

/* toast + boot states */
.sl-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%) translateY(6px);z-index:8;max-width:88%;
  background:var(--sl-surface);border:1px solid var(--sl-line);color:var(--sl-text);border-radius:999px;padding:9px 16px;
  font-size:12.5px;font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.sl-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
.sl-boot{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;background:var(--sl-bg);font-size:13px;font-weight:600;color:var(--sl-muted)}
.sl-boot-spin{width:24px;height:24px;border-radius:50%;border:3px solid var(--sl-line);border-top-color:var(--sl-accent);
  animation:slspin .8s linear infinite}
@keyframes slspin{to{transform:rotate(360deg)}}
.sl-boot-title{font-weight:800;font-size:15px;color:var(--sl-text)}
.sl-boot-retry{margin-top:4px;padding:9px 20px;border-radius:var(--sl-r-sm);background:var(--sl-accent);
  color:var(--sl-accent-ink);font-weight:700;font-size:13px}

/* a11y filter chips (over the map, top-left) */
.sl-chips{position:absolute;top:12px;left:12px;z-index:5;display:flex;gap:6px;flex-wrap:wrap;max-width:70%}
.sl-chip-f{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;font-size:12px;font-weight:700;
  background:var(--sl-surface);border:1px solid var(--sl-line);color:var(--sl-muted);transition:color .15s,border-color .15s}
.sl-chip-f:hover{color:var(--sl-text)}
.sl-chip-f.on{background:var(--sl-accent);color:var(--sl-accent-ink);border-color:transparent}

/* confirm popover */
.sl-confirm{position:absolute;z-index:9;min-width:190px;background:var(--sl-surface);border:1px solid var(--sl-line);
  border-radius:12px;padding:12px;box-shadow:0 18px 50px -18px rgba(0,0,0,.7);transform:translate(-50%,calc(-100% - 14px))}
.sl-confirm-label{font-weight:800;font-size:14px}
.sl-confirm-meta{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--sl-muted);margin-top:4px}
.sl-confirm-meta b{color:var(--sl-text);margin-left:auto}
.sl-confirm-row{display:flex;gap:8px;margin-top:10px}
.sl-confirm-row button{flex:1;padding:8px;border-radius:8px;font-weight:700;font-size:12.5px}
.sl-confirm-add{background:var(--sl-accent);color:var(--sl-accent-ink)}
.sl-confirm-cancel{border:1px solid var(--sl-line);color:var(--sl-muted)}
.sl-confirm-cancel:hover{color:var(--sl-text)}

/* best-available row */
.sl-ba{display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--sl-line);border-radius:var(--sl-r-sm)}
.sl-ba select{background:var(--sl-surface);color:var(--sl-text);border:1px solid var(--sl-line);border-radius:7px;
  font:inherit;font-size:12px;padding:5px 6px;max-width:110px}
.sl-ba-qty{display:flex;align-items:center;gap:7px}
.sl-ba-qty button{width:24px;height:24px;border-radius:999px;background:var(--sl-surface);border:1px solid var(--sl-line);
  font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center}
.sl-ba-qty span{min-width:14px;text-align:center;font-weight:800}
.sl-ba-go{margin-left:auto;padding:7px 12px;border-radius:999px;border:1px solid var(--sl-line);font-weight:700;font-size:12px;transition:border-color .15s}
.sl-ba-go:hover{border-color:var(--sl-muted)}

/* screen-reader live region */
.sl-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

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
  private readonly controller: PickerController;

  private root: HTMLDivElement | null = null;
  private mapHost: HTMLDivElement | null = null;
  private rendered = false;
  private destroyed = false;

  // chrome refs
  private els: Record<string, HTMLElement> = {};
  private ro: ResizeObserver | null = null;
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // state
  private currency = 'USD';
  private hold: HoldResult | null = null;
  private gaQty = new Map<string, number>();
  private tipEl: HTMLDivElement | null = null;
  private tipPos = { x: 0, y: 0 };
  private confirmEl: HTMLDivElement | null = null;
  private confirmSeat: ExpandedSeat | null = null;
  private srEl: HTMLDivElement | null = null;
  private a11yFilter: AccessibilityType | 'all' = 'all';
  private baQty = 2;
  private baCat = '';

  // modal plumbing (set by open())
  private modalScrim: HTMLElement | null = null;
  private prevFocus: Element | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

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
    const close = (): void => {
      document.body.style.overflow = prevOverflow;
      picker.destroy();
      options.onClose?.();
    };
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) close();
    });
    picker.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
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
    this.opts = options;
    const api = new PubApi((options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''));
    this.controller = new PickerController({
      transport: api,
      eventKey: options.event,
      maxSelection: options.maxSelection ?? DEFAULT_MAX_SELECTION,
      currency: options.currency,
      flashOnLiveChange: true,
      colorblindSafe: options.colorblindSafe,
      onSelectionChange: () => this.syncTray(),
      onStatusChange: () => {
        this.syncPrices();
        this.evictTakenSelections();
      },
      onHoldExpired: () => {
        this.hold = null;
        this.stopHoldTimer();
        this.gaQty.clear();
        this.toast(t('picker.holdExpired', undefined) || 'Your hold expired — seats released. Pick again.');
        this.syncTray();
        this.opts.onHoldExpired?.();
      },
      confirmSelection: options.confirmSelection,
      onSelect: (seat) => {
        if (this.opts.confirmSelection) this.showConfirm(seat);
      },
      onViewChange: () => this.reanchorConfirm(),
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
    this.root = root;
    mount.appendChild(root);

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
          <div class="sl-zoom">
            <button type="button" aria-label="Zoom in" data-ref="zin">+</button>
            <button type="button" aria-label="Zoom out" data-ref="zout">−</button>
            <button type="button" aria-label="Fit to screen" data-ref="zfit">
              <svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            </button>
          </div>
          <div class="sl-boot" data-ref="boot"><span class="sl-boot-spin"></span>Loading seat map…</div>
          <div class="sl-toast" data-ref="toast" role="status" aria-live="polite"></div>
        </div>
        <div class="sl-side">
          <div class="sl-sec" data-ref="pricesSec">Prices</div>
          <div class="sl-prices" data-ref="prices"></div>
          <div class="sl-sec">Your seats</div>
          <div class="sl-tray" data-ref="tray"></div>
          <div class="sl-foot">
            <div class="sl-total"><span data-ref="count"></span><b data-ref="total"></b></div>
            <button type="button" class="sl-cta" data-ref="cta" disabled></button>
          </div>
        </div>
      </div>`;
    root.querySelectorAll<HTMLElement>('[data-ref]').forEach((el) => {
      this.els[el.dataset.ref!] = el;
    });
    this.mapHost = this.els.map as HTMLDivElement;

    // container-adaptive layout
    this.ro = new ResizeObserver(() => {
      const w = root.clientWidth;
      root.dataset.layout = w < 640 ? 'narrow' : 'wide';
    });
    this.ro.observe(root);

    // zoom + tooltip wiring
    this.els.zin.addEventListener('click', () => this.controller.zoomIn());
    this.els.zout.addEventListener('click', () => this.controller.zoomOut());
    this.els.zfit.addEventListener('click', () => this.controller.zoomToFit());
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
      this.els.map.appendChild(chips);
      chips.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const f = btn.dataset.f as AccessibilityType | 'all';
          this.a11yFilter = f;
          chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
          this.controller.setAccessibilityFilter(f === 'all' ? null : [f]);
        });
      });
    }

    // Colorblind-safe toggle rides in the zoom column.
    const cb = document.createElement('button');
    cb.type = 'button';
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

    this.syncPrices();
    this.syncTray();
    return this;
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
    const price = cat?.tiers?.length ? cat.tiers[0].price : cat?.price;
    this.srEl.textContent = `Seat ${seat.label}, ${cat?.label ?? seat.categoryKey}${
      price != null ? `, ${this.money(price)}` : ''
    }, ${statusText}`;
  }

  // ---- confirm popover (opt-in confirmSelection mode) ------------------------

  private showConfirm(seat: ExpandedSeat): void {
    this.closeConfirm();
    if (this.tipEl) this.tipEl.style.display = 'none';
    const cat = this.controller.doc?.categories.find((c) => c.key === seat.categoryKey);
    const price = cat?.tiers?.length ? cat.tiers[0].price : cat?.price;
    const el = document.createElement('div');
    el.className = 'sl-confirm';
    el.innerHTML =
      `<div class="sl-confirm-label">${seat.label}</div>` +
      `<div class="sl-confirm-meta"><span class="sl-dot" style="background:${cat?.color ?? '#6e7bff'}"></span>` +
      `${cat?.label ?? seat.categoryKey}${price != null ? `<b>${this.money(price)}</b>` : ''}</div>` +
      `<div class="sl-confirm-row">` +
      `<button type="button" class="sl-confirm-cancel">Cancel</button>` +
      `<button type="button" class="sl-confirm-add">Add seat</button></div>`;
    this.els.map.appendChild(el);
    this.confirmEl = el;
    this.confirmSeat = seat;
    this.reanchorConfirm();
    el.querySelector('.sl-confirm-add')!.addEventListener('click', () => this.closeConfirm());
    el.querySelector('.sl-confirm-cancel')!.addEventListener('click', () => {
      this.controller.deselect([seat.id]);
      this.closeConfirm();
    });
  }

  private reanchorConfirm(): void {
    if (!this.confirmEl || !this.confirmSeat) return;
    const p = this.controller.worldToScreen({ x: this.confirmSeat.x, y: this.confirmSeat.y });
    this.confirmEl.style.left = `${p.x}px`;
    this.confirmEl.style.top = `${p.y}px`;
  }

  private closeConfirm(): void {
    this.confirmEl?.remove();
    this.confirmEl = null;
    this.confirmSeat = null;
  }

  // ---- chrome sync ----------------------------------------------------------

  private money(n: number): string {
    try {
      return new Intl.NumberFormat(this.opts.locale, { style: 'currency', currency: this.currency }).format(n);
    } catch {
      return `${n} ${this.currency}`;
    }
  }

  private syncPrices(): void {
    const doc = this.controller.doc;
    if (!doc || !this.els.prices) return;
    const left = this.controller.categoryAvailability();
    this.els.prices.innerHTML = doc.categories
      .map((c) => {
        const price = c.tiers?.length ? c.tiers[0].price : c.price;
        return (
          `<div class="sl-price-row" data-cat="${c.key}"><span class="sl-dot" style="background:${c.color}"></span>` +
          `<span class="sl-price-label">${c.label}</span>` +
          `<span class="sl-price-left">${left[c.key] ?? 0} left</span>` +
          (price != null ? `<span class="sl-price-amt">${this.money(price)}</span>` : '') +
          `</div>`
        );
      })
      .join('');
    // Legend-hover highlight: dim other categories on the map while hovering a row.
    this.els.prices.querySelectorAll<HTMLElement>('.sl-price-row').forEach((row) => {
      row.addEventListener('mouseenter', () => this.controller.getRenderer()?.setCategoryHighlight?.(row.dataset.cat ?? null));
      row.addEventListener('mouseleave', () => this.controller.getRenderer()?.setCategoryHighlight?.(null));
    });
  }

  /** A live delta took one of OUR selected (not yet held) seats — evict + tell the buyer. */
  private evictTakenSelections(): void {
    // Our own hold's WS echo paints our seats 'held' — never treat those as sniped.
    const ownLabels = new Set<string>(this.controller.currentHold()?.labels ?? []);
    const gone = this.controller
      .getSelection()
      .filter((s) => !ownLabels.has(s.label) && (this.controller.getStatus(s.id) ?? 'free') !== 'free');
    if (!gone.length) return;
    this.controller.deselect(gone.map((s) => s.id));
    this.toast(`Seat ${gone[0].label} was just taken by another buyer.`);
  }

  private syncTray(): void {
    if (!this.els.tray) return;
    const seats = this.controller.getSelection();
    const gaAreas = this.controller.getGAAreas();
    const heldItems = this.hold?.items ?? [];
    const parts: string[] = [];

    if (!seats.length && !heldItems.length && !gaAreas.length) {
      parts.push(`<div class="sl-tray-hint">Tap a seat on the map, or let us pick the best available for you.</div>`);
    } else if (!seats.length && !heldItems.length) {
      parts.push(`<div class="sl-tray-hint">Tap a seat on the map — or grab standing tickets below.</div>`);
    }

    // Held line items (best-available or a completed hold) — locked in, no remove.
    for (const item of heldItems) {
      const cat = this.controller.doc?.categories.find((c) => c.key === item.categoryKey);
      parts.push(
        `<div class="sl-chip"><b>${item.label}</b>` +
          `<span class="cat">${cat?.label ?? item.categoryKey}</span>` +
          `<span class="amt">${this.money(item.unitPrice * (item.quantity ?? 1))}</span></div>`,
      );
    }

    const heldLabels = new Set(heldItems.map((item) => item.label));
    for (const s of seats.filter((seat) => !heldLabels.has(seat.label))) {
      const cat = this.controller.doc?.categories.find((c) => c.key === s.categoryKey);
      parts.push(
        `<div class="sl-chip" data-seat="${s.id}"><b>${s.label}</b>` +
          `<span class="cat">${cat?.label ?? s.categoryKey}</span>` +
          `<span class="amt">${this.money(s.price)}</span>` +
          `<button type="button" class="rm" aria-label="Remove ${s.label}">` +
          `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
          `</button></div>`,
      );
    }

    for (const area of gaAreas) {
      const qty = this.gaQty.get(area.id) ?? 0;
      parts.push(
        `<div class="sl-ga" data-ga="${area.id}"><div class="sl-ga-info">` +
          `<div class="sl-ga-name">${area.label}</div>` +
          `<div class="sl-ga-sub">${this.money(area.price)} · ${area.available} left</div></div>` +
          `<div class="sl-ga-qty">` +
          `<button type="button" data-d="-1" aria-label="Fewer">−</button><span>${qty}</span>` +
          `<button type="button" data-d="1" aria-label="More">+</button></div></div>`,
      );
    }

    // Best available — qty (+ optional category) picked server-side and held atomically.
    if (!this.hold) {
      const cats = this.controller.doc?.categories ?? [];
      parts.push(
        `<div class="sl-ba">` +
          (cats.length > 1
            ? `<select aria-label="Category" data-ba-cat>` +
              `<option value="">Any tier</option>` +
              cats.map((c) => `<option value="${c.key}"${this.baCat === c.key ? ' selected' : ''}>${c.label}</option>`).join('') +
              `</select>`
            : '') +
          `<div class="sl-ba-qty">` +
          `<button type="button" data-ba="-1" aria-label="Fewer seats">−</button><span>${this.baQty}</span>` +
          `<button type="button" data-ba="1" aria-label="More seats">+</button></div>` +
          `<button type="button" class="sl-ba-go">Best available</button></div>`,
      );
    }

    this.els.tray.innerHTML = parts.join('');
    this.els.tray.querySelectorAll<HTMLButtonElement>('[data-ba]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.baQty = Math.max(1, Math.min(8, this.baQty + Number(btn.dataset.ba)));
        this.syncTray();
      });
    });
    this.els.tray.querySelector<HTMLSelectElement>('[data-ba-cat]')?.addEventListener('change', (e) => {
      this.baCat = (e.target as HTMLSelectElement).value;
    });
    this.els.tray.querySelector<HTMLButtonElement>('.sl-ba-go')?.addEventListener('click', () => {
      void this.bestAvailable(this.baQty, this.baCat || undefined);
    });
    this.els.tray.querySelectorAll<HTMLElement>('.sl-chip .rm').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn.closest('.sl-chip') as HTMLElement).dataset.seat!;
        this.controller.deselect([id]);
      });
    });
    this.els.tray.querySelectorAll<HTMLElement>('.sl-ga button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const areaEl = btn.closest('.sl-ga') as HTMLElement;
        const id = areaEl.dataset.ga!;
        const area = gaAreas.find((a) => a.id === id);
        const next = Math.max(0, Math.min(area?.available ?? 0, (this.gaQty.get(id) ?? 0) + Number(btn.dataset.d)));
        this.gaQty.set(id, next);
        this.syncTray();
      });
    });

    // totals + CTA (held lines + fresh selections + GA)
    const gaTotal = gaAreas.reduce((sum, a) => sum + a.price * (this.gaQty.get(a.id) ?? 0), 0);
    const gaCount = [...this.gaQty.values()].reduce((a, b) => a + b, 0);
    const heldTotal = heldItems.reduce((sum, item) => sum + item.unitPrice * (item.quantity ?? 1), 0);
    const heldCount = heldItems.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
    const freshSeats = seats.filter((seat) => !heldLabels.has(seat.label));
    const total = freshSeats.reduce((sum, s) => sum + s.price, 0) + gaTotal + heldTotal;
    const count = freshSeats.length + gaCount + heldCount;
    this.els.count.textContent = count
      ? `${count} ${count === 1 ? 'ticket' : 'tickets'}`
      : 'No seats selected';
    this.els.total.textContent = count ? this.money(total) : '';
    const cta = this.els.cta as HTMLButtonElement;
    cta.disabled = count === 0;
    cta.textContent = this.hold ? 'Continue to checkout' : count ? 'Hold seats & checkout' : 'Select seats';
    this.opts.onSelectionChange?.(seats);
  }

  private async handleCta(): Promise<void> {
    const cta = this.els.cta as HTMLButtonElement;
    // Best-available (or a prior CTA press) already holds the seats — hand off.
    if (this.hold && !this.controller.getSelection().some((s) => !(this.hold!.items ?? []).some((i) => i.label === s.label))) {
      this.opts.onCheckout?.(this.hold, this.controller.getSelection());
      return;
    }
    cta.disabled = true;
    cta.textContent = 'Holding…';
    try {
      // seats first (controller.hold covers selected seats); GA quantities ride along
      let hold: HoldResult | null = null;
      const gaEntries = [...this.gaQty.entries()].filter(([, q]) => q > 0);
      // Snapshot before hold — the hold's own WS echo repaints these seats.
      const chosenSeats = this.controller.getSelection();
      if (chosenSeats.length) {
        const h = await this.controller.hold(undefined, this.opts.holdTtlMs);
        hold = h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
      }
      for (const [areaId, qty] of gaEntries) {
        const h = await this.controller.holdGA(areaId, qty, { ttlMs: this.opts.holdTtlMs });
        hold = h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : hold;
      }
      if (!hold) {
        this.toast('One or more seats were just taken. Please pick again.');
        this.syncTray();
        return;
      }
      this.hold = hold;
      this.startHoldTimer(hold.expiresAt);
      this.opts.onCheckout?.(hold, chosenSeats);
    } catch (err) {
      this.opts.onError?.(err);
      this.toast('One or more seats were just taken. Please pick again.');
    } finally {
      this.syncTray();
    }
  }

  private startHoldTimer(expiresAt: number): void {
    this.stopHoldTimer();
    const pill = this.els.hold;
    const tick = (): void => {
      const ms = Math.max(0, expiresAt - Date.now());
      const m = Math.floor(ms / 60000);
      const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      pill.textContent = `Held ${m}:${s}`;
      pill.classList.add('on');
      if (ms <= 0) this.stopHoldTimer();
    };
    tick();
    this.holdTimer = setInterval(tick, 500);
  }

  private stopHoldTimer(): void {
    if (this.holdTimer) clearInterval(this.holdTimer);
    this.holdTimer = null;
    this.els.hold?.classList.remove('on');
  }

  private toast(msg: string): void {
    const el = this.els.toast;
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
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
    this.tipEl.innerHTML =
      `<div style="font-weight:800;font-size:13px">${details.label}</div>` +
      `<div style="display:flex;align-items:center;gap:6px;margin-top:4px">` +
      `<span style="width:9px;height:9px;border-radius:50%;flex:none;background:${details.categoryColor}"></span>` +
      `<span style="opacity:.75">${details.categoryLabel}</span>` +
      `<span style="margin-left:auto;font-weight:800">${this.money(details.price)}</span></div>` +
      statusLine;
    this.tipEl.style.display = 'block';
    this.placeTooltip();
  }

  // ---- public conveniences ----------------------------------------------------

  getSelection(): PickerSeat[] {
    return this.controller.getSelection();
  }

  async bestAvailable(qty: number, categoryKey?: string): Promise<HoldResult | null> {
    try {
      const h = await this.controller.bestAvailable(qty, categoryKey);
      if (h) {
        this.hold = { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items };
        this.startHoldTimer(h.expiresAt);
        this.syncTray();
        return this.hold;
      }
      return null;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  async release(): Promise<void> {
    await this.controller.release();
    this.hold = null;
    this.stopHoldTimer();
    this.gaQty.clear();
    this.syncTray();
  }

  destroy(): void {
    this.destroyed = true;
    this.closeConfirm();
    this.stopHoldTimer();
    if (this.toastTimer) clearTimeout(this.toastTimer);
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
