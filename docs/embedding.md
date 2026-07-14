# Embedding the SeatPicker

`SeatPicker` is the full buyer experience in one mount — branded header, live
price panel, selection tray, GA steppers, hold countdown, snipe toasts, accessibility
filters, arena navigation and the P4 commerce chrome (extend-hold prompt + booked
confirmation). It is **container-adaptive**: give its host box a size and it lays
itself out for that box (side panel ≥ 960px, bottom sheet < 640px) — you do not
pick a layout.

Three ways to embed it: **inline** in a page, as a **modal** overlay, or as a
plain **iframe** with zero JS on your side. All three share the same
[checkout handoff contract](#checkout-handoff-oncheckout) and
[booked confirmation](#booked-confirmation-onbooked).

---

## 1. Inline (JS)

Mount into any sized element. The widget fills it and adapts to its width.

```html
<div id="seats" style="height:640px;max-width:1100px"></div>
<script type="module">
  import { SeatPicker } from '@seatlayer/js';

  const picker = new SeatPicker({
    container: '#seats',
    event: 'ev_9f3a',
    apiBase: 'https://api.seatlayer.io',
    // Optional: brand overrides (org theme from the chart is applied automatically).
    theme: { accent: '#E54558', accentInk: '#fff' },
    onCheckout: (hold, seats, handoff) => {
      // handoff = { holdId, expiresAt, currency, lineItems, total } — build your order from it.
      startYourCheckout(handoff);
    },
    onBooked: (handoff) => {
      // Your server booked the held seats — the widget is showing its success state.
      showReceipt(handoff);
    },
  });
  await picker.render();
</script>
```

## 1b. Inline (React)

```tsx
import { SeatPicker } from '@seatlayer/react';

<SeatPicker
  event="ev_9f3a"
  apiBase="https://api.seatlayer.io"
  style={{ height: 640, maxWidth: 1100 }}
  theme={{ accent: '#E54558', accentInk: '#fff' }}
  onCheckout={(hold, seats, handoff) => startYourCheckout(handoff)}
  onBooked={(handoff) => showReceipt(handoff)}
/>;
```

---

## 2. Modal (JS)

One call mounts a document-level modal — scrim, ESC/scrim-to-close, focus restore
and body-scroll lock are handled for you. No container needed.

```js
import { SeatPicker } from '@seatlayer/js';

document.querySelector('#buy').addEventListener('click', () => {
  SeatPicker.open({
    event: 'ev_9f3a',
    apiBase: 'https://api.seatlayer.io',
    onCheckout: (hold, seats, handoff) => startYourCheckout(handoff),
    onBooked: (handoff) => showReceipt(handoff),
    onClose: () => console.log('buyer dismissed the picker'),
  });
});
```

In React, import the framework-agnostic widget for the modal helper:

```tsx
import { SeatPickerWidget } from '@seatlayer/react';

<button onClick={() => SeatPickerWidget.open({ event: 'ev_9f3a', onCheckout })}>
  Buy tickets
</button>;
```

---

## 3. Plain iframe (no JS on your page)

Every published event has a hosted buyer page at
`https://seatmap.paiteq.in/e/<eventKey>` (prod: `https://app.seatlayer.io/e/<eventKey>`).
Drop it in an iframe — no SDK, no build step:

```html
<iframe
  src="https://seatmap.paiteq.in/e/ev_9f3a"
  title="Choose your seats"
  style="width:100%;height:720px;border:0;border-radius:16px"
  allow="clipboard-write"
></iframe>
```

The hosted page runs the same `SeatPicker`, so it inherits the org's theme,
currency and realtime updates. Use this when you want the picker on a page you
don't control the JS on (a CMS post, an email-linked landing page, a no-code site).

---

## Checkout handoff (`onCheckout`)

When the buyer presses the CTA and the hold succeeds, `onCheckout` fires with a
stable, self-contained **`CheckoutHandoff`** as the third argument:

```ts
interface CheckoutHandoff {
  holdId: string;        // pass this to YOUR book call
  expiresAt: number;     // epoch ms the hold expires (moves when the buyer extends)
  currency: string;      // ISO-4217, resolved server-side (per-event override → org → USD)
  lineItems: CheckoutLineItem[];
  total: number;         // Σ unitPrice × quantity, in major units
}

interface CheckoutLineItem {
  label: string;         // seat (or GA unit) label
  objectId: string;
  objectType: 'seat' | 'booth' | 'ga';
  categoryKey: string;
  tierId: string | null; // chosen ticket tier (Adult/Child/…), null if untiered
  unitPrice: number;     // major units, e.g. 45 = 45.00
  currency: string;
  quantity: number;
}
```

> **Backward compatibility:** the legacy `(hold, seats)` arguments are unchanged
> since SDK 0.6 — `onCheckout(hold, seats, handoff)` only *adds* the third
> parameter. Existing integrations keep working untouched; new ones should build
> against `handoff`.

Book the hold from **your server** with your secret key (a browser never books in
production):

```
POST https://api.seatlayer.io/v1/events/{eventKey}/book
Authorization: Bearer <your_secret_key>
{ "holdId": "<handoff.holdId>", "labels": [...], "bookingRef": "<your_order_id>" }
```

## Booked confirmation (`onBooked`)

After your server books the held seats, the booking is broadcast over the widget's
realtime channel. If the widget is still open it flips to a success state and fires
`onBooked(handoff)` — use it to advance your own UI (receipt, redirect). It fires
once per hold.

## Extend-hold ("Need more time?")

In the hold's final 60 seconds the widget shows a **"Need more time?"** prompt with
an **Add time** button that renews the hold server-side and resets the countdown
pill. This is automatic — no host wiring. The renewal is capped (a few times per
hold) so an abandoned cart can't hold inventory forever; once the cap is hit the
buyer is guided to check out.

## Currency

Prices render in the event's currency, resolved server-side: a per-event override
(set at event creation) wins, else the org's workspace currency, else USD. The
widget's `currency` option is only a last-resort fallback for the brief moment
before the chart loads.
