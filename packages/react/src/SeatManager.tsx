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
  type EventScopedManageToken,
  type SeatManagerTallies,
  type SeatManagerActivity,
  type SeatManagerActionResult,
  type SeatManagerConnection,
  type SeatManagerFilteredSection,
  type SeatManagerSelectionValidity,
  type EventTableBookingMode,
  type ReportResult,
  type ControlRoomSnapshot,
  type LogEntry,
  type ExpandedSeat,
// `@seatlayer/js/manager`, NOT the bare `@seatlayer/js` barrel. The barrel is a
// buyer SDK that also exports the cockpit, so importing the cockpit through it
// drags SeatPicker, SeatingChart, EmbeddedDesigner and the engine code only
// those reach into every bundle that renders a control room. See the header of
// `@seatlayer/js`'s `src/manager.ts` for the measurement.
} from '@seatlayer/js/manager';

export type {
  SeatManagerOptions,
  SeatManagerMode,
  EventScopedManageToken,
  SeatManagerTallies,
  SeatManagerActivity,
  SeatManagerActionResult,
  SeatManagerConnection,
  SeatManagerFilteredSection,
  SeatManagerSelectionValidity,
  EventTableBookingMode,
} from '@seatlayer/js/manager';

/** Imperative handle for the organizer manage board. */
export interface SeatManagerHandle {
  setMode(mode: SeatManagerMode): void;
  setToken(token: EventScopedManageToken, expiresAt?: number): void;
  setHeatOverlay(enabled: boolean): void;
  setFollowLive(enabled: boolean): void;
  setTrendWindow(windowMinutes: number): Promise<ControlRoomSnapshot>;
  enterFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
  isFullscreen(): boolean;
  block(labels?: string[], opts?: { releaseAt?: number; reason?: string }): Promise<void>;
  unblock(labels?: string[]): Promise<void>;
  unblockAll(): Promise<void>;
  cancelBooking(labels: string[], bookingRef: string): Promise<void>;
  setCategory(categoryKey: string, labels?: string[]): Promise<void>;
  setTableBooking(
    tableIds: string[],
    mode: EventTableBookingMode,
    bounds?: { minOccupancy?: number; maxOccupancy?: number },
  ): Promise<void>;
  selectAll(): ExpandedSeat[];
  selectSection(sectionId: string): ExpandedSeat[];
  selectByLabels(labels: string[]): ExpandedSeat[];
  selectObjects(labels: string[]): ExpandedSeat[];
  deselectObjects(labels: string[]): ExpandedSeat[];
  selectCategories(keys: string[]): ExpandedSeat[];
  deselectCategories(keys: string[]): ExpandedSeat[];
  setSelectableObjects(labels: string[]): void;
  setUnavailableObjectsSelectable(enabled: boolean): void;
  setObjectSelectable(predicate: SeatManagerOptions['isObjectSelectable']): void;
  setMaxSelectedObjects(max: number | undefined): void;
  setNumberOfPlacesToSelect(required: number | undefined): void;
  getSelectionValidity(): SeatManagerSelectionValidity | null;
  setFilteredSection(label: string): SeatManagerFilteredSection[];
  clearFilteredSection(): void;
  getFilteredSections(): SeatManagerFilteredSection[];
  clearSelection(): void;
  getSelection(): ExpandedSeat[];
  getReport(): Promise<ReportResult>;
  getControlRoomSnapshot(windowMinutes?: number): Promise<ControlRoomSnapshot>;
  getLog(opts?: { limit?: number; before?: number }): Promise<{ entries: LogEntry[]; nextBefore: number | null }>;
  setHoldTtl(ms: number | null): Promise<void>;
  /**
   * Realtime link state plus the "as of" behind the numbers on screen.
   *
   * Null only before the manager has mounted. Pair with the `onConnectionChange`
   * prop: the callback gives the edges, this gives the answer on demand — which
   * is what a host needs on tab focus, when no transition is coming.
   */
  getConnection(): SeatManagerConnection | null;
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
 * when the event identity / apiBase changes. Tokens, declared capabilities,
 * theme, fallback currency, background liveness, and callbacks are updated in
 * place without tearing the board down.
 */
export const SeatManager = forwardRef<SeatManagerHandle, SeatManagerProps>(
  function SeatManager(props, ref) {
    const {
      className, style, apiBase, eventKey, token, tokenExpiresAt,
      mode, currency, keepLiveWhileHidden, followLive, capabilities,
      selectedObjects, selectableObjects, unavailableObjectsSelectable,
      maxSelectedObjects, numberOfPlacesToSelect, isObjectSelectable,
    } = props;

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
        tokenExpiresAt,
        mode,
        currency,
        keepLiveWhileHidden,
        followLive,
        capabilities,
        selectedObjects,
        selectableObjects,
        unavailableObjectsSelectable,
        maxSelectedObjects,
        numberOfPlacesToSelect,
        isObjectSelectable,
        theme: callbacks.current.theme,
        onReady: () => callbacks.current.onReady?.(),
        onTallies: (t: SeatManagerTallies) => callbacks.current.onTallies?.(t),
        onActivity: (activity: SeatManagerActivity) => callbacks.current.onActivity?.(activity),
        onControlRoom: (snapshot: ControlRoomSnapshot) => callbacks.current.onControlRoom?.(snapshot),
        onTokenRefresh: callbacks.current.onTokenRefresh ? async () => callbacks.current.onTokenRefresh!() : undefined,
        onModeChange: (nextMode) => callbacks.current.onModeChange?.(nextMode),
        onFollowLiveChange: (enabled) => callbacks.current.onFollowLiveChange?.(enabled),
        onSelectionChange: (s: ExpandedSeat[]) => callbacks.current.onSelectionChange?.(s),
        onObjectSelected: (object) => callbacks.current.onObjectSelected?.(object),
        onObjectDeselected: (object) => callbacks.current.onObjectDeselected?.(object),
        onSelectionValidityChange: (state) => callbacks.current.onSelectionValidityChange?.(state),
        onSelectionValid: (state) => callbacks.current.onSelectionValid?.(state),
        onSelectionInvalid: (state) => callbacks.current.onSelectionInvalid?.(state),
        onSelectionLimit: (max) => callbacks.current.onSelectionLimit?.(max),
        onFilteredSectionChange: (sections) => callbacks.current.onFilteredSectionChange?.(sections),
        onActionComplete: (r: SeatManagerActionResult) => callbacks.current.onActionComplete?.(r),
        onConnectionChange: (s: SeatManagerConnection) => callbacks.current.onConnectionChange?.(s),
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
    }, [apiBase, eventKey]);

    // Rotate credentials without losing camera, selection, realtime state or DOM.
    useEffect(() => {
      managerRef.current?.setToken(token, tokenExpiresAt);
    }, [token, tokenExpiresAt]);

    useEffect(() => {
      managerRef.current?.setCapabilities(capabilities);
    }, [capabilities]);

    useEffect(() => {
      managerRef.current?.setCurrency(currency);
    }, [currency]);

    useEffect(() => {
      managerRef.current?.setTheme(props.theme);
    }, [props.theme]);

    useEffect(() => {
      managerRef.current?.setKeepLiveWhileHidden(keepLiveWhileHidden);
    }, [keepLiveWhileHidden]);

    useEffect(() => {
      managerRef.current?.setTokenRefresh(
        props.onTokenRefresh ? async () => callbacks.current.onTokenRefresh!() : undefined,
      );
    }, [!!props.onTokenRefresh]);

    // Reflect a controlled `mode` prop onto the live instance without rebuilding.
    useEffect(() => {
      if (mode) managerRef.current?.setMode(mode);
    }, [mode]);

    useEffect(() => {
      if (followLive != null) managerRef.current?.setFollowLive(followLive);
    }, [followLive]);

    useEffect(() => {
      managerRef.current?.setSelectableObjects(selectableObjects ?? []);
    }, [selectableObjects]);

    useEffect(() => {
      managerRef.current?.setUnavailableObjectsSelectable(unavailableObjectsSelectable ?? true);
    }, [unavailableObjectsSelectable]);

    useEffect(() => {
      managerRef.current?.setMaxSelectedObjects(maxSelectedObjects);
    }, [maxSelectedObjects]);

    useEffect(() => {
      managerRef.current?.setNumberOfPlacesToSelect(numberOfPlacesToSelect);
    }, [numberOfPlacesToSelect]);

    useEffect(() => {
      managerRef.current?.setObjectSelectable(isObjectSelectable);
    }, [isObjectSelectable]);

    useImperativeHandle(
      ref,
      (): SeatManagerHandle => ({
        setMode: (m) => managerRef.current?.setMode(m),
        setToken: (nextToken, expiresAt) => managerRef.current?.setToken(nextToken, expiresAt),
        setHeatOverlay: (enabled) => managerRef.current?.setHeatOverlay(enabled),
        setFollowLive: (enabled) => managerRef.current?.setFollowLive(enabled),
        setTrendWindow: (windowMinutes) => managerRef.current?.setTrendWindow(windowMinutes)
          ?? Promise.reject(new Error('not ready')),
        enterFullscreen: () => managerRef.current?.enterFullscreen() ?? Promise.resolve(),
        exitFullscreen: () => managerRef.current?.exitFullscreen() ?? Promise.resolve(),
        isFullscreen: () => managerRef.current?.isFullscreen() ?? false,
        block: (labels, opts) => managerRef.current?.block(labels, opts) ?? Promise.resolve(),
        unblock: (labels) => managerRef.current?.unblock(labels) ?? Promise.resolve(),
        unblockAll: () => managerRef.current?.unblockAll() ?? Promise.resolve(),
        cancelBooking: (labels, bookingRef) => managerRef.current?.cancelBooking(labels, bookingRef) ?? Promise.resolve(),
        setCategory: (categoryKey, labels) => managerRef.current?.setCategory(categoryKey, labels) ?? Promise.resolve(),
        setTableBooking: (tableIds, nextMode, bounds) => managerRef.current?.setTableBooking(tableIds, nextMode, bounds)
          ?? Promise.resolve(),
        selectAll: () => managerRef.current?.selectAll() ?? [],
        selectSection: (id) => managerRef.current?.selectSection(id) ?? [],
        selectByLabels: (labels) => managerRef.current?.selectByLabels(labels) ?? [],
        selectObjects: (labels) => managerRef.current?.selectObjects(labels) ?? [],
        deselectObjects: (labels) => managerRef.current?.deselectObjects(labels) ?? [],
        selectCategories: (keys) => managerRef.current?.selectCategories(keys) ?? [],
        deselectCategories: (keys) => managerRef.current?.deselectCategories(keys) ?? [],
        setSelectableObjects: (labels) => managerRef.current?.setSelectableObjects(labels),
        setUnavailableObjectsSelectable: (enabled) => managerRef.current?.setUnavailableObjectsSelectable(enabled),
        setObjectSelectable: (predicate) => managerRef.current?.setObjectSelectable(predicate),
        setMaxSelectedObjects: (max) => managerRef.current?.setMaxSelectedObjects(max),
        setNumberOfPlacesToSelect: (required) => managerRef.current?.setNumberOfPlacesToSelect(required),
        getSelectionValidity: () => managerRef.current?.getSelectionValidity() ?? null,
        setFilteredSection: (label) => managerRef.current?.setFilteredSection(label) ?? [],
        clearFilteredSection: () => managerRef.current?.clearFilteredSection(),
        getFilteredSections: () => managerRef.current?.getFilteredSections() ?? [],
        clearSelection: () => managerRef.current?.clearSelection(),
        getSelection: () => managerRef.current?.getSelection() ?? [],
        getReport: () => managerRef.current?.getReport() ?? Promise.reject(new Error('not ready')),
        getControlRoomSnapshot: (windowMinutes) => managerRef.current?.getControlRoomSnapshot(windowMinutes)
          ?? Promise.reject(new Error('not ready')),
        getLog: (opts) => managerRef.current?.getLog(opts) ?? Promise.resolve({ entries: [], nextBefore: null }),
        getConnection: () => managerRef.current?.getConnection() ?? null,
        setHoldTtl: (ms) => managerRef.current?.setHoldTtl(ms) ?? Promise.resolve(),
        zoomToFit: () => managerRef.current?.zoomToFit(),
      }),
      [],
    );

    return <div ref={containerRef} className={className} style={style} />;
  },
);
