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
  'picker.holdSeats': 'Réserver les sièges et valider',
  'picker.completeBooking': 'Terminer la réservation',
  'picker.seatsHeld': 'Sièges réservés — {time}',
  'picker.holdExpired': 'Votre réservation a expiré — les sièges ont été libérés. Sélectionnez à nouveau.',
  'picker.seatTaken': 'Le siège {label} vient d\'être réservé par un autre acheteur.',
  'picker.poweredBy': 'Propulsé par SeatLayer',
  'picker.testMode': 'MODE TEST',
  'picker.colorblind': 'Couleurs adaptées au daltonisme',
  'picker.orphanHint': "Cela laisse un siège isolé — pensez à vous décaler d'un siège.",
  'picker.seats.one': '{count} siège',
  'picker.seats.other': '{count} sièges',

  // renderer (drawn on the Konva map — shared by the embed SDK)
  'map.aria': 'Plan de salle. Utilisez les flèches pour naviguer entre les sièges, Entrée pour sélectionner.',
  'map.seatsLeft': '{count} LIBRES',
  'map.statusHeld': 'En attente',
  'map.statusTaken': 'Pris',
  'map.fromPrice': 'DÈS {price}',

  // buyer picker page (src/pages/PickerPage.tsx)
  'picker.language': 'Langue',
  'picker.zoomToFit': 'Ajuster le zoom',
  'picker.seatCountLabel': 'sièges',
  'picker.capacity': 'capacité',
  'picker.viewMode': 'Mode d\'affichage',
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
  'picker.chartSize': 'Taille du plan',
  'picker.custom': 'Personnalisé',
  'picker.categories': 'Catégories',
  'picker.accessibility': 'Accessibilité',
  'picker.showAnyAccessible': 'Afficher un siège accessible',
  'picker.any': 'N\'importe quel',
  'picker.yourSeats': 'Vos sièges',
  'picker.emptySeats': 'Appuyez sur les sièges sur le plan',
  'picker.emptySeatsWithGa': 'Appuyez sur les sièges sur le plan · appuyez sur une zone debout pour les billets GA',
  'picker.oneFewer': 'Un de moins',
  'picker.oneMore': 'Un de plus',
  'picker.remove': 'Supprimer {label}',
  'picker.ticketTierFor': 'Catégorie de billet pour {label}',
  'picker.total': 'Total : {amount}',
  'picker.viewFromSeat': 'Vue depuis le siège {label}',
  'picker.real360': 'VRAI 360°',
  'picker.preview': 'APERÇU',
  'picker.open360': 'Ouvrir la vue à 360°',
  'picker.sightline': '≈ {m} m de la scène · vue dégagée',
  'picker.bookedDemo': 'Réservé ! (démo)',
  'picker.bookButton.one': 'Réserver {count} billet — {amount}',
  'picker.bookButton.other': 'Réserver {count} billets — {amount}',
  'picker.simulateCrowd': 'Simuler la foule : {state}',
  'picker.on': 'ACTIVÉ',
  'picker.off': 'DÉSACTIVÉ',
  'picker.panorama360': 'Photo panoramique 360° du lieu',
  'picker.illustrationCaption': 'illustration · ≈ {m} m de la scène',
  'picker.restrictedView': 'Visibilité réduite',
  'picker.obstructedView': 'Vue obstruée',
  'picker.premiumSeat': 'Place premium',
  'picker.hideLimitedView': 'Masquer les places à visibilité réduite',
};
