/**
 * SeatingChart — the embeddable buyer picker.
 *
 * A thin wrapper over the shared PickerController (src/picker/PickerController):
 * it owns the mount <div> + the public embed contract (hold-only — the SDK hands
 * the holdId to the host page for a server-side book) and delegates all transport
 * + booking to the controller, so the SDK inherits every fix made for the live
 * buyer page and the demo picker.
 */
import { PickerController, type PickerSeat } from '@seatlayer/core';
import { PubApi, type BestAvailableResult, type HoldResult } from './api';

const DEFAULT_API_BASE = 'https://seatmap-api.paiteq.in';
const DEFAULT_MAX_SELECTION = 10;

/** A seat as surfaced to the host page (prices resolved from the chart's categories). */
export type SelectedSeat = PickerSeat;

export interface SeatingChartOptions {
  /** CSS selector or an HTMLElement to render into. */
  container: string | HTMLElement;
  /** Event key, e.g. `ev_xxx`. */
  event: string;
  /** API origin. Defaults to https://seatmap-api.paiteq.in. */
  apiBase?: string;
  /** Reserved for future authenticated rendering — accepted + stored, not yet sent. */
  publicKey?: string;
  /** Max seats selectable at once (default 10). */
  maxSelection?: number;
  onSelectionChange?: (seats: SelectedSeat[]) => void;
  onHold?: (result: HoldResult) => void;
  onError?: (err: unknown) => void;
}

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (!el) throw new Error(`seatmap: container "${container}" not found`);
    return el as HTMLElement;
  }
  if (!(container instanceof HTMLElement)) {
    throw new Error('seatmap: container must be a CSS selector or an HTMLElement');
  }
  return container;
}

export class SeatingChart {
  private readonly opts: SeatingChartOptions;
  private readonly controller: PickerController;
  /** Reserved for future authenticated rendering — stored, not yet sent on any request. */
  readonly publicKey?: string;

  private mount: HTMLElement | null = null;
  private hostEl: HTMLDivElement | null = null;
  private rendered = false;

  constructor(options: SeatingChartOptions) {
    if (!options || typeof options !== 'object') throw new Error('seatmap: options object is required');
    if (!options.container) throw new Error('seatmap: `container` is required');
    if (!options.event || typeof options.event !== 'string') throw new Error('seatmap: `event` key is required');

    this.opts = options;
    this.publicKey = options.publicKey;
    const api = new PubApi((options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''));
    this.controller = new PickerController({
      transport: api,
      eventKey: options.event,
      maxSelection: options.maxSelection ?? DEFAULT_MAX_SELECTION,
      onSelectionChange: (seats) => this.opts.onSelectionChange?.(seats),
      onHold: (h) => this.opts.onHold?.({ holdId: h.holdId, expiresAt: h.expiresAt }),
      onError: (err) => this.opts.onError?.(err),
    });
  }

  /** Fetch the chart, mount the renderer, seed statuses and go live. Idempotent. */
  async render(): Promise<this> {
    if (this.rendered) return this;
    this.rendered = true;

    // Mount an owned <div> inside the caller's container so we never fight their
    // layout and can cleanly remove it on destroy().
    this.mount = resolveContainer(this.opts.container);
    const host = document.createElement('div');
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.position = 'relative';
    this.mount.appendChild(host);
    this.hostEl = host;

    const ok = await this.controller.render(host);
    if (!ok) this.rendered = false; // render() already emitted the error
    return this;
  }

  /** Current selection with prices resolved from the chart categories. */
  getSelection(): SelectedSeat[] {
    return this.controller.getSelection();
  }

  /** Hold the current selection. Resolves the hold, or null on a 409 conflict. */
  async hold(): Promise<HoldResult | null> {
    try {
      const h = await this.controller.hold();
      return h ? { holdId: h.holdId, expiresAt: h.expiresAt } : null;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** Ask the server for the `qty` best free seats and hold them atomically. */
  async bestAvailable(qty: number, categoryKey?: string): Promise<BestAvailableResult | null> {
    try {
      const h = await this.controller.bestAvailable(qty, categoryKey);
      return h ? { holdId: h.holdId, expiresAt: h.expiresAt, labels: h.labels } : null;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  /** Release the current hold (if any). No-op when nothing is held. */
  async release(): Promise<void> {
    await this.controller.release();
  }

  /** Tear everything down: close the socket, stop timers, drop the canvas. */
  destroy(): void {
    this.controller.destroy();
    if (this.hostEl && this.hostEl.parentNode) this.hostEl.parentNode.removeChild(this.hostEl);
    this.hostEl = null;
    this.mount = null;
    this.rendered = false;
  }
}
