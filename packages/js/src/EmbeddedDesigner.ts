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

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container !== 'string') return container;
  const element = document.querySelector<HTMLElement>(container);
  if (!element) throw new Error(`EmbeddedDesigner container not found: ${container}`);
  return element;
}

/** Mount, replace, and destroy a scoped Designer iframe safely. */
export class EmbeddedDesigner {
  private options: EmbeddedDesignerOptions;
  private frame: HTMLIFrameElement | null = null;
  private designerOrigin = '';

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

    window.addEventListener('message', this.handleMessage);
    resolveContainer(this.options.container).append(frame);
    this.frame = frame;
    return frame;
  }

  /** Replace the iframe instead of assigning a new fragment to an existing one. */
  setDesignerUrl(designerUrl: string): HTMLIFrameElement {
    this.options = { ...this.options, designerUrl };
    return this.mount();
  }

  getIframe(): HTMLIFrameElement | null {
    return this.frame;
  }

  destroy(): void {
    window.removeEventListener('message', this.handleMessage);
    this.frame?.remove();
    this.frame = null;
    this.designerOrigin = '';
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
    if (this.options.expectedChartId && message.chartId && message.chartId !== this.options.expectedChartId) return;
    if (this.options.expectedWorkspaceId && message.workspaceId && message.workspaceId !== this.options.expectedWorkspaceId) return;

    switch (message.type) {
      case 'seatlayer.designer.ready': this.options.onReady?.(message); break;
      case 'seatlayer.designer.saved': this.options.onSaved?.(message); break;
      case 'seatlayer.designer.published': this.options.onPublished?.(message); break;
      case 'seatlayer.designer.close': this.options.onClose?.(message); break;
      case 'seatlayer.designer.error': this.options.onError?.(message); break;
    }
  };
}
