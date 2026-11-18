// @vitest-environment node
/** Server rendering never starts a bootstrap: the render-time prewarm is browser only. */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const prewarms: unknown[] = [];
vi.mock('@seatlayer/js', async () => ({
  ...(await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js')),
  prewarmSeatPicker: (options: unknown) => { prewarms.push(options); },
}));

describe('SeatingChart on the server', () => {
  it('renders markup and starts no request', async () => {
    const { SeatingChart } = await import('../src/SeatingChart');
    const html = renderToString(createElement(SeatingChart, { event: 'ev_ssr', publicKey: `pk_live_${'a'.repeat(48)}` }));
    expect(html).toContain('<div');
    expect(prewarms).toEqual([]);
  });
});
