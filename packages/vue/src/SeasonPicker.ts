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
  SeasonPicker as CoreSeasonPicker,
  type SeasonAvailability,
  type SeasonCheckoutHandoff,
  type SeasonDescriptor,
  type SeasonPickerOptions,
  type SeasonRenewalIntent,
  type SeasonStatusEvent,
} from '@seatlayer/js';

/** Imperative controls exposed through a Vue template ref. */
export interface SeasonPickerExposed {
  holdSameSeat(labels: readonly string[], operationId: string): Promise<SeasonCheckoutHandoff>;
  restoreOperation(operationId: string): Promise<SeasonCheckoutHandoff | null>;
  release(releaseActionId: string): Promise<void>;
  createRenewalIntent(offerId: string): Promise<SeasonRenewalIntent>;
  getDescriptor(): SeasonDescriptor | null;
  getAvailability(): SeasonAvailability | null;
  getHandoff(): SeasonCheckoutHandoff | null;
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
    buyerAccessTokenProvider: {
      type: Function as PropType<SeasonPickerOptions['buyerAccessTokenProvider']>,
      default: undefined,
    },
    buyerAccessToken: {
      type: [String, Object] as PropType<SeasonPickerOptions['buyerAccessToken']>,
      default: undefined,
    },
    initialOperationId: { type: String, default: undefined },
    recoveryTimeoutMs: { type: Number, default: undefined },
    fetch: { type: Function as PropType<typeof fetch>, default: undefined },
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
        buyerAccessTokenProvider: props.buyerAccessTokenProvider,
        buyerAccessToken: props.buyerAccessToken,
        initialOperationId: props.initialOperationId,
        recoveryTimeoutMs: props.recoveryTimeoutMs,
        fetch: props.fetch,
        onHold: (handoff) => emit('hold', handoff),
        onHoldChange: (handoff) => emit('hold-change', handoff),
        onContinue: (handoff) => emit('continue', handoff),
        onRenewalIntent: (intent) => emit('renewal-intent', intent),
        onAccessExpired: (event) => emit('access-expired', event),
        onAccessUnavailable: (event) => emit('access-unavailable', event),
        onOrderConfirmed: (order) => emit('order-confirmed', order),
        onStatusChange: (event) => emit('status-change', event),
        onError: (error) => emit('error', error),
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
        props.recoveryTimeoutMs,
        props.fetch,
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
      holdSameSeat: (labels, operationId) => current().holdSameSeat(labels, operationId),
      restoreOperation: (operationId) => current().restoreOperation(operationId),
      release: (releaseActionId) => current().release(releaseActionId),
      createRenewalIntent: (offerId) => current().createRenewalIntent(offerId),
      getDescriptor: () => picker.value?.getDescriptor() ?? null,
      getAvailability: () => picker.value?.getAvailability() ?? null,
      getHandoff: () => picker.value?.getHandoff() ?? null,
    };
    expose(exposed);
    return () => h('div', { ref: container });
  },
});
