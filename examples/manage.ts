import { SeatManager } from '@seatlayer/js';
import { SeatPicker } from '@seatlayer/js';

const q = new URLSearchParams(location.search);
const requestedWidth = Number(q.get('width'));
const requestedHeight = Number(q.get('height'));
const board = document.querySelector<HTMLElement>('#board');
if (board && Number.isFinite(requestedWidth) && requestedWidth >= 320) board.style.width = `${requestedWidth}px`;
if (board && Number.isFinite(requestedHeight) && requestedHeight >= 480) board.style.height = `${requestedHeight}px`;
const API = q.get('api') || 'https://seatmap-api.paiteq.in';
const EVENT = q.get('event') || 'west-end-p3';
// Reads (chart/objects/WS) are public; only writes need a real Bearer token
// (event-scoped mse_… or a tenant sk_…). Pass ?token=… to exercise block/unblock.
const TOKEN = q.get('token') || 'sk_dev_placeholder';

const manager = new SeatManager({
  container: '#board',
  apiBase: API,
  eventKey: EVENT,
  token: TOKEN,
  mode: (q.get('mode') as 'view' | 'inspect' | 'block') || 'view',
  onReady: () => console.log('[manage] ready'),
  onTallies: (t) => console.log('[manage] tallies', t),
  onControlRoom: (snapshot) => console.log('[manage] control-room', snapshot),
  onSelectionChange: (s) => console.log('[manage] selection', s.length),
  onActionComplete: (r) => console.log('[manage] action', r),
  onError: (e) => console.warn('[manage] error', e),
});
void manager.render();
(window as unknown as { __manager: SeatManager }).__manager = manager;

// A live buyer picker on the same event = a second client for cross-client tests.
const buyer = new SeatPicker({
  container: '#buyer',
  event: EVENT,
  apiBase: API,
  confirmSelection: true,
  onCheckout: (_h, _s, handoff) => {
    console.log('[buyer] checkout', handoff);
    // Dev-gated: complete the "payment" so the seats BOOK and broadcast a delta
    // the board renders in realtime (DEV_PUBLIC_BOOK=1 on the paiteq worker).
    const labels = handoff.lineItems.map((i) => i.label);
    void fetch(`${API}/pub/events/${EVENT}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels, holdId: handoff.holdId, bookingRef: `harness-${Date.now()}` }),
    }).then((r) => console.log('[buyer] book →', r.status));
  },
});
void buyer.render();
(window as unknown as { __buyer: SeatPicker }).__buyer = buyer;
