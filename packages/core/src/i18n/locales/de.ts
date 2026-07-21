/**
 * German bundle — native-quality translations of the English reference dictionary.
 * Keys are identical to en.ts; values are translated to German (de).
 *
 * Conventions:
 *  - flat dot-namespaced keys: "<surface>.<element>" (picker.holdSeats)
 *  - {name} interpolation, {count} reserved for tCount plural keys
 *  - plural keys end in ".one" / ".other" (Intl.PluralRules categories)
 */

import type { Dict } from '../index';

export const de: Dict = {
  // shared
  'common.cancel': 'Abbrechen',
  'common.close': 'Schließen',
  'common.done': 'Fertig',
  'common.copied': '✓ Kopiert',

  // buyer picker (extraction in progress — P4 of the port plan)
  'picker.holdExpired': 'Ihre Reservierung ist abgelaufen — die Plätze wurden freigegeben. Bitte erneut auswählen.',
  'picker.poweredBy': 'Bereitgestellt von SeatLayer',
  'picker.testMode': 'TESTMODUS',
  'picker.orphanHint': 'Dadurch bleibt ein einzelner Platz übrig — rücken Sie ggf. einen Platz weiter.',

  // renderer (drawn on the Konva map — shared by the embed SDK)
  'map.aria': 'Sitzplan. Mit Pfeiltasten zwischen Plätzen navigieren, Eingabe zum Auswählen.',
  'map.seatsLeft': '{count} FREI',
  'map.statusHeld': 'Reserviert',
  'map.statusTaken': 'Vergeben',
  'map.fromPrice': 'AB {price}',

  // buyer picker widget (src/picker/widget/SeatPicker.ts)
  'picker.floor': 'Etage',
  'picker.zoomLevel': 'Zoomstufe',
  'picker.rungTip.zones': 'Übersicht — Bereichsgruppen wie Nordtribüne oder VIP',
  'picker.rungTip.sections': 'Bereichs-Blöcke — Kategoriesortierung + Verfügbarkeitstönung',
  'picker.rungTip.seats': 'Einzelne Plätze — Blöcke lösen sich zu Punkten auf',
  'picker.rungLabel.zones': 'ZONEN',
  'picker.rungLabel.sections': 'BEREICHE',
  'picker.rungLabel.seats': 'PLÄTZE',
  'picker.sectionSummaryAria': 'Bereichszusammenfassung {label}',
  'picker.closeSectionSummary': 'Bereichszusammenfassung schließen',
  'picker.seatsLeftInSection.one': '{count} Platz verfügbar',
  'picker.seatsLeftInSection.other': '{count} Plätze verfügbar',
  'picker.overview': 'Übersicht',
  'picker.entrance': 'Eingang',
  'picker.tapSeatHint': 'Tippen Sie auf einen Platz, um die Ansicht zu prüfen',
  'picker.ticketTierFor': 'Ticketklasse für {label}',
  'picker.viewFromSeat': 'Ansicht von Platz {label}',
  'picker.real360': 'REAL 360°',
  'picker.preview': 'VORSCHAU',
  'picker.sightline': '≈ {m} m zur Bühne · freie Sicht',
  'picker.panorama360': '360°-Veranstaltungsfotos',
  'picker.illustrationCaption': 'Illustration · ≈ {m} m von der Bühne',
  'picker.restrictedView': 'Eingeschränkte Sicht',
  'picker.obstructedView': 'Sichtbehinderung',
  'picker.premiumSeat': 'Premium-Platz',
  'picker.hideLimitedView': 'Plätze mit eingeschränkter Sicht ausblenden',
  'picker.bestSeatsPremium': 'Beste Plätze',
  'picker.premiumFallbackNote': 'Kein Premium-Block mit {count} Plätzen — beste verfügbare werden angezeigt',
};
