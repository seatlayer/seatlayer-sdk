import { SeatPicker } from '@seatlayer/js';

const API = 'https://seatmap-api.paiteq.in';
// west-end-p3: multi-floor (Stalls/Dress Circle/Upper Circle), Adult/Concession/Child
// tiers on Stalls, 3 zoned sections per floor — exercises all P3 chrome.
// Override with ?event=arena-bowl-p3 (single-floor, 12 zoned sections) for rungs.
const EVENT = new URLSearchParams(location.search).get('event') || 'west-end-p3';

const inlinePicker = new SeatPicker({
  container: '#inline',
  event: EVENT,
  apiBase: API,
  confirmSelection: true,
  onCheckout: (hold, seats) => console.log('[harness] checkout', hold, seats),
});
inlinePicker.render();
// Dev-harness only: expose for scripted verification.
(window as unknown as { __picker: SeatPicker }).__picker = inlinePicker;

new SeatPicker({
  container: '#narrow',
  event: EVENT,
  apiBase: API,
  theme: { accent: '#E54558', accentInk: '#fff' },
}).render();

document.getElementById('modal-btn')!.addEventListener('click', () => {
  void SeatPicker.open({
    event: EVENT,
    apiBase: API,
    onCheckout: (hold) => console.log('[harness] modal checkout', hold),
    onClose: () => console.log('[harness] modal closed'),
  });
});
