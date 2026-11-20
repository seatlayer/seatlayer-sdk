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
[React seat-map documentation](https://docs.seatlayer.io/buyer-sdk/react/) ·
[SeatLayer SDK and API overview](https://seatlayer.io/developers/) ·
[Buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) ·
[SeatLayer JavaScript seat map SDK](https://www.npmjs.com/package/@seatlayer/js) ·
[SeatLayer Vue seat map SDK](https://www.npmjs.com/package/@seatlayer/vue) ·
[SeatLayer Angular seat map SDK](https://www.npmjs.com/package/@seatlayer/angular) ·
[SeatLayer React Native SDK](https://github.com/seatlayer/seatlayer-react-native) ·
[SeatLayer AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

## What is included

- `SeatingChart`: the lower-level interactive chart, mounted into a plain `<div>`
  your styles own.
- `SeatPicker`: the complete buyer experience: map, legend, tray, pricing, and
  the checkout hand-off.
- `SeasonPicker`: season tickets. The buyer picks a seat once and holds it on
  every date of the season; returning holders can say they will renew. Same
  typed lifecycle and imperative handle as the other components.
- `SeatManager`: the organizer control room, for dashboards that monitor and
  block live inventory.
- `EmbeddedDesigner`: a hosted chart Designer inside your own application.
- `SeatPickerWidget` and `attachPickerFrame`: the framework-agnostic modal and
  iframe helpers, re-exported so a React host depends on this package alone.
- TypeScript declarations for ESM (`dist/index.d.ts`) and CommonJS
  (`dist/index.d.cts`), plus the `@seatlayer/react/manager` subpath.

## Requirements

- React 17 or newer (declared as a peer dependency).
- A browser DOM. The chart is created inside an effect, and this package ships
  no `'use client'` banner of its own. In the Next.js App Router, mark the
  component that imports it.

## Install

```bash
npm install @seatlayer/react
```

## Upgrading to 0.118.0

Nothing needs a code change. What a buyer may now see, in the Season picker unless named:

- **Step 1 in the buyer's language** from its first frame, not only once the map loads. An Arabic step 1 is right to left from the start.
- **"Change package?"**: Escape keeps the seats, as "Keep my seats" does, and Tab stays inside the prompt.
- **A package card that failed to load** can be pressed again, and the package that was on screen comes back chosen.
- **Single dates' times** on a 12-hour clock read "7:30 PM" (was "07:30 PM"). With `theme.mode`, a dark picker's date ticks are dark.
- **The phone cart names a table once** ("FLEX-8", was "FLEX-8-FLEX-8"), in every picker.
- **If you pay single dates yourself (`singleDates`):** a handoff that carries `dates` now has `planActivationId: ''`, because the hold is the run's. Read `handoff.dates` as before.
- **New, opt-in: `followOpening`.** The Season picker opens on what the Season's page opens with: the map, the passes, or its dates first with the passes as set chips (where single dates are offered; otherwise the passes). Off by default: every Season opens on the package step, as before.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.118.0 as well.

## Upgrading to 0.117.3

Nothing needs a code change, and no type, prop or string changed. What a buyer may now see, **on a phone only** (the picker's narrow layout, under 640 px wide; a computer is unchanged):

- **The cart is one row** (64 px): an arrow, the count and total over the chosen seats, and the main button on the right. It was a round handle over the map, a count line and a full-width button. A tap on the row opens the ticket list; a swipe on it climbs or drops one step, as before.
- **If your CSS or tests query the old handle:** `.sl-sheet-head` and `.sl-sheet-toggle` no longer exist; use `.sl-foot .sl-cart-chev` (same labels and `aria-expanded`). Read the count and total with `[data-ref=count]` and `[data-ref=total]`, not `.sl-total > span` / `> b`.
- **`host.foldedLine`** shows as the row's second line while nothing is chosen, instead of floating over the map.
- **The Test mode chip** sits in the map's top row, as on a computer.
- **A closed, invite-only or read-only picker** shows its words in the row and no dead button.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.117.3 as well.

## Upgrading to 0.117.2

Nothing needs a code change. What a buyer may now see:

- **Prices of exactly 0 read "Free"** in the seat card, the map's hover card and loupe, the screen-reader line and the map's zone labels (a zone with any paid place still reads "From <price>"). A range starting at 0 reads "Free–€20", as the price list does. A paid price and your own `pricing.formatter` are unchanged.
- **The screen-reader line for a focused seat** names its block, row and seat, as the cart does.
- **With the `host` option:** what it draws (the head, the folded line, the given-seat cards) loads as a separate chunk on first render; the picker waits for it (at most 4 s), so `hostHead()` is ready once it has rendered, as before. `host.categories` also limits the "Find seats together" card. If that chunk cannot load, `onError` hears `host_parts_unavailable` and the picker keeps working without those parts.
- **New, opt-in:** `host.closedNotice: false` (a closed or read-only picker stops saying sales are closed) and `host.titleRow: false` (hides the logo and event name under your own bar).
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.117.2 as well.

## Upgrading to 0.117.1

Nothing needs a code change, and no type or prop changed. What a buyer may now see:

- **A Season's ✕ on a held seat:** where the server supports it, the seat is given back from the same hold, which keeps its expiry. Your `onHoldChange` sees the same operation with fewer seats instead of `null` and a new one.
- **A page with `theme.mode`:** a chart whose map ground the organiser chose keeps it; template charts follow the page as before.
- **Seats already the buyer's (`host.givenSeats`):** they wear the buyer's own colour on the map.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.117.1 as well.

## Upgrading to 0.117.0

Nothing needs a code change. What a buyer may now see:

- **A free event's cart:** an amount of exactly 0 in the cart (the total, a ticket card, a standing-area line, the seat card and the table dialog) reads "Free" instead of "$0", as the price list already did. A page with its own `pricing.formatter` keeps its own words for 0.
- **A dark page with a very dark brand colour:** the main buttons (the cart button, "Find best seats", a Season's "Choose seats") turn to stay visible: the colour's ink fills them and the colour becomes their text. Light pages and pages with no `theme.mode` are unchanged.
- **New, opt-in:** `<SeatPicker host={…}>` (the picker's `host` option: a head element, a folded phone line, button words, `onPress` before any hold, read-only cards for seats already the buyer's, the categories listed, `findTogether: false`), with `hostHead()` and `setHost(patch)` on the ref. `<SeasonPicker singleDates>` and `startDatesCheckout()` on its ref, for a page with its own session or checkout.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.117.0 as well.

## Upgrading to 0.116.2

Nothing needs a code change, and no type or prop changed. What a buyer sees is unchanged: this release adds single dates for Season pages that supply their own session or checkout (the `singleDates` option of `@seatlayer/js`), which is off unless a page asks for it.

- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.116.2 as well.

## Upgrading to 0.116.1

Nothing needs a code change, and no type or prop changed. What a buyer may now see:

- **Season ✕ on a held seat:** Continue is disabled while the ✕ runs, instead
  of ignoring the press.
- **Season single dates:** a price whose top is not known reads "from €25" in
  the price list.
- **The map toolbar:** on a map about 500 px wide, Zones / Sections / Seats
  takes its own row instead of sitting under Map / 3D.
- **Test mode:** the "Test mode" chip never covers seats. On a phone it sits in
  the head of the sheet.
- **A Season with `theme.mode`:** its first step follows the mode, as its map
  already did. Without a mode, nothing changes.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.116.1 as well.

## Upgrading to 0.116.0

Nothing needs a code change, and no type or prop changed. What a buyer may now see:

- **A held Season seat has a ✕.** Removing one seat from a Season hold lets the
  whole hold go and holds the seats kept again as one new hold, so your
  `onHoldChange` sees `null` and then a hold with a new operation id. The last
  seat's ✕ simply releases it. There is no ✕ where your selection rules
  (`numberOfPlacesToSelect`, `selectionValidators`) would refuse the seats
  kept, nor while sales are closed.
- **Season single dates**, only on a Season the organizer sells by date as
  well, with SeatLayer's own checkout, on a page that mints its own session:
  step 1 offers "Single dates" beside the passes, and the buyer books the same
  seat on the dates they tick, each at its own price, in one checkout.
  Everywhere else nothing changes.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.116.0 as well.

## Upgrading to 0.115.0

Nothing needs a code change, and no type or prop changed. What a buyer may now see:

- **A Season map shows the package price.** The map's hover card, its
  screen-reader line and the price legend show the price of the package being
  bought, not one date's ticket price. If a category has no package price, the
  map shows no price rather than a wrong one.
- **A Season hold that runs out says so on screen**, above the map, in one
  sentence. On a phone the step line no longer shows a step number, and a
  Season of several dates no longer shows only its first date in the map's
  header.
- **With `webMcp` on**, the browser tools load from one more small file, so
  they register a moment later. If you serve your own copy of the CDN files,
  copy `seatlayer-webmcp.mjs` beside `seatlayer.js`. Without it, the tools are
  not registered (a console warning says why) and the picker works as usual.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.115.0 as well.

## Upgrading to 0.114.0

No existing type or prop changed. Two additions, and what a buyer may now see.

New on `SeasonPicker`:
- `tryRelease(releaseActionId)` on the `SeasonPicker` ref resolves `true` when the seats were
  let go and `false` when nothing was held or the server kept them. It never
  rejects for a failed release; `release()` stays as it was.
- a `releaseHoldOnDestroy` prop (default `false`). When true, unmounting releases a hold the buyer left
  unfinished. A hold that was continued, handed off, restored, booked or kept
  is never released. It is off by default because hosts that rebuild the
  picker, or hand the hold to their own checkout, rely on the hold surviving.

What changes without asking for it:
- **A short server stall heals on its own in more places.** A read of the map,
  its availability or an order's status that meets a `503` with
  `retryable: true` is sent again (at most three times, 2, 4 and 8 seconds
  apart, at least the server's `Retry-After`), so it may resolve up to about
  14 seconds later instead of failing at once. A busy Season is tried again
  for up to 7 seconds before its error. Writes are never resent.
- **A Season release says what really happened.** A release the server refuses
  no longer announces that the seats were released, and the buyer stays on the
  map. A release that ends booked or expired reports once through `onError`.
  When the picker had to send the release itself, `release()` then rejects
  with that error (`SeasonApiError`, code `season_already_booked` or
  `hold_not_active`) where it used to resolve; `tryRelease()` answers `false`.
- **A `release()` just before the picker unmounts now reaches the server.**
  Before, it could be dropped unsent.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.114.0 as well.

## Upgrading to 0.113.0

Nothing needs a code change, and no type changed. What a buyer sees:

- **A short server stall heals on its own.** A hold, release or resume that
  gets no answer is sent again (at most three tries, seven seconds of waiting),
  and the map's first load tries again for up to about 30 seconds while the
  picker says it is taking longer. A real outage still ends on the same panel
  and Try again button, only later.
- **"Check your connection and try again."** A hold or best-available that
  still gets no answer says this and keeps the selection, where it used to say
  the seats were taken.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.113.0 as well.

## Upgrading to 0.112.0

Nothing needs a code change. Four things to know:

- **`SeatingChart` now honours `enable3D`, `enable3DCrowd` and
  `touchNavigation3D`.** Before 0.112.0 it ignored them. If your page already
  passes one, it takes effect when you upgrade: `enable3D={false}` hides the 3D
  view, `enable3DCrowd={false}` leaves standing areas an empty floor in 3D, and
  `touchNavigation3D="classic"` keeps the earlier touch gestures. Unset, `true`
  and `"map"` change nothing. `SeatPicker` and `SeasonPicker` already honoured
  all three.
- **Changing one of the three after mount rebuilds the chart.** A page that
  drives `enable3D` from state, for example from the screen width, now remounts
  the chart each time the value changes, as a change of `event` or `locale`
  does. Set it once where you can.
- **Types.** `SeatPickerHandle` gains a required `markBooked`, and
  `SeatManagerHandle` gains required `setMarkedObjects`, `setClosedObjects` and
  `setChannelSeats`. Code that builds its own object of these types, such as a
  test double, must add them. Use through a ref is unaffected.
- **One version of the SDK.** `@seatlayer/js` and `@seatlayer/core` are
  dependencies of this package, pinned to the same version. If your app also
  installs `@seatlayer/js` itself, move it to 0.112.0 as well; an older direct
  install leaves two copies of the SDK in your bundle.

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

### Season tickets: the same seat on every date

```tsx
const season = useRef<SeasonPickerHandle>(null);

<SeasonPicker
  ref={season}
  season="sea_2027"
  buyerAccessToken={session.token}
  onContinue={(handoff) => continueOnYourServer(handoff.operationId)}
/>

await season.current?.holdSameSeat(['A-1'], 'sop_checkout_1183');
// Or let SeatLayer pick the best 2 seats free on every date:
await season.current?.holdBestAvailable(2, 'sop_checkout_1184', { categoryKey: 'stalls' });
```

The browser handoff is opaque and price-free. Its `pricingAuthority: "host"`
and `authoritativeAmountIncluded: false` flags mean trusted server code must
apply the package price, tax, and payment decision before booking the
identity-only allocation. `SeasonPicker` is supported in `@seatlayer/react`
`0.72.0` and newer.

To sell child or concession seats too, pass `priceTypes={['adult', 'child']}`:
the buyer chooses a type per seat before the hold, and the handoff's `seats`
lists each seat's `priceTypeKey`. `holdSameSeat(labels, operationId,
{ 'A-2': 'child' })` names them yourself; a label left out is adult.

The Season picker takes the same three 3D props as the seating chart:
`enable3D`, `enable3DCrowd` and `touchNavigation3D`. Changing one rebuilds it.

The picker opens on step 1, the package with its dates and prices. Pass
`package="spl_half"` (the package's key) to open on that package instead of the
Season's first one; a host token is already bound to one package, so it ignores
this. If your own checkout emails a ticket for every date, pass
`ticketsByEmail` and step 1 says so.

With SeatLayer checkout, pass `buyerEmail` and `buyerName` to fill in the
payment card for a signed-in member; the buyer can still change them. On your
own checkout, call `season.current?.markBooked()` once your server has booked
the hold: the picker shows the booked screen instead of offering checkout again.

Since 0.111.0, `season.current?.getHeldOrder()` gives the held order for your
own summary: each held seat with its price type and package price, the
currency and the total in minor units (null with no live hold). It is for
display; checkout prices the order on the server. In 3D, standing areas now
show a crowd and one finger moves the view like the 2D map; pass
`enable3DCrowd={false}` or `touchNavigation3D="classic"` to `SeatPicker` or
`SeasonPicker` to keep the earlier look or gestures.

Since 0.117.0, a page with its own checkout or session can pass `singleDates`
to offer the Season's single dates beside the passes (off by default; changing
it rebuilds the picker). Continue on a dates hold calls `onContinue` with a
handoff whose `dates` names the run, the dates and the held lines. To take the
payment on SeatLayer's checkout from your own page, call
`season.current?.startDatesCheckout({ buyerEmail, buyerName?, returnUrl? })`.
Like the hold methods, it throws while the picker is not mounted.

For the complete buyer experience (map, legend, priced tray, and the checkout
hand-off), render `SeatPicker` instead:

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
| `markBooked(holdId?)` | Your page booked the held seats itself: the picker shows its booked state, calls `onBooked` once and unticks that hold's seats. Resolves `false`, changing nothing, for another hold id, no active hold or an unmounted picker. It never books or releases on the server. Right after a rebuild the picker restores a live hold asynchronously: call `markBooked` after `onHoldRestored`, or call it again when it resolves `false` while you expect a hold (see the note under this table). `SeatPicker` only: the `SeatingChart` wrappers (React, Vue, Angular) do not have it. |
| `setMapTheme()`, `setEventDetailsHidden()`, `setPricing()` | Update host-owned presentation without remounting or losing a hold. |
| `isColorblindSafe()`, `setColorblindSafe()` | Read and update the shared buyer accessibility preference. |
| `getViewMode()`, `setViewMode()` | Read and update the 2D map projection. |
| `getBuyerView()`, `setBuyerView()` | Switch between the map and [interactive 3D seat views](https://seatlayer.io/3d-seat-map/), including optional camera intent. |
| `refreshAccess()` | Re-acquire a private buyer-access session. |
| `hostHead()` | The empty element `host={{ head: true }}` asked for, at the head of the ticket panel and the top of the opened phone sheet. Fill it with a portal. Null without `host.head` or while the picker is not mounted; a rebuild makes a new element. |
| `setHost(patch)` | Change `host` fields on the live picker (a shallow merge): the button's words, the folded line, the given seats, the categories. Does nothing while the picker is not mounted. |
| `destroy()` | Intentionally omitted: React owns teardown through component unmount. |

**`markBooked` after a rebuild.** When the picker rebuilds (a prop change that
remounts it, or a page reload), it restores a live hold asynchronously.
`markBooked(holdId)` called before the hold is back resolves `false`, and the
restored hold then offers checkout again. Call it after `onHoldRestored` fires,
or call it again when it resolves `false` while you expect a hold.

**Your own words in the picker (`host`).** Since 0.117.0, the `host` prop puts
your page's words, head and confirm step into the picker's panel and cart
instead of a second panel beside it: `head`, `foldedLine`, `buttonWords`,
`onPress`, `givenSeats`, `categories` and `findTogether: false` (see
`SeatPickerHostOptions`). Every field is optional. `host` is read when the
picker is built and is not a rebuild trigger, so an inline object never remounts
it. `onPress` and `buttonWords` always call the function from your latest
render. To change any other field on a live picker, call
`ref.current?.setHost(patch)`: a changed `host` prop does not reach it.

### Buyer WebMCP tools

Set `webMcp` on `SeatPicker` to let a compatible in-browser assistant describe
the event, find seats, select them on the map, and read the current selection:

```tsx
import { SeatPicker } from '@seatlayer/react';

<SeatPicker
  event="ev_9f3a"
  publicKey="pk_live_your_publishable_key"
  webMcp
  style={{ width: '100%', height: 640 }}
  onCheckout={(hold) => {
    void continueCheckoutOnYourServer(hold.holdId).catch(showCheckoutError);
  }}
/>
```

`continueCheckoutOnYourServer` and `showCheckoutError` are supplied by your
application. The first owns the async server request; `.catch(...)` surfaces a
rejected checkout.

WebMCP is off by default and inert in browsers without the API. Use
`webMcp={{ holds: true }}` only when the assistant should also be able to place
a temporary hold. The tools do not take payment or book seats; see the
[buyer WebMCP seat-selection guide](https://docs.seatlayer.io/buyer-sdk/webmcp-agent-tools/)
for iframe origin controls and the complete tool contract.

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
| `enable3D` | `boolean?` | Offer the 3D venue view. On by default; `false` hides it. |
| `enable3DCrowd` | `boolean?` | The standing crowd in 3D. Drawn by default; `false` turns it off. |
| `touchNavigation3D` | `'map' \| 'classic'?` | How fingers move the 3D view. `'map'` by default; `'classic'` keeps the older gestures. |
| `onSelectionChange` | `(seats) => void` | Fires when the selection changes. |
| `onSelectionValidityChange` | `(state) => void` | Rule state and typed `violations` after selection changes. |
| `onHold` | `(result) => void` | Fires when seats are held; hand `holdId` to your server. |
| `onHoldRestored` | `(result) => void` | Fires after `resumeHold()` verifies an active hold. |
| `onError` | `(err) => void` | Fires on errors. |
| `className` / `style` | not applicable | Applied to the container element. |

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
- Organizer surfaces take a short-lived, event-scoped `mse_` browser grant,
  never a tenant `sk_` secret.

Read [how the integration works](https://docs.seatlayer.io/start/how-it-works/)
before connecting checkout.

## Architecture

These components are a thin React layer over
[`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js), the
framework-agnostic browser runtime. The wrapper mounts a plain `<div>`, builds
the chart inside an effect, forwards every prop and callback, and exposes the
runtime's imperative handle through `ref`. Chart geometry, availability, and
holds all come from the SeatLayer API at runtime, so the same chart and event
inventory can be reused across supported web and mobile SDKs.

Callback props are read through a ref, so changing one never tears the chart
down. Only the identity props listed above rebuild it.

## Embed the live control room

Use `SeatManager` with a short-lived, event-scoped manage token minted by your
backend. The `token` prop accepts an `mse_` browser grant; tenant `sk_` secrets
are unsupported in React/browser code and must stay on your server. Keep the
grant in memory, never in a URL, browser storage, or logs. Monitor, Inspect,
Block/unblock, fullscreen, presence, exact configured
booked value, booking velocity, and the **Booking momentum** overlay are one
shared package surface, not host-owned tabs.
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

`markedObjects={['B-12']}` rings seats in ink (paint only), for example a
guest's current seat while you move them; a new array moves the rings in place,
and the ref's `setMarkedObjects(labels)` does the same.

Token rotation and tool changes preserve the live renderer, camera, selection,
WebSocket, and DOM. The component responds to its own container, including
compact embeds, and the buyer SDK remains unchanged when manager options are off.

## Embed the chart Designer

`EmbeddedDesigner` gives an organizer the hosted Designer inside your React
application. Mint `designerUrl` from your backend, never from a browser using an
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
| `onRequestRelaunch` | `() => void` | none | Called by **"Try again"** _and_ by automatic renewal (below). Mint a fresh session and set a new `designerUrl` (which recreates the iframe and returns to loading). When omitted, "Try again" reloads the current URL. |
| `autoRenewSession` | `boolean?` | `true`¹ | Silently renew the session before it expires and auto-recover once if an expiry error slips through. ¹Defaults `true` only when `onRequestRelaunch` is provided; a no-op without it. Set `false` for fully manual "Try again". |

All props are optional and additive: existing integrations keep working
unchanged.

### Session lifecycle

Designer sessions are **short-lived by design**: your backend mints a `dse_`
token (default 1 hour, up to 4 hours via `expiresInSeconds`) baked into
`designerUrl`. Choose a TTL that matches how long organizers actually edit: the
renewal below keeps even a multi-hour session alive, so you needn't over-provision.

Pass `onRequestRelaunch` that mints (and awaits) a fresh session and updates the
`designerUrl` state, and the component makes expiry a non-event:

- **Silent proactive renewal**: from each `ready`'s `expiresAt` it schedules an
  automatic relaunch shortly before the session lapses (~3 min ahead, or after 80%
  of the remaining life for a sub-15-minute TTL, never sooner than 30s after
  `ready`), re-armed on every `ready`.
- **Automatic expiry recovery**: if an expiry error slips through anyway, it makes
  **one** automatic relaunch attempt before showing the "Try again" card.

The wrapper **recreates the iframe whenever `designerUrl` changes**, and
**in-progress work is autosaved server-side**, so relaunching is safe: the
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
| `onHoldExpired` | no payload |
| `onGAClick` | `GAAreaAvailability` |
| `onError` | `unknown` |
| `onDeckTap` | `string` (floor id) |
| `onHint` | `string \| null`: `null` clears the hint |
| `onSeatHover` | `SeatHoverDetails \| null`: `null` when the pointer leaves |
| `onAccessExpired` | `BuyerAccessExpiredEvent` |
| `onAccessUnavailable` | `BuyerAccessUnavailableEvent` |
| `onSelectedObjectUnavailable` | `SelectedObjectUnavailableEvent` |

## Frequently asked questions

### Which React seating chart component can I use?

`@seatlayer/react` gives you a complete seat picker (`SeatPicker`) or the map
alone (`SeatingChart`), with live availability, seat holds, best available,
season tickets and, on every plan, a 3D view from each seat for venues up to
60,000 seats. A 200,000-seat stadium chart is ready in 1.95 s on desktop, and
the same charts run in Vue, Angular, iOS, Android, Flutter and React Native.
You pay only for sold seats, and your own server and payment provider keep the
order and the money.

### How do I add a seat map to a React app?

Install `@seatlayer/react` and render `SeatPicker` for the whole buyer flow:
live availability, a priced tray, seat holds with a timer, best available, the
3D view from each seat on charts up to 60,000 seats, and the checkout hand-off.
For the map alone inside your own UI, render `SeatingChart` and read the
buyer's choice from `onSelectionChange`. Give the container a definite height
and pass your event key and publishable key; your server then books the hold.

### Is this a real React component or an iframe?

`SeatingChart`, `SeatPicker` and `SeatManager` are real React components that
render into a plain `<div>` in your own tree, with no iframe. `EmbeddedDesigner`
is the one exception: the organizer Designer runs in an iframe served by
SeatLayer and opened with a short-lived session URL from your backend, so your
secret key never reaches the browser. If you want an iframe for the buyer
picker, `attachPickerFrame` is exported for that.

### What is the difference between `SeatPicker` and `SeatingChart`?

`SeatingChart` is the chart alone: it draws the venue, manages selection, and
hands you the seats, and you build the surrounding UI. `SeatPicker` is the complete
buyer experience with legend, priced tray, hold timer, and checkout hand-off
already built. Start with `SeatPicker` if you want a working ticket flow today,
and drop to `SeatingChart` when your design system owns the chrome.

### How do temporary seat holds work?

In the SeatLayer picker, a buyer's seats are held when they go to checkout;
with the bare chart, your code calls `hold()`, which reserves that inventory
against concurrent buyers for a limited checkout window and returns an opaque
`holdId`. The hold lapses on its own if checkout never completes. `onHoldExpired` tells
the app to return the buyer to the map, and `resumeHold()` restores it after a
same-tab checkout navigation or a reload. This is what prevents double-selling
without locking seats forever.

### Can I use my own payment provider?

Yes. By default nothing in this package takes a payment: the browser hands you
a `holdId` and a `CheckoutHandoff` with the priced line items, and your backend
charges through the provider you already use, then books the hold. For a host
with no backend, the opt-in `checkout: 'hosted'` mode sends the buyer through
SeatLayer's checkout instead; without it, no payment code is downloaded.

### Can I evaluate it without a SeatLayer account?

Yes. The live Grand Theatre demo runs in your browser with no account. To show
your own venue you need an event key, and test mode is free with no time limit
and no card: test events, holds and webhooks work like production and use no
credits.

### Does it work with Next.js and other React frameworks?

Yes, on the client. The chart is built inside an effect and touches the DOM only
there, so a server render emits the empty container. This package ships no
`'use client'` banner of its own, so in the App Router mark your own component
that imports it, or load it through `next/dynamic` with `ssr: false`.

### How much does the SeatLayer SDK cost?

Building and testing is free, and going live costs $0. You pay one credit per
sold seat: the first 100 sold seats each month are free, then 10¢ down to 5¢ a
seat, with no subscription, and credits you buy never expire. Browsing the map,
holds and the 3D view never use a credit.

### Can I sell season tickets with it?

Yes. `SeasonPicker` holds the same seat on every date of a season in one step,
with best available across every date and a price type such as adult or child
for each seat, and returning holders can tell you they will renew. The hand-off
carries no price; by default your server applies the package price and books
it, and the opt-in `checkout: 'hosted'` takes the payment through SeatLayer's
checkout instead, into the organizer's own payment account. `SeasonPicker` is in `@seatlayer/react` 0.72.0 and newer.

## Continue your React integration

- [Follow the buyer SDK installation guide](https://docs.seatlayer.io/buyer-sdk/install/)
  for the full browser integration, options, and events.
- [Build a React or Next.js seating chart](https://docs.seatlayer.io/buyer-sdk/react-seating-chart/)
  with the framework-specific tutorial and client-mounting guidance.
- [Read the seat picker documentation](https://docs.seatlayer.io/buyer-sdk/seat-picker/)
  for props, events, holds, and checkout in depth.
- [Connect seat holds to secure server-side checkout](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/)
  without putting booking credentials in the browser.
- [Run the complete checkout example](https://docs.seatlayer.io/examples/complete-checkout/)
  to connect a buyer hold id to payment and idempotent booking.
- [Compare SeatLayer's mobile seat map SDKs](https://docs.seatlayer.io/buyer-sdk/mobile/)
  when the same event also has to appear in your iOS, Android, Flutter or React
  Native app.
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

The React wrapper source in this package is MIT licensed. The separately
distributed SeatLayer runtime is not covered by this package's MIT license.
