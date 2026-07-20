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
