# SeatLayer SDK

The official SeatLayer SDKs — a framework-agnostic core plus per-framework wrappers.
Render an interactive seat picker, let buyers select and **hold** seats in the browser,
then **book** them from your server. Docs: <https://docs.seatlayer.io>

## Packages

| Package | What it is | Use it when |
| --- | --- | --- |
| [`@seatlayer/core`](packages/core) | The shared rendering engine (Konva, no framework) | You almost never depend on this directly — it's the shared brain. |
| [`@seatlayer/js`](packages/js) | The vanilla SDK (`SeatingChart` class) | Plain HTML, or any framework via its lifecycle hooks (Vue, Svelte, Angular…). |
| [`@seatlayer/react`](packages/react) | React component wrapper | React apps — the flagship wrapper. |

New frameworks are added as thin wrappers over `@seatlayer/js` as needed
(`@seatlayer/vue`, `@seatlayer/svelte`, `@seatlayer/react-native`, …).

## Quick look

```tsx
// React
import { SeatingChart } from '@seatlayer/react';

<SeatingChart
  event="ev_9f3a"
  onHold={({ holdId }) => bookOnYourServer(holdId)}
/>;
```

```js
// Plain JS / any framework
import { SeatingChart } from '@seatlayer/js';

const chart = new SeatingChart({ container: '#chart', event: 'ev_9f3a' });
await chart.render();
```

For the **full buyer experience** (branded header, price panel, tray, hold
countdown, extend-hold, booked confirmation) use `SeatPicker` — inline, modal, or
a plain iframe. Copy-paste recipes: **[docs/embedding.md](docs/embedding.md)**.

## Develop

```bash
pnpm install
pnpm sync:core   # pull the latest engine from the main app (see below)
pnpm build       # build every package
pnpm typecheck
```

### The `@seatlayer/core` sync

The rendering engine is currently shared with the main SeatLayer app. Until the app
migrates to consume `@seatlayer/core` directly, `packages/core/src/{core,engine,picker}`
is **synced byte-for-byte** from the app with:

```bash
pnpm sync:core                                  # assumes ../seatmap
SEATMAP_REPO=/path/to/seatmap pnpm sync:core    # or point at it
```

Do not hand-edit files under `packages/core/src/core`, `.../engine`, or `.../picker` —
edit them in the app and re-sync. `packages/core/src/index.ts` (the barrel) is owned here.

## Publishing

`npm publish` is a manual, credentialed step (run by a maintainer with npm access).
Publish order respects the dependency graph: `core` → `js` → `react`.
