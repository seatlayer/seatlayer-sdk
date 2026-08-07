import type { ChartDoc, ExpandedSeat } from '../core/types';
import { buildSceneModel, type SceneModel } from './scene/sceneModel';
import type { Scene3DPrepSource } from './analytics';

export interface PreparedVenue3D {
  model: SceneModel;
  buildMs: number;
  /** Reported on `3d_opened` as `prepSource`. `inline` is not reachable here —
   * it is what `mountVenue3D` reports when no prepared scene was handed in. */
  source: Exclude<Scene3DPrepSource, 'inline'>;
}

export interface PrepareVenue3DInput {
  doc: ChartDoc;
  seats: ExpandedSeat[];
  eventConfigurationId?: string;
}

function prepareOnMain(input: PrepareVenue3DInput): PreparedVenue3D {
  const started = performance.now();
  const model = buildSceneModel(input);
  return { model, buildMs: performance.now() - started, source: 'main' };
}

/**
 * Build the CPU-heavy merged mesh and seat buffers off the UI thread. Worker
 * failure is non-fatal: old browsers and restrictive hosts fall back to the
 * exact same pure compiler on the main thread.
 */
export function prepareVenue3D(input: PrepareVenue3DInput): Promise<PreparedVenue3D> {
  if (typeof Worker === 'undefined') return Promise.resolve(prepareOnMain(input));

  return new Promise((resolve) => {
    const worker = new Worker(new URL('./scene/scene.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (result: PreparedVenue3D): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      resolve(result);
    };
    const fallback = (): void => finish(prepareOnMain(input));
    const timeout = window.setTimeout(fallback, 15_000);
    worker.onerror = fallback;
    worker.onmessage = (event: MessageEvent<{ model: SceneModel; buildMs: number }>) => {
      finish({ model: event.data.model, buildMs: event.data.buildMs, source: 'worker' });
    };
    worker.postMessage(input);
  });
}
