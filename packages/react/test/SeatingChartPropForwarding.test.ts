import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const constructed: Array<Record<string, unknown>> = [];
const destroyed: Array<unknown> = [];

// The binding contract (`bindSeatingChartHandle`, `buildSeatingChartOptions`) is
// imported REAL — it is what the wrapper is now a shell over, so faking it would
// fake away what this test checks. Only the chart class is a stub. That module
// has no runtime imports of its own, so pulling it in costs nothing.
vi.mock('@seatlayer/js', async () => ({
  ...(await vi.importActual<typeof import('@seatlayer/js')>('@seatlayer/js')),
  SeatingChart: class {
    constructor(options: Record<string, unknown>) { constructed.push(options); }
    render() { return Promise.resolve(); }
    destroy() { destroyed.push(this); }
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  constructed.length = 0;
  destroyed.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SeatingChart prop forwarding', () => {
  it('forwards initialView and errorDisplay, and remounts when either initial policy changes', async () => {
    const { SeatingChart } = await import('../src/SeatingChart');
    await act(async () => {
      root.render(createElement(SeatingChart, {
        event: 'ev_1', initialView: 'flat', errorDisplay: 'none',
      }));
    });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ initialView: 'flat', errorDisplay: 'none' });

    await act(async () => {
      root.render(createElement(SeatingChart, {
        event: 'ev_1', initialView: 'isometric', errorDisplay: 'message',
      }));
    });
    expect(constructed).toHaveLength(2);
    expect(destroyed).toHaveLength(1);
    expect(constructed[1]).toMatchObject({ initialView: 'isometric', errorDisplay: 'message' });
  });
});
