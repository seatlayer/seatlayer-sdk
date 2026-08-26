# SeatLayer Angular Seat Map SDK for Reserved Seating

[![npm](https://img.shields.io/npm/v/@seatlayer/angular)](https://www.npmjs.com/package/@seatlayer/angular)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/angular)](https://www.npmjs.com/package/@seatlayer/angular)
[![Angular](https://img.shields.io/badge/Angular-%E2%89%A517-DD0031.svg)](https://angular.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-types%20included-3178C6.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The official Angular wrapper for SeatLayer reserved seating. Render an
interactive seating chart with live seat availability inside an Angular app, let
buyers pick seats, and take a temporary hold on the inventory they choose.

The buyer modal and iframe integration stay framework-agnostic: this package
also re-exports the plain JavaScript `SeatPickerWidget` class and the
`attachPickerFrame` helper, so an Angular host depends on one package.

[SeatLayer Angular SDK on npm](https://www.npmjs.com/package/@seatlayer/angular) ·
[Angular seat-map documentation](https://docs.seatlayer.io/buyer-sdk/seat-picker/) ·
[SeatLayer reserved-seating platform](https://seatlayer.io/) ·
[Buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) ·
[SeatLayer JavaScript seat map SDK](https://www.npmjs.com/package/@seatlayer/js) ·
[SeatLayer React seat map SDK](https://www.npmjs.com/package/@seatlayer/react) ·
[SeatLayer Vue seat map SDK](https://www.npmjs.com/package/@seatlayer/vue) ·
[SeatLayer AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

## What is included

- `SeatLayerSeatingChartComponent` — one standalone Angular component with the
  `seatlayer-seating-chart` selector.
- `SeatPickerWidget` — the framework-agnostic one-call buyer modal.
- `attachPickerFrame` — the host-side iframe helper for embedded pickers.
- An Angular Package Format build (`fesm2022`) with TypeScript declarations at
  `dist/index.d.ts`.

## Requirements

- Angular 17 or newer (`@angular/core` and `@angular/common` are peer
  dependencies).
- A browser DOM: the chart is created when the component initialises.

## Install

```bash
npm install @seatlayer/angular
```

The component is **standalone** — import it directly, no NgModule needed.

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
| `(holdExpired)` | — |
| `(gaClick)` | `GAAreaAvailability` |
| `(errored)` | `unknown` |
| `(deckTap)` | `string` (floor id) |
| `(hint)` | `string \| null` — `null` clears the hint |
| `(seatHover)` | `SeatHoverDetails \| null` — `null` when the pointer leaves |
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

## Zone behaviour

The chart runs a `requestAnimationFrame` render loop and its own pointer
handlers. Those are created **outside** the Angular zone — left inside it, every
frame would schedule change detection for your whole application. Each callback
re-enters the zone only to emit, which is the only part Angular needs to see.

## Also exported

- `SeatPickerWidget` — raw framework-agnostic JavaScript one-call modal (`SeatPickerWidget.open()`).
- `attachPickerFrame` — raw framework-agnostic JavaScript iframe helper; grows on `seatlayer:height` and
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

### How do I add a seat map to an Angular app?

Install `@seatlayer/angular`, import the standalone
`SeatLayerSeatingChartComponent`, and put `<seatlayer-seating-chart
event="ev_…">` on screen inside a block with a definite height. That is a
complete interactive seating chart with live availability; the
[seat-picker documentation](https://docs.seatlayer.io/buyer-sdk/seat-picker/)
covers inputs, outputs, holds, and checkout in depth.

### Is this a real Angular component or an iframe?

`SeatLayerSeatingChartComponent` is a real standalone Angular component whose
template is a plain `<div>` in your own tree — no iframe and no stylesheet of
its own. Its render loop and pointer handlers are created outside the Angular
zone and re-enter it only to emit, so a running chart does not schedule change
detection on every frame. If you would rather embed the buyer picker in an iframe,
`attachPickerFrame` is exported for that.

### How do temporary seat holds work?

When a buyer commits to a selection, `holdSelection()` reserves that inventory
against concurrent buyers for a limited checkout window and returns an opaque
`holdId`. The hold lapses on its own if checkout never completes —
`(holdExpired)` tells the app to return the buyer to the map — and
`resumeHold()` restores it after a same-tab checkout navigation or a reload.
This is what prevents double-selling without locking seats forever.

### Can I use my own payment provider?

Yes. Nothing in this package takes a payment. The browser hands your code a
`holdId` and priced line items, your backend charges through whatever provider
you already use, and it then books the hold through the
[server-side checkout flow](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/).

### Can I evaluate it without a SeatLayer account?

You can explore a live seating chart in the browser at the
[buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) with no
account. Rendering your own venue needs an event key, because the chart and its
availability are served by the SeatLayer API — create a free test event for
that, which books no real inventory.

## Continue your Angular integration

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

MIT © SeatLayer
