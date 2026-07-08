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
} from '@seatlayer/js';

export type { SelectedSeat, HoldResult, BestAvailableResult } from '@seatlayer/js';

/** Imperative handle exposed via `ref` — call these to drive the picker from your app. */
export interface SeatingChartHandle {
  /** Hold the current selection. Resolves the hold, or `null` on a 409 conflict. */
  hold(): Promise<HoldResult | null>;
  /** Ask the server for the `qty` best free seats and hold them atomically. */
  bestAvailable(qty: number, categoryKey?: string): Promise<BestAvailableResult | null>;
  /** Release the current hold (if any). */
  release(): Promise<void>;
  /** The current selection, with prices resolved from the chart categories. */
  getSelection(): SelectedSeat[];
}

export interface SeatingChartProps extends Omit<SeatingChartOptions, 'container'> {
  className?: string;
  style?: CSSProperties;
}

/**
 * React wrapper around the framework-agnostic `@seatlayer/js` SDK.
 *
 * The underlying canvas is created once and torn down on unmount. Callback props
 * (`onSelectionChange`, `onHold`, `onError`) may change freely between renders
 * without re-mounting the canvas — only `event`, `apiBase`, `maxSelection`, and
 * `publicKey` trigger a rebuild.
 */
export const SeatingChart = forwardRef<SeatingChartHandle, SeatingChartProps>(
  function SeatingChart(props, ref) {
    const { className, style, event, apiBase, maxSelection, publicKey } = props;

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
        onSelectionChange: (seats) => callbacks.current.onSelectionChange?.(seats),
        onHold: (result) => callbacks.current.onHold?.(result),
        onError: (err) => callbacks.current.onError?.(err),
      });
      chartRef.current = chart;
      void chart.render();

      return () => {
        chart.destroy();
        chartRef.current = null;
      };
      // Rebuild only when the identity of the chart changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event, apiBase, maxSelection, publicKey]);

    useImperativeHandle(
      ref,
      (): SeatingChartHandle => ({
        hold: () => chartRef.current?.hold() ?? Promise.resolve(null),
        bestAvailable: (qty, categoryKey) =>
          chartRef.current?.bestAvailable(qty, categoryKey) ?? Promise.resolve(null),
        release: () => chartRef.current?.release() ?? Promise.resolve(),
        getSelection: () => chartRef.current?.getSelection() ?? [],
      }),
      [],
    );

    return <div ref={containerRef} className={className} style={style} />;
  },
);
