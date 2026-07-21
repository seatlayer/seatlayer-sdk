/**
 * A secure, framework-neutral host for the SeatLayer chart Designer.
 *
 * The Designer remains an iframe so a platform never gives its SeatLayer secret
 * key to a browser. This class owns the iframe lifecycle and accepts messages
 * only from that iframe's exact origin.
 */
export type EmbeddedDesignerEventType =
  | 'seatlayer.designer.ready'
  | 'seatlayer.designer.saved'
  | 'seatlayer.designer.published'
  | 'seatlayer.designer.close'
  | 'seatlayer.designer.error';

export interface EmbeddedDesignerMessage {
  type: EmbeddedDesignerEventType;
  chartId?: string;
  workspaceId?: string;
  expiresAt?: number;
  code?: string;
  message?: string;
  meta?: unknown;
}

export interface EmbeddedDesignerOptions {
  /** The short-lived URL returned by your backend's Designer-session call. */
  designerUrl: string;
  /** CSS selector or element where the iframe is mounted. */
  container: string | HTMLElement;
  /** Verify the message belongs to the chart your backend opened. */
  expectedChartId?: string;
  /** Verify the message belongs to the workspace your backend opened. */
  expectedWorkspaceId?: string;
  title?: string;
  className?: string;
  style?: Partial<CSSStyleDeclaration>;
  allow?: string;
  referrerPolicy?: ReferrerPolicy;
  /**
   * Show the built-in branded loading skeleton and error/expiry card inside the
   * container while the Designer boots. Defaults to `true`. Set `false` when the
   * host renders its own loading and error chrome.
   */
  showLoadingState?: boolean;
  /**
   * If the Designer never posts `ready` within this many milliseconds, the host
   * transitions to the error card with a timeout message. Defaults to `20000`.
   * Only used when `showLoadingState` is enabled.
   */
  loadingTimeoutMs?: number;
  /**
   * How to size the iframe's height. The Designer is a full application (its
   * shell is `position:fixed; height:100dvh`), not flowing content, so it should
   * fill its box rather than be measured.
   *
   * - `'fill'` (default): container-aware. On mount the SDK probes whether the
   *   host gave the container a DEFINITE (bounded) height:
   *     - **Bounded container** (a fixed-height block, `height`/`max-height`,
   *       `flex:1; min-h:0`, a resolved `%`, etc.) → the iframe fills 100% of
   *       that block and tracks its size live via a `ResizeObserver`.
   *     - **Content-sized container** (the block collapses to whatever the iframe
   *       measures — typical full-page usage) → the iframe grows so its bottom
   *       edge reaches the bottom of the viewport (`window.innerHeight -
   *       iframe.top`), recomputed (rAF-throttled) on `resize` /
   *       `orientationchange` / `scroll`.
   *   Either way the result is clamped to `minHeight`. The verdict is cached but
   *   re-probed on `resize`/`orientationchange` so a responsive host layout can
   *   flip between the two. The legacy `seatlayer.designer.resize` message is
   *   ignored in `'fill'` mode: it is circular, because the fixed-position shell
   *   just echoes the iframe height.
   * - a number: a fixed pixel height. In this mode the legacy resize message is
   *   still honoured (unless `autoResize` is `false`) so older hosts keep growing.
   *
   * All SDK-managed heights are written with `!important` priority so a host
   * theme's `iframe { height: … !important }` cannot override them.
   */
  height?: 'fill' | number;
  /** Minimum height (px) that `'fill'` mode clamps to. Defaults to `480`. */
  minHeight?: number;
  /**
   * Auto-grow the iframe to the height the Designer reports over the resize
   * protocol (`seatlayer.designer.resize`). Only applies when `height` is a fixed
   * number; ignored in `'fill'` mode. Defaults to `true`. Set `false` when the
   * host sizes a fixed-height iframe itself.
   */
  autoResize?: boolean;
  /**
   * Called when the user presses "Try again" on the error card. Use it to mint a
   * fresh Designer session and call `setDesignerUrl()` with the new URL, which
   * recreates the iframe and returns to the loading state. When omitted, "Try
   * again" reloads the current `designerUrl` in place.
   */
  onRequestRelaunch?: () => void;
  onReady?: (message: EmbeddedDesignerMessage) => void;
  onSaved?: (message: EmbeddedDesignerMessage) => void;
  onPublished?: (message: EmbeddedDesignerMessage) => void;
  onClose?: (message: EmbeddedDesignerMessage) => void;
  onError?: (message: EmbeddedDesignerMessage) => void;
}

const TYPES = new Set<EmbeddedDesignerEventType>([
  'seatlayer.designer.ready',
  'seatlayer.designer.saved',
  'seatlayer.designer.published',
  'seatlayer.designer.close',
  'seatlayer.designer.error',
]);

const DEFAULT_LOADING_TIMEOUT_MS = 20000;
const DEFAULT_MIN_FILL_HEIGHT = 480;
/**
 * Container-fill detection tunables. The probe drives the iframe to two extreme
 * heights within one synchronous task (no paint between reads, so no flash) and
 * watches whether the container tracks it.
 */
const FILL_PROBE_HEIGHT_PX = 100000; // "huge" iframe used to see if the box grows with it
const FILL_PROBE_TRACK_EPSILON_PX = 4; // container grew with the iframe ⇒ content-sized
const FILL_MIN_DEFINITE_HEIGHT_PX = 50; // a bounded box must keep at least this much height

/** Internal reason the error card is being shown, used to pick human copy. */
type ErrorCause = 'expired' | 'mismatch' | 'timeout' | 'load';

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container !== 'string') return container;
  const element = document.querySelector<HTMLElement>(container);
  if (!element) throw new Error(`EmbeddedDesigner container not found: ${container}`);
  return element;
}

/** Map an error message's `code` onto one of the human-copy causes. */
function causeFromCode(code: string | undefined): ErrorCause {
  const value = (code ?? '').toLowerCase();
  if (value.includes('expire') || value.includes('revoke') || value === '401') return 'expired';
  if (value.includes('mismatch')) return 'mismatch';
  if (value.includes('timeout')) return 'timeout';
  return 'load';
}

const ERROR_COPY: Record<ErrorCause, { title: string; body: string }> = {
  expired: {
    title: 'This design session expired',
    body: 'For your security, editing sessions are short-lived. Start a fresh one to keep designing.',
  },
  mismatch: {
    title: "This editor doesn't match this chart",
    body: 'The session that loaded belongs to a different chart or workspace. Reopen the designer to continue.',
  },
  timeout: {
    title: 'The designer is taking too long',
    body: 'It did not finish loading in time. This is usually a slow connection — try again.',
  },
  load: {
    title: "We couldn't load the designer",
    body: 'Something went wrong while opening the editor. Please try again.',
  },
};

/** Mount, replace, and destroy a scoped Designer iframe safely. */
export class EmbeddedDesigner {
  private options: EmbeddedDesignerOptions;
  private frame: HTMLIFrameElement | null = null;
  private designerOrigin = '';
  private overlay: HTMLDivElement | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private phase: 'loading' | 'ready' | 'error' = 'loading';
  private restoreContainerPosition: string | null = null;
  // Host-side fullscreen pin: saved state we restore on `off`/Escape/destroy.
  private pinned = false;
  private frameStyleBeforeFs: string | null = null;
  private docOverflowBeforeFs: string | null = null;
  private bodyOverflowBeforeFs: string | null = null;
  private fsKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  /** Latest height (px string) the Designer reported; re-applied after unpin. */
  private lastAutoHeight = '';
  // Fill sizing: pending rAF handles + whether window listeners are attached.
  private fillRaf: number | null = null;
  private reprobeRaf: number | null = null;
  private fillListening = false;
  /** Resolved container element (fill measurement + ResizeObserver target). */
  private containerEl: HTMLElement | null = null;
  /** Cached fill verdict: 'container' = bounded block, 'viewport' = full page. */
  private fillMode: 'viewport' | 'container' | null = null;
  /** Live block-size tracking in container-fill mode; disconnected on destroy. */
  private resizeObs: ResizeObserver | null = null;

  constructor(options: EmbeddedDesignerOptions) {
    this.options = options;
  }

  mount(): HTMLIFrameElement {
    this.destroy();
    const url = new URL(this.options.designerUrl, window.location.href);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('EmbeddedDesigner requires an HTTPS designerUrl outside local development.');
    }
    this.designerOrigin = url.origin;

    const frame = document.createElement('iframe');
    frame.title = this.options.title ?? 'Venue chart Designer';
    frame.allow = this.options.allow ?? 'fullscreen; clipboard-write';
    frame.referrerPolicy = this.options.referrerPolicy ?? 'origin';
    frame.src = url.toString();
    // Width/height are written with `!important` priority so a host theme's
    // `iframe { height: … !important }` cannot beat the SDK's inline sizing.
    frame.style.setProperty('width', '100%', 'important');
    // `'fill'` (default) is (re)computed once the frame is in the DOM (see
    // startFill); a numeric height is a fixed pixel box.
    frame.style.setProperty(
      'height',
      typeof this.options.height === 'number' ? `${this.options.height}px` : '100%',
      'important',
    );
    frame.style.border = '0';
    Object.assign(frame.style, this.options.style);
    if (this.options.className) frame.className = this.options.className;

    const container = resolveContainer(this.options.container);
    this.containerEl = container;
    window.addEventListener('message', this.handleMessage);
    container.append(frame);
    this.frame = frame;

    // Fill mode owns the height from the viewport now the frame is measurable.
    if (this.fillEnabled()) this.startFill();

    this.phase = 'loading';
    if (this.loadingStateEnabled()) {
      this.ensureContainerPositioned(container);
      this.renderOverlay(container, 'loading');
      const timeout = this.options.loadingTimeoutMs ?? DEFAULT_LOADING_TIMEOUT_MS;
      if (timeout > 0 && Number.isFinite(timeout)) {
        this.timeoutTimer = setTimeout(() => {
          if (this.phase === 'loading') this.showError('timeout');
        }, timeout);
      }
    }
    return frame;
  }

  /** Replace the iframe instead of assigning a new fragment to an existing one. */
  setDesignerUrl(designerUrl: string): HTMLIFrameElement {
    this.options = { ...this.options, designerUrl };
    // mount() tears everything down and re-enters the loading state.
    return this.mount();
  }

  getIframe(): HTMLIFrameElement | null {
    return this.frame;
  }

  destroy(): void {
    window.removeEventListener('message', this.handleMessage);
    this.stopFill();
    this.unpinFullscreen();
    this.clearTimeoutTimer();
    this.removeOverlay();
    this.restoreContainerStyle();
    this.frame?.remove();
    this.frame = null;
    this.containerEl = null;
    this.fillMode = null;
    this.designerOrigin = '';
    this.phase = 'loading';
    this.lastAutoHeight = '';
  }

  private loadingStateEnabled(): boolean {
    return this.options.showLoadingState !== false;
  }

  private autoResizeEnabled(): boolean {
    return this.options.autoResize !== false;
  }

  /** Fill mode is the default; a numeric `height` opts into a fixed pixel box. */
  private fillEnabled(): boolean {
    return typeof this.options.height !== 'number';
  }

  /** Write an SDK-managed height with `!important` so a host theme can't win. */
  private setFrameHeight(value: string): void {
    this.frame?.style.setProperty('height', value, 'important');
  }

  /**
   * Decide whether the host gave the container a DEFINITE (bounded) height — a
   * fixed block the embed should fill 100% of — versus a content-sized container
   * that collapses to whatever the iframe measures (full-page usage).
   *
   * We drive the iframe to two extreme heights within a single synchronous task
   * and watch whether the container follows: a bounded box barely moves, a
   * content-sized one grows with the iframe. Because we restore the height before
   * yielding, the browser only lays out — it never paints the extremes, so there
   * is no visible flash. Works for px, resolved `%`, and flex (`flex:1;min-h:0`)
   * heights, and leaves a mere `min-height` floor classified as content-sized so
   * full-page hosts keep the old viewport-fill behavior.
   */
  private detectFillMode(): 'viewport' | 'container' {
    const container = this.containerEl;
    const frame = this.frame;
    if (this.pinned || !container || !frame) return this.fillMode ?? 'viewport';
    const measure = (): number => container.getBoundingClientRect().height;
    const savedValue = frame.style.getPropertyValue('height');
    const savedPriority = frame.style.getPropertyPriority('height');

    frame.style.setProperty('height', '0px', 'important');
    const collapsed = measure();
    frame.style.setProperty('height', `${FILL_PROBE_HEIGHT_PX}px`, 'important');
    const expanded = measure();

    if (savedValue) frame.style.setProperty('height', savedValue, savedPriority);
    else frame.style.removeProperty('height');

    const tracksIframe = expanded - collapsed > FILL_PROBE_TRACK_EPSILON_PX;
    const bounded = !tracksIframe && collapsed >= FILL_MIN_DEFINITE_HEIGHT_PX;
    return bounded ? 'container' : 'viewport';
  }

  /**
   * Size the iframe for the current fill verdict, clamped to `minHeight`. In
   * container mode it fills 100% of the bounded block; in viewport mode its
   * bottom edge meets the bottom of the viewport (`window.innerHeight - top`).
   * No-op while pinned fullscreen (the pin fills the viewport itself).
   */
  private applyFill(): void {
    if (!this.frame || this.pinned) return;
    const min = this.options.minHeight ?? DEFAULT_MIN_FILL_HEIGHT;
    if (this.fillMode === 'container' && this.containerEl) {
      const target = Math.max(min, Math.round(this.containerEl.getBoundingClientRect().height));
      this.setFrameHeight(`${target}px`);
      return;
    }
    const top = this.frame.getBoundingClientRect().top;
    const target = Math.max(min, Math.round(window.innerHeight - top));
    this.setFrameHeight(`${target}px`);
  }

  /** rAF-throttled fill recompute, so a burst of scroll/RO ticks coalesces. */
  private scheduleFill = (): void => {
    if (this.fillRaf !== null) return;
    this.fillRaf = requestAnimationFrame(() => {
      this.fillRaf = null;
      this.applyFill();
    });
  };

  /**
   * rAF-throttled re-probe: a host layout change (responsive breakpoint, a block
   * gaining/losing a definite height) can flip the verdict, so `resize` /
   * `orientationchange` re-detect and swap the container observer accordingly.
   */
  private scheduleReprobe = (): void => {
    if (this.reprobeRaf !== null) return;
    this.reprobeRaf = requestAnimationFrame(() => {
      this.reprobeRaf = null;
      if (this.pinned) return;
      this.fillMode = this.detectFillMode();
      this.syncContainerObserver();
      this.applyFill();
    });
  };

  /** Attach/detach the container ResizeObserver to match the current verdict. */
  private syncContainerObserver(): void {
    const want =
      this.fillMode === 'container' && !!this.containerEl && typeof ResizeObserver !== 'undefined';
    if (want && !this.resizeObs) {
      this.resizeObs = new ResizeObserver(() => this.scheduleFill());
      this.resizeObs.observe(this.containerEl!);
    } else if (!want && this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs = null;
    }
  }

  private startFill(): void {
    this.fillMode = this.detectFillMode();
    this.syncContainerObserver();
    this.applyFill();
    if (this.fillListening) return;
    this.fillListening = true;
    // Layout-changing events re-probe (the verdict can flip); scroll only shifts
    // the viewport-fill top offset, so it just re-applies.
    window.addEventListener('resize', this.scheduleReprobe);
    window.addEventListener('orientationchange', this.scheduleReprobe);
    window.addEventListener('scroll', this.scheduleFill, { passive: true });
  }

  private stopFill(): void {
    if (this.fillRaf !== null) {
      cancelAnimationFrame(this.fillRaf);
      this.fillRaf = null;
    }
    if (this.reprobeRaf !== null) {
      cancelAnimationFrame(this.reprobeRaf);
      this.reprobeRaf = null;
    }
    if (this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs = null;
    }
    if (!this.fillListening) return;
    this.fillListening = false;
    window.removeEventListener('resize', this.scheduleReprobe);
    window.removeEventListener('orientationchange', this.scheduleReprobe);
    window.removeEventListener('scroll', this.scheduleFill);
  }

  /**
   * Pin the iframe over the host page as a viewport-filling overlay. We save the
   * iframe's inline style and the document scroll state so `unpinFullscreen`
   * restores everything exactly. Escape (host-side) also exits.
   */
  private pinFullscreen(): void {
    if (this.pinned || !this.frame) return;
    this.pinned = true;
    this.frameStyleBeforeFs = this.frame.getAttribute('style');
    // Every pin property is `!important` so a host theme's `iframe { … }` rules
    // (height/width/inset) can't unpin us. `inset` is written as its four longhands
    // for reliability across engines. Restored wholesale via the saved style attr.
    const pin: Record<string, string> = {
      position: 'fixed',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      margin: '0',
      border: '0',
      'z-index': '2147483000',
      background: '#101625',
    };
    for (const [property, value] of Object.entries(pin)) {
      this.frame.style.setProperty(property, value, 'important');
    }

    const docEl = document.documentElement;
    this.docOverflowBeforeFs = docEl.style.overflow;
    docEl.style.overflow = 'hidden';
    if (document.body) {
      this.bodyOverflowBeforeFs = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    this.fsKeyHandler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') this.unpinFullscreen();
    };
    window.addEventListener('keydown', this.fsKeyHandler);
  }

  /** Undo `pinFullscreen`: restore the iframe style + scroll lock. Idempotent. */
  private unpinFullscreen(): void {
    if (!this.pinned) return;
    this.pinned = false;
    if (this.frame) {
      if (this.frameStyleBeforeFs === null) this.frame.removeAttribute('style');
      else this.frame.setAttribute('style', this.frameStyleBeforeFs);
      // Restore the right height for the mode: recompute the fill, or re-apply
      // the last height the Designer reported (numeric mode). Both use
      // `!important` so a host theme can't win after we unpin.
      if (this.fillEnabled()) this.applyFill();
      else if (this.autoResizeEnabled() && this.lastAutoHeight) this.setFrameHeight(this.lastAutoHeight);
    }
    this.frameStyleBeforeFs = null;

    if (this.docOverflowBeforeFs !== null) {
      document.documentElement.style.overflow = this.docOverflowBeforeFs;
      this.docOverflowBeforeFs = null;
    }
    if (this.bodyOverflowBeforeFs !== null && document.body) {
      document.body.style.overflow = this.bodyOverflowBeforeFs;
      this.bodyOverflowBeforeFs = null;
    }
    if (this.fsKeyHandler) {
      window.removeEventListener('keydown', this.fsKeyHandler);
      this.fsKeyHandler = null;
    }
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private ensureContainerPositioned(container: HTMLElement): void {
    // The overlay is absolutely positioned; the container must establish a
    // positioning context. Only touch a `static` container, and remember to
    // restore it on destroy.
    const position = getComputedStyle(container).position;
    if (position === 'static') {
      this.restoreContainerPosition = container.style.position;
      container.style.position = 'relative';
    }
  }

  private restoreContainerStyle(): void {
    if (this.restoreContainerPosition === null) return;
    try {
      resolveContainer(this.options.container).style.position = this.restoreContainerPosition;
    } catch {
      /* container already gone — nothing to restore */
    }
    this.restoreContainerPosition = null;
  }

  private removeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private showError(cause: ErrorCause): void {
    this.phase = 'error';
    this.clearTimeoutTimer();
    if (!this.loadingStateEnabled()) return;
    let container: HTMLElement;
    try {
      container = resolveContainer(this.options.container);
    } catch {
      return;
    }
    this.renderOverlay(container, 'error', cause);
  }

  private handleTryAgain(): void {
    if (this.options.onRequestRelaunch) {
      // Host mints a fresh session and calls setDesignerUrl(), which re-mounts
      // the iframe and returns to the loading state.
      this.options.onRequestRelaunch();
      return;
    }
    // No relaunch hook: reload the same session URL in place.
    this.mount();
  }

  /**
   * Build (or rebuild) the overlay for the given phase. A single overlay element
   * is reused so we never stack stale skeletons or cards.
   */
  private renderOverlay(container: HTMLElement, phase: 'loading' | 'error', cause?: ErrorCause): void {
    this.removeOverlay();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-seatlayer-designer-overlay', phase);
    overlay.setAttribute('role', phase === 'error' ? 'alert' : 'status');
    overlay.setAttribute('aria-live', 'polite');
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#101625',
      color: '#e6ebf5',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      zIndex: '2',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);

    if (phase === 'loading') this.buildSkeleton(overlay);
    else this.buildErrorCard(overlay, cause ?? 'load');

    container.append(overlay);
    this.overlay = overlay;
  }

  private buildSkeleton(overlay: HTMLDivElement): void {
    // Scoped keyframes; the shimmer only runs when the user allows motion.
    const style = document.createElement('style');
    style.textContent = `
@media (prefers-reduced-motion: no-preference) {
  @keyframes seatlayer-designer-shimmer {
    0% { background-position: -320px 0; }
    100% { background-position: 320px 0; }
  }
  [data-seatlayer-designer-overlay="loading"] .sl-shimmer {
    animation: seatlayer-designer-shimmer 1.25s ease-in-out infinite;
    background-size: 640px 100%;
  }
}`;
    overlay.append(style);

    const shimmer =
      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.10) 37%, rgba(255,255,255,0.04) 63%)';

    const scaffold = document.createElement('div');
    Object.assign(scaffold.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      padding: '16px',
      gap: '14px',
      opacity: '0.9',
    } satisfies Partial<CSSStyleDeclaration>);

    const bar = (styles: Partial<CSSStyleDeclaration>): HTMLDivElement => {
      const node = document.createElement('div');
      node.className = 'sl-shimmer';
      Object.assign(node.style, {
        background: shimmer,
        borderRadius: '8px',
      } satisfies Partial<CSSStyleDeclaration>);
      Object.assign(node.style, styles);
      return node;
    };

    // Top toolbar row.
    scaffold.append(bar({ height: '40px', width: '100%', flex: '0 0 auto' }));

    // Body: side panel + canvas.
    const body = document.createElement('div');
    Object.assign(body.style, {
      display: 'flex',
      gap: '14px',
      flex: '1 1 auto',
      minHeight: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    body.append(bar({ width: '220px', height: '100%', flex: '0 0 auto' }));
    body.append(bar({ flex: '1 1 auto', height: '100%' }));
    scaffold.append(body);

    overlay.append(scaffold);

    // Centered caption above the scaffold.
    const caption = document.createElement('div');
    Object.assign(caption.style, {
      position: 'relative',
      zIndex: '1',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '10px 16px',
      borderRadius: '999px',
      background: 'rgba(16, 22, 37, 0.72)',
      fontSize: '13px',
      fontWeight: '500',
      letterSpacing: '0.01em',
    } satisfies Partial<CSSStyleDeclaration>);

    const dot = document.createElement('span');
    dot.className = 'sl-shimmer';
    Object.assign(dot.style, {
      width: '9px',
      height: '9px',
      borderRadius: '50%',
      background: shimmer,
      flex: '0 0 auto',
    } satisfies Partial<CSSStyleDeclaration>);
    caption.append(dot);
    caption.append(document.createTextNode('Loading designer…'));
    overlay.append(caption);
  }

  private buildErrorCard(overlay: HTMLDivElement, cause: ErrorCause): void {
    const copy = ERROR_COPY[cause];
    const card = document.createElement('div');
    Object.assign(card.style, {
      maxWidth: '420px',
      margin: '0 24px',
      padding: '28px',
      textAlign: 'center',
      background: 'rgba(255, 255, 255, 0.03)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: '16px',
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
    } satisfies Partial<CSSStyleDeclaration>);

    const heading = document.createElement('h2');
    heading.textContent = copy.title;
    Object.assign(heading.style, {
      margin: '0 0 8px',
      fontSize: '17px',
      fontWeight: '600',
      color: '#f4f7ff',
    } satisfies Partial<CSSStyleDeclaration>);

    const body = document.createElement('p');
    body.textContent = copy.body;
    Object.assign(body.style, {
      margin: '0 0 20px',
      fontSize: '13.5px',
      lineHeight: '1.5',
      color: '#aab4c8',
    } satisfies Partial<CSSStyleDeclaration>);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Try again';
    Object.assign(button.style, {
      appearance: 'none',
      cursor: 'pointer',
      border: '0',
      borderRadius: '10px',
      padding: '10px 22px',
      fontSize: '14px',
      fontWeight: '600',
      color: '#101625',
      background: '#7aa2ff',
    } satisfies Partial<CSSStyleDeclaration>);
    button.addEventListener('click', () => this.handleTryAgain());

    card.append(heading, body, button);
    overlay.append(card);
  }

  private handleMessage = (event: MessageEvent<unknown>) => {
    if (!this.frame || event.origin !== this.designerOrigin || event.source !== this.frame.contentWindow) return;
    if (!event.data || typeof event.data !== 'object') return;
    const data = event.data as Record<string, unknown>;

    // Layout protocol — origin-locked like everything else, but handled here
    // rather than dispatched to the host callbacks.
    if (data.type === 'seatlayer.designer.resize') {
      // Fill mode owns the height from the viewport; the reported scrollHeight is
      // circular (the fixed-position shell echoes the iframe height), so ignore
      // it. Only a fixed numeric height honours the legacy auto-grow.
      if (!this.fillEnabled() && this.autoResizeEnabled()
          && typeof data.px === 'number' && Number.isFinite(data.px) && data.px > 0) {
        this.lastAutoHeight = `${Math.round(data.px)}px`;
        // While pinned fullscreen the iframe fills the viewport; apply the
        // reported height only when not pinned (it's re-applied on unpin).
        // `!important` so a host theme's `iframe { height … }` can't win.
        if (!this.pinned) this.setFrameHeight(this.lastAutoHeight);
      }
      return;
    }
    if (data.type === 'seatlayer.designer.fullscreen') {
      if (data.on === true) this.pinFullscreen();
      else if (data.on === false) this.unpinFullscreen();
      return;
    }

    if (typeof data.type !== 'string' || !TYPES.has(data.type as EmbeddedDesignerEventType)) return;

    const message: EmbeddedDesignerMessage = {
      type: data.type as EmbeddedDesignerEventType,
      chartId: typeof data.chartId === 'string' ? data.chartId : undefined,
      workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : undefined,
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
      code: typeof data.code === 'string' ? data.code : undefined,
      message: typeof data.message === 'string' ? data.message : undefined,
      meta: data.meta,
    };
    if (
      (this.options.expectedChartId && message.chartId && message.chartId !== this.options.expectedChartId) ||
      (this.options.expectedWorkspaceId && message.workspaceId && message.workspaceId !== this.options.expectedWorkspaceId)
    ) {
      // A message from our exact iframe carrying the wrong identity is a real
      // session mismatch, not spoofing. Surface it (loading state on) rather than
      // dispatching it to the host callbacks.
      this.showError('mismatch');
      return;
    }

    switch (message.type) {
      case 'seatlayer.designer.ready':
        this.phase = 'ready';
        this.clearTimeoutTimer();
        this.removeOverlay();
        this.options.onReady?.(message);
        break;
      case 'seatlayer.designer.saved': this.options.onSaved?.(message); break;
      case 'seatlayer.designer.published': this.options.onPublished?.(message); break;
      case 'seatlayer.designer.close': this.options.onClose?.(message); break;
      case 'seatlayer.designer.error':
        this.showError(causeFromCode(message.code));
        this.options.onError?.(message);
        break;
    }
  };
}
