/**
 * Host-side helper for embedding the SeatLayer picker as an iframe.
 *
 * The picker (the /e/:key page, mounted `position:fixed; inset:0`) reports its
 * desired height and fullscreen intent to whatever page frames it, using the
 * picker wire contract:
 *
 *   • `{ type: 'seatlayer:height', px:number }`      — grow the iframe to `px`.
 *   • `{ type: 'seatlayer:fullscreen', on:boolean }` — pin/unpin over the host.
 *
 * A framed picker cannot escape its own iframe with CSS, so it delegates both
 * concerns to the host. `attachPickerFrame` wires those two behaviours onto a
 * picker iframe and returns a detach function that tears everything back down.
 */
export interface AttachPickerFrameOptions {
  /**
   * Origin to accept messages from. Defaults to the origin parsed from
   * `iframe.src`. Messages from any other origin (or any other window) are
   * ignored — the picker posts with `targetOrigin:'*'`, so the host is the side
   * that must verify `event.origin`.
   */
  origin?: string;
}

/**
 * Attach the picker resize + fullscreen protocol to a picker iframe.
 *
 * ```ts
 * const iframe = document.querySelector('iframe#seatlayer')!;
 * const detach = attachPickerFrame(iframe);
 * // …later, when removing the embed:
 * detach();
 * ```
 *
 * @param iframe The `<iframe>` element pointing at a SeatLayer picker embed.
 * @param opts   Optional `{ origin }` override for the accepted message origin.
 * @returns A detach function: removes the listener and restores any pinned state.
 */
export function attachPickerFrame(
  iframe: HTMLIFrameElement,
  opts: AttachPickerFrameOptions = {},
): () => void {
  let expectedOrigin = opts.origin ?? '';
  if (!expectedOrigin) {
    try {
      expectedOrigin = new URL(iframe.src, window.location.href).origin;
    } catch {
      expectedOrigin = '';
    }
  }

  let pinned = false;
  let frameStyleBeforeFs: string | null = null;
  let docOverflowBeforeFs: string | null = null;
  let bodyOverflowBeforeFs: string | null = null;
  let lastAutoHeight = '';
  let keyHandler: ((event: KeyboardEvent) => void) | null = null;

  const pin = (): void => {
    if (pinned) return;
    pinned = true;
    frameStyleBeforeFs = iframe.getAttribute('style');
    Object.assign(iframe.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      margin: '0',
      border: '0',
      zIndex: '2147483000',
      background: '#101625',
    } satisfies Partial<CSSStyleDeclaration>);

    const docEl = document.documentElement;
    docOverflowBeforeFs = docEl.style.overflow;
    docEl.style.overflow = 'hidden';
    if (document.body) {
      bodyOverflowBeforeFs = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    keyHandler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') unpin();
    };
    window.addEventListener('keydown', keyHandler);
  };

  const unpin = (): void => {
    if (!pinned) return;
    pinned = false;
    if (frameStyleBeforeFs === null) iframe.removeAttribute('style');
    else iframe.setAttribute('style', frameStyleBeforeFs);
    frameStyleBeforeFs = null;
    // Re-apply any height reported while we were pinned.
    if (lastAutoHeight) iframe.style.height = lastAutoHeight;

    if (docOverflowBeforeFs !== null) {
      document.documentElement.style.overflow = docOverflowBeforeFs;
      docOverflowBeforeFs = null;
    }
    if (bodyOverflowBeforeFs !== null && document.body) {
      document.body.style.overflow = bodyOverflowBeforeFs;
      bodyOverflowBeforeFs = null;
    }
    if (keyHandler) {
      window.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== iframe.contentWindow) return;
    if (expectedOrigin && event.origin !== expectedOrigin) return;
    if (!event.data || typeof event.data !== 'object') return;
    const data = event.data as Record<string, unknown>;

    if (data.type === 'seatlayer:height') {
      if (typeof data.px === 'number' && Number.isFinite(data.px) && data.px > 0) {
        lastAutoHeight = `${Math.round(data.px)}px`;
        // While pinned the iframe fills the viewport; the height is re-applied on unpin.
        if (!pinned) iframe.style.height = lastAutoHeight;
      }
      return;
    }
    if (data.type === 'seatlayer:fullscreen') {
      if (data.on === true) pin();
      else if (data.on === false) unpin();
    }
  };

  window.addEventListener('message', onMessage);

  return (): void => {
    window.removeEventListener('message', onMessage);
    unpin();
  };
}
