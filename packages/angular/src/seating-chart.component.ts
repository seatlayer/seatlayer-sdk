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
 * Angular wrapper around the framework-agnostic `@seatlayer/js` SDK.
 *
 * Standalone, so it is imported directly rather than through an NgModule.
 *
 * The canvas is created once and torn down on destroy. Only the inputs that
 * change the chart's identity — `event`, `apiBase`, `maxSelection`, `publicKey`,
 * `locale`, `currency`, `colorblindSafe` — trigger a rebuild, so an unrelated
 * change-detection pass never destroys the canvas mid-selection.
 *
 * @example
 * ```html
 * <seatlayer-seating-chart
 *   #chart
 *   event="summer-gala"
 *   (selectionChange)="onSelectionChange($event)"
 *   (hold)="onHold($event)"
 * />
 * <button (click)="chart.hold()">Continue</button>
 * ```
 */
@Component({
  selector: 'seatlayer-seating-chart',
  standalone: true,
  template: '<div #container class="seatlayer-container"></div>',
  styles: [':host { display: block; } .seatlayer-container { width: 100%; height: 100%; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeatLayerSeatingChartComponent implements OnChanges {
  /** Event key to render. Changing it rebuilds the chart. */
  @Input({ required: true }) event!: string;

  /** API base URL. Defaults to the public API. */
  @Input() apiBase?: string;

  /** Cap on how many seats a buyer may select. */
  @Input() maxSelection?: number;

  /** Publishable key, when your integration uses one. */
  @Input() publicKey?: string;

  /** BCP-47 locale for built-in copy. */
  @Input() locale?: string;

  /** ISO currency for price formatting. */
  @Input() currency?: string;

  /** Render with colorblind-safe seat glyphs. */
  @Input() colorblindSafe?: boolean;

  /** Show the built-in seat tooltip. Set false to draw your own from `seatHover`. */
  @Input() seatTooltip?: boolean;

  /** Copy overrides, read once per rebuild. */
  @Input() messages?: SeatingChartOptions['messages'];

  /**
   * Sales Channels: mint a buyer access session on demand. Called with a
   * `reason`; returns `{ token, expiresAt }` from YOUR backend. The token is
   * held in memory only — never storage, never a URL, never a log.
   */
  @Input() buyerAccessTokenProvider?: BuyerAccessTokenProvider;

  /** One-shot session for hosts that own the lifecycle. Cannot be renewed. */
  @Input() buyerAccessToken?: string | BuyerAccessToken;

  /** The buyer's selection changed. */
  @Output() readonly selectionChange: EventEmitter<SelectedSeat[]> = new EventEmitter<SelectedSeat[]>();

  /** A hold succeeded. */
  @Output() readonly hold: EventEmitter<HoldResult> = new EventEmitter<HoldResult>();

  /** A previous hold was restored on mount. */
  @Output() readonly holdRestored: EventEmitter<HoldResult> = new EventEmitter<HoldResult>();

  /** The active hold lapsed. */
  @Output() readonly holdExpired: EventEmitter<void> = new EventEmitter<void>();

  /** A GA area was clicked. */
  @Output() readonly gaClick: EventEmitter<GAAreaAvailability> = new EventEmitter<GAAreaAvailability>();

  /** Something failed — a network error, a rejected hold. */
  @Output() readonly errored: EventEmitter<unknown> = new EventEmitter<unknown>();

  /** A floor deck was tapped in the 3D view. */
  @Output() readonly deckTap: EventEmitter<string> = new EventEmitter<string>();

  /** A transient hint worth showing the buyer, or `null` to clear it. */
  @Output() readonly hint: EventEmitter<string | null> = new EventEmitter<string | null>();

  /** The pointer moved onto a seat, or off one (`null`). */
  @Output() readonly seatHover: EventEmitter<SeatHoverDetails | null> = new EventEmitter<SeatHoverDetails | null>();

  /** The buyer access session lapsed; `refreshed` says whether it recovered. */
  @Output() readonly accessExpired: EventEmitter<BuyerAccessExpiredEvent> =
    new EventEmitter<BuyerAccessExpiredEvent>();

  /** Private inventory is unavailable and refreshing will not fix it. */
  @Output() readonly accessUnavailable: EventEmitter<BuyerAccessUnavailableEvent> =
    new EventEmitter<BuyerAccessUnavailableEvent>();

  /** Selected-but-unheld units stopped being selectable. */
  @Output() readonly selectedObjectUnavailable: EventEmitter<SelectedObjectUnavailableEvent> =
    new EventEmitter<SelectedObjectUnavailableEvent>();

  @ViewChild('container', { static: true })
  private readonly container!: ElementRef<HTMLDivElement>;

  private readonly zone = inject(NgZone);
  private chart: CoreSeatingChart | null = null;

  /** Inputs that require tearing the canvas down and rebuilding it. */
  private static readonly REBUILD_INPUTS = [
    'event', 'apiBase', 'maxSelection', 'publicKey', 'locale', 'currency', 'colorblindSafe',
  ] as const;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  ngOnChanges(changes: SimpleChanges): void {
    const needsRebuild = SeatLayerSeatingChartComponent.REBUILD_INPUTS.some((name) => name in changes);
    if (needsRebuild) {
      this.build();
    }
  }

  // ---------- imperative API, for a template ref ----------

  /** Hold the current selection. Resolves the hold, or `null` on a 409 conflict. */
  holdSelection(options?: { ttlMs?: number }): Promise<HoldResult | null> {
    return this.chart?.hold(options) ?? Promise.resolve(null);
  }

  /** Restore an active hold by its opaque id. */
  resumeHold(holdId: string): Promise<HoldResult | null> {
    return this.chart?.resumeHold(holdId) ?? Promise.resolve(null);
  }

  /** Current active hold known to the chart. */
  getCurrentHold(): HoldResult | null {
    return this.chart?.getCurrentHold() ?? null;
  }

  /** GA areas with live remaining capacity. */
  getGAAreas(): GAAreaAvailability[] {
    return this.chart?.getGAAreas() ?? [];
  }

  /** Atomically hold a quantity from one GA area. */
  holdGA(
    areaId: string,
    qty: number,
    options?: { tierId?: string | null; ttlMs?: number },
  ): Promise<HoldResult | null> {
    return this.chart?.holdGA(areaId, qty, options) ?? Promise.resolve(null);
  }

  /** Ask the server for the `qty` best free seats and hold them atomically. */
  bestAvailable(qty: number, categoryKey?: string): Promise<BestAvailableResult | null> {
    return this.chart?.bestAvailable(qty, categoryKey) ?? Promise.resolve(null);
  }

  /** Release the current hold (if any). */
  release(): Promise<void> {
    return this.chart?.release() ?? Promise.resolve();
  }

  /** Release some held labels while keeping the remainder active. */
  releaseLabels(labels: string[]): Promise<boolean> {
    return this.chart?.releaseLabels(labels) ?? Promise.resolve(false);
  }

  /** The current selection, with prices resolved from the chart categories. */
  getSelection(): SelectedSeat[] {
    return this.chart?.getSelection() ?? [];
  }

  /** Choose a ticket tier for a selected seat; `null` reverts to the default. */
  setSeatTier(seatId: string, tierId: string | null): void {
    this.chart?.setSeatTier(seatId, tierId);
  }

  /** Floors of a multi-floor chart. Empty before the first render. */
  getFloors(): { id: string; name: string }[] {
    return this.chart?.getFloors() ?? [];
  }

  /** Switch the shown floor (2D). No-ops on single-floor charts. */
  setFloor(floorId: string): void {
    this.chart?.setFloor(floorId);
  }

  /** Toggle colorblind-safe rendering at runtime. */
  setColorblindSafe(on: boolean): void {
    this.chart?.setColorblindSafe(on);
  }

  /** Zoom in one step (same increment as the wheel/pinch gesture). */
  zoomIn(): void {
    this.chart?.zoomIn();
  }

  /** Zoom out one step. */
  zoomOut(): void {
    this.chart?.zoomOut();
  }

  /** Reset the camera so the whole chart fits the container. */
  zoomToFit(): void {
    this.chart?.zoomToFit();
  }

  /**
   * Re-acquire the buyer access session after your app re-authorizes the buyer
   * (Sales Channels). Resolves false when the chart is not access-scoped.
   */
  refreshAccess(): Promise<boolean> {
    return this.chart?.refreshAccess() ?? Promise.resolve(false);
  }

  // ---------- internals ----------

  private build(): void {
    const element = this.container?.nativeElement;
    if (!element) return;

    this.destroy();

    // The chart runs a rAF render loop and pointer handlers. Left inside the
    // Angular zone, every frame would schedule change detection for the whole
    // application — so it is built outside, and each callback re-enters the zone
    // only to emit, which is the only part Angular needs to see.
    this.zone.runOutsideAngular(() => {
      const emit = <T>(emitter: EventEmitter<T>, value: T) =>
        this.zone.run(() => emitter.emit(value));

      const instance = new CoreSeatingChart({
        container: element,
        event: this.event,
        apiBase: this.apiBase,
        maxSelection: this.maxSelection,
        publicKey: this.publicKey,
        locale: this.locale,
        currency: this.currency,
        colorblindSafe: this.colorblindSafe,
        seatTooltip: this.seatTooltip,
        messages: this.messages,
        onSelectionChange: (seats) => emit(this.selectionChange, seats),
        onHold: (result) => emit(this.hold, result),
        onHoldRestored: (result) => emit(this.holdRestored, result),
        onHoldExpired: () => this.zone.run(() => this.holdExpired.emit()),
        onGAClick: (area) => emit(this.gaClick, area),
        onError: (error) => emit(this.errored, error),
        onDeckTap: (floorId) => emit(this.deckTap, floorId),
        onHint: (message) => emit(this.hint, message),
        onSeatHover: (details) => emit(this.seatHover, details),
        buyerAccessTokenProvider: this.buyerAccessTokenProvider,
        buyerAccessToken: this.buyerAccessToken,
        onAccessExpired: (state) => emit(this.accessExpired, state),
        onAccessUnavailable: (state) => emit(this.accessUnavailable, state),
        onSelectedObjectUnavailable: (state) => emit(this.selectedObjectUnavailable, state),
      });

      this.chart = instance;
      void instance.render();
    });
  }

  private destroy(): void {
    this.chart?.destroy();
    this.chart = null;
  }
}
