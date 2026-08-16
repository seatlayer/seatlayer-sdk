# @seatlayer/angular

[![npm](https://img.shields.io/npm/v/@seatlayer/angular)](https://www.npmjs.com/package/@seatlayer/angular)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/angular)](https://www.npmjs.com/package/@seatlayer/angular)
[![Angular](https://img.shields.io/badge/Angular-%E2%89%A517-DD0031.svg)](https://angular.dev/)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The official Angular wrapper for SeatLayer reserved seating provides one native
Angular component: `SeatLayerSeatingChartComponent`. The buyer modal and iframe
integration remain the framework-agnostic JavaScript `SeatPickerWidget` and
`attachPickerFrame` helpers exported by this package; they are not additional
Angular components.

[Package on npm](https://www.npmjs.com/package/@seatlayer/angular) ·
[SeatPicker docs](https://docs.seatlayer.io/buyer-sdk/seat-picker/) ·
[Live demo](https://app.seatlayer.io/demo/play) ·
[Website](https://seatlayer.io/developers/)

## Install

```bash
npm install @seatlayer/angular
```

Requires Angular 17 or newer. The component is **standalone** — import it
directly, no NgModule needed.

## Usage

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
| `publicKey` | `string` | Reserved compatibility input; stored by the chart but not transmitted to SeatLayer. |
| `locale` | `string` | BCP-47 locale for built-in copy. |
| `currency` | `string` | ISO currency for price formatting. |
| `colorblindSafe` | `boolean` | Render colorblind-safe seat glyphs. |
| `seatTooltip` | `boolean` | Set `false` to draw your own popover from `(seatHover)`. |
| `messages` | `object` | Copy overrides. Read once per rebuild. |

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
`zoomToFit`

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

## Related

- [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) — React components
- [`@seatlayer/vue`](https://www.npmjs.com/package/@seatlayer/vue) — Vue 3 components
- [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) — framework-agnostic core
- [Server SDKs](https://docs.seatlayer.io/server-sdk/install/) — Node.js, Python, PHP, Java, Go, Ruby, .NET

## License

MIT
