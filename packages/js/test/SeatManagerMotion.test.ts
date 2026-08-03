/**
 * The cockpit's motion contract (docs/motion-system-2026-08-01.md §2, §3).
 *
 * These assertions exist because the two defects they cover were both invisible
 * to every other test — the suite was green while the surface was wrong:
 *
 *   1. The KPI bump ran at a hard-coded `.58s` against a catalog whose slowest
 *      non-ambient token is 320ms, so the cockpit tile and the dashboard tile it
 *      mirrors were visibly different speeds.
 *   2. The `prefers-reduced-motion` block was an ENUMERATED list of selectors.
 *      It had fallen behind the stylesheet, leaving the zoom hint, the toast and
 *      the availability rows animating for a user who asked the OS for none.
 *      A list drifts silently; nothing fails when it isn't updated. So the rule
 *      is now a blanket, and this file is what keeps it one.
 */
import { describe, expect, it } from 'vitest';
import { MANAGER_CSS } from '../src/SeatManager';
import { CHANNELS_CSS } from '../src/channelsMode';

/** motion-system §2. `--slm-mo-*` are the SDK's mirror of the `--mo-*` tokens. */
const TOKENS = {
  '--slm-mo-instant': '80ms',
  '--slm-mo-quick': '140ms',
  '--slm-mo-base': '200ms',
  '--slm-mo-slow': '320ms',
  '--slm-mo-ambient': '2000ms',
  '--slm-mo-out': 'cubic-bezier(.2,.8,.2,1)',
  '--slm-mo-in-out': 'cubic-bezier(.4,0,.2,1)',
  '--slm-mo-exit': 'cubic-bezier(.4,0,1,1)',
  '--slm-mo-spring': 'cubic-bezier(.34,1.3,.64,1)',
} as const;

/** Durations that are a deliberate "hold long enough to read", not transitions.
 *  Each is a stated moment in §3, so each is allowed to sit off the catalog. */
const READ_HOLDS = ['1.45s'];

describe('cockpit motion contract', () => {
  it('declares every motion token on the cockpit root, not only in Channels mode', () => {
    // The base cockpit animates with Channels mode unused. Borrowing the tokens
    // from CHANNELS_CSS made a token edit change only half the surface.
    for (const [token, value] of Object.entries(TOKENS)) {
      expect(MANAGER_CSS, `${token} must be declared by the cockpit root`)
        .toContain(`${token}:${value}`);
    }
  });

  it('keeps Channels mode on the identical token values', () => {
    for (const [token, value] of Object.entries(TOKENS)) {
      expect(CHANNELS_CSS, `${token} must not drift between the two stylesheets`)
        .toContain(`${token}:${value}`);
    }
  });

  it('uses tokens for every duration, with only the stated read-holds exempt', () => {
    const durations = [...MANAGER_CSS.matchAll(/(?:animation|transition)[^;{}]*?(\d*\.?\d+m?s)/g)]
      .map((match) => match[1]);

    // There is at least one — a regex that matched nothing would pass vacuously.
    expect(durations.length).toBeGreaterThan(0);

    const offCatalog = durations.filter((d) => !READ_HOLDS.includes(d));
    expect(offCatalog, `hard-coded durations must be tokens: ${offCatalog.join(', ')}`)
      .toEqual([]);

    // The specific regression: the bump is on the base token and the one
    // spring easing the surface is allowed (§2). The `.58s` it replaced is
    // caught by the sweep above, not by a string search — the comment recording
    // that history still contains the literal, and should.
    expect(MANAGER_CSS).toContain('animation:slm-kpi-bump var(--slm-mo-base) var(--slm-mo-spring)');
    // Channels mode's count bump is the SAME pattern (§3) and had the same
    // hard-coded duration; it must stay in step with the cockpit's.
    expect(CHANNELS_CSS).toContain('animation:slm-ch-bump var(--slm-mo-base) var(--slm-mo-spring)');
  });

  it('reduces motion across the whole subtree rather than a list that can drift', () => {
    const block = MANAGER_CSS.match(/@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/);
    expect(block, 'the cockpit must ship a reduced-motion block').not.toBeNull();

    const rules = block![1];
    // The blanket: root, every descendant, and both generated boxes.
    expect(rules).toContain('.slm,.slm *,.slm *::before,.slm *::after');
    expect(rules).toContain('animation:none!important');
    expect(rules).toContain('transition:none!important');
  });

  it('leaves Channels mode its static substitutes for the motion it removes', () => {
    // Reduced motion must remove MOTION, not the information it carried: the
    // shake and the success state still have to be visible without animating.
    const block = CHANNELS_CSS.match(/@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('.slm-ch-staged.shake{outline:');
    expect(block![1]).toContain('.slm-ch-staged.done{outline:');
  });
});
