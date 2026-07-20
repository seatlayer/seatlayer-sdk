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
  'picker.holdSeats': 'Retener asientos y comprar',
  'picker.completeBooking': 'Completar reserva',
  'picker.seatsHeld': 'Asientos retenidos — {time}',
  'picker.holdExpired': 'Tu retención expiró — los asientos fueron liberados. Elige de nuevo.',
  'picker.seatTaken': 'El asiento {label} fue tomado por otro comprador.',
  'picker.poweredBy': 'Con la tecnología de SeatLayer',
  'picker.testMode': 'MODO DE PRUEBA',
  'picker.colorblind': 'Colores aptos para daltonismo',
  'picker.orphanHint': 'Esto deja un asiento aislado — considera desplazarte un asiento.',
  'picker.seats.one': '{count} asiento',
  'picker.seats.other': '{count} asientos',

  // renderer (drawn on the Konva map — shared by the embed SDK)
  'map.aria': 'Mapa de asientos. Usa las flechas para moverte entre asientos, Intro para seleccionar.',
  'map.seatsLeft': '{count} LIBRES',
  'map.statusHeld': 'En espera',
  'map.statusTaken': 'Ocupado',
  'map.fromPrice': 'DESDE {price}',

  // buyer picker page (src/pages/PickerPage.tsx)
  'picker.language': 'Idioma',
  'picker.zoomToFit': 'Ajustar zoom',
  'picker.seatCountLabel': 'asientos',
  'picker.capacity': 'capacidad',
  'picker.viewMode': 'Modo de vista',
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
  'picker.chartSize': 'Tamaño del gráfico',
  'picker.custom': 'Personalizado',
  'picker.categories': 'Categorías',
  'picker.accessibility': 'Accesibilidad',
  'picker.showAnyAccessible': 'Mostrar cualquier asiento accesible',
  'picker.any': 'Cualquiera',
  'picker.yourSeats': 'Tus asientos',
  'picker.emptySeats': 'Toca asientos en el mapa',
  'picker.emptySeatsWithGa': 'Toca asientos en el mapa · toca un área de pie para entradas de entrada general',
  'picker.oneFewer': 'Uno menos',
  'picker.oneMore': 'Uno más',
  'picker.remove': 'Eliminar {label}',
  'picker.ticketTierFor': 'Categoría de entrada para {label}',
  'picker.total': 'Total: {amount}',
  'picker.viewFromSeat': 'Vista desde el asiento {label}',
  'picker.real360': 'REAL 360°',
  'picker.preview': 'VISTA PREVIA',
  'picker.open360': 'Abrir vista de 360°',
  'picker.sightline': '≈ {m} m al escenario · visión despejada',
  'picker.bookedDemo': '¡Reservado! (demostración)',
  'picker.bookButton.one': 'Reservar {count} entrada — {amount}',
  'picker.bookButton.other': 'Reservar {count} entradas — {amount}',
  'picker.simulateCrowd': 'Simular multitud: {state}',
  'picker.on': 'ACTIVADO',
  'picker.off': 'DESACTIVADO',
  'picker.panorama360': 'Foto de 360° del lugar',
  'picker.illustrationCaption': 'ilustración · ≈ {m} m del escenario',
  'picker.restrictedView': 'Visibilidad restringida',
  'picker.obstructedView': 'Visibilidad obstruida',
  'picker.premiumSeat': 'Asiento premium',
  'picker.hideLimitedView': 'Ocultar asientos con visibilidad limitada',
};
