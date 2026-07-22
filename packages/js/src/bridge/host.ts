/**
 * SeatLayer mobile bridge — web-side runtime.
 *
 * Turns a page hosting a `SeatingChart` into something a native WebView wrapper
 * can drive: the host sends `cmd` envelopes and receives `res`/`err`/`evt`
 * envelopes back. The bridge is a thin, versioned adapter over the EXISTING
 * public `SeatingChart` surface — it adds no picker behaviour of its own.
 *
 * Lifecycle
 * ---------
 *   web  → hello  { bundle, protocol:{min,max}, capabilities, events, commands }
 *   host → init   { protocol, host, chrome, config }
 *   web  → evt sys.ready { protocol, mode, chart }        ← chart now exists
 *   host ↔ web    cmd/res/err + evt …
 *
 * Failure modes, all of which render NOTHING rather than half-booting:
 *   • no `init` within `timeoutMs` (default 10s) → `evt sys.error {code:'host_timeout'}`
 *   • protocol ranges do not intersect          → `evt sys.incompatible {host, web}`
 *
 * Invariants
 * ----------
 *   • Every `cmd` gets EXACTLY ONE `res` or `err`, correlated by `id`. Void
 *     commands get an empty `res` so native always has a completion signal.
 *   • No exception ever crosses the bridge: handler throws become `err`,
 *     anything else becomes `evt sys.error`.
 *   • An unknown command is an `err {code:'unsupported_command'}`, never a throw
 *     — that is what lets a NEW host talk to an OLD bundle and degrade cleanly.
 *   • High-rate events coalesce to at most one pending envelope per event type,
 *     flushed on the next animation frame.
 */
import type { SeatHoverDetails } from '@seatlayer/core';
import type { BestAvailableResult, HoldResult } from '../api';
import type { GAAreaAvailability, SeatingChartOptions, SelectedSeat } from '../SeatingChart';
import { SeatingChart } from '../SeatingChart';
import {
  BridgeError,
  ERROR_CODES,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  decode,
  errEnvelope,
  evtEnvelope,
  helloEnvelope,
  negotiate,
  resEnvelope,
  toErrorPayload,
  toRange,
  type Envelope,
  type InitPayload,
} from './protocol';
import { detectTransport, installReceiver, listenPostMessage, type BridgeTransport } from './transport';

/**
 * The slice of `SeatingChart` the bridge drives. Declared structurally so tests
 * (and any future alternative host surface) can supply a double without
 * standing up a renderer.
 */
export interface BridgeChart {
  render(): Promise<unknown>;
  /** Live vs test event, as reported by the server with the chart. */
  getMode(): 'live' | 'test' | null;
  // Throwing variants (…OrThrow): a 409 must reach onCmd's catch so the command
  // is answered with an `err` carrying the specific API reason. The public
  // hold()/bestAvailable()/… swallow the throw into onError + null (the direct
  // web-consumer contract), which would otherwise hide the conflict as a bare
  // `res { hold: null }`.
  holdOrThrow(options?: { ttlMs?: number }): Promise<HoldResult | null>;
  resumeHoldOrThrow(holdId: string): Promise<HoldResult | null>;
  extendHold(ttlMs?: number): Promise<HoldResult | null>;
  release(): Promise<void>;
  releaseLabels(labels: string[]): Promise<boolean>;
  bestAvailableOrThrow(qty: number, categoryKey?: string): Promise<BestAvailableResult | null>;
  holdGAOrThrow(areaId: string, qty: number, options?: { tierId?: string | null; ttlMs?: number }): Promise<HoldResult | null>;
  setSeatTier(seatId: string, tierId: string | null): void;
  getSelection(): SelectedSeat[];
  getCurrentHold(): HoldResult | null;
  getGAAreas(): GAAreaAvailability[];
  getFloors(): { id: string; name: string }[];
  setFloor(floorId: string): void;
  setColorblindSafe(on: boolean): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomToFit(): void;
  destroy(): void;
}

export interface StartBridgeOptions {
  /** SDK bundle version reported in `hello` (the CDN entry passes its own). */
  bundle?: string;
  /** Window to install on / detect against. Defaults to the global window. */
  win?: Window;
  /** Pre-built transport. Defaults to `detectTransport(win)`. */
  transport?: BridgeTransport;
  /** Chart factory. Defaults to constructing a real `SeatingChart`. */
  createChart?: (options: SeatingChartOptions) => BridgeChart;
  /** Handshake deadline in ms. Default 10000. */
  timeoutMs?: number;
  /** Element the chart mounts into when `init.config` names no container. */
  container?: string | HTMLElement;
  /** Frame scheduler for event coalescing. Defaults to rAF, then a 0ms timer. */
  schedule?: (flush: () => void) => void;
}

export interface BridgeHandle {
  /** Tear down listeners + chart. Idempotent. */
  close(): void;
  /** Negotiated protocol revision, or null before/without a successful `init`. */
  readonly protocol: number | null;
  /** Detected transport name — useful in tests and host diagnostics. */
  readonly transport: TransportNameOf;
}

type TransportNameOf = BridgeTransport['name'];

/** Every event `t` this bundle can emit (advertised in `hello`). */
export const BRIDGE_EVENTS = [
  'sys.ready',
  'sys.error',
  'sys.incompatible',
  'selection.changed',
  'hold.changed',
  'hold.restored',
  'hold.expired',
  'ga.click',
  'hint',
  'error',
  'seat.hover',
  'deck.tap',
] as const;

/**
 * Events that can fire many times per frame. Only these coalesce: dropping a
 * superseded hover or selection snapshot is lossless (each carries the FULL
 * current state), whereas dropping a second `ga.click` in the same frame would
 * lose a distinct user action.
 */
const COALESCED_EVENTS = new Set<string>(['seat.hover', 'selection.changed']);

/**
 * Coarse capability flags. Native uses these to decide which of its own UI to
 * show BEFORE the chart exists, without hardcoding a bundle version.
 */
export const BRIDGE_CAPABILITIES = [
  'hold',
  'hold.extend',
  'hold.resume',
  'hold.partial-release',
  'best-available',
  'ga',
  'tiers',
  'floors',
  'zoom',
  'colorblind-safe',
  'seat-hover',
] as const;

/* -------------------------------------------------------------------------- */
/* Payload validation helpers                                                  */
/* -------------------------------------------------------------------------- */

function bad(message: string): never {
  throw new BridgeError(ERROR_CODES.BAD_PAYLOAD, message);
}

function obj(p: unknown): Record<string, unknown> {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) bad('payload must be an object');
  return p as Record<string, unknown>;
}

function reqString(p: Record<string, unknown>, key: string): string {
  const value = p[key];
  if (typeof value !== 'string' || !value) bad(`\`${key}\` must be a non-empty string`);
  return value as string;
}

function reqNumber(p: Record<string, unknown>, key: string): number {
  const value = p[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(`\`${key}\` must be a finite number`);
  return value as number;
}

function optNumber(p: Record<string, unknown>, key: string): number | undefined {
  if (p[key] === undefined || p[key] === null) return undefined;
  return reqNumber(p, key);
}

function optString(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') bad(`\`${key}\` must be a string`);
  return value as string;
}

function reqBoolean(p: Record<string, unknown>, key: string): boolean {
  const value = p[key];
  if (typeof value !== 'boolean') bad(`\`${key}\` must be a boolean`);
  return value as boolean;
}

function reqStringArray(p: Record<string, unknown>, key: string): string[] {
  const value = p[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    bad(`\`${key}\` must be an array of strings`);
  }
  return value as string[];
}

/** `null` is meaningful here (revert to the default tier), so it is not "missing". */
function nullableString(p: Record<string, unknown>, key: string): string | null {
  const value = p[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') bad(`\`${key}\` must be a string or null`);
  return value as string;
}

/* -------------------------------------------------------------------------- */
/* Command table                                                               */
/* -------------------------------------------------------------------------- */

type CommandHandler = (chart: BridgeChart, p: unknown) => unknown | Promise<unknown>;

/**
 * v0.1 command set — a 1:1 mapping onto EXISTING public `SeatingChart` methods.
 * Getters return a named object (`{ seats }`, `{ hold }`) rather than a bare
 * array so a payload can gain fields later without breaking native decoders.
 */
const COMMANDS: Record<string, CommandHandler> = {
  hold: async (chart, p) => ({ hold: await chart.holdOrThrow({ ttlMs: optNumber(obj(p), 'ttlMs') }) }),
  resumeHold: async (chart, p) => ({ hold: await chart.resumeHoldOrThrow(reqString(obj(p), 'holdId')) }),
  extendHold: async (chart, p) => ({ hold: await chart.extendHold(optNumber(obj(p), 'ttlMs')) }),
  release: async (chart) => {
    await chart.release();
    return {};
  },
  releaseLabels: async (chart, p) => ({ released: await chart.releaseLabels(reqStringArray(obj(p), 'labels')) }),
  bestAvailable: async (chart, p) => {
    const args = obj(p);
    return { hold: await chart.bestAvailableOrThrow(reqNumber(args, 'qty'), optString(args, 'categoryKey')) };
  },
  holdGA: async (chart, p) => {
    const args = obj(p);
    const hold = await chart.holdGAOrThrow(reqString(args, 'areaId'), reqNumber(args, 'qty'), {
      tierId: args.tierId === undefined ? undefined : nullableString(args, 'tierId'),
      ttlMs: optNumber(args, 'ttlMs'),
    });
    return { hold };
  },
  setSeatTier: (chart, p) => {
    const args = obj(p);
    chart.setSeatTier(reqString(args, 'seatId'), nullableString(args, 'tierId'));
    return {};
  },
  getSelection: (chart) => ({ seats: chart.getSelection() }),
  getCurrentHold: (chart) => ({ hold: chart.getCurrentHold() }),
  getGAAreas: (chart) => ({ areas: chart.getGAAreas() }),
  getFloors: (chart) => ({ floors: chart.getFloors() }),
  setFloor: (chart, p) => {
    chart.setFloor(reqString(obj(p), 'floorId'));
    return {};
  },
  setColorblindSafe: (chart, p) => {
    chart.setColorblindSafe(reqBoolean(obj(p), 'on'));
    return {};
  },
  zoomIn: (chart) => {
    chart.zoomIn();
    return {};
  },
  zoomOut: (chart) => {
    chart.zoomOut();
    return {};
  },
  zoomToFit: (chart) => {
    chart.zoomToFit();
    return {};
  },
  destroy: (chart) => {
    chart.destroy();
    return {};
  },
};

/** Every command `t` this bundle accepts (advertised in `hello`). */
export const BRIDGE_COMMANDS = Object.keys(COMMANDS);

/* -------------------------------------------------------------------------- */
/* Runtime                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_TIMEOUT_MS = 10_000;

export function startBridge(options: StartBridgeOptions = {}): BridgeHandle {
  const win = options.win ?? (globalThis as unknown as Window);
  const transport = options.transport ?? detectTransport(win);
  // No cast: `SeatingChart` must structurally satisfy `BridgeChart`, so dropping
  // or renaming a bridged method is a compile error here rather than an
  // `unsupported_command` discovered by a native client at runtime.
  const createChart: (opts: SeatingChartOptions) => BridgeChart =
    options.createChart ?? ((opts) => new SeatingChart(opts));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const schedule =
    options.schedule ??
    ((flush: () => void) => {
      const raf = (win as unknown as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame;
      if (typeof raf === 'function') raf.call(win, () => flush());
      else setTimeout(flush, 0);
    });

  let seq = 0;
  let protocol: number | null = null;
  let chart: BridgeChart | null = null;
  let ready = false;
  let destroyed = false;
  let closed = false;
  let handshakeDone = false;

  /** Pending coalesced events, latest-wins per `t`, flushed on the next frame. */
  const pending = new Map<string, unknown>();
  let flushQueued = false;

  const send = (envelope: Envelope): void => {
    if (closed) return;
    transport.send(envelope);
  };

  /** Emit an event now, stamping the next monotonic `n`. */
  const emitNow = (t: string, payload?: unknown): void => {
    send(evtEnvelope(t, ++seq, payload));
  };

  const flush = (): void => {
    flushQueued = false;
    if (closed) return;
    // Snapshot first: emitNow → transport → host could re-enter and enqueue.
    const batch = [...pending.entries()];
    pending.clear();
    for (const [t, payload] of batch) emitNow(t, payload);
  };

  const emit = (t: string, payload?: unknown): void => {
    if (closed) return;
    if (!COALESCED_EVENTS.has(t)) {
      emitNow(t, payload);
      return;
    }
    pending.set(t, payload);
    if (flushQueued) return;
    flushQueued = true;
    schedule(flush);
  };

  /** Last-resort funnel: anything unexpected surfaces as an event, not a throw. */
  const emitSystemError = (err: unknown, code = 'internal_error'): void => {
    try {
      emitNow('sys.error', toErrorPayload(err, code));
    } catch {
      /* if even this fails the host channel is gone; nothing left to do */
    }
  };

  /** Guard host-facing callbacks: a throwing host callback must not break the picker. */
  const guard = <T extends unknown[]>(t: string, map: (...args: T) => unknown) =>
    (...args: T): void => {
      try {
        emit(t, map(...args));
      } catch (err) {
        emitSystemError(err);
      }
    };

  /* --- handshake ---------------------------------------------------------- */

  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onInit = async (envelope: Envelope): Promise<void> => {
    if (handshakeDone) return; // a second `init` is a host bug; ignore it.
    handshakeDone = true;
    clearTimer();

    const payload = (envelope.p ?? {}) as InitPayload;
    const hostRange = toRange(payload.protocol);
    if (!hostRange) {
      emitNow('sys.incompatible', {
        code: ERROR_CODES.BAD_PAYLOAD,
        message: '`init.protocol` must be a number or {min,max}',
        web: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
      });
      return;
    }

    const agreed = negotiate(hostRange);
    if (!agreed.ok) {
      // Render nothing: a bundle that cannot be understood is worse than none.
      emitNow('sys.incompatible', { message: agreed.reason, host: agreed.host, web: agreed.web });
      return;
    }
    protocol = agreed.protocol;

    try {
      chart = createChart(buildChartOptions(payload));
      await chart.render();
      ready = true;
      emitNow('sys.ready', {
        protocol,
        // The SERVED event's mode. Native MUST be able to badge a test build:
        // a test event looks and behaves exactly like a live one but books no
        // real inventory, and discovering that in production is expensive.
        // Falls back to 'live' only if the chart cannot report a mode, which
        // does not happen after a successful render().
        mode: chart.getMode() ?? 'live',
        // Which shim won detection — lets native confirm its own channel is in
        // use rather than a silent fallback to another.
        transport: transport.name,
        chart: { event: (payload.config?.event as string) ?? null },
      });
    } catch (err) {
      chart = null;
      emitSystemError(err, 'render_failed');
    }
  };

  const buildChartOptions = (payload: InitPayload): SeatingChartOptions => {
    const config = (payload.config ?? {}) as Record<string, unknown>;
    const event = config.event;
    if (typeof event !== 'string' || !event) {
      throw new BridgeError(ERROR_CODES.BAD_PAYLOAD, '`init.config.event` is required');
    }
    const container =
      (config.container as string | HTMLElement | undefined) ??
      options.container ??
      ((win as unknown as { document?: Document }).document?.body as HTMLElement);
    if (!container) throw new BridgeError(ERROR_CODES.BAD_PAYLOAD, 'no container available to mount into');

    return {
      container,
      event,
      apiBase: config.apiBase as string | undefined,
      publicKey: config.publicKey as string | undefined,
      maxSelection: config.maxSelection as number | undefined,
      locale: config.locale as string | undefined,
      messages: config.messages as Record<string, string> | undefined,
      currency: config.currency as string | undefined,
      colorblindSafe: config.colorblindSafe as boolean | undefined,
      // The native side draws its own seat sheet, so the host decides whether
      // the in-canvas tooltip should render at all.
      seatTooltip: payload.chrome?.seatTooltip,
      onSelectionChange: guard('selection.changed', (seats: SelectedSeat[]) => ({ seats })),
      onHold: guard('hold.changed', (hold: HoldResult) => ({ hold })),
      onHoldRestored: guard('hold.restored', (hold: HoldResult) => ({ hold })),
      onHoldExpired: guard('hold.expired', () => ({})),
      onGAClick: guard('ga.click', (area: GAAreaAvailability) => ({ area })),
      onHint: guard('hint', (message: string | null) => ({ message })),
      onError: guard('error', (err: unknown) => toErrorPayload(err, 'picker_error')),
      onSeatHover: guard('seat.hover', (details: SeatHoverDetails | null) => ({ details })),
      onDeckTap: guard('deck.tap', (floorId: string) => ({ floorId })),
    };
  };

  /* --- commands ----------------------------------------------------------- */

  const onCmd = async (envelope: Envelope): Promise<void> => {
    const id = envelope.id;
    // Without an id there is nothing to correlate a reply to. Report it as a
    // system error rather than replying to a correlation we do not have.
    if (!id) {
      emitSystemError(new BridgeError(ERROR_CODES.BAD_PAYLOAD, `cmd \`${envelope.t}\` is missing \`id\``));
      return;
    }
    const fail = (code: string, message: string): void => {
      send(errEnvelope(id, envelope.t, { code, message }));
    };

    const handler = COMMANDS[envelope.t];
    // Unknown command: a NEW host driving an OLD bundle. Never a throw — this
    // is the degradation path that makes forward compatibility work.
    if (!handler) {
      fail(ERROR_CODES.UNSUPPORTED_COMMAND, `unknown command \`${envelope.t}\``);
      return;
    }
    if (destroyed) {
      fail(ERROR_CODES.DESTROYED, 'the chart has been destroyed');
      return;
    }
    if (!ready || !chart) {
      fail(ERROR_CODES.NOT_READY, 'the chart is not ready yet');
      return;
    }

    try {
      const result = await handler(chart, envelope.p);
      if (envelope.t === 'destroy') destroyed = true;
      send(resEnvelope(id, envelope.t, result));
    } catch (err) {
      // Every failure inside a handler becomes an `err` for THIS correlation —
      // an API `code` (sold_out, …) rides through untouched.
      send(errEnvelope(id, envelope.t, toErrorPayload(err, 'command_failed')));
    }
  };

  /* --- inbound routing ---------------------------------------------------- */

  const handle = (input: unknown): void => {
    if (closed) return;
    const envelope = decode(input);
    if (!envelope) return; // not ours — pages receive unrelated messages
    try {
      if (envelope.k === 'init') void onInit(envelope);
      else if (envelope.k === 'cmd') void onCmd(envelope);
      // hello/res/err/evt are web→host kinds; an inbound one is noise.
    } catch (err) {
      emitSystemError(err);
    }
  };

  const uninstall = installReceiver(handle, win);
  const unlisten = listenPostMessage(handle, win);

  timer = setTimeout(() => {
    timer = null;
    if (handshakeDone) return;
    handshakeDone = true;
    // Render nothing: without `init` we have no event key and no negotiated
    // protocol, so there is no correct chart to draw.
    emitNow('sys.error', {
      code: 'host_timeout',
      message: `no init from the host within ${timeoutMs}ms`,
    });
  }, timeoutMs);

  send(
    helloEnvelope({
      bundle: options.bundle ?? 'unknown',
      protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
      capabilities: [...BRIDGE_CAPABILITIES],
      events: [...BRIDGE_EVENTS],
      commands: BRIDGE_COMMANDS,
    }),
  );

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearTimer();
      pending.clear();
      unlisten();
      uninstall();
      try {
        chart?.destroy();
      } catch {
        /* teardown is best-effort */
      }
      chart = null;
      ready = false;
    },
    get protocol() {
      return protocol;
    },
    get transport() {
      return transport.name;
    },
  };
}
