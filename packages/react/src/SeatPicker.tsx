import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import {
  SeatPicker as CoreSeatPicker,
  type SeatPickerOptions,
  type SeatPickerTheme,
  type SeatPickerPricing,
  type SeatPickerBestAvailableOptions,
  type SeatPickerBuyerView,
  type SeatPickerBuyerViewOptions,
  type PickerMapTheme,
  type RendererViewMode,
  type SelectedSeat,
  type HoldResult,
} from '@seatlayer/js';

export type {
  SeatPickerOptions,
  SeatPickerTheme,
  SeatPickerPricing,
  SeatPickerBestAvailableOptions,
  SeatPickerBuyerView,
  SeatPickerBuyerViewOptions,
  PickerMapTheme,
  RendererViewMode,
  CheckoutHandoff,
  CheckoutLineItem,
} from '@seatlayer/js';

/** Imperative handle for the full-experience picker widget. */
export interface SeatPickerHandle {
  /** Logically close the picker. React still owns component unmount/teardown. */
  close(): void;
  /** Current selection with resolved prices. */
  getSelection(): SelectedSeat[];
  /** Server-side best seats + hold, reflected in the widget tray. */
  bestAvailable(
    qty: number,
    categoryKey?: string,
    options?: SeatPickerBestAvailableOptions,
  ): Promise<HoldResult | null>;
  /** Current active/restored hold reflected in the tray. */
  getCurrentHold(): HoldResult | null;
  /** Restore an active hold by its opaque id. */
  resumeHold(holdId: string): Promise<HoldResult | null>;
  /** Remove one held ticket while preserving the remainder. */
  removeHeldTicket(label: string): Promise<boolean>;
  /** Release the current hold (if any) and reset the tray. */
  release(): Promise<void>;
  /**
   * Re-acquire the buyer access session after your app re-authorizes the buyer
   * (Sales Channels). Resolves false when the picker is not access-scoped.
   */
  refreshAccess(): Promise<boolean>;
  /** Re-ink the drawn map without rebuilding the picker or disturbing a hold. */
  setMapTheme(map: PickerMapTheme | null): void;
  /** Hide or restore duplicate event identity after mount. */
  setEventDetailsHidden(hidden: boolean): void;
  /** Replace host display-pricing overrides without remounting. */
  setPricing(pricing: SeatPickerPricing | undefined): void;
  /** Current colorblind-safe buyer preference. */
  isColorblindSafe(): boolean;
  /** Update the colorblind-safe buyer preference and renderer. */
  setColorblindSafe(on: boolean): void;
  /** Switch the underlying 2D map projection. */
  setViewMode(mode: RendererViewMode): void;
  /** Current 2D map projection. */
  getViewMode(): RendererViewMode;
  /** Current buyer surface: map or interactive 3D venue. */
  getBuyerView(): SeatPickerBuyerView;
  /** Switch the buyer surface, optionally carrying a 3D camera intent. */
  setBuyerView(view: SeatPickerBuyerView, options?: SeatPickerBuyerViewOptions): void;
}

export interface SeatPickerProps extends Omit<SeatPickerOptions, 'container'> {
  className?: string;
  style?: CSSProperties;
}

/**
 * React wrapper around the full SeatPicker widget (header · live price panel ·
 * tray · GA · hold countdown · toasts). The widget is container-adaptive: give
 * the wrapping div a size and it lays itself out for that box (side panel wide,
 * bottom sheet narrow). For the one-call modal, use `SeatPicker.open()` from
 * `@seatlayer/js` directly.
 */
export const SeatPicker = forwardRef<SeatPickerHandle, SeatPickerProps>(
  function SeatPicker(props, ref) {
    const { className, style, event, apiBase, maxSelection, publicKey, locale, currency, colorblindSafe, hideBadge, holdTtlMs, initialHoldId, restoreHold, confirmSelection, seatView, checkout } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const pickerRef = useRef<CoreSeatPicker | null>(null);
    const closeRef = useRef<(() => void) | null>(null);

    // Always call the latest callbacks without rebuilding the widget.
    const callbacks = useRef(props);
    callbacks.current = props;

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      // Forward every option the host passed. Spreading rather than naming each
      // field keeps new core options (pricing, hideBadge, transport, …) working
      // here the day they ship: a hand-maintained list silently drops anything
      // it forgets, and `SeatPickerProps extends SeatPickerOptions` means such a
      // drop still type-checks clean for the host.
      const { className: _className, style: _style, ...options } = callbacks.current;

      const picker = new CoreSeatPicker({
        ...options,
        container: el,
        onCheckout: (hold, seats, handoff) => callbacks.current.onCheckout?.(hold, seats, handoff),
        onBooked: (handoff) => callbacks.current.onBooked?.(handoff),
        onSelectionChange: (seats) => callbacks.current.onSelectionChange?.(seats),
        onHoldChange: (hold, seats, handoff) => callbacks.current.onHoldChange?.(hold, seats, handoff),
        onHoldExpired: () => callbacks.current.onHoldExpired?.(),
        onHoldRestored: (hold, seats, handoff) => callbacks.current.onHoldRestored?.(hold, seats, handoff),
        onError: (err) => callbacks.current.onError?.(err),
        // Sales Channels. The provider is read through the ref for the same
        // reason as every other callback: a host may pass an inline arrow.
        buyerAccessTokenProvider: options.buyerAccessTokenProvider
          ? (context) => callbacks.current.buyerAccessTokenProvider!(context)
          : undefined,
        onAccessExpired: (state) => callbacks.current.onAccessExpired?.(state),
        onAccessUnavailable: (state) => callbacks.current.onAccessUnavailable?.(state),
        onSelectedObjectUnavailable: (state) =>
          callbacks.current.onSelectedObjectUnavailable?.(state),
        // Hosted checkout. Read through the ref like every other callback — the
        // spread above would freeze an inline arrow at construction, and these
        // two fire long after it (a payment webhook can land minutes later).
        onCheckoutUnavailable: (state) => callbacks.current.onCheckoutUnavailable?.(state),
        onOrderConfirmed: (order) => callbacks.current.onOrderConfirmed?.(order),
      });
      pickerRef.current = picker;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (pickerRef.current === picker) pickerRef.current = null;
        picker.close();
      };
      closeRef.current = close;
      void picker.render();

      return () => {
        if (!closed) picker.destroy();
        if (pickerRef.current === picker) pickerRef.current = null;
        if (closeRef.current === close) closeRef.current = null;
      };
      // Rebuild only when the identity of the event/config changes. Object-valued
      // options (theme, messages, pricing, transport) stay out: hosts routinely
      // pass them as inline literals, so a new identity every render would tear
      // the widget down mid-selection. They are read fresh at construction.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event, apiBase, maxSelection, publicKey, locale, currency, colorblindSafe, hideBadge, holdTtlMs, initialHoldId, restoreHold, confirmSelection, seatView, checkout]);

    useImperativeHandle(
      ref,
      (): SeatPickerHandle => ({
        close: () => closeRef.current?.(),
        getSelection: () => pickerRef.current?.getSelection() ?? [],
        bestAvailable: (qty, categoryKey, options) =>
          pickerRef.current?.bestAvailable(qty, categoryKey, options) ?? Promise.resolve(null),
        getCurrentHold: () => pickerRef.current?.getCurrentHold() ?? null,
        resumeHold: (holdId) => pickerRef.current?.resumeHold(holdId) ?? Promise.resolve(null),
        removeHeldTicket: (label) => pickerRef.current?.removeHeldTicket(label) ?? Promise.resolve(false),
        release: () => pickerRef.current?.release() ?? Promise.resolve(),
        refreshAccess: () => pickerRef.current?.refreshAccess() ?? Promise.resolve(false),
        setMapTheme: (map) => pickerRef.current?.setMapTheme(map),
        setEventDetailsHidden: (hidden) => pickerRef.current?.setEventDetailsHidden(hidden),
        setPricing: (pricing) => pickerRef.current?.setPricing(pricing),
        isColorblindSafe: () => pickerRef.current?.isColorblindSafe() ?? false,
        setColorblindSafe: (on) => pickerRef.current?.setColorblindSafe(on),
        setViewMode: (mode) => pickerRef.current?.setViewMode(mode),
        getViewMode: () => pickerRef.current?.getViewMode() ?? 'flat',
        getBuyerView: () => pickerRef.current?.getBuyerView() ?? 'map',
        setBuyerView: (view, options) => pickerRef.current?.setBuyerView(view, options),
      }),
      [],
    );

    return <div ref={containerRef} className={className} style={style} />;
  },
);
