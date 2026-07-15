# @seatlayer/react

React component for the [SeatLayer](https://seatlayer.io) embed SDK. Render an
interactive seat map, let buyers select and **hold** seats in the browser, then
**book** them from your server. Full docs: <https://docs.seatlayer.io>

```bash
npm install @seatlayer/react
```

## Usage

```tsx
import { useRef } from 'react';
import { SeatingChart, type SeatingChartHandle } from '@seatlayer/react';

export function Checkout() {
  const chart = useRef<SeatingChartHandle>(null);

  return (
    <SeatingChart
      ref={chart}
      event="ev_9f3a"
      style={{ width: '100%', height: 520 }}
      onSelectionChange={(seats) => console.log('selected', seats)}
      onHold={({ holdId }) => bookOnYourServer(holdId)}
    />
  );
}
```

Drive it imperatively through the ref:

```tsx
const hold = await chart.current?.hold();              // hold the selection (null on conflict)
const best = await chart.current?.bestAvailable(4);    // auto-pick 4 seats and hold them
await chart.current?.release();                        // release the current hold
```

## Props

Extends the vanilla SDK options minus `container` (the component owns its own mount).

| Prop | Type | Notes |
| --- | --- | --- |
| `event` | `string` | **Required.** The event key, e.g. `ev_9f3a`. |
| `apiBase` | `string?` | API origin. Defaults to the SeatLayer production API. |
| `maxSelection` | `number?` | Max seats selectable at once (default 10). |
| `onSelectionChange` | `(seats) => void` | Fires when the selection changes. |
| `onHold` | `(result) => void` | Fires when seats are held; hand `holdId` to your server. |
| `onError` | `(err) => void` | Fires on errors. |
| `className` / `style` | — | Applied to the container element. |

Changing a callback prop does **not** rebuild the canvas; only `event`, `apiBase`,
`maxSelection`, and `publicKey` do.

## The model

The browser **holds**; your **server books** with a secret key — a browser never
books directly. See the [integration guide](https://docs.seatlayer.io/getting-started/how-it-works/).

Built on [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js).

## Embed the live control room

Use `SeatManager` with a short-lived, event-scoped manage token minted by your
backend. Monitor, Inspect, Block/unblock, fullscreen, presence, exact section
revenue, velocity, and the **Sales momentum** overlay are one shared package surface—not host-owned tabs.

```tsx
<SeatManager
  ref={manager}
  apiBase="https://api.seatlayer.io"
  eventKey="ev_9f3a"
  token={session.token}
  tokenExpiresAt={session.expiresAt}
  onTokenRefresh={() => mintManageSession()}
  style={{ width: '100%', height: 'calc(100vh - 96px)' }}
/>
```

Token rotation and tool changes preserve the live renderer, camera, selection,
WebSocket, and DOM. The component responds to its own container, including
compact embeds, and the buyer SDK remains unchanged when manager options are off.

## Embed the chart Designer

`EmbeddedDesigner` gives an organizer a native-feeling Designer inside your React
application. Mint `designerUrl` from your backend — never from a browser using an
account secret key. The component verifies messages by iframe source, Designer origin,
and the chart/workspace ids you provide.

```tsx
import { EmbeddedDesigner } from '@seatlayer/react';

export function VenueEditor({ session }: { session: {
  designerUrl: string; chartId: string; workspaceId: string;
} }) {
  return (
    <EmbeddedDesigner
      designerUrl={session.designerUrl}
      expectedChartId={session.chartId}
      expectedWorkspaceId={session.workspaceId}
      style={{ width: '100%', height: 'calc(100vh - 96px)' }}
      onSaved={({ chartId }) => refreshVenue(chartId)}
      onPublished={({ chartId }) => refreshVenue(chartId)}
      onClose={() => closeVenueEditor()}
      onError={({ code, message }) => showError(code ?? message)}
    />
  );
}
```

Changing `designerUrl` replaces the iframe, so a newly-minted fragment token never
continues an earlier session. See [the embedded Designer guide](https://docs.seatlayer.io/guides/embedded-designer/).
