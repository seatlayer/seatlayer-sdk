/**
 * SeatingChart — the embeddable buyer picker.
 *
 * A thin wrapper over the shared PickerController (src/picker/PickerController):
 * it owns the mount <div> + the public embed contract (hold-only — the SDK hands
 * the holdId to the host page for a server-side book) and delegates all transport
 * + booking to the controller, so the SDK inherits every fix made for the live
 * buyer page and the demo picker.
 */
import { PickerController, loadLocale, setStringOverrides, t, type PickerSeat } from '@seatlayer/core';
import { PubApi, type BestAvailableResult, type HoldResult } from './api';

const DEFAULT_API_BASE = 'https://api.seatlayer.io';
const DEFAULT_MAX_SELECTION = 10;

/** A seat as surfaced to the host page (prices resolved from the chart's categories). */
export type SelectedSeat = PickerSeat;
export interface GAAreaAvailability {
  id: string; label: string; capacity: number; available: number; categoryKey: string; price: number; currency: string;
  tiers?: Array<{ id: string; name: string; price: number }>;
}

export interface SeatingChartOptions {
  /** CSS selector or an HTMLElement to render into. */
  container: string | HTMLElement;
  /** Event key, e.g. `ev_xxx`. */
  event: string;
  /** API origin. Defaults to https://api.seatlayer.io. */
  apiBase?: string;
  /** Reserved for future authenticated rendering — accepted + stored, not yet sent. */
  publicKey?: string;
  /** Max seats selectable at once (default 10). */
  maxSelection?: number;
  /**
   * BCP 47 language for the widget UI — `'de'`, `'es-MX'`, etc. Falls back to
   * the browser language, then English. Built-in: en, es, de, fr. The German
   * bundle (etc.) is fetched on demand so unused languages cost nothing.
   */
  locale?: string;
  /**
   * Per-key string overrides layered over the active locale — white-label copy
   * without shipping a whole bundle, e.g. `{ 'map.fromPrice': 'ab {price}' }`.
   */
  messages?: Record<string, string>;
  /** ISO 4217 currency for on-map prices (default USD). */
  currency?: string;
  /**
   * Colorblind-safe rendering: category hues switch to an Okabe-Ito palette
   * and booked seats render hollow, so state never relies on hue alone.
   * Toggleable later with setColorblindSafe().
   */
  colorblindSafe?: boolean;
  onSelectionChange?: (seats: SelectedSeat[]) => void;
  onHold?: (result: HoldResult) => void;
  onHoldExpired?: () => void;
  onGAClick?: (area: GAAreaAvailability) => void;
  onError?: (err: unknown) => void;
  /**
   * Multi-floor charts only: fires when the buyer taps a deck in the stacked
   * 3D view, after the picker switches to that floor — lets the host page sync
   * its own floor UI (tabs, labels) with the map.
   */
  onDeckTap?: (floorId: string) => void;
  /**
   * Non-blocking, localized selection advice — currently the orphan-seat hint
   * (the selection would strand a single free seat between taken neighbors).
   * `null` clears it. Purely informational; nothing is ever prevented.
   */
  onHint?: (message: string | null) => void;
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

export class SeatingChart {
  private readonly opts: SeatingChartOptions;
  private readonly controller: PickerController;
  /** Reserved for future authenticated rendering — stored, not yet sent on any request. */
  readonly publicKey?: string;

  private mount: HTMLElement | null = null;
  private hostEl: HTMLDivElement | null = null;
  private rendered = false;

  constructor(options: SeatingChartOptions) {
    if (!options || typeof options !== 'object') throw new Error('seatmap: options object is required');
    if (!options.container) throw new Error('seatmap: `container` is required');
    if (!options.event || typeof options.event !== 'string') throw new Error('seatmap: `event` key is required');

    this.opts = options;
    this.publicKey = options.publicKey;
    const api = new PubApi((options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''));
    this.controller = new PickerController({
      transport: api,
      eventKey: options.event,
      maxSelection: options.maxSelection ?? DEFAULT_MAX_SELECTION,
      currency: options.currency,
      onSelectionChange: (seats) => this.opts.onSelectionChange?.(seats),
      onHold: (h) => this.opts.onHold?.({ holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items }),
      onHoldExpired: () => this.opts.onHoldExpired?.(),
      onGAClick: (areaId) => {
        const area = this.controller.getGAAreas().find((candidate) => candidate.id === areaId);
        if (area) this.opts.onGAClick?.(area);
      },
      onError: (err) => this.opts.onError?.(err),
      onDeckTap: (floorId) => this.opts.onDeckTap?.(floorId),
      onHint: (message) => this.opts.onHint?.(message),
      colorblindSafe: options.colorblindSafe,
    });
  }

  /** Fetch the chart, mount the renderer, seed statuses and go live. Idempotent. */
  async render(): Promise<this> {
    if (this.rendered) return this;
    this.rendered = true;

    // Resolve + load the UI language before the first paint so on-map labels
    // ("N LEFT", "FROM …", the map aria-label) render translated. English and
    // already-loaded locales resolve synchronously; others fetch one small chunk.
    await loadLocale(this.opts.locale);
    if (this.opts.messages) setStringOverrides(this.opts.messages);

    // Mount an owned <div> inside the caller's container so we never fight their
    // layout and can cleanly remove it on destroy().
    this.mount = resolveContainer(this.opts.container);
    const host = document.createElement('div');
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.position = 'relative';
    this.mount.appendChild(host);
    this.hostEl = host;

    const info = await this.controller.render(host);
    if (!info) {
      this.rendered = false;
      return this;
    }
    if (info.mode === 'test') {
      host.style.overflow = 'hidden';
      const ribbon = document.createElement('div');
      ribbon.textContent = t('picker.testMode');
      ribbon.setAttribute('aria-label', t('picker.testMode'));
      ribbon.style.cssText =
        'position:absolute;top:18px;right:-34px;z-index:6;transform:rotate(45deg);' +
        'width:140px;text-align:center;padding:4px 0;background:#f4b740;color:#1a1200;' +
        'font:800 10.5px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.12em;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;';
      host.appendChild(ribbon);
    }
    return this;
  }

  /** Current selection with prices resolved from the chart categories. */
  getSelection(): SelectedSeat[] {
    return this.controller.getSelection();
  }

  /** Hold the current selection. Resolves the hold, or null on a 409 conflict. */
  async hold(options: { ttlMs?: number } = {}): Promise<HoldResult | null> {
    try {
      const h = await this.controller.hold(undefined, options.ttlMs);
      return h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  getGAAreas(): GAAreaAvailability[] {
    return this.controller.getGAAreas();
  }

  async holdGA(
    areaId: string,
    qty: number,
    options: { tierId?: string | null; ttlMs?: number } = {},
  ): Promise<HoldResult | null> {
    try {
      const h = await this.controller.holdGA(areaId, qty, options);
      return h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** Ask the server for the `qty` best free seats and hold them atomically. */
  async bestAvailable(qty: number, categoryKey?: string): Promise<BestAvailableResult | null> {
    try {
      const h = await this.controller.bestAvailable(qty, categoryKey);
      return h ? { holdId: h.holdId, expiresAt: h.expiresAt, labels: h.labels, seats: h.seats, items: h.items } : null;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /**
   * Choose a ticket tier for a selected seat (e.g. Adult → Child). The seat's
   * available `tiers` are on each `SelectedSeat` from `getSelection()` /
   * `onSelectionChange`. Re-emits the selection with the new tier + price, and
   * the tier rides along in the next `hold()` / `onHold` per seat. `tierId=null`
   * reverts to the default tier.
   */
  setSeatTier(seatId: string, tierId: string | null): void {
    this.controller.setSeatTier(seatId, tierId);
  }

  /**
   * Floors of a multi-floor chart — `[{ id, name }]` (single-floor charts
   * return one entry; empty before render()). Pair with setFloor() to build a
   * host-side floor switcher.
   */
  getFloors(): { id: string; name: string }[] {
    return this.controller.getFloors();
  }

  /** Switch the shown floor (2D). Warns + no-ops on single-floor charts. */
  setFloor(floorId: string): void {
    if (this.controller.getFloors().length <= 1) {
      console.warn('seatmap: setFloor() ignored — this chart has a single floor');
      return;
    }
    this.controller.setFloor(floorId);
  }

  /** Toggle colorblind-safe rendering at runtime (see options.colorblindSafe). */
  setColorblindSafe(on: boolean): void {
    this.controller.setColorblindSafe(on);
  }

  /** Release the current hold (if any). No-op when nothing is held. */
  async release(): Promise<void> {
    await this.controller.release();
  }

  /** Tear everything down: close the socket, stop timers, drop the canvas. */
  destroy(): void {
    this.controller.destroy();
    if (this.hostEl && this.hostEl.parentNode) this.hostEl.parentNode.removeChild(this.hostEl);
    this.hostEl = null;
    this.mount = null;
    this.rendered = false;
  }
}
