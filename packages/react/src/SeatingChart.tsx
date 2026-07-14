import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import {
  SeatingChart as CoreSeatingChart,
  type SeatingChartOptions,
  type SelectedSeat,
  type HoldResult,
  type BestAvailableResult,
  type GAAreaAvailability,
  type HoldLineItem,
} from '@seatlayer/js';

export type { SelectedSeat, HoldResult, BestAvailableResult, GAAreaAvailability, HoldLineItem } from '@seatlayer/js';
export type { SeatHoverDetails } from '@seatlayer/js';

/** Imperative handle exposed via `ref` — call these to drive the picker from your app. */
export interface SeatingChartHandle {
  /** Hold the current selection. Resolves the hold, or `null` on a 409 conflict. */
  hold(options?: { ttlMs?: number }): Promise<HoldResult | null>;
  /** GA areas with live remaining capacity. */
  getGAAreas(): GAAreaAvailability[];
  /** Atomically hold a quantity from one GA area. */
  holdGA(areaId: string, qty: number, options?: { tierId?: string | null; ttlMs?: number }): Promise<HoldResult | null>;
  /** Ask the server for the `qty` best free seats and hold them atomically. */
  bestAvailable(qty: number, categoryKey?: string): Promise<BestAvailableResult | null>;
  /** Release the current hold (if any). */
  release(): Promise<void>;
  /** The current selection, with prices resolved from the chart categories. */
  getSelection(): SelectedSeat[];
  /**
   * Choose a ticket tier for a selected seat (e.g. Adult → Child). Available
   * `tiers` are on each `SelectedSeat`; `tierId=null` reverts to the default.
   */
  setSeatTier(seatId: string, tierId: string | null): void;
  /**
   * Floors of a multi-floor chart — `[{ id, name }]` (single-floor charts
   * return one entry; empty before render()). Pair with setFloor().
   */
  getFloors(): { id: string; name: string }[];
  /** Switch the shown floor (2D). Warns + no-ops on single-floor charts. */
  setFloor(floorId: string): void;
  /** Toggle colorblind-safe rendering at runtime (see the `colorblindSafe` prop). */
  setColorblindSafe(on: boolean): void;
}

export interface SeatingChartProps extends Omit<SeatingChartOptions, 'container'> {
  className?: string;
  style?: CSSProperties;
}

/**
 * React wrapper around the framework-agnostic `@seatlayer/js` SDK.
 *
 * The underlying canvas is created once and torn down on unmount. Callback props
 * (`onSelectionChange`, `onHold`, `onError`, `onDeckTap`, `onHint`) may change
 * freely between renders without re-mounting the canvas — only `event`,
 * `apiBase`, `maxSelection`, `publicKey`, `locale`, `currency`, and
 * `colorblindSafe` trigger a rebuild. (`messages` is read once per mount;
 * changing it alone does not re-apply.)
 */
export const SeatingChart = forwardRef<SeatingChartHandle, SeatingChartProps>(
  function SeatingChart(props, ref) {
    const { className, style, event, apiBase, maxSelection, publicKey, locale, currency, colorblindSafe } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<CoreSeatingChart | null>(null);

    // Always call the latest callbacks without rebuilding the chart.
    const callbacks = useRef(props);
    callbacks.current = props;

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const chart = new CoreSeatingChart({
        container: el,
        event,
        apiBase,
        maxSelection,
        publicKey,
        locale,
        currency,
        colorblindSafe,
        messages: callbacks.current.messages,
        onSelectionChange: (seats) => callbacks.current.onSelectionChange?.(seats),
        onHold: (result) => callbacks.current.onHold?.(result),
        onHoldExpired: () => callbacks.current.onHoldExpired?.(),
        onGAClick: (area) => callbacks.current.onGAClick?.(area),
        onError: (err) => callbacks.current.onError?.(err),
        onDeckTap: (floorId) => callbacks.current.onDeckTap?.(floorId),
        onHint: (message) => callbacks.current.onHint?.(message),
        seatTooltip: props.seatTooltip,
        onSeatHover: (details) => callbacks.current.onSeatHover?.(details),
      });
      chartRef.current = chart;
      void chart.render();

      return () => {
        chart.destroy();
        chartRef.current = null;
      };
      // Rebuild only when the identity of the chart changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event, apiBase, maxSelection, publicKey, locale, currency, colorblindSafe]);

    useImperativeHandle(
      ref,
      (): SeatingChartHandle => ({
        hold: (options) => chartRef.current?.hold(options) ?? Promise.resolve(null),
        getGAAreas: () => chartRef.current?.getGAAreas() ?? [],
        holdGA: (areaId, qty, options) => chartRef.current?.holdGA(areaId, qty, options) ?? Promise.resolve(null),
        bestAvailable: (qty, categoryKey) =>
          chartRef.current?.bestAvailable(qty, categoryKey) ?? Promise.resolve(null),
        release: () => chartRef.current?.release() ?? Promise.resolve(),
        getSelection: () => chartRef.current?.getSelection() ?? [],
        setSeatTier: (seatId, tierId) => chartRef.current?.setSeatTier(seatId, tierId),
        getFloors: () => chartRef.current?.getFloors() ?? [],
        setFloor: (floorId) => chartRef.current?.setFloor(floorId),
        setColorblindSafe: (on) => chartRef.current?.setColorblindSafe(on),
      }),
      [],
    );

    return <div ref={containerRef} className={className} style={style} />;
  },
);
