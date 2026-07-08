# @seatlayer/js

The framework-agnostic [SeatLayer](https://seatlayer.io) embed SDK. Render an
interactive seat map, let buyers select and **hold** seats in the browser, then
**book** them from your server. Full docs: <https://docs.seatlayer.io>

Works in plain HTML and any framework (React, Vue, Svelte, Angular…). For React,
prefer the [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) wrapper.

```bash
npm install @seatlayer/js
```

## Usage

```js
import { SeatingChart } from '@seatlayer/js';

const chart = new SeatingChart({
  container: '#chart',
  event: 'ev_9f3a',
  onHold: ({ holdId }) => bookOnYourServer(holdId),
});

await chart.render();
const hold = await chart.hold();          // null on a 409 conflict
// ... later
chart.destroy();
```

## Use in any framework

The SDK only needs a DOM element and mount/unmount hooks:

```js
// Vue
onMounted(() => { chart = new SeatingChart({ container: '#chart', event: 'ev_9f3a' }); chart.render(); });
onUnmounted(() => chart?.destroy());
```

Svelte → `onMount` / `onDestroy`. Angular → `ngAfterViewInit` / `ngOnDestroy`.

## API

`new SeatingChart(options)` — options: `container` (selector or element, required),
`event` (key, required), `apiBase?`, `maxSelection?` (default 10), `onSelectionChange?`,
`onHold?`, `onError?`.

Methods: `render()`, `getSelection()`, `hold()`, `bestAvailable(qty, categoryKey?)`,
`release()`, `destroy()`.

The browser **holds**; your **server books** with a secret key. See the
[integration guide](https://docs.seatlayer.io/getting-started/how-it-works/).
