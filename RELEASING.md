# Developing & releasing the SeatLayer SDK

The rule that makes everything else work:

> **The main app (`seatmap/src`) is the single source of truth for the rendering
> engine.** The files under `packages/core/src/{core,engine,picker,i18n,lib}` are a
> generated mirror — never hand-edit them.

## Who owns what

| Code | Source of truth | How to change it |
| --- | --- | --- |
| Engine: `packages/core/src/{core,engine,picker,i18n,lib}` | **The app** (`seatmap/src/{core,engine,picker,i18n,lib}`) | Edit it in the app, then `pnpm sync:core` |
| `@seatlayer/core` barrel (`packages/core/src/index.ts`) | This repo | Edit here |
| `@seatlayer/js` (`packages/js/src`) | This repo | Edit here |
| `@seatlayer/react` (`packages/react/src`) | This repo | Edit here |

Why a copy instead of the app importing this package? While the engine is under
active development in the app, editing it there gives instant local iteration (the
dashboard uses those files directly). The SDK is a periodic, versioned *export* of
that engine. See "Migration trigger" below for when this changes.

## Day-to-day development

- **Engine work** happens in the app (`seatmap`), as normal. Nothing to do here.
- **Wrapper/SDK work** (js/react/core-barrel) happens in this repo:
  `pnpm install && pnpm build && pnpm typecheck`.

## Releasing (the only supported path)

Cut releases **only from a clean, committed app state** — never with uncommitted
engine WIP in the app, or you ship half-finished changes.

```bash
# from the SDK repo root, with ../seatmap on a clean commit:
pnpm release:prep            # sync:core → check:sync → build → typecheck
# bump the versions you're releasing (see semver note), then:
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z && git push origin main --tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which builds and runs
`pnpm -r publish --provenance` — publishing every package whose version isn't yet
on npm, in dependency order, with a signed provenance attestation.

### Hard rules

- **Never `npm publish`.** Always the pnpm/CI path. Plain `npm publish` leaves the
  literal `workspace:*` in dependencies and breaks `npm install` (this is why
  `0.1.0` had to be re-cut as `0.1.1`).
- **Never sync with uncommitted app WIP.** `pnpm check:sync` guards against a stale
  or mid-edit engine before you tag.
- **Publish only via the tag → CI flow** (provenance + correct workspace→semver).

### Versioning (semver, currently 0.x)

- Engine/behaviour change or new API → **minor** (`0.1.x` → `0.2.0`).
- Bug fix / metadata → **patch** (`0.1.1` → `0.1.2`).
- Keep the three packages in lockstep on the same version unless a change is truly
  isolated to one.

## Migration trigger (retire the copy-and-sync)

Move the app to **consume `@seatlayer/core`** directly (delete the app's local
engine copy, import the package, drop `sync-core.mjs`) when **any** of these is true:

- Engine changes become infrequent (≈ less than one a month), or
- A second internal consumer of the engine appears, or
- Drift causes a real incident.

Until then, copy-and-sync is the deliberate, chosen model.
