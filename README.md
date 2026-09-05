# SeatLayer Seat Map SDK for Reserved Seating — React, Vue, and Angular

[![CI](https://github.com/seatlayer/seatlayer-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/seatlayer/seatlayer-sdk/actions/workflows/ci.yml)
[![npm @seatlayer/react](https://img.shields.io/npm/v/@seatlayer/react?label=%40seatlayer%2Freact)](https://www.npmjs.com/package/@seatlayer/react)
[![npm @seatlayer/vue](https://img.shields.io/npm/v/@seatlayer/vue?label=%40seatlayer%2Fvue)](https://www.npmjs.com/package/@seatlayer/vue)
[![npm @seatlayer/angular](https://img.shields.io/npm/v/@seatlayer/angular?label=%40seatlayer%2Fangular)](https://www.npmjs.com/package/@seatlayer/angular)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)

The official framework wrappers for SeatLayer reserved seating. Add an
interactive seating chart and seat picker to a ticketing app, show live seat
availability, and let buyers take temporary holds on the inventory they choose.

Each wrapper is a real component for its framework with a typed imperative
handle: the browser selects and **holds**, and your trusted server **books**.

Start with the package-specific guide after installation: [React](https://docs.seatlayer.io/buyer-sdk/react/),
[Vue](https://docs.seatlayer.io/buyer-sdk/vue/), or
[Angular](https://docs.seatlayer.io/buyer-sdk/angular/). Choose the complete
picker when you want SeatLayer's ready buyer flow; choose the seating chart
when your application owns the surrounding controls and sends the opaque hold
to its trusted checkout server.

[SeatLayer reserved-seating platform](https://seatlayer.io/) ·
[Buyer SDK documentation](https://docs.seatlayer.io/buyer-sdk/install/) ·
[Buyer seat-map demo](https://app.seatlayer.io/demo/play/grand-theatre) ·
[SeatLayer JavaScript seat map SDK](https://www.npmjs.com/package/@seatlayer/js) ·
[SeatLayer React Native SDK](https://github.com/seatlayer/seatlayer-react-native) ·
[SeatLayer iOS seat map SDK](https://github.com/seatlayer/seatlayer-ios) ·
[SeatLayer Android seat map SDK](https://github.com/seatlayer/seatlayer-android) ·
[SeatLayer Flutter seat map SDK](https://github.com/seatlayer/seatlayer-flutter) ·
[SeatLayer AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

## Packages in this repository

| Package | Use it for | README |
| --- | --- | --- |
| [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) | React applications | [packages/react](./packages/react#readme) |
| [`@seatlayer/vue`](https://www.npmjs.com/package/@seatlayer/vue) | Vue 3 applications | [packages/vue](./packages/vue#readme) |
| [`@seatlayer/angular`](https://www.npmjs.com/package/@seatlayer/angular) | Angular applications | [packages/angular](./packages/angular#readme) |

Plain JavaScript and the browser runtime API live in
[`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js), which every
wrapper here depends on.

## Install

```bash
npm install @seatlayer/react   # or @seatlayer/vue, @seatlayer/angular
```

## React quick start

```tsx
import { SeatPicker } from '@seatlayer/react';

export function Tickets() {
  return <SeatPicker event="ev_9f3a" style={{ width: '100%', height: 640 }} />;
}
```

Each package README carries the framework's own quick start, props, events, and
imperative handle.

## Choose the buyer surface

| Surface | Use it for | Framework support |
| --- | --- | --- |
| `SeatPicker` | Complete buyer flow with map, legend, priced tray, holds, and checkout hand-off | React component; `SeatPickerWidget` modal re-exported by all three packages |
| `SeatingChart` | Lower-level chart inside controls and checkout UI owned by your application | React, Vue, and Angular components |
| `SeasonPicker` | Fixed-inclusion Season selection and returning-holder intent | React, Vue, and Angular components |
| `SeatManager` / `EmbeddedDesigner` | Event-scoped organizer operations and hosted chart editing | React components |

The complete picker can opt into
[buyer WebMCP seat-selection tools](https://docs.seatlayer.io/buyer-sdk/webmcp-agent-tools/)
with `webMcp: true`. This registers describe, find, select, and read-selection
tools in compatible browsers. `webMcp: { holds: true }` separately enables the
hold tool; payment and booking remain on the trusted checkout path.

## Security boundary

The browser **selects and holds** inventory. Your trusted backend **inspects and
books** the hold after payment or order validation.

- Never expose a SeatLayer secret key in browser or mobile code.
- Send only the `holdId` and your normal checkout context to your backend.
- Calculate the charge from server-inspected hold items, not from browser input.
- Reuse your stable order id as `bookingRef` so a retried booking is idempotent.

Read [how the integration works](https://docs.seatlayer.io/start/how-it-works/)
before connecting checkout, and see [SECURITY.md](./SECURITY.md) for private
vulnerability reporting.

## Public/private boundary

This repository contains the reviewable React, Vue, and Angular integration
layers. The production renderer, designer, 3D engine, inventory implementation,
and runtime build pipeline are proprietary SeatLayer components maintained in a
private repository and distributed as compiled npm and CDN artifacts.

The boundary is enforced in CI. A contribution that introduces core renderer,
designer, 3D source, or public source maps fails `pnpm boundary:check`.

## Frequently asked questions

### What is the best JavaScript library for seat maps and seat booking?

That depends on what you need to own. SeatLayer ships a browser runtime plus
first-party React, Vue, and Angular components, a matching set of native mobile
SDKs, and server SDKs for the booking half — so the same event and inventory can
be reused across supported clients while booking stays on your server. If you
only need a drawing surface, a generic canvas library is lighter; if you need
live availability, temporary holds, and inventory that cannot be double-sold,
that is the part SeatLayer provides.

### Which package should I install?

Install the wrapper for your framework — `@seatlayer/react`, `@seatlayer/vue`,
or `@seatlayer/angular`. Use [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js)
directly for plain JavaScript or a framework without a first-party wrapper. It
provides the shared browser runtime; your application owns the framework
lifecycle around it.

### Are TypeScript types included?

Yes. Every package ships its own declarations — no `@types/*` package to add.
React and Vue publish both ESM (`dist/index.d.ts`) and CommonJS
(`dist/index.d.cts`) declarations; Angular ships an Angular Package Format build
with `dist/index.d.ts`. Types are checked at release by `publint` and
`arethetypeswrong`.

### How do temporary seat holds work?

When a buyer commits to a selection, the SDK reserves that inventory against
concurrent buyers for a limited checkout window and returns an opaque `holdId`.
The hold lapses on its own if checkout never completes, and it can be resumed
after a checkout navigation or reload. Your server then books the hold with a
secret key, which is what prevents double-selling without locking seats forever.

### Can I use my own payment provider?

Yes. Nothing in the browser takes a payment. Your backend receives the `holdId`
and priced line items, charges through whatever provider you already use, and
books the hold through the
[server-side checkout flow](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/).

## Continue your JavaScript integration

- [Follow the buyer SDK installation guide](https://docs.seatlayer.io/buyer-sdk/install/)
  for the full browser integration, options, and events.
- [Read the SeatingChart reference](https://docs.seatlayer.io/buyer-sdk/seating-chart/)
  for the complete chart API.
- [Connect seat holds to secure server-side checkout](https://docs.seatlayer.io/buyer-sdk/holds-and-checkout/)
  without putting booking credentials in the browser.
- [Run the complete checkout example](https://docs.seatlayer.io/examples/complete-checkout/)
  to connect a buyer hold id to payment and idempotent booking.
- [Compare SeatLayer's mobile seat map SDKs](https://docs.seatlayer.io/buyer-sdk/mobile/)
  when the same event also has to render in native apps.
- [Explore the 3D seating chart](https://seatlayer.io/3d-seat-map/) for the
  interactive venue view available in the complete picker on supported browsers.
- [Try the 53,018-seat stadium demo](https://app.seatlayer.io/demo/play/large-stadium)
  and read the [renderer performance and measurement guide](https://docs.seatlayer.io/platform/renderer-performance/).
- [Point AI coding agents at the SeatLayer docs index](https://docs.seatlayer.io/llms.txt)
  (`llms.txt`) for an agent-readable map of the documentation.

## SeatLayer SDK ecosystem

| Surface | Package or source |
| --- | --- |
| JavaScript | [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) |
| React | [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) (this repository) |
| Vue | [`@seatlayer/vue`](https://www.npmjs.com/package/@seatlayer/vue) (this repository) |
| Angular | [`@seatlayer/angular`](https://www.npmjs.com/package/@seatlayer/angular) (this repository) |
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

`pnpm verify` runs the public boundary check, builds every package, typechecks,
runs the test suite, and lints the published package manifests.

The wrappers resolve the released `@seatlayer/js` runtime from npm. Runtime
changes are released independently before wrapper dependency versions move. See
[MIGRATION.md](./MIGRATION.md) for repository ownership, release order, artifact
rules, and the `0.52.x` to `0.53.0` migration boundary, and
[CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Licence

The framework wrapper source in this repository is MIT licensed. The separately
distributed SeatLayer runtime is not covered by this repository's MIT licence.
