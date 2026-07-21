/**
 * English bundle — the reference dictionary every other locale is checked
 * against. Keys are added as pages route their strings through t();
 * buyer-surface keys land first.
 *
 * Conventions:
 *  - flat dot-namespaced keys: "<surface>.<element>" (picker.holdSeats)
 *  - {name} interpolation, {count} reserved for tCount plural keys
 *  - plural keys end in ".one" / ".other" (Intl.PluralRules categories)
 */

import type { Dict } from '../index';

export const en: Dict = {
  // shared
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.done': 'Done',
  'common.copied': '✓ Copied',

  // buyer picker
  'picker.holdExpired': 'Your hold expired — the seats were released. Pick again.',
  'picker.poweredBy': 'Powered by SeatLayer',
  'picker.testMode': 'TEST MODE',
  'picker.orphanHint': 'This leaves a single seat stranded — consider shifting one seat over.',

  // renderer (drawn on the Konva map — shared by the embed SDK)
  'map.aria': 'Seating map. Use arrow keys to move between seats, Enter to select.',
  'map.seatsLeft': '{count} LEFT',
  'map.fromPrice': 'FROM {price}',
  'map.statusHeld': 'On hold',
  'map.statusTaken': 'Taken',

  // buyer picker widget (src/picker/widget/SeatPicker.ts)
  'picker.floor': 'Floor',
  'picker.zoomLevel': 'Zoom level',
  'picker.rungTip.zones': 'Venue overview — groups of sections such as North Stand or VIP',
  'picker.rungTip.sections': 'Section blocks — category-mix fill + availability tint',
  'picker.rungTip.seats': 'Individual seats — blocks melt into dots',
  'picker.rungLabel.zones': 'ZONES',
  'picker.rungLabel.sections': 'SECTIONS',
  'picker.rungLabel.seats': 'SEATS',
  'picker.sectionSummaryAria': '{label} section summary',
  'picker.closeSectionSummary': 'Close section summary',
  'picker.seatsLeftInSection.one': '{count} seat left',
  'picker.seatsLeftInSection.other': '{count} seats left',
  'picker.overview': 'Overview',
  'picker.entrance': 'Entrance',
  'picker.tapSeatHint': 'Tap any seat to check its view',
  'picker.ticketTierFor': 'Ticket tier for {label}',
  'picker.viewFromSeat': 'View from seat {label}',
  'picker.real360': 'REAL 360°',
  'picker.preview': 'PREVIEW',
  'picker.sightline': '≈ {m} m to stage · clear sightline',
  'picker.panorama360': '360° venue photo',
  'picker.illustrationCaption': 'illustration · ≈ {m} m from stage',
  'picker.restrictedView': 'Restricted view',
  'picker.obstructedView': 'Obstructed view',
  'picker.premiumSeat': 'Premium seat',
  'picker.hideLimitedView': 'Hide limited-view seats',
  'picker.bestSeatsPremium': 'Best seats',
  'picker.premiumFallbackNote': 'No premium block of {count} — showing best overall',
};
