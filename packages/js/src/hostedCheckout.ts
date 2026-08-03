/**
 * Hosted checkout — the payment step, as a module nobody downloads until a
 * buyer actually asks to pay.
 *
 * This is the whole of what `checkout: 'hosted'` adds to SeatPicker: a card
 * that collects an email, starts a payment against `POST /pub/events/:key/
 * checkout`, hands off to the gateway, and waits for the webhook to land. It is
 * a straight port of the panel our own buyer page has shipped since hosted
 * checkout existed (`src/pages/CheckoutPanel.tsx`), with React and the app's
 * shared api client taken out.
 *
 * IT IMPORTS NOTHING AT RUNTIME. Not `@seatlayer/core`, not `./api`, not even a
 * type from `./SeatPicker` — every input arrives through {@link CheckoutMount},
 * including the two API calls, which arrive as functions. That is not
 * fastidiousness: this file is built as a standalone CDN asset
 * (`seatlayer-checkout.mjs`), and a single value import from the engine would
 * pull a second copy of it into that asset and undo the point of splitting.
 *
 * Three states, one card, because they are the same moment in the buyer's
 * journey and share every pixel of chrome:
 *
 *   pay          a live hold — collect an email and START a payment
 *   resume       back from a hosted gateway page — the hold and its line items
 *                are gone with the old document, so this can only WAIT on the
 *                order id that survived in the return URL. It must never offer
 *                to start a second payment for a purchase that may have already
 *                succeeded.
 *   unavailable  the event cannot take money here, and the buyer is holding
 *                seats. Say which of the three reasons it is, because two of
 *                them give opposite advice.
 */

/** The gateways `payment-options` can name. */
export type CheckoutProviderName = 'stripe' | 'razorpay';

/**
 * Why `payment-options` came back with an empty list. Mirrors the server enum
 * (`workers/api/src/checkout.ts`); see {@link unavailableCopy} for what each one
 * is allowed to say.
 */
export type CheckoutUnavailableReason =
  | 'not_configured'
  | 'payments_off_for_event'
  | 'unavailable_for_event';

/** What `POST /pub/events/:key/checkout` returns. Exactly one handoff is set. */
export interface CheckoutSessionResult {
  orderId: string;
  totalMinor: number;
  currency: string;
  expiresAt: number;
  /** Hosted gateway page (Stripe) — leave for it. */
  redirectUrl?: string;
  /** In-page modal gateway (Razorpay) — open it here. */
  clientPayload?: Record<string, unknown>;
}

/** What `GET /pub/orders/:id/status` returns while the webhook is in flight. */
export interface CheckoutOrderStatus {
  orderId: string;
  status: string;
  totalMinor: number;
  currency: string;
  amountFormatted: string;
  seatCount: number;
}

/** The buyer's held order, flattened out of the widget's CheckoutHandoff. */
export interface CheckoutOrderSummary {
  holdId: string;
  /** Epoch ms the hold expires — shown so the buyer knows their deadline. */
  expiresAt: number;
  currency: string;
  /** Total in MAJOR units, already carrying any host `pricing` overrides. */
  total: number;
  /** Buyer-facing unit labels (displayLabel where the designer set one). */
  labels: string[];
}

export type CheckoutState =
  | { kind: 'pay'; order: CheckoutOrderSummary; provider: CheckoutProviderName | null }
  | { kind: 'resume'; orderId: string }
  | { kind: 'unavailable'; reason: CheckoutUnavailableReason; seatCount: number };

export interface CheckoutMount {
  /** Where the card mounts — the widget root, so every `--sl-*` token inherits. */
  root: HTMLElement;
  state: CheckoutState;
  /** `POST /pub/events/:key/checkout`, already bound to the event and client. */
  startSession(input: {
    holdId: string; buyerEmail: string; buyerName?: string;
  }): Promise<CheckoutSessionResult>;
  /** `GET /pub/orders/:id/status`. */
  orderStatus(orderId: string): Promise<CheckoutOrderStatus>;
  /** Buyer backed out, or closed a finished card. The hold is NOT touched. */
  onCancel(): void;
  /** The webhook landed and the order is paid. Fires at most once. */
  onConfirmed(order: CheckoutOrderStatus): void;
  /** Anything the buyer was already told about, forwarded to the host. */
  onError?(err: unknown): void;
}

export interface CheckoutHandle {
  destroy(): void;
}

/** How long to wait on the webhook before telling the buyer to watch their email. */
const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 2_000;
const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
const STYLE_ID = 'seatlayer-checkout-style';

/**
 * The card's stylesheet. Every colour, font and radius is a `--sl-*` token the
 * widget root already defines, so an organizer's accent and a host's `theme`
 * overrides reach the payment step without this module knowing either exists.
 *
 * The `@sl-css` marker opts it into build-time minification — see
 * cdn/minifyCssLiterals.ts. Keep writing it long-hand.
 */
const CSS = /* @sl-css */ `
.sl-hco{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  padding:16px;background:color-mix(in srgb, var(--sl-bg) 82%, transparent);backdrop-filter:blur(3px)}
.sl-hco-card{width:100%;max-width:380px;max-height:100%;overflow:auto;padding:22px;
  background:var(--sl-surface);color:var(--sl-text);border:1px solid var(--sl-line);
  border-radius:var(--sl-radius);box-shadow:0 18px 48px rgba(0,0,0,.28)}
.sl-hco-title{margin:0 0 14px;font-size:19px;font-weight:650;letter-spacing:-.01em}
.sl-hco-summary{margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--sl-line)}
.sl-hco-seats{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.sl-hco-seat{padding:3px 8px;font-size:12px;font-weight:600;border-radius:calc(var(--sl-radius) * .5);
  background:var(--sl-bg);border:1px solid var(--sl-line)}
.sl-hco-total{display:flex;justify-content:space-between;align-items:baseline;font-size:14px}
.sl-hco-total strong{font-size:17px;font-weight:700}
.sl-hco-label{display:block;margin:12px 0 5px;font-size:12px;font-weight:600;color:var(--sl-muted)}
.sl-hco-input{width:100%;padding:10px 11px;font:inherit;font-size:15px;color:var(--sl-text);
  background:var(--sl-bg);border:1px solid var(--sl-line);border-radius:calc(var(--sl-radius) * .55)}
.sl-hco-input:focus-visible{outline:2px solid var(--sl-accent);outline-offset:1px}
.sl-hco-pay{width:100%;margin-top:16px;padding:12px;font:inherit;font-size:15px;font-weight:650;
  color:var(--sl-accent-ink);background:var(--sl-accent);border:0;
  border-radius:calc(var(--sl-radius) * .55);cursor:pointer}
.sl-hco-pay[disabled]{opacity:.5;cursor:default}
.sl-hco-back{width:100%;margin-top:8px;padding:10px;font:inherit;font-size:14px;color:var(--sl-muted);
  background:none;border:0;cursor:pointer;text-decoration:underline}
.sl-hco-note{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--sl-muted)}
.sl-hco-status{margin:8px 0 0;font-size:14px;line-height:1.55}
.sl-hco-error{color:var(--sl-danger, #c0392b)}
.sl-hco-receipt{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:14px 0 0;font-size:13px}
.sl-hco-receipt dt{color:var(--sl-muted)}
.sl-hco-receipt dd{margin:0;text-align:right}
.sl-hco-ref{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * Money for the buyer's eye. `Intl` is the right answer everywhere it exists;
 * the fallback is a plain amount and a code, which is never wrong — only plain.
 */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * What a buyer holding seats is told when the event cannot take their money,
 * and why the three differ. Pure, so the wording is unit-tested rather than
 * eyeballed.
 *
 *   not_configured         The organizer integrates by API and owns payment.
 *                          SeatLayer holds the inventory; their host takes the
 *                          money. Nothing is wrong and the buyer's checkout is
 *                          somewhere else on this very page.
 *   payments_off_for_event The organizer sells other events through us and chose
 *                          not to sell this one online. NOTHING IS WRONG.
 *                          Telling this buyer to "let the organiser know" would
 *                          send them to complain about a deliberate decision.
 *   unavailable_for_event  The organizer switched this event on and it still
 *                          cannot charge — a test key against a live event, or a
 *                          gateway disconnected after assignment. Something IS
 *                          wrong and only they can fix it.
 *
 * None of them names a provider, a mode or an account: the buyer is anonymous
 * and the reason enum is the entire disclosure budget.
 */
export function unavailableCopy(reason: CheckoutUnavailableReason, seatCount: number): {
  title: string; body: string; detail: string;
} {
  const held = `${seatCount} ${seatCount === 1 ? 'seat is' : 'seats are'} held for a limited time.`;
  if (reason === 'payments_off_for_event') {
    return {
      title: 'This event isn’t sold online',
      body: `${held} The organiser isn’t taking payment for this event here.`,
      detail: 'Nothing has been charged. Check where you found this event for how to get tickets.',
    };
  }
  if (reason === 'unavailable_for_event') {
    return {
      title: 'This event isn’t taking payment yet',
      body: `${held} Online payment is not switched on for this event.`,
      detail: 'Nothing has been charged. If you were sent here to pay, let the organiser know — '
        + 'only they can turn payment on for this event.',
    };
  }
  return {
    title: 'Finish in the ticketing checkout',
    body: `${held} Payment for this event is taken elsewhere.`,
    detail: 'Nothing has been charged. Continue in the checkout on this page to pay for your seats.',
  };
}

/**
 * Buyer-facing text for a server error code.
 *
 * Each one says what happened to their MONEY, because that is the only question
 * a buyer has at this moment. None of these paths can have charged them — the
 * charge does not exist until the gateway page — so every message says so.
 */
export function errorCopy(code: string | undefined): string {
  switch (code) {
    case 'gateway_not_connected':
    case 'payments_not_enabled_for_event':
      return 'This event is not taking online payments. Contact the organiser to buy these seats.';
    case 'provider_mismatch':
      // Only reachable if a caller sent a provider of its own. The widget never
      // does — it lets the event row decide — so this is a host integration bug,
      // and the buyer is told the one thing that is true for them.
      return 'This event’s payment setup changed while you were choosing. Nothing was charged — '
        + 'please try again.';
    case 'hold_not_active':
    case 'hold_not_found':
      return 'Your seats were released before checkout started. Nothing was charged — please pick again.';
    case 'checkout_already_started':
      return 'A payment for these seats is already in progress. Finish that one, or wait for it to '
        + 'time out before starting again.';
    case 'event_closed':
      return 'Sales for this event have closed.';
    case 'gateway_currency_mismatch':
    case 'unsupported_currency':
    case 'mixed_currency_hold':
    case 'price_unusable':
      return 'These seats cannot be checked out right now because of a pricing configuration '
        + 'problem. Nothing was charged — please contact the organiser.';
    case 'rate_limited':
      return 'Too many attempts. Wait a moment and try again.';
    default:
      return 'We could not start the payment. Nothing was charged — please try again.';
  }
}

/** Razorpay's script attaches this constructor; typed narrowly at the call site. */
interface RazorpayCheckout { open(): void }
type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayCheckout;

function loadRazorpay(): Promise<RazorpayConstructor> {
  const existing = (window as unknown as { Razorpay?: RazorpayConstructor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    // Reuse an in-flight tag if the buyer retries before the first load settles.
    const previous = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SCRIPT}"]`);
    const tag = previous ?? document.createElement('script');
    const done = (): void => {
      const ctor = (window as unknown as { Razorpay?: RazorpayConstructor }).Razorpay;
      if (ctor) resolve(ctor);
      else reject(new Error('razorpay_unavailable'));
    };
    tag.addEventListener('load', done, { once: true });
    tag.addEventListener('error', () => reject(new Error('razorpay_script_failed')), { once: true });
    if (previous) return;
    tag.src = RAZORPAY_SCRIPT;
    tag.async = true;
    document.head.appendChild(tag);
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: an event name, a seat label and a server
  // message all reach this card, and none of them is trusted markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount the payment card.
 *
 * Returns a handle rather than a promise: the card outlives the call (the buyer
 * types, pays, waits), and the widget needs a way to tear it down if the host
 * destroys the picker mid-payment.
 */
export function mountCheckout(mount: CheckoutMount): CheckoutHandle {
  ensureStyle();

  let live = true;
  let confirmed = false;
  const scrim = el('div', 'sl-hco');
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  const card = el('div', 'sl-hco-card');
  scrim.appendChild(card);

  const destroy = (): void => {
    live = false;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const cancel = (): void => {
    destroy();
    mount.onCancel();
  };
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !scrim.isConnected) return;
    // The picker has its own document-level ESC handler for modal mode. Stopping
    // here means one press closes the payment card, not the whole widget with a
    // payment possibly in flight.
    event.stopPropagation();
    event.preventDefault();
    cancel();
  }
  document.addEventListener('keydown', onKey, true);

  const title = el('h2', 'sl-hco-title', 'Checkout');
  const titleId = `sl-hco-t-${Math.random().toString(36).slice(2, 8)}`;
  title.id = titleId;
  scrim.setAttribute('aria-labelledby', titleId);

  /** Replace everything under the title — each phase owns the card's body. */
  const show = (...nodes: Node[]): void => {
    card.replaceChildren(title, ...nodes);
  };

  const fail = (message: string): void => {
    if (!live) return;
    const status = el('p', 'sl-hco-status sl-hco-error', message);
    status.setAttribute('role', 'alert');
    const back = el('button', 'sl-hco-back', 'Back to seats');
    back.type = 'button';
    back.addEventListener('click', cancel);
    show(status, back);
  };

  const waiting = (message: string): void => {
    if (!live) return;
    const status = el('p', 'sl-hco-status', message);
    status.setAttribute('role', 'status');
    show(status);
  };

  /**
   * Poll the order until the webhook lands.
   *
   * The buyer's browser is never the authority here — it is only waiting for
   * one. On timeout we tell them the truth (payment likely taken, confirmation
   * by email) rather than claiming a failure that did not happen.
   */
  const awaitConfirmation = async (orderId: string): Promise<void> => {
    waiting('Payment received — confirming your seats…');
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (live && Date.now() < deadline) {
      try {
        const body = await mount.orderStatus(orderId);
        if (!live) return;
        if (body.status === 'confirmed') {
          confirmed = true;
          title.textContent = 'Your tickets are confirmed';
          const status = el(
            'p', 'sl-hco-status',
            `${body.seatCount} ${body.seatCount === 1 ? 'seat' : 'seats'} confirmed. `
            + 'We have emailed your tickets.',
          );
          const receipt = el('dl', 'sl-hco-receipt');
          receipt.append(
            el('dt', undefined, 'Paid'),
            el('dd', undefined, `${body.amountFormatted} ${body.currency}`),
            el('dt', undefined, 'Order'),
            el('dd', 'sl-hco-ref', body.orderId),
          );
          const close = el('button', 'sl-hco-back', 'Close');
          close.type = 'button';
          close.addEventListener('click', cancel);
          show(status, receipt, close);
          mount.onConfirmed(body);
          return;
        }
        if (body.status === 'failed' || body.status === 'expired') {
          fail(body.status === 'expired'
            ? 'Your seats were released before payment completed. Nothing was charged — please pick again.'
            : 'The payment did not complete. If you were charged, it has been refunded automatically.');
          return;
        }
      } catch {
        // A transient blip while polling is not an answer. Keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
    }
    if (!live || confirmed) return;
    // Deliberately not an error: the money may well have gone through and the
    // webhook is just slow. The confirmation email is the durable receipt.
    fail('Still confirming with the payment provider. If your payment went through, your tickets '
      + 'will arrive by email shortly — you do not need to pay again.');
  };

  if (mount.state.kind === 'unavailable') {
    const copy = unavailableCopy(mount.state.reason, mount.state.seatCount);
    title.textContent = copy.title;
    const kicker = el('p', 'sl-hco-label', 'Seats held');
    const back = el('button', 'sl-hco-back', 'Back to seat map');
    back.type = 'button';
    back.addEventListener('click', cancel);
    card.replaceChildren(
      kicker, title,
      el('p', 'sl-hco-status', copy.body),
      el('p', 'sl-hco-note', copy.detail),
      back,
    );
    mount.root.appendChild(scrim);
    back.focus();
    return { destroy };
  }

  if (mount.state.kind === 'resume') {
    // A fresh document after a hosted gateway page. Everything except the order
    // id died with the old one, so this can only wait.
    mount.root.appendChild(scrim);
    void awaitConfirmation(mount.state.orderId);
    return { destroy };
  }

  const { order, provider } = mount.state;
  const summary = el('div', 'sl-hco-summary');
  const seats = el('div', 'sl-hco-seats');
  for (const label of order.labels) seats.appendChild(el('span', 'sl-hco-seat', label));
  const totalText = formatMoney(order.total, order.currency);
  const totalRow = el('div', 'sl-hco-total');
  totalRow.append(el('span', undefined, 'Total'), el('strong', undefined, totalText));
  summary.append(seats, totalRow);

  const form = el('form', 'sl-hco-form');
  const emailLabel = el('label', 'sl-hco-label', 'Email — your tickets go here');
  const email = el('input', 'sl-hco-input');
  email.type = 'email';
  email.required = true;
  email.autocomplete = 'email';
  email.placeholder = 'you@example.com';
  email.id = `${titleId}-email`;
  emailLabel.htmlFor = email.id;

  const nameLabel = el('label', 'sl-hco-label', 'Name (optional)');
  const name = el('input', 'sl-hco-input');
  name.type = 'text';
  name.autocomplete = 'name';
  name.placeholder = 'Your name';
  name.id = `${titleId}-name`;
  nameLabel.htmlFor = name.id;

  const pay = el('button', 'sl-hco-pay', `Pay ${totalText}`);
  pay.type = 'submit';
  pay.disabled = true;
  const back = el('button', 'sl-hco-back', 'Back to seats');
  back.type = 'button';
  back.addEventListener('click', cancel);

  const until = new Date(order.expiresAt)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const note = el(
    'p', 'sl-hco-note',
    `Your seats are held until ${until}. Payment is handled by `
    + `${provider === 'razorpay' ? 'Razorpay' : 'Stripe'} — we never see your card details.`,
  );

  const emailValid = (): boolean => /.+@.+\..+/.test(email.value.trim());
  email.addEventListener('input', () => { pay.disabled = !emailValid(); });

  const start = async (): Promise<void> => {
    waiting('Opening secure payment…');
    try {
      const body = await mount.startSession({
        holdId: order.holdId,
        buyerEmail: email.value.trim(),
        // Deliberately no `provider`: since W2 the EVENT row decides which
        // gateway charges, and naming one here can only ever 409 on a mismatch
        // the buyer cannot do anything about.
        ...(name.value.trim() ? { buyerName: name.value.trim() } : {}),
      });
      if (!live) return;

      // Hosted-page provider: leave the page. Where the gateway sends the buyer
      // back is the SERVER's choice, not ours — see the `checkout` option's note
      // in SeatPicker.
      if (body.redirectUrl) {
        waiting('Taking you to secure payment…');
        window.location.assign(body.redirectUrl);
        return;
      }

      // In-page modal provider — the embed never leaves the host's page.
      if (body.clientPayload) {
        const payload = body.clientPayload as {
          key: string; orderId: string; amount: number; currency: string;
          name: string; prefill?: { email?: string; name?: string };
        };
        const Razorpay = await loadRazorpay();
        if (!live) return;
        waiting('Waiting for payment…');
        new Razorpay({
          key: payload.key,
          order_id: payload.orderId,
          amount: payload.amount,
          currency: payload.currency,
          name: payload.name,
          prefill: payload.prefill,
          // The handler fires on the browser's word alone, so it only starts the
          // wait — the webhook is what actually confirms the order.
          handler: () => { void awaitConfirmation(body.orderId); },
          modal: { ondismiss: () => { if (live) details(); } },
        }).open();
        return;
      }

      fail(errorCopy('gateway_unavailable'));
    } catch (err) {
      mount.onError?.(err);
      fail(errorCopy((err as { code?: string } | null)?.code));
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (emailValid()) void start();
  });
  form.append(emailLabel, email, nameLabel, name, pay, back, note);

  const details = (): void => {
    title.textContent = 'Checkout';
    show(summary, form);
    pay.disabled = !emailValid();
  };
  details();
  mount.root.appendChild(scrim);
  email.focus();

  return { destroy };
}
