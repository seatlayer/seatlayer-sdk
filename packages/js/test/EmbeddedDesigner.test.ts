import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddedDesigner, type EmbeddedDesignerMessage } from '../src/EmbeddedDesigner';

const DESIGNER_URL = 'https://designer.seatlayer.test/embed#token=dse_abc';
const DESIGNER_ORIGIN = 'https://designer.seatlayer.test';

let container: HTMLDivElement;

function mountDesigner(overrides: Partial<ConstructorParameters<typeof EmbeddedDesigner>[0]> = {}) {
  const designer = new EmbeddedDesigner({
    designerUrl: DESIGNER_URL,
    container,
    ...overrides,
  });
  designer.mount();
  return designer;
}

/** Dispatch a message that passes the core's origin + source identity checks. */
function postFromFrame(designer: EmbeddedDesigner, data: Record<string, unknown>, origin = DESIGNER_ORIGIN) {
  const frame = designer.getIframe();
  if (!frame) throw new Error('no iframe mounted');
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'origin', { value: origin, configurable: true });
  Object.defineProperty(event, 'source', { value: frame.contentWindow, configurable: true });
  window.dispatchEvent(event);
}

const overlay = () => container.querySelector<HTMLElement>('[data-seatlayer-designer-overlay]');
const overlayPhase = () => overlay()?.getAttribute('data-seatlayer-designer-overlay') ?? null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
});

describe('EmbeddedDesigner loading state machine', () => {
  it('renders a loading skeleton on mount', () => {
    mountDesigner();
    expect(overlayPhase()).toBe('loading');
    expect(overlay()?.textContent).toContain('Loading designer');
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('removes the skeleton and fires onReady when ready arrives', () => {
    const onReady = vi.fn<(m: EmbeddedDesignerMessage) => void>();
    const designer = mountDesigner({ onReady });
    postFromFrame(designer, { type: 'seatlayer.designer.ready', chartId: 'ch_1' });
    expect(overlay()).toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0]![0].chartId).toBe('ch_1');
  });

  it('shows the error card and fires onError on an error message', () => {
    const onError = vi.fn();
    const designer = mountDesigner({ onError });
    postFromFrame(designer, {
      type: 'seatlayer.designer.error',
      code: 'designer_session_expired',
      message: 'expired',
    });
    expect(overlayPhase()).toBe('error');
    expect(overlay()?.textContent).toContain('expired');
    expect(overlay()?.querySelector('button')?.textContent).toBe('Try again');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('transitions to the error card on loading timeout', () => {
    vi.useFakeTimers();
    mountDesigner({ loadingTimeoutMs: 5000 });
    expect(overlayPhase()).toBe('loading');
    vi.advanceTimersByTime(5000);
    expect(overlayPhase()).toBe('error');
    expect(overlay()?.textContent).toContain('taking too long');
  });

  it('does not time out after ready arrives', () => {
    vi.useFakeTimers();
    const designer = mountDesigner({ loadingTimeoutMs: 5000 });
    postFromFrame(designer, { type: 'seatlayer.designer.ready' });
    vi.advanceTimersByTime(5000);
    expect(overlay()).toBeNull();
  });

  it('treats an identity mismatch as an error and blocks the callback', () => {
    const onReady = vi.fn();
    const designer = mountDesigner({ expectedChartId: 'ch_expected', onReady });
    postFromFrame(designer, { type: 'seatlayer.designer.ready', chartId: 'ch_other' });
    expect(overlayPhase()).toBe('error');
    expect(overlay()?.textContent).toContain("doesn't match");
    expect(onReady).not.toHaveBeenCalled();
  });

  it('setDesignerUrl resets a ready/error host back to loading', () => {
    const designer = mountDesigner();
    postFromFrame(designer, { type: 'seatlayer.designer.error', code: 'load_failed' });
    expect(overlayPhase()).toBe('error');
    designer.setDesignerUrl('https://designer.seatlayer.test/embed#token=dse_next');
    expect(overlayPhase()).toBe('loading');
  });

  it('opt-out: showLoadingState=false renders no overlay', () => {
    const designer = mountDesigner({ showLoadingState: false });
    expect(overlay()).toBeNull();
    postFromFrame(designer, { type: 'seatlayer.designer.error', code: 'load_failed' });
    expect(overlay()).toBeNull();
  });

  it('Try again calls onRequestRelaunch when provided', () => {
    const onRequestRelaunch = vi.fn();
    const designer = mountDesigner({ onRequestRelaunch });
    postFromFrame(designer, { type: 'seatlayer.designer.error', code: 'load_failed' });
    overlay()?.querySelector('button')?.click();
    expect(onRequestRelaunch).toHaveBeenCalledTimes(1);
  });

  it('Try again reloads the same URL when no relaunch hook is provided', () => {
    const designer = mountDesigner();
    const firstFrame = designer.getIframe();
    postFromFrame(designer, { type: 'seatlayer.designer.error', code: 'load_failed' });
    overlay()?.querySelector('button')?.click();
    expect(overlayPhase()).toBe('loading');
    expect(designer.getIframe()).not.toBe(firstFrame);
  });

  it('destroy removes the iframe and overlay', () => {
    const designer = mountDesigner();
    designer.destroy();
    expect(container.querySelector('iframe')).toBeNull();
    expect(overlay()).toBeNull();
  });
});

describe('EmbeddedDesigner resize + fullscreen protocol', () => {
  it('ignores the legacy resize message in fill mode (default)', () => {
    const designer = mountDesigner();
    const before = designer.getIframe()!.style.height;
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 640 });
    // Fill mode owns the height from the viewport; the circular scrollHeight
    // report never touches it.
    expect(designer.getIframe()!.style.height).toBe(before);
  });

  it('fills the iframe to the viewport in fill mode', () => {
    const designer = mountDesigner();
    // jsdom rects report top:0, so fill == innerHeight (clamped to minHeight).
    const expected = `${Math.max(480, window.innerHeight)}px`;
    expect(designer.getIframe()!.style.height).toBe(expected);
  });

  it('clamps fill height to minHeight', () => {
    const designer = mountDesigner({ minHeight: 100000 });
    expect(designer.getIframe()!.style.height).toBe('100000px');
  });

  it('uses a fixed numeric height verbatim', () => {
    const designer = mountDesigner({ height: 720 });
    expect(designer.getIframe()!.style.height).toBe('720px');
  });

  it('grows a numeric-height iframe to the reported height', () => {
    const designer = mountDesigner({ height: 300 });
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 640 });
    expect(designer.getIframe()!.style.height).toBe('640px');
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 812.6 });
    expect(designer.getIframe()!.style.height).toBe('813px');
  });

  it('ignores resize when autoResize is disabled (numeric mode)', () => {
    const designer = mountDesigner({ height: 300, autoResize: false });
    const before = designer.getIframe()!.style.height;
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 640 });
    expect(designer.getIframe()!.style.height).toBe(before);
  });

  it('ignores non-positive / non-finite heights (numeric mode)', () => {
    const designer = mountDesigner({ height: 300 });
    const before = designer.getIframe()!.style.height;
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 0 });
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: -50 });
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: Number.NaN });
    expect(designer.getIframe()!.style.height).toBe(before);
  });

  it('pins the iframe fullscreen and restores on off', () => {
    const designer = mountDesigner();
    const frame = designer.getIframe()!;
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: true });
    expect(frame.style.position).toBe('fixed');
    expect(frame.style.width).toBe('100vw');
    expect(frame.style.height).toBe('100vh');
    expect(document.documentElement.style.overflow).toBe('hidden');

    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: false });
    expect(frame.style.position).toBe('');
    expect(frame.style.width).toBe('100%');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('re-applies the numeric auto-height reported while pinned, on unpin', () => {
    const designer = mountDesigner({ height: 300 });
    const frame = designer.getIframe()!;
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 500 });
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: true });
    // pinned iframe fills the viewport, not the reported height
    expect(frame.style.height).toBe('100vh');
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 700 });
    expect(frame.style.height).toBe('100vh');
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: false });
    expect(frame.style.height).toBe('700px');
  });

  it('recomputes the viewport fill on unpin (fill mode)', () => {
    const designer = mountDesigner();
    const frame = designer.getIframe()!;
    const filled = frame.style.height;
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: true });
    expect(frame.style.height).toBe('100vh');
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: false });
    expect(frame.style.height).toBe(filled);
  });

  it('exits host-pinned fullscreen on Escape', () => {
    const designer = mountDesigner();
    const frame = designer.getIframe()!;
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: true });
    expect(frame.style.position).toBe('fixed');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(frame.style.position).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('restores the scroll lock on destroy while pinned', () => {
    const designer = mountDesigner();
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: true });
    expect(document.documentElement.style.overflow).toBe('hidden');
    designer.destroy();
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('ignores resize + fullscreen from the wrong origin', () => {
    const designer = mountDesigner();
    const frame = designer.getIframe()!;
    const before = frame.style.height;
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 640 }, 'https://evil.example');
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: true }, 'https://evil.example');
    expect(frame.style.height).toBe(before);
    expect(frame.style.position).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });
});

describe('EmbeddedDesigner writes !important-proof heights', () => {
  const priority = (frame: HTMLIFrameElement, prop: string) => frame.style.getPropertyPriority(prop);

  it('applies the viewport-fill height with !important', () => {
    const frame = mountDesigner().getIframe()!;
    expect(priority(frame, 'height')).toBe('important');
    expect(priority(frame, 'width')).toBe('important');
  });

  it('applies a fixed numeric height with !important', () => {
    const frame = mountDesigner({ height: 720 }).getIframe()!;
    expect(frame.style.height).toBe('720px');
    expect(priority(frame, 'height')).toBe('important');
  });

  it('applies the autoResize (resize protocol) height with !important', () => {
    const designer = mountDesigner({ height: 300 });
    postFromFrame(designer, { type: 'seatlayer.designer.resize', px: 640 });
    const frame = designer.getIframe()!;
    expect(frame.style.height).toBe('640px');
    expect(priority(frame, 'height')).toBe('important');
  });

  it('pins fullscreen with !important on height/width/position/inset', () => {
    const designer = mountDesigner();
    const frame = designer.getIframe()!;
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: true });
    for (const prop of ['position', 'top', 'right', 'bottom', 'left', 'width', 'height']) {
      expect(priority(frame, prop)).toBe('important');
    }
    // Unpin restores the pre-pin inline style, which itself kept !important height.
    postFromFrame(designer, { type: 'seatlayer.designer.fullscreen', on: false });
    expect(frame.style.position).toBe('');
    expect(priority(frame, 'height')).toBe('important');
  });
});

describe('EmbeddedDesigner container-aware fill', () => {
  const realRaf = global.requestAnimationFrame;
  const realCaf = global.cancelAnimationFrame;
  let rafQueue: Array<((t: number) => void) | undefined>;

  function flushRaf() {
    const queued = rafQueue;
    rafQueue = [];
    for (const cb of queued) cb?.(0);
  }

  /** Minimal DOMRect stub — the SDK only reads `.height` (container) / `.top` (iframe). */
  function rect(height: number): DOMRect {
    return { height, top: 0, bottom: height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  }

  /** A block the host sized to a definite height — stays put whatever the iframe does. */
  function makeBounded(el: HTMLElement, getHeight: () => number) {
    el.getBoundingClientRect = () => rect(getHeight());
  }

  /** A content-sized block — its height collapses to whatever the iframe measures. */
  function makeContentSized(el: HTMLElement) {
    el.getBoundingClientRect = () => {
      const frame = el.querySelector('iframe');
      return rect(frame ? Number.parseFloat(frame.style.height) || 0 : 0);
    };
  }

  class MockResizeObserver {
    static instances: MockResizeObserver[] = [];
    elements: Element[] = [];
    constructor(public cb: ResizeObserverCallback) { MockResizeObserver.instances.push(this); }
    observe(el: Element) { this.elements.push(el); }
    unobserve(el: Element) { this.elements = this.elements.filter((e) => e !== el); }
    disconnect() { this.elements = []; }
    trigger() { this.cb([], this as unknown as ResizeObserver); }
  }

  beforeEach(() => {
    rafQueue = [];
    global.requestAnimationFrame = ((cb: (t: number) => void) => rafQueue.push(cb)) as typeof requestAnimationFrame;
    global.cancelAnimationFrame = ((id: number) => { rafQueue[id - 1] = undefined; }) as typeof cancelAnimationFrame;
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    MockResizeObserver.instances = [];
  });

  afterEach(() => {
    global.requestAnimationFrame = realRaf;
    global.cancelAnimationFrame = realCaf;
    delete (global as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it('fills 100% of a host-sized (bounded) container', () => {
    makeBounded(container, () => 640);
    const frame = mountDesigner().getIframe()!;
    expect(frame.style.height).toBe('640px');
    expect(frame.style.getPropertyPriority('height')).toBe('important');
  });

  it('falls back to viewport-fill when the container collapses (content-sized)', () => {
    makeContentSized(container);
    const frame = mountDesigner().getIframe()!;
    // top:0 in jsdom ⇒ viewport-fill == max(minHeight, innerHeight).
    expect(frame.style.height).toBe(`${Math.max(480, window.innerHeight)}px`);
  });

  it('treats a bare min-height floor as content-sized (keeps viewport-fill)', () => {
    // min-height floors the collapsed measure but the box still grows with the
    // iframe, so the probe must not mistake it for a bounded block.
    makeBounded(container, () => 0); // baseline
    container.getBoundingClientRect = () => {
      const frame = container.querySelector('iframe');
      const h = frame ? Number.parseFloat(frame.style.height) || 0 : 0;
      return rect(Math.max(760, h)); // min-height:760, still tracks the iframe upward
    };
    const frame = mountDesigner().getIframe()!;
    expect(frame.style.height).toBe(`${Math.max(480, window.innerHeight)}px`);
  });

  it('clamps container-fill to minHeight', () => {
    makeBounded(container, () => 200);
    const frame = mountDesigner({ minHeight: 500 }).getIframe()!;
    expect(frame.style.height).toBe('500px');
  });

  it('tracks live block-size changes via a ResizeObserver', () => {
    let blockHeight = 600;
    makeBounded(container, () => blockHeight);
    const frame = mountDesigner().getIframe()!;
    expect(frame.style.height).toBe('600px');

    // A ResizeObserver was created for the bounded-container verdict.
    expect(MockResizeObserver.instances.length).toBeGreaterThan(0);

    // Firing the observer callback re-fills the iframe to the new block height.
    blockHeight = 820;
    for (const observer of MockResizeObserver.instances) observer.trigger();
    flushRaf();
    expect(frame.style.height).toBe('820px');
  });

  it('disconnects the ResizeObserver on destroy', () => {
    makeBounded(container, () => 600);
    const designer = mountDesigner();
    expect(MockResizeObserver.instances.length).toBeGreaterThan(0);
    designer.destroy();
    // Every observer is disconnected, and a late callback resizes nothing.
    for (const observer of MockResizeObserver.instances) {
      expect(observer.elements).toEqual([]);
      observer.trigger();
    }
    flushRaf();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('re-probes on resize and flips content-sized → bounded', () => {
    makeContentSized(container);
    const designer = mountDesigner();
    const frame = designer.getIframe()!;
    expect(frame.style.height).toBe(`${Math.max(480, window.innerHeight)}px`);
    expect(MockResizeObserver.instances.length).toBe(0);

    // Host layout change: the block now has a definite height.
    makeBounded(container, () => 700);
    window.dispatchEvent(new Event('resize'));
    flushRaf();
    expect(frame.style.height).toBe('700px');
    // An observer is now attached; firing it keeps the iframe filled to the block.
    expect(MockResizeObserver.instances.length).toBeGreaterThan(0);
    for (const observer of MockResizeObserver.instances) observer.trigger();
    flushRaf();
    expect(frame.style.height).toBe('700px');
  });
});
