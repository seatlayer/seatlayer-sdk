// @vitest-environment node
//
// Node, not the suite's default jsdom: jsdom's TextEncoder produces a Uint8Array
// from a different realm, and esbuild refuses to start when it sees that.
/**
 * The build-time CSS minifier (cdn/minifyCssLiterals.ts).
 *
 * This transform rewrites every byte of shipped stylesheet, and the failure mode
 * is silent: a corrupted selector or a swallowed `content:` string does not throw
 * anywhere, it just makes the widget subtly wrong in a browser nobody re-checks
 * after a bundle-size change. So the hazards are pinned here — the cases a
 * regex-based minifier gets wrong, and the real stylesheets themselves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSS_MARKER, minifyCssLiteralsInSource } from '../minifyCssLiterals';

const src = (body: string) => `const CSS = ${CSS_MARKER} \`${body}\`;\n`;

/** The marked literal bodies of a module, concatenated, exactly as written. */
function markedBodies(source: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const marker = source.indexOf(CSS_MARKER, cursor);
    if (marker === -1) return out;
    const open = source.indexOf('`', marker);
    const close = source.indexOf('`', open + 1);
    out += `${source.slice(open + 1, close)}\n`;
    cursor = close + 1;
  }
}

/**
 * Every class selector the stylesheet mentions — the cheapest strong invariant
 * on "did any rule get lost". Comments are dropped first because the source
 * prose names selectors too, and the minified side no longer has the prose.
 */
const selectors = (css: string) =>
  new Set(css.replace(/\/\*[\s\S]*?\*\//g, ' ').match(/\.[a-zA-Z][\w-]*/g) ?? []);

async function minifyBody(body: string): Promise<string> {
  const out = await minifyCssLiteralsInSource(src(body), 'test.ts');
  expect(out).not.toBeNull();
  return markedBodies(out!.code).trim();
}

describe('minifyCssLiteralsInSource', () => {
  it('leaves a module with no marker alone', async () => {
    expect(await minifyCssLiteralsInSource('const html = `<div>a</div>`;', 'x.ts')).toBeNull();
  });

  it('never touches an unmarked template literal in a marked module', async () => {
    const code = 'const html = `<b> {} ; , </b>`;\n' + src('.a{color:red}');
    const out = await minifyCssLiteralsInSource(code, 'x.ts');
    expect(out!.code).toContain('const html = `<b> {} ; , </b>`;');
  });

  it('strips comments and collapses the indentation', async () => {
    expect(await minifyBody(`
/* a note about the header */
.sl-head {
  display: flex;
  gap: 12px;
}
`)).toBe('.sl-head{display:flex;gap:12px}');
  });

  it('keeps a descendant combinator distinct from a pseudo-class', async () => {
    // `.a :hover` and `.a:hover` differ by exactly one space. Whitespace
    // collapsing that does not understand selectors merges them.
    expect(await minifyBody('.a :hover{color:red}')).toContain('.a :hover');
    expect(await minifyBody('.a:hover{color:red}')).toContain('.a:hover');
  });

  it('preserves punctuation and comment syntax inside a content string', async () => {
    const out = await minifyBody('.a::after{content:"a, b {} /* x */"}');
    expect(out).toContain('content:"a, b {} /* x */"');
  });

  it('preserves cubic-bezier values, custom properties and @media preludes', async () => {
    const out = await minifyBody(`
.slm {
  /* a custom property is an opaque token stream — it must survive verbatim */
  --slm-mo-out: cubic-bezier(.2, .8, .2, 1);
  transition: transform .2s cubic-bezier(.4, 0, .2, 1);
}
@media (prefers-reduced-motion: reduce) {
  .slm { transition: none }
}
`);
    expect(out).toContain('--slm-mo-out: cubic-bezier(.2, .8, .2, 1)');
    expect(out).toContain('transition:transform .2s cubic-bezier(.4,0,.2,1)');
    expect(out).toContain('prefers-reduced-motion:reduce');
  });

  it('preserves a url() data URI, commas and all', async () => {
    const uri = 'url("data:image/svg+xml;utf8,<svg width=\'2\' height=\'2\'/>")';
    expect(await minifyBody(`.a{background:${uri}}`)).toContain('data:image/svg+xml;utf8,<svg');
  });

  it('keeps a CSS escape sequence an escape, not a literal character', async () => {
    // In source this is written `\\2192`, which the JS engine cooks to `\2192`
    // — the CSS escape for →. Minifying the RAW text and re-embedding it would
    // either double the backslash or eat it.
    const out = await minifyBody('.a::after{content:"\\\\2192"}');
    expect(out).toBe('.a:after{content:"\\\\2192"}');
  });

  it('carries an interpolation through verbatim, in place', async () => {
    const code = `const CSS = ${CSS_MARKER} \`\n.a {\n  color: red;\n}\n\${OTHER_CSS}\`;\n`;
    const out = await minifyCssLiteralsInSource(code, 'x.ts');
    expect(out!.code).toBe('const CSS = ' + CSS_MARKER + ' `.a{color:red}${OTHER_CSS}`;\n');
  });

  it('fails loudly when the marker does not precede a template literal', async () => {
    await expect(minifyCssLiteralsInSource(`const x = ${CSS_MARKER} 1;`, 'x.ts')).rejects.toThrow(
      /must sit immediately before a template literal/,
    );
  });

  it('fails loudly when a marked literal is not CSS, instead of mangling it', async () => {
    // esbuild's CSS parser recovers rather than throwing — markup comes back as
    // `<div>a</div>{}`. The warning it raises is what turns that into a build stop.
    await expect(minifyBody('<div>a</div>')).rejects.toThrow(/did not understand/);
    await expect(minifyBody('.a{color:red')).rejects.toThrow(/did not understand/);
  });
});

describe('the real stylesheets', () => {
  const sources = [
    'packages/js/src/SeatPicker.ts',
    'packages/js/src/SeatManager.ts',
    'packages/js/src/channelsMode.ts',
    'packages/js/src/EmbeddedDesigner.ts',
  ];

  it.each(sources)('%s shrinks and keeps every selector', async (relative) => {
    const path = resolve(__dirname, '../..', relative);
    const before = readFileSync(path, 'utf8');
    const after = await minifyCssLiteralsInSource(before, relative);
    expect(after, `${relative} lost its ${CSS_MARKER} marker`).not.toBeNull();
    expect(after!.savedChars).toBeGreaterThan(0);
    expect(after!.code.length).toBeLessThan(before.length);
    expect(selectors(markedBodies(after!.code))).toEqual(selectors(markedBodies(before)));
  });

  it('takes the four stylesheets down by more than 10,000 characters together', async () => {
    // Measured 2026-08-03: 12,948 characters, ~6.0 KB gzipped off seatlayer.js.
    // The floor is here to catch the transform silently becoming a no-op.
    let total = 0;
    for (const relative of sources) {
      const path = resolve(__dirname, '../..', relative);
      const out = await minifyCssLiteralsInSource(readFileSync(path, 'utf8'), relative);
      total += out!.savedChars;
    }
    expect(total).toBeGreaterThan(10_000);
  });
});
