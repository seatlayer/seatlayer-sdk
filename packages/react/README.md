# SeatLayer React Seat Map SDK for Reserved Seating

[![npm](https://img.shields.io/npm/v/@seatlayer/react)](https://www.npmjs.com/package/@seatlayer/react)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/react)](https://www.npmjs.com/package/@seatlayer/react)
[![React](https://img.shields.io/badge/React-%E2%89%A517-61DAFB.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-types%20included-3178C6.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The official React components for SeatLayer reserved seating. Drop an
interactive seating chart or a complete seat picker into a ticketing app, show
live seat availability, and let buyers take temporary holds on the inventory
they choose.

Everything is a real React component with a typed imperative handle: the browser
selects and **holds**, and your trusted server **books** the hold.

[SeatLayer React SDK on npm](https://www.npmjs.com/package/@seatlayer/react) ·
[React seat-map documentation](https://docs.seatlayer.io/buyer-sdk/seat-picker/) ·
[SeatLayer reserved-seating platform](https://seatlayer.io/) ·
[Buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) ·
[SeatLayer JavaScript seat map SDK](https://www.npmjs.com/package/@seatlayer/js) ·
[SeatLayer Vue seat map SDK](https://www.npmjs.com/package/@seatlayer/vue) ·
[SeatLayer Angular seat map SDK](https://www.npmjs.com/package/@seatlayer/angular) ·
[SeatLayer React Native SDK](https://github.com/seatlayer/seatlayer-react-native) ·
[SeatLayer AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

## What is included

- `SeatingChart` — the headless interactive chart, mounted into a plain `<div>`
  your styles own.
- `SeatPicker` — the complete buyer experience: map, legend, tray, pricing, and
  the checkout hand-off.
- `SeatManager` — the organizer control room, for dashboards that monitor and
  block live inventory.
- `EmbeddedDesigner` — a hosted chart Designer inside your own application.
- `SeatPickerWidget` and `attachPickerFrame` — the framework-agnostic modal and
  iframe helpers, re-exported so a React host depends on this package alone.
- TypeScript declarations for ESM (`dist/index.d.ts`) and CommonJS
  (`dist/index.d.cts`), plus the `@seatlayer/react/manager` subpath.

## Requirements

- React 17 or newer (declared as a peer dependency).
- A browser DOM. The chart is created inside an effect, and this package ships
  no `'use client'` banner of its own — in the Next.js App Router, mark the
  component that imports it.

## Install

```bash
npm install @seatlayer/react
```

## Quick start

```tsx
import { useRef } from 'react';
import { SeatingChart, type SeatingChartHandle } from '@seatlayer/react';

export function Checkout() {
  const chart = useRef<SeatingChartHandle>(null);

  return (
    <SeatingChart
      ref={chart}
      event="ev_9f3a"
      publicKey="pk_live_your_publishable_key"
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

For the complete buyer experience — map, legend, priced tray, and the checkout
hand-off — render `SeatPicker` instead:

```tsx
import { SeatPicker } from '@seatlayer/react';

export function Tickets() {
  return (
    <SeatPicker
      event="ev_9f3a"
      publicKey="pk_live_your_publishable_key"
      style={{ width: '100%', height: 640 }}
      selectionValidators={[
        { type: 'minimumSelectedPlaces', minimum: 2 },
        { type: 'consecutiveSeats' },
        { type: 'noOrphanSeats' },
      ]}
      onCheckout={(hold, seats, handoff) => myServerTakesPayment(handoff)}
    />
  );
}
```

### Full SeatPicker imperative contract

The full-experience `SeatPicker` exposes the canonical safe widget controls through
`SeatPickerHandle`:

| React ref method | Contract |
| --- | --- |
| `close()` | Logically close the picker. The host should still unmount the React component. |
| `getSelection()` | Read the current priced selection. |
| `selectObjects()`, `deselectObjects()`, `clearSelection()` | Control selection by engine id or public label. |
| `selectCategories()`, `deselectCategories()` | Control every selectable object in named categories. |
| `setSelectableObjects()`, `setMaxSelection()`, `getSelectionValidity()` | Update selection policy and inspect exact-count validity. |
| `bestAvailable(qty, categoryKey?, options?)` | Pick and hold server-authoritative seats; options support `preferPremium` and `zoneId`. |
| `getCurrentHold()`, `resumeHold()`, `removeHeldTicket()`, `release()` | Inspect and manage the active hold. |
| `setMapTheme()`, `setEventDetailsHidden()`, `setPricing()` | Update host-owned presentation without remounting or losing a hold. |
| `isColorblindSafe()`, `setColorblindSafe()` | Read and update the shared buyer accessibility preference. |
| `getViewMode()`, `setViewMode()` | Read and update the 2D map projection. |
| `getBuyerView()`, `setBuyerView()` | Switch between the map and interactive 3D venue, including optional camera intent. |
| `refreshAccess()` | Re-acquire a private buyer-access session. |
| `destroy()` | Intentionally omitted: React owns teardown through component unmount. |

## Props

Extends the vanilla SDK options minus `container` (the component owns its own mount).

| Prop | Type | Notes |
| --- | --- | --- |
| `event` | `string` | **Required.** The event key, e.g. `ev_9f3a`. |
| `publicKey` | `string?` | Publishable browser key for public Platform events. Configure the browser origin in SeatLayer. |
| `apiBase` | `string?` | API origin. Defaults to the SeatLayer production API. |
| `maxSelection` | `number?` | Max seats selectable at once (default 10). |
| `selectedObjects` | `string[]?` | Initial object ids or public labels. |
| `selectableObjects` | `string[] \| null` | Buyer-selectable allow-list. |
| `numberOfPlacesToSelect` | `number?` | Exact count required for a valid selection. |
| `selectionValidators` | `PickerSelectionValidator[]?` | Minimum, consecutive-seat, and no-orphan guards. |
| `onSelectionChange` | `(seats) => void` | Fires when the selection changes. |
| `onSelectionValidityChange` | `(state) => void` | Rule state and typed `violations` after selection changes. |
| `onHold` | `(result) => void` | Fires when seats are held; hand `holdId` to your server. |
| `onHoldRestored` | `(result) => void` | Fires after `resumeHold()` verifies an active hold. |
| `onError` | `(err) => void` | Fires on errors. |
| `className` / `style` | — | Applied to the container element. |

Changing a callback prop does **not** rebuild the canvas. `selectedObjects` and
`selectableObjects` are initial values; use the imperative methods for later
changes. Exact count and validator props rebuild the chart.

## Security boundary

The React app **selects and holds** inventory. Your trusted backend **inspects
and books** the hold after payment or order validation.

- Never ship a SeatLayer secret key in browser code or in a bundled environment
  variable.
- A `pk_` public key is designed for browser code. SeatLayer binds it to the
  configured origin and event; keep private-channel access behind a server-minted
  `buyerAccessTokenProvider`.
- Send only the `holdId` and your normal checkout context to your backend.
- Calculate the charge from server-inspected hold items, not from browser input.
- Reuse your stable order id as `bookingRef` so a retried booking is idempotent.
- Organizer surfaces take a short-lived, event-scoped `mse_` browser grant —
  never a tenant `sk_` secret.

Read [how the integration works](https://docs.seatlayer.io/start/how-it-works/)
before connecting checkout.

## Architecture

These components are a thin React layer over
[`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js), the
framework-agnostic browser runtime. The wrapper mounts a plain `<div>`, builds
the chart inside an effect, forwards every prop and callback, and exposes the
runtime's imperative handle through `ref`. Chart geometry, availability, and
holds all come from the SeatLayer API at runtime, so the same event renders
identically on web and on the mobile SDKs.

Callback props are read through a ref, so changing one never tears the chart
down. Only the identity props listed above rebuild it.

## Embed the live control room

Use `SeatManager` with a short-lived, event-scoped manage token minted by your
backend. The `token` prop accepts an `mse_` browser grant; tenant `sk_` secrets
are unsupported in React/browser code and must stay on your server. Keep the
grant in memory, never in a URL, browser storage, or logs. Monitor, Inspect,
Block/unblock, fullscreen, presence, exact configured
booked value, booking velocity, and the **Booking momentum** overlay are one
shared package surface—not host-owned tabs.
Block mode includes explicit multi-select category controls plus a searchable,
section-filtered blocked-inventory list for restoring specific seats to sale.
Select mode adds host-owned initial/programmatic selection, availability policy,
maximum and exact-count rules, and validity callbacks. Capability-gated
Categories and Tables tools change only the event snapshot; table mode changes
fail safely while affected inventory is held, booked, or blocked.
Filter Sections groups duplicate public labels, frames their combined inventory,
and reports the matched sections through the React callback and ref methods.

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
continues an earlier session. See
[the embedded Designer guide](https://docs.seatlayer.io/platform/embedded-designer/).

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

## SeatingChart imperative handle

Every method the runtime exposes to a wrapper, reachable through the `ref`:

`hold` · `resumeHold` · `getCurrentHold` · `getGAAreas` · `holdGA` ·
`bestAvailable` · `release` · `releaseLabels` · `getSelection` ·
`selectObjects` · `deselectObjects` · `clearSelection` · `selectCategories` ·
`deselectCategories` · `setSelectableObjects` · `setMaxSelection` ·
`getSelectionValidity` · `setSeatTier` · `getFloors` · `setFloor` ·
`setColorblindSafe` · `zoomIn` · `zoomOut` · `zoomToFit` · `refreshAccess`

Calling any of them before the chart exists returns an empty answer rather than
throwing, so a ref used one frame early is safe.

## Callback props

| Prop | Payload |
| --- | --- |
| `onSelectionChange` | `SelectedSeat[]` |
| `onSelectionValidityChange` | Rule state with typed `violations` |
| `onSelectionValid` / `onSelectionInvalid` | Rule-validity transition |
| `onSelectionLimit` | Active numeric cap |
| `onHold` | `HoldResult` |
| `onHoldRestored` | `HoldResult` |
| `onHoldExpired` | — |
| `onGAClick` | `GAAreaAvailability` |
| `onError` | `unknown` |
| `onDeckTap` | `string` (floor id) |
| `onHint` | `string \| null` — `null` clears the hint |
| `onSeatHover` | `SeatHoverDetails \| null` — `null` when the pointer leaves |
| `onAccessExpired` | `BuyerAccessExpiredEvent` |
| `onAccessUnavailable` | `BuyerAccessUnavailableEvent` |
| `onSelectedObjectUnavailable` | `SelectedObjectUnavailableEvent` |

## Frequently asked questions

### How do I add a seat map to a React app?

Install `@seatlayer/react`, render `<SeatingChart event="ev_…" />` inside a
container with a definite height, and read the buyer's choice from
`onSelectionChange`. That is a complete interactive seating chart with live
availability; the quick start above is the whole integration, and the
[seat-picker documentation](https://docs.seatlayer.io/buyer-sdk/seat-picker/)
covers props, events, holds, and checkout in depth.

### Is this a real React component or an iframe?

`SeatingChart`, `SeatPicker`, and `SeatManager` are real React components that
render a plain `<div>` into your own tree — no iframe, no portal, and no
stylesheet of their own to fight with. `EmbeddedDesigner` is the one exception:
the organizer Designer is deliberately hosted in a sandboxed iframe so no
Designer credential ever reaches your bundle. If you *want* an iframe for the
buyer picker, `attachPickerFrame` is exported for that.

### What is the difference between `SeatPicker` and `SeatingChart`?

`SeatingChart` is the chart alone: it draws the venue, manages selection, and
hands you the seats — you build the surrounding UI. `SeatPicker` is the complete
buyer experience with legend, priced tray, hold timer, and checkout hand-off
already built. Start with `SeatPicker` if you want a working ticket flow today,
and drop to `SeatingChart` when your design system owns the chrome.

### How do temporary seat holds work?

When a buyer commits to a selection, `hold()` reserves that inventory against
concurrent buyers for a limited checkout window and returns an opaque `holdId`.
The hold lapses on its own if checkout never completes — `onHoldExpired` tells
the app to return the buyer to the map — and `resumeHold()` restores it after a
same-tab checkout navigation or a reload. This is what prevents double-selling
without locking seats forever.

### Can I use my own payment provider?

Yes. Nothing in this package takes a payment. The browser hands you a `holdId`
and a self-contained `CheckoutHandoff` with the priced line items, your backend
charges through whatever provider you already use, and it then books the hold
through the
[server-side checkout flow](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/).
The opt-in `checkout: 'hosted'` mode exists for hosts with no backend at all;
without it, no payment code is downloaded.

### Can I evaluate it without a SeatLayer account?

You can explore a live seating chart in the browser at the
[buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) with no
account. Rendering your own venue needs an event key, because the chart and its
availability are served by the SeatLayer API — create a free test event for
that, which books no real inventory.

### Does it work with Next.js and other React frameworks?

Yes, on the client. The chart is built inside an effect and touches the DOM only
there, so a server render emits the empty container. This package ships no
`'use client'` banner of its own, so in the App Router mark your own component
that imports it, or load it through `next/dynamic` with `ssr: false`.

## Continue your React integration

- [Follow the buyer SDK installation guide](https://docs.seatlayer.io/buyer-sdk/install/)
  for the full browser integration, options, and events.
- [Connect seat holds to secure server-side checkout](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/)
  without putting booking credentials in the browser.
- [Run the complete checkout example](https://docs.seatlayer.io/examples/complete-checkout/)
  to connect a buyer hold id to payment and idempotent booking.
- [Compare SeatLayer's mobile seat map SDKs](https://docs.seatlayer.io/buyer-sdk/mobile/)
  when the same event also has to render in native iOS, Android, Flutter, or
  React Native apps.
- [Read the embedded Designer guide](https://docs.seatlayer.io/platform/embedded-designer/)
  to let organizers draw their own venues inside your product.
- [Explore the 3D seating chart](https://seatlayer.io/3d-seat-map/) for the
  interactive venue view buyers can switch to from the map.
- [Point AI coding agents at the SeatLayer docs index](https://docs.seatlayer.io/llms.txt)
  (`llms.txt`) for an agent-readable map of the documentation.

## SeatLayer SDK ecosystem

| Surface | Package or source |
| --- | --- |
| JavaScript | [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) |
| React | [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) (this package) |
| Vue | [`@seatlayer/vue`](https://www.npmjs.com/package/@seatlayer/vue) |
| Angular | [`@seatlayer/angular`](https://www.npmjs.com/package/@seatlayer/angular) |
| React Native | [`@seatlayer/react-native`](https://www.npmjs.com/package/@seatlayer/react-native) |
| iOS | [`seatlayer-ios`](https://github.com/seatlayer/seatlayer-ios) |
| Flutter | [`seatlayer`](https://pub.dev/packages/seatlayer) |
| Android | [`seatlayer-android`](https://github.com/seatlayer/seatlayer-android) |
| Server SDKs | [Node.js, Python, PHP, Ruby, .NET, Java, and Go](https://docs.seatlayer.io/server-sdk/install/) |

## Development

```bash
pnpm install
pnpm verify
```

Source, issues, and contribution guidance live in
[seatlayer/seatlayer-sdk](https://github.com/seatlayer/seatlayer-sdk).

## License

MIT © SeatLayer
