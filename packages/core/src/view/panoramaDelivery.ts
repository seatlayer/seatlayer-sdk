/** Progressive delivery policy shared by the WebGL and DOM panorama viewers. */

export interface PanoramaDeliverySource {
  url: string;
  previewUrl?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  previewWidth?: number;
  previewHeight?: number;
}

export interface PanoramaDeliveryConstraints {
  saveData?: boolean;
  maxTextureSize?: number;
  maxDecodedBytes?: number;
}

export interface PanoramaDeliveryPlan {
  initialUrl: string;
  upgradeUrl?: string;
  initialWidth?: number;
  initialHeight?: number;
  reason: 'full-only' | 'progressive' | 'save-data' | 'texture-limit' | 'memory-limit';
}

/** Approximate GPU allocation including a complete mip chain (4/3 overhead). */
export function estimatePanoramaTextureBytes(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.ceil(width * height * 4 * (4 / 3));
}

/** Conservative per-panorama budget, raised only on devices reporting ample RAM. */
export function panoramaTextureBudgetBytes(deviceMemoryGb?: number): number {
  const mib = deviceMemoryGb !== undefined && deviceMemoryGb <= 2
    ? 32
    : deviceMemoryGb !== undefined && deviceMemoryGb >= 8
      ? 192
      : 96;
  return mib * 1024 * 1024;
}

export function browserPanoramaConstraints(maxTextureSize?: number): PanoramaDeliveryConstraints {
  const nav = typeof navigator === 'undefined'
    ? undefined
    : navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return {
    saveData: nav?.connection?.saveData === true,
    maxTextureSize,
    maxDecodedBytes: panoramaTextureBudgetBytes(nav?.deviceMemory),
  };
}

/** Select the first image and whether a later sharp-image upgrade is safe. */
export function planPanoramaDelivery(
  source: PanoramaDeliverySource,
  constraints: PanoramaDeliveryConstraints = {},
): PanoramaDeliveryPlan {
  const previewUrl = source.previewUrl?.trim();
  if (!previewUrl || previewUrl === source.url) {
    return {
      initialUrl: source.url,
      initialWidth: source.sourceWidth,
      initialHeight: source.sourceHeight,
      reason: 'full-only',
    };
  }

  const initial = {
    initialUrl: previewUrl,
    initialWidth: source.previewWidth,
    initialHeight: source.previewHeight,
  };
  if (constraints.saveData) return { ...initial, reason: 'save-data' };
  if (constraints.maxTextureSize !== undefined && source.sourceWidth !== undefined && source.sourceHeight !== undefined
    && Math.max(source.sourceWidth, source.sourceHeight) > constraints.maxTextureSize) {
    return { ...initial, reason: 'texture-limit' };
  }
  if (constraints.maxDecodedBytes !== undefined && source.sourceWidth !== undefined && source.sourceHeight !== undefined
    && estimatePanoramaTextureBytes(source.sourceWidth, source.sourceHeight) > constraints.maxDecodedBytes) {
    return { ...initial, reason: 'memory-limit' };
  }
  return { ...initial, upgradeUrl: source.url, reason: 'progressive' };
}

function abortError(): DOMException {
  return new DOMException('Panorama image load aborted', 'AbortError');
}

/** Decode before resolving so callers never upload or reveal a partial image. */
export function loadPanoramaImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    let settled = false;
    const cleanup = (): void => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(image);
    };
    const onAbort = (): void => {
      image.src = '';
      finish(abortError());
    };
    image.onload = () => {
      const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
      void decoded.then(() => finish(), () => finish());
    };
    image.onerror = () => finish(new Error('panorama_image_failed'));
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = url;
  });
}

/** Let the preview paint before starting a potentially large decode. */
export function schedulePanoramaUpgrade(work: () => void): () => void {
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (host.requestIdleCallback) {
    const id = host.requestIdleCallback(work, { timeout: 1200 });
    return () => host.cancelIdleCallback?.(id);
  }
  const id = globalThis.setTimeout(work, 32);
  return () => globalThis.clearTimeout(id);
}
