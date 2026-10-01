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
// that renders a control room. One bare import anywhere in this entry undoes
// the split, and it looks like nothing at all in a diff.
} from '@seatlayer/js/manager';

type Opt<K extends keyof SeatManagerOptions> = SeatManagerOptions[K];

/** What the room passes when the operator opens one of your orders. */
export interface SeatManagerOpenOrder {
  id: string;
  displayRef: string;
}

/** What the room passes when the operator opens your trend view for a number. */
export interface SeatManagerOpenTrend {
  kpi: string;
  sectionId?: string;
}

/**
 * True when the host bound a handler to this output. Read once, when the board
 * is built: the room only offers "Open order" and the trend link to a host
 * that can follow them. `observed` is rxjs 7; `observers` covers rxjs 6, which
 * Angular 17 still accepts.
 */
function hasHandler(emitter: object): boolean {
  const subject = emitter as { observed?: boolean; observers?: unknown[] };
  return subject.observed ?? (subject.observers?.length ?? 0) > 0;
}

/**
 * Angular wrapper around the organizer control room from `@seatlayer/js/manager`.
 *
 * Standalone, so it is imported directly rather than through an NgModule. Give
 * the element a size (it fills its box). The board is rebuilt only when
 * `eventKey` or `apiBase` changes. The inputs `@seatlayer/react` updates in
 * place reach the running board through its setters, so camera, selection,
 * live connection and DOM survive; every other input is read once when the
 * board is built.
 *
 * @example
 * ```html
 * <seatlayer-seat-manager
 *   #room
 *   eventKey="ev_9f3a"
 *   [token]="session.token"
 *   [tokenExpiresAt]="session.expiresAt"
 *   [onTokenRefresh]="mintManageSession"
 *   [(mode)]="mode"
 *   (roomStateChange)="onRoomState($event)"
 *   (openOrder)="openOrder($event)"
 * />
 * <button (click)="room.showObjects(resaleSeats, 'Resale')">Show resale</button>
 * ```
 */
@Component({
  selector: 'seatlayer-seat-manager',
  standalone: true,
  template: '<div #container class="seatlayer-container"></div>',
  styles: [':host { display: block; } .seatlayer-container { width: 100%; height: 100%; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeatLayerSeatManagerComponent implements OnChanges {
  /** Event to manage. Changing it rebuilds the board. */
  @Input({ required: true }) eventKey!: string;
  /** API base URL. Changing it rebuilds the board. */
  @Input() apiBase?: string;
  /** Short-lived, event-scoped `mse_` grant from your backend. Live. */
  @Input({ required: true }) token!: EventScopedManageToken;
  /** When `token` expires, epoch ms. Live. */
  @Input() tokenExpiresAt?: number;
  /**
   * Mint a fresh grant before the current one expires. Live. A function input,
   * like `buyerAccessTokenProvider` on the seating chart, because the room
   * needs the new token back.
   */
  @Input() onTokenRefresh?: Opt<'onTokenRefresh'>;
  /** The tool the board shows. Live; pairs with `modeChange` for `[(mode)]`. */
  @Input() mode?: SeatManagerMode;
  /** Which tools the board offers. Read once. */
  @Input() tools?: SeatManagerMode[];
  /** `minimal` shows just the map. Read once. */
  @Input() chrome?: Opt<'chrome'>;
  /** What the token may do. Live. */
  @Input() capabilities?: Opt<'capabilities'>;
  /** Fallback currency for money. Live. */
  @Input() currency?: string;
  /** Colour overrides. Live. */
  @Input() theme?: Opt<'theme'>;
  /** `light`, `dark` or `auto`. Applied before first paint, then live. */
  @Input() themeMode?: Opt<'themeMode'>;
  /** Keep the realtime link open while the tab is hidden. Live. */
  @Input() keepLiveWhileHidden?: boolean;
  /** Follow new bookings on the map. Live; pairs with `followLiveChange`. */
  @Input() followLive?: boolean;
  /** Seats selected once the board loads. Read once. */
  @Input() selectedObjects?: string[];
  /** Seats the operator may select. Live. */
  @Input() selectableObjects?: string[];
  /** Whether unavailable seats can be selected. Live. */
  @Input() unavailableObjectsSelectable?: boolean;
  /** Seats shown as unavailable. Live. */
  @Input() unavailableObjects?: readonly string[];
  /** The hover word for `unavailableObjects`. Live. */
  @Input() unavailableObjectsReason?: string;
  /** Prices the map's hover shows: a map overrides, null hides. Live. */
  @Input() categoryPrices?: Record<string, SeatManagerCategoryPrice> | null;
  /** Cap on the selection. Live. */
  @Input() maxSelectedObjects?: number;
  /** Exact count a valid selection needs. Live. */
  @Input() numberOfPlacesToSelect?: number;
  /** Per-seat selectability rule. Live. */
  @Input() isObjectSelectable?: Opt<'isObjectSelectable'>;
  /** False when your own header shows the numbers. Read once. */
  @Input() kpis?: boolean;
  /** The event's clock for every time the room shows. Read once. */
  @Input() timeZone?: string;
  /** Shown in "Ask an admin of …". Read once. */
  @Input() organizationName?: string;
  /** What you know about the sale. Live, compared by value. */
  @Input() sale?: Opt<'sale'>;
  /** Room your own overlays take over the map, in px. Live, compared by value. */
  @Input() mapInsets?: Opt<'mapInsets'>;
  /** What the map's colours mean when the room opens. Read once. */
  @Input() colourBy?: Opt<'colourBy'>;
  /**
   * Open on this section. Read once. Bound as `[focusSection]`; the class
   * field has another name because `focusSection()` is the handle method that
   * frames a section later, as on React's handle.
   */
  @Input('focusSection') focusSectionOnOpen?: string;
  /** Open on this seat. Read once. */
  @Input() focusSeat?: string;
  /** Open on these seats (an order's seats). Read once. */
  @Input() focusSeats?: string[];
  /** Open on this category. Read once. */
  @Input() focusCategory?: string;
  /** Where the operator came from, for the way back. Read once. */
  @Input() arrivedFrom?: Opt<'arrivedFrom'>;

  /** The board has loaded. */
  @Output() readonly ready: EventEmitter<void> = new EventEmitter<void>();
  /** Live numbers changed. */
  @Output() readonly tallies: EventEmitter<SeatManagerTallies> = new EventEmitter<SeatManagerTallies>();
  /** Something happened on the event. */
  @Output() readonly activity: EventEmitter<SeatManagerActivity> = new EventEmitter<SeatManagerActivity>();
  /** A fresh control room snapshot. */
  @Output() readonly controlRoom: EventEmitter<ControlRoomSnapshot> = new EventEmitter<ControlRoomSnapshot>();
  /** The operator switched tools. */
  @Output() readonly modeChange: EventEmitter<SeatManagerMode> = new EventEmitter<SeatManagerMode>();
  /** Follow-live was switched on or off. */
  @Output() readonly followLiveChange: EventEmitter<boolean> = new EventEmitter<boolean>();
  /** The selection changed. */
  @Output() readonly selectionChange: EventEmitter<ExpandedSeat[]> = new EventEmitter<ExpandedSeat[]>();
  /** One seat was selected. */
  @Output() readonly objectSelected: EventEmitter<ExpandedSeat> = new EventEmitter<ExpandedSeat>();
  /** One seat was deselected. */
  @Output() readonly objectDeselected: EventEmitter<ExpandedSeat> = new EventEmitter<ExpandedSeat>();
  /** Exact-count state changed. */
  @Output() readonly selectionValidityChange: EventEmitter<SeatManagerSelectionValidity> =
    new EventEmitter<SeatManagerSelectionValidity>();
  /** The selection became valid. */
  @Output() readonly selectionValid: EventEmitter<SeatManagerSelectionValidity> =
    new EventEmitter<SeatManagerSelectionValidity>();
  /** The selection became invalid. */
  @Output() readonly selectionInvalid: EventEmitter<SeatManagerSelectionValidity> =
    new EventEmitter<SeatManagerSelectionValidity>();
  /** The selection cap was reached. */
  @Output() readonly selectionLimit: EventEmitter<number> = new EventEmitter<number>();
  /** The filtered sections changed. */
  @Output() readonly filteredSectionChange: EventEmitter<SeatManagerFilteredSection[]> =
    new EventEmitter<SeatManagerFilteredSection[]>();
  /** A general-admission area was clicked. */
  @Output() readonly areaClick: EventEmitter<SeatManagerArea> = new EventEmitter<SeatManagerArea>();
  /** A block, unblock or other action finished. */
  @Output() readonly actionComplete: EventEmitter<SeatManagerActionResult> =
    new EventEmitter<SeatManagerActionResult>();
  /** The realtime link changed state. */
  @Output() readonly connectionChange: EventEmitter<SeatManagerConnection> =
    new EventEmitter<SeatManagerConnection>();
  /** The room changed state: connecting, live, paused, offline or ended. */
  @Output() readonly roomStateChange: EventEmitter<SeatManagerRoomState> =
    new EventEmitter<SeatManagerRoomState>();
  /** Something failed. */
  @Output() readonly errored: EventEmitter<unknown> = new EventEmitter<unknown>();
  /**
   * The operator opened one of your orders. Only when this is bound does the
   * room offer "Open order", so it never shows a dead link.
   */
  @Output() readonly openOrder: EventEmitter<SeatManagerOpenOrder> = new EventEmitter<SeatManagerOpenOrder>();
  /** The operator opened your trend view for a number. Only offered when bound. */
  @Output() readonly openTrend: EventEmitter<SeatManagerOpenTrend> = new EventEmitter<SeatManagerOpenTrend>();
  /** Sections on a chart without any offers "Open the designer". Only offered when bound. */
  @Output() readonly openDesigner: EventEmitter<void> = new EventEmitter<void>();

  @ViewChild('container', { static: true })
  private readonly container!: ElementRef<HTMLDivElement>;

  private readonly zone = inject(NgZone);
  private manager: CoreSeatManager | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Identity: a new event or API is a new board. The build reads every
    // input's current value, so nothing else needs applying on this pass.
    if (!this.manager || 'eventKey' in changes || 'apiBase' in changes) {
      this.build();
      return;
    }
    const manager = this.manager;
    const changed = (name: string) => name in changes;

    // Live inputs: the same set, the same setters and the same fallbacks as
    // the React wrapper's effects. Outside the zone, like the board itself:
    // a repaint must not schedule change detection for the whole app.
    this.zone.runOutsideAngular(() => {
      if (changed('token') || changed('tokenExpiresAt')) manager.setToken(this.token, this.tokenExpiresAt);
      if (changed('capabilities')) manager.setCapabilities(this.capabilities);
      if (changed('currency')) manager.setCurrency(this.currency);
      if (changed('theme')) manager.setTheme(this.theme);
      if (changed('sale') && saleChanged(changes['sale']!.previousValue, this.sale)) manager.setSale(this.sale);
      if (changed('mapInsets') && insetsChanged(changes['mapInsets']!.previousValue, this.mapInsets)) {
        manager.setMapInsets(this.mapInsets ?? null);
      }
      if (changed('themeMode')) manager.setThemeMode(this.themeMode);
      if (changed('keepLiveWhileHidden')) manager.setKeepLiveWhileHidden(this.keepLiveWhileHidden);
      if (changed('onTokenRefresh') && !!changes['onTokenRefresh']!.previousValue !== !!this.onTokenRefresh) {
        manager.setTokenRefresh(this.tokenRefresh());
      }
      if (changed('mode') && this.mode) manager.setMode(this.mode);
      if (changed('followLive') && this.followLive != null) manager.setFollowLive(this.followLive);
      if (changed('selectableObjects')) manager.setSelectableObjects(this.selectableObjects ?? []);
      if (changed('unavailableObjectsSelectable')) {
        manager.setUnavailableObjectsSelectable(this.unavailableObjectsSelectable ?? true);
      }
      if (changed('unavailableObjects') || changed('unavailableObjectsReason')) {
        manager.setUnavailableObjects(this.unavailableObjects ?? [], this.unavailableObjectsReason);
      }
      if (changed('categoryPrices')) manager.setCategoryPrices(this.categoryPrices);
      if (changed('maxSelectedObjects')) manager.setMaxSelectedObjects(this.maxSelectedObjects);
      if (changed('numberOfPlacesToSelect')) manager.setNumberOfPlacesToSelect(this.numberOfPlacesToSelect);
      if (changed('isObjectSelectable')) manager.setObjectSelectable(this.isObjectSelectable);
    });
  }

  // ---------- imperative API, for a template ref ----------
  // The same methods as SeatManagerHandle in @seatlayer/react.

  setMode(mode: SeatManagerMode): void { this.manager?.setMode(mode); }
  setToken(token: EventScopedManageToken, expiresAt?: number): void { this.manager?.setToken(token, expiresAt); }
  setHeatOverlay(enabled: boolean): void { this.manager?.setHeatOverlay(enabled); }
  setFollowLive(enabled: boolean): void { this.manager?.setFollowLive(enabled); }
  setTrendWindow(windowMinutes: number): Promise<ControlRoomSnapshot> {
    return this.manager?.setTrendWindow(windowMinutes) ?? Promise.reject(new Error('not ready'));
  }
  enterFullscreen(): Promise<void> { return this.manager?.enterFullscreen() ?? Promise.resolve(); }
  exitFullscreen(): Promise<void> { return this.manager?.exitFullscreen() ?? Promise.resolve(); }
  isFullscreen(): boolean { return this.manager?.isFullscreen() ?? false; }
  block(labels?: string[], opts?: { releaseAt?: number; reason?: string }): Promise<void> {
    return this.manager?.block(labels, opts) ?? Promise.resolve();
  }
  unblock(labels?: string[]): Promise<void> { return this.manager?.unblock(labels) ?? Promise.resolve(); }
  unblockAll(): Promise<void> { return this.manager?.unblockAll() ?? Promise.resolve(); }
  cancelBooking(labels: string[], bookingRef: string): Promise<void> {
    return this.manager?.cancelBooking(labels, bookingRef) ?? Promise.resolve();
  }
  setCategory(categoryKey: string, labels?: string[]): Promise<void> {
    return this.manager?.setCategory(categoryKey, labels) ?? Promise.resolve();
  }
  setTableBooking(
    tableIds: string[],
    mode: EventTableBookingMode,
    bounds?: { minOccupancy?: number; maxOccupancy?: number },
  ): Promise<void> {
    return this.manager?.setTableBooking(tableIds, mode, bounds) ?? Promise.resolve();
  }
  selectAll(): ExpandedSeat[] { return this.manager?.selectAll() ?? []; }
  selectSection(sectionId: string): ExpandedSeat[] { return this.manager?.selectSection(sectionId) ?? []; }
  selectByLabels(labels: string[]): ExpandedSeat[] { return this.manager?.selectByLabels(labels) ?? []; }
  selectObjects(labels: string[]): ExpandedSeat[] { return this.manager?.selectObjects(labels) ?? []; }
  deselectObjects(labels: string[]): ExpandedSeat[] { return this.manager?.deselectObjects(labels) ?? []; }
  selectCategories(keys: string[]): ExpandedSeat[] { return this.manager?.selectCategories(keys) ?? []; }
  deselectCategories(keys: string[]): ExpandedSeat[] { return this.manager?.deselectCategories(keys) ?? []; }
  setSelectableObjects(labels: string[]): void { this.manager?.setSelectableObjects(labels); }
  setUnavailableObjectsSelectable(enabled: boolean): void { this.manager?.setUnavailableObjectsSelectable(enabled); }
  /** Replace the labels shown as unavailable (and their hover word) without remounting. */
  setUnavailableObjects(labels: readonly string[], reason?: string): void {
    this.manager?.setUnavailableObjects(labels, reason);
  }
  /** Replace the prices the map's hover shows: a map overrides, null hides, undefined uses the chart's. */
  setCategoryPrices(prices: Record<string, SeatManagerCategoryPrice> | null | undefined): void {
    this.manager?.setCategoryPrices(prices);
  }
  setObjectSelectable(predicate: Opt<'isObjectSelectable'>): void { this.manager?.setObjectSelectable(predicate); }
  setMaxSelectedObjects(max: number | undefined): void { this.manager?.setMaxSelectedObjects(max); }
  setNumberOfPlacesToSelect(required: number | undefined): void {
    this.manager?.setNumberOfPlacesToSelect(required);
  }
  getSelectionValidity(): SeatManagerSelectionValidity | null { return this.manager?.getSelectionValidity() ?? null; }
  setFilteredSection(label: string): SeatManagerFilteredSection[] { return this.manager?.setFilteredSection(label) ?? []; }
  clearFilteredSection(): void { this.manager?.clearFilteredSection(); }
  /** Frame matching sections in any mode, without filtering or touching the selection. */
  focusSection(label: string): SeatManagerFilteredSection[] { return this.manager?.focusSection(label) ?? []; }
  getFilteredSections(): SeatManagerFilteredSection[] { return this.manager?.getFilteredSections() ?? []; }
  clearSelection(): void { this.manager?.clearSelection(); }
  getSelection(): ExpandedSeat[] { return this.manager?.getSelection() ?? []; }
  getReport(): Promise<ReportResult> { return this.manager?.getReport() ?? Promise.reject(new Error('not ready')); }
  getControlRoomSnapshot(windowMinutes?: number): Promise<ControlRoomSnapshot> {
    return this.manager?.getControlRoomSnapshot(windowMinutes) ?? Promise.reject(new Error('not ready'));
  }
  getLog(opts?: { limit?: number; before?: number }): Promise<{ entries: LogEntry[]; nextBefore: number | null }> {
    return this.manager?.getLog(opts) ?? Promise.resolve({ entries: [], nextBefore: null });
  }
  setHoldTtl(ms: number | null): Promise<void> { return this.manager?.setHoldTtl(ms) ?? Promise.resolve(); }
  /**
   * Realtime link state plus the "as of" behind the numbers on screen. Null
   * only before the board exists. `connectionChange` gives the edges; this
   * gives the answer on demand.
   */
  getConnection(): SeatManagerConnection | null { return this.manager?.getConnection() ?? null; }
  zoomToFit(): void { this.manager?.zoomToFit(); }
  /** Light these seats and frame them, named in the legend; null clears. */
  showObjects(labels: readonly string[] | null, name?: string): void { this.manager?.showObjects(labels, name); }

  // ---------- internals ----------

  /** Reads the current input on every call, so a swapped handler needs no setter. */
  private tokenRefresh(): Opt<'onTokenRefresh'> {
    return this.onTokenRefresh
      ? () => this.zone.run(() => this.onTokenRefresh!())
      : undefined;
  }

  private build(): void {
    const element = this.container?.nativeElement;
    if (!element) return;

    this.destroy();

    // The board runs a render loop, timers and a socket. Left inside the
    // Angular zone, each of them would schedule change detection for the
    // whole app — so it is built outside, and each callback re-enters the zone
    // only to emit.
    this.zone.runOutsideAngular(() => {
      const emit = <T>(emitter: EventEmitter<T>, value: T) => this.zone.run(() => emitter.emit(value));
      const back = this.arrivedFrom?.back;

      const instance = new CoreSeatManager({
        container: element,
        apiBase: this.apiBase,
        eventKey: this.eventKey,
        token: this.token,
        tokenExpiresAt: this.tokenExpiresAt,
        mode: this.mode,
        currency: this.currency,
        keepLiveWhileHidden: this.keepLiveWhileHidden,
        followLive: this.followLive,
        capabilities: this.capabilities,
        selectedObjects: this.selectedObjects,
        selectableObjects: this.selectableObjects,
        unavailableObjectsSelectable: this.unavailableObjectsSelectable,
        unavailableObjects: this.unavailableObjects,
        unavailableObjectsReason: this.unavailableObjectsReason,
        categoryPrices: this.categoryPrices,
        maxSelectedObjects: this.maxSelectedObjects,
        numberOfPlacesToSelect: this.numberOfPlacesToSelect,
        isObjectSelectable: this.isObjectSelectable,
        tools: this.tools,
        chrome: this.chrome,
        kpis: this.kpis,
        timeZone: this.timeZone,
        organizationName: this.organizationName,
        sale: this.sale,
        mapInsets: this.mapInsets,
        theme: this.theme,
        // Applied before first paint, so a board asked for light never
        // flashes dark on the way in.
        themeMode: this.themeMode,
        colourBy: this.colourBy,
        focusSection: this.focusSectionOnOpen,
        focusSeat: this.focusSeat,
        focusSeats: this.focusSeats,
        focusCategory: this.focusCategory,
        // The way back runs host code (usually the router), so it re-enters the zone.
        arrivedFrom: this.arrivedFrom && back
          ? { ...this.arrivedFrom, back: { ...back, go: () => this.zone.run(() => back.go()) } }
          : this.arrivedFrom,
        // Only a host that bound the output gets the link. Left unset
        // otherwise, so the room never offers a dead one.
        onOpenOrder: hasHandler(this.openOrder) ? (order) => emit(this.openOrder, order) : undefined,
        onOpenTrend: hasHandler(this.openTrend) ? (focus) => emit(this.openTrend, focus) : undefined,
        onOpenDesigner: hasHandler(this.openDesigner) ? () => emit(this.openDesigner, undefined) : undefined,
        onTokenRefresh: this.tokenRefresh(),
        onReady: () => this.zone.run(() => this.ready.emit()),
        onTallies: (tallies) => emit(this.tallies, tallies),
        onActivity: (activity) => emit(this.activity, activity),
        onControlRoom: (snapshot) => emit(this.controlRoom, snapshot),
        onModeChange: (nextMode) => emit(this.modeChange, nextMode),
        onFollowLiveChange: (enabled) => emit(this.followLiveChange, enabled),
        onSelectionChange: (seats) => emit(this.selectionChange, seats),
        onObjectSelected: (object) => emit(this.objectSelected, object),
        onObjectDeselected: (object) => emit(this.objectDeselected, object),
        onSelectionValidityChange: (state) => emit(this.selectionValidityChange, state),
        onSelectionValid: (state) => emit(this.selectionValid, state),
        onSelectionInvalid: (state) => emit(this.selectionInvalid, state),
        onSelectionLimit: (max) => emit(this.selectionLimit, max),
        onFilteredSectionChange: (sections) => emit(this.filteredSectionChange, sections),
        onAreaClick: (area) => emit(this.areaClick, area),
        onActionComplete: (result) => emit(this.actionComplete, result),
        onConnectionChange: (state) => emit(this.connectionChange, state),
        onRoomStateChange: (state) => emit(this.roomStateChange, state),
        onError: (error) => emit(this.errored, error),
      });

      this.manager = instance;
      void instance.render();
    });
  }

  private destroy(): void {
    this.manager?.destroy();
    this.manager = null;
  }
}

/** By value, as React compares it: a rebuilt object with the same facts is no change. */
function saleChanged(previous: Opt<'sale'>, next: Opt<'sale'>): boolean {
  return previous?.status !== next?.status || previous?.tone !== next?.tone
    || previous?.openedAt !== next?.openedAt || previous?.pageUrl !== next?.pageUrl;
}

function insetsChanged(previous: Opt<'mapInsets'>, next: Opt<'mapInsets'>): boolean {
  return previous?.top !== next?.top || previous?.right !== next?.right
    || previous?.bottom !== next?.bottom || previous?.left !== next?.left;
}
