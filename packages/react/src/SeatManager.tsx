import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import {
  SeatManager as CoreSeatManager,
  type SeatManagerOptions,
  type SeatManagerMode,
  type SeatManagerTallies,
  type SeatManagerActivity,
  type SeatManagerActionResult,
  type ReportResult,
  type LogEntry,
  type ExpandedSeat,
} from '@seatlayer/js';

export type {
  SeatManagerOptions,
  SeatManagerMode,
  SeatManagerTallies,
  SeatManagerActivity,
  SeatManagerActionResult,
} from '@seatlayer/js';

/** Imperative handle for the organizer manage board. */
export interface SeatManagerHandle {
  setMode(mode: SeatManagerMode): void;
  block(labels?: string[], opts?: { releaseAt?: number; reason?: string }): Promise<void>;
  unblock(labels?: string[]): Promise<void>;
  unblockAll(): Promise<void>;
  cancelBooking(labels: string[], bookingRef: string): Promise<void>;
  selectAll(): ExpandedSeat[];
  selectSection(sectionId: string): ExpandedSeat[];
  selectByLabels(labels: string[]): ExpandedSeat[];
  clearSelection(): void;
  getSelection(): ExpandedSeat[];
  getReport(): Promise<ReportResult>;
  getLog(opts?: { limit?: number; before?: number }): Promise<{ entries: LogEntry[]; nextBefore: number | null }>;
  setHoldTtl(ms: number | null): Promise<void>;
  zoomToFit(): void;
}

export interface SeatManagerProps extends Omit<SeatManagerOptions, 'container'> {
  className?: string;
  style?: CSSProperties;
}

/**
 * React wrapper around the framework-agnostic {@link CoreSeatManager}. Give the
 * wrapping div a size (it fills its box — a war-room board wants a big one) and
 * the manager lays out the live map + KPI bar + rails inside it. Rebuilt only
 * when the event identity / apiBase / token changes; callbacks are always read
 * live without tearing the board down.
 */
export const SeatManager = forwardRef<SeatManagerHandle, SeatManagerProps>(
  function SeatManager(props, ref) {
    const { className, style, apiBase, eventKey, token, mode, currency, keepLiveWhileHidden } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const managerRef = useRef<CoreSeatManager | null>(null);

    const callbacks = useRef(props);
    callbacks.current = props;

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const manager = new CoreSeatManager({
        container: el,
        apiBase,
        eventKey,
        token,
        mode,
        currency,
        keepLiveWhileHidden,
        theme: callbacks.current.theme,
        onReady: () => callbacks.current.onReady?.(),
        onTallies: (t: SeatManagerTallies) => callbacks.current.onTallies?.(t),
        onSelectionChange: (s: ExpandedSeat[]) => callbacks.current.onSelectionChange?.(s),
        onActionComplete: (r: SeatManagerActionResult) => callbacks.current.onActionComplete?.(r),
        onError: (e: unknown) => callbacks.current.onError?.(e),
      });
      managerRef.current = manager;
      void manager.render();

      return () => {
        manager.destroy();
        managerRef.current = null;
      };
      // Rebuild only on identity change (not on every callback change).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiBase, eventKey, token]);

    // Reflect a controlled `mode` prop onto the live instance without rebuilding.
    useEffect(() => {
      if (mode) managerRef.current?.setMode(mode);
    }, [mode]);

    useImperativeHandle(
      ref,
      (): SeatManagerHandle => ({
        setMode: (m) => managerRef.current?.setMode(m),
        block: (labels, opts) => managerRef.current?.block(labels, opts) ?? Promise.resolve(),
        unblock: (labels) => managerRef.current?.unblock(labels) ?? Promise.resolve(),
        unblockAll: () => managerRef.current?.unblockAll() ?? Promise.resolve(),
        cancelBooking: (labels, bookingRef) => managerRef.current?.cancelBooking(labels, bookingRef) ?? Promise.resolve(),
        selectAll: () => managerRef.current?.selectAll() ?? [],
        selectSection: (id) => managerRef.current?.selectSection(id) ?? [],
        selectByLabels: (labels) => managerRef.current?.selectByLabels(labels) ?? [],
        clearSelection: () => managerRef.current?.clearSelection(),
        getSelection: () => managerRef.current?.getSelection() ?? [],
        getReport: () => managerRef.current?.getReport() ?? Promise.reject(new Error('not ready')),
        getLog: (opts) => managerRef.current?.getLog(opts) ?? Promise.resolve({ entries: [], nextBefore: null }),
        setHoldTtl: (ms) => managerRef.current?.setHoldTtl(ms) ?? Promise.resolve(),
        zoomToFit: () => managerRef.current?.zoomToFit(),
      }),
      [],
    );

    return <div ref={containerRef} className={className} style={style} />;
  },
);
