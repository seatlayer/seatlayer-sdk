# SeatLayer Angular Seating Chart and Seat Map SDK

[![npm](https://img.shields.io/npm/v/@seatlayer/angular)](https://www.npmjs.com/package/@seatlayer/angular)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/angular)](https://www.npmjs.com/package/@seatlayer/angular)
[![Angular](https://img.shields.io/badge/Angular-%E2%89%A517-DD0031.svg)](https://angular.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-types%20included-3178C6.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The official Angular seating chart component for SeatLayer reserved seating.
Render live seat availability and selection inside an Angular app, then take a
temporary hold on the inventory the buyer chooses.

The buyer modal and iframe integration stay framework-agnostic: this package
also re-exports the plain JavaScript `SeatPickerWidget` class and the
`attachPickerFrame` helper, so an Angular host depends on one package.

[SeatLayer Angular SDK on npm](https://www.npmjs.com/package/@seatlayer/angular) ·
[Angular seat-map documentation](https://docs.seatlayer.io/buyer-sdk/angular/) ·
[SeatLayer SDK and API overview](https://seatlayer.io/developers/) ·
[Buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) ·
[SeatLayer JavaScript seat map SDK](https://www.npmjs.com/package/@seatlayer/js) ·
[SeatLayer React seat map SDK](https://www.npmjs.com/package/@seatlayer/react) ·
[SeatLayer Vue seat map SDK](https://www.npmjs.com/package/@seatlayer/vue) ·
[SeatLayer AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

## What is included

- `SeatLayerSeatingChartComponent`: one standalone Angular component with the
  `seatlayer-seating-chart` selector.
- `SeatLayerSeasonPickerComponent`: season tickets, with the
  `seatlayer-season-picker` selector. The buyer picks a seat once and holds it
  on every date of the season; returning holders can say they will renew.
- `SeatLayerSeatManagerComponent`: the organizer control room, for dashboards
  that monitor and block live inventory, with the `seatlayer-seat-manager`
  selector. It lives on its own entry, `@seatlayer/angular/manager`, so a buyer
  app never carries it.
- `SeatPickerWidget`: the framework-agnostic one-call buyer modal.
- `attachPickerFrame`: the host-side iframe helper for embedded pickers.
- An Angular Package Format build (`fesm2022`) with TypeScript declarations at
  `dist/index.d.ts`, plus the `@seatlayer/angular/manager` entry.

## Requirements

- Angular 17 or newer (`@angular/core` and `@angular/common` are peer
  dependencies).
- A browser DOM: the chart is created when the component initialises.

## Install

```bash
npm install @seatlayer/angular
```

The component is **standalone**: import it directly, no NgModule needed.

## Upgrading to 1.0.6

Nothing needs a code change. What a buyer may now see:

- **A seat selected from your code on another level** is in the cart at once, without the buyer opening that level first.
- **On a phone, a venue with levels** uses the full width of the map, and the level buttons never cover seats.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 1.0.6 as well.

## Upgrading to 1.0.5

Nothing needs a code change. What a buyer may now see:

- **Standing areas after a theme or language change** keep their live count, for example "48 left". They showed the area's capacity until the next sale.
- **A pressed seat card** that would stand under the edge of the window is scrolled into view.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 1.0.5 as well.

## Upgrading to 1.0.4

Nothing needs a code change. What a buyer may now see:

- **Runs sold date by date, and Season tickets by date:** the map says "Sold out" only when no seat can be booked on any date. On a Season's single dates a seat free on some of the chosen dates is half-coloured too. Its card lists only dates that were checked, and the button names the price, for example "Book 1 date · €23".
- **A hold that gets no answer** ends after 40 seconds with "Check your connection and try again." The seats stay picked, and on an event or a Season the next press gets the hold the server may have made. A server error no longer says that the seats were taken. `onError` can now come 40 seconds after a hold was sent, with an `AbortError`.
- **Phone held sideways:** the top of the seat card (section, row, seat and price) is no longer cut.
- **Show whole venue, levels and sections** while a seat card is open show the map. It could stand empty.
- **The Seats button** lands where a seat can be pressed.
- **Test mode:** the badge says "Test mode" and nothing more.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 1.0.4 as well.

## Upgrading to 1.0.3

Nothing needs a code change. What a buyer may now see:

- **Standing areas:** the Areas row and an open number box follow live sales, as the map does. A choice larger than what is left is lowered to it.
- **All levels view:** names placed by hand and rows drawn on a curve stay with their level, and a level's code sits in the middle of its ring.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 1.0.3 as well.

## Upgrading to 1.0.2

Nothing needs a code change. What a buyer or an organizer may now see:

- **Moving the map over a standing area** no longer opens its number. A tap still does.
- **Standing areas, live:** on a page with a publishable key or a buyer token, the number left follows live sales.
- **Whole map:** the outermost seats are drawn whole. The right column and the last row could lose a slice.
- **Control room, standing areas:** Block and Reserve pick a standing area and how many of its places. Find blocked and Release give back some of them. `block()` takes a standing area's labels.
- **Control room, tables:** a table sold as one counts as 1 table, by its name, in Block, Reserve, the live line and Live activity.
- **Control room on a phone:** at its lowest the sheet is one line.
- **Season, in other languages:** the line a screen reader says about free seats is in the buyer's language.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 1.0.2 as well.

## Upgrading to 1.0.1

Nothing needs a code change. What a buyer may now see:

- **No "Sold out" over a buyer's own seats:** a buyer who holds the last places keeps their map, also after a reload. Anyone else still sees the sold-out cover.
- **White text on mid-tone accents:** text on the accent is the chart's own ink where it reads at 3:1, else white where white reads at 3:1, else near-black. `theme.accentInk` is taken as it is. The "Select them again" button and the immersive view follow the same rule.
- **In the buyer's language:** the price filter in the side panel follows the event's language, and the payment card counts seats with the language's own plural.
- **A chair sold on its own at a table** reads "Table", not "Row", on the payment card and in the 3D view.
- **Standing tickets read the area's name**, in the phone cart, in the picker's messages and in the Control room's search.
- **Control room, whole and flexible tables:** Block, Reserve, Undo, Release, put-back times, saved selections, ticket types and channels now work on them. Picking one chair picks its table, and every count is in seats.
- **Run and Season pages need https, or localhost when you test:** on a plain `http://` address a browser has no `crypto.randomUUID`, and a hold can't start.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 1.0.1 as well.

## Upgrading to 1.0.0

Nothing needs a code change. What a buyer may now see:

- **One seat card for a run and a Season:** on a run, a seat opens a card with the run's dates. The buyer ticks dates, and the button counts and totals them, with the booking fee once per seat. On a Season's pass map that sells single dates, a free seat's card lists the open dates.
- **The cart's levels:** on a chart with two or more levels, each level button counts its cart lines, a cart line names its level, and a tap on it opens that level.
- **The Held clock in the map's toolbar row** when the host hides the title row.
- **A Season or run hold stays live** when the buyer comes back to the tab.
- **The Season picker's status line and the 3D seat card's profile chip in the buyer's language.** The `season.status` event's `message` follows the page's language too: decide on `kind`, never on `message`.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 1.0.0 as well.

## Upgrading to 0.119.1

Nothing needs a code change. What a buyer may now see:

- **Calmer seat cards and right panel:** each card sits on the panel's own background with a hairline, the tier's colour is a small dot beside the ticket type, and a held card says "Held" under its price. On a computer the panel's spacing and controls are on one scale.
- **On a phone, the cart row's fee words lead its second line:** line 1 is the count and the total, and line 2 starts with "includes booking fee · " before the seats.
- **The map's Test mode chip in full screen:** with `host.testChip: false`, the chip shows again while the map is in full screen, where the host's own bar is off the screen.
- **A stylesheet that targets `.sl-chip-dot` or `.sl-ticket-state svg`** no longer matches anything: those elements are gone.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.119.1 as well.

## Upgrading to 0.119.0

Nothing needs a code change. What a buyer may now see:

- **The booking fee in the Season picker's price lines**, when the organiser set one: "includes £1.50 booking fee" under a date's from-price and a pass chip's price, the ticked single dates' fees added up, and on the pass's map the strip's "· includes £2 booking fee" and one line in the prices panel.
- **No Best Available card on single dates:** their hold is the run's, which has no Best Available.
- **The checkout confirmation in plain words:** "We’ve emailed your tickets."
- **New in `@seatlayer/js`:** `SeasonPicker.datesCodeCall()`, a code function for held single dates, for a page that draws its own checkout card. These components don't expose it yet; use `@seatlayer/js` for it.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.119.0 as well.

## Upgrading to 0.118.2

Nothing needs a code change. What a buyer may now see:

- **`initialReads` when the API doesn't answer:** a read your page started through `PubApi` that failed after `PubApi`'s own resends now fails in the picker at once, so the buyer gets the panel and its Try again without waiting through the same resends a second time. A read your page made with a single `fetch` is still read again. Nothing else changes.
- **Not here yet, as in 0.118.1:** `testChip`, `telemetry` and `theme.modeMap` are not props of these components.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.118.2 as well.

## Upgrading to 0.118.1

Nothing needs a code change. What a buyer may now see:

- **Season date lists in the buyer's language:** the language's own separator, the month said once where the language puts it, and the weekday where the language says it before the day ("Wed Aug 4, Thu 5, Sun 8" in US English, "Wed 4, Thu 5, Sun 8 Aug" in British English).
- **A Season range in one year** says the year once ("1 Feb to 8 Feb 2027"). A range never breaks inside a date.
- **An event free throughout** names its categories on the price rail and in the panel ("Floor", "Balcony"), not "Free" for each.
- **An invite-only event** says "Invited guests only" once: the head pill goes while the phone's cart row or the computer's tray card says it.
- **Not here yet:** `@seatlayer/js` 0.118.1's new opt-in options (`testChip`, `telemetry`, `theme.modeMap`) are not inputs of these components. They come in the next patch.
- **One version of the SDK.** If your app also installs `@seatlayer/js`
  itself, move it to 0.118.1 as well.

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
- **New, opt-in:** `[singleDates]="true"` on the season picker and its `startDatesCheckout()` method, for a page with its own session or checkout. The `SeatPickerWidget` class takes the picker's `host` option, with `hostHead()` and `setHost(patch)`.
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
- `tryRelease(releaseActionId)` on the `seatlayer-season-picker` component resolves `true` when the seats were
  let go and `false` when nothing was held or the server kept them. It never
  rejects for a failed release; `release()` stays as it was.
- a `releaseHoldOnDestroy` input (default `false`). When true, destroying the component releases a hold the buyer left
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
- **A `release()` just before the picker is destroyed now reaches the server.**
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

Nothing needs a code change, and nothing changes for a page that already works.

- **`SeatingChart` and the Season picker take `enable3D`, `enable3DCrowd` and
  `touchNavigation3D` as inputs.** Before 0.112.0 they had no such inputs.
  `[enable3D]="false"` hides the 3D view, `[enable3DCrowd]="false"` leaves
  standing areas an empty floor in 3D, and `touchNavigation3D="classic"` keeps
  the earlier touch gestures. Unset, `true` and `'map'` are the defaults.
- **Changing one of the three after the first render rebuilds the picker.** A
  page that drives `enable3D` from state, for example from the screen width,
  remounts the chart each time the value changes, as a change of `event` or
  `locale` does. Set it once where you can.
- **One version of the SDK.** `@seatlayer/js` and `@seatlayer/core` are
  dependencies of this package, pinned to the same version. If your app also
  installs `@seatlayer/js` itself, move it to 0.112.0 as well; an older direct
  install leaves two copies of the SDK in your bundle.

## Quick start

```ts
import { Component, ViewChild } from '@angular/core';
import { SeatLayerSeatingChartComponent, type SelectedSeat } from '@seatlayer/angular';

@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [SeatLayerSeatingChartComponent],
  template: `
    <seatlayer-seating-chart
      #chart
      event="ev_9f3a"
      publicKey="pk_live_your_publishable_key"
      style="display:block; height:520px"
      (selectionChange)="onSelectionChange($event)"
      (hold)="bookOnYourServer($event.holdId)"
    />
    <button (click)="chart.holdSelection()">Continue</button>
  `,
})
export class CheckoutComponent {
  @ViewChild('chart') chart!: SeatLayerSeatingChartComponent;

  onSelectionChange(seats: SelectedSeat[]) {
    console.log('selected', seats);
  }

  bookOnYourServer(holdId: string) { /* … */ }
}
```

### Complete buyer picker

Use the re-exported `SeatPickerWidget` when you want the ready modal with its
map, legend, priced tray, hold timer, and checkout hand-off:

```ts
import { Component } from '@angular/core';
import { SeatPickerWidget } from '@seatlayer/angular';

@Component({
  selector: 'app-seat-picker-button',
  standalone: true,
  template: `<button (click)="openSeatPicker()">Choose seats</button>`,
})
export class SeatPickerButtonComponent {
  async openSeatPicker() {
    await SeatPickerWidget.open({
      event: 'ev_9f3a',
      publicKey: 'pk_live_your_publishable_key',
      webMcp: true,
      onCheckout: (hold) => {
        void continueCheckoutOnYourServer(hold.holdId).catch(showCheckoutError);
      },
    });
  }
}
```

`continueCheckoutOnYourServer` and `showCheckoutError` are supplied by your
application. The first owns the async server request; `.catch(...)` surfaces a
rejected checkout.

On supported browsers, the complete picker includes the Map | 3D buyer view.
Its opt-in `webMcp: true` setting lets a compatible in-browser assistant
describe the event, find seats, select them, and read the selection. Use
`webMcp: { holds: true }` only when the assistant should also place a temporary
hold. These tools do not take payment or book seats. See the
[buyer WebMCP seat-selection guide](https://docs.seatlayer.io/buyer-sdk/webmcp-agent-tools/)
for the full contract and iframe origin controls.

Since 0.117.0, the widget's `host` option (type `SeatPickerHostOptions`, also
exported here) puts your page's words, head and confirm step into its panel and
cart, and the widget's `hostHead()` and `setHost(patch)` methods fill and
change them.

### Season tickets: the same seat on every date

```html
<seatlayer-season-picker
  #seasonPicker
  season="sea_2027"
  [buyerAccessToken]="session.token"
  (continued)="continueOnYourServer($event.operationId)"
/>
```

The Season handoff is opaque and price-free. Its `pricingAuthority: "host"`
and `authoritativeAmountIncluded: false` flags mean trusted server code must
apply the package price, tax, and payment decision before booking the
identity-only allocation. `SeatLayerSeasonPickerComponent` is supported in
`@seatlayer/angular` `0.72.0` and newer.

The component exposes the same calls as `@seatlayer/js`, including Season
Best Available: `seasonPicker.holdBestAvailable(2, 'sop_checkout_1184', {
categoryKey: 'stalls' })` holds the best two seats free on every date.

To sell child or concession seats too, bind `[priceTypes]="['adult', 'child']"`:
the buyer chooses a type per seat before the hold, and the handoff's `seats`
lists each seat's `priceTypeKey`. `seasonPicker.holdSameSeat(labels,
operationId, { 'A-2': 'child' })` names them yourself; a label left out is adult.

The Season picker takes the same three 3D props as the seating chart:
`enable3D`, `enable3DCrowd` and `touchNavigation3D`. Changing one rebuilds it.

The picker opens on step 1, the package with its dates and prices. Bind
`package="spl_half"` (the package's key) to open on that package instead of the
Season's first one; a host token is already bound to one package, so it ignores
this. If your own checkout emails a ticket for every date, bind
`[ticketsByEmail]="true"` and step 1 says so.

With SeatLayer checkout, bind `[buyerEmail]` and `[buyerName]` to fill in the
payment card for a signed-in member; the buyer can still change them. On your
own checkout, call `seasonPicker.markBooked()` once your server has booked the
hold: the picker shows the booked screen instead of offering checkout again.

Since 0.111.0, `seasonPicker.getHeldOrder()` gives the held order for your own summary: each held
seat with its price type and package price, the currency and the total in
minor units (null with no live hold). It is for display; checkout prices the
order on the server.

Since 0.117.0, a page with its own checkout or session can bind
`[singleDates]="true"` to offer the Season's single dates beside the passes
(off by default; changing it rebuilds the picker). Continue on a dates hold
emits `(continued)` with a handoff whose `dates` names the run, the dates and
the held lines. To take the payment on SeatLayer's checkout from your own page,
call `seasonPicker.startDatesCheckout({ buyerEmail, buyerName?, returnUrl? })`.
Like the hold methods, it throws while the picker is not mounted.

## Inputs

| Input | Type | Notes |
| --- | --- | --- |
| `event` | `string` | **Required.** Changing it rebuilds the chart. |
| `apiBase` | `string` | Defaults to the public API. |
| `maxSelection` | `number` | Cap on how many seats a buyer may select. |
| `selectedObjects` | `string[]` | Initial object ids or public labels. |
| `selectableObjects` | `string[] \| null` | Buyer-selectable allow-list. |
| `numberOfPlacesToSelect` | `number` | Exact count required for a valid selection. |
| `selectionValidators` | `PickerSelectionValidator[]` | Minimum, consecutive-seat, and no-orphan guards. |
| `publicKey` | `string` | Publishable browser key for public Platform events. Configure the browser origin in SeatLayer. |
| `locale` | `string` | BCP-47 locale for built-in copy. |
| `currency` | `string` | ISO currency for price formatting. |
| `colorblindSafe` | `boolean` | Render colorblind-safe seat glyphs. |
| `enable3D` | `boolean` | Offer the 3D venue view. On by default; `false` hides it. |
| `enable3DCrowd` | `boolean` | The standing crowd in 3D. Drawn by default; `false` turns it off. |
| `touchNavigation3D` | `'map' \| 'classic'` | How fingers move the 3D view. `'map'` by default; `'classic'` keeps the older gestures. |
| `seatTooltip` | `boolean` | Set `false` to draw your own popover from `(seatHover)`. |
| `messages` | `object` | Copy overrides. Read once per rebuild. |
| `initialView` | `RendererViewMode` | Initial 2D projection, read once per rebuild. |
| `errorDisplay` | `'message' \| 'none'` | `'message'` (default) shows a notice with Try again; `'none'` is silent. |
| `buyerAccessTokenProvider` | `BuyerAccessTokenProvider` | Sales Channels: mint a buyer access session on demand from your backend. |
| `buyerAccessToken` | `string \| BuyerAccessToken` | One-shot session for hosts that own the lifecycle. Cannot be renewed. |

`numberOfPlacesToSelect`, `selectionValidators`, and the other identity inputs rebuild the
canvas. `selectedObjects` and `selectableObjects` are initial values; use the
imperative methods for later changes so change detection never destroys a chart
mid-selection because an array instance changed.

## Outputs

| Output | Payload |
| --- | --- |
| `(selectionChange)` | `SelectedSeat[]` |
| `(selectionValidityChange)` | Rule state with typed `violations` |
| `(selectionValid)` / `(selectionInvalid)` | Rule-validity transition |
| `(selectionLimit)` | Active numeric cap |
| `(hold)` | `HoldResult` |
| `(holdRestored)` | `HoldResult` |
| `(holdExpired)` | no payload |
| `(gaClick)` | `GAAreaAvailability` |
| `(errored)` | `unknown` |
| `(deckTap)` | `string` (floor id) |
| `(hint)` | `string \| null`: `null` clears the hint |
| `(seatHover)` | `SeatHoverDetails \| null`: `null` when the pointer leaves |
| `(accessExpired)` | `BuyerAccessExpiredEvent` |
| `(accessUnavailable)` | `BuyerAccessUnavailableEvent` |
| `(selectedObjectUnavailable)` | `SelectedObjectUnavailableEvent` |

> `(errored)` rather than `(error)`: `error` collides with the native DOM error
> event on the host element, which would fire your handler for unrelated
> failures.

## Imperative API

Via a template ref (`#chart`):

`holdSelection` · `resumeHold` · `getCurrentHold` · `getGAAreas` · `holdGA` ·
`bestAvailable` · `release` · `releaseLabels` · `getSelection` · `setSeatTier` ·
`selectObjects` · `deselectObjects` · `clearSelection` · `selectCategories` ·
`deselectCategories` · `setSelectableObjects` · `setMaxSelection` ·
`getSelectionValidity` ·
`getFloors` · `setFloor` · `setColorblindSafe` · `zoomIn` · `zoomOut` ·
`zoomToFit` · `refreshAccess`

Calling any of them before the chart exists returns an empty answer rather than
throwing, so a template ref used one frame early is safe.

> `holdSelection()` rather than `hold()`: `hold` is already the name of the
> `@Output`, and a class cannot have both.

## Embed the live control room

Import `SeatLayerSeatManagerComponent` from `@seatlayer/angular/manager`, not
from the package root. That entry holds the control room and nothing else, so
your buyer pages stay the same size.

Pass a short-lived, event-scoped manage token minted by your backend. The
`token` input takes an `mse_` browser grant. Tenant `sk_` secrets do not work
in browser code and must stay on your server. Keep the grant in memory, never
in a URL, browser storage, or logs.

```ts
import { Component } from '@angular/core';
import {
  SeatLayerSeatManagerComponent,
  type SeatManagerMode,
  type SeatManagerOpenOrder,
  type SeatManagerRoomState,
} from '@seatlayer/angular/manager';

@Component({
  selector: 'app-control-room',
  standalone: true,
  imports: [SeatLayerSeatManagerComponent],
  template: `
    <seatlayer-seat-manager
      #room
      apiBase="https://api.seatlayer.io"
      eventKey="ev_9f3a"
      [token]="session.token"
      [tokenExpiresAt]="session.expiresAt"
      [onTokenRefresh]="mintManageSession"
      [(mode)]="mode"
      (roomStateChange)="onRoomState($event)"
      (openOrder)="openOrder($event)"
      style="height: calc(100vh - 96px)"
    />
    <button (click)="room.showObjects(resaleSeats, 'Resale')">Show resale seats</button>
  `,
})
export class ControlRoomComponent {
  mode: SeatManagerMode = 'view';
  // session, mintManageSession, resaleSeats, onRoomState and openOrder are yours.
}
```

The inputs are the `SeatManager` options from `@seatlayer/js/manager`, without
`container`. The board is rebuilt only when `eventKey` or `apiBase` changes.
These inputs change the running board in place, keeping the camera, selection,
live connection and DOM: `token`, `tokenExpiresAt`, `onTokenRefresh`,
`capabilities`, `currency`, `theme`, `themeMode`, `keepLiveWhileHidden`,
`mode`, `followLive`, `selectableObjects`, `unavailableObjectsSelectable`,
`unavailableObjects`, `unavailableObjectsReason`, `categoryPrices`,
`maxSelectedObjects`, `numberOfPlacesToSelect`, `isObjectSelectable`, `sale`
and `mapInsets` (the last two compared by value). The rest, such as `tools`,
`chrome`, `kpis`, `timeZone`, `organizationName`, `colourBy`, the `focus*`
inputs and `arrivedFrom`, are read once when the board opens.

Outputs: `(ready)`, `(tallies)`, `(activity)`, `(controlRoom)`,
`(modeChange)`, `(followLiveChange)`, `(selectionChange)`, `(objectSelected)`,
`(objectDeselected)`, `(selectionValidityChange)`, `(selectionValid)`,
`(selectionInvalid)`, `(selectionLimit)`, `(filteredSectionChange)`,
`(areaClick)`, `(actionComplete)`, `(connectionChange)`, `(roomStateChange)`,
`(errored)`, `(openOrder)` and `(openTrend)`. `mode` and `followLive` pair with
their change outputs, so `[(mode)]` and `[(followLive)]` work.

The room offers "Open order" and the trend link only when you bind
`(openOrder)` or `(openTrend)`, so it never shows a link that goes nowhere.
`onTokenRefresh` is a function input, like `buyerAccessTokenProvider`, because
the room needs the new token back.

The template ref has the same methods as the React `SeatManagerHandle`,
including `setMode`, `block`, `unblock`, `selectObjects`, `focusSection`,
`getReport`, `getConnection` and `showObjects`. The `[focusSection]` input
opens the room on a section; the `focusSection()` method frames one later.

## Zone behaviour

The chart runs a `requestAnimationFrame` render loop and its own pointer
handlers. Those are created **outside** the Angular zone: left inside it, every
frame would schedule change detection for your whole application. Each callback
re-enters the zone only to emit, which is the only part Angular needs to see.

## Also exported

- `SeatPickerWidget`: raw framework-agnostic JavaScript one-call modal (`SeatPickerWidget.open()`).
- `attachPickerFrame`: raw framework-agnostic JavaScript iframe helper; grows on `seatlayer:height` and
  pins on `seatlayer:fullscreen`.

## Security boundary

The Angular app **selects and holds** inventory. Your trusted backend **inspects
and books** the hold after payment or order validation.

- Never ship a SeatLayer secret key in browser code or a bundled environment
  file.
- A `pk_` public key is designed for browser code. SeatLayer binds it to the
  configured origin and event; keep private-channel access behind a server-minted
  `buyerAccessTokenProvider`.
- Send only the `holdId` and your normal checkout context to your backend.
- Calculate the charge from server-inspected hold items, not from browser input.
- Reuse your stable order id as `bookingRef` so a retried booking is idempotent.

Read [how the integration works](https://docs.seatlayer.io/start/how-it-works/)
before connecting checkout.

## Architecture

This package is a thin Angular layer over
[`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js), the
framework-agnostic browser runtime. The component's template is a single
`<div>`, `ngOnChanges` decides which inputs rebuild the chart, and the
imperative methods forward to the runtime handle. Chart geometry, availability,
and holds come from the SeatLayer API at runtime.

## Frequently asked questions

### Which Angular seating chart component can I use?

`@seatlayer/angular` gives you a standalone seat map component
(`SeatLayerSeatingChartComponent`) and a ready buyer modal (`SeatPickerWidget`),
with seat holds, best available, season tickets and, on every plan, a 3D view
from each seat for venues up to 60,000 seats. A 200,000-seat stadium chart is
ready in 1.95 s on desktop, and the same charts run in React, Vue, iOS,
Android, Flutter and React Native. You pay only for sold seats, and your own
server and payment provider keep the order and the money.

### How do I add a seat map to an Angular app?

Install `@seatlayer/angular`, import the standalone
`SeatLayerSeatingChartComponent` and put `<seatlayer-seating-chart>` in a block
with a definite height: you get a live seat map with seat holds, best available
and the 3D view from each seat on charts up to 60,000 seats. For the ready buyer
modal with its priced tray, hold timer and checkout hand-off, call
`SeatPickerWidget.open()`. Call `holdSelection()` from your own button and
handle `(hold)`; your server then books the hold.

### Is this a real Angular component or an iframe?

`SeatLayerSeatingChartComponent` is a real standalone Angular component whose
template is a plain `<div>` in your own tree, with no iframe. Its render loop
and pointer handlers run outside the Angular zone and re-enter it only to emit,
so a running chart does not trigger change detection on every frame. If you
would rather embed the buyer picker in an iframe, `attachPickerFrame` is
exported for that.

### How do temporary seat holds work?

In the SeatLayer picker, a buyer's seats are held when they go to checkout;
with the bare chart, your code calls `holdSelection()`, which reserves that
inventory against concurrent buyers for a limited checkout window and returns
an opaque `holdId`. The hold lapses on its own if checkout never completes.
`(holdExpired)` tells the app to return the buyer to the map, and
`resumeHold()` restores it after a same-tab checkout navigation or a reload.
This is what prevents double-selling without locking seats forever.

### Can I use my own payment provider?

Yes. By default nothing in this package takes a payment. The browser hands your
code a `holdId` and priced line items, and your backend charges through the
provider you already use, then books the hold.

### Can I evaluate it without a SeatLayer account?

Yes. The live Grand Theatre demo runs in your browser with no account. To show
your own venue you need an event key, and test mode is free with no time limit
and no card: test events, holds and webhooks work like production and use no
credits.

### How much does the SeatLayer SDK cost?

Building and testing is free, and going live costs $0. You pay one credit per
sold seat: the first 100 sold seats each month are free, then 10¢ down to 5¢ a
seat, with no subscription, and credits you buy never expire. Browsing the map,
holds and the 3D view never use a credit.

### Can I sell season tickets with it?

Yes. `SeatLayerSeasonPickerComponent` (`<seatlayer-season-picker>`) holds the
same seat on every date of a season in one step, with best available across
every date and a price type such as adult or child for each seat, and returning
holders can tell you they will renew. The hand-off
carries no price; by default your server applies the package price and books
it, and the opt-in `checkout: 'hosted'` takes the payment through SeatLayer's
checkout instead, into the organizer's own payment account. It is in `@seatlayer/angular` 0.72.0 and newer.

## Continue your Angular integration

- [Follow the buyer SDK installation guide](https://docs.seatlayer.io/buyer-sdk/install/)
  for the full browser integration, options, and events.
- [Read the seat picker documentation](https://docs.seatlayer.io/buyer-sdk/seat-picker/)
  for inputs, outputs, holds, and checkout in depth.
- [Connect seat holds to secure server-side checkout](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/)
  without putting booking credentials in the browser.
- [Run the complete checkout example](https://docs.seatlayer.io/examples/complete-checkout/)
  to connect a buyer hold id to payment and idempotent booking.
- [Compare SeatLayer's mobile seat map SDKs](https://docs.seatlayer.io/buyer-sdk/mobile/)
  when the same event also has to appear in your iOS, Android, Flutter or React
  Native app.
- [Use the separate `@seatlayer/js` EmbeddedDesigner API](https://docs.seatlayer.io/platform/embedded-designer/)
  when organizers need hosted chart editing inside an Angular product.
- [Explore the 3D seating chart](https://seatlayer.io/3d-seat-map/) for the 3D
  venue and the view from each seat, which `SeatLayerSeatingChartComponent`, the Season picker and `SeatPickerWidget` all offer in supported browsers. 3D is offered for venues up to 60,000 seats.
- [Point AI coding agents at the SeatLayer docs index](https://docs.seatlayer.io/llms.txt)
  (`llms.txt`) for an agent-readable map of the documentation.

## SeatLayer SDK ecosystem

| Surface | Package or source |
| --- | --- |
| JavaScript | [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) |
| React | [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) |
| Vue | [`@seatlayer/vue`](https://www.npmjs.com/package/@seatlayer/vue) |
| Angular | [`@seatlayer/angular`](https://www.npmjs.com/package/@seatlayer/angular) (this package) |
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

The Angular wrapper source in this package is MIT licensed. The separately
distributed SeatLayer runtime is not covered by this package's MIT license.
