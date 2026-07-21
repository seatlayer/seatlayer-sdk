import { createRenderer } from '@seatlayer/core';
import { expandChart, floorsOf, polygonLabelPoint } from '@seatlayer/core';
import {
  inspectRenderedQualityEvidence,
  type RenderedEvidenceState,
  type RenderedQualityReport,
} from '@seatlayer/core';
import type { ChartDoc, ISeatmapRenderer, RendererQualityEvidence } from '@seatlayer/core';

export const BUYER_RENDERER_CONTRACT_VERSION = 4;
export type BuyerEvidenceState = RenderedEvidenceState;

export interface ChartDocumentPreviewOptions {
  /** CSS selector or element that will own the preview canvas. */
  container: string | HTMLElement;
  /** Persisted SeatLayer document to paint with the buyer renderer. */
  chart: ChartDoc;
  /** Optional persisted floor id; defaults to the chart's first floor. */
  floorId?: string;
  /** ISO 4217 currency used by hierarchy price labels. */
  currency?: string;
  /** Use the buyer renderer's colorblind-safe palette and state cues. */
  colorblindSafe?: boolean;
  /** Server-owned QA scene. Callers choose only the semantic name. */
  state?: BuyerEvidenceState;
  /** Server-owned category identity for a category-specific interaction scene. */
  evidenceCategoryKey?: string;
}

export interface ChartDocumentPreview {
  readonly contractVersion: number;
  readonly state: BuyerEvidenceState;
  getQualityEvidence(): RendererQualityEvidence;
  getQualityReport(): RenderedQualityReport;
  forceDraw(): void;
  destroy(): void;
}

function applyInteractionEvidenceState(
  renderer: ISeatmapRenderer,
  chart: ChartDoc,
  host: HTMLElement,
  floorId?: string,
  evidenceCategoryKey?: string,
): void {
  const initial = renderer.getRenderedQualityEvidence();
  const renderedCategories = new Set([
    ...initial.labels.map((label) => label.categoryKey),
    ...initial.gaAreas.map((area) => area.categoryKey),
  ]);
  if (evidenceCategoryKey && !renderedCategories.has(evidenceCategoryKey)) {
    throw new Error(`seatlayer: evidence category "${evidenceCategoryKey}" has no inventory on this floor`);
  }
  if (!initial.labels.length && !initial.gaAreas.length) {
    renderer.zoomToFit();
    return;
  }

  const floor = floorId
    ? floorsOf(chart).find((candidate) => candidate.id === floorId)
    : floorsOf(chart)[0];
  if (!floor) throw new Error('seatlayer: preview floor does not exist');
  const floorChart: ChartDoc = { ...chart, objects: floor.objects, floors: undefined };
  const byId = new Map(expandChart(floorChart).map((seat) => [seat.id, seat]));
  const eligibleLabels = evidenceCategoryKey
    ? initial.labels.filter((label) => label.categoryKey === evidenceCategoryKey)
    : initial.labels;
  const labelsBySection = new Map<string, typeof initial.labels>();
  for (const label of eligibleLabels) {
    if (!label.sectionId) continue;
    const members = labelsBySection.get(label.sectionId) ?? [];
    members.push(label);
    labelsBySection.set(label.sectionId, members);
  }
  const section = [...labelsBySection].sort((left, right) => {
    const leftCategories = new Set(left[1].map((label) => label.categoryKey)).size;
    const rightCategories = new Set(right[1].map((label) => label.categoryKey)).size;
    return Number(right[1].length >= 3) - Number(left[1].length >= 3)
      || rightCategories - leftCategories
      || right[1].length - left[1].length
      || left[0].localeCompare(right[0]);
  })[0];
  const pool = section?.[1] ?? eligibleLabels;
  const categoryCounts = new Map<string, number>();
  for (const label of pool) categoryCounts.set(label.categoryKey, (categoryCounts.get(label.categoryKey) ?? 0) + 1);
  const categoryKey = evidenceCategoryKey
    ?? [...categoryCounts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
    ?? initial.gaAreas[0]?.categoryKey;
  if (!categoryKey) {
    renderer.zoomToFit();
    return;
  }
  const candidates = evidenceCategoryKey
    ? pool
    : [
      ...pool.filter((label) => label.categoryKey === categoryKey),
      ...pool.filter((label) => label.categoryKey !== categoryKey),
      ...initial.labels.filter((label) => !pool.includes(label)),
    ];
  const distinct = [...new Map(candidates.map((label) => [label.seatId, label])).values()];
  const selected = distinct[0];
  const held = distinct[1];
  const booked = distinct[2];

  if (selected) {
    if (held) renderer.setStatus([held.seatId], 'held');
    if (booked) renderer.setStatus([booked.seatId], 'booked');
    renderer.setManageInteraction?.({
      manageMode: true,
      marqueeSelect: false,
      selectableStatuses: ['free'],
      maxSelection: 1,
    });
    if (!renderer.setEvidenceSelection?.(selected.seatId)) {
      renderer.selectByLabels?.([selected.label]);
    }
  }

  if (evidenceCategoryKey || renderedCategories.size >= 2) {
    renderer.setCategoryFilter?.([categoryKey]);
  }
  const targetGA = !selected
    ? initial.gaAreas
      .filter((area) => area.categoryKey === categoryKey)
      .sort((left, right) => right.capacity - left.capacity || left.areaId.localeCompare(right.areaId))[0]
    : undefined;
  const focusSectionId = section?.[0] ?? targetGA?.sectionId;
  if (focusSectionId) renderer.focusSection?.(focusSectionId);

  const anchor = selected ? byId.get(selected.seatId) : undefined;
  const gaObject = targetGA
    ? floor.objects.find((object) => object.type === 'gaArea' && object.id === targetGA.areaId)
    : undefined;
  const focusPoint = anchor ?? (gaObject?.type === 'gaArea'
    ? polygonLabelPoint(gaObject.points, gaObject.holes)
    : undefined);
  if (focusPoint && renderer.focusRegion) {
    const width = host.clientWidth || 1200;
    const height = host.clientHeight || 900;
    const targetScale = 2;
    const worldWidth = width / (targetScale * 1.12);
    const worldHeight = height / (targetScale * 1.12);
    renderer.focusRegion({
      x: focusPoint.x - worldWidth / 2,
      y: focusPoint.y - worldHeight / 2,
      width: worldWidth,
      height: worldHeight,
    }, { animate: false });
  }
}

function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container === 'string') {
    const element = document.querySelector(container);
    if (!element) throw new Error(`seatlayer: preview container "${container}" not found`);
    return element as HTMLElement;
  }
  if (!(container instanceof HTMLElement)) {
    throw new Error('seatlayer: preview container must be a CSS selector or an HTMLElement');
  }
  return container;
}

/**
 * Paint a persisted ChartDoc with the production buyer renderer, without API,
 * event, hold, booking, or WebSocket side effects. This is the browser capture
 * entry point used by MCP review evidence; it deliberately shares
 * SeatmapRenderer rather than maintaining a second look-alike rasterizer.
 */
export function renderChartDocument(options: ChartDocumentPreviewOptions): ChartDocumentPreview {
  if (!options || typeof options !== 'object') throw new Error('seatlayer: preview options are required');
  if (!options.chart || typeof options.chart !== 'object') throw new Error('seatlayer: preview chart is required');
  const state = options.state ?? 'overview';
  if (state !== 'overview' && state !== 'interaction') {
    throw new Error(`seatlayer: unsupported preview evidence state "${String(state)}"`);
  }
  const container = resolveContainer(options.container);
  const host = document.createElement('div');
  host.dataset.seatlayerBuyerRenderer = String(BUYER_RENDERER_CONTRACT_VERSION);
  host.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  container.replaceChildren(host);

  const renderer: ISeatmapRenderer = createRenderer(host, {
    maxSelection: 10,
    currency: options.currency,
  });
  renderer.setChart(options.chart, options.floorId ? { floorId: options.floorId } : undefined);
  if (options.colorblindSafe) renderer.setColorblindSafe?.(true);
  if (state === 'interaction') {
    applyInteractionEvidenceState(renderer, options.chart, host, options.floorId, options.evidenceCategoryKey);
  }
  else renderer.zoomToFit();
  renderer.forceDraw();

  let destroyed = false;
  return {
    contractVersion: BUYER_RENDERER_CONTRACT_VERSION,
    state,
    getQualityEvidence: () => renderer.getRenderedQualityEvidence(),
    getQualityReport: () => inspectRenderedQualityEvidence(
      renderer.getRenderedQualityEvidence(),
      state,
      options.evidenceCategoryKey ?? null,
    ),
    forceDraw: () => renderer.forceDraw(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      renderer.destroy();
      host.remove();
    },
  };
}
