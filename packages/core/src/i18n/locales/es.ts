/**
 * Spanish (es) bundle — neutral/international Spanish translation.
 * Follows the same key structure as en.ts; all placeholders and brand
 * names preserved.
 */

import type { Dict } from '../index';

export const es: Dict = {
  // shared
  'common.cancel': 'Cancelar',
  'common.close': 'Cerrar',
  'common.done': 'Listo',
  'common.copied': '✓ Copiado',

  // buyer picker (extraction in progress — P4 of the port plan)
  'picker.holdExpired': 'Tu retención expiró — los asientos fueron liberados. Elige de nuevo.',
  'picker.poweredBy': 'Con la tecnología de SeatLayer',
  'picker.testMode': 'MODO DE PRUEBA',
  'picker.orphanHint': 'Esto deja un asiento aislado — considera desplazarte un asiento.',

  // renderer (drawn on the Konva map — shared by the embed SDK)
  'map.aria': 'Mapa de asientos. Usa las flechas para moverte entre asientos, Intro para seleccionar.',
  'map.seatsLeft': '{count} LIBRES',
  'map.statusHeld': 'En espera',
  'map.statusTaken': 'Ocupado',
  'map.fromPrice': 'DESDE {price}',

  // buyer picker widget (src/picker/widget/SeatPicker.ts)
  'picker.floor': 'Piso',
  'picker.zoomLevel': 'Nivel de zoom',
  'picker.rungTip.zones': 'Vista general — grupos de secciones como Grada norte o VIP',
  'picker.rungTip.sections': 'Bloques de sección — mezcla de categorías + matiz de disponibilidad',
  'picker.rungTip.seats': 'Asientos individuales — los bloques se convierten en puntos',
  'picker.rungLabel.zones': 'ZONAS',
  'picker.rungLabel.sections': 'SECCIONES',
  'picker.rungLabel.seats': 'ASIENTOS',
  'picker.sectionSummaryAria': 'Resumen de sección {label}',
  'picker.closeSectionSummary': 'Cerrar resumen de sección',
  'picker.seatsLeftInSection.one': '{count} asiento disponible',
  'picker.seatsLeftInSection.other': '{count} asientos disponibles',
  'picker.overview': 'Descripción general',
  'picker.tapSeatHint': 'Toca cualquier asiento para ver su vista',
  'picker.ticketTierFor': 'Categoría de entrada para {label}',
  'picker.viewFromSeat': 'Vista desde el asiento {label}',
  'picker.real360': 'REAL 360°',
  'picker.preview': 'VISTA PREVIA',
  'picker.sightline': '≈ {m} m al escenario · visión despejada',
  'picker.panorama360': 'Foto de 360° del lugar',
  'picker.illustrationCaption': 'ilustración · ≈ {m} m del escenario',
  'picker.restrictedView': 'Visibilidad restringida',
  'picker.obstructedView': 'Visibilidad obstruida',
  'picker.premiumSeat': 'Asiento premium',
  'picker.hideLimitedView': 'Ocultar asientos con visibilidad limitada',
  'picker.bestSeatsPremium': 'Mejores asientos',
  'picker.premiumFallbackNote': 'No hay un bloque premium de {count}: mostrando los mejores disponibles',
};
