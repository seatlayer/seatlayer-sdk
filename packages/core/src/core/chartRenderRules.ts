/**
 * Rendering constants that quality inspection must agree with.
 *
 * Keep these in core rather than inside the Konva renderer so headless catalog,
 * API, and MCP checks can evaluate the text that the buyer/designer will see.
 */

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

/** Square viewBox the {@link ACCESS_GLYPH_PATH} coordinates live in. */
export const ACCESS_GLYPH_VIEWBOX = 24;
/**
 * Accessibility pictogram drawn centred on accessible seats — the widely
 * recognised "person" access symbol, as a single filled vector path. A vector
 * path renders crisply at small sizes on every platform, unlike the ♿ colour
 * emoji whose canvas metrics/alignment are inconsistent cross-browser. The
 * coloured ring around the seat still encodes the specific accommodation type,
 * so buyer and designer show the same marker (shared via this constant).
 */
export const ACCESS_GLYPH_PATH =
  'M12 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm9 7h-6v13h-2v-6h-2v6H9V9H3V7h18v2z';

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
