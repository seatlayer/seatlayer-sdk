# SeatLayer SDK

Official public framework wrappers for the SeatLayer reserved-seating SDK.

| Package | Use it for |
| --- | --- |
| [`@seatlayer/js`](https://www.npmjs.com/package/@seatlayer/js) | Plain JavaScript and the browser runtime API |
| [`@seatlayer/react`](./packages/react) | React applications |
| [`@seatlayer/vue`](./packages/vue) | Vue 3 applications |
| [`@seatlayer/angular`](./packages/angular) | Angular applications |

```bash
npm install @seatlayer/react
```

```tsx
import { SeatPicker } from '@seatlayer/react';

export function Tickets() {
  return <SeatPicker event="ev_9f3a" style={{ width: '100%', height: 640 }} />;
}
```

See the [SeatLayer developer documentation](https://docs.seatlayer.io/) for
installation, checkout, hold, security, and framework guides.

## Public/private boundary

This repository contains the reviewable React, Vue, and Angular integration
layers. The production renderer, designer, 3D engine, inventory implementation,
and runtime build pipeline are proprietary SeatLayer components maintained in a
private repository and distributed as compiled npm/CDN artifacts.

The boundary is enforced in CI. A contribution that introduces core renderer,
designer, 3D source, or public source maps fails `pnpm boundary:check`.

## Development

```bash
pnpm install
pnpm verify
```

The wrappers resolve the released `@seatlayer/js` runtime from npm. Runtime
changes are released independently before wrapper dependency versions move.

See [MIGRATION.md](./MIGRATION.md) for repository ownership, release order,
artifact rules, and the `0.52.x` to `0.53.0` migration boundary.

## Security

Never expose a SeatLayer secret key in browser or mobile code. See
[SECURITY.md](./SECURITY.md) for private vulnerability reporting.

## Licence

The framework wrapper source in this repository is MIT licensed. The separately
distributed SeatLayer runtime is not covered by this repository's MIT licence.
