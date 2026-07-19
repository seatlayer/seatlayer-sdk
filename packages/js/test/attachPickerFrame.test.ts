import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachPickerFrame } from '../src/attachPickerFrame';

const PICKER_SRC = 'https://tickets.seatlayer.test/e/evt_1';
const PICKER_ORIGIN = 'https://tickets.seatlayer.test';

let iframe: HTMLIFrameElement;
let detach: (() => void) | null = null;

beforeEach(() => {
  iframe = document.createElement('iframe');
  iframe.src = PICKER_SRC;
  iframe.style.height = '480px';
  document.body.append(iframe);
});

afterEach(() => {
  detach?.();
  detach = null;
  iframe.remove();
  document.documentElement.style.overflow = '';
  if (document.body) document.body.style.overflow = '';
});

/** Post a picker→host message with a chosen origin + source identity. */
function postFromPicker(data: Record<string, unknown>, origin = PICKER_ORIGIN) {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'origin', { value: origin, configurable: true });
  Object.defineProperty(event, 'source', { value: iframe.contentWindow, configurable: true });
  window.dispatchEvent(event);
}

describe('attachPickerFrame', () => {
  it('grows the iframe to the reported height', () => {
    detach = attachPickerFrame(iframe);
    postFromPicker({ type: 'seatlayer:height', px: 720 });
    expect(iframe.style.height).toBe('720px');
    postFromPicker({ type: 'seatlayer:height', px: 512.4 });
    expect(iframe.style.height).toBe('512px');
  });

  it('ignores non-positive / non-finite heights', () => {
    detach = attachPickerFrame(iframe);
    postFromPicker({ type: 'seatlayer:height', px: 0 });
    postFromPicker({ type: 'seatlayer:height', px: Number.NaN });
    expect(iframe.style.height).toBe('480px');
  });

  it('pins the iframe fullscreen and restores on off', () => {
    detach = attachPickerFrame(iframe);
    postFromPicker({ type: 'seatlayer:fullscreen', on: true });
    expect(iframe.style.position).toBe('fixed');
    expect(iframe.style.width).toBe('100vw');
    expect(iframe.style.height).toBe('100vh');
    expect(document.documentElement.style.overflow).toBe('hidden');

    postFromPicker({ type: 'seatlayer:fullscreen', on: false });
    expect(iframe.style.position).toBe('');
    expect(iframe.style.height).toBe('480px');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('re-applies the height reported while pinned, on unpin', () => {
    detach = attachPickerFrame(iframe);
    postFromPicker({ type: 'seatlayer:fullscreen', on: true });
    postFromPicker({ type: 'seatlayer:height', px: 640 });
    expect(iframe.style.height).toBe('100vh');
    postFromPicker({ type: 'seatlayer:fullscreen', on: false });
    expect(iframe.style.height).toBe('640px');
  });

  it('exits fullscreen on Escape', () => {
    detach = attachPickerFrame(iframe);
    postFromPicker({ type: 'seatlayer:fullscreen', on: true });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(iframe.style.position).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('ignores messages from the wrong origin', () => {
    detach = attachPickerFrame(iframe);
    postFromPicker({ type: 'seatlayer:height', px: 720 }, 'https://evil.example');
    postFromPicker({ type: 'seatlayer:fullscreen', on: true }, 'https://evil.example');
    expect(iframe.style.height).toBe('480px');
    expect(iframe.style.position).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('honours an explicit origin override', () => {
    detach = attachPickerFrame(iframe, { origin: 'https://custom.example' });
    postFromPicker({ type: 'seatlayer:height', px: 720 }, PICKER_ORIGIN);
    expect(iframe.style.height).toBe('480px');
    postFromPicker({ type: 'seatlayer:height', px: 720 }, 'https://custom.example');
    expect(iframe.style.height).toBe('720px');
  });

  it('detach removes the listener and restores pinned state', () => {
    detach = attachPickerFrame(iframe);
    postFromPicker({ type: 'seatlayer:fullscreen', on: true });
    expect(document.documentElement.style.overflow).toBe('hidden');
    detach();
    detach = null;
    expect(document.documentElement.style.overflow).toBe('');
    // Listener is gone: further messages are inert.
    postFromPicker({ type: 'seatlayer:height', px: 900 });
    expect(iframe.style.height).not.toBe('900px');
  });
});
