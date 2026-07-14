import { SeatPicker } from '@seatlayer/js';

const API = 'https://seatmap-api.paiteq.in';
const EVENT = 'seated-demo-1';

new SeatPicker({
  container: '#inline',
  event: EVENT,
  apiBase: API,
  onCheckout: (hold, seats) => console.log('[harness] checkout', hold, seats),
}).render();

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
