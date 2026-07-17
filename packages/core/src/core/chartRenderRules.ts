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
 * Transient status/selection fills are renderer-owned, so their label ink must
 * be renderer-owned too. Authored free/category fills keep their validated ink;
 * changed state fills choose the strongest normal-text candidate.
 */
export function stateAwareBookableLabelInk(fill: string, preferred: string): string {
  const preferredContrast = renderedTextContrast(preferred, fill);
  if (preferredContrast != null && preferredContrast >= SMALL_TEXT_CONTRAST) return preferred;
  const darkContrast = renderedTextContrast(DARK_BOOKABLE_LABEL_INK, fill) ?? 0;
  const lightContrast = renderedTextContrast(LIGHT_BOOKABLE_LABEL_INK, fill) ?? 0;
  if (darkContrast === 0 && lightContrast === 0) return preferred;
  return darkContrast >= lightContrast ? DARK_BOOKABLE_LABEL_INK : LIGHT_BOOKABLE_LABEL_INK;
}
