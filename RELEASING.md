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
| CDN-only entry (`cdn/src`) | This repo | Edit here |

### The CDN bundle is a superset of npm

`cdn/src/index.ts` re-exports the whole `@seatlayer/js` public API **plus** the
internal headless-render entry `renderChartDocument` (and
`BUYER_RENDERER_CONTRACT_VERSION`), implemented in
`cdn/src/ChartDocumentPreview.ts`.

That entry paints a persisted `ChartDoc` with the production buyer renderer and
returns a quality report; Cloudflare Browser Rendering calls
`window.seatlayer.renderChartDocument(...)` to capture AI chart-review evidence.
It replaced the retired private `@seatlayer/js` 0.2.x bundle in the app repo.

It lives under `cdn/` and **not** in `packages/js` on purpose: it is QA tooling,
not a supported integration API, so it must never reach npm or the published
type surface. The IIFE global stays `seatlayer` (with the `window.seatmap`
back-compat footer) because the review worker depends on both.
`BUYER_RENDERER_CONTRACT_VERSION` is hard-validated by that worker — changing it
is a breaking change to a live consumer, and `pnpm verify:cdn` pins its value.

`cdn/` is not a workspace package, so `pnpm -r typecheck` misses it; root
`pnpm typecheck` runs `tsc -p cdn/tsconfig.json` as well to cover it.

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

`release:prep` also builds and verifies the browser CDN artifact. Pushing the tag
triggers `.github/workflows/release.yml`, which treats npm and CDN as one release:

1. the tag must exactly match the lockstep `core` / `js` / `react` version;
2. the CDN IIFE and ESM are built directly from `packages/js/src`, with
   `packages/core/src` aliased into that same build;
3. a release manifest records the SDK commit, upstream engine commit, package
   versions, byte sizes, and SHA-256 hashes;
4. immutable `/seatlayer-js@X.Y.Z/` files are uploaded to R2 and verified through
   the production CDN before npm publishing is allowed;
5. npm packages publish in dependency order with provenance; and
6. `/-/versions.json` is published only after npm succeeds — publishing it is
   what moves the mutable `seatlayer-js@<major>` channel.

The workflow is safely retryable: an existing npm version is skipped only after
its unpacked payload matches the local package byte-for-byte, while an existing
immutable CDN object must match the local SHA-256 or the release stops.

### Release infrastructure prerequisites

- R2 bucket: `seatlayer-sdk-releases`
- Worker/custom domain: `cdn/wrangler.jsonc` → `cdn.seatlayer.io`
- GitHub secrets: `NPM_TOKEN`, `CLOUDFLARE_API_TOKEN`, and
  `CLOUDFLARE_ACCOUNT_ID`
- The Cloudflare token needs Workers Scripts edit plus R2 object read/write.

Before the first custom-domain transfer, run `pnpm cdn:migrate:legacy` with
`SEATMAP_REPO` pointing at the app repository. It verifies every historical
`v0.1.0`–`v0.2.x` browser artifact that is actually live (and repairs any path
currently returning the dashboard SPA fallback) before copying it into R2. This
preserves old pinned integrations, including the internal buyer-review renderer
at `v0.2.11`.

Pinned versions stay in R2 permanently. Do not add an expiry lifecycle to any
pinned prefix — neither `seatlayer-js@X.Y.Z/` nor the legacy `sdk/vX.Y.Z/`.

## The CDN namespace

```
https://cdn.seatlayer.io/seatlayer-js@0.24.0/seatlayer.js    pinned, immutable
https://cdn.seatlayer.io/seatlayer-js@0.24.0/seatlayer.mjs   pinned, immutable
https://cdn.seatlayer.io/seatlayer-js@0/seatlayer.js         mutable major channel (302)
https://cdn.seatlayer.io/-/versions.json                     version index
```

Three properties are deliberate and must not be traded away:

- **The filename is constant across versions.** Upgrading is a one-token edit to
  the version, never a rename. (The old shape mixed `seatlayer.js` on pinned
  paths with `seatmap.js` on the alias — a trap.)
- **The mutable channel is a 302, never a byte copy.** A copied alias is a second
  artifact: it can silently drift from the pinned object, and because the two
  cache independently they can be served at different ages, producing torn
  deploys where a page loads mismatched chunks. A redirect has exactly one source
  of truth by construction. `pnpm verify:cdn:remote full` asserts the alias is a
  302 and checks its *target*, not downloaded bytes.
- **`-` is the index prefix** because it is an illegal npm package name, so it can
  never collide with a real `seatlayer-<pkg>@<version>` path. The `versions.json`
  body matches the shape jsDelivr/cdnjs/npm return, so agents recognise it with
  no documentation.

Cache-Control (Braintree-style hybrid — immortal at the edge, short in the
browser, so a bad build is actually purgeable):

| Path | Cache-Control |
| --- | --- |
| `seatlayer-js@X.Y.Z/*` | `public, s-maxage=31536000, max-age=3600, immutable` |
| `seatlayer-js@<major>/*` | `public, max-age=600, s-maxage=60` |
| `-/versions.json` | `public, max-age=60` |

`cdn/versions.json` is the committed ledger the index is rendered from.
`finalize-cdn.mjs` merges the version being released into it — **commit the
result** so the next release builds on it.

### Legacy paths

The previous `/sdk/vX.Y.Z/` and `/sdk/v1/seatmap.{js,mjs}` shapes are **still
served and always will be** — old pinned integrations must never break. They are
simply no longer *emitted*: no release writes them again.

Pre-reshape versions were never copied to the new prefix. The Worker instead maps
`/seatlayer-js@X.Y.Z/<file>` onto the legacy `sdk/vX.Y.Z/<file>` key when the
canonical key is absent, so every historical version resolves at the canonical URL
with no object backfill and no duplicate bytes in R2.

### Hard rules

- **Never `npm publish`.** Always the pnpm/CI path. Plain `npm publish` leaves the
  literal `workspace:*` in dependencies and breaks `npm install` (this is why
  `0.1.0` had to be re-cut as `0.1.1`).
- **Never sync with uncommitted app WIP.** `pnpm check:sync` guards against a stale
  or mid-edit engine before you tag.
- **Publish only via the tag → CI flow** (provenance + correct workspace→semver).
- **Never publish npm without the CDN gate.** If immutable CDN upload or
  verification fails, npm must remain unpublished.
- **Never overwrite a pinned CDN version.** Re-running a tag is allowed only when
  every existing immutable object has the same SHA-256.

### Versioning (semver, currently 0.x)

- Engine/behaviour change or new API → **minor** (`0.1.x` → `0.2.0`).
- Bug fix / metadata → **patch** (`0.1.1` → `0.1.2`).
- Keep all three packages and the CDN in lockstep on the same version. The
  release check rejects mixed versions.

## Migration trigger (retire the copy-and-sync)

Move the app to **consume `@seatlayer/core`** directly (delete the app's local
engine copy, import the package, drop `sync-core.mjs`) when **any** of these is true:

- Engine changes become infrequent (≈ less than one a month), or
- A second internal consumer of the engine appears, or
- Drift causes a real incident.

Until then, copy-and-sync is the deliberate, chosen model.
