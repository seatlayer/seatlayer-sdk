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
   * How the iframe is sized. `'fill'` (the default) is **container-aware**: if the
   * container has a definite height (a sized block, `flex-1 min-h-0`, a resolved
   * `%`) the Designer fills 100% of it and tracks its size via a `ResizeObserver`;
   * if the container is content-sized (full-page usage) the Designer fills the
   * viewport (`window.innerHeight` minus the iframe's top offset). Either way the
   * result is clamped to `minHeight` and re-probed on resize. Heights are applied
   * with `!important` so a host theme can't override them. Pass a number for a
   * fixed pixel height you manage yourself.
   */
  height?: 'fill' | number;
  /** Lower bound for `'fill'` sizing. Defaults to `480`. */
  minHeight?: number;
  /**
   * Legacy content-height auto-grow via the `seatlayer.designer.resize`
   * protocol. Only honored when `height` is a number; with the default
   * `height: 'fill'` the resize messages are ignored and the SDK sizes the iframe
   * to the container or viewport.
   */
  autoResize?: boolean;
  /**
   * Called when the user presses "Try again" on the error card. Mint a fresh
   * session and set the new `designerUrl` (recreating the iframe returns it to
   * the loading state). When omitted, "Try again" reloads the current URL.
   *
   * When supplied, it also powers automatic session renewal — see
   * {@link EmbeddedDesignerProps.autoRenewSession}.
   */
  onRequestRelaunch?: () => void;
  /**
   * Keep long editing sessions alive with no expiry wall. When you supply
   * `onRequestRelaunch`, the SDK schedules a silent relaunch shortly before the
   * session's `expiresAt` (mint a fresh session and update `designerUrl` in your
   * `onRequestRelaunch` handler), and makes one automatic recovery attempt if an
   * expiry error still slips through before showing the "Try again" card. Defaults
   * to `true` whenever `onRequestRelaunch` is provided; a no-op without it. Set
   * `false` to keep the fully manual "Try again" behavior.
   */
  autoRenewSession?: boolean;
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
        autoRenewSession: props.autoRenewSession,
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
    }, [props.designerUrl, props.expectedChartId, props.expectedWorkspaceId, props.title, props.iframeClassName, props.iframeStyle, props.allow, props.referrerPolicy, props.showLoadingState, props.loadingTimeoutMs, props.autoResize, props.autoRenewSession]);

    useImperativeHandle(ref, () => ({
      setDesignerUrl: (designerUrl) => { designerRef.current?.setDesignerUrl(designerUrl); },
      getIframe: () => designerRef.current?.getIframe() ?? null,
    }), []);

    return <div ref={containerRef} className={props.className} style={props.style} />;
  },
);
