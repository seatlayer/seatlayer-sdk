import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
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

/** Standalone Angular adapter for the distinct fixed-inclusion Season buyer flow. */
@Component({
  selector: 'seatlayer-season-picker',
  standalone: true,
  template: '<div #container class="seatlayer-season-container"></div>',
  styles: [':host { display: block; } .seatlayer-season-container { width: 100%; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeatLayerSeasonPickerComponent implements OnChanges {
  /** Season key to render. */
  @Input({ required: true }) season!: string;

  /** Public API base override. */
  @Input() apiBase?: string;

  /** Publishable account key, accepted for snippet parity. Never sent. */
  @Input() publicKey?: string;

  /** Who takes the money once the package is held. Default `'handoff'`. */
  @Input() checkout?: SeasonPickerOptions['checkout'];

  /** Where a redirecting gateway returns the buyer, for hosted checkout. */
  @Input() returnUrl?: string;
  /** Prefills SeatLayer checkout's email field (a signed-in member's). */
  @Input() buyerEmail?: string;
  /** Prefills SeatLayer checkout's name field. */
  @Input() buyerName?: string;

  /** Refreshable one-time browser bearer provider. */
  @Input() buyerAccessTokenProvider?: SeasonPickerOptions['buyerAccessTokenProvider'];

  /** One-time Season browser bearer. */
  @Input() buyerAccessToken?: SeasonPickerOptions['buyerAccessToken'];

  /** Operation restored after an uncertain create response. */
  @Input() initialOperationId?: string;

  /**
   * Release, on destroy, a hold the buyer left unfinished (`@seatlayer/js`
   * `releaseHoldOnDestroy`). Default false: destroying the component releases
   * nothing. Not in REBUILD_INPUTS: changing it does not rebuild the picker,
   * which reads the current value when it is destroyed.
   *
   * Do not turn this on if you rebuild the picker (changing inputs the
   * component rebuilds on, REBUILD_INPUTS) or hand the hold to your own
   * checkout without the `continued` output.
   */
  @Input() releaseHoldOnDestroy?: boolean;

  /** The package to open on, by its key; the first package without it. */
  @Input() package?: string;

  /** The host emails a ticket per date itself: step 1 says so. */
  @Input() ticketsByEmail?: boolean;

  /**
   * Offer the Season's single dates beside the passes on a page with its own
   * checkout or session: continuing on a dates hold emits a `continued`
   * handoff whose `dates` names the run, the dates and the held lines; pay it
   * with `startDatesCheckout`. Off by default. Changing it rebuilds.
   */
  @Input() singleDates?: boolean;

  /** Maximum recovery polling time. */
  @Input() recoveryTimeoutMs?: number;

  /** Offer the 3D venue view (default true). Changing it rebuilds. */
  @Input() enable3D?: boolean;

  /** The standing crowd in 3D, drawn by default; false turns it off. Changing it rebuilds. */
  @Input() enable3DCrowd?: boolean;

  /** How fingers move the 3D view: `'map'` (default) or `'classic'`. Changing it rebuilds. */
  @Input() touchNavigation3D?: 'map' | 'classic';

  /** Test or host fetch implementation. */
  @Input() fetch?: typeof fetch;

  /**
   * The price types the picker sells, e.g. `['adult', 'child']`. With a type
   * besides adult, the buyer chooses one per seat before the hold.
   */
  @Input() priceTypes?: readonly SeasonPriceType[];

  /** A same-seat hold reached a safe handoff. */
  @Output() readonly hold = new EventEmitter<SeasonCheckoutHandoff>();

  /** The active handoff changed or was released. */
  @Output() readonly holdChange = new EventEmitter<SeasonCheckoutHandoff | null>();

  /** The buyer continued with an opaque handoff. */
  @Output() readonly continued = new EventEmitter<SeasonCheckoutHandoff>();

  /** A returning holder recorded browser intent only. */
  @Output() readonly renewalIntent = new EventEmitter<SeasonRenewalIntent>();

  /** Buyer access expired. */
  @Output() readonly accessExpired = new EventEmitter<unknown>();

  /** Buyer access cannot be recovered. */
  @Output() readonly accessUnavailable = new EventEmitter<unknown>();

  /** Hosted checkout only: the gateway webhook landed and the order is paid. */
  @Output() readonly orderConfirmed = new EventEmitter<unknown>();

  /** Buyer-visible operation status changed. */
  @Output() readonly statusChange = new EventEmitter<SeasonStatusEvent>();

  /** The Season buyer flow failed. */
  @Output() readonly errored = new EventEmitter<unknown>();

  @ViewChild('container', { static: true })
  private readonly container!: ElementRef<HTMLDivElement>;

  private static readonly REBUILD_INPUTS = new Set([
    'season', 'apiBase', 'publicKey', 'checkout', 'returnUrl',
    'buyerAccessTokenProvider', 'buyerAccessToken',
    'initialOperationId', 'package', 'ticketsByEmail', 'singleDates', 'recoveryTimeoutMs', 'fetch', 'priceTypes',
    'enable3D', 'enable3DCrowd', 'touchNavigation3D',
  ]);
  private readonly zone = inject(NgZone);
  private picker: CoreSeasonPicker | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (Object.keys(changes).some((name) => SeatLayerSeasonPickerComponent.REBUILD_INPUTS.has(name))) {
      this.build();
    }
  }

  /**
   * Holds the same labels across every included occurrence. `priceTypes` names
   * each seat's price type by label (`{ 'A-2': 'child' }`); a label it leaves
   * out is adult.
   */
  holdSameSeat(
    labels: readonly string[], operationId: string, priceTypes?: SeasonSeatPriceTypes,
  ): Promise<SeasonCheckoutHandoff> {
    return this.current().holdSameSeat(labels, operationId, priceTypes);
  }

  /**
   * Holds the best `qty` seats free on every included performance, as a map
   * selection would. Same contract as `@seatlayer/js` `holdBestAvailable`: a
   * caller-stable `sop_` id, 1 to `maxSelection` seats, one call at a time.
   */
  holdBestAvailable(
    qty: number, operationId: string, options?: SeasonBestAvailableOptions,
  ): Promise<SeasonCheckoutHandoff> {
    return this.current().holdBestAvailable(qty, operationId, options);
  }

  /** Restores a caller-stable Season operation after uncertainty. */
  restoreOperation(operationId: string): Promise<SeasonCheckoutHandoff | null> {
    return this.current().restoreOperation(operationId);
  }

  /** Your server booked the held seats: show booked and stop the hold clock. */
  markBooked(): Promise<boolean> {
    return this.current().markBooked();
  }

  /** Releases the active selection with a caller-stable action id. */
  release(releaseActionId: string): Promise<void> {
    return this.current().release(releaseActionId);
  }

  /** As release(), resolving true when the seats were let go, false when nothing was held or the server kept the hold. */
  tryRelease(releaseActionId: string): Promise<boolean> {
    return this.current().tryRelease(releaseActionId);
  }

  /** Records renewal intent; trusted server code still inspects and commits it. */
  createRenewalIntent(offerId: string): Promise<SeasonRenewalIntent> {
    return this.current().createRenewalIntent(offerId);
  }

  /** Current immutable Season descriptor. */
  getDescriptor(): SeasonDescriptor | null {
    return this.picker?.getDescriptor() ?? null;
  }

  /** Current same-seat aggregate availability. */
  getAvailability(): SeasonAvailability | null {
    return this.picker?.getAvailability() ?? null;
  }

  /** Current opaque checkout handoff. */
  getHandoff(): SeasonCheckoutHandoff | null {
    return this.picker?.getHandoff() ?? null;
  }

  /**
   * The held Season order for your own order summary: each held seat with its
   * price type and package price, and the total. Null with no live hold.
   * Display only: checkout prices the order on the server.
   */
  getHeldOrder(): SeasonHeldOrder | null {
    return this.picker?.getHeldOrder() ?? null;
  }

  /**
   * Pay a single-dates hold (`singleDates`) on your own checkout page: the
   * `continued` handoff carries `dates`. Same contract as `@seatlayer/js`
   * `startDatesCheckout`.
   */
  startDatesCheckout(input: SeasonDatesCheckoutInput): Promise<CheckoutSessionResult> {
    return this.current().startDatesCheckout(input);
  }

  private build(): void {
    this.destroy();
    const inputs = this;
    this.zone.runOutsideAngular(() => {
      const picker = new CoreSeasonPicker({
        container: this.container.nativeElement,
        season: this.season,
        apiBase: this.apiBase,
        publicKey: this.publicKey,
        checkout: this.checkout,
        returnUrl: this.returnUrl,
        buyerEmail: this.buyerEmail,
        buyerName: this.buyerName,
        buyerAccessTokenProvider: this.buyerAccessTokenProvider,
        buyerAccessToken: this.buyerAccessToken,
        initialOperationId: this.initialOperationId,
        package: this.package,
        ticketsByEmail: this.ticketsByEmail,
        singleDates: this.singleDates,
        recoveryTimeoutMs: this.recoveryTimeoutMs,
        enable3D: this.enable3D,
        enable3DCrowd: this.enable3DCrowd,
        touchNavigation3D: this.touchNavigation3D,
        fetch: this.fetch,
        priceTypes: this.priceTypes,
        onHold: (value) => this.zone.run(() => this.hold.emit(value)),
        onHoldChange: (value) => this.zone.run(() => this.holdChange.emit(value)),
        onContinue: (value) => this.zone.run(() => this.continued.emit(value)),
        onRenewalIntent: (value) => this.zone.run(() => this.renewalIntent.emit(value)),
        onAccessExpired: (value) => this.zone.run(() => this.accessExpired.emit(value)),
        onAccessUnavailable: (value) => this.zone.run(() => this.accessUnavailable.emit(value)),
        onOrderConfirmed: (value) => this.zone.run(() => this.orderConfirmed.emit(value)),
        onStatusChange: (value) => this.zone.run(() => this.statusChange.emit(value)),
        onError: (value) => this.zone.run(() => this.errored.emit(value)),
        // Not a rebuild input: read from the current input when the picker is destroyed.
        get releaseHoldOnDestroy() { return inputs.releaseHoldOnDestroy; },
      });
      this.picker = picker;
      void picker.render().catch(() => undefined);
    });
  }

  private current(): CoreSeasonPicker {
    if (!this.picker) throw new Error('seatlayer: Angular SeasonPicker is not mounted');
    return this.picker;
  }

  private destroy(): void {
    this.picker?.destroy();
    this.picker = null;
  }
}
