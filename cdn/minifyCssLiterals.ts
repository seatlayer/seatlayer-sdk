/**
 * Minify the widget's inline CSS at BUILD time.
 *
 * The SDK ships its stylesheets as template literals inside the TypeScript
 * sources (`SeatPicker`'s `CSS`, `SeatManager`'s `MANAGER_CSS`, `channelsMode`'s
 * `CHANNELS_CSS`) so a host page gets one `<style>` tag per document with no CSS
 * loader, no extra request and no build step of its own. That is the right
 * shipping shape — but esbuild minifies the JavaScript AROUND those literals and
 * never looks inside a string, so every comment and every run of source
 * indentation went out over the wire. SeatPicker's literal alone is 58,905
 * characters of pretty-printed CSS, ~4.9 KB gzipped of pure whitespace and prose.
 *
 * So: keep the source readable and comment it freely, and strip it here. The
 * minifier is esbuild's own CSS parser rather than a hand-rolled regex pass,
 * because the hazards (`content:"a, b {}"`, `.a :hover` descendant combinators,
 * `cubic-bezier(.4, 0, .2, 1)`, `--custom-props`, `@media` prelude spacing,
 * `url()` data URIs) are exactly the cases a regex gets wrong.
 *
 * OPT-IN BY MARKER. A literal is minified only when it is prefixed with the
 * `@sl-css` marker comment:
 *
 *     const CSS = [marker] `
 *       .sl-picker { ... }
 *     `;
 *
 * These files are also full of HTML template literals, and feeding markup to a
 * CSS parser would silently corrupt it. Marking the CSS explicitly means the
 * transform can never wander into the wrong literal, and a marked literal that
 * esbuild cannot parse fails the build loudly instead of quietly shipping
 * unminified — a silent skip is how this kind of win rots.
 *
 * Applied to the CDN bundles only (`cdn/vite.config.ts`). The npm packages build
 * with sourcemaps on, and collapsing a 1,300-line literal onto one line would
 * shift every mapping after it; consumers' own minifiers can't reach inside the
 * string either, but a correct sourcemap is worth more there than 5 KB.
 */
import { transform } from 'esbuild';
import type { Plugin } from 'vite';

/** The opt-in marker a template literal must carry to be treated as CSS. */
export const CSS_MARKER = '/* @sl-css */';

interface Segment {
  /** Raw template text (still JS-escaped) between two `${…}` holes. */
  text: string;
  /** The `${…}` hole that followed it, verbatim, or '' at the end of the literal. */
  hole: string;
}

/**
 * Scan a template literal starting at its opening backtick, splitting it into
 * raw text segments and the `${…}` holes between them. Returns the index just
 * past the closing backtick. Escapes are honoured, so an escaped backtick never
 * ends the literal.
 */
function readLiteral(code: string, open: number): { segments: Segment[]; end: number } {
  const segments: Segment[] = [];
  let text = '';
  let i = open + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      text += code.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      segments.push({ text, hole: '' });
      return { segments, end: i + 1 };
    }
    if (ch === '$' && code[i + 1] === '{') {
      // Brace-depth scan. Our CSS literals interpolate bare identifiers; a hole
      // containing a nested string or template would need a real parser, so we
      // refuse it rather than guess.
      let depth = 0;
      let j = i + 1;
      for (; j < code.length; j += 1) {
        const c = code[j];
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) break;
        } else if (c === '`' || c === '"' || c === "'") {
          throw new Error(`quotes inside a ${CSS_MARKER} interpolation are not supported`);
        }
      }
      if (depth !== 0) throw new Error(`unterminated interpolation in a ${CSS_MARKER} literal`);
      segments.push({ text, hole: code.slice(i, j + 1) });
      text = '';
      i = j + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  throw new Error(`unterminated ${CSS_MARKER} template literal`);
}

/**
 * Raw template text → the string the JS engine would actually produce. CSS uses
 * backslashes for real (`content:"\\2192"` in source is the escape `\2192` in the
 * stylesheet), so minifying the raw text and re-embedding it would double or eat
 * those escapes. Evaluating the segment with the engine's own template rules is
 * exact. The input is a text segment we just scanned: holes have been split out
 * and every backtick in it is escaped, so there is nothing here to execute.
 */
function cook(raw: string): string {
  // eslint-disable-next-line no-new-func
  return new Function(`return \`${raw}\``)() as string;
}

/** Cooked CSS → text that reads back identically inside a template literal. */
function embed(css: string): string {
  return css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Minify every `@sl-css`-marked template literal in one module's source.
 * Returns null when the module has no marked literal, so callers can skip it.
 */
export async function minifyCssLiteralsInSource(
  code: string,
  id: string,
): Promise<{ code: string; savedChars: number } | null> {
  if (!code.includes(CSS_MARKER)) return null;

  let out = '';
  let cursor = 0;
  let savedChars = 0;

  for (;;) {
    const marker = code.indexOf(CSS_MARKER, cursor);
    if (marker === -1) break;
    let open = marker + CSS_MARKER.length;
    while (open < code.length && /\s/.test(code[open])) open += 1;
    if (code[open] !== '`') {
      throw new Error(`${id}: ${CSS_MARKER} must sit immediately before a template literal`);
    }

    const { segments, end } = readLiteral(code, open);
    let rebuilt = '`';
    for (const segment of segments) {
      const css = cook(segment.text);
      if (css.trim()) {
        // esbuild is given no `target`, which keeps its output modern (no
        // shorthand expansion) and value-preserving.
        const result = await transform(css, { loader: 'css', minify: true, logLevel: 'silent' });
        // esbuild's CSS parser RECOVERS rather than throwing — hand it markup and
        // it happily emits `<div>a</div>{}`. The warnings are the only signal that
        // it did not understand what it was given, so on a literal that claims to
        // be CSS they are an error. The stylesheets parse clean today.
        if (result.warnings.length > 0) {
          const detail = result.warnings.map((w) => `${w.text} (line ${w.location?.line ?? '?'})`).join('; ');
          throw new Error(`${id}: esbuild did not understand this ${CSS_MARKER} literal as CSS — ${detail}`);
        }
        rebuilt += embed(result.code.trim());
      }
      rebuilt += segment.hole;
    }
    rebuilt += '`';

    savedChars += (end - open) - rebuilt.length;
    // The marker stays in the emitted source. It costs nothing (esbuild drops
    // comments) and it keeps the transform visible in an intermediate dump.
    out += code.slice(cursor, open) + rebuilt;
    cursor = end;
  }

  out += code.slice(cursor);
  return { code: out, savedChars };
}

/**
 * Vite plugin wrapper. Runs `pre` so it sees the original TypeScript, before
 * esbuild rewrites the module around the literal.
 */
export function minifyCssLiterals(): Plugin {
  let total = 0;
  return {
    name: 'seatlayer:minify-css-literals',
    enforce: 'pre',
    // One plugin instance serves both lib formats (iife + es); without this the
    // reported figure is the same saving counted twice.
    buildStart() {
      total = 0;
    },
    async transform(code, id) {
      if (!id.endsWith('.ts')) return null;
      const result = await minifyCssLiteralsInSource(code, id);
      if (!result) return null;
      total += result.savedChars;
      return { code: result.code, map: null };
    },
    buildEnd() {
      if (total > 0) console.log(`  inline CSS minified: ${total.toLocaleString()} source characters removed`);
    },
  };
}
