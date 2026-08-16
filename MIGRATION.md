# SDK repository and release boundary

This document defines where SeatLayer code lives after the privacy migration.
The short rule is: publish integration layers publicly; keep the renderer and
runtime implementation private.

## Ownership

| Area | Repository | Published form | License |
| --- | --- | --- | --- |
| Engine, designer, layout, picker internals, and 3D implementation | Private `seatlayer/seatlayer-runtime` plus private `paiteq/seatmap` source | Never published as source; compiled runtime/CDN bytes only | Proprietary from runtime `0.53.0` |
| `@seatlayer/core` and `@seatlayer/js` | Private `seatlayer/seatlayer-runtime` | npm `dist/` and CDN bundles without source maps | SeatLayer Runtime License from `0.53.0` |
| React, Vue, and Angular wrappers | Public `seatlayer/seatlayer-sdk` | Public TypeScript source and npm packages | MIT |
| Documentation, examples, and public issue intake | Public `seatlayer/seatlayer-sdk` and docs site | Public | MIT/docs terms |

The public repository is a fresh history. It must never receive `packages/core`,
`packages/js/src`, `cdn`, designer source, 3D source, or a source map generated
from private runtime code.

## Release order

1. In the private app, commit the engine and widget changes. The app remains the
   source of truth.
2. In a clean checkout, run the private runtime `release:prep` with
   `SEATMAP_REPO` pointing at that app commit. This checks the mirror and the
   vendored widget byte-for-byte and records both provenance SHAs.
3. Merge the private runtime change and tag `vX.Y.Z`. Its workflow builds the
   minified, map-free core/JS packages, verifies the CDN manifest and Worker
   routing, uploads the immutable CDN prefix, publishes npm core/JS, and only
   then promotes the mutable CDN alias.
4. Update the public wrapper dependencies to the exact released core/JS version.
   Run `pnpm verify`, merge the public PR, and tag the same version. The public
   workflow publishes React/Vue/Angular only after the runtime is live.
5. Verify npm versions, package manifests, unpacked file lists, CDN
   `/-/versions.json`, the pinned CDN URL, and the alias redirect.

## Artifact boundary

Private runtime packages may contain declarations because consumers need the
type contract. They must not contain:

- `.map` files or `sourcesContent`;
- original `.ts`/`.tsx` implementation files;
- private source paths in JavaScript metadata; or
- an npm `files` entry that includes anything outside compiled `dist/`.

Wrapper source maps are allowed because wrapper source is intentionally public.
The private runtime gate is `pnpm verify:public-artifacts`; the public source
gate is `pnpm boundary:check`.

## Existing consumers and migration

Existing `0.52.x` consumers continue to work at their existing npm and pinned
CDN URLs. No CDN URL is overwritten. Consumers should upgrade the runtime and
wrapper packages together to `0.53.0` or a later matching version.

The old public repository was renamed private and the new public repository has
no shared Git history. This prevents new GitHub browsing and forks from exposing
the old tree, but it cannot revoke copies already made under the old license.
Browser JavaScript is executable client code and can always be inspected; the
boundary prevents source disclosure and makes copying legally unauthorized for
new proprietary releases, not technically impossible to reverse-engineer.

## Operational security checklist

- Keep `seatlayer-runtime` private and disable private forks.
- Protect public `main` with the `verify` check and prevent force-pushes.
- Keep CDN prefixes immutable; promote aliases only through `versions.json`.
- Keep `NPM_TOKEN`, Cloudflare credentials, and any read-only deployment keys in
  repository secrets, never in source or logs.
- Configure npm trusted publishing for each public wrapper package to the exact
  GitHub workflow `.github/workflows/release.yml`. The account owner must
  complete npm's security-key/2FA confirmation when changing that setting.
- Treat package licenses as versioned contracts: do not claim that a prior MIT
  release became proprietary retroactively.

## Recovery

If a runtime release fails before npm, leave the immutable CDN prefix unused and
fix or rerun the same tag only after confirming byte identity. If npm succeeds
but alias promotion fails, keep the pinned URL as the recovery path and promote
the index after the CDN is verified. Never delete or overwrite a published
version to repair it.
