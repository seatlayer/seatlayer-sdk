import {
  defineComponent,
  h,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type PropType,
  type Ref,
} from 'vue';
import {
  SeatingChart as CoreSeatingChart,
  type SeatingChartOptions,
  type SelectedSeat,
  type HoldResult,
  type BestAvailableResult,
  type GAAreaAvailability,
  type SeatHoverDetails,
  type BuyerAccessToken,
  type BuyerAccessTokenProvider,
  type BuyerAccessExpiredEvent,
  type BuyerAccessUnavailableEvent,
  type SelectedObjectUnavailableEvent,
} from '@seatlayer/js';

/**
 * What `ref="chart"` gives you — call these to drive the picker from your app.
 *
 * Vue exposes these through `defineExpose`, so a template ref is typed as this
 * rather than as the raw component instance.
 */
export interface SeatingChartExposed {
  /** Hold the current selection. Resolves the hold, or `null` on a 409 conflict. */
  hold(options?: { ttlMs?: number }): Promise<HoldResult | null>;
  /** Restore an active hold by its opaque id. */
  resumeHold(holdId: string): Promise<HoldResult | null>;
  /** Current active hold known to the chart. */
  getCurrentHold(): HoldResult | null;
  /** GA areas with live remaining capacity. */
  getGAAreas(): GAAreaAvailability[];
  /** Atomically hold a quantity from one GA area. */
  holdGA(areaId: string, qty: number, options?: { tierId?: string | null; ttlMs?: number }): Promise<HoldResult | null>;
  /** Ask the server for the `qty` best free seats and hold them atomically. */
  bestAvailable(qty: number, categoryKey?: string): Promise<BestAvailableResult | null>;
  /** Release the current hold (if any). */
  release(): Promise<void>;
  /** Release some held labels while keeping the remainder active. */
  releaseLabels(labels: string[]): Promise<boolean>;
  /** The current selection, with prices resolved from the chart categories. */
  getSelection(): SelectedSeat[];
  /** Choose a ticket tier for a selected seat; `null` reverts to the default. */
  setSeatTier(seatId: string, tierId: string | null): void;
  /** Floors of a multi-floor chart. Empty before the first render. */
  getFloors(): { id: string; name: string }[];
  /** Switch the shown floor (2D). No-ops on single-floor charts. */
  setFloor(floorId: string): void;
  /** Toggle colorblind-safe rendering at runtime. */
  setColorblindSafe(on: boolean): void;
  /** Zoom in one step (same increment as the wheel/pinch gesture). */
  zoomIn(): void;
  /** Zoom out one step. */
  zoomOut(): void;
  /** Reset the camera so the whole chart fits the container. */
  zoomToFit(): void;
  /**
   * Re-acquire the buyer access session after your app re-authorizes the buyer
   * (Sales Channels). Resolves false when the chart is not access-scoped.
   */
  refreshAccess(): Promise<boolean>;
}

/**
 * Vue 3 wrapper around the framework-agnostic `@seatlayer/js` SDK.
 *
 * The canvas is created once and torn down on unmount. Only the props that
 * change the chart's identity — `event`, `apiBase`, `maxSelection`, `publicKey`,
 * `locale`, `currency`, `colorblindSafe` — trigger a rebuild; everything else is
 * read live, so a parent re-render never destroys the canvas mid-selection.
 *
 * Written as a render function rather than an SFC so the package builds with
 * plain TypeScript — a consumer needs no Vue compiler plugin to install it.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { ref } from 'vue';
 * import { SeatingChart, type SeatingChartExposed } from '@seatlayer/vue';
 *
 * const chart = ref<SeatingChartExposed | null>(null);
 * const checkout = async () => {
 *   const held = await chart.value?.hold();
 *   if (held) await pay(held.holdId);
 * };
 * </script>
 *
 * <template>
 *   <SeatingChart ref="chart" event="summer-gala" @selection-change="onChange" />
 * </template>
 * ```
 */
export const SeatingChart = defineComponent({
  name: 'SeatLayerSeatingChart',

  props: {
    /** Event key to render. Changing it rebuilds the chart. */
    event: { type: String, required: true },
    /** API base URL. Defaults to the public API. */
    apiBase: { type: String, default: undefined },
    /** Cap on how many seats a buyer may select. */
    maxSelection: { type: Number, default: undefined },
    /** Publishable key, when your integration uses one. */
    publicKey: { type: String, default: undefined },
    /** BCP-47 locale for built-in copy. */
    locale: { type: String, default: undefined },
    /** ISO currency for price formatting. */
    currency: { type: String, default: undefined },
    /** Render with colorblind-safe seat glyphs. */
    colorblindSafe: { type: Boolean, default: undefined },
    /** Copy overrides, read once per mount. */
    messages: {
      type: Object as PropType<SeatingChartOptions['messages']>,
      default: undefined,
    },
    /**
     * Show the built-in seat tooltip. Set false to draw your own popover from
     * the `seat-hover` event.
     */
    seatTooltip: { type: Boolean, default: undefined },
    /**
     * Sales Channels: mint a buyer access session on demand. Called with a
     * `reason`; returns `{ token, expiresAt }` from YOUR backend. The token is
     * held in memory only — never storage, never a URL, never a log.
     */
    buyerAccessTokenProvider: {
      type: Function as PropType<BuyerAccessTokenProvider>,
      default: undefined,
    },
    /** One-shot session for hosts that own the lifecycle. Cannot be renewed. */
    buyerAccessToken: {
      type: [String, Object] as PropType<string | BuyerAccessToken>,
      default: undefined,
    },
  },

  emits: {
    /** The buyer's selection changed. */
    'selection-change': (_seats: SelectedSeat[]) => true,
    /** A hold succeeded. */
    hold: (_result: HoldResult) => true,
    /** A previous hold was restored on mount. */
    'hold-restored': (_result: HoldResult) => true,
    /** The active hold lapsed. */
    'hold-expired': () => true,
    /** A GA area was clicked. */
    'ga-click': (_area: GAAreaAvailability) => true,
    /** Something failed — a network error, a rejected hold. */
    error: (_error: unknown) => true,
    /** A floor deck was tapped in the 3D view. */
    'deck-tap': (_floorId: string) => true,
    /** A transient hint worth showing the buyer, or `null` to clear it. */
    hint: (_message: string | null) => true,
    /** The pointer moved onto a seat, or off one (`null`). */
    'seat-hover': (_details: SeatHoverDetails | null) => true,
    /** The buyer access session lapsed; `refreshed` says whether it recovered. */
    'access-expired': (_event: BuyerAccessExpiredEvent) => true,
    /** Private inventory is unavailable and refreshing will not fix it. */
    'access-unavailable': (_event: BuyerAccessUnavailableEvent) => true,
    /** Selected-but-unheld units stopped being selectable. */
    'selected-object-unavailable': (_event: SelectedObjectUnavailableEvent) => true,
  },

  setup(props, { emit, expose }) {
    const container: Ref<HTMLDivElement | null> = ref(null);
    // shallowRef: the chart owns a canvas and a large scene graph, and making it
    // deeply reactive would have Vue walk all of it on every touch.
    const chart = shallowRef<CoreSeatingChart | null>(null);

    const destroy = () => {
      chart.value?.destroy();
      chart.value = null;
    };

    const build = () => {
      const element = container.value;
      if (!element) return;

      destroy();

      // Handlers are bound here rather than inline in the options literal.
      // Inline, TypeScript has to resolve `emit`'s overloads while it is still
      // contextually typing the literal against SeatingChartOptions, and it
      // gives up — collapsing to the last emit signature. Naming them first
      // separates the two inference problems, and reads better besides.
      const onSelectionChange = (seats: SelectedSeat[]) => emit('selection-change', seats);
      const onHold = (result: HoldResult) => emit('hold', result);
      const onHoldRestored = (result: HoldResult) => emit('hold-restored', result);
      const onHoldExpired = () => emit('hold-expired');
      const onGAClick = (area: GAAreaAvailability) => emit('ga-click', area);
      const onError = (error: unknown) => emit('error', error);
      const onDeckTap = (floorId: string) => emit('deck-tap', floorId);
      const onHint = (message: string | null) => emit('hint', message);
      const onSeatHover = (details: SeatHoverDetails | null) => emit('seat-hover', details);
      const onAccessExpired = (state: BuyerAccessExpiredEvent) => emit('access-expired', state);
      const onAccessUnavailable = (state: BuyerAccessUnavailableEvent) =>
        emit('access-unavailable', state);
      const onSelectedObjectUnavailable = (state: SelectedObjectUnavailableEvent) =>
        emit('selected-object-unavailable', state);

      const instance = new CoreSeatingChart({
        container: element,
        event: props.event,
        apiBase: props.apiBase,
        maxSelection: props.maxSelection,
        publicKey: props.publicKey,
        locale: props.locale,
        currency: props.currency,
        colorblindSafe: props.colorblindSafe,
        messages: props.messages,
        seatTooltip: props.seatTooltip,
        buyerAccessTokenProvider: props.buyerAccessTokenProvider,
        buyerAccessToken: props.buyerAccessToken,
        onAccessExpired,
        onAccessUnavailable,
        onSelectedObjectUnavailable,
        onSelectionChange,
        onHold,
        onHoldRestored,
        onHoldExpired,
        onGAClick,
        onError,
        onDeckTap,
        onHint,
        onSeatHover,
      });

      chart.value = instance;
      void instance.render();
    };

    // `flush: 'post'` so the container element exists on the first run — a
    // pre-flush watcher would fire before the DOM node is attached.
    watch(
      () => [
        container.value,
        props.event,
        props.apiBase,
        props.maxSelection,
        props.publicKey,
        props.locale,
        props.currency,
        props.colorblindSafe,
      ],
      build,
      { immediate: true, flush: 'post' },
    );

    onBeforeUnmount(destroy);

    const exposed: SeatingChartExposed = {
      hold: (options) => chart.value?.hold(options) ?? Promise.resolve(null),
      resumeHold: (holdId) => chart.value?.resumeHold(holdId) ?? Promise.resolve(null),
      getCurrentHold: () => chart.value?.getCurrentHold() ?? null,
      getGAAreas: () => chart.value?.getGAAreas() ?? [],
      holdGA: (areaId, qty, options) => chart.value?.holdGA(areaId, qty, options) ?? Promise.resolve(null),
      bestAvailable: (qty, categoryKey) =>
        chart.value?.bestAvailable(qty, categoryKey) ?? Promise.resolve(null),
      release: () => chart.value?.release() ?? Promise.resolve(),
      releaseLabels: (labels) => chart.value?.releaseLabels(labels) ?? Promise.resolve(false),
      getSelection: () => chart.value?.getSelection() ?? [],
      setSeatTier: (seatId, tierId) => chart.value?.setSeatTier(seatId, tierId),
      getFloors: () => chart.value?.getFloors() ?? [],
      setFloor: (floorId) => chart.value?.setFloor(floorId),
      setColorblindSafe: (on) => chart.value?.setColorblindSafe(on),
      zoomIn: () => chart.value?.zoomIn(),
      zoomOut: () => chart.value?.zoomOut(),
      zoomToFit: () => chart.value?.zoomToFit(),
      refreshAccess: () => chart.value?.refreshAccess() ?? Promise.resolve(false),
    };
    expose(exposed);

    return () => h('div', { ref: container });
  },
});
