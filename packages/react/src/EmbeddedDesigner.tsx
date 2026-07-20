import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from 'react';
import {
  EmbeddedDesigner as CoreEmbeddedDesigner,
  type EmbeddedDesignerMessage,
} from '@seatlayer/js';

export type { EmbeddedDesignerMessage } from '@seatlayer/js';

export interface EmbeddedDesignerHandle {
  /** Recreate the iframe with a newly-minted session URL. */
  setDesignerUrl(designerUrl: string): void;
  /** The currently mounted iframe, if any. */
  getIframe(): HTMLIFrameElement | null;
}

export interface EmbeddedDesignerProps {
  /** Short-lived `designerUrl` returned by your backend. Never pass an `sk_` key. */
  designerUrl: string;
  expectedChartId?: string;
  expectedWorkspaceId?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  iframeClassName?: string;
  iframeStyle?: Partial<CSSStyleDeclaration>;
  allow?: string;
  referrerPolicy?: ReferrerPolicy;
  /**
   * Show the built-in branded loading skeleton and error/expiry card inside the
   * container while the Designer boots. Defaults to `true`. Set `false` when you
   * render your own loading and error chrome.
   */
  showLoadingState?: boolean;
  /**
   * If the Designer never posts `ready` within this many milliseconds, the host
   * shows the error card with a timeout message. Defaults to `20000`.
   */
  loadingTimeoutMs?: number;
  /**
   * How the iframe is sized. `'fill'` (the default) keeps the Designer filling
   * the viewport — its height tracks `window.innerHeight` minus the iframe's
   * top offset, recomputed on resize/scroll. Pass a number for a fixed pixel
   * height you manage yourself.
   */
  height?: 'fill' | number;
  /** Lower bound for `'fill'` sizing. Defaults to `480`. */
  minHeight?: number;
  /**
   * Legacy content-height auto-grow via the `seatlayer.designer.resize`
   * protocol. Only honored when `height` is a number; with the default
   * `height: 'fill'` the resize messages are ignored and the iframe always
   * fills the viewport.
   */
  autoResize?: boolean;
  /**
   * Called when the user presses "Try again" on the error card. Mint a fresh
   * session and set the new `designerUrl` (recreating the iframe returns it to
   * the loading state). When omitted, "Try again" reloads the current URL.
   */
  onRequestRelaunch?: () => void;
  onReady?: (message: EmbeddedDesignerMessage) => void;
  onSaved?: (message: EmbeddedDesignerMessage) => void;
  onPublished?: (message: EmbeddedDesignerMessage) => void;
  onClose?: (message: EmbeddedDesignerMessage) => void;
  onError?: (message: EmbeddedDesignerMessage) => void;
}

/**
 * Native-feeling React host for the secure SeatLayer Designer iframe.
 * A new `designerUrl` always recreates the iframe, so a new fragment token can
 * never retain state from an earlier chart session.
 */
export const EmbeddedDesigner = forwardRef<EmbeddedDesignerHandle, EmbeddedDesignerProps>(
  function EmbeddedDesigner(props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const designerRef = useRef<CoreEmbeddedDesigner | null>(null);
    const callbacks = useRef(props);
    callbacks.current = props;

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const designer = new CoreEmbeddedDesigner({
        designerUrl: props.designerUrl,
        container,
        expectedChartId: props.expectedChartId,
        expectedWorkspaceId: props.expectedWorkspaceId,
        title: props.title,
        className: props.iframeClassName,
        style: props.iframeStyle,
        allow: props.allow,
        referrerPolicy: props.referrerPolicy,
        showLoadingState: props.showLoadingState,
        loadingTimeoutMs: props.loadingTimeoutMs,
        height: props.height,
        minHeight: props.minHeight,
        autoResize: props.autoResize,
        // Only forward a relaunch hook when the host supplied one, so the core's
        // "reload the same URL in place" fallback still applies otherwise.
        onRequestRelaunch: props.onRequestRelaunch
          ? () => callbacks.current.onRequestRelaunch?.()
          : undefined,
        onReady: (message) => callbacks.current.onReady?.(message),
        onSaved: (message) => callbacks.current.onSaved?.(message),
        onPublished: (message) => callbacks.current.onPublished?.(message),
        onClose: (message) => callbacks.current.onClose?.(message),
        onError: (message) => callbacks.current.onError?.(message),
      });
      designer.mount();
      designerRef.current = designer;
      return () => {
        designer.destroy();
        designerRef.current = null;
      };
      // Session/chart identity changes must recreate the iframe. Callback changes are
      // picked up from the ref without reloading an in-progress Designer session.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.designerUrl, props.expectedChartId, props.expectedWorkspaceId, props.title, props.iframeClassName, props.iframeStyle, props.allow, props.referrerPolicy, props.showLoadingState, props.loadingTimeoutMs, props.autoResize]);

    useImperativeHandle(ref, () => ({
      setDesignerUrl: (designerUrl) => { designerRef.current?.setDesignerUrl(designerUrl); },
      getIframe: () => designerRef.current?.getIframe() ?? null,
    }), []);

    return <div ref={containerRef} className={props.className} style={props.style} />;
  },
);
