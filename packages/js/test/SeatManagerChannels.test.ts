import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageApi, ManageApiError } from '../src/manageApi';
import {
  ChannelsMode,
  bucketRowsHtml,
  type ChannelsClient,
  type ChannelsModeHost,
} from '../src/channelsMode';
import {
  PUBLIC_CHANNEL_ID,
  accessLine,
  bucketRows,
  dropReviewRows,
  markerLetter,
  markerOf,
  mutationCount,
  needsMoveConfirmation,
  planAssignment,
  retryAfterCopy,
  selectionSources,
  suggestMarker,
  type AssignmentBuckets,
  type ChannelListResult,
  type ChannelSeatStatus,
} from '../src/channelPlan';

/**
 * The literal Public-sale id the worker puts on the wire
 * (`eventChannels.PUBLIC_CHANNEL_ID`). Hard-coded ON PURPOSE: every fixture below
 * used the SDK's own constant, so when that constant was wrong ('') the fixtures
 * were wrong with it and the whole suite stayed green while production lied.
 */
const SERVER_PUBLIC_ID = 'public';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

function counts(over: Partial<ChannelListResult['publicSale']['counts']> = {}) {
  return { allocated: 0, free: 0, held: 0, booked: 0, blocked: 0, units: 0, ...over };
}

function listFixture(): ChannelListResult {
  return {
    assignmentVersion: 7,
    publicSale: {
      // The server's real sentinel. These fixtures used '' until 2026-08-02 —
      // which is exactly why they never caught the public-sale misclassification.
      id: SERVER_PUBLIC_ID, name: 'Public sale', state: 'active',
      counts: counts({ allocated: 800, free: 469, booked: 296 }),
    },
    channels: [
      {
        id: 'ch_a', name: 'Travel Agency A', color: '#a78bfa', marker: 'A', externalRef: null,
        state: 'active', archiveDestination: null, createdAt: 1, updatedAt: 1, archivedAt: null,
        counts: counts({ allocated: 120, free: 103, booked: 14, held: 3 }),
        access: { intent: 'server', hasActiveGrants: true, lastMintAt: null },
      },
      {
        id: 'ch_s', name: 'Sponsor guests', color: '#2dd4bf', marker: 'S', externalRef: null,
        state: 'paused', archiveDestination: null, createdAt: 2, updatedAt: 2, archivedAt: null,
        counts: counts({ allocated: 50, free: 22, booked: 26, held: 2 }),
        access: { intent: 'hosted_link', hasActiveGrants: false, lastMintAt: null },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

describe('channel plan', () => {
  it('speaks the same Public-sale id the server does', () => {
    expect(PUBLIC_CHANNEL_ID).toBe(SERVER_PUBLIC_ID);
  });

  const status: Record<string, ChannelSeatStatus> = {
    P1: 'free', P2: 'free', P3: 'held', P4: 'booked',
    S1: 'free', S2: 'free',
    A1: 'free', A2: 'booked',
  };
  const allocation = new Map<string, string>([
    ['S1', 'ch_s'], ['S2', 'ch_s'], ['A1', 'ch_a'], ['A2', 'ch_a'],
  ]);
  const plan = (labels: string[], target = 'ch_a'): AssignmentBuckets => planAssignment({
    labels,
    targetChannelId: target,
    allocation,
    statusOf: (label) => status[label],
    nameOf: (id) => (id === 'ch_s' ? 'Sponsor guests' : id === 'ch_a' ? 'Travel Agency A' : null),
  });

  it('puts every requested label in exactly one bucket', () => {
    const labels = ['P1', 'P2', 'P3', 'P4', 'S1', 'S2', 'A1', 'A2', 'GHOST'];
    const buckets = plan(labels);
    const total = buckets.changedFromPublic.count
      + buckets.movedFromOtherChannel.count
      + buckets.alreadyInTarget.count
      + buckets.skippedHeld.count
      + buckets.skippedBooked.count
      + buckets.notFound.count;
    expect(total).toBe(labels.length);
  });

  it('never moves held or booked inventory, and itemises private sources', () => {
    const buckets = plan(['P1', 'P2', 'P3', 'P4', 'S1', 'S2']);
    expect(buckets.changedFromPublic.count).toBe(2);
    expect(buckets.skippedHeld).toMatchObject({ count: 1, labels: ['P3'] });
    expect(buckets.skippedBooked).toMatchObject({ count: 1, labels: ['P4'] });
    expect(buckets.movedFromOtherChannel.channels)
      .toEqual([{ channelId: 'ch_s', name: 'Sponsor guests', count: 2 }]);
    expect(mutationCount(buckets)).toBe(4);
  });

  it('counts units already in the target as unchanged whatever their status', () => {
    const buckets = plan(['A1', 'A2']);
    expect(buckets.alreadyInTarget.count).toBe(2);
    expect(buckets.skippedBooked.count).toBe(0);
    expect(mutationCount(buckets)).toBe(0);
  });

  it('flags labels that are not inventory on this event', () => {
    const buckets = plan(['GHOST', 'ALSO_GONE']);
    expect(buckets.notFound).toMatchObject({ count: 2, labels: ['GHOST', 'ALSO_GONE'] });
  });

  it('summarises mixed selection sources, public first', () => {
    const rows = selectionSources(['A1', 'P1', 'S1', 'P2'], allocation, listFixture());
    expect(rows).toEqual([
      { channelId: SERVER_PUBLIC_ID, name: 'Public sale', count: 2 },
      { channelId: 'ch_a', name: 'Travel Agency A', count: 1 },
      { channelId: 'ch_s', name: 'Sponsor guests', count: 1 },
    ]);
  });

  it('gives every channel a letter marker, never colour alone', () => {
    expect(markerOf({ id: 'ch_a', name: 'Travel Agency A', marker: 'A', color: '#a78bfa' }))
      .toEqual({ letter: 'A', color: '#a78bfa' });
    // No stored marker: derive a letter rather than fall back to colour only.
    expect(markerOf({ id: 'ch_z', name: 'Zebra club', marker: null, color: null }).letter).toBe('Z');
    expect(markerOf({ id: SERVER_PUBLIC_ID, name: 'Public sale', marker: null, color: null }).letter).toBe('P');
  });

  // V3 — the rail drew "?" on production because the built-in row arrives with
  // the server's 'public' id, which the old `id === ''` test never matched, so
  // it fell through to the private branch with no name and no stored marker.
  it('marks the built-in public row P, whichever sentinel the worker sends', () => {
    for (const id of ['public', '']) {
      const marker = markerOf({ id, name: 'Public sale', marker: null, color: null });
      expect(marker.letter).toBe('P');
      expect(marker.color).toBe('#f4b740');
    }
  });

  it('renders a marker as exactly ONE uppercase letter, never a truncated word', () => {
    // The server column is free text: "star" used to render as the chip "ST".
    expect(markerOf({ id: 'ch_x', name: 'Starlight', marker: 'star', color: null }).letter).toBe('S');
    expect(markerOf({ id: 'ch_x', name: 'VIP suites', marker: 'VIP', color: null }).letter).toBe('V');
    expect(markerLetter('★ gold', 'X')).toBe('G');
    expect(markerLetter('', 'X')).toBe('X');
    expect(markerLetter(null, 'P')).toBe('P');
  });

  it('suggests an unused marker letter for a new channel', () => {
    expect(suggestMarker('Box office', ['A', 'S']).letter).toBe('B');
    expect(suggestMarker('Agency B', ['A', 'S']).letter).not.toBe('A');
    // A stored word marker occupies the letter it RENDERS as, not its whole text.
    expect(suggestMarker('Sponsor guests', ['star']).letter).not.toBe('S');
  });
});

// ---------------------------------------------------------------------------
// V2 — Public sale is not "another channel"
//
// The allocation map is built from GET /channels/allocation, which names public
// sale EXPLICITLY on every unallocated row ('public'). The fixtures above used
// '' for public, which is why no existing test exercised the real wire value.
// ---------------------------------------------------------------------------

describe('channel plan · public-sentinel allocation', () => {
  const status: Record<string, ChannelSeatStatus> = {
    P1: 'free', P2: 'free', P3: 'free', S1: 'free',
  };
  // Exactly what loadAllocation would hold if it did NOT filter public rows out,
  // plus the shape it does hold. Both must classify public units identically.
  const explicitPublic = new Map<string, string>([
    ['P1', SERVER_PUBLIC_ID], ['P2', SERVER_PUBLIC_ID], ['P3', SERVER_PUBLIC_ID],
    ['S1', 'ch_s'],
  ]);
  const filteredPublic = new Map<string, string>([['S1', 'ch_s']]);

  const plan = (allocation: Map<string, string>, target = 'ch_new') => planAssignment({
    labels: ['P1', 'P2', 'P3'],
    targetChannelId: target,
    allocation,
    statusOf: (label) => status[label],
    nameOf: (id) => (id === 'ch_s' ? 'Sponsor guests' : null),
  });

  it('counts public-sale units as changedFromPublic, not movedFromOtherChannel', () => {
    const buckets = plan(explicitPublic);
    expect(buckets.changedFromPublic.count).toBe(3);
    expect(buckets.movedFromOtherChannel.count).toBe(0);
    expect(buckets.movedFromOtherChannel.channels).toEqual([]);
  });

  it('never asks for the private→private move confirmation on a public-only staging', () => {
    expect(needsMoveConfirmation(plan(explicitPublic))).toBe(false);
    const rows = bucketRows(plan(explicitPublic), 'Sponsor guests');
    expect(rows.map((row) => row.kind)).toEqual(['add']);
    expect(rows[0].text).toBe('3 from Public sale');
    expect(rows[0].icon).toBe('+');
  });

  it('classifies identically whether the map names public sale or omits it', () => {
    expect(plan(explicitPublic)).toEqual(plan(filteredPublic));
  });

  it('treats an explicit public target as "already in target" for public units', () => {
    const buckets = plan(explicitPublic, SERVER_PUBLIC_ID);
    expect(buckets.alreadyInTarget.count).toBe(3);
    expect(mutationCount(buckets)).toBe(0);
  });

  it('names public sale in the selection summary, never "Another channel"', () => {
    const rows = selectionSources(['P1', 'P2', 'S1'], explicitPublic, listFixture());
    expect(rows).toEqual([
      { channelId: SERVER_PUBLIC_ID, name: 'Public sale', count: 2 },
      { channelId: 'ch_s', name: 'Sponsor guests', count: 1 },
    ]);
    expect(rows.some((row) => row.name === 'Another channel')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bucket rendering (comp's five lines + the documented sixth)
// ---------------------------------------------------------------------------

describe('review buckets', () => {
  const buckets: AssignmentBuckets = {
    changedFromPublic: { count: 85 },
    movedFromOtherChannel: { count: 10, channels: [{ channelId: 'ch_s', name: 'Sponsor guests', count: 10 }] },
    alreadyInTarget: { count: 20 },
    skippedHeld: { count: 2, labels: ['K-4', 'K-5'], truncated: false },
    skippedBooked: { count: 3, labels: ['B-1'], truncated: true },
    notFound: { count: 0, labels: [], truncated: false },
  };

  it('renders the comp five lines and drops empty buckets', () => {
    const rows = bucketRows(buckets, 'Travel Agency A');
    expect(rows.map((row) => row.kind)).toEqual(['add', 'move', 'same', 'skip', 'skip']);
    expect(rows[0].text).toContain('from Public sale');
    expect(rows[3].peek).toBe('K-4, K-5');
    expect(rows.some((row) => row.text.includes('not on this map'))).toBe(false);
  });

  it('adds the "not on this map" line when notFound is non-zero', () => {
    const rows = bucketRows({ ...buckets, notFound: { count: 4, labels: ['Z9'], truncated: true } }, 'Travel Agency A');
    const missing = rows.at(-1)!;
    expect(missing.text).toBe('4 not on this map');
    expect(missing.why).toContain('no longer part of the event');
    expect(missing.peek).toBe('Z9…');
  });

  it('renders a chart-update drop refusal through the SAME row component', () => {
    const rows = dropReviewRows({
      droppedUnits: 12,
      channels: [{ channelId: 'ch_a', name: 'Travel Agency A', count: 12, labels: ['A1', 'A2'], truncated: true }],
      acknowledgeWith: 'tok',
    });
    expect(rows[0]).toMatchObject({ kind: 'skip', count: 12 });
    expect(bucketRowsHtml(rows)).toContain('would leave Travel Agency A');
  });
});

describe('archive retry copy', () => {
  it('rounds the wait up so nobody comes back early', () => {
    expect(retryAfterCopy({ retryAfterMs: 11 * 60_000 + 1 })).toBe('in about 12 minutes');
    expect(retryAfterCopy({ retryAfterMs: 30_000 })).toBe('in about a minute');
    expect(retryAfterCopy(null)).toBe('in a moment');
  });
});

describe('access line', () => {
  it('falls back to an em dash when the server sends no access field', () => {
    expect(accessLine(undefined)).toBe('—');
    expect(accessLine({})).toBe('—');
  });

  it('reads the final hardening intents', () => {
    expect(accessLine({ intent: 'hosted_link', hasActiveGrants: true })).toBe('Hosted access link · in use now');
    expect(accessLine({ intent: 'internal' })).toContain('Internal selling');
    expect(accessLine({ intent: 'none' })).toBe('No buyer access configured');
  });
});

// ---------------------------------------------------------------------------
// ManageApi wire contract
// ---------------------------------------------------------------------------

describe('ManageApi channel routes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists channels with the Bearer token and the archived flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(listFixture()));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ManageApi('https://api.seatlayer.io/', 'mse_tok');

    await api.channels('ev_1', { includeArchived: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.seatlayer.io/v1/events/ev_1/channels?includeArchived=1');
    expect(init.headers.Authorization).toBe('Bearer mse_tok');
    expect(init.credentials).toBe('omit');
  });

  it('sends the versioned assignment body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, applied: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ManageApi('https://api.seatlayer.io', 'sk_secret');

    await api.applyChannelAssignment('ev_1', { targetChannelId: 'ch_a', labels: ['A1'], assignmentVersion: 7 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.seatlayer.io/v1/events/ev_1/channels/assignments');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ targetChannelId: 'ch_a', labels: ['A1'], assignmentVersion: 7 });
  });

  it('asks the server for a preview projection with the final query shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ available: true, eligible: ['A1'] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ManageApi('https://api.seatlayer.io', 'sk_secret');

    await api.channelPreview('ev_1', ['ch_a'], { includePublic: false });

    expect(fetchMock.mock.calls[0][0])
      .toBe('https://api.seatlayer.io/v1/events/ev_1/channels/preview?channelIds=ch_a&includePublic=0');
  });

  it('carries the archive-blocked 409 details onto the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'channel_archive_blocked_by_holds',
      code: 'channel_archive_blocked_by_holds',
      details: { activeHolds: 2, heldUnits: 2, latestHoldExpiresAt: 1, retryAfterMs: 720_000 },
    }, { ok: false, status: 409 })));
    const api = new ManageApi('https://api.seatlayer.io', 'sk_secret');

    await expect(api.archiveChannel('ev_1', 'ch_s', null)).rejects.toMatchObject({
      status: 409,
      code: 'channel_archive_blocked_by_holds',
      details: { retryAfterMs: 720_000 },
    });
  });
});

// ---------------------------------------------------------------------------
// Mode behaviour (DOM)
// ---------------------------------------------------------------------------

function makeClient(over: Partial<ChannelsClient> = {}): ChannelsClient {
  return {
    channels: vi.fn().mockResolvedValue(listFixture()),
    channelAllocation: vi.fn().mockResolvedValue({
      assignmentVersion: 7,
      allocations: [
        { label: 'A1', channelId: 'ch_a' }, { label: 'A2', channelId: 'ch_a' },
        { label: 'S1', channelId: 'ch_s' }, { label: 'P1', channelId: SERVER_PUBLIC_ID },
      ],
      nextAfterLabel: null,
    }),
    createChannel: vi.fn(),
    renameChannel: vi.fn(),
    setChannelPaused: vi.fn(),
    archiveChannel: vi.fn(),
    applyChannelAssignment: vi.fn(),
    channelPreview: vi.fn().mockResolvedValue({ available: true, eligible: ['A1'], counts: { eligible: 1 } }),
    setChannelAccessIntent: vi.fn(),
    createAccessLink: vi.fn(),
    accessLinks: vi.fn().mockResolvedValue({ links: [] }),
    rotateAccessLink: vi.fn(),
    revokeAccessLink: vi.fn(),
    ...over,
  };
}

interface Harness {
  mode: ChannelsMode;
  root: HTMLElement;
  rail: HTMLElement;
  client: ChannelsClient;
  selection: string[];
  setSelection(labels: string[]): void;
}

function mount(
  capabilities: { view: boolean; manage: boolean },
  client = makeClient(),
): Harness {
  const root = document.createElement('div');
  root.className = 'slm';
  root.innerHTML = `<div class="slm-body"><div class="slm-map"><div class="slm-map-host"></div></div>
    <aside class="slm-rail"><div class="slm-railscroll"></div></aside></div>`;
  document.body.appendChild(root);
  const rail = root.querySelector('.slm-railscroll') as HTMLElement;
  const status: Record<string, ChannelSeatStatus> = { A1: 'free', A2: 'booked', S1: 'free', P1: 'free', P2: 'held' };
  const state = { selection: [] as string[] };
  const host: ChannelsModeHost = {
    eventKey: 'ev_1',
    api: client,
    rail,
    mapLayer: root.querySelector('.slm-map') as HTMLElement,
    root,
    seats: () => Object.keys(status).map((label, index) => ({ id: label, label, x: index * 10, y: 0 })),
    statusOf: (label) => status[label],
    selectionLabels: () => state.selection,
    selectByLabels: (labels) => { state.selection = [...new Set([...state.selection, ...labels])]; },
    clearSelection: () => { state.selection = []; },
    selectSection: () => {},
    sections: () => [{ id: 'sec-1', label: 'Stalls' }],
    categories: () => [{ key: 'std', label: 'Standard' }],
    labelsInCategory: () => ['A1'],
    sectionOfLabel: () => ({ id: 'sec-1', label: 'Stalls' }),
    worldToScreen: (point) => ({ x: point.x, y: point.y }),
    seatPixelSize: () => 6,
    isCompact: () => false,
    setMapInert: () => {},
    toast: () => {},
    onError: () => {},
  };
  const mode = new ChannelsMode(host, capabilities);
  return {
    mode, root, rail, client,
    get selection() { return state.selection; },
    setSelection(labels: string[]) { state.selection = labels; },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ChannelsMode capability gating', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders nothing but an explanation without channel-view permission', async () => {
    const harness = mount({ view: false, manage: false });
    harness.mode.enter();
    await flush();
    expect(harness.rail.textContent).toContain('channel-management permission');
    expect(harness.client.channels).not.toHaveBeenCalled();
  });

  it('renders ZERO mutation controls for a view-only token', async () => {
    const harness = mount({ view: true, manage: false });
    harness.mode.enter();
    await flush();
    const html = harness.rail.innerHTML;
    expect(html).toContain('Travel Agency A');
    expect(html).toContain('120');
    // Absent, not disabled — a read-only operator is never shown authority.
    expect(html).not.toContain('Create channel');
    expect(harness.rail.querySelector('[data-ch-detail]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="create"]')).toBeNull();
    expect(harness.rail.querySelectorAll('[disabled]').length).toBe(0);
    expect(harness.mode.canSelect()).toBe(false);
  });

  it('offers create + per-channel management to a manage token', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    expect(harness.rail.querySelector('[data-ch-act="create"]')).not.toBeNull();
    expect(harness.rail.querySelectorAll('[data-ch-detail]').length).toBe(2);
    expect(harness.mode.canSelect()).toBe(true);
  });

  it('drops to read-only when the server refuses the list', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      channels: vi.fn().mockRejectedValue(new ManageApiError(403, 'forbidden', 'missing_manage_capability')),
    }));
    harness.mode.enter();
    await flush();
    expect(harness.rail.textContent).toContain('channel-management permission');
  });
});

describe('ChannelsMode rail + a11y', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('pins Public sale as built-in and shows exact counts plus an access line', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    const rows = [...harness.rail.querySelectorAll('.slm-ch-row')];
    expect(rows[0].textContent).toContain('Public sale');
    expect(rows[0].textContent).toContain('Built-in');
    expect(rows[1].textContent).toContain('Server integration');
    expect(rows[2].textContent).toContain('Paused');
    // Falls back rather than inventing a state when access is absent.
    expect(rows[0].querySelector('.slm-ch-access')).toBeNull();
  });

  // V3 as the owner saw it: the built-in row's chip read "?" on production.
  it('draws the Public sale marker as P in the accent gold, never "?"', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    const chip = harness.rail.querySelector('.slm-ch-row.public .slm-ch-mk') as HTMLElement;
    expect(chip.textContent).toBe('P');
    expect(chip.style.background).toContain('244, 183, 64'); // #f4b740
    expect(harness.rail.innerHTML).not.toContain('>?<');
  });

  // V2 as the owner saw it: staging Public-sale seats claimed they came out of
  // "another channel" and demanded the private→private move confirmation.
  it('reviews Public-sale seats as an addition, with no move confirmation', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1']);
    harness.mode.handleSelectionChange();
    (harness.rail.querySelector('[data-ch-act="review"]') as HTMLElement | null)?.click();
    await flush();
    const dialog = document.querySelector('.slm-ch-dialog, [role="dialog"]')!;
    expect(dialog.textContent).toContain('from Public sale');
    expect(dialog.textContent).not.toContain('moved out of');
    expect(dialog.textContent).not.toContain('another private channel');
  });

  it('announces the mixed-source selection summary in a live region', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(['A1', 'S1', 'P1']);
    harness.mode.handleSelectionChange();
    const live = harness.rail.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toContain('Public sale');
    expect(live.textContent).toContain('Travel Agency A');
    expect(live.textContent).toContain('Sponsor guests');
  });

  it('stages a sticky bar with the honest skipped count', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1', 'P2', 'A2']);
    harness.mode.handleSelectionChange();
    const staged = harness.root.querySelector('.slm-ch-staged')!;
    expect(staged.classList.contains('on')).toBe(true);
    expect(staged.textContent).toContain("can't move now");
  });

  it('gives a dialog a name, traps focus and closes on Escape without mutating', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    (harness.rail.querySelector('[data-ch-act="create"]') as HTMLElement).click();
    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('#slm-ch-dlg-title')).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
    expect(harness.client.createChannel).not.toHaveBeenCalled();
  });
});

describe('ChannelsMode apply', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders the AUTHORITATIVE server buckets after Apply', async () => {
    const applied = {
      ok: true as const, targetChannelId: 'ch_a', assignmentVersion: 8, requested: 3, applied: 2,
      buckets: {
        changedFromPublic: { count: 2 },
        movedFromOtherChannel: { count: 0, channels: [] },
        alreadyInTarget: { count: 0 },
        skippedHeld: { count: 1, labels: ['P2'], truncated: false },
        skippedBooked: { count: 0, labels: [], truncated: false },
        notFound: { count: 5, labels: ['GONE'], truncated: true },
      },
    };
    const harness = mount({ view: true, manage: true }, makeClient({
      applyChannelAssignment: vi.fn().mockResolvedValue(applied),
    }));
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1', 'P2', 'S1']);
    harness.mode.handleSelectionChange();
    (harness.rail.querySelector('[data-ch-act="review"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-apply]') as HTMLElement).click();
    await flush();
    await flush();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Moved 2 seats');
    // The sixth bucket the comp does not draw, rendered because it is non-zero.
    expect(dialog.textContent).toContain('not on this map');
    expect(harness.root.querySelector('[aria-live="polite"]')!.textContent).toContain('Applied 2');
  });

  it('keeps the selection and offers Refresh and review on a version conflict', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      applyChannelAssignment: vi.fn().mockRejectedValue(
        new ManageApiError(409, 'channel_assignment_conflict', 'channel_assignment_conflict', undefined,
          { assignmentVersion: 9 }),
      ),
    }));
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1', 'S1']);
    harness.mode.handleSelectionChange();
    (harness.rail.querySelector('[data-ch-act="review"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-apply]') as HTMLElement).click();
    await flush();

    expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
    expect(harness.selection).toEqual(['P1', 'S1']);
    const alert = harness.rail.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Nothing was applied');
    expect(harness.rail.querySelector('[data-ch-act="refresh-review"]')).not.toBeNull();
  });

  it('cannot apply when every selected unit is skipped', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(['A1', 'A2']); // already in Travel Agency A
    harness.mode.handleSelectionChange();
    (harness.rail.querySelector('[data-ch-act="review"]') as HTMLElement).click();
    const apply = harness.root.querySelector('[data-ch-apply]') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
  });
});

describe('ChannelsMode archive + preview', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('blocks archive on active holds and says when to come back', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      archiveChannel: vi.fn().mockRejectedValue(new ManageApiError(
        409, 'channel_archive_blocked_by_holds', 'channel_archive_blocked_by_holds', undefined,
        { activeHolds: 2, heldUnits: 2, retryAfterMs: 12 * 60_000 },
      )),
    }));
    harness.mode.enter();
    await flush();
    (harness.rail.querySelectorAll('[data-ch-detail]')[1] as HTMLElement).click();
    (harness.rail.querySelector('[data-ch-act="archive"]') as HTMLElement).click();
    (harness.root.querySelector('[data-ch-archive]') as HTMLElement).click();
    await flush();

    const alert = harness.root.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('2 seats are in a buyer');
    expect(alert.textContent).toContain('in about 12 minutes');
    expect((harness.root.querySelector('[data-ch-archive]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the preview needs a newer server instead of faking a projection', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      channelPreview: vi.fn().mockRejectedValue(new ManageApiError(404, 'not_found')),
    }));
    harness.mode.enter();
    await flush();
    (harness.rail.querySelector('[data-ch-view="preview"]') as HTMLElement).click();
    await flush();
    expect(harness.rail.textContent).toContain('Preview needs a newer server');
    expect(harness.mode.canSelect()).toBe(false);
  });

  it('shows the real unavailable landing state for a paused audience', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      channelPreview: vi.fn().mockResolvedValue({
        available: false, unavailable: [{ channelId: 'ch_s', state: 'paused' }],
      }),
    }));
    harness.mode.enter();
    await flush();
    (harness.rail.querySelector('[data-ch-view="preview"]') as HTMLElement).click();
    await flush();
    expect(harness.rail.textContent).toContain('This private sale is not available');
    expect(harness.rail.textContent).toContain('Sponsor guests is paused');
  });
});
