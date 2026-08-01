# @seatlayer/vue

[![npm](https://img.shields.io/npm/v/@seatlayer/vue)](https://www.npmjs.com/package/@seatlayer/vue)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/vue)](https://www.npmjs.com/package/@seatlayer/vue)
[![Vue](https://img.shields.io/badge/Vue-%E2%89%A53.3-42B883.svg)](https://vuejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The official Vue 3 components for SeatLayer reserved seating. Render an
interactive chart, hold inventory in the browser, and complete the booking from
your trusted server.

[Package on npm](https://www.npmjs.com/package/@seatlayer/vue) ·
[SeatPicker docs](https://docs.seatlayer.io/buyer-sdk/seat-picker/) ·
[Live demo](https://app.seatlayer.io/demo/play) ·
[Website](https://seatlayer.io/developers/)

## Install

```bash
npm install @seatlayer/vue
```

Requires Vue 3.3 or newer. Components are shipped as render functions, so you
need no Vue compiler plugin to consume this package.

## Usage

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
    style="width: 100%; height: 520px"
    @selection-change="onSelectionChange"
    @hold="({ holdId }) => bookOnYourServer(holdId)"
  />
  <button @click="checkout">Continue</button>
</template>
```

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `event` | `string` | **Required.** Changing it rebuilds the chart. |
| `apiBase` | `string` | Defaults to the public API. |
| `maxSelection` | `number` | Cap on how many seats a buyer may select. |
| `publicKey` | `string` | Publishable key, when your integration uses one. |
| `locale` | `string` | BCP-47 locale for built-in copy. |
| `currency` | `string` | ISO currency for price formatting. |
| `colorblindSafe` | `boolean` | Render colorblind-safe seat glyphs. |
| `seatTooltip` | `boolean` | Set `false` to draw your own popover from `@seat-hover`. |
| `messages` | `object` | Copy overrides. Read once per rebuild. |

Only `event`, `apiBase`, `maxSelection`, `publicKey`, `locale`, `currency` and
`colorblindSafe` rebuild the canvas. Everything else is read live, so a parent
re-render never destroys the chart mid-selection.

## Events

| Event | Payload |
| --- | --- |
| `@selection-change` | `SelectedSeat[]` |
| `@hold` | `HoldResult` |
| `@hold-restored` | `HoldResult` |
| `@hold-expired` | — |
| `@ga-click` | `GAAreaAvailability` |
| `@error` | `unknown` |
| `@deck-tap` | `string` (floor id) |
| `@hint` | `string \| null` — `null` clears the hint |
| `@seat-hover` | `SeatHoverDetails \| null` — `null` when the pointer leaves |

## Imperative API

Everything on the template ref, typed as `SeatingChartExposed`:

`hold` · `resumeHold` · `getCurrentHold` · `getGAAreas` · `holdGA` ·
`bestAvailable` · `release` · `releaseLabels` · `getSelection` · `setSeatTier` ·
`getFloors` · `setFloor` · `setColorblindSafe` · `zoomIn` · `zoomOut` ·
`zoomToFit`

## Also exported

- `SeatPickerWidget` — the framework-agnostic one-call modal (`SeatPickerWidget.open()`).
- `attachPickerFrame` — host-side iframe helper; grows on `seatlayer:height` and
  pins on `seatlayer:fullscreen`.

## Related

- [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) — React components
- [`@seatlayer/angular`](https://www.npmjs.com/package/@seatlayer/angular) — Angular component
- [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) — framework-agnostic core
- [Server SDKs](https://docs.seatlayer.io/server-sdk/install/) — Node.js, Python, PHP, Java, Go, Ruby, .NET

## License

MIT
