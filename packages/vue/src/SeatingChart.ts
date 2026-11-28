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
  SEATING_CHART_IDENTITY_PROPS,
  bindSeatingChartHandle,
  buildSeatingChartOptions,
  type RendererViewMode,
  type SeatingChartHandle,
  type SeatingChartOptions,
  type SelectedSeat,
  type HoldResult,
  type BestAvailableResult,
  type GAAreaAvailability,
  type SeatHoverDetails,
  type PickerSelectionValidity,
  type PickerSelectionValidator,
  type BuyerAccessToken,
  type BuyerAccessTokenProvider,
  type BuyerAccessExpiredEvent,
  type BuyerAccessUnavailableEvent,
  type SelectedObjectUnavailableEvent,
} from '@seatlayer/js';

/** The argument a `SeatingChart` callback option is called with. */
type CallbackArg<K extends keyof SeatingChartOptions> =
  NonNullable<SeatingChartOptions[K]> extends (arg: infer A) => unknown ? A : never;

/**
 * What `ref="chart"` gives you — call these to drive the picker from your app.
 *
 * Vue exposes these through `defineExpose`, so a template ref is typed as this
 * rather than as the raw component instance. It is the shared
 * `SeatingChartHandle` from `@seatlayer/js`: the same 17 methods React's `ref`
 * and Angular's component expose, from one declaration, so the three wrappers
 * cannot drift apart again.
 */
export type SeatingChartExposed = SeatingChartHandle;

/**
 * Vue 3 wrapper around the framework-agnostic `@seatlayer/js` SDK.
 *
 * The canvas is created once and torn down on unmount. Only the props that
 * change the chart's identity (`SEATING_CHART_IDENTITY_PROPS`: `event`,
 * `apiBase`, `maxSelection`, `numberOfPlacesToSelect`, `publicKey`, `locale`, `currency`,
 * `colorblindSafe`, `initialView`, `errorDisplay`, `enable3D`, `enable3DCrowd`,
 * `touchNavigation3D`) trigger a rebuild;
 * everything else is read live, so a parent re-render never destroys the canvas
 * mid-selection.
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
    /** Object ids or public labels selected after availability loads. */
    selectedObjects: { type: Array as PropType<string[]>, default: undefined },
    /** Object ids or public labels the buyer may select. */
    selectableObjects: { type: Array as PropType<string[] | null>, default: undefined },
    /** Exact ticket count required for a valid selection. */
    numberOfPlacesToSelect: { type: Number, default: undefined },
    /** Local buyer selection guards. Changing them rebuilds the chart. */
    selectionValidators: { type: Array as PropType<PickerSelectionValidator[]>, default: undefined },
    /** Publishable key, when your integration uses one. */
    publicKey: { type: String, default: undefined },
    /** BCP-47 locale for built-in copy. */
    locale: { type: String, default: undefined },
    /** ISO currency for price formatting. */
    currency: { type: String, default: undefined },
    /** Render with colorblind-safe seat glyphs. */
    colorblindSafe: { type: Boolean, default: undefined },
    /**
     * Initial canvas projection. Read once when the chart is built, so
     * changing it rebuilds.
     * @deprecated `'isometric'` and `'perspective'` are retired in favour of
     * the real 3D venue view; use `'flat'`.
     */
    initialView: {
      type: String as PropType<RendererViewMode>,
      default: undefined,
    },
    /**
     * What the BUYER sees when the chart cannot load: `'message'` (default) is
     * a styleable notice with a Try again button, `'none'` is silent for hosts
     * that render their own failure UI from the `error` event.
     */
    errorDisplay: {
      type: String as PropType<'message' | 'none'>,
      default: undefined,
    },
    /** Offer the 3D venue view (default true). Changing it rebuilds. */
    enable3D: { type: Boolean, default: undefined },
    /** The standing crowd in 3D, drawn by default; false turns it off. Changing it rebuilds. */
    enable3DCrowd: { type: Boolean, default: undefined },
    /** How fingers move the 3D view: `'map'` (default) or `'classic'`. Changing it rebuilds. */
    touchNavigation3D: {
      type: String as PropType<'map' | 'classic'>,
      default: undefined,
    },
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
    /** Light, dark or auto (`{ mode }`). Read once per mount. */
    theme: { type: Object as PropType<SeatingChartOptions['theme']>, default: undefined },
    /** Your own prices per category or object. Read once per mount. */
    pricing: { type: Object as PropType<SeatingChartOptions['pricing']>, default: undefined },
    /** Usage telemetry; false turns it off. Read once per mount. */
    telemetry: { type: Boolean, default: undefined },
    /** Languages offered to the buyer. Read once per mount. */
    languages: { type: Array as PropType<string[]>, default: undefined },
    /** Map colours. Read once per mount. */
    mapTheme: { type: Object as PropType<SeatingChartOptions['mapTheme']>, default: undefined },
    /** Turn off built-in 3D and seat-view captions you draw yourself. Read once per mount. */
    chrome: { type: Object as PropType<SeatingChartOptions['chrome']>, default: undefined },
    /** Level labels by `'name'` or `'number'`. Read once per mount. */
    floorLabelStyle: {
      type: String as PropType<SeatingChartOptions['floorLabelStyle']>,
      default: undefined,
    },
    /** Offer the view from a seat. Read once per mount. */
    enableSeatView: { type: Boolean, default: undefined },
    /** Cap on seats drawn in 3D. Read once per mount. */
    max3DSeats: { type: Number, default: undefined },
  },

  emits: {
    /** The buyer's selection changed. */
    'selection-change': (_seats: SelectedSeat[]) => true,
    /** Exact-count state changed. */
    'selection-validity-change': (_state: PickerSelectionValidity) => true,
    /** The exact count was reached. */
    'selection-valid': (_seats: SelectedSeat[]) => true,
    /** The selection is not at the exact count. */
    'selection-invalid': (_state: PickerSelectionValidity) => true,
    /** The active selection cap was reached. */
    'selection-limit': (_max: number) => true,
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
    /** The page's line to the server changed. */
    'connection-change': (_state: CallbackArg<'onConnectionChange'>) => true,
    /** The status line over the map changed. */
    'status-change': () => true,
    /** Sales for the event closed. */
    'sales-closed': () => true,
    /** The camera moved (once per frame at most). */
    'view-change': () => true,
    /** The map's state changed. */
    'map-state-change': () => true,
    /** A section was focused, or focus left (`null`). */
    'section-focus': (_summary: CallbackArg<'onSectionFocus'>) => true,
    /** The buyer tapped a seat already in the selection. */
    'seat-retap': (_seat: CallbackArg<'onSeatRetap'>) => true,
    /** The view from a seat opened, or closed (`null`). */
    'seat-view-change': (_info: CallbackArg<'onSeatViewChange'>) => true,
    /** The buyer's view changed (2D, 3D, a seat). */
    'buyer-view-change': (_state: CallbackArg<'onBuyerViewChange'>) => true,
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
      const onSelectionValidityChange = (state: PickerSelectionValidity) => emit('selection-validity-change', state);
      const onSelectionValid = (seats: SelectedSeat[]) => emit('selection-valid', seats);
      const onSelectionInvalid = (state: PickerSelectionValidity) => emit('selection-invalid', state);
      const onSelectionLimit = (max: number) => emit('selection-limit', max);
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
      const onConnectionChange = (state: CallbackArg<'onConnectionChange'>) => emit('connection-change', state);
      const onStatusChange = () => emit('status-change');
      const onSalesClosed = () => emit('sales-closed');
      const onViewChange = () => emit('view-change');
      const onMapStateChange = () => emit('map-state-change');
      const onSectionFocus = (summary: CallbackArg<'onSectionFocus'>) => emit('section-focus', summary);
      const onSeatRetap = (seat: CallbackArg<'onSeatRetap'>) => emit('seat-retap', seat);
      const onSeatViewChange = (info: CallbackArg<'onSeatViewChange'>) => emit('seat-view-change', info);
      const onBuyerViewChange = (state: CallbackArg<'onBuyerViewChange'>) => emit('buyer-view-change', state);

      const instance = new CoreSeatingChart(buildSeatingChartOptions(
        element,
        {
          event: props.event,
          apiBase: props.apiBase,
          maxSelection: props.maxSelection,
          selectedObjects: props.selectedObjects,
          selectableObjects: props.selectableObjects,
          numberOfPlacesToSelect: props.numberOfPlacesToSelect,
          selectionValidators: props.selectionValidators,
          publicKey: props.publicKey,
          locale: props.locale,
          currency: props.currency,
          colorblindSafe: props.colorblindSafe,
          initialView: props.initialView,
          errorDisplay: props.errorDisplay,
          enable3D: props.enable3D,
          enable3DCrowd: props.enable3DCrowd,
          touchNavigation3D: props.touchNavigation3D,
          messages: props.messages,
          seatTooltip: props.seatTooltip,
          buyerAccessTokenProvider: props.buyerAccessTokenProvider,
          buyerAccessToken: props.buyerAccessToken,
          theme: props.theme,
          pricing: props.pricing,
          telemetry: props.telemetry,
          languages: props.languages,
          mapTheme: props.mapTheme,
          chrome: props.chrome,
          floorLabelStyle: props.floorLabelStyle,
          enableSeatView: props.enableSeatView,
          max3DSeats: props.max3DSeats,
        },
        {
          onAccessExpired,
          onAccessUnavailable,
          onSelectedObjectUnavailable,
          onSelectionChange,
          onSelectionValidityChange,
          onSelectionValid,
          onSelectionInvalid,
          onSelectionLimit,
          onHold,
          onHoldRestored,
          onHoldExpired,
          onGAClick,
          onError,
          onDeckTap,
          onHint,
          onSeatHover,
          onConnectionChange,
          onStatusChange,
          onSalesClosed,
          onViewChange,
          onMapStateChange,
          onSectionFocus,
          onSeatRetap,
          onSeatViewChange,
          onBuyerViewChange,
        },
      ));

      chart.value = instance;
      void instance.render();
    };

    // `flush: 'post'` so the container element exists on the first run — a
    // pre-flush watcher would fire before the DOM node is attached.
    watch(
      () => [
        container.value,
        // The shared identity list, not a hand-copied one — this is exactly the
        // place Vue fell two props behind React.
        ...SEATING_CHART_IDENTITY_PROPS.map((prop) => props[prop]),
      ],
      build,
      { immediate: true, flush: 'post' },
    );

    onBeforeUnmount(destroy);

    // Built once and read live: the handle must survive every rebuild, so it
    // asks for the current instance on each call rather than capturing one.
    const exposed: SeatingChartExposed = bindSeatingChartHandle(() => chart.value);
    expose(exposed);

    return () => h('div', { ref: container });
  },
});
