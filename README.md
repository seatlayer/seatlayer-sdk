# SeatLayer SDK for React, Vue and Angular: seat map, seating chart and seat picker

[![npm @seatlayer/react](https://img.shields.io/npm/v/@seatlayer/react?label=%40seatlayer%2Freact)](https://www.npmjs.com/package/@seatlayer/react)
[![npm @seatlayer/vue](https://img.shields.io/npm/v/@seatlayer/vue?label=%40seatlayer%2Fvue)](https://www.npmjs.com/package/@seatlayer/vue)
[![npm @seatlayer/angular](https://img.shields.io/npm/v/@seatlayer/angular?label=%40seatlayer%2Fangular)](https://www.npmjs.com/package/@seatlayer/angular)
[![CI](https://github.com/seatlayer/seatlayer-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/seatlayer/seatlayer-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)

The SeatLayer SDK puts an interactive seat map and a complete seat picker into React, Vue and
Angular ticketing apps: buyers see live availability, pick seats in 2D or 3D, see the view from
their seat, and hold the seats while your own checkout takes the payment.

## What SeatLayer is

SeatLayer is reserved-seat ticketing and seating software: organizers sell with hosted checkout,
a box office, door check-in and season tickets, and platforms add the same seat maps, with 3D
seat views, through the SeatLayer SDK and API. One chart drives the 2D map, the 3D venue and the
view from each seat (3D for venues up to 60,000 seats; the 2D map benchmarked at 200,000 seats).

[Website](https://seatlayer.io/) · [For developers](https://seatlayer.io/developers/) ·
[Season tickets](https://seatlayer.io/season-tickets/) · [Pricing](https://seatlayer.io/pricing/) ·
[Live demo](https://seatlayer.io/demo/)

This repository holds the [React](./packages/react#readme), [Vue](./packages/vue#readme) and
[Angular](./packages/angular#readme) packages. Plain JavaScript and the script tag
are [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js).

## Try it

- [Pick a seat in a live theatre](https://app.seatlayer.io/demo/play/grand-theatre), no account needed
- [Open the 200,000-seat stadium](https://app.seatlayer.io/demo/play/century-stadium-200k)
- [Quick start](https://docs.seatlayer.io/start/quickstart/): your first event and keys

## React seat map

```bash
npm install @seatlayer/react
```

```tsx
import { SeatPicker } from '@seatlayer/react';

export function Tickets() {
  return (
    <SeatPicker
      event="<YOUR_EVENT_KEY>"
      publicKey="<YOUR_PUBLIC_KEY>"
      style={{ width: '100%', height: 640 }}
      onCheckout={async (hold) => {
        // Send only the hold id. Your server prices the hold and books it.
        const res = await fetch('/api/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ holdId: hold.holdId }),
        });
        window.location.href = (await res.json()).paymentUrl;
      }}
    />
  );
}
```

`SeatPicker` is the complete buyer flow. `SeatingChart` is the map alone, inside your own UI.
[React guide](https://docs.seatlayer.io/buyer-sdk/react/)

## Vue seat map

```bash
npm install @seatlayer/vue
```

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { SeatingChart, type SeatingChartExposed } from '@seatlayer/vue';

const chart = ref<SeatingChartExposed | null>(null);
</script>

<template>
  <SeatingChart
    ref="chart"
    event="<YOUR_EVENT_KEY>"
    public-key="<YOUR_PUBLIC_KEY>"
    style="width: 100%; height: 520px"
    @hold="({ holdId }) => bookOnYourServer(holdId)"
  />
  <button @click="chart?.hold()">Continue</button>
</template>
```

`SeatingChart` is the map alone, so your own button calls `hold()` and `@hold` hands you the
`holdId`. [Vue guide](https://docs.seatlayer.io/buyer-sdk/vue/)

## Angular seat map

```bash
npm install @seatlayer/angular
```

```html
<seatlayer-seating-chart
  #chart
  event="<YOUR_EVENT_KEY>"
  publicKey="<YOUR_PUBLIC_KEY>"
  style="display:block; height:520px"
  (hold)="bookOnYourServer($event.holdId)"
/>
<button (click)="chart.holdSelection()">Continue</button>
```

Import `SeatLayerSeatingChartComponent` from `@seatlayer/angular` into your standalone component.
The chart is the map alone, so your own button calls `holdSelection()` and `(hold)` hands you the
`holdId`. [Angular guide](https://docs.seatlayer.io/buyer-sdk/angular/)

## Your server books the seats

```ts
// With @seatlayer/server and your secret key
const hold = await seatlayer.inventory.retrieveHold(eventKey, holdId); // the real prices
// ... take the payment with your own provider ...
await seatlayer.inventory.book(eventKey, { holdId, bookingRef: order.id });
```

Server SDKs for Node.js, Python, PHP, Java, Go, Ruby and .NET:
[server SDK guide](https://docs.seatlayer.io/server-sdk/install/).

## Features

- **Live availability and seat holds.** A seat another buyer holds disappears at once. A hold
  keeps the seats through your checkout and lapses on its own if the buyer leaves.
  [Holds and checkout](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/)
- **Best available.** `bestAvailable(4)` finds and holds the best four seats together.
- **3D venue and the view from each seat**, built from the same chart, on every plan, for venues
  up to 60,000 seats. The React `SeatPicker` and `SeasonPicker` take `max3DSeats` to change that
  limit (by default 60,000 on desktop and 30,000 on small or low-core devices).
  [3D view](https://docs.seatlayer.io/buyer-sdk/3d-view/) · [3D seat map](https://seatlayer.io/3d-seat-map/)
- **Season tickets.** `SeasonPicker` (in Angular, `SeatLayerSeasonPickerComponent`) holds the
  same seat on every date of a season, and returning holders can renew from an offer your server
  issues. [Seasons](https://docs.seatlayer.io/buyer-sdk/seasons/) · [Season tickets](https://seatlayer.io/season-tickets/)
- **Your checkout, your payment provider.** The browser holds; your server books with a stable
  `bookingRef`. By default nothing in these packages takes a payment; the opt-in hosted checkout
  (`checkout: 'hosted'`) is the other option.
- **Your brand.** Theme, currency and language options, and no SeatLayer badge for buyers, on any plan.
- **Organizer tools in your app.** `SeatManager` (live control room) in all three packages, and
  `EmbeddedDesigner` (chart designer) in React.
- **AI agents.** The picker can register seat-selection tools for browser agents.
  [WebMCP tools](https://docs.seatlayer.io/buyer-sdk/webmcp-agent-tools/)
- **TypeScript types included.** React and Vue ship ESM and CommonJS builds; Angular ships an
  Angular Package Format build.

## Frequently asked questions

### Which seat map SDK can I use with React, Vue or Angular?
SeatLayer gives you a complete seat picker or a bare seating chart with live availability, seat
holds, best available and, on every plan, a 3D view from each seat for venues up to 60,000 seats.
You pay only for sold seats: 100 a month are free, then 10¢ down to 5¢ a seat, and credits you buy
never expire. The same charts run in React, Vue, Angular, iOS, Android, Flutter and React Native,
and your own server and payment provider keep the order and the money. The 2D map is benchmarked
at 200,000 seats; the measured figures are under Scale evidence below.

### How much does the SeatLayer SDK cost?
Building and testing is free. On the SDK you pay per sold seat: the first 100 sold seats each month
are free, then 10¢ down to 5¢ a seat, with no subscription. Credits you buy never expire.

### How do I stop two buyers taking the same seat?
In the SeatLayer picker, a buyer's seats are held when they go to checkout; with the bare chart,
your code calls hold. Every other buyer sees held seats as taken at once, and your server books the
hold after payment. A hold that is never booked lapses on its own, so nothing stays locked.

### Can I move from seats.io?
Yes. You rebuild each chart in the SeatLayer Designer (from your floor plan, a template, an SVG or
DXF file, or a description), and the migration guide maps seats.io events, categories, hold tokens,
labels, channels, seasons and webhooks to their SeatLayer equivalents. The rebuilt chart opens in
3D with the view from each seat, for venues up to 60,000 seats.

### Can I use my own payment provider?
Yes. By default nothing in these packages takes a payment: your server reads the held seats and
their prices, charges through the provider you already use, and books the hold. The opt-in hosted
checkout is the other option, for a site with no backend of its own.

### Does it work with Next.js?
Yes. Import the component in a client component. The Next.js example in this organization shows
the full flow, including the server route that books the hold.

## Where to go next

| Topic | Docs | On seatlayer.io |
|---|---|---|
| React, Vue, Angular | [React](https://docs.seatlayer.io/buyer-sdk/react/) · [Vue](https://docs.seatlayer.io/buyer-sdk/vue/) · [Angular](https://docs.seatlayer.io/buyer-sdk/angular/) | [For developers](https://seatlayer.io/developers/) |
| Checkout and booking | [Holds and checkout](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/) | [JavaScript seating chart guide](https://seatlayer.io/guides/javascript-seating-chart/) |
| 3D and the view from a seat | [3D view](https://docs.seatlayer.io/buyer-sdk/3d-view/) | [3D seat map](https://seatlayer.io/3d-seat-map/) · [View from seat](https://seatlayer.io/view-from-seat/) |
| Season tickets | [Seasons](https://docs.seatlayer.io/buyer-sdk/seasons/) | [Season tickets](https://seatlayer.io/season-tickets/) |
| Moving from seats.io | [Migration guide](https://docs.seatlayer.io/integrations/migrate-from-seatsio/) | [SeatLayer vs seats.io](https://seatlayer.io/vs/seats-io/) |
| Examples | [React example](https://github.com/seatlayer/seatlayer-react-example) · [Next.js example](https://github.com/seatlayer/seatlayer-nextjs-example) | [Live demos](https://seatlayer.io/demo/) |
| Mobile and server SDKs | [Mobile SDKs](https://docs.seatlayer.io/buyer-sdk/mobile/) · [Server SDKs](https://docs.seatlayer.io/server-sdk/install/) | |

## Scale evidence

Benchmarked on public 100,000-, 150,000- and 200,000-seat venue fixtures on 15 September 2026: 200,000 seats chart-ready in 1.95 s, desktop, local production build. Tested at 10,000 simulated concurrent buyers on one 12,000-seat event (18 September 2026): engine-side hold latency p99 9 ms, zero server errors. Method, fixtures and run files: https://github.com/seatlayer/seatlayer-performance. Live 200,000-seat stadium demo: https://app.seatlayer.io/demo/play/century-stadium-200k.

## Versions and support

The three packages release together with `@seatlayer/js` and share its version number. Release
notes: [changelog](https://docs.seatlayer.io/changelog/) and
[GitHub Releases](https://github.com/seatlayer/seatlayer-sdk/releases). Security issues:
[SECURITY.md](./SECURITY.md). Questions: hello@seatlayer.io. Contributing:
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

The React, Vue and Angular wrapper source in this repository is MIT licensed. The SeatLayer runtime
it loads (`@seatlayer/js`, `@seatlayer/core`) is distributed under its own licence.
