/**
 * SeatingChart — the embeddable buyer picker.
 *
 * A thin wrapper over the shared PickerController (src/picker/PickerController):
 * it owns the mount <div> + the public embed contract (hold-only — the SDK hands
 * the holdId to the host page for a server-side book) and delegates all transport
 * + booking to the controller, so the SDK inherits every fix made for the live
 * buyer page and the demo picker.
 */
import {
  PickerController,
  loadLocale,
  setStringOverrides,
  t,
  type PickerSeat,
  type RendererViewMode,
  type SeatHoverDetails,
} from '@seatlayer/core';
import { PubApi, type BestAvailableResult, type HoldResult } from './api';
import {
  createBuyerAccessContext,
  type BuyerAccessContext,
  type BuyerAccessExpiredEvent,
  type BuyerAccessToken,
  type BuyerAccessTokenProvider,
  type BuyerAccessUnavailableEvent,
  type SelectedObjectUnavailableEvent,
} from './buyerAccess';
import { BuyerRealtimeClient, createControllerSink } from './buyerRealtime';
import { SEATLAYER_ATTRIBUTION_MARK_SVG } from './seatLayerBrand';

const DEFAULT_API_BASE = 'https://api.seatlayer.io';
const DEFAULT_MAX_SELECTION = 10;

/** A seat as surfaced to the host page (prices resolved from the chart's categories). */
export type SelectedSeat = PickerSeat;
export interface GAAreaAvailability {
  id: string; label: string; capacity: number; available: number; categoryKey: string; price: number; currency: string;
  /** Buyer-facing copy authored separately from stable inventory identity. */
  displayLabel?: string;
  displayType?: string;
  tiers?: Array<{ id: string; name: string; price: number }>;
}

export interface SeatingChartOptions {
  /** CSS selector or an HTMLElement to render into. */
  container: string | HTMLElement;
  /** Event key, e.g. `ev_xxx`. */
  event: string;
  /** API origin. Defaults to https://api.seatlayer.io. */
  apiBase?: string;
  /** Reserved for future authenticated rendering — accepted + stored, not yet sent.
   *  NOT the channel-access credential: a buyer access session is a different
   *  thing with different authority, and uses the two options below. */
  publicKey?: string;
  /**
   * Buyer access session provider — the recommended way to render private
   * channel inventory (Sales Channels guide §6).
   *
   * Called with a `reason` whenever the SDK needs a bearer: first acquisition,
   * a near/actual expiry, a 401 `buyer_access_expired`, a realtime reconnect,
   * or `refreshAccess()`. It should POST to YOUR backend, which mints the
   * session with your secret key and returns `{ token, expiresAt }`.
   *
   * The token lives in memory for the widget's lifetime and nowhere else: never
   * in storage, never in a URL, never in a log or an error message. Refresh
   * returns the same or a narrower scope — the SDK never widens to Public sale
   * on its own, and a failed refresh stops the scoped operation rather than
   * retrying it anonymously.
   */
  buyerAccessTokenProvider?: BuyerAccessTokenProvider;
  /**
   * One-shot escape hatch for hosts that already own the session lifecycle.
   * Cannot be renewed — when it lapses the widget reports `onAccessExpired`
   * and then `onAccessUnavailable`. Prefer `buyerAccessTokenProvider`.
   */
  buyerAccessToken?: string | BuyerAccessToken;
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
  /** Initial canvas projection.
   * @deprecated `'isometric'` and `'perspective'` are retired in favour of the
   * real 3D venue view (`setBuyerView('venue3d')`); they remain accepted for
   * source compatibility and will be removed in the next major. Use `'flat'`. */
  initialView?: RendererViewMode;
  /**
   * Built-in seat tooltip on mouse hover (seat · category · price · status).
   * Rendered inside the widget so every host gets it; default true. Turn off
   * to draw your own popover from onSeatHover.
   */
  seatTooltip?: boolean;
  /**
   * Seat hover with everything a popover needs (category label/color, resolved
   * tier-aware price, live status, currency); null on hover-out. Fires whether
   * or not the built-in tooltip is enabled.
   */
  onSeatHover?: (details: SeatHoverDetails | null) => void;
  onSelectionChange?: (seats: SelectedSeat[]) => void;
  onHold?: (result: HoldResult) => void;
  /** A prior active hold was restored with resumeHold(). */
  onHoldRestored?: (result: HoldResult) => void;
  onHoldExpired?: () => void;
  onGAClick?: (area: GAAreaAvailability) => void;
  /**
   * The buyer access session lapsed. `refreshed` says whether the provider
   * already recovered it — false means private inventory is now unavailable and
   * `onAccessUnavailable` follows. Distinct from `onError` on purpose: this is
   * never a network failure (guide §10).
   */
  onAccessExpired?: (event: BuyerAccessExpiredEvent) => void;
  /**
   * Private inventory is unavailable and refreshing will not fix it — revoked,
   * paused, wrong origin/event/mode, or the provider failed. Carries a reason,
   * never a channel name, id, colour or count.
   */
  onAccessUnavailable?: (event: BuyerAccessUnavailableEvent) => void;
  /**
   * Selected-but-unheld units stopped being selectable — someone else took
   * them, or an allocation change moved them out of this buyer's scope. The
   * widget has already dropped them from the selection.
   */
  onSelectedObjectUnavailable?: (event: SelectedObjectUnavailableEvent) => void;
  onError?: (err: unknown) => void;
  /**
   * What the BUYER sees when the chart cannot load.
   *
   * `'message'` (the default) renders a plain, styleable notice with a Try
   * again button. This used to be silent unconditionally: `render()` returned
   * with an EMPTY mounted div and only `onError` fired, so a host that had not
   * wired `onError` — or had wired it to a logger — showed buyers a blank
   * rectangle where the seat map belongs, on the host's own domain, which
   * reads as a broken website rather than a temporary fault. `SeatPicker` has
   * always failed loud with a retry; this is the embed class catching up.
   *
   * `'none'` restores the silent behaviour for hosts that render their own
   * failure UI from `onError`.
   */
  errorDisplay?: 'message' | 'none';
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
  private retryBtn: HTMLButtonElement | null = null;
  private mode_: 'live' | 'test' | null = null;
  private tipEl: HTMLDivElement | null = null;
  private tipPos = { x: 0, y: 0 };
  private onTipMove: ((e: MouseEvent) => void) | null = null;
  /** Null for the ordinary public chart — the tokenless path is untouched. */
  private readonly access: BuyerAccessContext | null;
  private readonly api: PubApi;
  private realtime: BuyerRealtimeClient | null = null;

  constructor(options: SeatingChartOptions) {
    if (!options || typeof options !== 'object') throw new Error('seatmap: options object is required');
    if (!options.container) throw new Error('seatmap: `container` is required');
    if (!options.event || typeof options.event !== 'string') throw new Error('seatmap: `event` key is required');

    this.opts = options;
    this.publicKey = options.publicKey;
    this.access = createBuyerAccessContext(options, {
      onExpired: (event) => this.opts.onAccessExpired?.(event),
      onUnavailable: (event) => this.opts.onAccessUnavailable?.(event),
    });
    const api = new PubApi((options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''), {
      access: this.access ?? undefined,
      onObjectUnavailable: (event) => this.opts.onSelectedObjectUnavailable?.(event),
    });
    this.api = api;
    this.controller = new PickerController({
      transport: api,
      eventKey: options.event,
      maxSelection: options.maxSelection ?? DEFAULT_MAX_SELECTION,
      currency: options.currency,
      onSelectionChange: (seats) => this.opts.onSelectionChange?.(seats),
      onHold: (h) => this.opts.onHold?.({ holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items }),
      onHoldRestored: (h) => this.opts.onHoldRestored?.({ holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items }),
      onHoldExpired: () => this.opts.onHoldExpired?.(),
      onGAClick: (areaId) => {
        const area = this.controller.getGAAreas().find((candidate) => candidate.id === areaId);
        if (area) this.opts.onGAClick?.(area);
      },
      onError: (err) => this.opts.onError?.(err),
      onDeckTap: (floorId) => this.opts.onDeckTap?.(floorId),
      onHint: (message) => this.opts.onHint?.(message),
      // Live-activity cue: pulse seats that other buyers take while the map is
      // open — the WS feed already streams the status change, this makes it felt.
      flashOnLiveChange: true,
      onSeatHover: (details) => {
        this.opts.onSeatHover?.(details);
        if (this.opts.seatTooltip !== false) this.updateTooltip(details);
      },
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
      if (this.opts.errorDisplay !== 'none') this.showLoadFailure(host);
      return this;
    }
    this.controller.setViewMode(this.opts.initialView ?? 'flat');
    this.startRealtime();
    // The served event's mode. Anything the API does not explicitly mark as a
    // test event is a live one — the same rule the test-mode ribbon below uses.
    this.mode_ = info.mode === 'test' ? 'test' : 'live';

    // Tooltip element + cursor tracking (mouse only — touch selects directly and
    // reviews seats in the host tray). Positioned at the cursor, flipped at edges.
    // Appended AFTER controller.render — mounting the canvas replaces the host's
    // prior children, so anything added earlier would be wiped.
    if (this.opts.seatTooltip !== false) {
      const tip = document.createElement('div');
      tip.setAttribute('role', 'tooltip');
      tip.style.cssText =
        'position:absolute;z-index:7;pointer-events:none;display:none;max-width:240px;' +
        'background:#10162a;color:#fff;border-radius:10px;padding:9px 12px;' +
        'font:500 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'box-shadow:0 10px 30px -10px rgba(0,0,0,.5);';
      host.appendChild(tip);
      this.tipEl = tip;
      this.onTipMove = (e: MouseEvent) => {
        const r = host.getBoundingClientRect();
        this.tipPos = { x: e.clientX - r.left, y: e.clientY - r.top };
        if (this.tipEl && this.tipEl.style.display !== 'none') this.placeTooltip();
      };
      host.addEventListener('mousemove', this.onTipMove);
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

    // "Powered by SeatLayer" attribution — the SDK embed is canvas-only, so
    // (unlike the full SeatPicker widget) nothing else renders this badge; no
    // duplication guard is needed. Shown by default; hidden only when the SERVED
    // chart doc's theme sets hideBadge (the API forces that false for orgs
    // without the white-label entitlement, so the client can trust the flag).
    this.buildBadge(host);
    return this;
  }

  /**
   * Attribution badge pinned to the embed's bottom-right, linking to
   * seatlayer.io. Rendered as an absolutely-positioned overlay with
   * self-contained inline styles — the SDK embed ships no widget CSS, and an
   * overlay keeps it out of the layout flow so it never disturbs the SDK v0.22
   * fill-height resize contract. Mirrors the full widget's mark + wordmark and
   * reuses the `picker.poweredBy` i18n string.
   */
  private buildBadge(host: HTMLDivElement): void {
    if (this.controller.doc?.theme?.hideBadge) return;
    const badge = document.createElement('a');
    badge.href = 'https://seatlayer.io';
    badge.target = '_blank';
    badge.rel = 'noopener noreferrer';
    badge.setAttribute('aria-label', t('picker.poweredBy'));
    badge.style.cssText =
      'position:absolute;bottom:10px;right:12px;z-index:5;' +
      'display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;' +
      'background:rgba(255,255,255,.92);color:#4a5163;text-decoration:none;' +
      'font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.02em;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.12);';
    badge.innerHTML =
      '<span aria-hidden="true" style="width:16px;height:16px;border-radius:4px;flex:none;' +
      'display:flex;align-items:center;justify-content:center;background:#0c1220;color:#fcf7ee">' +
      SEATLAYER_ATTRIBUTION_MARK_SVG + '</span>' +
      `<span>${t('picker.poweredBy')}</span>`;
    host.appendChild(badge);
  }

  private placeTooltip(): void {
    if (!this.tipEl || !this.hostEl) return;
    const hw = this.hostEl.clientWidth;
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
    const money = (() => {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: details.currency }).format(details.price);
      } catch {
        return `${details.price} ${details.currency}`;
      }
    })();
    const statusLine =
      details.status === 'free'
        ? ''
        : `<div style="margin-top:5px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#fca5a5;font-weight:700">${
            details.status === 'held' ? t('map.statusHeld') : t('map.statusTaken')
          }</div>`;
    this.tipEl.innerHTML =
      `<div style="font-weight:700;font-size:13px">${details.label}</div>` +
      `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;color:#c7cddc">` +
      `<span style="width:9px;height:9px;border-radius:50%;flex:none;background:${details.categoryColor}"></span>` +
      `<span>${details.categoryLabel}</span>` +
      `<span style="margin-left:auto;font-weight:700;color:#fff">${money}</span></div>` +
      statusLine;
    this.tipEl.style.display = 'block';
    this.placeTooltip();
  }

  /**
   * Whether the SERVED event is a live or a test event (`sk_test_` keys create
   * test events, which never book real inventory). `null` before render()
   * resolves — the mode comes from the server with the chart, not from options.
   *
   * The widget already surfaces this visually with the test-mode ribbon; this
   * getter is for hosts that draw their own chrome — notably a native WebView
   * wrapper, which must be able to tell an integrator that the build they are
   * about to ship is pointed at a test event.
   */
  getMode(): 'live' | 'test' | null {
    return this.mode_;
  }

  /** Current selection with prices resolved from the chart categories. */
  getSelection(): SelectedSeat[] {
    return this.controller.getSelection();
  }

  /** Hold the current selection. Resolves the hold, or null on a 409 conflict. */
  async hold(options: { ttlMs?: number } = {}): Promise<HoldResult | null> {
    try {
      return await this.holdOrThrow(options);
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /**
   * @internal Like {@link hold} but RE-THROWS the structured API error (409
   * `reason`/`code` + `conflicts`) instead of swallowing it into `onError` +
   * `null`. The native WebView host adapter needs the throw so it can answer the
   * originating command with a correlated error carrying the SPECIFIC reason
   * (`sold_out` vs `not_enough_together`); the public method above keeps the
   * catch-and-onError contract that direct web consumers rely on. Not a stable
   * part of the embed API.
   */
  async holdOrThrow(options: { ttlMs?: number } = {}): Promise<HoldResult | null> {
    const h = await this.controller.hold(undefined, options.ttlMs);
    return h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
  }

  /** Restore an active hold by its opaque id without extending its expiry. */
  async resumeHold(holdId: string): Promise<HoldResult | null> {
    try {
      return await this.resumeHoldOrThrow(holdId);
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** @internal Throwing variant of {@link resumeHold} for the native host adapter. See {@link holdOrThrow}. */
  async resumeHoldOrThrow(holdId: string): Promise<HoldResult | null> {
    const h = await this.controller.resumeHold(holdId);
    return h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
  }

  /**
   * Push the OPEN hold's expiry out ("need more time?"). Resolves the refreshed
   * hold, or `null` when there is nothing held or the server refused (the hold
   * is gone, already expired, or at its renewal cap) — refusal is a normal
   * outcome, not an error, so the host decides the copy. The client-side expiry
   * timer is re-armed to match, so `onHoldExpired` won't fire early.
   */
  async extendHold(ttlMs?: number): Promise<HoldResult | null> {
    try {
      const h = await this.controller.extendHold(ttlMs);
      return h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** Current active hold known to this chart, if any. */
  getCurrentHold(): HoldResult | null {
    const h = this.controller.currentHold();
    return h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
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
      return await this.holdGAOrThrow(areaId, qty, options);
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** @internal Throwing variant of {@link holdGA} for the native host adapter. See {@link holdOrThrow}. */
  async holdGAOrThrow(
    areaId: string,
    qty: number,
    options: { tierId?: string | null; ttlMs?: number } = {},
  ): Promise<HoldResult | null> {
    const h = await this.controller.holdGA(areaId, qty, options);
    return h ? { holdId: h.holdId, expiresAt: h.expiresAt, seats: h.seats, items: h.items } : null;
  }

  /**
   * Ask the server for the `qty` best free seats and hold them atomically.
   * `options.ttlMs` sets the checkout window exactly like {@link hold}; omit it
   * and the server falls back to the event setting, then its own default.
   */
  async bestAvailable(
    qty: number,
    categoryKey?: string,
    options: { zoneId?: string; preferPremium?: boolean; ttlMs?: number } = {},
  ): Promise<BestAvailableResult | null> {
    try {
      return await this.bestAvailableOrThrow(qty, categoryKey, options);
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** @internal Throwing variant of {@link bestAvailable} for the native host adapter. See {@link holdOrThrow}. */
  async bestAvailableOrThrow(
    qty: number,
    categoryKey?: string,
    options: { zoneId?: string; preferPremium?: boolean; ttlMs?: number } = {},
  ): Promise<BestAvailableResult | null> {
    const h = await this.controller.bestAvailable(qty, categoryKey, options);
    return h ? {
      holdId: h.holdId,
      expiresAt: h.expiresAt,
      labels: h.labels,
      seats: h.seats,
      items: h.items,
      ...(options.zoneId ? { zoneId: options.zoneId } : {}),
    } : null;
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

  /** Switch the 2D canvas projection.
   * @deprecated `'isometric'` and `'perspective'` are retired in favour of the
   * real 3D venue view (`setBuyerView('venue3d')`); accepted for source
   * compatibility until the next major. */
  setViewMode(mode: RendererViewMode): void {
    this.controller.setViewMode(mode);
  }

  /** Current canvas projection. */
  getViewMode(): RendererViewMode {
    return this.controller.getViewMode();
  }

  /** Zoom in one step (same increment as the wheel/pinch gesture). */
  zoomIn(): void {
    this.controller.zoomIn();
  }

  /** Zoom out one step. */
  zoomOut(): void {
    this.controller.zoomOut();
  }

  /** Reset the camera so the whole chart fits the container. */
  zoomToFit(): void {
    this.controller.zoomToFit();
  }

  /** Release the current hold (if any). No-op when nothing is held. */
  async release(): Promise<void> {
    await this.controller.release();
  }

  /** Release selected labels from the current hold while keeping the remainder. */
  async releaseLabels(labels: string[]): Promise<boolean> {
    return this.controller.releaseLabels(labels);
  }

  /** Tear everything down: close the socket, stop timers, drop the canvas. */
  /**
   * Realtime for an access-scoped chart.
   *
   * A tokenless chart never gets here: `access` is null, `PubApi.socketUrl()`
   * returns the URL it always has, and PickerController keeps its own socket
   * and its own legacy frames. Nothing about the public path changes.
   */
  private startRealtime(): void {
    if (!this.access?.configured || this.realtime) return;
    this.realtime = new BuyerRealtimeClient({
      url: this.api.subscribeUrl(this.opts.event),
      mintTicket: () => this.api.subscribeTicket(this.opts.event),
      onAccessUnavailable: (event) => this.opts.onAccessUnavailable?.(event),
      sink: createControllerSink(this.controller, {
        flashOnLiveChange: true,
        onSelectedObjectUnavailable: (labels, reason) =>
          this.opts.onSelectedObjectUnavailable?.({ labels, reason }),
      }),
    });
    this.realtime.start();
  }

  /**
   * Re-acquire the buyer access session — call after your app has re-authorized
   * the buyer (a revoked session cannot be recovered any other way). Resolves
   * true when a fresh bearer is held; the realtime feed restarts with it.
   */
  async refreshAccess(): Promise<boolean> {
    if (!this.access?.configured) return false;
    const ok = await this.access.refresh('manual');
    if (ok) {
      await this.controller.refresh();
      this.realtime?.restart();
      if (!this.realtime) this.startRealtime();
    }
    return ok;
  }

  /**
   * The visible failure state. Deliberately inline-styled and dependency-free:
   * this renders on a stranger's website, where our stylesheet may not have
   * loaded (the chart fetch just failed) and where inheriting the host's own
   * styles is likelier to produce something unreadable than something on-brand.
   */
  private showLoadFailure(host: HTMLDivElement): void {
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
      'width:100%;height:100%;min-height:180px;box-sizing:border-box;padding:24px;text-align:center;' +
      'font:500 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#3b4256;';

    const text = document.createElement('div');
    // No error detail: a buyer cannot act on it, and it can carry internals.
    text.textContent = 'The seat map didn’t load.';
    box.appendChild(text);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Try again';
    btn.style.cssText =
      'appearance:none;border:1px solid #c9cede;background:#fff;color:#10162a;border-radius:8px;' +
      'padding:8px 16px;font:600 13px/1 inherit;cursor:pointer;';
    btn.addEventListener('click', () => {
      // Full remount: the controller holds no partial state worth salvaging
      // after a failed render, and this is the same recovery SeatPicker uses.
      this.destroy();
      void this.render().catch((err) => this.opts.onError?.(err));
    });
    box.appendChild(btn);
    this.retryBtn = btn;
    host.appendChild(box);
  }

  destroy(): void {
    this.realtime?.stop();
    this.realtime = null;
    this.access?.clear();
    this.retryBtn = null;
    if (this.hostEl && this.onTipMove) this.hostEl.removeEventListener('mousemove', this.onTipMove);
    this.tipEl = null;
    this.onTipMove = null;
    this.controller.destroy();
    if (this.hostEl && this.hostEl.parentNode) this.hostEl.parentNode.removeChild(this.hostEl);
    this.hostEl = null;
    this.mount = null;
    this.rendered = false;
    this.mode_ = null;
  }
}
