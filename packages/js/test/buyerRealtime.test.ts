/**
 * The realtime wire protocol, against a mock server built from
 * `docs/realtime-protocol-2026-08-01.md`.
 *
 * Covered: negotiation (v1 echo, legacy fallback, the `?pv=1` proxy path), the
 * subscribe-ticket exchange and its no-credential-in-URL rule, compact
 * `{default, exceptions}` snapshot reconstruction, `sv.<n>` resume with BOTH
 * outcomes, close code 4401 as a typed revocation rather than a reconnect loop,
 * and §5's silence contract — a quiet socket is never a dead one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BuyerRealtimeClient,
  CLOSE_ACCESS_REVOKED,
  SEATLAYER_V1,
  applyChanges,
  assertCredentialFreeUrl,
  createControllerSink,
  diffProjections,
  projectionFromSnapshot,
  type PickerControllerLike,
  type RealtimeSink,
  type StatusChange,
} from '../src/buyerRealtime';

const URL_BASE = 'wss://api.test.seatlayer.io/pub/events/ev_1/subscribe?surface=picker&viewerId=v1';
const TICKET = 'tkt_one_use_value';

/** The half of the WebSocket API this client uses, driven from the test. */
class MockSocket {
  static opened: MockSocket[] = [];
  readyState = 0;
  protocol = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string, readonly protocols: string[]) {
    MockSocket.opened.push(this);
  }

  /** The 101 response: echo the app protocol, and never the ticket. */
  accept(protocol = ''): void {
    this.protocol = protocol;
    this.readyState = 1;
    this.onopen?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function makeClient(
  overrides: Partial<ConstructorParameters<typeof BuyerRealtimeClient>[0]> = {},
): { client: BuyerRealtimeClient; sink: RealtimeSink & { changes: StatusChange[]; resyncs: number } } {
  const changes: StatusChange[] = [];
  const state = { resyncs: 0 };
  const sink = {
    changes,
    get resyncs() {
      return state.resyncs;
    },
    applyStatuses: (batch: StatusChange[]) => changes.push(...batch),
    resync: () => {
      state.resyncs += 1;
    },
  } as RealtimeSink & { changes: StatusChange[]; resyncs: number };

  const client = new BuyerRealtimeClient({
    url: URL_BASE,
    sink,
    mintTicket: async () => ({ ticket: TICKET, protocols: [SEATLAYER_V1, `tkt.${TICKET}`] }),
    socketFactory: (url, protocols) => new MockSocket(url, protocols) as unknown as WebSocket,
    ...overrides,
  });
  return { client, sink };
}

const latest = (): MockSocket => MockSocket.opened[MockSocket.opened.length - 1];

/** Let the ticket mint's microtask settle before the socket exists. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  MockSocket.opened = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('projection reconstruction (protocol §2)', () => {
  it('reads a compact v1 snapshot as default + exceptions', () => {
    expect(
      projectionFromSnapshot({ default: 'blocked', seats: { 'A-1': 'free', 'A-2': 'held' } }),
    ).toEqual({ default: 'blocked', exceptions: { 'A-1': 'free', 'A-2': 'held' } });
  });

  it('reads a legacy verbose snapshot as the same shape with an implicit free default', () => {
    expect(projectionFromSnapshot({ seats: { 'A-1': 'booked' } })).toEqual({
      default: 'free',
      exceptions: { 'A-1': 'booked' },
    });
  });

  it('drops exceptions that merely restate the default', () => {
    expect(projectionFromSnapshot({ default: 'free', seats: { 'A-1': 'free' } }).exceptions).toEqual({});
  });

  it('diffs two projections that share a default, including units returning to it', () => {
    const changes = diffProjections(
      { default: 'free', exceptions: { 'A-1': 'held', 'A-2': 'booked' } },
      { default: 'free', exceptions: { 'A-2': 'booked', 'A-3': 'held' } },
    );
    expect(changes).toEqual([
      { label: 'A-3', status: 'held' },
      { label: 'A-1', status: 'free' },
    ]);
  });

  it('refuses to diff across a default change — that universe is not held locally', () => {
    expect(diffProjections({ default: 'free', exceptions: {} }, { default: 'blocked', exceptions: {} })).toBeNull();
    expect(diffProjections(null, { default: 'free', exceptions: {} })).toBeNull();
  });

  it('folds deltas back into the default so the model cannot grow without bound', () => {
    const projection = { default: 'free', exceptions: { 'A-1': 'held' } };
    applyChanges(projection, [{ label: 'A-1', status: 'free' }, { label: 'A-2', status: 'booked' }]);
    expect(projection.exceptions).toEqual({ 'A-2': 'booked' });
  });
});

describe('negotiation and the ticket exchange (protocol §1, §3)', () => {
  it('offers seatlayer.v1 plus the one-use ticket, and keeps both out of the URL', async () => {
    const { client } = makeClient();
    client.start();
    await settle();

    const socket = latest();
    expect(socket.protocols).toEqual([SEATLAYER_V1, `tkt.${TICKET}`]);
    expect(socket.url).toBe(URL_BASE);
    expect(socket.url).not.toContain(TICKET);
    expect(socket.url).not.toMatch(/[?&](tkt|ticket|token|bearer)=/i);
    client.stop();
  });

  it('speaks v1 when the 101 echoes it, and applies a compact snapshot as a diff', async () => {
    const { client, sink } = makeClient();
    client.start();
    await settle();
    const socket = latest();
    socket.accept(SEATLAYER_V1);
    expect(client.protocol).toBe('v1');
    // Fresh connection with no resume offered: authoritative HTTP first.
    expect(sink.resyncs).toBe(1);

    socket.emit({
      type: 'snapshot', protocol: 1, snapshotVersion: 42,
      default: 'free', seats: { 'A-2': 'held' }, hidden: [], closed: [],
    });
    // The first snapshot cannot be diffed against nothing — resync, then track.
    expect(sink.resyncs).toBe(2);
    expect(client.snapshotVersion).toBe(42);

    socket.emit({
      type: 'delta', protocol: 1, snapshotVersion: 43,
      changes: [{ label: 'A-1', status: 'booked' }],
    });
    expect(sink.changes).toEqual([{ label: 'A-1', status: 'booked' }]);
    expect(client.snapshotVersion).toBe(43);
    client.stop();
  });

  it('falls back to legacy frames byte-compatibly when the 101 echoes nothing', async () => {
    const { client, sink } = makeClient();
    client.start();
    await settle();
    const socket = latest();
    socket.accept(''); // pre-M5 server, or a proxy that ate the header
    expect(client.protocol).toBe('legacy');

    socket.emit({ type: 'snapshot', seats: { 'A-1': 'held' }, hidden: [], closed: [], updatedAt: 1 });
    socket.emit({ type: 'delta', changes: [{ label: 'A-1', status: 'booked' }], ts: 2 });

    expect(sink.changes).toEqual([{ label: 'A-1', status: 'booked' }]);
    // A legacy stream carries no snapshotVersion, so nothing to resume from.
    expect(client.snapshotVersion).toBeNull();
    client.stop();
  });

  it('selects the v1 frame format with ?pv=1 on the next attempt when the subprotocol was stripped', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept('');
    latest().close(1006);
    await vi.advanceTimersByTimeAsync(1_100);

    const retry = latest();
    expect(retry.url).toBe(`${URL_BASE}&pv=1`);
    // The marker selects a format. It can never carry a credential.
    expect(() => assertCredentialFreeUrl(retry.url)).not.toThrow();
    client.stop();
  });

  it('believes a frame that declares protocol: 1 even when the echo was lost', async () => {
    const { client } = makeClient();
    client.start();
    await settle();
    const socket = latest();
    socket.accept('');
    expect(client.protocol).toBe('legacy');
    socket.emit({ type: 'delta', protocol: 1, snapshotVersion: 7, changes: [] });
    expect(client.protocol).toBe('v1');
    client.stop();
  });

  it('connects with no ticket at all for the anonymous case', async () => {
    const { client } = makeClient({ mintTicket: undefined });
    client.start();
    await settle();
    expect(latest().protocols).toEqual([SEATLAYER_V1]);
    client.stop();
  });

  it('refuses outright to open a socket whose URL carries a credential', () => {
    expect(() => assertCredentialFreeUrl(`${URL_BASE}&ticket=abc`)).toThrow(/credential in the URL/);
    expect(() => assertCredentialFreeUrl(`${URL_BASE}&x=bse_abc123`)).toThrow(/credential in the URL/);
    expect(
      () => new BuyerRealtimeClient({ url: `${URL_BASE}&token=bse_x`, sink: {} as RealtimeSink }),
    ).toThrow(/credential in the URL/);
  });
});

describe('resume and gap-fill (protocol §4)', () => {
  it('offers sv.<lastSeenVersion> on reconnect and mints a fresh ticket for it', async () => {
    vi.useFakeTimers();
    const mintTicket = vi.fn(async () => ({ ticket: TICKET, protocols: [SEATLAYER_V1, `tkt.${TICKET}`] }));
    const { client } = makeClient({ mintTicket });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'delta', protocol: 1, snapshotVersion: 128, changes: [{ label: 'A-1', status: 'held' }] });
    latest().close(1006);
    await vi.advanceTimersByTimeAsync(1_100);

    expect(latest().protocols).toEqual([SEATLAYER_V1, `tkt.${TICKET}`, 'sv.128']);
    expect(mintTicket).toHaveBeenCalledTimes(2); // one mint per attempt, by design
    client.stop();
  });

  it('applies a resumed gap-fill delta and does NOT resync', async () => {
    vi.useFakeTimers();
    const { client, sink } = makeClient();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'delta', protocol: 1, snapshotVersion: 10, changes: [{ label: 'A-1', status: 'held' }] });
    const before = sink.resyncs;
    latest().close(1006);
    await vi.advanceTimersByTimeAsync(1_100);
    latest().accept(SEATLAYER_V1);

    latest().emit({
      type: 'delta', protocol: 1, resumed: true, snapshotVersion: 14,
      changes: [{ label: 'A-2', status: 'booked' }],
    });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(sink.changes.at(-1)).toEqual({ label: 'A-2', status: 'booked' });
    expect(sink.resyncs).toBe(before); // the resume answered; no HTTP needed
    expect(client.snapshotVersion).toBe(14);
    client.stop();
  });

  it('handles the other resume outcome — a ring miss answers with an authoritative snapshot', async () => {
    vi.useFakeTimers();
    const { client, sink } = makeClient();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'snapshot', protocol: 1, snapshotVersion: 3, default: 'free', seats: {} });
    latest().close(1006);
    await vi.advanceTimersByTimeAsync(1_100);
    latest().accept(SEATLAYER_V1);
    const before = sink.resyncs;

    // Ring miss: the whole scope re-projects, default and all.
    latest().emit({
      type: 'snapshot', protocol: 1, snapshotVersion: 900,
      default: 'blocked', seats: { 'A-1': 'free' },
    });
    expect(sink.resyncs).toBe(before + 1);
    client.stop();
  });

  it('resyncs if a resume is offered and the server answers with nothing at all', async () => {
    vi.useFakeTimers();
    const { client, sink } = makeClient();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'delta', protocol: 1, snapshotVersion: 5, changes: [{ label: 'A-1', status: 'held' }] });
    latest().close(1006);
    await vi.advanceTimersByTimeAsync(1_100);
    latest().accept(SEATLAYER_V1);
    const before = sink.resyncs;

    await vi.advanceTimersByTimeAsync(6_000);
    expect(sink.resyncs).toBe(before + 1);
    client.stop();
  });

  it('never dedupes on allocationVersion — the snapshot that follows always wins', async () => {
    const { client, sink } = makeClient();
    client.start();
    await settle();
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'snapshot', protocol: 1, snapshotVersion: 1, default: 'free', seats: {} });
    const before = sink.resyncs;

    // Same allocationVersion twice (a pause then an unpause), different projection.
    latest().emit({ type: 'allocation', protocol: 1, allocationVersion: 4, ts: 1 });
    latest().emit({ type: 'snapshot', protocol: 1, snapshotVersion: 2, default: 'blocked', seats: {} });
    latest().emit({ type: 'allocation', protocol: 1, allocationVersion: 4, ts: 2 });
    latest().emit({ type: 'snapshot', protocol: 1, snapshotVersion: 3, default: 'free', seats: {} });

    expect(sink.resyncs).toBe(before + 2);
    client.stop();
  });
});

describe('revocation (protocol §3)', () => {
  it('reports close 4401 as a typed access-revoked state and stops reconnecting', async () => {
    vi.useFakeTimers();
    const seen: Array<{ reason: string }> = [];
    const { client } = makeClient({ onAccessUnavailable: (event) => seen.push(event) });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);
    const opened = MockSocket.opened.length;

    latest().close(CLOSE_ACCESS_REVOKED);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(seen).toEqual([{ reason: 'revoked', code: 'access_revoked', retryable: false }]);
    // Retrying with the same credential is guaranteed to fail, so we do not.
    expect(MockSocket.opened).toHaveLength(opened);
  });

  it('reconnects with backoff on any ordinary close', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);
    latest().close(1006);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(MockSocket.opened).toHaveLength(2);
    client.stop();
  });

  it('restart() resumes from scratch after the host re-authorizes', async () => {
    vi.useFakeTimers();
    const seen: Array<{ reason: string }> = [];
    const { client } = makeClient({ onAccessUnavailable: (event) => seen.push(event) });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'snapshot', protocol: 1, snapshotVersion: 9, default: 'free', seats: {} });
    latest().close(CLOSE_ACCESS_REVOKED);

    client.restart();
    await vi.advanceTimersByTimeAsync(0);
    // A fresh session starts clean: no stale resume point from the revoked one.
    expect(latest().protocols).toEqual([SEATLAYER_V1, `tkt.${TICKET}`]);
    expect(client.snapshotVersion).toBeNull();
    client.stop();
  });
});

describe('the silence contract (protocol §5)', () => {
  it('treats a long-quiet socket as healthy: no resync, no reconnect, only ping/pong', async () => {
    vi.useFakeTimers();
    const { client, sink } = makeClient();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = latest();
    socket.accept(SEATLAYER_V1);
    socket.emit({ type: 'snapshot', protocol: 1, snapshotVersion: 1, default: 'free', seats: {} });
    const before = sink.resyncs;

    // Five minutes of nothing — the normal state for a narrowly-scoped buyer.
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(25_000);
      socket.emit({ type: 'pong', ts: i });
    }

    expect(sink.resyncs).toBe(before);
    expect(MockSocket.opened).toHaveLength(1);
    expect(socket.sent.filter((m) => m.includes('ping')).length).toBeGreaterThanOrEqual(10);
    client.stop();
  });

  it('does reconnect when ping/pong stops answering — liveness is the ping, not the silence', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    latest().accept(SEATLAYER_V1);

    await vi.advanceTimersByTimeAsync(25_000); // ping goes out
    await vi.advanceTimersByTimeAsync(10_500); // no pong within grace
    await vi.advanceTimersByTimeAsync(1_100); // backoff
    expect(MockSocket.opened.length).toBeGreaterThan(1);
    client.stop();
  });

  it('passes a scope-projected presence frame through without inferring anything from its absence', async () => {
    const counts: Array<{ shoppingSessions: number; activeHolds: number }> = [];
    const { client, sink } = makeClient();
    (sink as RealtimeSink).onPresence = (value) => counts.push(value);
    client.start();
    await settle();
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'presence', shoppingSessions: 3, activeHolds: 2, ts: 1 });
    expect(counts).toEqual([{ shoppingSessions: 3, activeHolds: 2 }]);
    client.stop();
  });

  it('raises section availability once per change, not once per frame', async () => {
    const sections: Array<[string[], string[]]> = [];
    const { client, sink } = makeClient();
    (sink as RealtimeSink).onSections = (hidden, closed) => sections.push([hidden, closed]);
    client.start();
    await settle();
    latest().accept(SEATLAYER_V1);
    latest().emit({ type: 'hidden', hidden: ['sec_a'], closed: [], ts: 1 });
    latest().emit({ type: 'hidden', hidden: ['sec_a'], closed: [], ts: 2 });
    latest().emit({ type: 'hidden', hidden: ['sec_a'], closed: ['sec_b'], ts: 3 });
    expect(sections).toEqual([[['sec_a'], []], [['sec_a'], ['sec_b']]]);
    client.stop();
  });
});

describe('controller sink', () => {
  function fakeController(): PickerControllerLike & {
    statusCalls: Array<[string[], string]>;
    deselected: string[][];
  } {
    const statuses = new Map<string, string>([['id-A-1', 'free'], ['id-A-2', 'free']]);
    const statusCalls: Array<[string[], string]> = [];
    const deselected: string[][] = [];
    return {
      statusCalls,
      deselected,
      idForLabel: (label) => (label.startsWith('A-') ? `id-${label}` : undefined),
      tableSelection: () => null,
      setStatus: (ids, status) => {
        statusCalls.push([ids, status]);
        ids.forEach((id) => statuses.set(id, status));
      },
      getStatus: (id) => statuses.get(id),
      flashSeat: () => {},
      currentHold: () => null,
      getSelection: () => [{ id: 'id-A-1', label: 'A-1' }],
      deselect: (ids) => deselected.push(ids),
      refresh: async () => {},
    };
  }

  it('paints a whole delta batch as ONE call per status, not one per seat', () => {
    const controller = fakeController();
    const sink = createControllerSink(controller);
    sink.applyStatuses([
      { label: 'A-1', status: 'held' },
      { label: 'A-2', status: 'booked' },
      { label: 'A-3', status: 'held' },
    ]);
    // Three labels, two statuses → two renderer calls.
    expect(controller.statusCalls).toEqual([
      [['id-A-1', 'id-A-3'], 'held'],
      [['id-A-2'], 'booked'],
    ]);
  });

  it('maps the neutral out-of-scope status to unavailable without exposing why', () => {
    const controller = fakeController();
    createControllerSink(controller).applyStatuses([{ label: 'A-2', status: 'blocked' }]);
    expect(controller.statusCalls).toEqual([[['id-A-2'], 'not_for_sale']]);
  });

  it('drops selected-but-unheld units in one deselect and reports them as ineligible', () => {
    const controller = fakeController();
    const lost: Array<[string[], string]> = [];
    const sink = createControllerSink(controller, {
      onSelectedObjectUnavailable: (labels, reason) => lost.push([labels, reason]),
    });
    sink.applyStatuses([{ label: 'A-1', status: 'blocked' }]);
    expect(controller.deselected).toEqual([['id-A-1']]);
    expect(lost).toEqual([[['A-1'], 'ineligible']]);
  });

  it('reports a unit someone else took as taken, not as an access problem', () => {
    const controller = fakeController();
    const lost: Array<[string[], string]> = [];
    createControllerSink(controller, {
      onSelectedObjectUnavailable: (labels, reason) => lost.push([labels, reason]),
    }).applyStatuses([{ label: 'A-1', status: 'booked' }]);
    expect(lost).toEqual([[['A-1'], 'taken']]);
  });
});
