import { describe, expect, it } from 'vitest';
import {
  BridgeError,
  ENVELOPE_MARKER,
  ERROR_CODES,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  decode,
  encode,
  errEnvelope,
  evtEnvelope,
  helloEnvelope,
  negotiate,
  resEnvelope,
  toErrorPayload,
  toRange,
} from '../src/bridge/protocol';

describe('bridge protocol — encode/decode', () => {
  it('round-trips an envelope through JSON', () => {
    const envelope = evtEnvelope('selection.changed', 7, { seats: [{ id: 's1' }] });
    const decoded = decode(encode(envelope));
    expect(decoded).toEqual(envelope);
  });

  it('decodes an already-structured object (iOS / postMessage path)', () => {
    const decoded = decode({ sl: 1, k: 'cmd', id: 'c1', t: 'zoomIn' });
    expect(decoded).toEqual({ sl: 1, k: 'cmd', id: 'c1', t: 'zoomIn' });
  });

  it('preserves an explicitly-null payload', () => {
    expect(decode({ sl: 1, k: 'cmd', id: 'c1', t: 'x', p: null })?.p).toBeNull();
  });

  it('strips unknown top-level keys', () => {
    const decoded = decode({ sl: 1, k: 'cmd', id: 'c1', t: 'zoomIn', rogue: 'value' });
    expect(decoded).not.toHaveProperty('rogue');
  });

  it('rejects anything that is not a well-formed envelope', () => {
    expect(decode('not json')).toBeNull();
    expect(decode('[1,2,3]')).toBeNull();
    expect(decode(null)).toBeNull();
    expect(decode(42)).toBeNull();
    expect(decode({ k: 'cmd', t: 'x' })).toBeNull(); // no marker
    expect(decode({ sl: 2, k: 'cmd', t: 'x' })).toBeNull(); // wrong marker
    expect(decode({ sl: 1, k: 'nope', t: 'x' })).toBeNull(); // unknown kind
    expect(decode({ sl: 1, k: 'cmd' })).toBeNull(); // no type
    expect(decode({ sl: 1, k: 'cmd', t: '' })).toBeNull(); // empty type
    expect(decode({ sl: 1, k: 'cmd', t: 'x', id: 9 })).toBeNull(); // non-string id
    expect(decode({ sl: 1, k: 'evt', t: 'x', n: 1.5 })).toBeNull(); // non-integer seq
  });

  it('stamps evt envelopes with the monotonic sequence and nothing else', () => {
    const envelope = evtEnvelope('hint', 3, { message: null });
    expect(envelope).toMatchObject({ sl: ENVELOPE_MARKER, k: 'evt', t: 'hint', n: 3 });
    expect(envelope.id).toBeUndefined();
  });

  it('gives void results an empty res payload rather than omitting it', () => {
    expect(resEnvelope('c9', 'zoomIn')).toEqual({ sl: 1, k: 'res', id: 'c9', t: 'zoomIn', p: {} });
  });

  it('correlates res / err back to the cmd id', () => {
    expect(resEnvelope('abc', 'hold', { hold: null }).id).toBe('abc');
    expect(errEnvelope('abc', 'hold', { code: 'x', message: 'y' }).id).toBe('abc');
  });

  it('advertises the protocol range in hello', () => {
    const hello = helloEnvelope({
      bundle: '9.9.9',
      protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
      capabilities: [],
      events: [],
      commands: [],
    });
    expect(hello.k).toBe('hello');
    expect(hello.p).toMatchObject({ bundle: '9.9.9', protocol: { min: 1, max: 1 } });
  });
});

describe('bridge protocol — version negotiation', () => {
  it('normalises a bare number or a range', () => {
    expect(toRange(2)).toEqual({ min: 2, max: 2 });
    expect(toRange({ min: 1, max: 3 })).toEqual({ min: 1, max: 3 });
    expect(toRange({ min: 3, max: 1 })).toBeNull(); // inverted
    expect(toRange('1')).toBeNull();
    expect(toRange(undefined)).toBeNull();
  });

  it('agrees on the highest revision both sides speak', () => {
    expect(negotiate({ min: 1, max: 3 }, { min: 1, max: 3 })).toEqual({ ok: true, protocol: 3 });
    expect(negotiate({ min: 1, max: 5 }, { min: 2, max: 3 })).toEqual({ ok: true, protocol: 3 });
  });

  // Direction 1: an OLD host that only speaks v1 meets a NEW bundle that speaks
  // 1..3 — the bundle must speak down to 1, not refuse.
  it('old host + new bundle settles on the host revision', () => {
    expect(negotiate({ min: 1, max: 1 }, { min: 1, max: 3 })).toEqual({ ok: true, protocol: 1 });
  });

  // Direction 2: a NEW host that has dropped v1 meets an OLD bundle capped at 1
  // — no shared revision, so the bridge must refuse rather than half-speak.
  it('new host + old bundle is incompatible', () => {
    const result = negotiate({ min: 2, max: 4 }, { min: 1, max: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.host).toEqual({ min: 2, max: 4 });
      expect(result.web).toEqual({ min: 1, max: 1 });
      expect(result.reason).toContain('no shared protocol revision');
    }
  });

  it('is incompatible when the bundle is ahead of everything the host accepts', () => {
    expect(negotiate({ min: 5, max: 6 }, { min: 1, max: 2 }).ok).toBe(false);
  });

  it('defaults the web side to this bundle range', () => {
    expect(negotiate({ min: 1, max: 1 })).toEqual({ ok: true, protocol: 1 });
    expect(negotiate({ min: 99, max: 99 }).ok).toBe(false);
  });
});

describe('bridge protocol — error normalisation', () => {
  it('keeps a BridgeError code and details', () => {
    const payload = toErrorPayload(new BridgeError(ERROR_CODES.BAD_PAYLOAD, 'nope', { field: 'qty' }), 'fallback');
    expect(payload).toEqual({ code: 'bad_payload', message: 'nope', details: { field: 'qty' } });
  });

  it('passes an API error code straight through, with its context', () => {
    const apiError = Object.assign(new Error('sold out'), {
      code: 'sold_out',
      status: 409,
      conflicts: [{ label: 'A-1', status: 'booked' }],
      reason: 'not_enough_together',
    });
    expect(toErrorPayload(apiError, 'command_failed')).toEqual({
      code: 'sold_out',
      message: 'sold out',
      details: { status: 409, conflicts: [{ label: 'A-1', status: 'booked' }], reason: 'not_enough_together' },
    });
  });

  it('falls back for a plain Error and for non-error throws', () => {
    expect(toErrorPayload(new Error('boom'), 'command_failed')).toEqual({ code: 'command_failed', message: 'boom' });
    expect(toErrorPayload('boom', 'command_failed')).toEqual({ code: 'command_failed', message: 'boom' });
    expect(toErrorPayload(undefined, 'command_failed').code).toBe('command_failed');
  });
});
