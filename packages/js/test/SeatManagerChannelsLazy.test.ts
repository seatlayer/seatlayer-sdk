/**
 * Channels mode is loaded on demand — and the loading must be invisible.
 *
 * `channelsMode` is a ~95 KB (minified) sub-app that most cockpit visits never
 * open, so `SeatManager` reaches it through `import('./channelsMode')` on first
 * entry rather than in its static graph. That saving is real, but it moves a
 * previously synchronous construction behind a network fetch, and four things
 * could quietly break in that gap. This file pins all four, because every one
 * of them would look like a permissions bug or an inventory bug to an organizer
 * rather than like a loading bug:
 *
 *   1. **The pill is authority, not readiness.** It must appear the moment the
 *      token is known to carry `event:channels:view`, with no module loaded and
 *      nothing fetched. A pill that pops in when a chunk lands reads as a
 *      permission change that did not happen; a pill that is missing until then
 *      reads as a permission the member does not have.
 *   2. **Nothing is loaded until someone asks.** The whole point.
 *   3. **The rail says which state it is in.** A blank Channels rail reads as
 *      "this event has no channels" — a false claim about inventory. Loading
 *      and failure are distinct, stated answers.
 *   4. **A mode change during the load is respected.** Tapping Channels and
 *      then Monitor must not yank the member into Channels when the chunk
 *      arrives.
 *
 * Style follows the sibling wrapper tests: construct WITHOUT `render()` (which
 * would need the network and Konva) and drive the private surface, which is the
 * same code path `render()` runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatManager } from '../src/SeatManager';

/* eslint-disable @typescript-eslint/no-explicit-any -- exercising private state, as the sibling wrapper tests do */

let container: HTMLDivElement;

/** A chrome-built manager with no chart, no socket and no fetch anywhere. */
function manager(capabilities?: string[]): any {
  const m: any = new SeatManager({
    container,
    eventKey: 'ev_1',
    token: 'mse_tok',
    capabilities: capabilities as never,
  });
  m.buildChrome();
  return m;
}

/** Await the in-flight `import('./channelsMode')` and its continuation. */
async function settle(m: any): Promise<void> {
  await m.channelsLoading;
}

const pill = (m: any): HTMLElement =>
  m.els.modes.querySelector('[data-mode="channels"]') as HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  document.getElementById('seatlayer-manager-channels-style')?.remove();
  vi.restoreAllMocks();
});

describe('the Channels pill follows authority, not the loader', () => {
  it('appears from capability alone, with nothing loaded', async () => {
    const m = manager(['event:view', 'event:channels:view']);
    await m.resolveChannelCapabilities();

    expect(m.channelCaps).toEqual({ view: true, manage: false });
    expect(pill(m).hidden).toBe(false);
    // The saving itself: authority is settled and the sub-app is still absent.
    expect(m.channels).toBeNull();
    expect(m.channelsLoading).toBeNull();
  });

  it('stays hidden without the capability, and the mode falls back to Monitor', async () => {
    const m = manager(['event:view']);
    await m.resolveChannelCapabilities();

    expect(pill(m).hidden).toBe(true);
    m.setMode('channels');
    expect(m.mode).toBe('view');
    expect(m.channelsLoading).toBeNull();
  });
});

describe('the module arrives on first entry', () => {
  it('loads once, builds once, and injects its stylesheet with it', async () => {
    const m = manager(['event:view', 'event:channels:view', 'event:channels:manage']);
    await m.resolveChannelCapabilities();
    expect(document.getElementById('seatlayer-manager-channels-style')).toBeNull();

    m.setMode('channels');
    // Two more entries while the first is still in the air must not double-load.
    const first = m.channelsLoading;
    m.setMode('channels');
    expect(m.channelsLoading).toBe(first);
    await settle(m);

    expect(m.channels).not.toBeNull();
    expect(m.channels.caps).toEqual({ view: true, manage: true });
    const style = document.getElementById('seatlayer-manager-channels-style');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('.slm-ch');

    const built = m.channels;
    m.setMode('view');
    m.setMode('channels');
    await settle(m);
    expect(m.channels).toBe(built);
  });

  it('says it is loading rather than showing an empty rail', async () => {
    const m = manager(['event:view', 'event:channels:view']);
    await m.resolveChannelCapabilities();

    m.setMode('channels');
    // Synchronously after the tap: the chunk cannot have landed yet.
    expect(m.channels).toBeNull();
    expect(m.els.rail.textContent).toContain('Loading sales channels');
  });

  it('does not enter Channels if the member left while it loaded', async () => {
    const m = manager(['event:view', 'event:channels:view']);
    await m.resolveChannelCapabilities();

    m.setMode('channels');
    m.setMode('view');
    await settle(m);

    // The instance is kept — it is paid for — but the member stayed put.
    expect(m.mode).toBe('view');
    expect(m.channels).not.toBeNull();
    expect(m.channels.active).toBeFalsy();
  });

  it('does not build the sub-app if the capability was revoked mid-load', async () => {
    const m = manager(['event:view', 'event:channels:view']);
    await m.resolveChannelCapabilities();

    m.setMode('channels');
    // A token rotation between the tap and the arrival.
    m.channelCaps = { view: false, manage: false };
    await settle(m);

    expect(m.channels).toBeNull();
  });
});
