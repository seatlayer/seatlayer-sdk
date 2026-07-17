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

Every release uses one version for npm and the CDN. Push a `vX.Y.Z` tag only
after `pnpm release:prep` passes. The release workflow then:

1. builds all three npm packages and a self-contained browser bundle from the
   same `packages/{core,js}` source tree;
2. publishes and hash-verifies immutable CDN files at
   `https://cdn.seatlayer.io/sdk/vX.Y.Z/`;
3. publishes `@seatlayer/core`, `@seatlayer/js`, and `@seatlayer/react` with npm
   provenance; and
4. promotes `https://cdn.seatlayer.io/sdk/v1/seatmap.js` only after npm succeeds.

Do not run `npm publish` manually. See [RELEASING.md](RELEASING.md).
