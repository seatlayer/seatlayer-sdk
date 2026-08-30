# SeatLayer Vue Seat Map SDK for Reserved Seating

[![npm](https://img.shields.io/npm/v/@seatlayer/vue)](https://www.npmjs.com/package/@seatlayer/vue)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/vue)](https://www.npmjs.com/package/@seatlayer/vue)
[![Vue](https://img.shields.io/badge/Vue-%E2%89%A53.3-42B883.svg)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-types%20included-3178C6.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The official Vue 3 wrapper for SeatLayer reserved seating. Render an interactive
seating chart with live seat availability inside a Vue app, let buyers pick
seats, and take a temporary hold on the inventory they choose.

The buyer modal and iframe integration stay framework-agnostic: this package
also re-exports the plain JavaScript `SeatPickerWidget` class and the
`attachPickerFrame` helper, so a Vue host depends on one package.

[SeatLayer Vue SDK on npm](https://www.npmjs.com/package/@seatlayer/vue) ·
[Vue seat-map documentation](https://docs.seatlayer.io/buyer-sdk/vue/) ·
[SeatLayer SDK and API overview](https://seatlayer.io/developers/) ·
[Buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) ·
[SeatLayer JavaScript seat map SDK](https://www.npmjs.com/package/@seatlayer/js) ·
[SeatLayer React seat map SDK](https://www.npmjs.com/package/@seatlayer/react) ·
[SeatLayer Angular seat map SDK](https://www.npmjs.com/package/@seatlayer/angular) ·
[SeatLayer AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

## What is included

- `SeatingChart` — one native Vue component (`SeatLayerSeatingChart`), written
  as a render function so no Vue compiler plugin is needed.
- `SeasonPicker` — an unpublished fixed-inclusion Season source candidate.
- `SeatPickerWidget` — the framework-agnostic one-call buyer modal.
- `attachPickerFrame` — the host-side iframe helper for embedded pickers.
- TypeScript declarations for ESM (`dist/index.d.ts`) and CommonJS
  (`dist/index.d.cts`), including the `SeatingChartExposed` handle type.

## Requirements

- Vue 3.3 or newer (declared as a peer dependency).
- A browser DOM: the chart is created when the component mounts.

## Install

```bash
npm install @seatlayer/vue
```

## Quick start

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { SeatingChart, type SeatingChartExposed, type SelectedSeat } from '@seatlayer/vue';

const chart = ref<SeatingChartExposed | null>(null);

function onSelectionChange(seats: SelectedSeat[]) {
  console.log('selected', seats);
}

async function checkout() {
  const held = await chart.value?.hold();
  if (held) await bookOnYourServer(held.holdId);
}
</script>

<template>
  <SeatingChart
    ref="chart"
    event="ev_9f3a"
    public-key="pk_live_your_publishable_key"
    style="width: 100%; height: 520px"
    @selection-change="onSelectionChange"
    @hold="({ holdId }) => bookOnYourServer(holdId)"
  />
  <button @click="checkout">Continue</button>
</template>
```

### Fixed renewable Season source candidate

```vue
<SeasonPicker
  ref="season"
  season="sea_2027"
  :buyer-access-token="session.token"
  @continue="handoff => continueOnYourServer(handoff.operationId)"
/>
```

The Season handoff is opaque and price-free. Its `pricingAuthority: "host"`
and `authoritativeAmountIncluded: false` flags mean trusted server code must
apply the package price, tax, and payment decision before booking the
identity-only allocation. This source is not a published framework support
claim.

## Props

| Prop | Type | Notes |
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
| `seatTooltip` | `boolean` | Set `false` to draw your own popover from `@seat-hover`. |
| `messages` | `object` | Copy overrides. Read once per rebuild. |
| `initialView` | `RendererViewMode` | Initial 2D projection, read once per rebuild. |
| `errorDisplay` | `'message' \| 'none'` | `'message'` (default) shows a notice with Try again; `'none'` is silent. |
| `buyerAccessTokenProvider` | `BuyerAccessTokenProvider` | Sales Channels: mint a buyer access session on demand from your backend. |
| `buyerAccessToken` | `string \| BuyerAccessToken` | One-shot session for hosts that own the lifecycle. Cannot be renewed. |

`numberOfPlacesToSelect`, `selectionValidators`, and the other identity props rebuild the
canvas. `selectedObjects` and `selectableObjects` are initial values; use the
imperative methods for later changes so a new array identity cannot remount the
chart mid-selection.

## Events

| Event | Payload |
| --- | --- |
| `@selection-change` | `SelectedSeat[]` |
| `@selection-validity-change` | Rule state with typed `violations` |
| `@selection-valid` / `@selection-invalid` | Rule-validity transition |
| `@selection-limit` | Active numeric cap |
| `@hold` | `HoldResult` |
| `@hold-restored` | `HoldResult` |
| `@hold-expired` | — |
| `@ga-click` | `GAAreaAvailability` |
| `@error` | `unknown` |
| `@deck-tap` | `string` (floor id) |
| `@hint` | `string \| null` — `null` clears the hint |
| `@seat-hover` | `SeatHoverDetails \| null` — `null` when the pointer leaves |
| `@access-expired` | `BuyerAccessExpiredEvent` |
| `@access-unavailable` | `BuyerAccessUnavailableEvent` |
| `@selected-object-unavailable` | `SelectedObjectUnavailableEvent` |

## Imperative API

Everything on the template ref, typed as `SeatingChartExposed`:

`hold` · `resumeHold` · `getCurrentHold` · `getGAAreas` · `holdGA` ·
`bestAvailable` · `release` · `releaseLabels` · `getSelection` · `setSeatTier` ·
`selectObjects` · `deselectObjects` · `clearSelection` · `selectCategories` ·
`deselectCategories` · `setSelectableObjects` · `setMaxSelection` ·
`getSelectionValidity` ·
`getFloors` · `setFloor` · `setColorblindSafe` · `zoomIn` · `zoomOut` ·
`zoomToFit` · `refreshAccess`

Calling any of them before the chart exists returns an empty answer rather than
throwing, so a template ref used one frame early is safe.

## Also exported

- `SeatPickerWidget` — raw framework-agnostic JavaScript one-call modal (`SeatPickerWidget.open()`).
- `attachPickerFrame` — raw framework-agnostic JavaScript iframe helper; grows on `seatlayer:height` and
  pins on `seatlayer:fullscreen`.

## Security boundary

The Vue app **selects and holds** inventory. Your trusted backend **inspects and
books** the hold after payment or order validation.

- Never ship a SeatLayer secret key in browser code or a bundled env variable.
- A `pk_` public key is designed for browser code. SeatLayer binds it to the
  configured origin and event; keep private-channel access behind a server-minted
  `buyerAccessTokenProvider`.
- Send only the `holdId` and your normal checkout context to your backend.
- Calculate the charge from server-inspected hold items, not from browser input.
- Reuse your stable order id as `bookingRef` so a retried booking is idempotent.

Read [how the integration works](https://docs.seatlayer.io/start/how-it-works/)
before connecting checkout.

## Architecture

This package is a thin Vue layer over
[`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js), the
framework-agnostic browser runtime. The component renders a single `<div>`,
builds the chart on mount, forwards every prop and emit, and exposes the
runtime's imperative handle through `defineExpose`. Chart geometry,
availability, and holds come from the SeatLayer API at runtime.

## Frequently asked questions

### How do I add a seat map to a Vue app?

Install `@seatlayer/vue`, render `<SeatingChart event="ev_…" />` in a container
with a definite height, and handle `@selection-change`. That is a complete
interactive seating chart with live availability; the
[seat-picker documentation](https://docs.seatlayer.io/buyer-sdk/seat-picker/)
covers props, events, holds, and checkout in depth.

### Is this a real Vue component or an iframe?

`SeatingChart` is a real Vue 3 component that renders a plain `<div>` into your
own tree — no iframe and no stylesheet of its own. It is written as a render
function rather than a single-file component, so it needs no Vue compiler plugin
and works the same in Vite, Nuxt, and a plain bundler. If you would rather embed
the buyer picker in an iframe, `attachPickerFrame` is exported for that.

### How do temporary seat holds work?

When a buyer commits to a selection, `hold()` reserves that inventory against
concurrent buyers for a limited checkout window and returns an opaque `holdId`.
The hold lapses on its own if checkout never completes — `@hold-expired` tells
the app to return the buyer to the map — and `resumeHold()` restores it after a
same-tab checkout navigation or a reload. This is what prevents double-selling
without locking seats forever.

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

## Continue your Vue integration

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
| Vue | [`@seatlayer/vue`](https://www.npmjs.com/package/@seatlayer/vue) (this package) |
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
