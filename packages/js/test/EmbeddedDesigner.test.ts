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
function postFromFrame(designer: EmbeddedDesigner, data: Record<string, unknown>) {
  const frame = designer.getIframe();
  if (!frame) throw new Error('no iframe mounted');
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'origin', { value: DESIGNER_ORIGIN, configurable: true });
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
