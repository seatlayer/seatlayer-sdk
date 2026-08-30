import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import {
  SeasonPicker as CoreSeasonPicker,
  type SeasonAvailability,
  type SeasonCheckoutHandoff,
  type SeasonDescriptor,
  type SeasonPickerOptions as CoreSeasonPickerOptions,
  type SeasonRenewalIntent,
  type RendererViewMode,
  type SeatPickerTheme,
} from '@seatlayer/js';

export type {
  SeasonAvailability,
  SeasonCheckoutHandoff,
  SeasonDescriptor,
  SeasonOperation,
  SeasonOperationState,
  SeasonRenewalIntent,
  SeasonStatusEvent,
} from '@seatlayer/js';

/** Display-only commercial context; the host must re-price on its server. */
export interface SeasonOfferPresentation {
  eyebrow?: string;
  priceLabel?: string;
  compareAtPriceLabel?: string;
  savingsLabel?: string;
  priceNote?: string;
  benefits?: readonly string[];
  renewalLabel?: string;
}

/** Forward-compatible wrapper options for the interactive Season buyer flow. */
export interface SeasonPickerOptions extends CoreSeasonPickerOptions {
  offer?: SeasonOfferPresentation;
  maxSelection?: number;
  numberOfPlacesToSelect?: number;
  locale?: string;
  initialView?: RendererViewMode;
  enable3D?: boolean;
  theme?: SeatPickerTheme;
}

/** Imperative controls for the fixed-inclusion Season buyer flow. */
export interface SeasonPickerHandle {
  holdSameSeat(labels: readonly string[], operationId: string): Promise<SeasonCheckoutHandoff>;
  restoreOperation(operationId: string): Promise<SeasonCheckoutHandoff | null>;
  release(releaseActionId: string): Promise<void>;
  createRenewalIntent(offerId: string): Promise<SeasonRenewalIntent>;
  getDescriptor(): SeasonDescriptor | null;
  getAvailability(): SeasonAvailability | null;
  getHandoff(): SeasonCheckoutHandoff | null;
}

/** Props accepted by the React Season wrapper. */
export interface SeasonPickerProps extends Omit<SeasonPickerOptions, 'container'> {
  className?: string;
  style?: CSSProperties;
}

/**
 * React lifecycle adapter for the distinct fixed-inclusion `SeasonPicker`.
 * It never receives a secret key and never turns a browser handoff into proof
 * of price, payment, booking, or renewal.
 */
export const SeasonPicker = forwardRef<SeasonPickerHandle, SeasonPickerProps>(
  function SeasonPicker(props, ref) {
    const {
      season,
      apiBase,
      buyerAccessToken,
      initialOperationId,
      recoveryTimeoutMs,
      fetch,
      offer,
      maxSelection,
      numberOfPlacesToSelect,
      locale,
      initialView,
      enable3D,
      theme,
      className,
      style,
    } = props;
    const containerRef = useRef<HTMLDivElement | null>(null);
    const pickerRef = useRef<CoreSeasonPicker | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const offerKey = JSON.stringify(offer ?? null);
    const themeKey = JSON.stringify(theme ?? null);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const { className: _className, style: _style, ...options } = latest.current;
      const picker = new CoreSeasonPicker({
        ...options,
        container,
        buyerAccessTokenProvider: options.buyerAccessTokenProvider
          ? (context) => latest.current.buyerAccessTokenProvider!(context)
          : undefined,
        onHold: (handoff) => latest.current.onHold?.(handoff),
        onHoldChange: (handoff) => latest.current.onHoldChange?.(handoff),
        onContinue: (handoff) => latest.current.onContinue?.(handoff),
        onRenewalIntent: (intent) => latest.current.onRenewalIntent?.(intent),
        onAccessExpired: (event) => latest.current.onAccessExpired?.(event),
        onAccessUnavailable: (event) => latest.current.onAccessUnavailable?.(event),
        onStatusChange: (event) => latest.current.onStatusChange?.(event),
        onError: (error) => latest.current.onError?.(error),
      });
      pickerRef.current = picker;
      void picker.render().catch(() => undefined);

      return () => {
        picker.destroy();
        if (pickerRef.current === picker) pickerRef.current = null;
      };
    }, [
      season,
      apiBase,
      buyerAccessToken,
      initialOperationId,
      recoveryTimeoutMs,
      fetch,
      offerKey,
      maxSelection,
      numberOfPlacesToSelect,
      locale,
      initialView,
      enable3D,
      themeKey,
    ]);

    useImperativeHandle(ref, (): SeasonPickerHandle => ({
      holdSameSeat: (labels, operationId) => required(pickerRef).holdSameSeat(labels, operationId),
      restoreOperation: (operationId) => required(pickerRef).restoreOperation(operationId),
      release: (releaseActionId) => required(pickerRef).release(releaseActionId),
      createRenewalIntent: (offerId) => required(pickerRef).createRenewalIntent(offerId),
      getDescriptor: () => pickerRef.current?.getDescriptor() ?? null,
      getAvailability: () => pickerRef.current?.getAvailability() ?? null,
      getHandoff: () => pickerRef.current?.getHandoff() ?? null,
    }), []);

    return <div ref={containerRef} className={className} style={style} />;
  },
);

function required(ref: { current: CoreSeasonPicker | null }): CoreSeasonPicker {
  if (!ref.current) throw new Error('seatlayer: React SeasonPicker is not mounted');
  return ref.current;
}
