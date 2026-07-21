import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeatingChartOptions } from '../src/SeatingChart';
import { BRIDGE_COMMANDS, BRIDGE_EVENTS, startBridge, type BridgeChart, type BridgeHandle } from '../src/bridge/host';
import type { Envelope } from '../src/bridge/protocol';
import type { TransportName } from '../src/bridge/transport';

/** A `SeatingChart` double: every bridged method, none of the renderer. */
function fakeChart() {
  return {
    render: vi.fn(async () => undefined),
    getMode: vi.fn((): 'live' | 'test' | null => 'live'),
    hold: vi.fn(async () => ({ holdId: 'h1', expiresAt: 123 })),
    resumeHold: vi.fn(async () => ({ holdId: 'h1', expiresAt: 123 })),
    extendHold: vi.fn(async () => ({ holdId: 'h1', expiresAt: 456 })),
    release: vi.fn(async () => undefined),
    releaseLabels: vi.fn(async () => true),
    bestAvailable: vi.fn(async () => ({ holdId: 'h2', expiresAt: 9, labels: ['A-1'] })),
    holdGA: vi.fn(async () => ({ holdId: 'h3', expiresAt: 9 })),
    setSeatTier: vi.fn(),
    getSelection: vi.fn(() => [{ id: 's1', label: 'A-1' }]),
    getCurrentHold: vi.fn(() => ({ holdId: 'h1', expiresAt: 123 })),
    getGAAreas: vi.fn(() => [{ id: 'ga1' }]),
    getFloors: vi.fn(() => [{ id: 'f1', name: 'Floor 1' }]),
    setFloor: vi.fn(),
    setColorblindSafe: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomToFit: vi.fn(),
    destroy: vi.fn(),
  };
}

type FakeChart = ReturnType<typeof fakeChart>;
type BridgeWindow = Window & { __slBridge?: { recv(input: unknown): void } };

interface Harness {
  sent: Envelope[];
  win: BridgeWindow;
  chart: FakeChart;
  created: SeatingChartOptions[];
  handle: BridgeHandle;
  /** Deliver a host→web frame through the installed receiver. */
  recv(envelope: Record<string, unknown>): void;
  /** Run any coalesced-event flush that was scheduled. */
  frame(): void;
  /** Envelopes of one kind, in send order. */
  ofKind(kind: Envelope['k']): Envelope[];
  last(kind: Envelope['k']): Envelope | undefined;
}

let harnesses: Harness[] = [];

function makeHarness(
  overrides: Partial<Parameters<typeof startBridge>[0]> = {},
  transportName: TransportName = 'ios',
): Harness {
  const sent: Envelope[] = [];
  const win = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    document: window.document,
  } as unknown as BridgeWindow;
  const chart = fakeChart();
  const created: SeatingChartOptions[] = [];
  const frames: Array<() => void> = [];

  const handle = startBridge({
    win,
    bundle: '0.25.0-test',
    transport: { name: transportName, send: (envelope) => sent.push(envelope) },
    createChart: (opts) => {
      created.push(opts);
      return chart as unknown as BridgeChart;
    },
    schedule: (flush) => frames.push(flush),
    container: document.createElement('div'),
    ...overrides,
  });

  const h: Harness = {
    sent,
    win,
    chart,
    created,
    handle,
    recv: (envelope) => win.__slBridge!.recv(envelope),
    frame: () => frames.splice(0).forEach((flush) => flush()),
    ofKind: (kind) => sent.filter((envelope) => envelope.k === kind),
    last: (kind) => [...sent].reverse().find((envelope) => envelope.k === kind),
  };
  harnesses.push(h);
  return h;
}

/** Let the async handshake / command chains resolve. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/** Boot a harness all the way to `sys.ready`. */
async function ready(overrides?: Partial<Parameters<typeof startBridge>[0]>): Promise<Harness> {
  const h = makeHarness(overrides);
  h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_1' } } });
  await settle();
  return h;
}

/** Send a cmd and return its single reply. */
async function cmd(h: Harness, t: string, p?: unknown, id = `c-${t}`): Promise<Envelope> {
  const before = h.sent.length;
  h.recv({ sl: 1, k: 'cmd', id, t, ...(p !== undefined ? { p } : {}) });
  await settle();
  const replies = h.sent.slice(before).filter((e) => e.k === 'res' || e.k === 'err');
  expect(replies).toHaveLength(1); // exactly one reply per cmd, always
  return replies[0];
}

beforeEach(() => {
  harnesses = [];
});

afterEach(() => {
  for (const h of harnesses) h.handle.close();
  harnesses = [];
  vi.useRealTimers();
});

describe('bridge host — handshake', () => {
  it('opens with hello advertising the protocol range, commands and events', () => {
    const h = makeHarness();
    const hello = h.sent[0];
    expect(hello.k).toBe('hello');
    expect(hello.p).toMatchObject({ bundle: '0.25.0-test', protocol: { min: 1, max: 1 } });
    const payload = hello.p as { commands: string[]; events: string[]; capabilities: string[] };
    expect(payload.commands).toEqual(BRIDGE_COMMANDS);
    expect(payload.events).toEqual([...BRIDGE_EVENTS]);
    expect(payload.capabilities.length).toBeGreaterThan(0);
    // Nothing is rendered before the host replies.
    expect(h.created).toHaveLength(0);
  });

  it('builds the chart and emits sys.ready after init', async () => {
    const h = await ready();
    expect(h.chart.render).toHaveBeenCalledTimes(1);
    const evt = h.last('evt')!;
    expect(evt.t).toBe('sys.ready');
    expect(evt.p).toEqual({ protocol: 1, mode: 'live', transport: 'ios', chart: { event: 'ev_1' } });
    expect(h.handle.protocol).toBe(1);
  });

  // A native host that cannot tell a test event from a live one can ship a
  // build that looks live and books nothing. sys.ready must carry the mode.
  it('reports mode:test in sys.ready when the served event is a test event', async () => {
    const h = makeHarness();
    h.chart.getMode.mockReturnValue('test');
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_test' } } });
    await settle();

    expect(h.last('evt')).toMatchObject({ t: 'sys.ready', p: { mode: 'test' } });
    // Read AFTER render, so the server-supplied mode is available.
    expect(h.chart.getMode.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.chart.render.mock.invocationCallOrder[0],
    );
  });

  it('reports mode:live for a live event', async () => {
    const h = makeHarness();
    h.chart.getMode.mockReturnValue('live');
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_live' } } });
    await settle();
    expect(h.last('evt')).toMatchObject({ t: 'sys.ready', p: { mode: 'live' } });
  });

  it('falls back to live when the chart reports no mode', async () => {
    const h = makeHarness();
    h.chart.getMode.mockReturnValue(null);
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_1' } } });
    await settle();
    expect(h.last('evt')).toMatchObject({ t: 'sys.ready', p: { mode: 'live' } });
  });

  it('reports the detected transport in sys.ready, separately from the mode', async () => {
    for (const name of ['ios', 'android', 'flutter', 'rn', 'frame', 'none'] as const) {
      const h = makeHarness({}, name);
      h.chart.getMode.mockReturnValue('test');
      h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_1' } } });
      await settle();

      // The two axes are independent: a test event on any shim.
      expect(h.last('evt')!.p).toMatchObject({ mode: 'test', transport: name });
      expect(h.handle.transport).toBe(name);
    }
  });

  it('passes host config + chrome through to the chart options', async () => {
    const h = makeHarness();
    h.recv({
      sl: 1,
      k: 'init',
      t: 'init',
      p: {
        protocol: 1,
        chrome: { seatTooltip: false },
        config: { event: 'ev_9', apiBase: 'https://api.test', locale: 'de', maxSelection: 4 },
      },
    });
    await settle();
    expect(h.created[0]).toMatchObject({
      event: 'ev_9',
      apiBase: 'https://api.test',
      locale: 'de',
      maxSelection: 4,
      seatTooltip: false,
    });
  });

  it('ignores a duplicate init', async () => {
    const h = await ready();
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_2' } } });
    await settle();
    expect(h.created).toHaveLength(1);
  });

  it('emits sys.error host_timeout and renders nothing when init never arrives', async () => {
    vi.useFakeTimers();
    const h = makeHarness({ timeoutMs: 10_000 });
    vi.advanceTimersByTime(9_999);
    expect(h.ofKind('evt')).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const evt = h.last('evt')!;
    expect(evt.t).toBe('sys.error');
    expect(evt.p).toMatchObject({ code: 'host_timeout' });
    expect(h.created).toHaveLength(0);
    expect(h.chart.render).not.toHaveBeenCalled();
  });

  it('does not fire the timeout once init has landed', async () => {
    vi.useFakeTimers();
    const h = makeHarness({ timeoutMs: 10_000 });
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_1' } } });
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(h.ofKind('evt').filter((e) => e.t === 'sys.error')).toHaveLength(0);
  });

  it('reports a render failure as sys.error instead of throwing', async () => {
    const h = makeHarness();
    h.chart.render.mockRejectedValueOnce(new Error('canvas unavailable'));
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: { event: 'ev_1' } } });
    await settle();
    expect(h.last('evt')).toMatchObject({ t: 'sys.error', p: { code: 'render_failed', message: 'canvas unavailable' } });
  });

  it('rejects an init with no usable event key', async () => {
    const h = makeHarness();
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 1, config: {} } });
    await settle();
    expect(h.last('evt')).toMatchObject({ t: 'sys.error', p: { code: 'bad_payload' } });
    expect(h.created).toHaveLength(0);
  });
});

describe('bridge host — version negotiation', () => {
  // Old host, current bundle: the host pins v1 and everything works.
  it('accepts an old host that pins the lowest shared revision', async () => {
    const h = await ready();
    expect(h.handle.protocol).toBe(1);
    expect(h.last('evt')!.t).toBe('sys.ready');
  });

  it('accepts a host range that overlaps this bundle', async () => {
    const h = makeHarness();
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: { min: 1, max: 4 }, config: { event: 'ev_1' } } });
    await settle();
    expect(h.handle.protocol).toBe(1);
    expect(h.last('evt')!.t).toBe('sys.ready');
  });

  // New host, old bundle: no overlap → render nothing.
  it('emits sys.incompatible and renders nothing when the ranges do not overlap', async () => {
    const h = makeHarness();
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: { min: 2, max: 4 }, config: { event: 'ev_1' } } });
    await settle();

    const evt = h.last('evt')!;
    expect(evt.t).toBe('sys.incompatible');
    expect(evt.p).toMatchObject({ host: { min: 2, max: 4 }, web: { min: 1, max: 1 } });
    expect(h.created).toHaveLength(0);
    expect(h.chart.render).not.toHaveBeenCalled();
    expect(h.handle.protocol).toBeNull();
  });

  it('treats a malformed protocol field as incompatible', async () => {
    const h = makeHarness();
    h.recv({ sl: 1, k: 'init', t: 'init', p: { protocol: 'v1', config: { event: 'ev_1' } } });
    await settle();
    expect(h.last('evt')).toMatchObject({ t: 'sys.incompatible', p: { code: 'bad_payload' } });
    expect(h.created).toHaveLength(0);
  });
});

describe('bridge host — commands', () => {
  it('replies to every void command with an empty, correlated res', async () => {
    const h = await ready();
    for (const t of ['zoomIn', 'zoomOut', 'zoomToFit'] as const) {
      const reply = await cmd(h, t, undefined, `id-${t}`);
      expect(reply).toEqual({ sl: 1, k: 'res', id: `id-${t}`, t, p: {} });
      expect(h.chart[t]).toHaveBeenCalledTimes(1);
    }
  });

  it('correlates concurrent commands by id', async () => {
    const h = await ready();
    let resolveHold: ((value: { holdId: string; expiresAt: number }) => void) | null = null;
    h.chart.hold.mockImplementationOnce(
      () => new Promise((resolve) => { resolveHold = resolve; }),
    );

    h.recv({ sl: 1, k: 'cmd', id: 'slow', t: 'hold' });
    h.recv({ sl: 1, k: 'cmd', id: 'fast', t: 'getFloors' });
    await settle();

    // The fast, synchronous command answers first — with its OWN id.
    expect(h.last('res')).toMatchObject({ id: 'fast', t: 'getFloors' });
    resolveHold!({ holdId: 'hX', expiresAt: 1 });
    await settle();
    expect(h.last('res')).toMatchObject({ id: 'slow', t: 'hold', p: { hold: { holdId: 'hX' } } });
  });

  it('maps the v0.1 command set onto the SeatingChart methods', async () => {
    const h = await ready();

    expect(await cmd(h, 'hold', { ttlMs: 5000 })).toMatchObject({ k: 'res', p: { hold: { holdId: 'h1' } } });
    expect(h.chart.hold).toHaveBeenCalledWith({ ttlMs: 5000 });

    await cmd(h, 'resumeHold', { holdId: 'h9' });
    expect(h.chart.resumeHold).toHaveBeenCalledWith('h9');

    await cmd(h, 'extendHold', { ttlMs: 60_000 });
    expect(h.chart.extendHold).toHaveBeenCalledWith(60_000);

    expect(await cmd(h, 'release')).toMatchObject({ k: 'res', p: {} });
    expect(h.chart.release).toHaveBeenCalled();

    expect(await cmd(h, 'releaseLabels', { labels: ['A-1', 'A-2'] })).toMatchObject({ p: { released: true } });
    expect(h.chart.releaseLabels).toHaveBeenCalledWith(['A-1', 'A-2']);

    await cmd(h, 'bestAvailable', { qty: 3, categoryKey: 'vip' });
    expect(h.chart.bestAvailable).toHaveBeenCalledWith(3, 'vip');

    await cmd(h, 'holdGA', { areaId: 'ga1', qty: 2, tierId: 'child' });
    expect(h.chart.holdGA).toHaveBeenCalledWith('ga1', 2, { tierId: 'child', ttlMs: undefined });

    await cmd(h, 'setSeatTier', { seatId: 's1', tierId: null });
    expect(h.chart.setSeatTier).toHaveBeenCalledWith('s1', null);

    expect(await cmd(h, 'getSelection')).toMatchObject({ p: { seats: [{ id: 's1', label: 'A-1' }] } });
    expect(await cmd(h, 'getCurrentHold')).toMatchObject({ p: { hold: { holdId: 'h1' } } });
    expect(await cmd(h, 'getGAAreas')).toMatchObject({ p: { areas: [{ id: 'ga1' }] } });
    expect(await cmd(h, 'getFloors')).toMatchObject({ p: { floors: [{ id: 'f1', name: 'Floor 1' }] } });

    await cmd(h, 'setFloor', { floorId: 'f2' });
    expect(h.chart.setFloor).toHaveBeenCalledWith('f2');

    await cmd(h, 'setColorblindSafe', { on: true });
    expect(h.chart.setColorblindSafe).toHaveBeenCalledWith(true);
  });

  it('answers an unknown command with unsupported_command, never a throw', async () => {
    const h = await ready();
    const reply = await cmd(h, 'teleportBuyer', { x: 1 });
    expect(reply.k).toBe('err');
    expect(reply.p).toMatchObject({ code: 'unsupported_command' });
    expect(reply.id).toBe('c-teleportBuyer');
  });

  it('rejects an unknown command even before the chart is ready', async () => {
    const h = makeHarness();
    const reply = await cmd(h, 'somethingNew');
    expect(reply.p).toMatchObject({ code: 'unsupported_command' });
  });

  it('answers a known command with not_ready before the handshake completes', async () => {
    const h = makeHarness();
    const reply = await cmd(h, 'zoomIn');
    expect(reply.k).toBe('err');
    expect(reply.p).toMatchObject({ code: 'not_ready' });
    expect(h.chart.zoomIn).not.toHaveBeenCalled();
  });

  it('validates payloads instead of letting a TypeError escape', async () => {
    const h = await ready();
    for (const [t, p] of [
      ['setFloor', {}],
      ['setFloor', { floorId: 7 }],
      ['resumeHold', { holdId: '' }],
      ['bestAvailable', { qty: 'three' }],
      ['releaseLabels', { labels: 'A-1' }],
      ['setColorblindSafe', { on: 'yes' }],
      ['setSeatTier', { seatId: 's1', tierId: 7 }],
      ['hold', 'not-an-object'],
    ] as Array<[string, unknown]>) {
      const reply = await cmd(h, t, p, `bad-${t}-${JSON.stringify(p)}`);
      expect(reply.k, `${t} ${JSON.stringify(p)}`).toBe('err');
      expect(reply.p).toMatchObject({ code: 'bad_payload' });
    }
    expect(h.chart.setFloor).not.toHaveBeenCalled();
  });

  it('converts a rejected chart call into an err, passing the API code through', async () => {
    const h = await ready();
    h.chart.hold.mockRejectedValueOnce(
      Object.assign(new Error('seats gone'), { code: 'sold_out', status: 409, conflicts: [{ label: 'A-1', status: 'booked' }] }),
    );
    const reply = await cmd(h, 'hold');
    expect(reply.k).toBe('err');
    expect(reply.p).toMatchObject({
      code: 'sold_out',
      message: 'seats gone',
      details: { status: 409, conflicts: [{ label: 'A-1', status: 'booked' }] },
    });
  });

  it('converts a synchronous throw into an err', async () => {
    const h = await ready();
    h.chart.zoomIn.mockImplementationOnce(() => {
      throw new Error('renderer detached');
    });
    const reply = await cmd(h, 'zoomIn');
    expect(reply).toMatchObject({ k: 'err', p: { code: 'command_failed', message: 'renderer detached' } });
  });

  it('locks out commands after destroy', async () => {
    const h = await ready();
    expect(await cmd(h, 'destroy')).toMatchObject({ k: 'res', p: {} });
    expect(h.chart.destroy).toHaveBeenCalledTimes(1);

    const reply = await cmd(h, 'zoomIn');
    expect(reply).toMatchObject({ k: 'err', p: { code: 'destroyed' } });
    expect(h.chart.zoomIn).not.toHaveBeenCalled();
  });

  it('reports a cmd with no id as a system error rather than replying blind', async () => {
    const h = await ready();
    const before = h.sent.length;
    h.recv({ sl: 1, k: 'cmd', t: 'zoomIn' });
    await settle();
    const after = h.sent.slice(before);
    expect(after.filter((e) => e.k === 'res' || e.k === 'err')).toHaveLength(0);
    expect(after[0]).toMatchObject({ k: 'evt', t: 'sys.error', p: { code: 'bad_payload' } });
  });

  it('ignores frames that are not envelopes, and web→host kinds', async () => {
    const h = await ready();
    const before = h.sent.length;
    h.recv({ hello: 'world' } as unknown as Record<string, unknown>);
    h.win.__slBridge!.recv('not json');
    h.recv({ sl: 1, k: 'evt', t: 'selection.changed', n: 1 });
    h.recv({ sl: 1, k: 'res', id: 'x', t: 'zoomIn' });
    await settle();
    expect(h.sent).toHaveLength(before);
  });
});

describe('bridge host — events', () => {
  it('forwards the v0.1 events from the chart callbacks', async () => {
    const h = await ready();
    const opts = h.created[0];
    const before = h.sent.length;

    opts.onHold?.({ holdId: 'h1', expiresAt: 5 });
    opts.onHoldRestored?.({ holdId: 'h1', expiresAt: 5 });
    opts.onHoldExpired?.();
    opts.onGAClick?.({ id: 'ga1' } as never);
    opts.onHint?.('one seat left over');
    opts.onError?.(Object.assign(new Error('ws down'), { code: 'socket_error' }));
    opts.onDeckTap?.('f2');

    const events = h.sent.slice(before);
    expect(events.map((e) => e.t)).toEqual([
      'hold.changed',
      'hold.restored',
      'hold.expired',
      'ga.click',
      'hint',
      'error',
      'deck.tap',
    ]);
    expect(events[0].p).toEqual({ hold: { holdId: 'h1', expiresAt: 5 } });
    expect(events[2].p).toEqual({});
    expect(events[4].p).toEqual({ message: 'one seat left over' });
    expect(events[5].p).toMatchObject({ code: 'socket_error', message: 'ws down' });
    expect(events[6].p).toEqual({ floorId: 'f2' });
  });

  it('stamps every event with a monotonic n', async () => {
    const h = await ready();
    const opts = h.created[0];
    opts.onHoldExpired?.();
    opts.onDeckTap?.('f2');
    opts.onHoldExpired?.();

    const seqs = h.ofKind('evt').map((e) => e.n!);
    expect(seqs).toHaveLength(4); // sys.ready + 3
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it('coalesces high-rate events to one latest-wins envelope per frame', async () => {
    const h = await ready();
    const opts = h.created[0];
    const before = h.sent.length;

    opts.onSeatHover?.({ label: 'A-1' } as never);
    opts.onSeatHover?.({ label: 'A-2' } as never);
    opts.onSelectionChange?.([{ id: 's1' }] as never);
    opts.onSelectionChange?.([{ id: 's1' }, { id: 's2' }] as never);
    // Nothing goes out until the frame boundary.
    expect(h.sent).toHaveLength(before);

    h.frame();
    const events = h.sent.slice(before);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.t === 'seat.hover')!.p).toEqual({ details: { label: 'A-2' } });
    expect(events.find((e) => e.t === 'selection.changed')!.p).toEqual({ seats: [{ id: 's1' }, { id: 's2' }] });
  });

  it('does not coalesce discrete user actions', async () => {
    const h = await ready();
    const opts = h.created[0];
    const before = h.sent.length;
    opts.onGAClick?.({ id: 'ga1' } as never);
    opts.onGAClick?.({ id: 'ga2' } as never);
    expect(h.sent.slice(before)).toHaveLength(2);
  });

  it('turns a throwing event mapper into sys.error, not a picker crash', async () => {
    const h = await ready();
    const opts = h.created[0];
    expect(() =>
      opts.onError?.({
        get code() {
          throw new Error('exploding payload');
        },
      }),
    ).not.toThrow();
    expect(h.last('evt')).toMatchObject({ t: 'sys.error' });
  });
});

describe('bridge host — teardown', () => {
  it('close() destroys the chart, uninstalls the receiver and stops sending', async () => {
    const h = await ready();
    const opts = h.created[0];
    h.handle.close();

    expect(h.chart.destroy).toHaveBeenCalledTimes(1);
    expect(h.win.__slBridge).toBeUndefined();

    const before = h.sent.length;
    opts.onHoldExpired?.();
    expect(h.sent).toHaveLength(before);
  });

  it('close() is idempotent', async () => {
    const h = await ready();
    h.handle.close();
    h.handle.close();
    expect(h.chart.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports the detected transport name', () => {
    expect(makeHarness().handle.transport).toBe('ios');
  });
});
