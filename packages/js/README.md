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
  // Mint a fresh session when the user retries an expired/failed editor:
  onRequestRelaunch: async () => {
    const next = await mintDesignerSession(session.chartId);
    designer.setDesignerUrl(next.designerUrl);
  },
});
designer.mount();

// On a new editor opening, use a new session and iframe:
designer.setDesignerUrl(nextSession.designerUrl);
// On route teardown:
designer.destroy();
```

Give the container a height, for example `min-height: 760px`. Keep the default
`referrerPolicy: 'origin'`; the Designer uses it to verify the parent origin.

### Built-in loading, error, and expiry states

By default the host paints a lightweight, branded skeleton inside the container
while the Designer boots, then removes it the moment the iframe reports `ready`.
If the session expires, the identity check fails, the iframe reports an error, or
it never becomes ready, the host swaps in a dark **"Try again"** card with copy
matched to the cause. The skeleton respects `prefers-reduced-motion` and adds no
CSS files or external assets.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `showLoadingState` | `boolean` | `true` | Render the built-in skeleton and error card. Set `false` when you draw your own chrome. |
| `loadingTimeoutMs` | `number` | `20000` | If `ready` never arrives within this window, show the error card with a timeout message. |
| `onRequestRelaunch` | `() => void` | — | Called by **"Try again"**. Mint a fresh session and call `setDesignerUrl()`; the iframe recreates and returns to loading. When omitted, "Try again" reloads the current URL in place. |

`setDesignerUrl()` always returns the host to the loading state, so a relaunch
flow needs no extra bookkeeping.

## API

`new SeatingChart(options)` — options: `container` (selector or element, required),
`event` (key, required), `apiBase?`, `maxSelection?` (default 10), `onSelectionChange?`,
`onHold?`, `onHoldRestored?`, `onError?`.

Methods: `render()`, `getSelection()`, `hold()`, `bestAvailable(qty, categoryKey?)`,
`resumeHold(holdId)`, `getCurrentHold()`, `releaseLabels(labels)`, `release()`, `destroy()`.

The full `SeatPicker` automatically restores an active hold after same-tab
checkout navigation and lets the buyer remove individual held tickets. Set
`restoreHold: false` and pass `initialHoldId` when your host owns persistence.

The browser **holds**; your **server books** with a secret key. See the
[integration guide](https://docs.seatlayer.io/getting-started/how-it-works/).
