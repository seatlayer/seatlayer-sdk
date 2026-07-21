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
const restored = await chart.current?.resumeHold(savedHoldId);
await chart.current?.releaseLabels(['A-12']);          // keep the remainder held
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
| `onHoldRestored` | `(result) => void` | Fires after `resumeHold()` verifies an active hold. |
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
Block mode includes explicit multi-select category controls plus a searchable,
section-filtered blocked-inventory list for restoring specific seats to sale.

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
      onRequestRelaunch={async () => {
        const next = await mintDesignerSession(session.chartId);
        setDesignerUrl(next.designerUrl); // a new designerUrl recreates the iframe
      }}
    />
  );
}
```

Changing `designerUrl` replaces the iframe, so a newly-minted fragment token never
continues an earlier session. See [the embedded Designer guide](https://docs.seatlayer.io/guides/embedded-designer/).

The default `height: 'fill'` is **container-aware**: give the container element a
definite height (a fixed-height block, `flex-1 min-h-0`, a resolved `%`) and the
Designer fills 100% of it, tracking size changes live via a `ResizeObserver`; leave
it content-sized (e.g. `style={{ height: 'calc(100vh - 96px)' }}` full-page) and it
fills the viewport instead. The result is clamped to `minHeight` (default `480`) and
re-probed on resize. SDK-managed heights are applied with `!important`, so a host
theme's `iframe { height: … }` rule can't override them.

### Built-in loading, error, and expiry states

The component paints a branded loading skeleton inside its container until the
Designer reports `ready`, then removes it. On an expired session, identity
mismatch, iframe error, or a load timeout it shows a dark **"Try again"** card
with cause-specific copy. The skeleton honors `prefers-reduced-motion`.

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `showLoadingState` | `boolean?` | `true` | Render the built-in skeleton and error card. Set `false` to supply your own chrome. |
| `loadingTimeoutMs` | `number?` | `20000` | Show the error card if `ready` never arrives within this window. |
| `onRequestRelaunch` | `() => void` | — | Called by **"Try again"** _and_ by automatic renewal (below). Mint a fresh session and set a new `designerUrl` (which recreates the iframe and returns to loading). When omitted, "Try again" reloads the current URL. |
| `autoRenewSession` | `boolean?` | `true`¹ | Silently renew the session before it expires and auto-recover once if an expiry error slips through. ¹Defaults `true` only when `onRequestRelaunch` is provided; a no-op without it. Set `false` for fully manual "Try again". |

All props are optional and additive — existing integrations keep working
unchanged.

### Session lifecycle

Designer sessions are **short-lived by design**: your backend mints a `dse_`
token (default 1 hour, up to 4 hours via `expiresInSeconds`) baked into
`designerUrl`. Choose a TTL that matches how long organizers actually edit — the
renewal below keeps even a multi-hour session alive, so you needn't over-provision.

Pass `onRequestRelaunch` that mints (and awaits) a fresh session and updates the
`designerUrl` state, and the component makes expiry a non-event:

- **Silent proactive renewal** — from each `ready`'s `expiresAt` it schedules an
  automatic relaunch shortly before the session lapses (~3 min ahead, or after 80%
  of the remaining life for a sub-15-minute TTL, never sooner than 30s after
  `ready`), re-armed on every `ready`.
- **Automatic expiry recovery** — if an expiry error slips through anyway, it makes
  **one** automatic relaunch attempt before showing the "Try again" card.

The wrapper **recreates the iframe whenever `designerUrl` changes**, and
**in-progress work is autosaved server-side**, so relaunching is safe — the
organizer's chart is restored right where they left off.

```tsx
export function VenueEditor({ chartId }: { chartId: string }) {
  const [designerUrl, setDesignerUrl] = useState<string>();

  useEffect(() => {
    mintDesignerSession(chartId).then((s) => setDesignerUrl(s.designerUrl));
  }, [chartId]);

  if (!designerUrl) return null;
  return (
    <EmbeddedDesigner
      designerUrl={designerUrl}
      expectedChartId={chartId}
      style={{ width: '100%', height: 'calc(100vh - 96px)' }}
      // Mint a fresh session on renewal, expiry recovery, or "Try again":
      onRequestRelaunch={async () => {
        const next = await mintDesignerSession(chartId); // your backend, up to 4h TTL
        setDesignerUrl(next.designerUrl);                // swapping the URL recreates the iframe
      }}
      // autoRenewSession defaults to true because onRequestRelaunch is present.
    />
  );
}
```
