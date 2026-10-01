import {
  defineComponent,
  h,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type ExtractPublicPropTypes,
  type PropType,
  type Ref,
} from 'vue';
import {
  SeatManager as CoreSeatManager,
  type SeatManagerOptions,
  type SeatManagerMode,
  type EventScopedManageToken,
  type SeatManagerTallies,
  type SeatManagerActivity,
  type SeatManagerActionResult,
  type SeatManagerArea,
  type SeatManagerConnection,
  type SeatManagerRoomState,
  type SeatManagerFilteredSection,
  type SeatManagerSelectionValidity,
  type SeatManagerCategoryPrice,
  type EventTableBookingMode,
  type ReportResult,
  type ControlRoomSnapshot,
  type LogEntry,
  type ExpandedSeat,
// `@seatlayer/js/manager`, NOT the bare `@seatlayer/js` barrel. The barrel is the
// buyer SDK and also exports the cockpit, so importing the cockpit through it
// would pull SeatPicker, SeatingChart and the buyer engine into every bundle
// that renders a control room. One bare import anywhere in this graph undoes the
// split, and it looks like nothing at all in a diff.
} from '@seatlayer/js/manager';

/**
 * What `ref="manager"` gives you — call these to drive the control room.
 *
 * The same methods as `SeatManagerHandle` in `@seatlayer/react`, so the two
 * wrappers read the same in docs and in code.
 */
export interface SeatManagerExposed {
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
  /** Replace the labels shown as unavailable (and their hover word) without remounting. */
  setUnavailableObjects(labels: readonly string[], reason?: string): void;
  /** Replace the prices the map's hover shows: a map overrides, null hides, undefined uses the chart's. */
  setCategoryPrices(prices: Record<string, SeatManagerCategoryPrice> | null | undefined): void;
  setObjectSelectable(predicate: SeatManagerOptions['isObjectSelectable']): void;
  setMaxSelectedObjects(max: number | undefined): void;
  setNumberOfPlacesToSelect(required: number | undefined): void;
  getSelectionValidity(): SeatManagerSelectionValidity | null;
  setFilteredSection(label: string): SeatManagerFilteredSection[];
  clearFilteredSection(): void;
  /** Frame matching sections in any mode, without filtering or touching the selection. */
  focusSection(label: string): SeatManagerFilteredSection[];
  getFilteredSections(): SeatManagerFilteredSection[];
  clearSelection(): void;
  getSelection(): ExpandedSeat[];
  getReport(): Promise<ReportResult>;
  getControlRoomSnapshot(windowMinutes?: number): Promise<ControlRoomSnapshot>;
  getLog(opts?: { limit?: number; before?: number }): Promise<{ entries: LogEntry[]; nextBefore: number | null }>;
  setHoldTtl(ms: number | null): Promise<void>;
  /**
   * Realtime link state plus the "as of" behind the numbers on screen. Null
   * only before the manager has mounted. Pair with `@connection-change`: the
   * event gives the edges, this gives the answer on demand.
   */
  getConnection(): SeatManagerConnection | null;
  zoomToFit(): void;
  /** Light these seats and frame them, named in the legend; null clears. */
  showObjects(labels: readonly string[] | null, name?: string): void;
}

/** The same handle under React's name, for code shared between the two. */
export type SeatManagerHandle = SeatManagerExposed;

type Opt<K extends keyof SeatManagerOptions> = SeatManagerOptions[K];

const seatManagerProps = {
  /** Event to manage. Changing it rebuilds the board. */
  eventKey: { type: String, required: true },
  /** API base URL. Changing it rebuilds the board. */
  apiBase: { type: String, default: undefined },
  /** Short-lived, event-scoped `mse_` grant from your backend. Live. */
  token: { type: String as PropType<EventScopedManageToken>, required: true },
  /** When `token` expires, epoch ms. Live. */
  tokenExpiresAt: { type: Number, default: undefined },
  /** Mint a fresh grant before the current one expires. Live. */
  onTokenRefresh: { type: Function as PropType<Opt<'onTokenRefresh'>>, default: undefined },
  /** The tool the board shows. Live. */
  mode: { type: String as PropType<SeatManagerMode>, default: undefined },
  /** Which tools the board offers. Read once. */
  tools: { type: Array as PropType<SeatManagerMode[]>, default: undefined },
  /** `minimal` shows just the map. Read once. */
  chrome: { type: String as PropType<Opt<'chrome'>>, default: undefined },
  /** What the token may do. Live. */
  capabilities: { type: Array as PropType<Opt<'capabilities'>>, default: undefined },
  /** Fallback currency for money. Live. */
  currency: { type: String, default: undefined },
  /** Colour overrides. Live. */
  theme: { type: Object as PropType<Opt<'theme'>>, default: undefined },
  /** `light`, `dark` or `auto`. Applied before first paint, then live. */
  themeMode: { type: String as PropType<Opt<'themeMode'>>, default: undefined },
  /** Keep the realtime link open while the tab is hidden. Live. */
  keepLiveWhileHidden: { type: Boolean, default: undefined },
  /** Follow new bookings on the map. Live. */
  followLive: { type: Boolean, default: undefined },
  /** Seats selected once the board loads. Read once. */
  selectedObjects: { type: Array as PropType<string[]>, default: undefined },
  /** Seats the operator may select. Live. */
  selectableObjects: { type: Array as PropType<string[]>, default: undefined },
  /** Whether unavailable seats can be selected. Live. */
  unavailableObjectsSelectable: { type: Boolean, default: undefined },
  /** Seats shown as unavailable. Live. */
  unavailableObjects: { type: Array as PropType<readonly string[]>, default: undefined },
  /** The hover word for `unavailableObjects`. Live. */
  unavailableObjectsReason: { type: String, default: undefined },
  /** Prices the map's hover shows: a map overrides, null hides. Live. */
  categoryPrices: {
    type: Object as PropType<Record<string, SeatManagerCategoryPrice> | null>,
    default: undefined,
  },
  /** Cap on the selection. Live. */
  maxSelectedObjects: { type: Number, default: undefined },
  /** Exact count a valid selection needs. Live. */
  numberOfPlacesToSelect: { type: Number, default: undefined },
  /** Per-seat selectability rule. Live. */
  isObjectSelectable: { type: Function as PropType<Opt<'isObjectSelectable'>>, default: undefined },
  /** False when your own header shows the numbers. Read once. */
  kpis: { type: Boolean, default: undefined },
  /** The event's clock for every time the room shows. Read once. */
  timeZone: { type: String, default: undefined },
  /** Shown in "Ask an admin of …". Read once. */
  organizationName: { type: String, default: undefined },
  /** What you know about the sale. Live, compared by value. */
  sale: { type: Object as PropType<Opt<'sale'>>, default: undefined },
  /** Room your own overlays take over the map, in px. Live, compared by value. */
  mapInsets: { type: Object as PropType<Opt<'mapInsets'>>, default: undefined },
  /** What the map's colours mean when the room opens. Read once. */
  colourBy: { type: String as PropType<Opt<'colourBy'>>, default: undefined },
  /** Open on this section. Read once. */
  focusSection: { type: String, default: undefined },
  /** Open on this seat. Read once. */
  focusSeat: { type: String, default: undefined },
  /** Open on these seats (an order's seats). Read once. */
  focusSeats: { type: Array as PropType<string[]>, default: undefined },
  /** Open on this category. Read once. */
  focusCategory: { type: String, default: undefined },
  /** Where the operator came from, for the way back. Read once. */
  arrivedFrom: { type: Object as PropType<Opt<'arrivedFrom'>>, default: undefined },
  /** Open one of your orders. Only when given does the room offer "Open order". */
  onOpenOrder: { type: Function as PropType<Opt<'onOpenOrder'>>, default: undefined },
  /** Open your trend view for a number. Only when given does the room link to it. */
  onOpenTrend: { type: Function as PropType<Opt<'onOpenTrend'>>, default: undefined },
} as const;

/**
 * The props `SeatManager` takes: every `SeatManagerOptions` field except
 * `container` and the callbacks that are Vue events.
 */
export type SeatManagerProps = ExtractPublicPropTypes<typeof seatManagerProps>;

/**
 * Vue 3 wrapper around the organizer control room from `@seatlayer/js/manager`.
 *
 * Give the component a size (it fills its box) and the manager lays out the
 * live map, the numbers and the rails inside it. It is rebuilt only when
 * `eventKey` or `apiBase` changes. Token, capabilities, theme, currency, sale
 * facts, map insets, selection rules and liveness are updated in place, so a
 * parent re-render never tears down a live board. The same props are live as
 * in `@seatlayer/react`; every other option is read once when the board is built.
 *
 * Callbacks that only report something are Vue events (`@room-state-change`).
 * Three are props, because the room needs to know whether you passed one or
 * needs a value back: `onTokenRefresh` returns the new token, and the room only
 * offers "Open order" and the trend link when `onOpenOrder` / `onOpenTrend` are
 * given. Vue routes `@open-order="fn"` to the `onOpenOrder` prop, so both
 * spellings work.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { ref } from 'vue';
 * import { SeatManager, type SeatManagerExposed } from '@seatlayer/vue/manager';
 *
 * const manager = ref<SeatManagerExposed | null>(null);
 * </script>
 *
 * <template>
 *   <SeatManager
 *     ref="manager"
 *     event-key="ev_9f3a"
 *     :token="session.token"
 *     :token-expires-at="session.expiresAt"
 *     :on-token-refresh="mintManageSession"
 *     style="width: 100%; height: calc(100vh - 96px)"
 *     @room-state-change="onRoomState"
 *   />
 * </template>
 * ```
 */
export const SeatManager = defineComponent({
  name: 'SeatLayerSeatManager',

  props: seatManagerProps,

  emits: {
    /** The board has loaded. */
    ready: () => true,
    /** Live numbers changed. */
    tallies: (_tallies: SeatManagerTallies) => true,
    /** Something happened on the event. */
    activity: (_activity: SeatManagerActivity) => true,
    /** A fresh control room snapshot. */
    'control-room': (_snapshot: ControlRoomSnapshot) => true,
    /** The operator switched tools. */
    'mode-change': (_mode: SeatManagerMode) => true,
    /** Follow-live was switched on or off. */
    'follow-live-change': (_enabled: boolean) => true,
    /** The selection changed. */
    'selection-change': (_seats: ExpandedSeat[]) => true,
    /** One seat was selected. */
    'object-selected': (_object: ExpandedSeat) => true,
    /** One seat was deselected. */
    'object-deselected': (_object: ExpandedSeat) => true,
    /** Exact-count state changed. */
    'selection-validity-change': (_state: SeatManagerSelectionValidity) => true,
    /** The selection became valid. */
    'selection-valid': (_state: SeatManagerSelectionValidity) => true,
    /** The selection became invalid. */
    'selection-invalid': (_state: SeatManagerSelectionValidity) => true,
    /** The selection cap was reached. */
    'selection-limit': (_max: number) => true,
    /** The filtered sections changed. */
    'filtered-section-change': (_sections: SeatManagerFilteredSection[]) => true,
    /** A general-admission area was clicked. */
    'area-click': (_area: SeatManagerArea) => true,
    /** A block, unblock or other action finished. */
    'action-complete': (_result: SeatManagerActionResult) => true,
    /** The realtime link changed state. */
    'connection-change': (_state: SeatManagerConnection) => true,
    /** The room changed state: connecting, live, paused, offline or ended. */
    'room-state-change': (_state: SeatManagerRoomState) => true,
    /** Something failed. */
    error: (_error: unknown) => true,
  },

  setup(props, { emit, expose }) {
    const container: Ref<HTMLDivElement | null> = ref(null);
    // shallowRef: the manager owns a canvas and a large scene graph; a deep
    // reactive proxy would have Vue walk all of it on every touch.
    const manager = shallowRef<CoreSeatManager | null>(null);

    const destroy = () => {
      manager.value?.destroy();
      manager.value = null;
    };

    // The three function props are read through `props` at call time, so a host
    // that swaps its handler never has to rebuild the board.
    const tokenRefresh = (): Opt<'onTokenRefresh'> =>
      props.onTokenRefresh ? async () => props.onTokenRefresh!() : undefined;

    const build = () => {
      const element = container.value;
      if (!element) return;

      destroy();

      // Named first rather than inline in the options literal: inline,
      // TypeScript resolves `emit`'s overloads while contextually typing the
      // literal and collapses to the last signature.
      const onReady = () => emit('ready');
      const onTallies = (tallies: SeatManagerTallies) => emit('tallies', tallies);
      const onActivity = (activity: SeatManagerActivity) => emit('activity', activity);
      const onControlRoom = (snapshot: ControlRoomSnapshot) => emit('control-room', snapshot);
      const onModeChange = (nextMode: SeatManagerMode) => emit('mode-change', nextMode);
      const onFollowLiveChange = (enabled: boolean) => emit('follow-live-change', enabled);
      const onSelectionChange = (seats: ExpandedSeat[]) => emit('selection-change', seats);
      const onObjectSelected = (object: ExpandedSeat) => emit('object-selected', object);
      const onObjectDeselected = (object: ExpandedSeat) => emit('object-deselected', object);
      const onSelectionValidityChange = (state: SeatManagerSelectionValidity) =>
        emit('selection-validity-change', state);
      const onSelectionValid = (state: SeatManagerSelectionValidity) => emit('selection-valid', state);
      const onSelectionInvalid = (state: SeatManagerSelectionValidity) => emit('selection-invalid', state);
      const onSelectionLimit = (max: number) => emit('selection-limit', max);
      const onFilteredSectionChange = (sections: SeatManagerFilteredSection[]) =>
        emit('filtered-section-change', sections);
      const onAreaClick = (area: SeatManagerArea) => emit('area-click', area);
      const onActionComplete = (result: SeatManagerActionResult) => emit('action-complete', result);
      const onConnectionChange = (state: SeatManagerConnection) => emit('connection-change', state);
      const onRoomStateChange = (state: SeatManagerRoomState) => emit('room-state-change', state);
      const onError = (error: unknown) => emit('error', error);

      const instance = new CoreSeatManager({
        container: element,
        apiBase: props.apiBase,
        eventKey: props.eventKey,
        token: props.token,
        tokenExpiresAt: props.tokenExpiresAt,
        mode: props.mode,
        currency: props.currency,
        keepLiveWhileHidden: props.keepLiveWhileHidden,
        followLive: props.followLive,
        capabilities: props.capabilities,
        selectedObjects: props.selectedObjects,
        selectableObjects: props.selectableObjects,
        unavailableObjectsSelectable: props.unavailableObjectsSelectable,
        unavailableObjects: props.unavailableObjects,
        unavailableObjectsReason: props.unavailableObjectsReason,
        categoryPrices: props.categoryPrices,
        maxSelectedObjects: props.maxSelectedObjects,
        numberOfPlacesToSelect: props.numberOfPlacesToSelect,
        isObjectSelectable: props.isObjectSelectable,
        tools: props.tools,
        chrome: props.chrome,
        kpis: props.kpis,
        timeZone: props.timeZone,
        organizationName: props.organizationName,
        sale: props.sale,
        mapInsets: props.mapInsets,
        theme: props.theme,
        // Applied before first paint, so a board asked for light never
        // flashes dark on the way in.
        themeMode: props.themeMode,
        colourBy: props.colourBy,
        focusSection: props.focusSection,
        focusSeat: props.focusSeat,
        focusSeats: props.focusSeats,
        focusCategory: props.focusCategory,
        arrivedFrom: props.arrivedFrom,
        // Only a host that has a trend view / an orders page gets the link.
        // Left unset otherwise, so the room never offers a dead one.
        onOpenTrend: props.onOpenTrend ? (focus) => props.onOpenTrend?.(focus) : undefined,
        onOpenOrder: props.onOpenOrder ? (order) => props.onOpenOrder?.(order) : undefined,
        onTokenRefresh: tokenRefresh(),
        onReady,
        onTallies,
        onActivity,
        onControlRoom,
        onModeChange,
        onFollowLiveChange,
        onSelectionChange,
        onObjectSelected,
        onObjectDeselected,
        onSelectionValidityChange,
        onSelectionValid,
        onSelectionInvalid,
        onSelectionLimit,
        onFilteredSectionChange,
        onAreaClick,
        onActionComplete,
        onConnectionChange,
        onRoomStateChange,
        onError,
      });

      manager.value = instance;
      void instance.render();
    };

    // Rebuild only on identity. `flush: 'post'` so the container exists on the
    // first run.
    watch(() => [container.value, props.apiBase, props.eventKey], build, {
      immediate: true,
      flush: 'post',
    });

    // Live props: each reaches the running board through its setter, the way
    // the React wrapper's effects do, so camera, selection, socket and DOM
    // survive. Multi-source watches compare each source on its own, which is
    // what makes `sale` and `mapInsets` compare by value.
    const live = { flush: 'post' } as const;

    watch([() => props.token, () => props.tokenExpiresAt], ([token, expiresAt]) => {
      manager.value?.setToken(token, expiresAt);
    }, live);
    watch(() => props.capabilities, (capabilities) => manager.value?.setCapabilities(capabilities), live);
    watch(() => props.currency, (currency) => manager.value?.setCurrency(currency), live);
    watch(() => props.theme, (theme) => manager.value?.setTheme(theme), live);
    watch(
      [() => props.sale?.status, () => props.sale?.tone, () => props.sale?.openedAt, () => props.sale?.pageUrl],
      () => manager.value?.setSale(props.sale),
      live,
    );
    watch(
      [() => props.mapInsets?.top, () => props.mapInsets?.right, () => props.mapInsets?.bottom, () => props.mapInsets?.left],
      () => manager.value?.setMapInsets(props.mapInsets ?? null),
      live,
    );
    watch(() => props.themeMode, (themeMode) => manager.value?.setThemeMode(themeMode), live);
    watch(() => props.keepLiveWhileHidden, (keep) => manager.value?.setKeepLiveWhileHidden(keep), live);
    watch(() => !!props.onTokenRefresh, () => manager.value?.setTokenRefresh(tokenRefresh()), live);
    watch(() => props.mode, (mode) => {
      if (mode) manager.value?.setMode(mode);
    }, live);
    watch(() => props.followLive, (followLive) => {
      if (followLive != null) manager.value?.setFollowLive(followLive);
    }, live);
    watch(() => props.selectableObjects, (labels) => manager.value?.setSelectableObjects(labels ?? []), live);
    watch(
      () => props.unavailableObjectsSelectable,
      (enabled) => manager.value?.setUnavailableObjectsSelectable(enabled ?? true),
      live,
    );
    watch(
      [() => props.unavailableObjects, () => props.unavailableObjectsReason],
      ([labels, reason]) => manager.value?.setUnavailableObjects(labels ?? [], reason),
      live,
    );
    watch(() => props.categoryPrices, (prices) => manager.value?.setCategoryPrices(prices), live);
    watch(() => props.maxSelectedObjects, (max) => manager.value?.setMaxSelectedObjects(max), live);
    watch(
      () => props.numberOfPlacesToSelect,
      (required) => manager.value?.setNumberOfPlacesToSelect(required),
      live,
    );
    watch(() => props.isObjectSelectable, (predicate) => manager.value?.setObjectSelectable(predicate), live);

    onBeforeUnmount(destroy);

    // Built once and read live: it asks for the current instance on each call,
    // so it survives every rebuild.
    const m = () => manager.value;
    const exposed: SeatManagerExposed = {
      setMode: (nextMode) => m()?.setMode(nextMode),
      setToken: (nextToken, expiresAt) => m()?.setToken(nextToken, expiresAt),
      setHeatOverlay: (enabled) => m()?.setHeatOverlay(enabled),
      setFollowLive: (enabled) => m()?.setFollowLive(enabled),
      setTrendWindow: (windowMinutes) => m()?.setTrendWindow(windowMinutes)
        ?? Promise.reject(new Error('not ready')),
      enterFullscreen: () => m()?.enterFullscreen() ?? Promise.resolve(),
      exitFullscreen: () => m()?.exitFullscreen() ?? Promise.resolve(),
      isFullscreen: () => m()?.isFullscreen() ?? false,
      block: (labels, opts) => m()?.block(labels, opts) ?? Promise.resolve(),
      unblock: (labels) => m()?.unblock(labels) ?? Promise.resolve(),
      unblockAll: () => m()?.unblockAll() ?? Promise.resolve(),
      cancelBooking: (labels, bookingRef) => m()?.cancelBooking(labels, bookingRef) ?? Promise.resolve(),
      setCategory: (categoryKey, labels) => m()?.setCategory(categoryKey, labels) ?? Promise.resolve(),
      setTableBooking: (tableIds, nextMode, bounds) => m()?.setTableBooking(tableIds, nextMode, bounds)
        ?? Promise.resolve(),
      selectAll: () => m()?.selectAll() ?? [],
      selectSection: (id) => m()?.selectSection(id) ?? [],
      selectByLabels: (labels) => m()?.selectByLabels(labels) ?? [],
      selectObjects: (labels) => m()?.selectObjects(labels) ?? [],
      deselectObjects: (labels) => m()?.deselectObjects(labels) ?? [],
      selectCategories: (keys) => m()?.selectCategories(keys) ?? [],
      deselectCategories: (keys) => m()?.deselectCategories(keys) ?? [],
      setSelectableObjects: (labels) => m()?.setSelectableObjects(labels),
      setUnavailableObjectsSelectable: (enabled) => m()?.setUnavailableObjectsSelectable(enabled),
      setUnavailableObjects: (labels, reason) => m()?.setUnavailableObjects(labels, reason),
      setCategoryPrices: (prices) => m()?.setCategoryPrices(prices),
      setObjectSelectable: (predicate) => m()?.setObjectSelectable(predicate),
      setMaxSelectedObjects: (max) => m()?.setMaxSelectedObjects(max),
      setNumberOfPlacesToSelect: (required) => m()?.setNumberOfPlacesToSelect(required),
      getSelectionValidity: () => m()?.getSelectionValidity() ?? null,
      setFilteredSection: (label) => m()?.setFilteredSection(label) ?? [],
      clearFilteredSection: () => m()?.clearFilteredSection(),
      focusSection: (label) => m()?.focusSection(label) ?? [],
      getFilteredSections: () => m()?.getFilteredSections() ?? [],
      clearSelection: () => m()?.clearSelection(),
      getSelection: () => m()?.getSelection() ?? [],
      getReport: () => m()?.getReport() ?? Promise.reject(new Error('not ready')),
      getControlRoomSnapshot: (windowMinutes) => m()?.getControlRoomSnapshot(windowMinutes)
        ?? Promise.reject(new Error('not ready')),
      getLog: (opts) => m()?.getLog(opts) ?? Promise.resolve({ entries: [], nextBefore: null }),
      getConnection: () => m()?.getConnection() ?? null,
      setHoldTtl: (ms) => m()?.setHoldTtl(ms) ?? Promise.resolve(),
      zoomToFit: () => m()?.zoomToFit(),
      showObjects: (labels, name) => m()?.showObjects(labels, name),
    };
    expose(exposed);

    return () => h('div', { ref: container });
  },
});
