/**
 * Rendering constants that quality inspection must agree with.
 *
 * Keep these in core rather than inside the Konva renderer so headless catalog,
 * API, and MCP checks can evaluate the text that the buyer/designer will see.
 */

import type { AccessibilityType } from './types';

/** Seat and table-seat labels are authored at this many chart units. */
export const SEAT_LABEL_FONT_SIZE = 7;

/** Booth labels are authored at this many chart units. */
export const BOOTH_LABEL_FONT_SIZE = 10;

/** GA area captions and their capacity sublabels. */
export const GA_LABEL_FONT_SIZE = 15;
export const GA_CAPACITY_LABEL_FONT_SIZE = 11;

/**
 * GA category paint remains slightly translucent, but must still separate from
 * both supported canvas surfaces by the shared 3:1 graphical-object floor.
 */
export const GA_FILL_OPACITY = 0.85;

/**
 * Small labels below this rendered CSS-pixel size are hidden by LOD instead of
 * being painted as unreadable specks.
 */
export const MIN_VISIBLE_BOOKABLE_LABEL_PX = 12;

/** WCAG contrast for normal/small text. */
export const SMALL_TEXT_CONTRAST = 4.5;

/** WCAG contrast for genuinely large text. */
export const LARGE_TEXT_CONTRAST = 3;

/** Dark/light label candidates used only when a transient rendered state
 * changes the authored category fill (selected, held, unavailable, and so on). */
export const DARK_BOOKABLE_LABEL_INK = '#000000';
export const LIGHT_BOOKABLE_LABEL_INK = '#ffffff';

/** 18pt normal text and 14pt bold text expressed as CSS pixels. */
const LARGE_NORMAL_TEXT_PX = 24;
const LARGE_BOLD_TEXT_PX = 18.67;

export function minimumTextContrast(renderedFontPx: number, fontWeight = 400): number {
  const isLarge = renderedFontPx >= LARGE_NORMAL_TEXT_PX
    || (fontWeight >= 700 && renderedFontPx >= LARGE_BOLD_TEXT_PX);
  return isLarge ? LARGE_TEXT_CONTRAST : SMALL_TEXT_CONTRAST;
}

export function isBookableLabelLegibleAtScale(fontSize: number, effectiveScale: number): boolean {
  return fontSize * effectiveScale >= MIN_VISIBLE_BOOKABLE_LABEL_PX;
}

/** Square viewBox every accessibility glyph path's coordinates live in. */
export const ACCESS_GLYPH_VIEWBOX = 24;

/**
 * Per-accommodation pictograms drawn centred on accessible seats. Each is a
 * SOLID filled silhouette in the 0 0 24 24 viewBox, designed to stay legible at
 * the ~13px it renders on a seat dot (bold shapes, no thin strokes). A vector
 * path renders crisply at small sizes on every platform, unlike a colour emoji
 * whose canvas metrics/alignment are inconsistent cross-browser.
 *
 * The owner directive (OV-89): every accessibility type must render ITS OWN
 * meaningful glyph so a buyer *sees* what the seat provides — the coloured ring
 * still encodes the type by colour, but the on-seat icon now matches the
 * filter's meaning instead of every non-wheelchair type showing a bare ring.
 *
 * Every path below is numerically validated (bbox centred within 12±1.5, longer
 * axis spans 14–22 units) — see scratchpad/validate-glyphs.mjs in the authoring
 * session. Keep any edit passing that check.
 */
export const ACCESS_TYPE_GLYPH_PATHS: Record<AccessibilityType, string> = {
  // ISO-style wheelchair: seated figure (head + L-shaped body) over a ring wheel.
  wheelchair:
    'M7.8 4.5a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0z'
    + 'M8 7L10.5 7L10.5 15L8 15Z'
    + 'M8 12.5L18 12.5L18 15L8 15Z'
    + 'M16 15L18 15L18 18L16 18Z'
    + 'M5.5 16a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0z'
    + 'M8 16a3 3 0 1 1 6 0a3 3 0 1 1 -6 0z',
  // Companion: two overlapping head-and-shoulders figures (seat + a guest).
  companion:
    'M5.5 6.5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0z'
    + 'M4.5 18.5L6 11.5L11 11.5L12.5 18.5Z'
    + 'M12.5 7.5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0z'
    + 'M11.5 19L13 12.5L18 12.5L19.5 19Z',
  // Semi-ambulatory: walking figure leaning on a cane at its right side.
  'semi-ambulatory':
    'M8.3 3.8a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0z'
    + 'M9 6.2L12 6.6L11 13.5L8.6 13L9 6.2Z'
    + 'M8.6 13L11 13L9.5 21L7 21Z'
    + 'M10.4 13L12.6 13L13.6 21L11.2 21Z'
    + 'M11.2 7.2L14 8L14.6 9.6L11.9 8.9Z'
    + 'M14.4 6.8L15.9 6.8L16.4 21L14.8 21Z',
  // Hearing: a bold ear silhouette (assistive listening).
  hearing:
    'M15.5 3.5'
    + 'C9 2.2 5.5 6 5.5 11.5'
    + 'C5.5 16 8 19.5 10.5 21'
    + 'C13.2 22.6 16.4 20.8 15.4 18'
    + 'C14.8 16.4 12.9 16.1 13 14'
    + 'C13.1 11.9 15.8 11.4 15.8 8.5'
    + 'C15.8 5.4 13 4 15.5 3.5Z',
  // CART captions: a rounded caption bubble with two bold caption bars cut out.
  cart:
    'M5.5 6L18.5 6a2.5 2.5 0 0 1 2.5 2.5L21 15.5a2.5 2.5 0 0 1 -2.5 2.5L11 18L7 20.5L7.5 18L5.5 18a2.5 2.5 0 0 1 -2.5 -2.5L3 8.5a2.5 2.5 0 0 1 2.5 -2.5z'
    + 'M6.5 11L17.5 11L17.5 12.6L6.5 12.6z'
    + 'M6.5 14L17.5 14L17.5 15.6L6.5 15.6z',
  // Sign language: a raised open hand (palm with four fingers and a thumb).
  'sign-language':
    'M7 11L17 11L17 18a2 2 0 0 1 -2 2L9 20a2 2 0 0 1 -2 -2z'
    + 'M7.6 5L9.4 5L9.4 12L7.6 12z'
    + 'M9.9 3.5L11.7 3.5L11.7 12L9.9 12z'
    + 'M12.3 3.5L14.1 3.5L14.1 12L12.3 12z'
    + 'M14.6 5L16.4 5L16.4 12L14.6 12z'
    + 'M7.2 12.5L5 10.2L6.4 8.9L8.6 11.2Z',
  // Plus-size: a broad-shouldered wide figure.
  'plus-size':
    'M9.4 4.3a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0z'
    + 'M5 20L4 13C4 10.5 7 9.5 12 9.5C17 9.5 20 10.5 20 13L19 20Z',
  // Lift-up armrest: a chair side-profile with an up arrow over the armrest.
  'lift-armrest':
    'M5 6L8 6L8 19L5 19z'
    + 'M5 16L18 16L18 19L5 19z'
    + 'M8 12L17 12L17 14.5L8 14.5z'
    + 'M14 7L16 7L16 12L14 12z'
    + 'M12 7L18 7L15 3Z',
};

/**
 * Legacy default access pictogram — now the ISO-style wheelchair symbol. Kept as
 * an alias of {@link ACCESS_TYPE_GLYPH_PATHS.wheelchair} for back-compat with
 * callers that drew a single wheelchair glyph.
 */
export const ACCESS_GLYPH_PATH = ACCESS_TYPE_GLYPH_PATHS.wheelchair;

/**
 * The glyph to draw for a seat's PRIMARY accommodation. Wheelchair wins whenever
 * present (its physical provision is the headline fact); otherwise the first
 * listed accommodation is shown. Returns null for a seat with no accommodations,
 * so callers can skip drawing a glyph.
 */
export function accessGlyphPath(accessibility: AccessibilityType[]): string | null {
  if (!accessibility?.length) return null;
  const primary = accessibility.includes('wheelchair') ? 'wheelchair' : accessibility[0];
  return ACCESS_TYPE_GLYPH_PATHS[primary] ?? null;
}

/**
 * Keep the public seat label as the inventory identity while rendering only
 * its terminal seat number inside the physical marker. Generated row seats use
 * `<row label>-<number>`; a custom label without that suffix remains unchanged.
 */
export function bookableMarkerLabel(publicLabel: string): string {
  return /-(\d{1,5})$/.exec(publicLabel)?.[1] ?? publicLabel;
}

function luminance(value: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const channel = (offset: number) => {
    const encoded = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast for the actual opaque hex paints used by bookable labels. */
export function renderedTextContrast(ink: string, fill: string): number | null {
  const inkLuminance = luminance(ink);
  const fillLuminance = luminance(fill);
  if (inkLuminance == null || fillLuminance == null) return null;
  return (Math.max(inkLuminance, fillLuminance) + 0.05)
    / (Math.min(inkLuminance, fillLuminance) + 0.05);
}

function rgb(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const packed = Number.parseInt(match[1], 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

/**
 * Resolve the opaque pixel under text painted over a translucent category
 * shape. Quality evidence must compare against this composite—not the raw
 * category colour or the canvas alone.
 */
export function compositeHexOver(
  foreground: string,
  background: string,
  opacity: number,
): string {
  const front = rgb(foreground);
  const back = rgb(background);
  if (!front || !back) return background;
  const alpha = Math.max(0, Math.min(1, opacity));
  const channels = front.map((value, index) => Math.round(value * alpha + back[index] * (1 - alpha)));
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Bookable fills can vary per category and per transient state, while a chart
 * exposes only one preferred label token. Preserve that preference whenever it
 * passes, then deterministically choose the strongest normal-text candidate.
 */
export function stateAwareBookableLabelInk(fill: string, preferred: string): string {
  const preferredContrast = renderedTextContrast(preferred, fill);
  if (preferredContrast != null && preferredContrast >= SMALL_TEXT_CONTRAST) return preferred;
  const darkContrast = renderedTextContrast(DARK_BOOKABLE_LABEL_INK, fill) ?? 0;
  const lightContrast = renderedTextContrast(LIGHT_BOOKABLE_LABEL_INK, fill) ?? 0;
  if (darkContrast === 0 && lightContrast === 0) return preferred;
  return darkContrast >= lightContrast ? DARK_BOOKABLE_LABEL_INK : LIGHT_BOOKABLE_LABEL_INK;
}

const OPAQUE_HEX = /^#[0-9a-f]{6}$/i;

/** Is a solid hex fill light enough to read as a light surface? Feedback helpers
 * use this to pick the neutral section shell a label sits on. */
export function isLightFill(fill: string): boolean {
  const value = luminance(fill);
  return value != null && value > 0.5;
}

/**
 * Neutral section shell fills the renderer paints when a section has no custom
 * colour, mirrored here so contrast feedback can evaluate uncoloured sections.
 */
export const LIGHT_NEUTRAL_SECTION_FILL = '#e5e7eb';
export const DARK_NEUTRAL_SECTION_FILL = '#273142';
export function neutralSectionFill(canvasBackground: string): string {
  return isLightFill(canvasBackground) ? LIGHT_NEUTRAL_SECTION_FILL : DARK_NEUTRAL_SECTION_FILL;
}

export interface LabelInkContrastSummary {
  /** Backgrounds that could be evaluated (valid preferred + valid fill hex). */
  total: number;
  /** Backgrounds where the preferred ink is auto-swapped for legibility. */
  overridden: number;
  /** `applies` = preferred survives everywhere; `overridden` = swapped
   * everywhere; `mixed` = some of each; `none` = nothing evaluable. */
  status: 'applies' | 'overridden' | 'mixed' | 'none';
  /** Fallback ink chosen where the preferred was overridden (black/white), or
   * null when nothing was overridden — names the swap in user-facing copy. */
  overrideInk: string | null;
}

/**
 * Feedback-only companion to {@link stateAwareBookableLabelInk}: does a preferred
 * label ink survive across a set of backgrounds, or does the shared auto-contrast
 * rule silently swap it for black/white on some of them? Reuses the exact same
 * per-fill decision so a report can never disagree with what the renderer paints.
 */
export function summarizeLabelInkContrast(
  preferred: string,
  backgrounds: Iterable<string>,
): LabelInkContrastSummary {
  const preferredValid = OPAQUE_HEX.test(preferred.trim());
  const preferredHex = preferred.trim().toLowerCase();
  let total = 0;
  let overridden = 0;
  let overrideInk: string | null = null;
  for (const fill of backgrounds) {
    if (!preferredValid || !OPAQUE_HEX.test(fill.trim())) continue;
    total += 1;
    const ink = stateAwareBookableLabelInk(fill, preferred);
    if (ink.toLowerCase() !== preferredHex) {
      overridden += 1;
      overrideInk = ink;
    }
  }
  const status = total === 0 ? 'none'
    : overridden === 0 ? 'applies'
      : overridden === total ? 'overridden'
        : 'mixed';
  return { total, overridden, status, overrideInk };
}
