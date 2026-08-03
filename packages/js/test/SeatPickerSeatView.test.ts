/**
 * The 360° view-from-seat viewer, now that its generator is a lazy chunk.
 *
 * `openSeatView` used to be synchronous. It awaits `loadPanorama()` today, which
 * introduces two things worth pinning: an organizer's uploaded photo must not
 * wait on a generator it does not need, and the gap between the tap and the
 * viewer appearing is a window in which a second tap can arrive.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SeatPicker, type SeatPickerOptions } from '../src/SeatPicker';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

/* eslint-disable @typescript-eslint/no-explicit-any -- exercising a private method */
function mounted(overrides: Partial<SeatPickerOptions> = {}): { picker: any; root: HTMLDivElement } {
  const picker = new SeatPicker({ event: 'ev_test', container, ...overrides }) as any;
  // render() needs a live chart fetch; the viewer only needs a root to mount in.
  const root = document.createElement('div');
  container.appendChild(root);
  picker.root = root;
  return { picker, root };
}

const seat = (viewUrl?: string) => ({
  id: 's1', label: 'A1', x: 0, y: 0, categoryKey: 'std', viewUrl,
}) as any;

describe('openSeatView', () => {
  it('opens an organizer photo without ever reaching the generator', async () => {
    const { picker, root } = mounted();
    await picker.openSeatView(seat('https://example.test/seat.jpg'));
    const view = root.querySelector('.sl-view');
    expect(view).not.toBeNull();
    expect(view!.getAttribute('role')).toBe('dialog');
    expect(root.querySelector('.sl-view-pano')!.getAttribute('style'))
      .toContain('https://example.test/seat.jpg');
  });

  it('leaves exactly one viewer behind when two taps overlap', async () => {
    // The close-then-build order matters: closing before the await would let the
    // first viewer be built after the second close and orphan it in the DOM.
    const { picker, root } = mounted();
    await Promise.all([
      picker.openSeatView(seat('https://example.test/a.jpg')),
      picker.openSeatView(seat('https://example.test/b.jpg')),
    ]);
    expect(root.querySelectorAll('.sl-view').length).toBe(1);
  });

  it('reports and stands down when the generator cannot draw', async () => {
    // jsdom has no 2D canvas context, so the generated path throws here — which
    // is exactly the shape of a failed chunk fetch on a real buyer's phone. The
    // buyer must be left on the map, not looking at an empty viewer.
    const errors: unknown[] = [];
    const { picker, root } = mounted({ onError: (err) => errors.push(err) });
    await picker.openSeatView(seat());
    expect(root.querySelector('.sl-view')).toBeNull();
    expect(errors.length).toBe(1);
  });

  it('does nothing at all when seatView is switched off', async () => {
    const { picker, root } = mounted({ seatView: false });
    await picker.openSeatView(seat('https://example.test/seat.jpg'));
    expect(root.querySelector('.sl-view')).toBeNull();
  });
});
