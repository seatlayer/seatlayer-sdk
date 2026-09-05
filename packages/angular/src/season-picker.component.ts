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
  type SeasonAvailability,
  type SeasonCheckoutHandoff,
  type SeasonDescriptor,
  type SeasonPickerOptions,
  type SeasonRenewalIntent,
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

  /** Refreshable one-time browser bearer provider. */
  @Input() buyerAccessTokenProvider?: SeasonPickerOptions['buyerAccessTokenProvider'];

  /** One-time Season browser bearer. */
  @Input() buyerAccessToken?: SeasonPickerOptions['buyerAccessToken'];

  /** Operation restored after an uncertain create response. */
  @Input() initialOperationId?: string;

  /** Maximum recovery polling time. */
  @Input() recoveryTimeoutMs?: number;

  /** Test or host fetch implementation. */
  @Input() fetch?: typeof fetch;

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
    'initialOperationId', 'recoveryTimeoutMs', 'fetch',
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

  /** Holds the same labels across every included occurrence. */
  holdSameSeat(labels: readonly string[], operationId: string): Promise<SeasonCheckoutHandoff> {
    return this.current().holdSameSeat(labels, operationId);
  }

  /** Restores a caller-stable Season operation after uncertainty. */
  restoreOperation(operationId: string): Promise<SeasonCheckoutHandoff | null> {
    return this.current().restoreOperation(operationId);
  }

  /** Releases the active selection with a caller-stable action id. */
  release(releaseActionId: string): Promise<void> {
    return this.current().release(releaseActionId);
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

  private build(): void {
    this.destroy();
    this.zone.runOutsideAngular(() => {
      const picker = new CoreSeasonPicker({
        container: this.container.nativeElement,
        season: this.season,
        apiBase: this.apiBase,
        publicKey: this.publicKey,
        checkout: this.checkout,
        returnUrl: this.returnUrl,
        buyerAccessTokenProvider: this.buyerAccessTokenProvider,
        buyerAccessToken: this.buyerAccessToken,
        initialOperationId: this.initialOperationId,
        recoveryTimeoutMs: this.recoveryTimeoutMs,
        fetch: this.fetch,
        onHold: (value) => this.zone.run(() => this.hold.emit(value)),
        onHoldChange: (value) => this.zone.run(() => this.holdChange.emit(value)),
        onContinue: (value) => this.zone.run(() => this.continued.emit(value)),
        onRenewalIntent: (value) => this.zone.run(() => this.renewalIntent.emit(value)),
        onAccessExpired: (value) => this.zone.run(() => this.accessExpired.emit(value)),
        onAccessUnavailable: (value) => this.zone.run(() => this.accessUnavailable.emit(value)),
        onOrderConfirmed: (value) => this.zone.run(() => this.orderConfirmed.emit(value)),
        onStatusChange: (value) => this.zone.run(() => this.statusChange.emit(value)),
        onError: (value) => this.zone.run(() => this.errored.emit(value)),
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
