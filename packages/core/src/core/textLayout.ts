import type { TextObject } from './types';

export const TEXT_WIDTH_MIN = 40;
export const TEXT_WIDTH_MAX = 1_200;
export const TEXT_LINE_HEIGHT_MIN = 0.8;
export const TEXT_LINE_HEIGHT_MAX = 3;
export const TEXT_LETTER_SPACING_MIN = -2;
export const TEXT_LETTER_SPACING_MAX = 20;
export const TEXT_OPACITY_MIN = 0.1;
export const TEXT_BACKGROUND_PADDING_MAX = 40;
export const TEXT_BACKGROUND_RADIUS_MAX = 40;

export interface TextLayoutMetrics {
  width: number;
  height: number;
  lineCount: number;
  padding: number;
}

const glyphAdvance = (text: TextObject): number => Math.max(1, text.fontSize * 0.6 + (text.letterSpacing ?? 0));

function wrappedLineCount(text: TextObject, usableWidth: number): number {
  const explicit = text.text.split(/\r?\n/);
  if (!text.width) return Math.max(1, explicit.length);
  const perLine = Math.max(1, Math.floor(usableWidth / glyphAdvance(text)));
  let lines = 0;
  for (const source of explicit) {
    if (!source.length) { lines += 1; continue; }
    let used = 0;
    for (const word of source.split(/\s+/)) {
      const length = word.length;
      if (!used) {
        lines += Math.max(1, Math.ceil(length / perLine));
        used = length % perLine;
      } else if (used + 1 + length <= perLine) used += 1 + length;
      else {
        lines += Math.max(1, Math.ceil(length / perLine));
        used = length % perLine;
      }
    }
  }
  return Math.max(1, lines);
}

/** Conservative renderer-independent box used by chart bounds, quality and
 * collision checks. Konva remains authoritative for exact glyph metrics. */
export function textLayoutMetrics(text: TextObject): TextLayoutMetrics {
  const padding = text.background?.padding ?? 0;
  const explicitLines = text.text.split(/\r?\n/);
  const naturalWidth = Math.max(1, ...explicitLines.map((line) => line.length)) * glyphAdvance(text);
  const width = text.width ?? naturalWidth + padding * 2;
  const usableWidth = Math.max(1, width - padding * 2);
  const lineCount = wrappedLineCount(text, usableWidth);
  return {
    width,
    height: lineCount * text.fontSize * (text.lineHeight ?? 1.2) + padding * 2,
    lineCount,
    padding,
  };
}
