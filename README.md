# SeatLayer SDK

[![CI](https://github.com/seatlayer/seatlayer-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/seatlayer/seatlayer-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@seatlayer/js?label=%40seatlayer%2Fjs)](https://www.npmjs.com/package/@seatlayer/js)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)

Official JavaScript and React SDKs for SeatLayer reserved seating. Embed the
complete buyer picker or a headless seating chart, hold inventory in the
browser, and complete the booking from your trusted server.

[Website](https://seatlayer.io/) ·
[Developer docs](https://docs.seatlayer.io/) ·
[Demo hub](https://app.seatlayer.io/demo) ·
[Try the buyer experience](https://app.seatlayer.io/demo/play) ·
[AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)

## Choose a package

| Package | Use it for | Documentation |
| --- | --- | --- |
| [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) | Plain JavaScript, Vue, Svelte, Angular, and any DOM-based framework | [Install and embed](https://docs.seatlayer.io/buyer-sdk/install/) |
| [`@seatlayer/react`](https://www.npmjs.com/package/@seatlayer/react) | React applications and component-driven checkout flows | [SeatPicker reference](https://docs.seatlayer.io/buyer-sdk/seat-picker/) |
| [`@seatlayer/core`](https://www.npmjs.com/package/@seatlayer/core) | Low-level renderer and domain primitives for custom SDK authors | [Core package guide](packages/core/README.md) |

Most buyer integrations should start with `SeatPicker` from `@seatlayer/js` or
`@seatlayer/react`. Use `SeatingChart` only when your product intentionally owns
the surrounding selection, pricing, confirmation, and hold UI.

## Quick start

```bash
npm install @seatlayer/react
```

```tsx
import { SeatPicker } from '@seatlayer/react';

export function Tickets() {
  return (
    <SeatPicker
      event="ev_9f3a"
      style={{ width: '100%', height: 640 }}
      onCheckout={(_, __, handoff) => {
        beginCheckoutOnYourServer(handoff.holdId);
      }}
    />
  );
}
```

Plain JavaScript:

```bash
npm install @seatlayer/js
```

```js
import { SeatPicker } from '@seatlayer/js';

const picker = new SeatPicker({
  container: '#picker',
  event: 'ev_9f3a',
  onCheckout: (_, __, handoff) => {
    beginCheckoutOnYourServer(handoff.holdId);
  },
});

await picker.render();
```

The embed container needs an explicit usable height. See the
[installation guide](https://docs.seatlayer.io/buyer-sdk/install/) for hosted
script, browser ESM, npm, React, and responsive-container examples.

## Security boundary

The browser or mobile app **selects and holds** inventory. Your trusted server
**inspects and books** the hold after payment or order validation.

- Never expose a SeatLayer secret key in browser or mobile code.
- Calculate the charge from server-inspected hold items, not client input.
- Reuse your stable order id as `bookingRef` for safe retries.
- Treat `409` inventory conflicts and expired holds as expected recovery paths.

Read [how the integration works](https://docs.seatlayer.io/start/how-it-works/)
before building checkout.

## Mobile SDKs

| SDK | Status | Repository |
| --- | --- | --- |
| React Native | Public preview | [`seatlayer/seatlayer-react-native`](https://github.com/seatlayer/seatlayer-react-native) |
| iOS | Public release candidate | [`seatlayer/seatlayer-ios`](https://github.com/seatlayer/seatlayer-ios) |
| Android | Public preview | [`seatlayer/seatlayer-android`](https://github.com/seatlayer/seatlayer-android) |
| Flutter | Public release candidate | [`seatlayer/seatlayer-flutter`](https://github.com/seatlayer/seatlayer-flutter) |

See the [mobile SDK guide](https://docs.seatlayer.io/buyer-sdk/mobile/) for the
current installation and release status.

## Examples and agent support

- [Embedding recipes](docs/embedding.md)
- [Complete checkout example](https://docs.seatlayer.io/examples/complete-checkout/)
- [Live demo hub](https://app.seatlayer.io/demo)
- [SeatLayer AI Toolkit](https://github.com/seatlayer/seatlayer-ai-toolkit)
- [React Native SDK](https://github.com/seatlayer/seatlayer-react-native)
- [Native Android SDK](https://github.com/seatlayer/seatlayer-android)
- [Agent-readable docs index](https://docs.seatlayer.io/llms.txt)

## Development

```bash
pnpm install
pnpm sync:core
pnpm build
pnpm typecheck
pnpm test
```

The rendering engine is synced from SeatLayer's private platform source. Do not
hand-edit `packages/core/src/{core,engine,picker}`; update the platform source
and run `pnpm sync:core`. The public barrel in `packages/core/src/index.ts` is
owned here.

## Releasing

All npm packages and CDN channels use one version. Releases are created from a
`vX.Y.Z` tag only after `pnpm release:prep` passes. The GitHub workflow builds,
uploads and verifies the immutable CDN release, publishes all npm packages with
provenance, and then promotes the compatible CDN alias.

Do not run `npm publish` manually. Follow [RELEASING.md](RELEASING.md).

## License

MIT © SeatLayer
