/**
 * SeatLayer mobile bridge — wire protocol (v1).
 *
 * A native WebView wrapper (iOS / Android / Flutter / React Native) drives the
 * web `SeatingChart` by exchanging small JSON envelopes with the page. This
 * module owns the envelope shape, the version range, the error vocabulary and
 * the encode/decode helpers. It has NO DOM or transport dependency so it can be
 * unit-tested (and re-implemented natively) in isolation.
 *
 * Envelope:
 *
 *   { sl: 1, k: 'hello'|'init'|'cmd'|'res'|'err'|'evt', id?, n?, t, p? }
 *
 *   • `sl` — envelope marker + envelope version. Always 1 for this protocol.
 *   • `k`  — kind. `hello`/`evt`/`res`/`err` are web→host; `init`/`cmd` are host→web.
 *   • `id` — correlation id. Present on `cmd` and echoed on its single `res`/`err`.
 *   • `n`  — monotonic sequence, present on `evt` ONLY.
 *   • `t`  — type/topic: the command name (`cmd`/`res`/`err`) or event name (`evt`).
 *   • `p`  — payload; shape depends on `t`.
 *
 * Why `n` exists: on Android, `WebView.evaluateJavascript` (host→web) and
 * `@JavascriptInterface` methods (web→host) run on DIFFERENT threads with no
 * ordering guarantee, so a native reader can observe two emissions of the same
 * event type out of order. Every `evt` therefore carries a monotonically
 * increasing `n` and native drops any envelope whose `n` is lower than the
 * highest `n` it has already applied FOR THAT `t`.
 */

/** Envelope marker/version. Bumped only if the envelope itself changes shape. */
export const ENVELOPE_MARKER = 1 as const;

/** Oldest protocol revision this bundle can speak. */
export const PROTOCOL_MIN = 1;
/** Newest protocol revision this bundle can speak. */
export const PROTOCOL_MAX = 1;

export type EnvelopeKind = 'hello' | 'init' | 'cmd' | 'res' | 'err' | 'evt';

const KINDS: readonly EnvelopeKind[] = ['hello', 'init', 'cmd', 'res', 'err', 'evt'];

export interface Envelope {
  sl: typeof ENVELOPE_MARKER;
  k: EnvelopeKind;
  /** Correlation id — set on `cmd`, echoed on the matching `res`/`err`. */
  id?: string;
  /** Monotonic sequence — set on `evt` only. */
  n?: number;
  /** Command or event name. */
  t: string;
  p?: unknown;
}

/**
 * Bridge-level error codes. Anything the underlying API returns (an `ApiError`
 * `code` such as `sold_out`) passes through unchanged, so native must treat the
 * code as an open string set and only special-case the four below.
 */
export const ERROR_CODES = {
  /** `t` is not in this bundle's command table. */
  UNSUPPORTED_COMMAND: 'unsupported_command',
  /** `p` failed the command's argument validation. */
  BAD_PAYLOAD: 'bad_payload',
  /** A command arrived before `sys.ready` (no chart yet). */
  NOT_READY: 'not_ready',
  /** A command arrived after the `destroy` command. */
  DESTROYED: 'destroyed',
} as const;

export type BridgeErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES] | (string & {});

/** Payload of an `err` envelope, and of the `sys.error` event. */
export interface BridgeErrorPayload {
  code: BridgeErrorCode;
  message: string;
  /** Optional extra context (API conflicts, validation detail). */
  details?: unknown;
}

/** An error whose `code` should survive the trip across the bridge. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: unknown;
  constructor(code: BridgeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

/** Protocol range as advertised by either side of the handshake. */
export interface ProtocolRange {
  min: number;
  max: number;
}

/** Web→host handshake opener. */
export interface HelloPayload {
  /** SDK bundle version, for host-side diagnostics. */
  bundle: string;
  protocol: ProtocolRange;
  /** Coarse feature flags this bundle supports. */
  capabilities: string[];
  /** Every event `t` this bundle can emit. */
  events: string[];
  /** Every command `t` this bundle accepts. */
  commands: string[];
}

/** Host→web handshake reply. */
export interface InitPayload {
  /** Protocol revision the host wants, or the range it supports. */
  protocol: number | ProtocolRange;
  /** Free-form host identification (`{ platform:'ios', app:'1.4.0' }`). */
  host?: Record<string, unknown>;
  /** Which UI the WEB side should draw (the host draws the rest natively). */
  chrome?: { seatTooltip?: boolean };
  /** SeatingChart construction options. */
  config?: Record<string, unknown>;
}

/** Result of intersecting the host's protocol range with this bundle's. */
export type Negotiation =
  | { ok: true; protocol: number }
  | { ok: false; reason: string; host: ProtocolRange; web: ProtocolRange };

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value;
}

/** Normalise `init.protocol` (a bare number OR a `{min,max}` range) to a range. */
export function toRange(protocol: unknown): ProtocolRange | null {
  if (isFiniteInt(protocol)) return { min: protocol, max: protocol };
  if (protocol && typeof protocol === 'object') {
    const { min, max } = protocol as Record<string, unknown>;
    if (isFiniteInt(min) && isFiniteInt(max) && min <= max) return { min, max };
  }
  return null;
}

/**
 * Version negotiation by RANGE INTERSECTION.
 *
 * The agreed revision is the highest both sides can speak — `min(hostMax,
 * webMax)`. If that falls below EITHER side's minimum the ranges do not
 * overlap and there is no revision both understand, so the bridge refuses to
 * render rather than half-speaking a protocol.
 *
 * This makes both upgrade directions safe:
 *   • old host (max 1) + new bundle (1..3) → agreed 1, bundle speaks down.
 *   • new host (2..4) + old bundle (max 1) → agreed 1 < hostMin 2 → incompatible.
 */
export function negotiate(
  host: ProtocolRange,
  web: ProtocolRange = { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
): Negotiation {
  const agreed = Math.min(host.max, web.max);
  if (agreed < host.min || agreed < web.min) {
    return {
      ok: false,
      reason: `no shared protocol revision (host ${host.min}..${host.max}, web ${web.min}..${web.max})`,
      host,
      web,
    };
  }
  return { ok: true, protocol: agreed };
}

/** Serialise an envelope for the string-based native shims. */
export function encode(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parse + validate an inbound envelope. Accepts a JSON string (Android /
 * Flutter / RN shims) or an already-structured object (iOS `postMessage`,
 * `window.postMessage`). Returns `null` for anything that is not a well-formed
 * envelope — the bridge ignores those silently rather than throwing, because a
 * page can receive unrelated messages it does not own.
 */
export function decode(input: unknown): Envelope | null {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.sl !== ENVELOPE_MARKER) return null;
  if (typeof obj.k !== 'string' || !KINDS.includes(obj.k as EnvelopeKind)) return null;
  if (typeof obj.t !== 'string' || obj.t.length === 0) return null;
  if (obj.id !== undefined && typeof obj.id !== 'string') return null;
  if (obj.n !== undefined && !isFiniteInt(obj.n)) return null;

  const out: Envelope = { sl: ENVELOPE_MARKER, k: obj.k as EnvelopeKind, t: obj.t };
  if (typeof obj.id === 'string') out.id = obj.id;
  if (isFiniteInt(obj.n)) out.n = obj.n;
  if ('p' in obj) out.p = obj.p;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Envelope constructors                                                       */
/* -------------------------------------------------------------------------- */

export function helloEnvelope(payload: HelloPayload): Envelope {
  return { sl: ENVELOPE_MARKER, k: 'hello', t: 'hello', p: payload };
}

/** Success reply to a `cmd`. Void commands still get one, with an empty `p`. */
export function resEnvelope(id: string, t: string, payload?: unknown): Envelope {
  return { sl: ENVELOPE_MARKER, k: 'res', id, t, p: payload ?? {} };
}

/** Failure reply to a `cmd`. Exactly one of `res`/`err` is sent per `cmd`. */
export function errEnvelope(id: string, t: string, payload: BridgeErrorPayload): Envelope {
  return { sl: ENVELOPE_MARKER, k: 'err', id, t, p: payload };
}

export function evtEnvelope(t: string, n: number, payload?: unknown): Envelope {
  return { sl: ENVELOPE_MARKER, k: 'evt', n, t, p: payload ?? {} };
}

/**
 * Normalise ANY thrown value into an error payload. Nothing that crosses the
 * bridge is ever a raw exception, and an API error's own `code` (e.g.
 * `sold_out`) passes straight through so native can branch on it.
 */
export function toErrorPayload(err: unknown, fallbackCode: BridgeErrorCode): BridgeErrorPayload {
  if (err instanceof BridgeError) {
    return { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) };
  }
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // The API discriminates a 409 by `reason` (`sold_out`, `not_enough_together`,
    // `event_closed`, …) while its top-level `error` — which surfaces as the
    // generic `.code`/`.message` `conflict` — is only the bucket. Native buyer UI
    // must branch on the SPECIFIC reason ("sold out" vs "couldn't seat you
    // together"), so `reason` becomes the surfaced `code` when present; an
    // explicit `code` is next; the fallback last. The reason is NOT merely buried
    // in `details` where a native decoder branching on `code` would never see it.
    const reason = typeof e.reason === 'string' && e.reason ? e.reason : undefined;
    const explicitCode = typeof e.code === 'string' && e.code ? e.code : undefined;
    const code = reason ?? explicitCode ?? fallbackCode;
    const message = typeof e.message === 'string' ? e.message : String(err);
    const details: Record<string, unknown> = {};
    if (typeof e.status === 'number') details.status = e.status;
    if (Array.isArray(e.conflicts)) details.conflicts = e.conflicts;
    if (reason) details.reason = reason;
    return {
      code,
      message,
      ...(Object.keys(details).length ? { details } : {}),
    };
  }
  return { code: fallbackCode, message: typeof err === 'string' ? err : String(err) };
}
