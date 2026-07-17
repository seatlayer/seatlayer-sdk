const RELEASE_PATH = /^sdk\/(v\d+\.\d+\.\d+|v1)\/(?:seatlayer\.(?:js|mjs)|seatmap\.(?:js|mjs)|release\.json)$/;

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

function responseHeaders(key, object) {
  const headers = new Headers(corsHeaders());
  object.writeHttpMetadata?.(headers);
  headers.set('Content-Type', contentType(key, object));
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', key.startsWith('sdk/v1/')
    ? 'public, max-age=300, must-revalidate'
    : 'public, max-age=31536000, immutable');
  return headers;
}

function safeKey(url) {
  let key;
  try {
    key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!key || key.includes('..') || !RELEASE_PATH.test(key)) return null;
  return key;
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
    const key = safeKey(url);
    if (!key) return new Response('Not found', { status: 404, headers: corsHeaders() });

    const bypassCache = url.searchParams.has('__seatlayer_verify');
    const cacheKey = new Request(`${url.origin}/${key}`, { method: 'GET' });
    if (!bypassCache && request.method === 'GET') {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        if (request.headers.get('If-None-Match') === cached.headers.get('ETag')) {
          return new Response(null, { status: 304, headers: cached.headers });
        }
        return cached;
      }
    }

    const object = request.method === 'HEAD'
      ? await env.SDK_RELEASES.head(key)
      : await env.SDK_RELEASES.get(key);
    if (!object) return new Response('Not found', { status: 404, headers: corsHeaders() });

    const headers = responseHeaders(key, object);
    if (request.headers.get('If-None-Match') === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }
    if (request.method === 'HEAD') {
      headers.set('Content-Length', String(object.size));
      return new Response(null, { status: 200, headers });
    }

    const response = new Response(object.body, { status: 200, headers });
    if (!bypassCache) ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  },
};
