import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const instances: MockDesigner[] = [];

class MockDesigner {
  options: Record<string, unknown>;
  mount = vi.fn();
  destroy = vi.fn();
  setSizing = vi.fn();
  setRelaunchPolicy = vi.fn();
  setDesignerUrl = vi.fn();
  getIframe = vi.fn(() => null);

  constructor(options: Record<string, unknown>) {
    this.options = options;
    instances.push(this);
  }
}

vi.mock('@seatlayer/js', () => ({ EmbeddedDesigner: MockDesigner }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  instances.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('EmbeddedDesigner reactive props', () => {
  it('updates height and minHeight in place without replacing the live iframe', async () => {
    const { EmbeddedDesigner } = await import('../src/EmbeddedDesigner');
    await act(async () => {
      root.render(createElement(EmbeddedDesigner, {
        designerUrl: 'https://designer.test/embed#one', height: 500, minHeight: 400,
      }));
    });
    const instance = instances[0]!;
    instance.setSizing.mockClear();

    await act(async () => {
      root.render(createElement(EmbeddedDesigner, {
        designerUrl: 'https://designer.test/embed#one', height: 'fill', minHeight: 720,
      }));
    });
    expect(instances).toHaveLength(1);
    expect(instance.destroy).not.toHaveBeenCalled();
    expect(instance.setSizing).toHaveBeenCalledWith('fill', 720);
  });

  it('adds and removes relaunch policy in place and calls the latest host callback', async () => {
    const { EmbeddedDesigner } = await import('../src/EmbeddedDesigner');
    await act(async () => {
      root.render(createElement(EmbeddedDesigner, {
        designerUrl: 'https://designer.test/embed#one',
      }));
    });
    const instance = instances[0]!;
    instance.setRelaunchPolicy.mockClear();
    const relaunch = vi.fn();

    await act(async () => {
      root.render(createElement(EmbeddedDesigner, {
        designerUrl: 'https://designer.test/embed#one',
        onRequestRelaunch: relaunch,
        autoRenewSession: true,
      }));
    });
    expect(instances).toHaveLength(1);
    const livePolicy = instance.setRelaunchPolicy.mock.calls.at(-1)!;
    expect(livePolicy[1]).toBe(true);
    expect(livePolicy[0]).toBeTypeOf('function');
    livePolicy[0]();
    expect(relaunch).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(createElement(EmbeddedDesigner, {
        designerUrl: 'https://designer.test/embed#one', autoRenewSession: false,
      }));
    });
    expect(instances).toHaveLength(1);
    expect(instance.setRelaunchPolicy).toHaveBeenLastCalledWith(undefined, false);
  });
});
