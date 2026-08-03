/**
 * Entry for the lazy view-from-seat chunk (`seatlayer-panorama.mjs`).
 *
 * ONE export on purpose. `generatePanorama.ts` also holds `generateSeatThumb`,
 * which the confirm card renders eagerly for its distance figure and which
 * therefore stays in the main bundle; naming only the panorama here lets rollup
 * tree-shake the thumb out of this chunk instead of shipping it twice.
 */
export { generateSeatPanorama } from '../../packages/core/src/view/generatePanorama';
