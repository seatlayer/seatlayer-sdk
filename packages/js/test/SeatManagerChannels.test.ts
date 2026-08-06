import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManageApi, ManageApiError } from '../src/manageApi';
import {
  ChannelsMode,
  bucketRowsHtml,
  type ChannelsClient,
  type ChannelsModeHost,
  type ChannelsRowView,
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

  it('names only the two distribution routes that actually reach a buyer', () => {
    expect(accessLine({ intent: 'hosted_link', hasActiveGrants: true })).toBe('Buyer link · in use now');
    expect(accessLine({ intent: 'server' })).toBe('Website integration');
  });

  // 'internal' and 'none' are stored on legacy rows and read by nothing. They
  // must not resurface as a state of their own — both mean "not distributed".
  it('says the same honest thing for both dead intents', () => {
    expect(accessLine({ intent: 'internal' })).toBe('Not distributed yet');
    expect(accessLine({ intent: 'none' })).toBe('Not distributed yet');
    expect(accessLine({ intent: 'internal' })).not.toContain('Internal selling');
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
  get overviewCalls(): number;
}

function mount(
  capabilities: { view: boolean; manage: boolean },
  client = makeClient(),
  opts: {
    seatPixelSize?: number;
    sections?: Array<{ id: string; label: string }>;
    rows?: ChannelsRowView[];
  } = {},
): Harness {
  const root = document.createElement('div');
  root.className = 'slm';
  root.innerHTML = `<div class="slm-body"><div class="slm-map"><div class="slm-map-host"></div></div>
    <aside class="slm-rail"><div class="slm-railscroll"></div></aside></div>`;
  document.body.appendChild(root);
  const rail = root.querySelector('.slm-railscroll') as HTMLElement;
  const status: Record<string, ChannelSeatStatus> = { A1: 'free', A2: 'booked', S1: 'free', P1: 'free', P2: 'held' };
  const state = { selection: [] as string[], overviewCalls: 0 };
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
    sections: () => opts.sections ?? [{ id: 'sec-1', label: 'Stalls' }, { id: 'sec-2', label: 'Circle' }],
    labelsInSection: (sectionId) => (sectionId === 'sec-1' ? ['A1', 'A2'] : ['S1', 'P1', 'P2']),
    rows: () => opts.rows ?? [
      { id: 'row-a', label: 'A', sectionId: 'sec-1', sectionLabel: 'Stalls', labels: ['A1', 'A2'] },
      { id: 'row-p', label: 'P', sectionId: 'sec-2', sectionLabel: 'Circle', labels: ['P1', 'P2'] },
      { id: 'row-s', label: 'S', sectionId: 'sec-2', sectionLabel: 'Circle', labels: ['S1'] },
    ],
    categories: () => [{ key: 'std', label: 'Standard' }],
    labelsInCategory: () => ['A1'],
    sectionOfLabel: () => ({ id: 'sec-1', label: 'Stalls' }),
    worldToScreen: (point) => ({ x: point.x, y: point.y }),
    seatPixelSize: () => opts.seatPixelSize ?? 6,
    isSeatDetail: () => true,
    showSectionOverview: () => { state.overviewCalls += 1; },
    focusSection: () => {},
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
    get overviewCalls() { return state.overviewCalls; },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Express the intent to assign. The tools are disclosed, not permanent, so every
 * test that reaches for a select-by route has to say so first — which is exactly
 * what an organizer now has to do.
 */
function openAssign(harness: Harness): void {
  (harness.rail.querySelector('[data-ch-act="assign-open"]') as HTMLElement).click();
}

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
    expect(harness.rail.querySelector('[data-ch-open]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="create"]')).toBeNull();
    expect(harness.rail.querySelectorAll('[disabled]').length).toBe(0);
    expect(harness.mode.canSelect()).toBe(false);
  });

  it('offers create + per-channel management to a manage token', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    expect(harness.rail.querySelector('[data-ch-act="create"]')).not.toBeNull();
    expect(harness.rail.querySelectorAll('[data-ch-open]').length).toBe(2);
    expect(harness.mode.canSelect()).toBe(true);
    expect(harness.mode.usesMarqueeSelection()).toBe(false);
  });

  it('opens a sectioned chart in overview and makes marquee assignment explicit', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();

    expect(harness.overviewCalls).toBe(1);
    expect(harness.rail.textContent).toContain('Section overview');
    expect(harness.rail.textContent).toContain('Pan map');
    expect(harness.mode.usesMarqueeSelection()).toBe(false);

    (harness.rail.querySelector('[data-ch-map="assign"]') as HTMLElement).click();
    expect(harness.mode.usesMarqueeSelection()).toBe(true);
    expect(harness.rail.textContent).toContain('Drag across seats to select them');

    (harness.rail.querySelector('[data-ch-act="sections"]') as HTMLElement).click();
    expect(harness.overviewCalls).toBe(2);
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
    expect(rows[1].textContent).toContain('Website integration');
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

  it('closes the sheet on Apply and keeps the AUTHORITATIVE buckets behind Details', async () => {
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

    // The organizer is returned to the map they just changed — no sheet to dismiss.
    expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
    const staged = harness.root.querySelector('[data-ch="staged"]')!;
    expect(staged.textContent).toContain('Assigned');
    expect(staged.textContent).toContain('Travel Agency A');
    // 1 held + 5 not-found are the seats the server refused to move.
    expect(staged.textContent).toContain('6 skipped');
    expect(harness.root.querySelector('[aria-live="polite"]')!.textContent)
      .toContain('Assigned 2 seats to Travel Agency A; 6 skipped');

    // Details reopens the authoritative sheet, still naming the SERVER's target.
    (staged.querySelector('[data-ch-applied-details]') as HTMLElement).click();
    const dialog = harness.root.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Moved 2 seats');
    // The sixth bucket the comp does not draw, rendered because it is non-zero.
    expect(dialog.textContent).toContain('not on this map');
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

// ---------------------------------------------------------------------------
// Distribute — the two routes that actually reach a buyer
//
// The detail panel used to offer a four-value "access intent" picker. Two of the
// values (none / internal) were read by nothing at all, and a third
// (hosted_link) is the server's to set. What is left is two actions.
// ---------------------------------------------------------------------------

async function openDetail(harness: Harness, index = 0): Promise<void> {
  (harness.rail.querySelectorAll('[data-ch-open]')[index] as HTMLElement).click();
  await flush();
}

function withIntent(intent: string): ChannelsClient {
  const list = listFixture();
  list.channels[0].access = { intent: intent as 'none', hasActiveGrants: false, lastMintAt: null };
  return makeClient({ channels: vi.fn().mockResolvedValue(list) });
}

describe('ChannelsMode distribute', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('offers exactly the two working routes, and no dead-intent control', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    await openDetail(harness);

    expect(harness.rail.querySelector('[data-ch-act="link-create"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="embed-code"]')).not.toBeNull();
    // The picker and both of its dead values are gone from the surface entirely.
    expect(harness.rail.querySelector('[data-ch-intent]')).toBeNull();
    expect(harness.rail.querySelector('#slm-ch-intent')).toBeNull();
    const html = harness.rail.innerHTML;
    expect(html).not.toContain('Internal selling');
    expect(html).not.toContain('No buyer access yet');
    expect(html).not.toContain('How should buyers reach this channel');
  });

  it('renders a legacy internal channel as "not distributed", never an empty select', async () => {
    const harness = mount({ view: true, manage: true }, withIntent('internal'));
    harness.mode.enter();
    await flush();
    await openDetail(harness);

    expect(harness.rail.textContent).toContain('Not distributed yet — seats stay reserved');
    expect(harness.rail.querySelector('select')).toBeNull();
    // Both actions stay available on a legacy row — it is not a dead end.
    expect(harness.rail.querySelector('[data-ch-act="link-create"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="embed-code"]')).not.toBeNull();
  });

  it('renders an unknown legacy intent the same way rather than crashing', async () => {
    const harness = mount({ view: true, manage: true }, withIntent('none'));
    harness.mode.enter();
    await flush();
    await openDetail(harness);
    expect(harness.rail.textContent).toContain('Not distributed yet');
  });

  it('keeps the unchanged setAccessIntent API behind "Get embed code"', async () => {
    const harness = mount({ view: true, manage: true }, withIntent('none'));
    harness.mode.enter();
    await flush();
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="embed-code"]') as HTMLElement).click();
    await flush();

    expect(harness.client.setChannelAccessIntent).toHaveBeenCalledWith('ev_1', 'ch_a', 'server');
  });

  it('opens the buyer-link dialog straight from the distribute card', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    await openDetail(harness);
    (harness.rail.querySelector('[data-ch-act="link-create"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Create a buyer link for Travel Agency A');
  });

  it('explains the website route without promising a screen that does not exist', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    await openDetail(harness); // ch_a already carries intent 'server'
    expect(harness.rail.textContent).toContain("Your website's backend grants each buyer access");
    const guide = harness.rail.querySelector('a[href]') as HTMLAnchorElement;
    expect(guide.href).toBe('https://docs.seatlayer.io/server-api/channels');
  });
});

// ---------------------------------------------------------------------------
// Rail scrolling + poll hygiene — the owner's "the rail gets stuck" report
// ---------------------------------------------------------------------------

describe('ChannelsMode rail repaints', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('does not touch the rail at all when a repaint would change nothing', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    const before = harness.rail.firstElementChild;

    harness.mode.applyRealtimeHint(); // exactly what a poll tick does
    await flush();

    // Same nodes, so the scroll offset, focus and any open <select> all survive.
    expect(harness.rail.firstElementChild).toBe(before);
  });

  it('restores the scroll offset when the rail really is rewritten', async () => {
    const harness = mount({ view: true, manage: true });
    // jsdom has no layout, so scrollTop is a fixed 0 — model it as a real one.
    let scrollTop = 0;
    Object.defineProperty(harness.rail, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    harness.mode.enter();
    await flush();
    scrollTop = 260;

    harness.setSelection(['P1']); // a genuinely different rail body
    harness.mode.handleSelectionChange();

    expect(harness.rail.innerHTML).toContain('selected');
    expect(scrollTop).toBe(260);
  });
});

describe('ChannelsMode polling', () => {
  let hidden = false;
  beforeEach(() => {
    document.body.innerHTML = '';
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('skips ticks while the tab is hidden and catches up once on return', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await vi.advanceTimersByTimeAsync(1);
    const reads = () => vi.mocked(harness.client.channels).mock.calls.length;
    const initial = reads();

    hidden = true;
    await vi.advanceTimersByTimeAsync(120_000); // four ticks at the 30s cadence
    expect(reads()).toBe(initial);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(initial + 1);

    harness.mode.leave();
    // The listener goes with the mode — a left cockpit never polls again.
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(initial + 1);
  });

  it('re-walks the allocation only when the assignment version moved', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    const walks = () => vi.mocked(harness.client.channelAllocation).mock.calls.length;
    expect(walks()).toBe(1);

    harness.mode.applyRealtimeHint();
    await flush();
    expect(walks()).toBe(1); // same version — the pages cannot have changed

    vi.mocked(harness.client.channels).mockResolvedValue({ ...listFixture(), assignmentVersion: 8 });
    harness.mode.applyRealtimeHint();
    await flush();
    expect(walks()).toBe(2);
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
    (harness.rail.querySelectorAll('[data-ch-open]')[1] as HTMLElement).click();
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

  it('paints the exact preview allocation as a distinct state without square category bleed', async () => {
    const fills: string[] = [];
    const context = {
      fillStyle: '', strokeStyle: '', lineWidth: 0, globalAlpha: 1,
      setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(),
      fill: vi.fn(() => { fills.push(context.fillStyle); }), measureText: vi.fn(() => ({ width: 8 })),
      fillText: vi.fn(),
      stroke: vi.fn(), fillRect: vi.fn(),
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const harness = mount({ view: true, manage: true }, makeClient({
      // The worker's authoritative seat labels are sufficient even when an
      // older deployment omits the redundant aggregate count.
      channelPreview: vi.fn().mockResolvedValue({ available: true, eligible: ['A1'] }),
    }), { seatPixelSize: 24 });
    const map = harness.root.querySelector('.slm-map') as HTMLElement;
    vi.spyOn(map, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 180, width: 300, height: 180,
      toJSON: () => ({}),
    });

    harness.mode.enter();
    await flush();
    // In the organiser's allocation view, private inventory uses the channel
    // marker colour — not the chart category colour beneath it.
    expect(fills).toEqual(expect.arrayContaining(['#a78bfa', '#2dd4bf']));
    expect(context.arc).toHaveBeenCalled();
    // Inspect mode legitimately paints the administrative allocation. The
    // assertions below are specifically about the buyer-preview repaint.
    context.fillRect.mockClear();
    context.arc.mockClear();
    context.fill.mockClear();
    fills.length = 0;
    (harness.rail.querySelector('[data-ch-view="preview"]') as HTMLElement).click();
    await flush();
    await flush();

    expect(harness.rail.textContent).toContain('1 seat is available now');
    expect(fills).toEqual(expect.arrayContaining(['#6e7bff', '#303846']));
    expect(context.arc).toHaveBeenCalled();
    expect(context.fillText).toHaveBeenCalledWith('A1', expect.any(Number), expect.any(Number));
    expect(context.fillRect).not.toHaveBeenCalled();
    getContext.mockRestore();
  });
});

/**
 * Assignment tools. These were the cockpit's biggest discoverability hole: the
 * section / category / seat-list choosers only existed inside the selection
 * rail, which nothing reached until seats were already selected by hand.
 */
describe('ChannelsMode assignment tools', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('leads with the CHANNELS — no tools until the organizer asks to assign', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();

    // The panel opens on the thing the organizer came for.
    const html = harness.rail.innerHTML;
    expect(html.indexOf('Sales channels')).toBeLessThan(html.indexOf('assign-open'));
    expect(harness.rail.querySelector('[data-ch-target]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="pick-sections"]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="drag-select"]')).toBeNull();
    // …but the way in is a plain-language control, not a hidden gesture.
    const entry = harness.rail.querySelector('[data-ch-act="assign-open"]') as HTMLElement;
    expect(entry).not.toBeNull();
    expect(entry.textContent).toContain('Assign seats to a channel');
    expect(entry.getAttribute('aria-expanded')).toBe('false');
  });

  it('discloses the destination and every select-by route once assigning starts', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    openAssign(harness);

    expect(harness.rail.querySelector('[data-ch-target]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="pick-sections"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="pick-rows"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="drag-select"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="pick-category"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="seatlist"]')).not.toBeNull();
    // The channel list is still above them — disclosure never buries the list.
    const html = harness.rail.innerHTML;
    expect(html.indexOf('Travel Agency A')).toBeLessThan(html.indexOf('data-ch-target'));
  });

  it('closes back down and disarms the marquee, never leaving a hidden mode on', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    (harness.rail.querySelector('[data-ch-act="drag-select"]') as HTMLElement).click();
    expect(harness.mode.usesMarqueeSelection()).toBe(true);

    (harness.rail.querySelector('[data-ch-act="assign-close"]') as HTMLElement).click();

    expect(harness.rail.querySelector('[data-ch-target]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="assign-open"]')).not.toBeNull();
    expect(harness.mode.usesMarqueeSelection()).toBe(false);
  });

  it('opens the tools from the map segment too, so the two routes cannot disagree', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    expect(harness.rail.querySelector('[data-ch-target]')).toBeNull();

    (harness.rail.querySelector('[data-ch-map="assign"]') as HTMLElement).click();

    expect(harness.mode.usesMarqueeSelection()).toBe(true);
    expect(harness.rail.querySelector('[data-ch-target]')).not.toBeNull();
  });

  it('keeps the tools open after a selection is cleared, not back behind the door', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1']);
    harness.mode.handleSelectionChange();
    expect(harness.rail.querySelector('[data-ch-target]')).not.toBeNull();

    (harness.rail.querySelector('[data-ch-act="discard"]') as HTMLElement).click();
    harness.mode.handleSelectionChange();

    expect(harness.rail.querySelector('[data-ch-target]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="assign-open"]')).toBeNull();
  });

  it('keeps the same tools once a selection exists', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1', 'S1']);
    harness.mode.handleSelectionChange();

    expect(harness.rail.textContent).toContain('2');
    expect(harness.rail.querySelector('[data-ch-act="pick-rows"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-target]')).not.toBeNull();
  });

  it('shows NO assignment tools to a view-only token', async () => {
    const harness = mount({ view: true, manage: false });
    harness.mode.enter();
    await flush();

    expect(harness.rail.querySelector('[data-ch-act="pick-sections"]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-target]')).toBeNull();
  });

  it('hides a route the chart cannot serve rather than opening an empty chooser', async () => {
    const harness = mount({ view: true, manage: true }, makeClient(), { sections: [], rows: [] });
    harness.mode.enter();
    await flush();
    openAssign(harness);

    expect(harness.rail.querySelector('[data-ch-act="pick-sections"]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-act="pick-rows"]')).toBeNull();
    // Drag box needs no chart structure at all, so it is always offered.
    expect(harness.rail.querySelector('[data-ch-act="drag-select"]')).not.toBeNull();
  });

  it('arms the marquee — Drag box is a map intent, not a dialog', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    expect(harness.mode.usesMarqueeSelection()).toBe(false);

    (harness.rail.querySelector('[data-ch-act="drag-select"]') as HTMLElement).click();

    expect(harness.mode.usesMarqueeSelection()).toBe(true);
    expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
    // The armed state is visible, not silent.
    expect((harness.rail.querySelector('[data-ch-act="drag-select"]') as HTMLElement).className)
      .not.toContain('ghost');
  });
});

describe('ChannelsMode scope chooser', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('ADDS whole sections to the existing selection instead of replacing it', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1']);
    harness.mode.handleSelectionChange();
    (harness.rail.querySelector('[data-ch-act="pick-sections"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    const confirm = dialog.querySelector('[data-ch-add-scope]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    (dialog.querySelector('[data-ch-scope-id="sec-1"]') as HTMLElement).click();
    expect(confirm.textContent).toContain('Add 2 seats');

    confirm.click();
    // P1 survives — a chooser that discarded a marquee would be a trap.
    expect(harness.selection).toEqual(['P1', 'A1', 'A2']);
    expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps rows collapsed under their section and expands one on request', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    (harness.rail.querySelector('[data-ch-act="pick-rows"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll('[data-ch-scope-group]').length).toBe(2);
    expect(dialog.querySelector('[data-ch-scope-id="row-a"]')).toBeNull();

    (dialog.querySelector('[data-ch-scope-toggle="0"]') as HTMLElement).click();
    expect(dialog.querySelector('[data-ch-scope-id="row-a"]')).not.toBeNull();
  });

  it('selects every row in a section from one tri-state group checkbox', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    (harness.rail.querySelector('[data-ch-act="pick-rows"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    // Circle holds rows P (2 seats) and S (1 seat).
    (dialog.querySelector('[data-ch-scope-group="1"]') as HTMLElement).click();
    expect(dialog.querySelector('[data-ch-scope-group="1"]')!.getAttribute('aria-checked')).toBe('true');
    const confirm = dialog.querySelector('[data-ch-add-scope]') as HTMLButtonElement;
    expect(confirm.textContent).toContain('Add 3 seats');

    confirm.click();
    expect(harness.selection).toEqual(['P1', 'P2', 'S1']);
  });

  it('searches across every row without expanding a section by hand', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    (harness.rail.querySelector('[data-ch-act="pick-rows"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    const search = dialog.querySelector('[data-ch-scope-search]') as HTMLInputElement;
    search.value = 'stalls';
    search.dispatchEvent(new Event('input'));

    expect(dialog.querySelector('[data-ch-scope-id="row-a"]')).not.toBeNull();
    expect(dialog.querySelector('[data-ch-scope-id="row-p"]')).toBeNull();
    expect(dialog.textContent).toContain('matching rows');
  });

  it('says so plainly when nothing matches the search', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    (harness.rail.querySelector('[data-ch-act="pick-rows"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    const search = dialog.querySelector('[data-ch-scope-search]') as HTMLInputElement;
    search.value = 'balcony';
    search.dispatchEvent(new Event('input'));

    expect(dialog.textContent).toContain('No sections or rows match');
  });

  it('drops a row that has no selectable seats rather than offering "Add 0 seats"', async () => {
    const harness = mount({ view: true, manage: true }, makeClient(), {
      rows: [
        { id: 'row-a', label: 'A', sectionId: 'sec-1', sectionLabel: 'Stalls', labels: ['A1'] },
        { id: 'row-x', label: 'X', sectionId: 'sec-1', sectionLabel: 'Stalls', labels: [] },
      ],
    });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    (harness.rail.querySelector('[data-ch-act="pick-rows"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    (dialog.querySelector('[data-ch-scope-toggle="0"]') as HTMLElement).click();
    expect(dialog.querySelector('[data-ch-scope-id="row-a"]')).not.toBeNull();
    expect(dialog.querySelector('[data-ch-scope-id="row-x"]')).toBeNull();
  });

  it('refuses a scope selection that would exceed the one-Apply ceiling', async () => {
    const huge = Array.from({ length: 6_000 }, (_, index) => `H${index}`);
    const harness = mount({ view: true, manage: true }, makeClient(), {
      rows: [{ id: 'row-h', label: 'H', sectionId: 'sec-1', sectionLabel: 'Stalls', labels: huge }],
    });
    harness.mode.enter();
    await flush();
    openAssign(harness);
    (harness.rail.querySelector('[data-ch-act="pick-rows"]') as HTMLElement).click();

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    (dialog.querySelector('[data-ch-scope-group="0"]') as HTMLElement).click();
    const confirm = dialog.querySelector('[data-ch-add-scope]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain('Maximum 5,000 seats');
    expect(dialog.querySelector('[data-ch-error]')!.textContent).toContain('Choose fewer rows or sections');

    confirm.click();
    expect(harness.selection).toEqual([]);
  });
});

/**
 * The one-Apply ceiling. It is stated everywhere the organizer could commit,
 * so it is never discovered as a request that dies halfway.
 */
describe('ChannelsMode assignment ceiling', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('blocks Review from both the staged bar and the rail, and says the limit', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    harness.setSelection(Array.from({ length: 5_001 }, (_, index) => `H${index}`));
    harness.mode.handleSelectionChange();

    const railReview = harness.rail.querySelector('[data-ch-act="review"]') as HTMLButtonElement;
    expect(railReview.disabled).toBe(true);
    expect(harness.rail.textContent).toContain('too large to apply at once');

    const stagedReview = harness.root
      .querySelector('[data-ch="staged"] [data-ch-act="review"]') as HTMLButtonElement;
    expect(stagedReview.disabled).toBe(true);
    expect(stagedReview.textContent).toContain('Maximum 5,000 seats');
  });

  // The sheet reads the LIVE selection, so a selection that grows while the
  // review is open must be caught at the Apply itself, not only in the markup.
  it('never sends an over-sized Apply to the server', async () => {
    const apply = vi.fn();
    const harness = mount({ view: true, manage: true }, makeClient({ applyChannelAssignment: apply }));
    harness.mode.enter();
    await flush();
    harness.setSelection(['P1', 'S1']);
    harness.mode.handleSelectionChange();
    (harness.rail.querySelector('[data-ch-act="review"]') as HTMLElement).click();

    harness.setSelection(Array.from({ length: 5_001 }, (_, index) => `H${index}`));
    (harness.root.querySelector('[data-ch-apply]') as HTMLElement).click();
    await flush();

    expect(apply).not.toHaveBeenCalled();
    expect(harness.root.querySelector('[data-ch-error]')!.textContent)
      .toContain('at most 5,000 seats');
  });
});

// ---------------------------------------------------------------------------
// The row/menu interaction contract: the ROW is the door, ⋯ is everything else.
// ---------------------------------------------------------------------------

function channelRow(harness: Harness, channelId: string): HTMLElement {
  return harness.rail.querySelector(`[data-ch-open="${channelId}"]`) as HTMLElement;
}

describe('ChannelsMode channel row', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('opens the channel from anywhere on the row, not just a hidden ⋯', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();

    // Clicking the NAME — the part an organizer actually aims at — opens it.
    (channelRow(harness, 'ch_a').querySelector('.slm-ch-name') as HTMLElement).click();
    await flush();

    expect(harness.rail.textContent).toContain('Channel · Travel Agency A');
    expect(harness.rail.querySelector('[data-ch-act="back"]')).not.toBeNull();
  });

  it('is a real control: role, tab stop, and both activation keys', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    const row = channelRow(harness, 'ch_a');

    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('aria-label')).toBe('Open Travel Agency A');
    expect(row.className).toContain('open'); // the hover/focus affordance is on

    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(harness.rail.textContent).toContain('Channel · Travel Agency A');

    (harness.rail.querySelector('[data-ch-act="back"]') as HTMLElement).click();
    channelRow(harness, 'ch_a')
      .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flush();
    expect(harness.rail.textContent).toContain('Channel · Travel Agency A');
  });

  it('⋯ opens the actions menu and does NOT also open the channel', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    const more = harness.rail.querySelector('[data-ch-menu="ch_a"]') as HTMLElement;
    expect(more.getAttribute('aria-label')).toContain('More actions');

    more.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    const dialog = harness.root.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Rename');
    expect(dialog.textContent).toContain('Archive');
    // The row underneath never fired: the rail is still the list.
    expect(harness.rail.textContent).not.toContain('Channel · Travel Agency A');
    expect(harness.rail.querySelector('[data-ch-act="back"]')).toBeNull();
  });

  it('keeps the destructive actions behind the menu, and opening behind the row', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    (harness.rail.querySelector('[data-ch-menu="ch_a"]') as HTMLElement)
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const dialog = harness.root.querySelector('[role="dialog"]')!;
    (dialog.querySelector('[data-ch-menu-act="archive"]') as HTMLElement).click();

    expect(harness.root.querySelector('[role="dialog"]')!.textContent)
      .toContain('Archive Travel Agency A');
  });

  it('gives a view-only token a card, never a door it cannot use', async () => {
    const harness = mount({ view: true, manage: false });
    harness.mode.enter();
    await flush();

    expect(harness.rail.querySelector('[data-ch-open]')).toBeNull();
    expect(harness.rail.querySelector('[data-ch-menu]')).toBeNull();
    expect(harness.rail.querySelector('[role="button"]')).toBeNull();
  });

  it('never makes Public sale look openable — it has no detail panel', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();

    const rows = harness.rail.querySelectorAll('.slm-ch-row');
    expect(rows[0].className).toContain('public');
    expect(rows[0].getAttribute('role')).toBeNull();
    expect(rows[0].hasAttribute('data-ch-open')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Loading / empty / error are three DIFFERENT answers on every channels surface.
// ---------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ChannelsMode honest states', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('shows a loading state, then the list — never a flash of empty', async () => {
    const gate = deferred<ChannelListResult>();
    const harness = mount({ view: true, manage: true }, makeClient({
      channels: vi.fn().mockReturnValue(gate.promise),
    }));
    harness.mode.enter();

    expect(harness.rail.querySelector('[data-ch-state="list-loading"]')).not.toBeNull();
    expect(harness.rail.textContent).toContain('Loading channels and allocations…');
    expect(harness.rail.querySelector('[data-ch-act="create"]')).toBeNull();

    gate.resolve(listFixture());
    await flush();

    expect(harness.rail.querySelector('[data-ch-state="list-loading"]')).toBeNull();
    expect(harness.rail.textContent).toContain('Travel Agency A');
  });

  it('shows a FAILED read as a failure with a retry, never as an empty list', async () => {
    const channels = vi.fn().mockRejectedValueOnce(new ManageApiError(500, 'boom', 'server_error'));
    const harness = mount({ view: true, manage: true }, makeClient({ channels }));
    harness.mode.enter();
    await flush();

    const error = harness.rail.querySelector('[data-ch-state="list-error"]') as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain("Couldn't load sales channels");
    // The distinction the owner asked for, in words: a failure is not "nothing".
    expect(error.textContent).toContain('we could not read them');
    expect(harness.rail.querySelector('[data-ch-state="list-empty"]')).toBeNull();

    channels.mockResolvedValue(listFixture());
    (harness.rail.querySelector('[data-ch-act="retry"]') as HTMLElement).click();
    await flush();

    expect(harness.rail.querySelector('[data-ch-state="list-error"]')).toBeNull();
    expect(harness.rail.textContent).toContain('Travel Agency A');
  });

  it('says an event with no private channel is on public sale, and offers the fix', async () => {
    const list = listFixture();
    list.channels = [];
    const harness = mount({ view: true, manage: true }, makeClient({
      channels: vi.fn().mockResolvedValue(list),
    }));
    harness.mode.enter();
    await flush();

    expect(harness.rail.querySelector('[data-ch-state="list-empty"]')!.textContent)
      .toContain('every seat is on public sale');
    expect(harness.rail.querySelector('[data-ch-act="create"]')).not.toBeNull();
  });

  it('paints the buyer-link section as loading before the read lands', async () => {
    const gate = deferred<{ links: [] }>();
    const harness = mount({ view: true, manage: true }, makeClient({
      accessLinks: vi.fn().mockReturnValue(gate.promise),
    }));
    harness.mode.enter();
    await flush();
    channelRow(harness, 'ch_a').click();

    // The panel is already open — the links slot says it is working, not empty.
    expect(harness.rail.textContent).toContain('Channel · Travel Agency A');
    expect(harness.rail.querySelector('[data-ch-state="links-loading"]')).not.toBeNull();

    gate.resolve({ links: [] });
    await flush();
    await flush();
    expect(harness.rail.querySelector('[data-ch-state="links-loading"]')).toBeNull();
  });

  it('distinguishes a failed link read from a channel with no links', async () => {
    const harness = mount({ view: true, manage: true }, makeClient({
      accessLinks: vi.fn().mockRejectedValue(new ManageApiError(500, 'boom', 'server_error')),
    }));
    harness.mode.enter();
    await flush();
    channelRow(harness, 'ch_a').click();
    await flush();
    await flush();

    const error = harness.rail.querySelector('[data-ch-state="links-error"]') as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.textContent).toContain('failed read, not an empty list');
    expect(harness.rail.querySelector('[data-ch-act="link-reload"]')).not.toBeNull();
  });

  it('moves the buyer preview loading → error, with a retry that succeeds', async () => {
    const gate = deferred<never>();
    const channelPreview = vi.fn().mockReturnValueOnce(gate.promise);
    const harness = mount({ view: true, manage: true }, makeClient({ channelPreview }));
    harness.mode.enter();
    await flush();

    (harness.rail.querySelector('[data-ch-view="preview"]') as HTMLElement).click();
    expect(harness.rail.querySelector('[data-ch-state="preview-loading"]')).not.toBeNull();
    expect(harness.rail.querySelector('[data-ch-state="preview-error"]')).toBeNull();

    gate.reject(new ManageApiError(500, 'boom', 'server_error'));
    await flush();

    const error = harness.rail.querySelector('[data-ch-state="preview-error"]') as HTMLElement;
    expect(error).not.toBeNull();
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('the simulation itself failed to load');
    // A 500 is NOT "your server is too old" — that stays its own state.
    expect(harness.rail.querySelector('[data-ch-state="preview-unsupported"]')).toBeNull();

    channelPreview.mockResolvedValue({ available: true, eligible: ['A1'], counts: { eligible: 1 } });
    (harness.rail.querySelector('[data-ch-act="preview-retry"]') as HTMLElement).click();
    await flush();

    expect(harness.rail.querySelector('[data-ch-state="preview-error"]')).toBeNull();
    expect(harness.rail.textContent).toContain('1 seat is available now');
  });

  it('explains a channel that disappeared instead of silently bouncing to the list', async () => {
    const harness = mount({ view: true, manage: true });
    harness.mode.enter();
    await flush();
    channelRow(harness, 'ch_a').click();
    await flush();

    const gone = listFixture();
    gone.channels = gone.channels.filter((channel) => channel.id !== 'ch_a');
    (harness.client.channels as ReturnType<typeof vi.fn>).mockResolvedValue(gone);
    harness.mode.applyRealtimeHint();
    await flush();

    expect(harness.rail.querySelector('[data-ch-state="detail-gone"]')!.textContent)
      .toContain('no longer on this event');
    expect(harness.rail.querySelector('[data-ch-act="back"]')).not.toBeNull();
  });
});
