import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import {
  SeatingChart as CoreSeatingChart,
  bindSeatingChartHandle,
  buildSeatingChartOptions,
  type SeatingChartHandle,
  type SeatingChartIdentityProp,
  type SeatingChartOptions,
} from '@seatlayer/js';

export type { SelectedSeat, HoldResult, BestAvailableResult, GAAreaAvailability, HoldLineItem } from '@seatlayer/js';
export type { SeatHoverDetails } from '@seatlayer/js';

/** Imperative handle exposed via `ref` — call these to drive the picker from your app. */
export type { SeatingChartHandle } from '@seatlayer/js';

export interface SeatingChartProps extends Omit<SeatingChartOptions, 'container'> {
  className?: string;
  style?: CSSProperties;
}

/**
 * React wrapper around the framework-agnostic `@seatlayer/js` SDK.
 *
 * The underlying canvas is created once and torn down on unmount. Callback props
 * (`onSelectionChange`, `onHold`, `onError`, `onDeckTap`, `onHint`) may change
 * freely between renders without re-mounting the canvas — only the props in
 * `SEATING_CHART_IDENTITY_PROPS` (`event`, `apiBase`, `maxSelection`, `numberOfPlacesToSelect`,
 * `publicKey`, `locale`, `currency`, `colorblindSafe`, `initialView`,
 * `errorDisplay`) trigger a rebuild.
 * (`messages`, `selectedObjects`, and `selectableObjects` are read once per
 * mount; change selection policy later through the imperative handle.)
 */
export const SeatingChart = forwardRef<SeatingChartHandle, SeatingChartProps>(
  function SeatingChart(props, ref) {
    const {
      className, style, event, apiBase, maxSelection, selectedObjects, selectableObjects,
      numberOfPlacesToSelect, publicKey, locale, currency,
      colorblindSafe, initialView, errorDisplay,
    } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<CoreSeatingChart | null>(null);

    // Always call the latest callbacks without rebuilding the chart.
    const callbacks = useRef(props);
    callbacks.current = props;

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const chart = new CoreSeatingChart(buildSeatingChartOptions(
        el,
        {
          event,
          apiBase,
          maxSelection,
          selectedObjects,
          selectableObjects,
          numberOfPlacesToSelect,
          publicKey,
          locale,
          currency,
          colorblindSafe,
          initialView,
          errorDisplay,
          messages: callbacks.current.messages,
          seatTooltip: props.seatTooltip,
          // Read through the ref so a host may pass the provider as an inline
          // arrow without its new identity tearing the canvas down each render.
          buyerAccessTokenProvider: props.buyerAccessTokenProvider
            ? (context) => callbacks.current.buyerAccessTokenProvider!(context)
            : undefined,
          buyerAccessToken: callbacks.current.buyerAccessToken,
        },
        {
          onAccessExpired: (state) => callbacks.current.onAccessExpired?.(state),
          onAccessUnavailable: (state) => callbacks.current.onAccessUnavailable?.(state),
          onSelectedObjectUnavailable: (state) =>
            callbacks.current.onSelectedObjectUnavailable?.(state),
          onSelectionChange: (seats) => callbacks.current.onSelectionChange?.(seats),
          onSelectionValidityChange: (state) => callbacks.current.onSelectionValidityChange?.(state),
          onSelectionValid: (seats) => callbacks.current.onSelectionValid?.(seats),
          onSelectionInvalid: (state) => callbacks.current.onSelectionInvalid?.(state),
          onSelectionLimit: (max) => callbacks.current.onSelectionLimit?.(max),
          onHold: (result) => callbacks.current.onHold?.(result),
          onHoldRestored: (result) => callbacks.current.onHoldRestored?.(result),
          onHoldExpired: () => callbacks.current.onHoldExpired?.(),
          onGAClick: (area) => callbacks.current.onGAClick?.(area),
          onError: (err) => callbacks.current.onError?.(err),
          onDeckTap: (floorId) => callbacks.current.onDeckTap?.(floorId),
          onHint: (message) => callbacks.current.onHint?.(message),
          onSeatHover: (details) => callbacks.current.onSeatHover?.(details),
        },
      ));
      chartRef.current = chart;
      void chart.render();

      return () => {
        chart.destroy();
        chartRef.current = null;
      };
      // Rebuild only when the identity of the chart changes — this dependency
      // array is SEATING_CHART_IDENTITY_PROPS, spelled out because React's
      // linter (and its compiler) must see the literal list.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event, apiBase, maxSelection, numberOfPlacesToSelect, publicKey, locale, currency, colorblindSafe, initialView, errorDisplay]);

    useImperativeHandle(ref, () => bindSeatingChartHandle(() => chartRef.current), []);

    return <div ref={containerRef} className={className} style={style} />;
  },
);

/**
 * The `useEffect` dependency array above must list every identity prop, and
 * React's linter and compiler both require it to be a literal — so it cannot be
 * spread from `SEATING_CHART_IDENTITY_PROPS` the way Vue's watcher and Angular's
 * `ngOnChanges` do. This is the compile-time proof that the literal is still
 * complete: add a prop to the shared list without adding it above and
 * `MissingIdentityDeps` stops being `never`, which fails this line. Types only —
 * nothing here reaches the bundle.
 */
type MissingIdentityDeps = Exclude<
  SeatingChartIdentityProp,
  | 'event' | 'apiBase' | 'maxSelection' | 'numberOfPlacesToSelect'
  | 'publicKey' | 'locale'
  | 'currency' | 'colorblindSafe' | 'initialView' | 'errorDisplay'
>;
type Assert<T extends true> = T;
type _IdentityDepsAreComplete = Assert<[MissingIdentityDeps] extends [never] ? true : false>;
