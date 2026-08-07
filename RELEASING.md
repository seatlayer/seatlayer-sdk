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

### The `manager` subpath (npm only)

`@seatlayer/js/manager` and `@seatlayer/react/manager` export the organizer
cockpit — `SeatManager` and its types — and nothing else. They exist because the
package roots are buyer SDKs that *also* export the cockpit, so importing
`SeatManager` from the root drags `SeatPicker`, `SeatingChart`,
`EmbeddedDesigner` and the engine code only those reach (`PickerController`,
`generatePanorama`, `renderedQuality`) into a bundle that never renders any of
it. Measured on the dashboard's own Control Room route: **~220 KB of minified JS
that the surface cannot run.**

Bundlers cannot fix that from the outside. The published `dist/index.js` is one
file and its classes are not provably side-effect-free at the granularity a
tree-shaker needs, so the buyer half survives an import that names one symbol.
The split has to be made here, where the module graph is still real.

Two rules keep the saving from silently evaporating, and nothing fails loudly if
either is broken:

- `packages/react/src/{manager.ts,SeatManager.tsx}` import from
  `@seatlayer/js/manager`, **never** from `@seatlayer/js`. One bare-barrel
  import anywhere in that graph re-admits the whole buyer SDK.
- The roots keep exporting `SeatManager` unchanged. This is a cheaper door to
  the same class, not a move — every existing integration is untouched.

Each subpath needs an `exports` entry **and** a `typesVersions` entry (node10
resolution ignores `exports`, and `attw` in `pnpm lint:packages` fails the
release without it) — the same pair `@seatlayer/core` already carries for
`./view3d`.

This is an **npm-only** split. There is no CDN counterpart and none of the CDN
scripts change: the IIFE cannot code-split, so a browser consumer keeps getting
one bundle with everything in it.

### Channels mode is lazy (npm only)

`packages/js/src/channelsMode.ts` — ~95 KB minified, plus its stylesheet — is
reached through `import('./channelsMode')` in `SeatManager.ensureChannels()`, on
first entry into Channels mode. Most cockpit visits never open it. On npm this
chunk-splits automatically; on the CDN the dynamic import is inlined into the
IIFE, so this is **not** a fourth lazy CDN chunk and none of the five CDN
scripts or the Worker allowlist change.

Two invariants, both pinned by `packages/js/test/SeatManagerChannelsLazy.test.ts`:

- The `channelsMode` import in `SeatManager.ts` is **type-only**. A value import
  — including `CHANNELS_CSS`, which is why that stylesheet is now injected by
  the lazy load rather than concatenated into `MANAGER_CSS` — folds the sub-app
  back into first paint with nothing failing to say so.
- The Channels pill is gated on `channelCaps.view` (authority), never on
  `this.channels` (readiness). Gating on the instance would make a capability
  the member genuinely has look like one they do not, for as long as a fetch
  takes.

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

### The lazy chunks (`seatlayer-view3d.mjs`, `seatlayer-panorama.mjs`, `seatlayer-checkout.mjs`)

Three pieces of the widget cost real bytes and run only if a buyer asks for them,
so none may sit in the main bundle. On npm they chunk-split automatically. On
the CDN — where IIFE bundles can't code-split — each is built as a **separate
self-contained ESM asset** that lands beside the pinned files:

- `seatlayer-view3d.mjs` — the interactive 3D venue view
  (`@seatlayer/core/view3d`, an OGL scene; `cdn/vite.view3d.config.ts`, with
  `ogl` + `earcut` bundled in). Imported at 3D-open time; zero GL bytes before.
- `seatlayer-panorama.mjs` — `generateSeatPanorama`, which draws the 2048×1024
  view-from-seat texture (`cdn/vite.panorama.config.ts`). Imported when a buyer
  taps "View from here", or when a 3D cinematic asks for a seat view.
- `seatlayer-checkout.mjs` — the hosted-checkout card
  (`packages/js/src/hostedCheckout.ts`; `cdn/vite.checkout.config.ts`). Imported
  when a buyer presses the CTA in a picker mounted with `checkout: 'hosted'` —
  so there are zero payment bytes for every integration on the default
  `'handoff'` path, and zero for a hosted one until someone actually pays.

The widget resolves all three by URL relative to its own script
(`import.meta.url` in the ESM output; `document.currentScript` in the IIFE) —
see `cdnChunkUrl` in `SeatPicker.ts`.

The panorama is deliberately NOT folded into the 3D chunk even though 3D also
asks for panoramas: the 2D "View from here" button never enters 3D, so folding
would make that tap pull 74 KB gzipped of OGL scene code — unrunnable without
WebGL2 — to draw a 2D canvas.

`hostedCheckout.ts` imports **nothing at runtime** — not the engine, not the
SDK's own api client, not even a type from `SeatPicker` — and takes its two API
calls as functions instead. That is what keeps the asset a few KB rather than a
second copy of the renderer, since a standalone CDN asset shares no chunk with
the main bundle. `verify-cdn-build.mjs` therefore gates this one with a **byte
ceiling as well as a floor**: a stray engine import would otherwise produce a
release that looks perfectly healthy.

All three are pinned immutable objects like the main artifacts:
`finalize-cdn.mjs` records their SHA-256/size in `release.json`,
`verify-cdn-build.mjs` gates them (including a per-file byte floor),
`upload-cdn.mjs` ships them, `verify-cdn-deployment.mjs` checks them live, and
the CDN Worker's filename allowlist serves them. These are the ONLY intentional
lazy chunks; any other file in the release dir fails the build check. **Adding a
fourth means editing every one of those five places plus `build:cdn` in
`package.json`** — and, if the new module is one the main app vendors, its entry
in `scripts/sync-widget.mjs` too.

### Hashed assets (`assets/<name>-<hash>.js`)

The lazy chunks above are *enumerated*: we choose their names, so they can be
written down. Some files cannot be. `packages/core/src/view3d/prepareScene.ts`
starts the scene compiler with

```js
new Worker(new URL('./scene/scene.worker.ts', import.meta.url), { type: 'module' })
```

which Vite must emit as its own file — and it names that file with a content
hash. Inlining it instead would make it a **blob worker**, which a host site's
CSP `worker-src` can refuse; that was considered and rejected.

So the release artifact set is *the enumerated entry files **plus** a manifest of
hashed assets*. `release.json` gained an `assets` map (schema version **3**)
alongside `files`, with the same `{ sha256, bytes }` shape:

```json
"assets": {
  "assets/scene.worker-DM50HIYm.js": { "sha256": "02f2…", "bytes": 128685 }
}
```

The old contract asserted a flat set of six filenames and that *no other file may
appear*. The letter of that changed; the spirit did not — **nothing ships
unaccounted.** `verify-cdn-build.mjs` now walks the whole release directory and
requires every emitted file to be either an enumerated entry file or a
sha-matching member of `assets`, and requires `assets` to name nothing the build
did not emit. Anything outside `assets/<name>.js` — a nested directory, a
non-JS extension — fails the build.

Four rules make this safe rather than a loophole:

- **Hashed names go under the version prefix anyway.** The key is
  `seatlayer-js@<x.y.z>/assets/<name>-<hash>.js`. The hash alone would already
  stop two releases colliding; keeping the version prefix means an old release's
  assets are untouchable even if a hash ever repeated, and it matches how every
  other object in this bucket is laid out.
- **`upload-cdn.mjs` walks the manifest, not the directory.** It can only ship
  bytes `verify-cdn-build` already pinned. That walk is `uploadPlan()` in
  `scripts/release-metadata.mjs` — a pure function, unit-tested in
  `cdn/test/uploadPlan.test.ts`, because a tag is otherwise the first thing that
  ever exercises it. It writes `release.json` **last**, after the bytes it
  describes.
- **The Worker matches assets by pattern, not by allowlist.** It has no manifest
  on the hot path, so `cdn/src/worker.mjs` serves
  `seatlayer-js@<x.y.z>/assets/<name>` for a deliberately narrow name pattern
  (one flat directory, `.js`/`.mjs`, no traversal) and only under a *pinned*
  version — a hashed URL is never hand-written, so the mutable alias channel does
  not serve them. A pattern match for a key nobody uploaded is just a 404.
- **`cdn/vite.view3d.config.ts` sets `base: './'`.** With Vite's default `/`, the
  rewritten worker URL is root-absolute (`/assets/scene.worker-<hash>.js`), which
  on the CDN resolves to `cdn.seatlayer.io/assets/…` — outside the pinned
  directory, where nothing is published.

That last one matters more than it looks, because **the failure is silent**:
`prepareVenue3D` treats any worker failure as non-fatal and falls back to the
exact same pure compiler on the main thread. A 404'd worker costs frame budget
and reports nothing. Three gates therefore check reachability, not just presence
— `verify-cdn-build.mjs` asserts the 3D chunk references the asset relatively,
and both it and `verify-cdn-deployment.mjs` assert the asset is served as
JavaScript with `Access-Control-Allow-Origin` (a `type: 'module'` worker is a
CORS request; a classic worker could not be cross-origin at all).

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
https://cdn.seatlayer.io/seatlayer-js@0.24.0/assets/x-<hash>.js  hashed asset, pinned only
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
