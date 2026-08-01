/**
 * Hosted access links in the cockpit (M8).
 *
 * The behaviours worth defending, in the order the organizer meets them:
 *   - the create form carries the OWNER's defaults, each one editable;
 *   - the reveal happens exactly once and is unrecoverable afterwards — the
 *     assertion here is not "the dialog closed" but "the string is nowhere in
 *     the DOM and nowhere on the instance";
 *   - the status listing has no url, no capability, and no Copy control;
 *   - rotation cannot be submitted until the organizer says what happens to the
 *     buyers already inside;
 *   - platform bounds are the SERVER's to state, and its sentence is what the
 *     organizer reads;
 *   - a view-only token gets no mutation control at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageApi, ManageApiError } from '../src/manageApi';
import { ChannelsMode, type ChannelsClient, type ChannelsModeHost } from '../src/channelsMode';
import {
  ACCESS_LINK_DEFAULTS,
  accessLinkBadge,
  accessLinkErrorCopy,
  accessLinkIsLive,
  accessLinkPolicyLines,
  type AccessLinkRecord,
  type AccessLinkStatusRecord,
  type ChannelListResult,
  type ChannelSeatStatus,
} from '../src/channelPlan';

const REVEALED_URL = 'https://app.seatlayer.io/a#alc_ev1_0123456789abcdef0123456789abcdef';

function counts(over: Partial<ChannelListResult['publicSale']['counts']> = {}) {
  return { allocated: 0, free: 0, held: 0, booked: 0, blocked: 0, units: 0, ...over };
}

function listFixture(): ChannelListResult {
  return {
    assignmentVersion: 3,
    publicSale: {
      id: 'public', name: 'Public sale', state: 'active', counts: counts({ allocated: 800, free: 500 }),
    },
    channels: [{
      id: 'ch_s', name: 'Sponsor guests', color: '#2dd4bf', marker: 'S', externalRef: null,
      state: 'active', archiveDestination: null, createdAt: 1, updatedAt: 1, archivedAt: null,
      counts: counts({ allocated: 50, free: 22, booked: 26, held: 2 }),
      access: { intent: 'hosted_link', hasActiveGrants: true, lastMintAt: null },
    }],
  };
}

function linkFixture(over: Partial<AccessLinkStatusRecord> = {}): AccessLinkStatusRecord {
  return {
    id: 'alk_1', channelId: 'ch_s', label: 'VIP list Nov 14', includePublic: false,
    expiresAt: Date.now() + 5 * 86_400_000,
    maxRedemptions: 60, redemptions: 31, maxQuantity: 4, sessionTtlSeconds: 1800,
    state: 'active', status: 'active', createdAt: 1, createdBy: 'nadia',
    revokedAt: null, lastRedeemedAt: null, rotatedFrom: null, rotatedTo: null,
    activeSessions: 7,
    ...over,
  };
}

function revealFixture(over: Partial<AccessLinkRecord> = {}) {
  return {
    link: { ...linkFixture({ redemptions: 0, activeSessions: undefined }), ...over } as AccessLinkRecord,
    url: REVEALED_URL,
    capability: 'alc_ev1_0123456789abcdef0123456789abcdef',
    revealedOnce: true as const,
  };
}

function makeClient(over: Partial<ChannelsClient> = {}): ChannelsClient {
  return {
    channels: vi.fn().mockResolvedValue(listFixture()),
    channelAllocation: vi.fn().mockResolvedValue({
      assignmentVersion: 3, allocations: [{ label: 'S1', channelId: 'ch_s' }], nextAfterLabel: null,
    }),
    createChannel: vi.fn(),
    renameChannel: vi.fn(),
    setChannelPaused: vi.fn(),
    archiveChannel: vi.fn(),
    applyChannelAssignment: vi.fn(),
    channelPreview: vi.fn().mockResolvedValue({ available: true, eligible: [], counts: {} }),
    setChannelAccessIntent: vi.fn(),
    createAccessLink: vi.fn().mockResolvedValue(revealFixture()),
    accessLinks: vi.fn().mockResolvedValue({ links: [linkFixture()] }),
    rotateAccessLink: vi.fn().mockResolvedValue({ ...revealFixture({ id: 'alk_2' }), previous: linkFixture(), endedSessions: 0 }),
    revokeAccessLink: vi.fn().mockResolvedValue({ ok: true, link: linkFixture({ state: 'revoked' }), endedSessions: 0 }),
    ...over,
  };
}

interface Harness {
  mode: ChannelsMode;
  root: HTMLElement;
  rail: HTMLElement;
  client: ChannelsClient;
}

function mount(capabilities: { view: boolean; manage: boolean }, client = makeClient()): Harness {
  const root = document.createElement('div');
  root.className = 'slm';
  root.innerHTML = `<div class="slm-body"><div class="slm-map"><div class="slm-map-host"></div></div>
    <aside class="slm-rail"><div class="slm-railscroll"></div></aside></div>`;
  document.body.appendChild(root);
  const rail = root.querySelector('.slm-railscroll') as HTMLElement;
  const status: Record<string, ChannelSeatStatus> = { S1: 'free' };
  const host: ChannelsModeHost = {
    eventKey: 'ev_1',
    api: client,
    rail,
    mapLayer: root.querySelector('.slm-map') as HTMLElement,
    root,
    seats: () => [{ id: 'S1', label: 'S1', x: 0, y: 0 }],
    statusOf: (label) => status[label],
    selectionLabels: () => [],
    selectByLabels: () => {},
    clearSelection: () => {},
    selectSection: () => {},
    sections: () => [],
    categories: () => [],
    labelsInCategory: () => [],
    sectionOfLabel: () => null,
    worldToScreen: (point) => point,
    seatPixelSize: () => 6,
    isCompact: () => false,
    setMapInert: () => {},
    toast: () => {},
    onError: () => {},
  };
  return { mode: new ChannelsMode(host, capabilities), root, rail, client };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Open the Sponsor-guests detail panel with its hosted-link status loaded. */
async function openDetail(harness: Harness): Promise<void> {
  harness.mode.enter();
  await flush();
  (harness.rail.querySelector('[data-ch-detail="ch_s"]') as HTMLElement).click();
  await flush();
  await flush();
}

/**
 * Walk everything reachable from an object graph looking for a literal string.
 *
 * This is the real test of "revealed once": closing the dialog proves nothing if
 * the URL is still sitting on a field somewhere waiting for a future render.
 */
function reachableFrom(root: unknown, needle: string): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > 8 || value == null) return false;
    if (typeof value === 'string') return value.includes(needle);
    // Functions are skipped: the only ones reachable here are the vi.fn() doubles
    // on the host, whose `.mock.results` retain every response the test itself
    // fabricated. That is test bookkeeping, not cockpit state.
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    // DOM nodes are covered separately by the document-level assertion, and
    // walking them recurses into the whole page.
    if (typeof Node !== 'undefined' && value instanceof Node) return false;
    for (const key of Object.getOwnPropertyNames(value)) {
      let child: unknown;
      try { child = (value as Record<string, unknown>)[key]; } catch { continue; }
      if (walk(child, depth + 1)) return true;
    }
    if (value instanceof Map) {
      for (const entry of value.values()) if (walk(entry, depth + 1)) return true;
    }
    if (Array.isArray(value)) {
      for (const entry of value) if (walk(entry, depth + 1)) return true;
    }
    return false;
  };
  return walk(root, 0);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('hosted access link presentation', () => {
  it('states the owner-set policy defaults', () => {
    expect(ACCESS_LINK_DEFAULTS).toEqual({ maxRedemptions: 100, maxQuantity: 4 });
  });

  it('speaks plain language for every link state', () => {
    expect(accessLinkBadge({ state: 'active', status: 'active' }).text).toBe('Active');
    expect(accessLinkBadge({ state: 'active', status: 'expired' }).text).toBe('Expired');
    expect(accessLinkBadge({ state: 'active', status: 'exhausted' }).text).toBe('All used');
    expect(accessLinkBadge({ state: 'rotated', status: 'rotated' }).text).toBe('Replaced');
    expect(accessLinkBadge({ state: 'revoked', status: 'revoked' }).text).toBe('Revoked');
  });

  it('offers rotate/revoke only while a link is genuinely live', () => {
    expect(accessLinkIsLive({ state: 'active', status: 'active' })).toBe(true);
    expect(accessLinkIsLive({ state: 'active', status: 'exhausted' })).toBe(false);
    expect(accessLinkIsLive({ state: 'rotated', status: 'rotated' })).toBe(false);
  });

  it('summarises policy without ever naming a url', () => {
    const lines = accessLinkPolicyLines(linkFixture());
    expect(lines.map((line) => line.k)).toEqual(['Expires', 'Redemptions', 'Seats per buyer', 'Covers']);
    expect(lines.find((line) => line.k === 'Redemptions')?.v).toBe('31 of 60 used');
    expect(lines.find((line) => line.k === 'Seats per buyer')?.v).toBe('4 seats maximum');
    expect(JSON.stringify(lines)).not.toMatch(/http|alc_/);
  });

  it('reports the SERVER\'s sentence for a bounds refusal rather than its own', () => {
    const copy = accessLinkErrorCopy({
      code: 'invalid_max_redemptions',
      serverMessage: 'Redemptions must be between 1 and 10000',
    });
    expect(copy).toBe('Redemptions must be between 1 and 10000');
  });

  it('explains the live-link cap and the two lifecycle refusals', () => {
    expect(accessLinkErrorCopy({ code: 'too_many_access_links' })).toContain('Revoke one');
    expect(accessLinkErrorCopy({ code: 'access_link_not_active' })).toContain('no longer active');
    expect(accessLinkErrorCopy({ code: 'channel_unavailable' })).toContain('paused or archived');
    expect(accessLinkErrorCopy({ code: 'end_active_sessions_required' })).toContain('already came in');
  });
});

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

describe('ManageApi hosted-link routes', () => {
  function apiWith(body: unknown, init: { ok?: boolean; status?: number } = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    return { api: new ManageApi('https://api.test', 'mse_x'), fetchMock };
  }

  it('omits every unset policy field so the server default applies', async () => {
    const { api, fetchMock } = apiWith(revealFixture());
    await api.createAccessLink('ev_1', 'ch_s', { maxRedemptions: 100, maxQuantity: 4 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v1/events/ev_1/channels/ch_s/access-links');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ maxRedemptions: 100, maxQuantity: 4 });
  });

  it('always sends an explicit endActiveSessions on rotate', async () => {
    const { api, fetchMock } = apiWith(revealFixture());
    await api.rotateAccessLink('ev_1', 'ch_s', 'alk_1', false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v1/events/ev_1/channels/ch_s/access-links/alk_1/rotate');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ endActiveSessions: false });
  });

  it('carries the revoke cascade in the query string of a bodiless DELETE', async () => {
    const { api, fetchMock } = apiWith({ ok: true, link: linkFixture(), endedSessions: 2 });
    await api.revokeAccessLink('ev_1', 'ch_s', 'alk_1', true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v1/events/ev_1/channels/ch_s/access-links/alk_1?endActiveSessions=1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('keeps the server\'s human message alongside the machine code', async () => {
    const { api } = apiWith(
      { error: 'invalid_expiry', code: 'invalid_expiry', message: 'A hosted link must expire between 60 seconds and 180 days from now' },
      { ok: false, status: 422 },
    );
    await expect(api.createAccessLink('ev_1', 'ch_s', {})).rejects.toMatchObject({
      status: 422,
      code: 'invalid_expiry',
      serverMessage: 'A hosted link must expire between 60 seconds and 180 days from now',
    });
  });
});

// ---------------------------------------------------------------------------
// The cockpit flows
// ---------------------------------------------------------------------------

describe('ChannelsMode hosted access links', () => {
  beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('no longer promises a feature it cannot deliver', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    expect(harness.rail.textContent).not.toContain('Coming soon');
    expect(harness.rail.querySelector('[data-ch-act="link-create"]')).toBeTruthy();
  });

  it('pre-fills the create form with the owner\'s defaults, all editable', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    expect((dialog.querySelector('#slm-ch-lk-expiry') as HTMLSelectElement).value).toBe('event');
    expect((dialog.querySelector('#slm-ch-lk-redemptions') as HTMLInputElement).value).toBe('100');
    expect((dialog.querySelector('#slm-ch-lk-quantity') as HTMLInputElement).value).toBe('4');
    for (const id of ['#slm-ch-lk-expiry', '#slm-ch-lk-redemptions', '#slm-ch-lk-quantity', '#slm-ch-lk-label']) {
      expect((dialog.querySelector(id) as HTMLInputElement).disabled).toBe(false);
    }
  });

  it('sends the owner defaults and NO expiry when the organizer keeps "when the event starts"', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-lk-create]') as HTMLElement).click();
    await flush();
    expect(harness.client.createAccessLink).toHaveBeenCalledWith('ev_1', 'ch_s', {
      label: null, includePublic: false, maxRedemptions: 100, maxQuantity: 4,
    });
  });

  it('sends an absolute timestamp when the organizer picks a custom expiry', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    const expiry = dialog.querySelector('#slm-ch-lk-expiry') as HTMLSelectElement;
    expiry.value = 'custom';
    expiry.dispatchEvent(new Event('change'));
    (dialog.querySelector('#slm-ch-lk-when') as HTMLInputElement).value = '2026-11-13T23:59';
    (dialog.querySelector('[data-ch-lk-create]') as HTMLElement).click();
    await flush();
    const input = (harness.client.createAccessLink as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(input.expiresAt).toBe(Date.parse('2026-11-13T23:59'));
  });

  it('reveals the url ONCE and cannot show it again after the reveal is dismissed', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-lk-create]') as HTMLElement).click();
    await flush();

    expect(document.body.textContent).toContain(REVEALED_URL);
    expect(harness.root.querySelector('[data-ch-lk-url]')?.textContent).toBe(REVEALED_URL);

    (harness.root.querySelector('[data-ch-lk-done]') as HTMLElement).click();
    await flush();

    // Gone from the page…
    expect(document.body.innerHTML).not.toContain(REVEALED_URL);
    expect(document.body.innerHTML).not.toContain('alc_');
    // …and, more importantly, gone from anything that could re-render it.
    expect(reachableFrom(harness.mode, 'alc_')).toBe(false);
    // Re-painting and re-entering the channel cannot resurrect it.
    harness.mode.paintRail();
    (harness.rail.querySelector('[data-ch-detail="ch_s"]') as HTMLElement)?.click();
    await flush();
    expect(document.body.innerHTML).not.toContain(REVEALED_URL);
  });

  it('lists links as status only — no url, no capability, no Copy control', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    const listed = (harness.client.accessLinks as ReturnType<typeof vi.fn>).mock.results[0].value;
    for (const link of (await listed).links) {
      expect(Object.keys(link)).not.toContain('url');
      expect(Object.keys(link)).not.toContain('capability');
    }
    expect(harness.rail.textContent).toContain('VIP list Nov 14');
    expect(harness.rail.textContent).toContain('31 of 60 used');
    expect(harness.rail.textContent).toContain('4 seats maximum');
    expect(harness.rail.textContent).toContain('Buyers inside now');
    expect(harness.rail.textContent).toContain('Revealed once at creation');
    expect(harness.rail.innerHTML).not.toMatch(/https?:\/\/[^"']*\/a#|alc_/);
    const buttons = [...harness.rail.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.some((text) => /copy/i.test(text))).toBe(false);
  });

  it('will not rotate until the organizer chooses what happens to the buyers inside', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-rotate="alk_1"]') as HTMLElement).click();
    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('7 buyers');
    const confirm = dialog.querySelector('[data-ch-lk-rotate]') as HTMLButtonElement;
    // Neither branch is pre-selected: the gentle one is a decision too.
    expect([...dialog.querySelectorAll<HTMLInputElement>('[data-ch-rot]')].some((r) => r.checked)).toBe(false);
    expect(confirm.disabled).toBe(true);
    confirm.click();
    await flush();
    expect(harness.client.rotateAccessLink).not.toHaveBeenCalled();

    const end = dialog.querySelectorAll<HTMLInputElement>('[data-ch-rot]')[1];
    end.checked = true;
    end.dispatchEvent(new Event('change'));
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await flush();
    expect(harness.client.rotateAccessLink).toHaveBeenCalledWith('ev_1', 'ch_s', 'alk_1', true);
  });

  it('rotation ends in a fresh one-time reveal that names the dead link', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      rotateAccessLink: vi.fn().mockResolvedValue({
        ...revealFixture({ id: 'alk_2' }), previous: linkFixture(), endedSessions: 7,
      }),
    }));
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-rotate="alk_1"]') as HTMLElement).click();
    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    const keep = dialog.querySelectorAll<HTMLInputElement>('[data-ch-rot]')[0];
    keep.checked = true;
    keep.dispatchEvent(new Event('change'));
    (dialog.querySelector('[data-ch-lk-rotate]') as HTMLElement).click();
    await flush();
    const reveal = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    expect(reveal.textContent).toContain('The old link has stopped working');
    expect(reveal.textContent).toContain('7 buyers lost access immediately');
    expect(reveal.querySelector('[data-ch-lk-url]')?.textContent).toBe(REVEALED_URL);
  });

  it('confirms a revoke before calling the server, and can cascade the sessions', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-revoke="alk_1"]') as HTMLElement).click();
    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('cannot be restored');
    expect(harness.client.revokeAccessLink).not.toHaveBeenCalled();
    (dialog.querySelector('[data-ch-lk-endsessions]') as HTMLInputElement).checked = true;
    (dialog.querySelector('[data-ch-lk-revoke]') as HTMLElement).click();
    await flush();
    expect(harness.client.revokeAccessLink).toHaveBeenCalledWith('ev_1', 'ch_s', 'alk_1', true);
  });

  it('renders ZERO hosted-link mutation controls for a view-only token', async () => {
    const harness = mount({ view: true, manage: false });
    harness.mode.enter();
    await flush();
    const html = harness.rail.innerHTML;
    expect(html).not.toContain('data-ch-detail');
    expect(html).not.toContain('data-ch-act="link-create"');
    expect(html).not.toContain('data-ch-rotate');
    expect(html).not.toContain('data-ch-revoke');
  });

  it('drops the create control the moment manage authority is lost', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    expect(harness.rail.querySelector('[data-ch-act="link-create"]')).toBeTruthy();
    harness.mode.setCapabilities({ view: true, manage: false });
    expect(harness.rail.querySelector('[data-ch-act="link-create"]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-rotate="alk_1"]')).toBeNull();
  });

  it('shows the server\'s own bounds sentence on a 422', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      createAccessLink: vi.fn().mockRejectedValue(new ManageApiError(
        422, 'invalid_max_quantity', 'invalid_max_quantity', undefined, { min: 1, max: 100 },
        'Seats per buyer must be between 1 and 100',
      )),
    }));
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-lk-create]') as HTMLElement).click();
    await flush();
    const error = harness.root.querySelector('[data-ch-error]') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Seats per buyer must be between 1 and 100');
    expect(harness.root.querySelector('[data-ch-lk-url]')).toBeNull();
  });

  it('explains the live-link cap instead of failing silently', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      createAccessLink: vi.fn().mockRejectedValue(new ManageApiError(
        409, 'too_many_access_links', 'too_many_access_links', undefined, { max: 20 },
        'A channel may hold at most 20 live hosted links',
      )),
    }));
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-lk-create]') as HTMLElement).click();
    await flush();
    expect((harness.root.querySelector('[data-ch-error]') as HTMLElement).textContent)
      .toBe('A channel may hold at most 20 live hosted links');
  });

  it('says hosted links need a newer server rather than showing an error', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      accessLinks: vi.fn().mockRejectedValue(new ManageApiError(404, 'not_found')),
    }));
    await openDetail(harness);
    expect(harness.rail.textContent).toContain('Hosted links need a newer server');
    expect(harness.rail.querySelector('[data-ch-act="link-create"]')).toBeNull();
  });

  it('points at the guide for server integration instead of a dead button', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    expect(harness.rail.textContent).toContain('nothing to set up on this screen');
    const guide = harness.rail.querySelector('a[href*="docs.seatlayer.io"]') as HTMLAnchorElement;
    expect(guide).toBeTruthy();
    expect(guide.rel).toContain('noopener');
    expect([...harness.rail.querySelectorAll('button')].some((b) => b.disabled)).toBe(false);
  });

  it('gives the reveal a modal dialog that Escape closes without leaving the url behind', async () => {
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-lk-create]') as HTMLElement).click();
    await flush();
    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('slm-ch-dlg-title');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(document.body.innerHTML).not.toContain(REVEALED_URL);
    expect(reachableFrom(harness.mode, 'alc_')).toBe(false);
  });

  it('copies the revealed url from the closure, never from a stored field', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const harness = mount({ view: true, manage: true });
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-lk-create]') as HTMLElement).click();
    await flush();
    (harness.root.querySelector('[data-ch-lk-copy]') as HTMLElement).click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(REVEALED_URL);
    expect(reachableFrom(harness.mode, 'alc_')).toBe(false);
  });
});
