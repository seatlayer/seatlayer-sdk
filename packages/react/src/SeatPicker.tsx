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
  type SelectedSeat,
  type HoldResult,
} from '@seatlayer/js';

export type { SeatPickerOptions, SeatPickerTheme, CheckoutHandoff, CheckoutLineItem } from '@seatlayer/js';

/** Imperative handle for the full-experience picker widget. */
export interface SeatPickerHandle {
  /** Current selection with resolved prices. */
  getSelection(): SelectedSeat[];
  /** Server-side best seats + hold, reflected in the widget tray. */
  bestAvailable(qty: number, categoryKey?: string): Promise<HoldResult | null>;
  /** Current active/restored hold reflected in the tray. */
  getCurrentHold(): HoldResult | null;
  /** Restore an active hold by its opaque id. */
  resumeHold(holdId: string): Promise<HoldResult | null>;
  /** Remove one held ticket while preserving the remainder. */
  removeHeldTicket(label: string): Promise<boolean>;
  /** Release the current hold (if any) and reset the tray. */
  release(): Promise<void>;
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
    const { className, style, event, apiBase, maxSelection, publicKey, locale, currency, colorblindSafe, hideBadge, holdTtlMs, initialHoldId, restoreHold, confirmSelection, seatView } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const pickerRef = useRef<CoreSeatPicker | null>(null);

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
      });
      pickerRef.current = picker;
      void picker.render();

      return () => {
        picker.destroy();
        pickerRef.current = null;
      };
      // Rebuild only when the identity of the event/config changes. Object-valued
      // options (theme, messages, pricing, transport) stay out: hosts routinely
      // pass them as inline literals, so a new identity every render would tear
      // the widget down mid-selection. They are read fresh at construction.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event, apiBase, maxSelection, publicKey, locale, currency, colorblindSafe, hideBadge, holdTtlMs, initialHoldId, restoreHold, confirmSelection, seatView]);

    useImperativeHandle(
      ref,
      (): SeatPickerHandle => ({
        getSelection: () => pickerRef.current?.getSelection() ?? [],
        bestAvailable: (qty, categoryKey) => pickerRef.current?.bestAvailable(qty, categoryKey) ?? Promise.resolve(null),
        getCurrentHold: () => pickerRef.current?.getCurrentHold() ?? null,
        resumeHold: (holdId) => pickerRef.current?.resumeHold(holdId) ?? Promise.resolve(null),
        removeHeldTicket: (label) => pickerRef.current?.removeHeldTicket(label) ?? Promise.resolve(false),
        release: () => pickerRef.current?.release() ?? Promise.resolve(),
      }),
      [],
    );

    return <div ref={containerRef} className={className} style={style} />;
  },
);
