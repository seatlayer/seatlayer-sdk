/**
 * cdn.seatlayer.io — the SeatLayer browser-artifact CDN.
 *
 * Canonical namespace (the only shape we EMIT):
 *
 *   /seatlayer-js@0.25.0/seatlayer.js     immutable, pinned; filename is CONSTANT
 *   /seatlayer-js@0.25.0/seatlayer.mjs    across versions, so upgrading is a
 *   /seatlayer-js@0.25.0/release.json     one-token edit.
 *   /seatlayer-js@0/seatlayer.js          mutable major alias -> 302 to the pinned URL
 *   /-/versions.json                      version index (jsDelivr/cdnjs-shaped)
 *
 * The major alias is a REDIRECT, never a byte copy. A copied alias is a second
 * artifact that can silently diverge from the pinned one, and because the copy
 * and the pinned object cache independently they can be served at different ages
 * — a torn deploy. A 302 has exactly one source of truth by construction.
 *
 * `-` is the version-index prefix because it is an illegal npm package name, so
 * it can never collide with a real `seatlayer-<pkg>@<version>` path.
 *
 * LEGACY (still served, never emitted again): the previous `/sdk/vX.Y.Z/` and
 * `/sdk/v1/` shapes. Pinned objects are permanent by policy — old integrations
 * must keep resolving forever. New releases stop writing these paths.
 */

const FILE_NAMES = new Set(['seatlayer.js', 'seatlayer.mjs', 'release.json']);

/** Canonical pinned artifact: /seatlayer-js@1.2.3/seatlayer.js */
const PINNED_PATH = /^seatlayer-js@(\d+\.\d+\.\d+)\/([^/]+)$/;
/** Mutable alias: /seatlayer-js@1/seatlayer.js or /seatlayer-js@latest/seatlayer.js */
const ALIAS_PATH = /^seatlayer-js@(\d+|latest)\/([^/]+)$/;
/** Version index: /-/versions.json */
const VERSIONS_PATH = '-/versions.json';
/** Legacy shapes retained for already-published integrations. */
const LEGACY_PATH = /^sdk\/(v\d+\.\d+\.\d+|v1)\/(?:seatlayer\.(?:js|mjs)|seatmap\.(?:js|mjs)|release\.json)$/;

// Braintree-style hybrid: immortal at the edge so origin reads are ~zero, but a
// short browser TTL so a bad build can be purged and actually disappear.
const CACHE_PINNED = 'public, s-maxage=31536000, max-age=3600, immutable';
const CACHE_ALIAS = 'public, max-age=600, s-maxage=60';
const CACHE_INDEX = 'public, max-age=60';
const CACHE_LEGACY_PINNED = 'public, max-age=31536000, immutable';
const CACHE_LEGACY_ALIAS = 'public, max-age=300, must-revalidate';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

function contentType(key, object) {
  if (object?.httpMetadata?.contentType) return object.httpMetadata.contentType;
  if (key.endsWith('.mjs') || key.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function notFound(message = 'Not found') {
  return new Response(message, { status: 404, headers: corsHeaders() });
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Resolve a request path to what should be served.
 * Returns null for anything we do not knowingly publish.
 */
function route(url) {
  let path;
  try {
    path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!path || path.includes('..')) return null;

  if (path === VERSIONS_PATH) {
    return { kind: 'object', key: VERSIONS_PATH, cacheControl: CACHE_INDEX };
  }

  const pinned = PINNED_PATH.exec(path);
  if (pinned) {
    const [, version, name] = pinned;
    if (!FILE_NAMES.has(name)) return null;
    return {
      kind: 'object',
      key: `seatlayer-js@${version}/${name}`,
      // Everything published before the namespace reshape lives under the old
      // key. Serving it here means every historical version is reachable at the
      // canonical URL with no object backfill and no second copy in R2.
      //
      // This is intentionally ungated, so the retired internal 0.2.x renderer
      // objects also answer at a canonical-looking URL. That is harmless: the
      // ledger (-/versions.json) is the discovery surface and excludes them, and
      // no alias can resolve to them. Gating would cost an R2 read on the hot
      // path for every pinned request.
      fallbackKey: `sdk/v${version}/${name}`,
      cacheControl: CACHE_PINNED,
    };
  }

  const alias = ALIAS_PATH.exec(path);
  if (alias) {
    const [, channel, name] = alias;
    if (!FILE_NAMES.has(name)) return null;
    return { kind: 'alias', channel, name, cacheControl: CACHE_ALIAS };
  }

  if (LEGACY_PATH.test(path)) {
    return {
      kind: 'object',
      key: path,
      cacheControl: path.startsWith('sdk/v1/') ? CACHE_LEGACY_ALIAS : CACHE_LEGACY_PINNED,
    };
  }

  return null;
}

async function readVersionIndex(env) {
  const object = await env.SDK_RELEASES.get(VERSIONS_PATH);
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
}

/** `0` -> newest published 0.x; `latest` -> the tagged release. */
function resolveChannel(index, channel) {
  if (!index) return null;
  const versions = Array.isArray(index.versions)
    ? index.versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    : [];
  if (channel === 'latest') {
    const tagged = index.tags?.latest;
    if (typeof tagged === 'string' && versions.includes(tagged)) return tagged;
    return versions.slice().sort(compareVersions).pop() ?? null;
  }
  const major = Number(channel);
  return versions
    .filter((version) => Number(version.split('.')[0]) === major)
    .sort(compareVersions)
    .pop() ?? null;
}

function objectHeaders(key, object, cacheControl) {
  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata?.(headers);
  headers.set('Content-Type', contentType(key, object));
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', cacheControl);
  return headers;
}

async function serveObject(request, env, ctx, target, bypassCache) {
  const read = async (key) => (request.method === 'HEAD'
    ? env.SDK_RELEASES.head(key)
    : env.SDK_RELEASES.get(key));
  const object = (await read(target.key))
    ?? (target.fallbackKey ? await read(target.fallbackKey) : null);
  if (!object) return notFound();

  const headers = objectHeaders(target.key, object, target.cacheControl);
  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const response = new Response(object.body, { status: 200, headers });
  if (!bypassCache) {
    const cacheKey = new Request(`${new URL(request.url).origin}/${target.key}`, { method: 'GET' });
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  }
  return response;
}

async function serveAlias(env, url, target) {
  const version = resolveChannel(await readVersionIndex(env), target.channel);
  if (!version) {
    return new Response(`No published version for channel "${target.channel}"`, {
      status: 404,
      headers: { ...corsHeaders(), 'Cache-Control': 'public, max-age=30' },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(),
      Location: `${url.origin}/seatlayer-js@${version}/${target.name}`,
      'Cache-Control': target.cacheControl,
      // Lets a caller see which concrete build an alias resolved to without
      // having to follow the redirect.
      'X-SeatLayer-Version': version,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { ...corsHeaders(), Allow: 'GET, HEAD, OPTIONS' },
      });
    }

    const url = new URL(request.url);
    const target = route(url);
    if (!target) return notFound();

    const bypassCache = url.searchParams.has('__seatlayer_verify');

    // Aliases resolve per request and are cached only briefly at the edge, so a
    // promotion goes live fast with no object copying anywhere.
    if (target.kind === 'alias') return serveAlias(env, url, target);

    const cacheKey = new Request(`${url.origin}/${target.key}`, { method: 'GET' });
    if (!bypassCache && request.method === 'GET') {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        if (request.headers.get('If-None-Match') === cached.headers.get('ETag')) {
          return new Response(null, { status: 304, headers: cached.headers });
        }
        return cached;
      }
    }

    return serveObject(request, env, ctx, target, bypassCache);
  },
};
