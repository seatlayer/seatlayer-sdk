import { describe, expect, it, vi } from 'vitest';
import { evtEnvelope } from '../src/bridge/protocol';
import { detectTransport, installReceiver, listenPostMessage } from '../src/bridge/transport';

const ENVELOPE = evtEnvelope('hint', 1, { message: 'hi' });
const AS_JSON = JSON.stringify(ENVELOPE);

/** A bare object standing in for `window`; only the probed shims are present. */
function fakeWindow(shims: Record<string, unknown> = {}): Window {
  const win: Record<string, unknown> = { ...shims };
  // Top-level page by default: `parent === self`, so the iframe fallback is off.
  if (!('parent' in win)) win.parent = win;
  return win as unknown as Window;
}

describe('bridge transport — platform selection', () => {
  it('prefers the iOS WKWebView handler and sends the OBJECT, not a string', () => {
    const postMessage = vi.fn();
    const win = fakeWindow({ webkit: { messageHandlers: { seatlayer: { postMessage } } } });
    const transport = detectTransport(win);
    transport.send(ENVELOPE);

    expect(transport.name).toBe('ios');
    expect(postMessage).toHaveBeenCalledWith(ENVELOPE);
    expect(typeof postMessage.mock.calls[0][0]).toBe('object');
  });

  it('uses the Android @JavascriptInterface shim with a JSON string', () => {
    const post = vi.fn();
    const win = fakeWindow({ SeatLayerNative: { post } });
    const transport = detectTransport(win);
    transport.send(ENVELOPE);

    expect(transport.name).toBe('android');
    expect(post).toHaveBeenCalledWith(AS_JSON);
  });

  it('uses the Flutter JavascriptChannel with a JSON string', () => {
    const postMessage = vi.fn();
    const win = fakeWindow({ SeatLayer: { postMessage } });
    const transport = detectTransport(win);
    transport.send(ENVELOPE);

    expect(transport.name).toBe('flutter');
    expect(postMessage).toHaveBeenCalledWith(AS_JSON);
  });

  it('uses the React Native WebView shim with a JSON string', () => {
    const postMessage = vi.fn();
    const win = fakeWindow({ ReactNativeWebView: { postMessage } });
    const transport = detectTransport(win);
    transport.send(ENVELOPE);

    expect(transport.name).toBe('rn');
    expect(postMessage).toHaveBeenCalledWith(AS_JSON);
  });

  it('falls back to the parent window only when actually framed', () => {
    const postMessage = vi.fn();
    const win = fakeWindow({ parent: { postMessage } });
    const transport = detectTransport(win);
    transport.send(ENVELOPE);

    expect(transport.name).toBe('frame');
    expect(postMessage).toHaveBeenCalledWith(ENVELOPE, '*');
  });

  it('is a no-op sink on a plain top-level page', () => {
    const transport = detectTransport(fakeWindow());
    expect(transport.name).toBe('none');
    expect(() => transport.send(ENVELOPE)).not.toThrow();
  });

  it('resolves ties in the documented order (ios > android > flutter > rn > frame)', () => {
    const all = {
      webkit: { messageHandlers: { seatlayer: { postMessage: vi.fn() } } },
      SeatLayerNative: { post: vi.fn() },
      SeatLayer: { postMessage: vi.fn() },
      ReactNativeWebView: { postMessage: vi.fn() },
      parent: { postMessage: vi.fn() },
    };
    expect(detectTransport(fakeWindow(all)).name).toBe('ios');

    const { webkit: _webkit, ...noIos } = all;
    expect(detectTransport(fakeWindow(noIos)).name).toBe('android');

    const { SeatLayerNative: _android, ...noAndroid } = noIos;
    expect(detectTransport(fakeWindow(noAndroid)).name).toBe('flutter');

    const { SeatLayer: _flutter, ...noFlutter } = noAndroid;
    expect(detectTransport(fakeWindow(noFlutter)).name).toBe('rn');

    const { ReactNativeWebView: _rn, ...noRn } = noFlutter;
    expect(detectTransport(fakeWindow(noRn)).name).toBe('frame');
  });

  it('ignores a half-present shim (namespace without the method)', () => {
    const win = fakeWindow({ webkit: { messageHandlers: {} }, SeatLayerNative: {} });
    expect(detectTransport(win).name).toBe('none');
  });

  it('never lets a throwing host shim escape into the page', () => {
    const win = fakeWindow({
      SeatLayerNative: {
        post: () => {
          throw new Error('native bridge detached');
        },
      },
    });
    expect(() => detectTransport(win).send(ENVELOPE)).not.toThrow();
  });
});

describe('bridge transport — host→web receiver', () => {
  it('installs window.__slBridge.recv and hands frames to the bridge', () => {
    const win = fakeWindow() as Window & { __slBridge?: { recv(input: unknown): void } };
    const handle = vi.fn();
    const uninstall = installReceiver(handle, win);

    win.__slBridge!.recv(AS_JSON);
    win.__slBridge!.recv({ sl: 1, k: 'cmd', id: 'a', t: 'zoomIn' });
    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenNthCalledWith(1, AS_JSON);

    uninstall();
    expect(win.__slBridge).toBeUndefined();
  });

  it('swallows handler exceptions so evaluateJavascript never sees a throw', () => {
    const win = fakeWindow() as Window & { __slBridge?: { recv(input: unknown): void } };
    installReceiver(() => {
      throw new Error('bad frame');
    }, win);
    expect(() => win.__slBridge!.recv('{}')).not.toThrow();
  });

  it('restores a previously installed receiver on uninstall', () => {
    const previous = { recv: vi.fn() };
    const win = fakeWindow({ __slBridge: previous }) as Window & { __slBridge?: unknown };
    const uninstall = installReceiver(vi.fn(), win);
    expect(win.__slBridge).not.toBe(previous);
    uninstall();
    expect(win.__slBridge).toBe(previous);
  });

  it('routes window.postMessage frames and detaches cleanly', () => {
    const handle = vi.fn();
    const detach = listenPostMessage(handle, window);
    window.dispatchEvent(new MessageEvent('message', { data: AS_JSON }));
    expect(handle).toHaveBeenCalledWith(AS_JSON);

    detach();
    window.dispatchEvent(new MessageEvent('message', { data: AS_JSON }));
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
