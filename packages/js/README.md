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

## Embed the live control room

`SeatManager` gives first-party dashboards and external platforms the same
realtime organizer cockpit. Mint a short-lived, event-scoped `mse_` token from
your backend, bound to the browser's exact origin and only the capabilities it
needs. The shared surface owns Monitor, Inspect, Block/unblock, fullscreen,
presence, exact section revenue, sales velocity, and a clearly explained **Sales momentum** overlay.
Block mode exposes explicit multi-select category state and a searchable,
section-filtered blocked-inventory list, so an organizer can put specific seats
back on sale without resetting the entire event.

```js
import { SeatManager } from '@seatlayer/js';

const manager = new SeatManager({
  container: '#control-room',
  apiBase: 'https://api.seatlayer.io',
  eventKey: 'ev_9f3a',
  token: session.token,
  tokenExpiresAt: session.expiresAt,
  onTokenRefresh: () => mintManageSession(),
});
await manager.render();
```

Switching tools and rotating tokens happen in place: the renderer, camera,
selection, WebSocket, and DOM are not remounted. Give the container a height;
the cockpit responds to its container rather than the browser viewport.

## Embed the chart Designer

For organizer-facing venue design, use `EmbeddedDesigner`. Your backend mints the
short-lived `designerUrl`; the browser receives no SeatLayer secret key. The wrapper
creates the iframe, recreates it for a new session URL, and validates every
`postMessage` by iframe source and exact Designer origin.

```js
import { EmbeddedDesigner } from '@seatlayer/js';

const designer = new EmbeddedDesigner({
  container: '#venue-designer',
  designerUrl: session.designerUrl, // returned by YOUR backend
  expectedChartId: session.chartId,
  expectedWorkspaceId: session.workspaceId,
  onPublished: ({ chartId }) => refreshVenue(chartId),
  onClose: () => closeVenueEditor(),
  onError: ({ code, message }) => showError(code ?? message),
});
designer.mount();

// On a new editor opening, use a new session and iframe:
designer.setDesignerUrl(nextSession.designerUrl);
// On route teardown:
designer.destroy();
```

Give the container a height, for example `min-height: 760px`. Keep the default
`referrerPolicy: 'origin'`; the Designer uses it to verify the parent origin.

## API

`new SeatingChart(options)` — options: `container` (selector or element, required),
`event` (key, required), `apiBase?`, `maxSelection?` (default 10), `onSelectionChange?`,
`onHold?`, `onError?`.

Methods: `render()`, `getSelection()`, `hold()`, `bestAvailable(qty, categoryKey?)`,
`release()`, `destroy()`.

The browser **holds**; your **server books** with a secret key. See the
[integration guide](https://docs.seatlayer.io/getting-started/how-it-works/).
