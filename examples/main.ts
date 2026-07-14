import { SeatPicker, type CheckoutHandoff } from '@seatlayer/js';

const API = 'https://seatmap-api.paiteq.in';
// west-end-p3: multi-floor (Stalls/Dress Circle/Upper Circle), Adult/Concession/Child
// tiers on Stalls, 3 zoned sections per floor — exercises all P3 chrome.
// Override with ?event=arena-bowl-p3 (single-floor, 12 zoned sections) for rungs.
const EVENT = new URLSearchParams(location.search).get('event') || 'west-end-p3';

// Keep the latest checkout handoff so the "simulate payment" button below can
// book it via the dev-gated /pub book endpoint (prod books server-side with a
// secret key — a browser never books). Booking broadcasts a WS 'booked' delta,
// which the still-open widget turns into its onBooked + success state (P4).
let lastHandoff: CheckoutHandoff | null = null;

const inlinePicker = new SeatPicker({
  container: '#inline',
  event: EVENT,
  apiBase: API,
  confirmSelection: true,
  // P4: the THIRD arg is the stable CheckoutHandoff — build your order from it.
  onCheckout: (hold, seats, handoff) => {
    lastHandoff = handoff;
    console.log('[harness] checkout handoff', handoff);
    console.log('[harness]   holdId', handoff.holdId, 'currency', handoff.currency, 'total', handoff.total);
    console.log('[harness]   legacy args still present:', { hold, seats });
    (document.getElementById('pay-btn') as HTMLButtonElement).disabled = false;
  },
  // P4: fires when your server books the held seats while the widget is open.
  onBooked: (handoff) => {
    console.log('[harness] BOOKED', handoff);
    (document.getElementById('pay-btn') as HTMLButtonElement).disabled = true;
  },
  onHoldExpired: () => console.log('[harness] hold expired'),
});
inlinePicker.render();
// Dev-harness only: expose for scripted verification.
(window as unknown as { __picker: SeatPicker }).__picker = inlinePicker;

new SeatPicker({
  container: '#narrow',
  event: EVENT,
  apiBase: API,
  theme: { accent: '#E54558', accentInk: '#fff' },
  onCheckout: (_hold, _seats, handoff) => console.log('[harness] narrow checkout', handoff),
}).render();

document.getElementById('modal-btn')!.addEventListener('click', () => {
  void SeatPicker.open({
    event: EVENT,
    apiBase: API,
    onCheckout: (_hold, _seats, handoff) => console.log('[harness] modal checkout', handoff),
    onBooked: (handoff) => console.log('[harness] modal booked', handoff),
    onClose: () => console.log('[harness] modal closed'),
  });
});

// Simulate the host completing payment: book the held seats. The widget (still
// open) then flips to its booked-confirmation state via the realtime channel.
document.getElementById('pay-btn')!.addEventListener('click', async () => {
  if (!lastHandoff) return;
  const labels = lastHandoff.lineItems.map((i) => i.label);
  const res = await fetch(`${API}/pub/events/${EVENT}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels, holdId: lastHandoff.holdId, bookingRef: `harness-${Date.now()}` }),
  });
  console.log('[harness] book →', res.status, await res.json().catch(() => null));
});
