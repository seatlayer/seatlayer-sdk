# @seatlayer/core

[![npm](https://img.shields.io/npm/v/@seatlayer/core)](https://www.npmjs.com/package/@seatlayer/core)
[![npm downloads](https://img.shields.io/npm/dm/@seatlayer/core)](https://www.npmjs.com/package/@seatlayer/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](../../LICENSE)

The low-level, framework-agnostic rendering engine and shared domain model behind
the SeatLayer SDKs. It is pure TypeScript with a hardware-accelerated canvas
renderer and an optional WebGL venue view.

[Package on npm](https://www.npmjs.com/package/@seatlayer/core) ·
[Source](https://github.com/seatlayer/seatlayer-sdk/tree/main/packages/core) ·
[Developer docs](https://docs.seatlayer.io/) ·
[Live demo](https://app.seatlayer.io/demo/play) ·
[AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

> **Most applications should not install this package directly.** Use
> [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) or
> [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) when you
> need SeatLayer's hosted chart transport, live inventory, holds, and buyer UI.

## Install

```bash
npm install @seatlayer/core
```

Its runtime dependencies are normal package dependencies and install with
the package.

## Use it when

Install `@seatlayer/core` directly when you are:

- building a SeatLayer SDK wrapper for another UI framework or platform;
- rendering an already-authorized `ChartDoc` with your own data transport;
- implementing a specialized preview, operator, or evidence surface; or
- consuming shared chart layout, section, GA, panorama, quality, i18n, or money
  primitives.

For a regular checkout integration, start with the
[Buyer SDK installation guide](https://docs.seatlayer.io/buyer-sdk/install/).

## Main exports

| Export | Purpose |
| --- | --- |
| `createRenderer` / `SeatmapRenderer` | Create and control the seat-map renderer |
| `PickerController` | Coordinate selection and seat status with a host-supplied transport |
| `ChartDoc`, `SeatStatus`, and domain types | Use the canonical chart and inventory contracts |
| `expandChart` and layout helpers | Expand venue geometry into positioned bookable objects |
| GA and section helpers | Work with capacities, tiers, hierarchy, and section state |
| `generatePanorama` | Generate the optional buyer panorama representation |
| rendered-quality helpers | Validate labels, hierarchy, and visual evidence |
| i18n and money helpers | Reuse SeatLayer locale and price formatting behavior |
| `@seatlayer/core/view3d` | Load the optional 3D view entry point |

The package exports TypeScript declarations for both ESM and CommonJS consumers.

## Renderer lifecycle

`@seatlayer/core` does not fetch a chart or connect to live inventory. Provide a
trusted `ChartDoc`, apply status changes from your own transport, and destroy the
renderer with the host view.

```ts
import {
  createRenderer,
  type ChartDoc,
} from '@seatlayer/core';

const container = document.querySelector<HTMLDivElement>('#seat-map');
if (!container) throw new Error('Missing #seat-map container');

const chart: ChartDoc = await loadAuthorizedChart();
const renderer = createRenderer(container, { maxSelection: 10 });

renderer.setChart(chart);
renderer.setStatus(['seat_42'], 'booked');

// During host teardown:
renderer.destroy();
```

Give the container an explicit width and height. The renderer owns pan, zoom,
selection, and drawing inside that box.

## Responsibilities you still own

Direct consumers must deliberately provide:

- authorized chart loading and schema/version handling;
- initial and realtime seat-status transport;
- reconnect, stale-state, and conflict recovery;
- hold, extension, release, best-available, and booking orchestration;
- server-only secret handling and authoritative pricing; and
- responsive, keyboard, touch, accessibility, and teardown behavior.

If you do not need to own all of those boundaries, the higher-level SDK is the
safer integration surface.

## Security model

Rendering is a client concern; permanent booking is not. A browser or mobile app
may select and hold seats, but only a trusted server should inspect the hold,
calculate the charge, and book using a secret key. See
[how the integration works](https://docs.seatlayer.io/start/how-it-works/).

## Related resources

- [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js)
- [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react)
- [Complete checkout example](https://docs.seatlayer.io/examples/complete-checkout/)
- [SeatLayer developer site](https://seatlayer.io/developers/)
- [Agent-readable documentation](https://docs.seatlayer.io/llms.txt)

## License

MIT © SeatLayer
