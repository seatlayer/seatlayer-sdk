// Venue wayfinding icon registry.
//
// Icons are authored as single-color vector paths in a 24×24 viewBox, drawn in a
// consistent stroke style (Lucide/Material-Symbols aesthetic — 2-unit stroke,
// round caps/joins, no fill). Both the Designer canvas and the buyer
// SeatmapRenderer draw the SAME path so a placed marker looks identical
// everywhere, unlike the emoji glyphs it replaces (which rendered per-OS).
//
// Identity + backward compatibility: a placed icon is a TextObject with
// `semanticKind:'icon'`. NEW placements also carry `iconKey` referencing an entry
// here and render as a vector Path. LEGACY placements carry only an emoji in
// `text` (no iconKey) and keep rendering through the shared text/glyph path. The
// two coexist forever; nothing rewrites old charts.

/** Logical grouping for the Designer palette (plain-language section headers). */
export type VenueIconGroup = 'facilities' | 'food-drink' | 'navigation' | 'accessibility';

export interface VenueIcon {
  /** Stable registry key persisted on the object as `iconKey`. Never shown to users. */
  key: string;
  /** Plain-language name (button label, tooltip, accessible name). */
  label: string;
  group: VenueIconGroup;
  /** SVG path `d` in a 0 0 24 24 viewBox, stroke-styled (fill:none). */
  path: string;
}

/** The viewBox side length every icon path is authored against. */
export const VENUE_ICON_VIEWBOX = 24;
/** Stroke width in viewBox units; scales with the object's size like a font. */
export const VENUE_ICON_STROKE = 2;

/** Human-readable section headers for the palette groups. */
export const VENUE_ICON_GROUP_LABELS: Record<VenueIconGroup, string> = {
  facilities: 'Facilities',
  'food-drink': 'Food & drink',
  navigation: 'Getting around',
  accessibility: 'Accessibility',
};

/** Display order of the groups in the palette. */
export const VENUE_ICON_GROUP_ORDER: VenueIconGroup[] = [
  'facilities',
  'food-drink',
  'navigation',
  'accessibility',
];

// Shared sub-marks reused across a couple of icons.
const WHEELCHAIR =
  'M13 4.6a1.6 1.6 0 1 0-3.2 0 1.6 1.6 0 0 0 3.2 0 M11 6.5V13h5l2.4 6 M15 16.4A5 5 0 1 1 9 11.3';

export const VENUE_ICONS: VenueIcon[] = [
  // ---- Facilities --------------------------------------------------------
  {
    key: 'restroom-men',
    label: "Men's restroom",
    group: 'facilities',
    path: 'M16 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0 M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2',
  },
  {
    key: 'restroom-women',
    label: "Women's restroom",
    group: 'facilities',
    path: 'M15 5a3 3 0 1 0-6 0 3 3 0 0 0 6 0 M12 8l-4 10h8l-4-10 M10 18v4 M14 18v4',
  },
  {
    key: 'restroom-accessible',
    label: 'Accessible restroom',
    group: 'facilities',
    path: WHEELCHAIR,
  },
  {
    key: 'first-aid',
    label: 'First aid',
    group: 'facilities',
    path: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M12 8v8 M8 12h8',
  },
  {
    key: 'coat-check',
    label: 'Coat check',
    group: 'facilities',
    path: 'M12 6a2 2 0 0 1 0-4 2 2 0 0 1 1.6 3.2L21 13H3l8.4-7.8 M3 13h18',
  },
  {
    key: 'atm',
    label: 'ATM / cash',
    group: 'facilities',
    path: 'M2 6h20v12H2V6Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M6 9h.01 M18 15h.01',
  },
  {
    key: 'info',
    label: 'Info point',
    group: 'facilities',
    path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v5 M12 8h.01',
  },
  {
    key: 'lost-found',
    label: 'Lost & found',
    group: 'facilities',
    path: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M16 16l5 5 M9 8.5a2 2 0 1 1 3 1.7c-.8.5-1 .8-1 1.8 M11 15h.01',
  },
  {
    key: 'restrooms',
    label: 'Restrooms',
    group: 'facilities',
    path: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M9 18v-3.5a3 3 0 0 1 6 0V18',
  },
  {
    key: 'charging',
    label: 'Charging point',
    group: 'facilities',
    path: 'M3 8h13v8H3V8Z M16 10h3v4h-3 M9.6 9l-2 3.5h2.5l-1.5 3',
  },
  {
    key: 'smoking',
    label: 'Smoking area',
    group: 'facilities',
    path: 'M2 15h13v3H2v-3Z M18 16h2 M19 8c0 1 1 1.5 1 2.5S19 12 19 13',
  },
  {
    key: 'no-smoking',
    label: 'No smoking',
    group: 'facilities',
    path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M5.6 5.6l12.8 12.8 M7 13h6v2H7v-2Z',
  },
  // ---- Food & drink ------------------------------------------------------
  {
    key: 'food',
    label: 'Food',
    group: 'food-drink',
    path: 'M7 3v6a2 2 0 0 0 4 0V3 M9 11v10 M17 3c-1.6 1-2.2 3-2.2 6 0 2 .9 3.2 2.2 3.6V21',
  },
  {
    key: 'bar',
    label: 'Bar',
    group: 'food-drink',
    path: 'M4 5h16l-8 8-8-8Z M12 13v6 M8 20h8',
  },
  {
    key: 'coffee',
    label: 'Café / coffee',
    group: 'food-drink',
    path: 'M4 8h13v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z M17 9h2a2 2 0 0 1 0 4h-2 M8 2v2 M11 2v2 M4 21h14',
  },
  {
    key: 'water',
    label: 'Water / drinks',
    group: 'food-drink',
    path: 'M12 22a7 7 0 0 1-7-7c0-5 7-12 7-12s7 7 7 12a7 7 0 0 1-7 7Z',
  },
  {
    key: 'merch',
    label: 'Merch / shop',
    group: 'food-drink',
    path: 'M6 8h12l-1 12H7L6 8Z M9 8V6a3 3 0 0 1 6 0v2',
  },
  {
    key: 'screen',
    label: 'Screen',
    group: 'facilities',
    path: 'M3 4h18v12H3V4Z M9 20h6 M12 16v4 M10 8l4 2-4 2V8Z',
  },
  {
    key: 'sound-booth',
    label: 'Sound booth',
    group: 'facilities',
    path: 'M6 4v16 M6 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M12 4v16 M12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M18 4v16 M18 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  },
  // ---- Getting around ----------------------------------------------------
  {
    key: 'entrance',
    label: 'Entrance',
    group: 'navigation',
    path: 'M14 3h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5 M3 12h11 M10 8l4 4-4 4',
  },
  {
    key: 'exit',
    label: 'Exit',
    group: 'navigation',
    path: 'M10 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h5 M14 12h7 M17 8l4 4-4 4',
  },
  {
    key: 'emergency-exit',
    label: 'Emergency exit',
    group: 'navigation',
    path: 'M14 4.6a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0 M12.5 8l-3.5 2 1.6 3.6-2 4.4 M12.5 10l3.5 1.5 M9 10.5l-3.5 1 M15 12h6 M18 9l3 3-3 3',
  },
  {
    key: 'stairs',
    label: 'Stairs',
    group: 'navigation',
    path: 'M3 20v-4h4v-4h4v-4h4V4h5',
  },
  {
    key: 'elevator',
    label: 'Elevator',
    group: 'navigation',
    path: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M8 11l1.5-2 1.5 2 M8 14l1.5 2 1.5-2 M15 8v8',
  },
  {
    key: 'parking',
    label: 'Parking',
    group: 'navigation',
    path: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M9 17V7h4a3 3 0 0 1 0 6H9',
  },
  // ---- Accessibility -----------------------------------------------------
  {
    key: 'wheelchair',
    label: 'Wheelchair access',
    group: 'accessibility',
    path: WHEELCHAIR,
  },
  {
    key: 'hearing',
    label: 'Hearing assistance',
    group: 'accessibility',
    path: 'M8 20a4 4 0 0 1-2-3c0-1 .5-2 .5-3a4.5 4.5 0 1 1 9 0c0 1.4-1 2-2 2.4-1.2.5-1.5 1-1.5 2.2 M17 6a5 5 0 0 1 1 6 M19.5 4a8 8 0 0 1 1.2 9',
  },
];

/**
 * Décor-stamp-only glyphs. Some Designer décor presets (e.g. a structural wall)
 * are not buyer-placeable wayfinding markers, so they must NOT appear in the
 * IconPalette / VENUE_ICONS registry — but their flyout stamp button still needs
 * a vector preview in the same stroke language so the Décor row reads as one
 * system (OV-82). Authored against the same 0 0 24 24 viewBox / 2-unit stroke.
 */
export const DECOR_STAMP_ICON_PATHS: Record<string, string> = {
  // Running-bond brick courses — a plain structural divider.
  wall: 'M3 5h18v14H3V5Z M3 9.7h18 M3 14.3h18 M9 5v4.7 M15 5v4.7 M6 9.7v4.6 M12 9.7v4.6 M18 9.7v4.6 M9 14.3v4.7 M15 14.3v4.7',
};

const BY_KEY = new Map<string, VenueIcon>(VENUE_ICONS.map((icon) => [icon.key, icon]));

/** Resolve a registry entry by key, or undefined for legacy/unknown keys. */
export function venueIcon(key: string | undefined | null): VenueIcon | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

/** Vector path for a key, or undefined when the key is not in the registry. */
export function venueIconPath(key: string | undefined | null): string | undefined {
  return venueIcon(key)?.path;
}

/** True when `key` names a real registry icon (MCP/validation fail-closed guard). */
export function isVenueIconKey(key: unknown): key is string {
  return typeof key === 'string' && BY_KEY.has(key);
}

/** Every valid registry key (for MCP enum + validation messages). */
export const VENUE_ICON_KEYS: string[] = VENUE_ICONS.map((icon) => icon.key);
