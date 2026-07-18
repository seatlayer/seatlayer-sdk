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
    frame.allow = this.options.allow ?? 'clipboard-write';
    frame.referrerPolicy = this.options.referrerPolicy ?? 'origin';
    frame.src = url.toString();
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.border = '0';
    Object.assign(frame.style, this.options.style);
    if (this.options.className) frame.className = this.options.className;

    const container = resolveContainer(this.options.container);
    window.addEventListener('message', this.handleMessage);
    container.append(frame);
    this.frame = frame;

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
    this.clearTimeoutTimer();
    this.removeOverlay();
    this.restoreContainerStyle();
    this.frame?.remove();
    this.frame = null;
    this.designerOrigin = '';
    this.phase = 'loading';
  }

  private loadingStateEnabled(): boolean {
    return this.options.showLoadingState !== false;
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
