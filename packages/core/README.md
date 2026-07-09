# @seatlayer/core

The shared, framework-agnostic seat-rendering engine behind the
[SeatLayer](https://seatlayer.io) SDKs. Pure TypeScript + [Konva](https://konvajs.org/)
(HTML canvas) — no framework.

> **You almost never install this directly.** It's the low-level engine shared by
> the SeatLayer SDKs. Use one of these instead:
>
> - **[`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js)** — the SDK for plain JS and any framework
> - **[`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react)** — the React component

Full documentation: **<https://docs.seatlayer.io>**

## What's in here

`@seatlayer/core` renders a seat map onto a canvas and manages live buyer
interaction, independent of any UI framework:

- **`SeatmapRenderer`** / `createRenderer(container, opts)` — the Konva-based renderer
- **`PickerController`** — buyer selection + live seat-status state machine (hold / release / best-available), transport-agnostic
- **`expandChart`** and the chart layout helpers — turn a `ChartDoc` into positioned seats
- The shared domain **types** (`ChartDoc`, `Category`, `ExpandedSeat`, `SeatStatus`, …)

The higher-level SDKs (`@seatlayer/js`, `@seatlayer/react`) wrap this with the
public embed contract (mount a picker, hold seats, hand the `holdId` to your server).

## Install

```bash
npm install @seatlayer/core
```

Requires [`konva`](https://www.npmjs.com/package/konva) (declared as a dependency).

## License

MIT © SeatLayer
