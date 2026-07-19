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
  'picker.holdSeats': 'Hold seats & checkout',
  'picker.completeBooking': 'Complete booking',
  'picker.seatsHeld': 'Seats held — {time}',
  'picker.holdExpired': 'Your hold expired — the seats were released. Pick again.',
  'picker.seatTaken': 'Seat {label} was just taken by another buyer.',
  'picker.poweredBy': 'Powered by SeatLayer',
  'picker.testMode': 'TEST MODE',
  'picker.colorblind': 'Colorblind-friendly colors',
  'picker.orphanHint': 'This leaves a single seat stranded — consider shifting one seat over.',
  'picker.seats.one': '{count} seat',
  'picker.seats.other': '{count} seats',

  // renderer (drawn on the Konva map — shared by the embed SDK)
  'map.aria': 'Seating map. Use arrow keys to move between seats, Enter to select.',
  'map.seatsLeft': '{count} LEFT',
  'map.fromPrice': 'FROM {price}',
  'map.statusHeld': 'On hold',
  'map.statusTaken': 'Taken',

  // buyer picker page (src/pages/PickerPage.tsx)
  'picker.language': 'Language',
  'picker.zoomToFit': 'Zoom to fit',
  'picker.seatCountLabel': 'seats',
  'picker.capacity': 'capacity',
  'picker.viewMode': 'View mode',
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
  'picker.tapSeatHint': 'Tap any seat to check its view',
  'picker.chartSize': 'Chart size',
  'picker.custom': 'Custom',
  'picker.categories': 'Categories',
  'picker.accessibility': 'Accessibility',
  'picker.showAnyAccessible': 'Show any accessible seat',
  'picker.any': 'Any',
  'picker.yourSeats': 'Your seats',
  'picker.emptySeats': 'Tap seats on the map',
  'picker.emptySeatsWithGa': 'Tap seats on the map · tap a standing area for GA tickets',
  'picker.oneFewer': 'One fewer',
  'picker.oneMore': 'One more',
  'picker.remove': 'Remove {label}',
  'picker.ticketTierFor': 'Ticket tier for {label}',
  'picker.total': 'Total: {amount}',
  'picker.viewFromSeat': 'View from seat {label}',
  'picker.real360': 'REAL 360°',
  'picker.preview': 'PREVIEW',
  'picker.open360': 'Open 360° view',
  'picker.sightline': '≈ {m} m to stage · clear sightline',
  'picker.bookedDemo': 'Booked! (demo)',
  'picker.bookButton.one': 'Book {count} ticket — {amount}',
  'picker.bookButton.other': 'Book {count} tickets — {amount}',
  'picker.simulateCrowd': 'Simulate crowd: {state}',
  'picker.on': 'ON',
  'picker.off': 'OFF',
  'picker.panorama360': '360° venue photo',
  'picker.illustrationCaption': 'illustration · ≈ {m} m from stage',
};
