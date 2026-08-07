import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crossOriginWorker } from '../crossOriginWorker';

/**
 * The three tiers this plugin injects were each verified in a real browser
 * against the real CDN Worker (a direct cross-origin worker is refused; the blob
 * shim starts it; `worker-src 'none'` degrades to the main thread). They are
 * pinned here because two of the three only happen on someone else's origin
 * under someone else's CSP, where nothing we run can see them again.
 */
const render = (code: string): string => {
  const plugin = crossOriginWorker();
  const hook = plugin.renderChunk as (code: string) => { code: string } | null;
  const result = hook.call({}, code);
  return result ? result.code : code;
};

/**
 * Evaluate the injected helper with `Worker` under our control. The chunk body
 * is an arrow function that is never called, so loading it constructs nothing —
 * only the explicit spawn calls below do.
 */
function loadHelper(): (url: unknown, options?: unknown) => any {
  const code = render('const unused = () => new Worker(0);');
  // eslint-disable-next-line no-new-func
  return new Function(`${code}; return __slSpawnWorker;`)() as never;
}

describe('crossOriginWorker', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => 'blob:http://host.example/abc'),
      revokeObjectURL: vi.fn(),
    }));
  });

  it('routes worker construction through the shim', () => {
    const out = render('const w = new Worker(new URL("assets/x.js", import.meta.url), { type: "module" });');
    expect(out).not.toMatch(/=\s*new Worker\(new URL/);
    expect(out).toContain('__slSpawnWorker(new URL');
    expect(out).toContain('function __slSpawnWorker');
  });

  it('leaves a chunk that constructs no worker untouched', () => {
    expect(render('export const a = 1;')).toBe('export const a = 1;');
  });

  it('uses the direct worker when the constructor allows it (same-origin consumers)', () => {
    const made: unknown[] = [];
    class FakeWorker { constructor(url: unknown) { made.push(url); } }
    vi.stubGlobal('Worker', FakeWorker);
    const spawn = loadHelper();
    spawn('https://same-origin/x.js', { type: 'module' });
    expect(made).toEqual(['https://same-origin/x.js']);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('falls back to a same-origin blob that imports the cross-origin asset', () => {
    const made: unknown[] = [];
    const listeners: string[] = [];
    class FakeWorker {
      constructor(url: string) {
        // What Chrome does with a cross-origin script URL, whatever CORS says.
        if (!String(url).startsWith('blob:')) throw new Error('SecurityError');
        made.push(url);
      }

      addEventListener(type: string) { listeners.push(type); }
    }
    vi.stubGlobal('Worker', FakeWorker);
    let blobParts: string[] = [];
    vi.stubGlobal('Blob', class { constructor(parts: string[]) { blobParts = parts; } });
    const spawn = loadHelper();
    const worker = spawn('https://cdn.example/seatlayer-js@1.0.0/assets/scene.worker-abc.js', { type: 'module' });
    expect(made).toEqual(['blob:http://host.example/abc']);
    // The 128 KB worker stays a hashed CDN object; the blob is a pointer to it.
    expect(blobParts.join('')).toBe(
      'import "https://cdn.example/seatlayer-js@1.0.0/assets/scene.worker-abc.js";',
    );
    expect(worker).toBeTruthy();
    // Revocation is hung off the worker's own report, never a timer.
    expect(listeners).toEqual(['message', 'error']);
  });

  it('reports failure like a worker would when CSP refuses blob: too', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('CSP worker-src'); } });
    vi.stubGlobal('Blob', class {});
    const spawn = loadHelper();
    const worker = spawn('https://cdn.example/x.js', { type: 'module' });
    // Not null and not a throw: prepareScene assigns onerror and posts, and its
    // existing non-fatal fallback has to run rather than an unhandled rejection.
    const errored = await new Promise((resolve) => {
      worker.onerror = () => resolve(true);
      worker.postMessage({});
    });
    expect(errored).toBe(true);
    expect(() => worker.terminate()).not.toThrow();
  });
});
