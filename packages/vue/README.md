# @seatlayer/vue

[![npm](https://img.shields.io/npm/v/@seatlayer/vue)](https://www.npmjs.com/package/@seatlayer/vue)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/vue)](https://www.npmjs.com/package/@seatlayer/vue)
[![Vue](https://img.shields.io/badge/Vue-%E2%89%A53.3-42B883.svg)](https://vuejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The official Vue 3 wrapper for SeatLayer reserved seating provides one native
Vue component: `SeatingChart`. The buyer modal and iframe integration remain
the framework-agnostic JavaScript `SeatPickerWidget` and `attachPickerFrame`
helpers exported by this package; they are not additional Vue components.

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
| `selectedObjects` | `string[]` | Initial object ids or public labels. |
| `selectableObjects` | `string[] \| null` | Buyer-selectable allow-list. |
| `numberOfPlacesToSelect` | `number` | Exact count required for a valid selection. |
| `selectionValidators` | `PickerSelectionValidator[]` | Minimum, consecutive-seat, and no-orphan guards. |
| `publicKey` | `string` | Reserved compatibility input; stored by the chart but not transmitted to SeatLayer. |
| `locale` | `string` | BCP-47 locale for built-in copy. |
| `currency` | `string` | ISO currency for price formatting. |
| `colorblindSafe` | `boolean` | Render colorblind-safe seat glyphs. |
| `seatTooltip` | `boolean` | Set `false` to draw your own popover from `@seat-hover`. |
| `messages` | `object` | Copy overrides. Read once per rebuild. |

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

## Imperative API

Everything on the template ref, typed as `SeatingChartExposed`:

`hold` · `resumeHold` · `getCurrentHold` · `getGAAreas` · `holdGA` ·
`bestAvailable` · `release` · `releaseLabels` · `getSelection` · `setSeatTier` ·
`selectObjects` · `deselectObjects` · `clearSelection` · `selectCategories` ·
`deselectCategories` · `setSelectableObjects` · `setMaxSelection` ·
`getSelectionValidity` ·
`getFloors` · `setFloor` · `setColorblindSafe` · `zoomIn` · `zoomOut` ·
`zoomToFit`

## Also exported

- `SeatPickerWidget` — raw framework-agnostic JavaScript one-call modal (`SeatPickerWidget.open()`).
- `attachPickerFrame` — raw framework-agnostic JavaScript iframe helper; grows on `seatlayer:height` and
  pins on `seatlayer:fullscreen`.

## Related

- [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) — React components
- [`@seatlayer/angular`](https://www.npmjs.com/package/@seatlayer/angular) — Angular component
- [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) — framework-agnostic core
- [Server SDKs](https://docs.seatlayer.io/server-sdk/install/) — Node.js, Python, PHP, Java, Go, Ruby, .NET

## License

MIT
