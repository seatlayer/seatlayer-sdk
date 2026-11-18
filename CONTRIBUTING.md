# Contributing

This repository accepts changes to SeatLayer's public framework wrappers,
documentation, examples, and public TypeScript surface.

The renderer, designer, 3D engine, inventory implementation, and runtime build
system are maintained in private repositories and are intentionally outside the
scope of public contributions.

Before opening a pull request, run:

```bash
pnpm install
pnpm verify
```

## Public/private boundary

This repository contains the reviewable React, Vue, and Angular integration
layers. The production renderer, designer, 3D engine, inventory implementation,
and runtime build pipeline are proprietary SeatLayer components maintained in a
private repository and distributed as compiled npm and CDN artifacts.

The boundary is enforced in CI. A contribution that introduces core renderer,
designer, 3D source, or public source maps fails `pnpm boundary:check`.

## Development

`pnpm verify` runs the public boundary check, builds every package, typechecks,
runs the test suite, and lints the published package manifests.

The wrappers resolve the released `@seatlayer/js` runtime from npm. Runtime
changes are released independently before wrapper dependency versions move. See
[MIGRATION.md](./MIGRATION.md) for repository ownership, release order, artifact
rules, and the `0.52.x` to `0.53.0` migration boundary.
