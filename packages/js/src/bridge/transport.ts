/**
 * SeatLayer mobile bridge — transport shim.
 *
 * One web→host send path, feature-detected across the four native WebView
 * conventions plus a framed-page fallback. The web side never knows (or cares)
 * which wrapper it is inside; it just calls `transport.send(envelope)`.
 *
 * Detection order is deliberate — a host may expose more than one channel (a
 * Flutter app embeds a platform WebView that also has `webkit.messageHandlers`
 * on iOS), so the most specific/purpose-built channel wins:
 *
 *   1. `window.webkit.messageHandlers.seatlayer` — iOS WKWebView.
 *      Takes the ENVELOPE OBJECT, not a string: WKScriptMessage bridges JS
 *      values to NSDictionary natively, so pre-stringifying would force the
 *      Swift side to parse a string out of a dictionary for no reason.
 *   2. `window.SeatLayerNative.post` — Android `@JavascriptInterface`.
 *      Android's injected-object bridge only marshals primitives: STRING.
 *   3. `window.SeatLayer.postMessage` — Flutter `JavascriptChannel`. STRING.
 *   4. `window.ReactNativeWebView.postMessage` — RN WebView. STRING.
 *   5. `window.parent.postMessage` — plain iframe embed, only when framed.
 *      Structured clone, so the object goes across as-is.
 *
 * Host→web is the mirror image: the bridge installs `window.__slBridge`, and
 * the native side calls `window.__slBridge.recv(...)` (via
 * `evaluateJavascript` / `stringByEvaluatingJavaScript` / `runJavaScript`)
 * with either a JSON string or an object literal.
 */
import { encode, type Envelope } from './protocol';

export type TransportName = 'ios' | 'android' | 'flutter' | 'rn' | 'frame' | 'none';

export interface BridgeTransport {
  /** Which shim was detected. Reported to the host in `sys.ready`. */
  readonly name: TransportName;
  /** Push one envelope to the host. Never throws. */
  send(envelope: Envelope): void;
}

/** The receiver the bridge installs at `window.__slBridge`. */
export interface BridgeReceiver {
  recv(input: unknown): void;
}

/** Minimal structural types for the shims we probe. Hosts are untyped globals. */
interface ShimWindow {
  webkit?: { messageHandlers?: Record<string, { postMessage?: (value: unknown) => void } | undefined> };
  SeatLayerNative?: { post?: (json: string) => void };
  SeatLayer?: { postMessage?: (json: string) => void };
  ReactNativeWebView?: { postMessage?: (json: string) => void };
  __slBridge?: BridgeReceiver;
  parent?: Window;
  postMessage?: (message: unknown, targetOrigin: string) => void;
}

function fn(value: unknown): ((...args: never[]) => unknown) | null {
  return typeof value === 'function' ? (value as (...args: never[]) => unknown) : null;
}

/**
 * Pick the send channel for the current environment.
 *
 * Returns a `'none'` transport (a no-op sink) when nothing is detected, so the
 * bridge stays constructible on a plain top-level page — a host that never
 * arrives is handled by the handshake timeout, not by a crash here.
 */
export function detectTransport(win: Window & ShimWindow = window as Window & ShimWindow): BridgeTransport {
  const ios = fn(win.webkit?.messageHandlers?.seatlayer?.postMessage);
  if (ios) {
    const handler = win.webkit!.messageHandlers!.seatlayer!;
    // Object, not string — see the header note on WKScriptMessage.
    return { name: 'ios', send: (e) => safely(() => handler.postMessage!(e)) };
  }

  const android = fn(win.SeatLayerNative?.post);
  if (android) {
    const target = win.SeatLayerNative!;
    return { name: 'android', send: (e) => safely(() => target.post!(encode(e))) };
  }

  const flutter = fn(win.SeatLayer?.postMessage);
  if (flutter) {
    const target = win.SeatLayer!;
    return { name: 'flutter', send: (e) => safely(() => target.postMessage!(encode(e))) };
  }

  const rn = fn(win.ReactNativeWebView?.postMessage);
  if (rn) {
    const target = win.ReactNativeWebView!;
    return { name: 'rn', send: (e) => safely(() => target.postMessage!(encode(e))) };
  }

  const parent = win.parent;
  if (parent && parent !== (win as unknown as Window) && typeof parent.postMessage === 'function') {
    return { name: 'frame', send: (e) => safely(() => parent.postMessage(e, '*')) };
  }

  return { name: 'none', send: () => {} };
}

/** A transport must never take the page down because the host shim threw. */
function safely(run: () => void): void {
  try {
    run();
  } catch {
    /* the host channel is the host's problem; the page keeps running */
  }
}

/**
 * Install the host→web entry point at `window.__slBridge`.
 *
 * `recv` accepts a JSON string or a plain object (both are valid depending on
 * how the native side evaluates JS) and is exception-proof: a malformed frame
 * must never surface as a JS error inside the host's `evaluateJavascript`
 * callback. Returns an uninstall function.
 */
export function installReceiver(
  handle: (input: unknown) => void,
  win: Window & ShimWindow = window as Window & ShimWindow,
): () => void {
  const previous = win.__slBridge;
  const receiver: BridgeReceiver = {
    recv(input: unknown) {
      try {
        handle(input);
      } catch {
        /* swallow — see doc comment */
      }
    },
  };
  win.__slBridge = receiver;
  return () => {
    if (win.__slBridge === receiver) {
      if (previous) win.__slBridge = previous;
      else delete win.__slBridge;
    }
  };
}

/**
 * Listen for host→web frames posted with `window.postMessage` (the iframe
 * fallback, and some Android hosts that prefer postMessage over an injected
 * object). Returns a detach function. No-ops when the window has no listener
 * support.
 */
export function listenPostMessage(
  handle: (input: unknown) => void,
  win: Window = window,
): () => void {
  if (typeof win.addEventListener !== 'function') return () => {};
  const onMessage = (event: MessageEvent<unknown>): void => {
    try {
      handle(event.data);
    } catch {
      /* malformed frames are ignored */
    }
  };
  win.addEventListener('message', onMessage as EventListener);
  return () => win.removeEventListener('message', onMessage as EventListener);
}
