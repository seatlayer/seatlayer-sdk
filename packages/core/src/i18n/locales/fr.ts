/**
 * French (fr) bundle — native French translation.
 * Follows the same key structure as en.ts; all placeholders and brand
 * names preserved.
 */

import type { Dict } from '../index';

export const fr: Dict = {
  // shared
  'common.cancel': 'Annuler',
  'common.close': 'Fermer',
  'common.done': 'Terminé',
  'common.copied': '✓ Copié',

  // buyer picker (extraction in progress — P4 of the port plan)
  'picker.holdExpired': 'Votre réservation a expiré — les sièges ont été libérés. Sélectionnez à nouveau.',
  'picker.poweredBy': 'Propulsé par SeatLayer',
  'picker.testMode': 'MODE TEST',
  'picker.orphanHint': "Cela laisse un siège isolé — pensez à vous décaler d'un siège.",

  // renderer (drawn on the Konva map — shared by the embed SDK)
  'map.aria': 'Plan de salle. Utilisez les flèches pour naviguer entre les sièges, Entrée pour sélectionner.',
  'map.seatsLeft': '{count} LIBRES',
  'map.statusHeld': 'En attente',
  'map.statusTaken': 'Pris',
  'map.fromPrice': 'DÈS {price}',

  // buyer picker widget (src/picker/widget/SeatPicker.ts)
  'picker.floor': 'Étage',
  'picker.zoomLevel': 'Niveau de zoom',
  'picker.rungTip.zones': 'Vue générale — groupes de sections comme Tribune nord ou VIP',
  'picker.rungTip.sections': 'Blocs de sections — mélange de catégories + teinte de disponibilité',
  'picker.rungTip.seats': 'Sièges individuels — les blocs se transforment en points',
  'picker.rungLabel.zones': 'ZONES',
  'picker.rungLabel.sections': 'SECTIONS',
  'picker.rungLabel.seats': 'SIÈGES',
  'picker.sectionSummaryAria': 'Résumé de la section {label}',
  'picker.closeSectionSummary': 'Fermer le résumé de la section',
  'picker.seatsLeftInSection.one': '{count} siège restant',
  'picker.seatsLeftInSection.other': '{count} sièges restants',
  'picker.overview': 'Vue d\'ensemble',
  'picker.tapSeatHint': 'Appuyez sur un siège pour vérifier sa vue',
  'picker.ticketTierFor': 'Catégorie de billet pour {label}',
  'picker.viewFromSeat': 'Vue depuis le siège {label}',
  'picker.real360': 'VRAI 360°',
  'picker.preview': 'APERÇU',
  'picker.sightline': '≈ {m} m de la scène · vue dégagée',
  'picker.panorama360': 'Photo panoramique 360° du lieu',
  'picker.illustrationCaption': 'illustration · ≈ {m} m de la scène',
  'picker.restrictedView': 'Visibilité réduite',
  'picker.obstructedView': 'Vue obstruée',
  'picker.premiumSeat': 'Place premium',
  'picker.hideLimitedView': 'Masquer les places à visibilité réduite',
  'picker.bestSeatsPremium': 'Meilleures places',
  'picker.premiumFallbackNote': 'Aucun bloc premium de {count} — affichage des meilleures places disponibles',
};
