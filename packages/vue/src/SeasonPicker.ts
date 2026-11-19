import {
  computed,
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
  SeasonPicker as CoreSeasonPicker,
  type CheckoutSessionResult,
  type SeasonAvailability,
  type SeasonBestAvailableOptions,
  type SeasonCheckoutHandoff,
  type SeasonDatesCheckoutInput,
  type SeasonDescriptor,
  type SeasonHeldOrder,
  type SeasonPickerOptions,
  type SeasonPriceType,
  type SeasonRenewalIntent,
  type SeasonSeatPriceTypes,
  type SeasonStatusEvent,
} from '@seatlayer/js';

/** Imperative controls exposed through a Vue template ref. */
export interface SeasonPickerExposed {
  /**
   * Holds the same labels for every included performance. `priceTypes` names
   * each seat's price type by label (`{ 'A-2': 'child' }`); a label it leaves
   * out is adult. Same contract as `@seatlayer/js` `holdSameSeat`.
   */
  holdSameSeat(
    labels: readonly string[], operationId: string, priceTypes?: SeasonSeatPriceTypes,
  ): Promise<SeasonCheckoutHandoff>;
  /**
   * Holds the best `qty` seats free on every included performance, as a map
   * selection would. Same contract as `@seatlayer/js` `holdBestAvailable`: a
   * caller-stable `sop_` id, 1 to `maxSelection` seats, one call at a time.
   */
  holdBestAvailable(
    qty: number, operationId: string, options?: SeasonBestAvailableOptions,
  ): Promise<SeasonCheckoutHandoff>;
  restoreOperation(operationId: string): Promise<SeasonCheckoutHandoff | null>;
  /** Your server booked the held seats: show booked and stop the hold clock. */
  markBooked(): Promise<boolean>;
  release(releaseActionId: string): Promise<void>;
  /**
   * As release(), resolving `true` when the seats were let go and `false` when
   * nothing was held or the server kept the hold (booked, or being booked).
   * Always present on the handle this package gives you; optional in the type
   * only so an object you typed as this handle before it existed still compiles.
   */
  tryRelease?(releaseActionId: string): Promise<boolean>;
  createRenewalIntent(offerId: string): Promise<SeasonRenewalIntent>;
  getDescriptor(): SeasonDescriptor | null;
  getAvailability(): SeasonAvailability | null;
  getHandoff(): SeasonCheckoutHandoff | null;
  /**
   * The held Season order for your own order summary: each held seat with its
   * price type and package price, and the total. Null with no live hold.
   * Display only: checkout prices the order on the server.
   */
  getHeldOrder(): SeasonHeldOrder | null;
  /**
   * Pay a single-dates hold (`singleDates`) on your own checkout page: the
   * handoff the `continue` event gave you carries `dates`. Same contract as
   * `@seatlayer/js` `startDatesCheckout`. Always present on the handle this
   * package gives you; optional in the type only so an object you typed as
   * this handle before it existed still compiles.
   */
  startDatesCheckout?(input: SeasonDatesCheckoutInput): Promise<CheckoutSessionResult>;
}

/** Vue lifecycle adapter for the distinct fixed-inclusion Season buyer flow. */
export const SeasonPicker = defineComponent({
  name: 'SeatLayerSeasonPicker',
  props: {
    season: { type: String, required: true },
    apiBase: { type: String, default: undefined },
    publicKey: { type: String, default: undefined },
    checkout: {
      type: String as PropType<SeasonPickerOptions['checkout']>,
      default: undefined,
    },
    returnUrl: { type: String, default: undefined },
    buyerEmail: { type: String, default: undefined },
    buyerName: { type: String, default: undefined },
    buyerAccessTokenProvider: {
      type: Function as PropType<SeasonPickerOptions['buyerAccessTokenProvider']>,
      default: undefined,
    },
    buyerAccessToken: {
      type: [String, Object] as PropType<SeasonPickerOptions['buyerAccessToken']>,
      default: undefined,
    },
    initialOperationId: { type: String, default: undefined },
    /**
     * Release, on unmount, a hold the buyer left unfinished (`@seatlayer/js`
     * `releaseHoldOnDestroy`). Default false: unmounting releases nothing.
     * Changing it does not rebuild the picker; the picker reads the current
     * value when it is destroyed.
     *
     * Do not turn this on if you rebuild the picker (changing props the
     * wrapper rebuilds on: season, apiBase, publicKey, checkout, returnUrl,
     * buyerAccessTokenProvider (by identity), buyerAccessToken,
     * initialOperationId, package, ticketsByEmail, singleDates,
     * recoveryTimeoutMs, the 3D props, fetch (by identity), priceTypes) or
     * hand the hold to your own
     * checkout without the continue event.
     */
    releaseHoldOnDestroy: { type: Boolean, default: undefined },
    /** The package to open on, by its key; the first package without it. */
    package: { type: String, default: undefined },
    /** The host emails a ticket per date itself: step 1 says so. */
    ticketsByEmail: { type: Boolean, default: undefined },
    /**
     * Offer the Season's single dates beside the passes on a page with its own
     * checkout or session: continue on a dates hold emits a handoff whose
     * `dates` names the run, the dates and the held lines; pay it with
     * `startDatesCheckout`. Off by default. Changing it rebuilds.
     */
    singleDates: { type: Boolean, default: undefined },
    recoveryTimeoutMs: { type: Number, default: undefined },
    /** Offer the 3D venue view (default true). Changing it rebuilds. */
    enable3D: { type: Boolean, default: undefined },
    /** The standing crowd in 3D, drawn by default; false turns it off. Changing it rebuilds. */
    enable3DCrowd: { type: Boolean, default: undefined },
    /** How fingers move the 3D view: `'map'` (default) or `'classic'`. Changing it rebuilds. */
    touchNavigation3D: {
      type: String as PropType<'map' | 'classic'>,
      default: undefined,
    },
    fetch: { type: Function as PropType<typeof fetch>, default: undefined },
    /**
     * The price types the picker sells, e.g. `['adult', 'child']`. With a type
     * besides adult, the buyer chooses one per seat before the hold.
     */
    priceTypes: {
      type: Array as PropType<readonly SeasonPriceType[]>,
      default: undefined,
    },
  },
  emits: {
    hold: (_handoff: SeasonCheckoutHandoff) => true,
    'hold-change': (_handoff: SeasonCheckoutHandoff | null) => true,
    continue: (_handoff: SeasonCheckoutHandoff) => true,
    'renewal-intent': (_intent: SeasonRenewalIntent) => true,
    'access-expired': (_event: unknown) => true,
    'access-unavailable': (_event: unknown) => true,
    'order-confirmed': (_order: unknown) => true,
    'status-change': (_event: SeasonStatusEvent) => true,
    error: (_error: unknown) => true,
  },
  setup(props, { emit, expose }) {
    const container: Ref<HTMLDivElement | null> = ref(null);
    const picker = shallowRef<CoreSeasonPicker | null>(null);
    // By content, so an inline `:price-types="['adult', 'child']"` does not
    // rebuild the picker on every parent render (a computed only notifies the
    // watch below when its value changes).
    const priceTypesKey = computed(() => (props.priceTypes ?? []).join(','));

    const destroy = () => {
      picker.value?.destroy();
      picker.value = null;
    };
    const build = () => {
      const element = container.value;
      if (!element) return;
      destroy();
      const instance = new CoreSeasonPicker({
        container: element,
        season: props.season,
        apiBase: props.apiBase,
        publicKey: props.publicKey,
        checkout: props.checkout,
        returnUrl: props.returnUrl,
        buyerEmail: props.buyerEmail,
        buyerName: props.buyerName,
        buyerAccessTokenProvider: props.buyerAccessTokenProvider,
        buyerAccessToken: props.buyerAccessToken,
        initialOperationId: props.initialOperationId,
        package: props.package,
        ticketsByEmail: props.ticketsByEmail,
        singleDates: props.singleDates,
        recoveryTimeoutMs: props.recoveryTimeoutMs,
        enable3D: props.enable3D,
        enable3DCrowd: props.enable3DCrowd,
        touchNavigation3D: props.touchNavigation3D,
        fetch: props.fetch,
        priceTypes: props.priceTypes,
        onHold: (handoff) => emit('hold', handoff),
        onHoldChange: (handoff) => emit('hold-change', handoff),
        onContinue: (handoff) => emit('continue', handoff),
        onRenewalIntent: (intent) => emit('renewal-intent', intent),
        onAccessExpired: (event) => emit('access-expired', event),
        onAccessUnavailable: (event) => emit('access-unavailable', event),
        onOrderConfirmed: (order) => emit('order-confirmed', order),
        onStatusChange: (event) => emit('status-change', event),
        onError: (error) => emit('error', error),
        // Not a rebuild trigger: read from the current prop when the picker is destroyed.
        get releaseHoldOnDestroy() { return props.releaseHoldOnDestroy; },
      });
      picker.value = instance;
      void instance.render().catch(() => undefined);
    };

    watch(
      () => [
        container.value,
        props.season,
        props.apiBase,
        props.publicKey,
        props.checkout,
        props.returnUrl,
        props.buyerAccessTokenProvider,
        props.buyerAccessToken,
        props.initialOperationId,
        props.package,
        props.ticketsByEmail,
        props.singleDates,
        props.recoveryTimeoutMs,
        props.enable3D,
        props.enable3DCrowd,
        props.touchNavigation3D,
        props.fetch,
        priceTypesKey.value,
      ],
      build,
      { immediate: true, flush: 'post' },
    );
    onBeforeUnmount(destroy);

    const current = (): CoreSeasonPicker => {
      if (!picker.value) throw new Error('seatlayer: Vue SeasonPicker is not mounted');
      return picker.value;
    };
    const exposed: SeasonPickerExposed = {
      holdSameSeat: (labels, operationId, priceTypes) => current().holdSameSeat(labels, operationId, priceTypes),
      holdBestAvailable: (qty, operationId, options) => current().holdBestAvailable(qty, operationId, options),
      restoreOperation: (operationId) => current().restoreOperation(operationId),
      markBooked: () => current().markBooked(),
      release: (releaseActionId) => current().release(releaseActionId),
      tryRelease: (releaseActionId) => current().tryRelease(releaseActionId),
      createRenewalIntent: (offerId) => current().createRenewalIntent(offerId),
      getDescriptor: () => picker.value?.getDescriptor() ?? null,
      getAvailability: () => picker.value?.getAvailability() ?? null,
      getHandoff: () => picker.value?.getHandoff() ?? null,
      getHeldOrder: () => picker.value?.getHeldOrder() ?? null,
      startDatesCheckout: (input) => current().startDatesCheckout(input),
    };
    expose(exposed);
    return () => h('div', { ref: container });
  },
});
