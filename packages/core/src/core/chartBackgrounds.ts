import type {
  Category,
  ChartDoc,
  ChartObject,
  ChartReferenceImage,
  Floor,
} from './types';

type BackgroundOwner = Pick<ChartDoc, 'referenceImage' | 'backgroundImage'>
  | Pick<Floor, 'referenceImage' | 'backgroundImage'>;

/**
 * Canonical trace lookup with backward compatibility for documents authored
 * before reference and buyer backgrounds became separate fields.
 *
 * Any historical `backgroundImage` carrying a private `assetId` is trace-only,
 * even if it also contains a URL. That fail-closed rule prevents a mistakenly
 * persisted runtime URL from making a private blueprint buyer-visible.
 */
export function traceReferenceImage(owner: BackgroundOwner): ChartReferenceImage | undefined {
  return owner.referenceImage ?? (owner.backgroundImage?.assetId ? owner.backgroundImage : undefined);
}

/** Buyer-visible aesthetic background; private asset-backed values fail closed. */
export function buyerBackgroundImage(owner: BackgroundOwner): ChartReferenceImage | undefined {
  const background = owner.backgroundImage;
  return background?.url && !background.assetId ? background : undefined;
}

function buyerBackgroundProjection(owner: BackgroundOwner): ChartReferenceImage | undefined {
  const background = buyerBackgroundImage(owner);
  if (!background?.url) return undefined;
  // Calibration and derived source scale are private authoring evidence. Even a
  // historical URL-only layer must not expose source coordinates to buyers.
  const { calibration: _calibration, derivedScale: _derivedScale, assetId: _assetId, ...placement } = background;
  return placement;
}

/**
 * Promote historical private `backgroundImage.assetId` values into the
 * canonical `referenceImage` field in place. The migration is deterministic,
 * keeps placement/calibration bytes intact, and never overwrites an explicit
 * canonical trace. A conflicting second legacy asset is left in place so
 * validation can report it instead of silently dropping authored data.
 */
export function migrateLegacyBackgroundLayersInPlace(doc: ChartDoc): ChartDoc {
  const migrate = (owner: BackgroundOwner): void => {
    const legacy = owner.backgroundImage;
    if (!legacy?.assetId) return;
    if (!owner.referenceImage) {
      owner.referenceImage = legacy;
      owner.backgroundImage = undefined;
    }
  };
  migrate(doc);
  for (const floor of doc.floors ?? []) migrate(floor);
  return doc;
}

function buyerObject(object: ChartObject): ChartObject {
  const clean = { ...object } as ChartObject & Record<string, unknown>;
  // Private source ids, source hashes and scan provenance are authoring-only.
  delete clean.referenceScan;
  delete clean.referenceInventorySource;
  delete clean.referenceSource;
  delete clean.referenceInventoryExclusion;
  return clean;
}

function buyerCategory(category: Category): Category {
  const clean = { ...category };
  delete clean.referenceCategorySource;
  return clean;
}

/**
 * Produce the document a buyer is allowed to receive. This is deliberately a
 * projection, not a mutation: immutable publications and organizer drafts keep
 * their trace evidence, while every public response loses the trace bitmap,
 * calibration/source coordinates and object/category reference provenance.
 */
export function buyerFacingChartDoc(doc: ChartDoc): ChartDoc {
  const buyerBackground = buyerBackgroundProjection(doc);
  const floors = doc.floors?.map((floor) => ({
    ...floor,
    objects: floor.objects.map(buyerObject),
    referenceImage: undefined,
    backgroundImage: buyerBackgroundProjection(floor),
  }));
  return {
    ...doc,
    categories: doc.categories.map(buyerCategory),
    objects: doc.objects.map(buyerObject),
    referenceImage: undefined,
    backgroundImage: buyerBackground,
    ...(floors ? { floors } : {}),
  };
}

/** True when a scope has two different trace candidates and cannot be migrated safely. */
export function hasConflictingLegacyTrace(owner: BackgroundOwner): boolean {
  return !!owner.referenceImage?.assetId
    && !!owner.backgroundImage?.assetId
    && owner.referenceImage.assetId !== owner.backgroundImage.assetId;
}
