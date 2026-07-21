import {
  MIN_VISIBLE_BOOKABLE_LABEL_PX,
  renderedTextContrast,
} from './chartRenderRules';
import type {
  RenderedBookableLabelEvidence,
  RenderedFreeTextEvidence,
  RenderedHierarchyLabelEvidence,
  RendererQualityEvidence,
} from './types';

export const RENDERED_QUALITY_REPORT_VERSION = 3;
const MIN_TEXT_CONTRAST = 4.5;
const MIN_GRAPHICAL_CONTRAST = 3;
const MIN_POINTER_TARGET_PX = 24;
const MAX_SAMPLES_PER_FINDING = 20;

export type RenderedEvidenceState = 'overview' | 'interaction';

interface ScreenBox { x: number; y: number; width: number; height: number }

export type RenderedQualityFindingCode =
  | 'bookable-label-undersized'
  | 'bookable-label-contrast-low'
  | 'bookable-label-collision'
  | 'hierarchy-label-undersized'
  | 'hierarchy-label-contrast-low'
  | 'hierarchy-label-outside-section'
  | 'hierarchy-label-collision'
  | 'hierarchy-bookable-collision'
  | 'overview-section-category-paint'
  | 'overview-category-detail-visible'
  | 'overview-row-hints-visible'
  | 'overview-availability-clutter'
  | 'overview-ga-detail-visible'
  | 'free-text-undersized'
  | 'free-text-contrast-low'
  | 'free-text-collision'
  | 'free-text-bookable-collision'
  | 'free-text-hierarchy-collision'
  | 'ga-contrast-low'
  | 'detail-rung-missing'
  | 'detail-inventory-not-visible'
  | 'pointer-target-undersized'
  | 'pointer-target-inactive'
  | 'selected-state-missing'
  | 'selected-state-contrast-low'
  | 'held-state-missing'
  | 'booked-state-missing'
  | 'status-state-indistinct'
  | 'section-focus-missing'
  | 'category-filter-missing'
  | 'category-filter-ineffective'
  | 'target-category-not-visible'
  | 'target-category-filter-mismatch';

export interface RenderedQualitySample {
  primaryId: string;
  primaryLabel: string;
  secondaryId?: string;
  secondaryLabel?: string;
  measured?: number;
  minimum?: number;
}

export interface RenderedQualityFinding {
  code: RenderedQualityFindingCode;
  message: string;
  count: number;
  samples: RenderedQualitySample[];
}

export interface RenderedQualityReport {
  version: typeof RENDERED_QUALITY_REPORT_VERSION;
  passed: boolean;
  state: RenderedEvidenceState;
  /** Server-selected category exercised by a category-specific detail scene. */
  targetCategoryKey: string | null;
  /** Exact overview checks discharged by this browser-rendered report. */
  resolvedRules: string[];
  viewport: { width: number; height: number };
  canvasBackground: string;
  effectiveScale: number;
  rung: RendererQualityEvidence['rung'];
  inventory: {
    totalBookableUnits: number;
    totalLabelledBookableUnits: number;
    visibleBookableLabels: number;
    hiddenBookableLabels: number;
    visibleHierarchyLabels: number;
    visibleFreeTextLabels: number;
    visibleGAAreas: number;
  };
  overviewStyle?: RendererQualityEvidence['overviewStyle'];
  /**
   * Coordinate-free identity evidence from the exact buyer scene. The Worker
   * uses this to compare persisted reference semantics with what Chromium
   * actually painted, without exposing screen boxes or accepting geometry.
   */
  composition: {
    hierarchy: Array<{
      id: string;
      kind: 'section' | 'zone';
      label: string;
      visible: boolean;
    }>;
    labelledObjects: Array<{
      objectId: string;
      kind: RenderedFreeTextEvidence['kind'];
      text: string;
      visible: boolean;
    }>;
    gaAreas: Array<{
      areaId: string;
      label: string;
      categoryKey: string;
      sectionId?: string;
      visible: boolean;
    }>;
    bookableSectionIds: string[];
    categoryKeys: string[];
    /** Categories whose non-dimmed bookable paint is visible in this scene. */
    activeCategoryKeys: string[];
  };
  metrics: {
    minimumRenderedBookableLabelPx: number | null;
    minimumBookableLabelContrast: number | null;
    minimumRenderedHierarchyLabelPx: number | null;
    minimumHierarchyLabelContrast: number | null;
    minimumRenderedFreeTextPx: number | null;
    minimumFreeTextContrast: number | null;
    minimumGAContrast: number | null;
    minimumEffectivePointerTargetPx: number | null;
    selectedRingContrast: number | null;
  };
  interaction: {
    applicable: {
      detail: boolean;
      pointer: boolean;
      held: boolean;
      booked: boolean;
      sectionFocus: boolean;
      categoryFilter: boolean;
    };
    selectedUnits: number;
    heldUnits: number;
    bookedUnits: number;
    activePointerTargets: number;
    focusedSectionId: string | null;
    focusBackdropVisible: boolean;
    categoryFilterKeys: string[] | null;
  };
  findings: RenderedQualityFinding[];
}

type VisibleWithBox<T extends { visible: boolean; screenBox?: ScreenBox }> = T & { screenBox: ScreenBox };

function visibleWithBox<T extends { visible: boolean; screenBox?: ScreenBox }>(
  items: T[],
): Array<VisibleWithBox<T>> {
  return items.filter((item): item is VisibleWithBox<T> => item.visible && Boolean(item.screenBox));
}

function intersects(left: ScreenBox, right: ScreenBox): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function minimum(values: number[]): number | null {
  return values.length ? Math.round(Math.min(...values) * 100) / 100 : null;
}

function finding(
  code: RenderedQualityFindingCode,
  message: string,
  samples: RenderedQualitySample[],
): RenderedQualityFinding | null {
  if (!samples.length) return null;
  return {
    code,
    message,
    count: samples.length,
    samples: samples.slice(0, MAX_SAMPLES_PER_FINDING),
  };
}

function labelSample(label: RenderedBookableLabelEvidence, measured?: number, minimumValue?: number): RenderedQualitySample {
  return {
    primaryId: label.seatId,
    primaryLabel: label.label,
    ...(measured == null ? {} : { measured: Math.round(measured * 100) / 100 }),
    ...(minimumValue == null ? {} : { minimum: minimumValue }),
  };
}

function hierarchySample(label: RenderedHierarchyLabelEvidence, measured?: number, minimumValue?: number): RenderedQualitySample {
  return {
    primaryId: label.id,
    primaryLabel: label.label,
    ...(measured == null ? {} : { measured: Math.round(measured * 100) / 100 }),
    ...(minimumValue == null ? {} : { minimum: minimumValue }),
  };
}

function freeTextSample(label: RenderedFreeTextEvidence, measured?: number, minimumValue?: number): RenderedQualitySample {
  return {
    primaryId: label.objectId,
    primaryLabel: label.text,
    ...(measured == null ? {} : { measured: Math.round(measured * 100) / 100 }),
    ...(minimumValue == null ? {} : { minimum: minimumValue }),
  };
}

function collisionSample(
  primaryId: string,
  primaryLabel: string,
  secondaryId: string,
  secondaryLabel: string,
): RenderedQualitySample {
  return { primaryId, primaryLabel, secondaryId, secondaryLabel };
}

/**
 * Inspect what the buyer renderer actually decided to paint at one exact
 * viewport. This is deliberately downstream of ChartDoc validation: screen
 * size, LOD visibility, fitted hierarchy text, transient paint, and label
 * collisions cannot be proven from stored geometry alone.
 */
export function inspectRenderedQualityEvidence(
  evidence: RendererQualityEvidence,
  state: RenderedEvidenceState = 'overview',
  targetCategoryKey: string | null = null,
): RenderedQualityReport {
  const bookable = visibleWithBox(evidence.labels);
  const hierarchy = visibleWithBox(evidence.hierarchyLabels);
  const freeText = visibleWithBox(evidence.freeTextLabels);
  const visibleGA = evidence.gaAreas.filter((area) => area.visible);

  const bookableContrast = bookable.map((label) => renderedTextContrast(label.ink, label.fill) ?? 0);
  const hierarchyContrast = hierarchy.map((label) => renderedTextContrast(label.ink, label.fill) ?? 0);
  const freeTextContrast = freeText.map((label) => renderedTextContrast(label.ink, label.background) ?? 0);
  const gaContrast = visibleGA.map((area) => renderedTextContrast(area.effectiveBackground, evidence.canvasBackground) ?? 0);
  const targetLabels = targetCategoryKey
    ? evidence.labels.filter((label) => label.categoryKey === targetCategoryKey)
    : evidence.labels;
  const targetGAAreas = targetCategoryKey
    ? evidence.gaAreas.filter((area) => area.categoryKey === targetCategoryKey)
    : evidence.gaAreas;
  const selected = targetLabels.filter((label) => label.selected);
  const held = targetLabels.filter((label) => label.status === 'held');
  const booked = targetLabels.filter((label) => label.status === 'booked');
  const activePointerTargets = targetLabels.filter((label) => label.pointerTarget.active);
  const activeCategoryKeys = new Set([
    ...evidence.labels
      .filter((label) => label.visible && (label.opacity > 0.25 || label.selected || label.status !== 'free'))
      .map((label) => label.categoryKey),
    ...evidence.gaAreas
      .filter((area) => area.visible && area.opacity > 0.1)
      .map((area) => area.categoryKey),
  ]);
  const selectedRingContrast = selected.length
    ? minimum(selected.flatMap((label) => [
      renderedTextContrast(evidence.selectionRingColor, evidence.canvasBackground) ?? 0,
      renderedTextContrast(evidence.selectionRingColor, label.fill) ?? 0,
    ]))
    : null;

  const findings: Array<RenderedQualityFinding | null> = [];
  const overviewCountSamples = (count: number, label: string): RenderedQualitySample[] =>
    Array.from({ length: count }, (_, index) => ({
      primaryId: `overview:${index + 1}`,
      primaryLabel: label,
    }));
  if (state === 'overview' && evidence.rung === 'sections') {
    findings.push(finding(
      'overview-section-category-paint',
      'Section overview shells must use the neutral hierarchy palette, not category paint',
      overviewCountSamples(evidence.overviewStyle.categoryPaintedSectionShells, 'category-painted section shell'),
    ));
    findings.push(finding(
      'overview-category-detail-visible',
      'Category-tinted section detail must wait until section focus or seat zoom',
      overviewCountSamples(evidence.overviewStyle.visibleCategoryDetailOutlines, 'category detail outline'),
    ));
    findings.push(finding(
      'overview-row-hints-visible',
      'Row and seat patterns must not clutter the section overview',
      overviewCountSamples(evidence.overviewStyle.visibleSectionRowHints, 'section row hint'),
    ));
    findings.push(finding(
      'overview-availability-clutter',
      'Live availability counts belong in focused detail, not on section overview shells',
      overviewCountSamples(evidence.overviewStyle.visibleSectionAvailabilityLabels, 'section availability label'),
    ));
    findings.push(finding(
      'overview-ga-detail-visible',
      'Section-contained standing paint belongs in focused detail, not on section overview shells',
      overviewCountSamples(evidence.overviewStyle.visibleSectionGADetails, 'section-contained GA detail'),
    ));
  }
  findings.push(finding(
    'bookable-label-undersized',
    'Visible bookable labels must meet the rendered small-text size floor',
    bookable
      .filter((label) => label.renderedFontPx < evidence.minimumVisibleLabelPx)
      .map((label) => labelSample(label, label.renderedFontPx, evidence.minimumVisibleLabelPx)),
  ));

  if (state === 'interaction') {
    const labelledInventory = targetLabels.length > 0;
    const gaInventory = targetGAAreas.length > 0;
    const detailInventory = labelledInventory || gaInventory;
    const visibleTargetGA = targetGAAreas.filter((area) => area.visible);
    const sections = new Set([
      ...targetLabels.flatMap((label) => label.sectionId ? [label.sectionId] : []),
      ...targetGAAreas.flatMap((area) => area.sectionId ? [area.sectionId] : []),
    ]);
    const categories = new Set([
      ...evidence.labels.map((label) => label.categoryKey),
      ...evidence.gaAreas.map((area) => area.categoryKey),
    ]);
    const inViewport = (label: RenderedBookableLabelEvidence) => (
      label.screenCenter.x >= 0 && label.screenCenter.x <= evidence.viewport.width
      && label.screenCenter.y >= 0 && label.screenCenter.y <= evidence.viewport.height
    );
    findings.push(finding(
      'detail-rung-missing',
      'Interaction evidence with bookable inventory must render the seat-detail rung',
      detailInventory && evidence.rung !== 'seats'
        ? [{ primaryId: 'renderer', primaryLabel: evidence.rung }]
        : [],
    ));
    findings.push(finding(
      'detail-inventory-not-visible',
      'Interaction evidence must frame at least one real bookable unit',
      detailInventory && !targetLabels.some(inViewport) && !visibleTargetGA.length
        ? [{ primaryId: 'renderer', primaryLabel: 'no target inventory in viewport' }]
        : [],
    ));
    findings.push(finding(
      'pointer-target-inactive',
      'Interaction evidence must expose a live production pointer target',
      (labelledInventory && !activePointerTargets.some(inViewport))
        || (!labelledInventory && gaInventory && !visibleTargetGA.some((area) => area.interactive))
        ? [{ primaryId: 'renderer', primaryLabel: 'no active pointer target in viewport' }]
        : [],
    ));
    findings.push(finding(
      'pointer-target-undersized',
      'Every active production pointer target must reach at least 24 CSS pixels',
      activePointerTargets
        .filter((label) => inViewport(label) && label.pointerTarget.effectiveMinimumPx < MIN_POINTER_TARGET_PX)
        .map((label) => labelSample(label, label.pointerTarget.effectiveMinimumPx, MIN_POINTER_TARGET_PX)),
    ));
    findings.push(finding(
      'selected-state-missing',
      'Interaction evidence must paint a selected unit and its renderer-owned ring',
      labelledInventory && (!selected.length || !selected.some((label) => evidence.selectionRingSeatIds.includes(label.seatId)))
        ? [{ primaryId: 'renderer', primaryLabel: 'selected state' }]
        : [],
    ));
    findings.push(finding(
      'selected-state-contrast-low',
      'The selected-state ring must maintain 3:1 graphical contrast with the canvas',
      selected.length && (selectedRingContrast ?? 0) < MIN_GRAPHICAL_CONTRAST
        ? [{
          primaryId: selected[0].seatId,
          primaryLabel: selected[0].label,
          measured: Math.round((selectedRingContrast ?? 0) * 100) / 100,
          minimum: MIN_GRAPHICAL_CONTRAST,
        }]
        : [],
    ));
    findings.push(finding(
      'held-state-missing',
      'Interaction evidence must paint a held state when the floor has at least two status-managed units',
      targetLabels.length >= 2 && !held.length
        ? [{ primaryId: 'renderer', primaryLabel: 'held state' }]
        : [],
    ));
    findings.push(finding(
      'booked-state-missing',
      'Interaction evidence must paint a taken state when the floor has at least three status-managed units',
      targetLabels.length >= 3 && !booked.length
        ? [{ primaryId: 'renderer', primaryLabel: 'booked state' }]
        : [],
    ));
    const heldSignatures = new Set(held.map((label) => `${label.fill.toLowerCase()}:${label.opacity}`));
    const bookedSignatures = new Set(booked.map((label) => `${label.fill.toLowerCase()}:${label.opacity}`));
    findings.push(finding(
      'status-state-indistinct',
      'Held and taken evidence must resolve to distinct renderer paint',
      held.length && booked.length && [...heldSignatures].some((signature) => bookedSignatures.has(signature))
        ? [{ primaryId: held[0].seatId, primaryLabel: held[0].label, secondaryId: booked[0].seatId, secondaryLabel: booked[0].label }]
        : [],
    ));
    findings.push(finding(
      'section-focus-missing',
      'Interaction evidence must exercise section focus and its backdrop when section membership exists',
      sections.size && (!evidence.focusedSectionId || !evidence.focusBackdropVisible)
        ? [{ primaryId: 'renderer', primaryLabel: 'section focus' }]
        : [],
    ));
    findings.push(finding(
      'category-filter-missing',
      'Interaction evidence must exercise a category filter when multiple categories exist',
      categories.size >= 2 && (!evidence.categoryFilterKeys || !evidence.categoryFilterKeys.length)
        ? [{ primaryId: 'renderer', primaryLabel: 'category filter' }]
        : [],
    ));
    const excludedFree = evidence.labels.filter((label) => (
      label.status === 'free'
      && !label.selected
      && evidence.categoryFilterKeys != null
      && !evidence.categoryFilterKeys.includes(label.categoryKey)
    ));
    const excludedGA = evidence.gaAreas.filter((area) => (
      evidence.categoryFilterKeys != null
      && !evidence.categoryFilterKeys.includes(area.categoryKey)
    ));
    findings.push(finding(
      'category-filter-ineffective',
      'The active category filter must visibly dim excluded free inventory',
      (excludedFree.length || excludedGA.length)
        && !excludedFree.some((label) => label.opacity <= 0.25)
        && !excludedGA.some((area) => area.opacity <= 0.1)
        ? [
          ...excludedFree.map((label) => labelSample(label, label.opacity)),
          ...excludedGA.map((area) => ({ primaryId: area.areaId, primaryLabel: area.label, measured: area.opacity })),
        ]
        : [],
    ));
    findings.push(finding(
      'target-category-not-visible',
      'A category-specific interaction scene must visibly paint its exact target category',
      targetCategoryKey && !activeCategoryKeys.has(targetCategoryKey)
        ? [{ primaryId: targetCategoryKey, primaryLabel: targetCategoryKey }]
        : [],
    ));
    findings.push(finding(
      'target-category-filter-mismatch',
      'A category-specific interaction scene must bind its filter to only the exact target category',
      targetCategoryKey && (
        evidence.categoryFilterKeys?.length !== 1
        || evidence.categoryFilterKeys[0] !== targetCategoryKey
      )
        ? [{ primaryId: targetCategoryKey, primaryLabel: targetCategoryKey }]
        : [],
    ));
  }
  findings.push(finding(
    'bookable-label-contrast-low',
    'Visible bookable labels must meet 4.5:1 contrast against their actual paint',
    bookable.flatMap((label) => {
      const ratio = renderedTextContrast(label.ink, label.fill) ?? 0;
      return ratio < MIN_TEXT_CONTRAST ? [labelSample(label, ratio, MIN_TEXT_CONTRAST)] : [];
    }),
  ));

  const bookableCollisions: RenderedQualitySample[] = [];
  for (let index = 0; index < bookable.length; index += 1) {
    for (let other = 0; other < index; other += 1) {
      if (intersects(bookable[index].screenBox, bookable[other].screenBox)) {
        bookableCollisions.push(collisionSample(
          bookable[other].seatId, bookable[other].label,
          bookable[index].seatId, bookable[index].label,
        ));
      }
    }
  }
  findings.push(finding(
    'bookable-label-collision',
    'Visible bookable labels must not overlap',
    bookableCollisions,
  ));

  findings.push(finding(
    'hierarchy-label-undersized',
    'Visible section and zone labels must meet the rendered small-text size floor',
    hierarchy
      .filter((label) => label.renderedFontPx < MIN_VISIBLE_BOOKABLE_LABEL_PX)
      .map((label) => hierarchySample(label, label.renderedFontPx, MIN_VISIBLE_BOOKABLE_LABEL_PX)),
  ));
  findings.push(finding(
    'hierarchy-label-contrast-low',
    'Visible section and zone labels must meet 4.5:1 contrast against their backing paint',
    hierarchy.flatMap((label) => {
      const ratio = renderedTextContrast(label.ink, label.fill) ?? 0;
      return ratio < MIN_TEXT_CONTRAST ? [hierarchySample(label, ratio, MIN_TEXT_CONTRAST)] : [];
    }),
  ));
  findings.push(finding(
    'hierarchy-label-outside-section',
    'Visible section labels must remain inside the filled section surface and outside holes',
    hierarchy
      .filter((label) => label.kind === 'section' && label.fitsContainer === false)
      .map((label) => hierarchySample(label)),
  ));

  const hierarchyCollisions: RenderedQualitySample[] = [];
  for (let index = 0; index < hierarchy.length; index += 1) {
    for (let other = 0; other < index; other += 1) {
      if (intersects(hierarchy[index].screenBox, hierarchy[other].screenBox)) {
        hierarchyCollisions.push(collisionSample(
          hierarchy[other].id, hierarchy[other].label,
          hierarchy[index].id, hierarchy[index].label,
        ));
      }
    }
  }
  findings.push(finding(
    'hierarchy-label-collision',
    'Visible hierarchy labels must not overlap each other',
    hierarchyCollisions,
  ));

  const hierarchyBookableCollisions: RenderedQualitySample[] = [];
  for (const upper of hierarchy) {
    for (const unit of bookable) {
      if (intersects(upper.screenBox, unit.screenBox)) {
        hierarchyBookableCollisions.push(collisionSample(upper.id, upper.label, unit.seatId, unit.label));
      }
    }
  }
  findings.push(finding(
    'hierarchy-bookable-collision',
    'Visible hierarchy labels must not overlap bookable labels',
    hierarchyBookableCollisions,
  ));

  findings.push(finding(
    'free-text-undersized',
    'Visible chart text must meet the rendered small-text size floor',
    freeText
      .filter((label) => label.renderedFontPx < evidence.minimumVisibleLabelPx)
      .map((label) => freeTextSample(label, label.renderedFontPx, evidence.minimumVisibleLabelPx)),
  ));
  findings.push(finding(
    'free-text-contrast-low',
    'Visible chart text must meet 4.5:1 contrast against its measured background',
    freeText.flatMap((label) => {
      const ratio = renderedTextContrast(label.ink, label.background) ?? 0;
      return ratio < MIN_TEXT_CONTRAST ? [freeTextSample(label, ratio, MIN_TEXT_CONTRAST)] : [];
    }),
  ));

  const freeTextCollisions: RenderedQualitySample[] = [];
  for (let index = 0; index < freeText.length; index += 1) {
    for (let other = 0; other < index; other += 1) {
      if (intersects(freeText[index].screenBox, freeText[other].screenBox)) {
        freeTextCollisions.push(collisionSample(
          freeText[other].objectId, freeText[other].text,
          freeText[index].objectId, freeText[index].text,
        ));
      }
    }
  }
  findings.push(finding(
    'free-text-collision',
    'Visible chart text labels must not overlap each other',
    freeTextCollisions,
  ));

  const freeTextBookableCollisions: RenderedQualitySample[] = [];
  for (const text of freeText) {
    for (const unit of bookable) {
      if (intersects(text.screenBox, unit.screenBox)) {
        freeTextBookableCollisions.push(collisionSample(text.objectId, text.text, unit.seatId, unit.label));
      }
    }
  }
  findings.push(finding(
    'free-text-bookable-collision',
    'Visible chart text must not overlap bookable labels',
    freeTextBookableCollisions,
  ));

  const freeTextHierarchyCollisions: RenderedQualitySample[] = [];
  for (const text of freeText) {
    for (const upper of hierarchy) {
      if (intersects(text.screenBox, upper.screenBox)) {
        freeTextHierarchyCollisions.push(collisionSample(text.objectId, text.text, upper.id, upper.label));
      }
    }
  }
  findings.push(finding(
    'free-text-hierarchy-collision',
    'Visible chart text must not overlap hierarchy labels',
    freeTextHierarchyCollisions,
  ));

  findings.push(finding(
    'ga-contrast-low',
    'Visible GA surfaces must maintain 3:1 graphical contrast with the canvas',
    visibleGA.flatMap((area) => {
      const ratio = renderedTextContrast(area.effectiveBackground, evidence.canvasBackground) ?? 0;
      return ratio < MIN_GRAPHICAL_CONTRAST ? [{
        primaryId: area.areaId,
        primaryLabel: area.label,
        measured: Math.round(ratio * 100) / 100,
        minimum: MIN_GRAPHICAL_CONTRAST,
      }] : [];
    }),
  ));

  const materialFindings = findings.filter((item): item is RenderedQualityFinding => Boolean(item));
  return {
    version: RENDERED_QUALITY_REPORT_VERSION,
    passed: materialFindings.length === 0,
    state,
    targetCategoryKey,
    resolvedRules: [
      'rendered-overview-label-size',
      'rendered-overview-label-contrast',
      'rendered-overview-label-collision',
      'rendered-overview-hierarchy-containment',
      'rendered-overview-section-first-style',
      'rendered-overview-ga-contrast',
      ...(state === 'interaction' ? [
        'rendered-detail-inventory',
        'rendered-pointer-target',
        'rendered-selected-held-taken-states',
        'rendered-section-focus',
        'rendered-category-filter',
      ] : []),
    ],
    viewport: evidence.viewport,
    canvasBackground: evidence.canvasBackground,
    effectiveScale: evidence.effectiveScale,
    rung: evidence.rung,
    inventory: {
      totalBookableUnits: evidence.totalBookableUnits,
      totalLabelledBookableUnits: evidence.totalLabelledBookableUnits,
      visibleBookableLabels: bookable.length,
      hiddenBookableLabels: evidence.hiddenLabels,
      visibleHierarchyLabels: hierarchy.length,
      visibleFreeTextLabels: freeText.length,
      visibleGAAreas: visibleGA.length,
    },
    overviewStyle: evidence.overviewStyle,
    composition: {
      hierarchy: evidence.hierarchyLabels
        .filter((label) => label.role === 'name')
        .map((label) => ({
          id: label.id,
          kind: label.kind,
          label: label.label,
          visible: label.visible,
        }))
        .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
      labelledObjects: evidence.freeTextLabels
        .map((label) => ({
          objectId: label.objectId,
          kind: label.kind,
          text: label.text,
          visible: label.visible,
        }))
        .sort((left, right) => left.objectId.localeCompare(right.objectId) || left.kind.localeCompare(right.kind)),
      gaAreas: evidence.gaAreas
        .map((area) => ({
          areaId: area.areaId,
          label: area.label,
          categoryKey: area.categoryKey,
          ...(area.sectionId ? { sectionId: area.sectionId } : {}),
          visible: area.visible,
        }))
        .sort((left, right) => left.areaId.localeCompare(right.areaId)),
      bookableSectionIds: [...new Set(evidence.labels.flatMap((label) => label.sectionId ? [label.sectionId] : []))].sort(),
      categoryKeys: [...new Set([
        ...evidence.labels.map((label) => label.categoryKey),
        ...evidence.gaAreas.map((area) => area.categoryKey),
      ])].sort(),
      activeCategoryKeys: [...activeCategoryKeys].sort(),
    },
    metrics: {
      minimumRenderedBookableLabelPx: minimum(bookable.map((label) => label.renderedFontPx)),
      minimumBookableLabelContrast: minimum(bookableContrast),
      minimumRenderedHierarchyLabelPx: minimum(hierarchy.map((label) => label.renderedFontPx)),
      minimumHierarchyLabelContrast: minimum(hierarchyContrast),
      minimumRenderedFreeTextPx: minimum(freeText.map((label) => label.renderedFontPx)),
      minimumFreeTextContrast: minimum(freeTextContrast),
      minimumGAContrast: minimum(gaContrast),
      minimumEffectivePointerTargetPx: minimum(activePointerTargets.map((label) => label.pointerTarget.effectiveMinimumPx)),
      selectedRingContrast: selectedRingContrast == null ? null : Math.round(selectedRingContrast * 100) / 100,
    },
    interaction: {
      applicable: {
        detail: targetLabels.length > 0 || targetGAAreas.length > 0,
        pointer: targetLabels.length > 0 || targetGAAreas.length > 0,
        held: targetLabels.length >= 2,
        booked: targetLabels.length >= 3,
        sectionFocus: targetLabels.some((label) => Boolean(label.sectionId))
          || targetGAAreas.some((area) => Boolean(area.sectionId)),
        categoryFilter: new Set([
          ...evidence.labels.map((label) => label.categoryKey),
          ...evidence.gaAreas.map((area) => area.categoryKey),
        ]).size >= 2,
      },
      selectedUnits: selected.length,
      heldUnits: held.length,
      bookedUnits: booked.length,
      activePointerTargets: activePointerTargets.length,
      focusedSectionId: evidence.focusedSectionId,
      focusBackdropVisible: evidence.focusBackdropVisible,
      categoryFilterKeys: evidence.categoryFilterKeys,
    },
    findings: materialFindings,
  };
}
