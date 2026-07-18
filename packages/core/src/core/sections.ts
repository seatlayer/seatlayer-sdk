/**
 * Section membership + hide/show resolution (Batch 3.3).
 *
 * A `SectionObject` is a polygon drawn over existing seat objects; an object
 * "belongs" to a section when its visual centre (`objectCenter`) falls inside
 * the section outline, first section in doc order winning. This is the same
 * spatial notion `objectCenter`'s doc-comment describes, resolved once here so
 * BOTH the event manager (Sections tab counts) and the buyer picker (omit
 * hidden seats) agree on which seats live in which section.
 *
 * Hiding is per-EVENT (the EventDO holds the hidden id set), not a chart edit —
 * so a republish of the chart never disturbs it. A hidden id may be a section
 * id, a zone id (hides every section in the zone), or `UNGROUPED_ID` (the
 * catch-all bucket of seat objects that sit in no section).
 */
import type { ChartDoc, ChartObject, SectionObject } from './types';
import { allObjects, expandBooth, expandRow, expandTable, objectCenter, pointInPolygonWithHoles } from './layout';
import { gaUnitLabels } from './ga';

/** Synthetic section id for seat objects that fall in no drawn section. */
export const UNGROUPED_ID = '__ungrouped__';

/**
 * A per section/zone availability window (Batch 3.4). Wire-compatible with the
 * EventDO's own `AvailabilityRule`. Absence of a rule for an id = on sale.
 *   'hidden'    — manual: hidden until the organizer reveals it (3.3).
 *   'timed'     — hidden until `revealAt` (epoch ms), then auto-reveals.
 *   'threshold' — auto-reveals once the on-sale inventory is `thresholdPct`% sold.
 *   'closed'    — visible to buyers but not purchasable (rendered flat grey);
 *                 unlike 'hidden', the seats stay on the map, just off sale.
 * `labels` are the seat labels the id governs, so a threshold's denominator can
 * exclude still-hidden seats.
 */
export interface AvailabilityRule {
  mode: 'hidden' | 'timed' | 'threshold' | 'closed';
  revealAt?: number;
  thresholdPct?: number;
  labels?: string[];
}

export interface SectionNode {
  /** Section id (a `SectionObject.id`, or `UNGROUPED_ID`). */
  id: string;
  label: string;
  /** Zone id this section points at (`SectionObject.zone`), if any. */
  zone?: string;
  /** Total seats across the member objects. */
  seatCount: number;
  /** Ids of the seat-bearing objects that belong to this section. */
  objectIds: string[];
  /** Seat labels across the member objects (for availability-rule denominators). */
  seatLabels: string[];
}

/** Seat labels produced by one seat-bearing object (rows/tables/booths); [] otherwise. */
function objectSeatLabels(o: ChartObject): string[] {
  if (o.type === 'row') return expandRow(o).map((s) => s.label);
  if (o.type === 'table') return expandTable(o).map((s) => s.label);
  if (o.type === 'booth') return expandBooth(o).map((s) => s.label);
  if (o.type === 'gaArea') return gaUnitLabels(o);
  return [];
}

function isSeatObject(o: ChartObject): o is Extract<ChartObject, { type: 'row' | 'table' | 'booth' | 'gaArea' }> {
  return o.type === 'row' || o.type === 'table' || o.type === 'booth' || o.type === 'gaArea';
}

function samePoints(left: Array<{ x: number; y: number }>, right: Array<{ x: number; y: number }>): boolean {
  return left.length === right.length
    && left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
}

function sameGASurfaceAsSection(object: ChartObject, section: SectionObject): boolean {
  if (object.type !== 'gaArea' || !samePoints(object.points, section.outline)) return false;
  const objectHoles = object.holes ?? [];
  const sectionHoles = section.holes ?? [];
  return objectHoles.length === sectionHoles.length
    && objectHoles.every((hole, index) => samePoints(hole, sectionHoles[index]));
}

/**
 * Resolve section membership for a chart. Returns one node per drawn section
 * (doc order), a synthetic "Ungrouped" node for loose seat objects (null when
 * every seat sits in a section), and the object→section id map.
 */
export function computeSections(doc: ChartDoc): {
  sections: SectionNode[];
  ungrouped: SectionNode | null;
  /** seat-object id → owning section id (or `UNGROUPED_ID`). */
  objectToSection: Map<string, string>;
} {
  // Span all floors (Batch 5) — a multi-floor chart's sections live in floors[];
  // single-floor charts fall through to doc.objects. Section ids are chart-unique.
  const objs = allObjects(doc);
  const sectionObjs = objs.filter((o): o is SectionObject => o.type === 'section');
  const nodes = new Map<string, SectionNode>();
  for (const s of sectionObjs) {
    const logicalId = s.logicalSectionId ?? s.id;
    const existing = nodes.get(logicalId);
    if (existing) {
      // Validation owns disagreement reporting; keep the first component's
      // public identity deterministic if an invalid document reaches here.
      continue;
    }
    nodes.set(logicalId, {
      id: logicalId,
      label: s.displayLabel || s.label || 'Section',
      zone: s.zone,
      seatCount: 0,
      objectIds: [],
      seatLabels: [],
    });
  }
  const ungrouped: SectionNode = { id: UNGROUPED_ID, label: 'Other seats', seatCount: 0, objectIds: [], seatLabels: [] };
  const objectToSection = new Map<string, string>();

  for (const obj of objs) {
    if (!isSeatObject(obj)) continue;
    const labels = objectSeatLabels(obj);
    if (labels.length === 0) continue;
    // Deterministically generated reference inventory carries durable ownership.
    // Prefer the named logical section when its geometry confirms that claim: a
    // concave GA surface can have an arithmetic centre outside its own shell,
    // while malformed provenance must not pull a truly standalone area inside.
    const referencedLogicalId = obj.referenceInventorySource?.logicalSectionId;
    const c = objectCenter(obj);
    const referencedOwner = referencedLogicalId
      ? sectionObjs.find((section) => (
          (section.logicalSectionId ?? section.id) === referencedLogicalId
          && (sameGASurfaceAsSection(obj, section) || pointInPolygonWithHoles(c, section.outline, section.holes))
        ))
      : undefined;
    // Ordinary authored inventory still uses the first drawn section (doc order)
    // whose outline contains the visual centre.
    const owner = referencedOwner ?? sectionObjs.find((s) => pointInPolygonWithHoles(c, s.outline, s.holes));
    const node = owner ? nodes.get(owner.logicalSectionId ?? owner.id)! : ungrouped;
    node.seatCount += labels.length;
    node.objectIds.push(obj.id);
    node.seatLabels.push(...labels);
    objectToSection.set(obj.id, node.id);
  }

  return {
    sections: [...nodes.values()],
    ungrouped: ungrouped.objectIds.length ? ungrouped : null,
    objectToSection,
  };
}

/** Is a drawn section hidden under `hidden` — directly, or via its zone? */
export function isSectionHidden(s: SectionObject, hidden: ReadonlySet<string>): boolean {
  return hidden.has(s.id)
    || (!!s.logicalSectionId && hidden.has(s.logicalSectionId))
    || (!!s.zone && hidden.has(s.zone));
}

/**
 * The set of seat-object ids to omit from the buyer view for a given hidden id
 * set. An object is hidden when its owning section is hidden (directly or via
 * zone), or it is ungrouped and the catch-all bucket is hidden.
 */
export function hiddenObjectIds(doc: ChartDoc, hidden: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (!hidden.size) return out;
  const { sections, ungrouped, objectToSection } = computeSections(doc);
  const hiddenSectionIds = new Set<string>();
  const zoneById = new Map(sections.map((s) => [s.id, s.zone] as const));
  for (const s of sections) {
    const zone = zoneById.get(s.id);
    if (hidden.has(s.id) || (zone && hidden.has(zone))) hiddenSectionIds.add(s.id);
  }
  const ungroupedHidden = !!ungrouped && hidden.has(UNGROUPED_ID);
  for (const [objId, secId] of objectToSection) {
    if (hiddenSectionIds.has(secId) || (ungroupedHidden && secId === UNGROUPED_ID)) out.add(objId);
  }
  return out;
}

/**
 * A copy of the doc with hidden sections' member objects removed, plus the
 * hidden section overlays themselves (so no empty block renders). Returns the
 * SAME reference when nothing is hidden — callers can skip a re-render on `===`.
 */
export function applyHidden(doc: ChartDoc, hidden: ReadonlySet<string>): ChartDoc {
  if (!hidden.size) return doc;
  const hide = hiddenObjectIds(doc, hidden);
  const hiddenSet = hidden instanceof Set ? hidden : new Set(hidden);
  const keep = (o: ChartObject): boolean => {
    if (hide.has(o.id)) return false;
    if (o.type === 'section' && isSectionHidden(o, hiddenSet)) return false;
    return true;
  };
  // Multi-floor (Batch 5): filter each floor + the floor-0 mirror.
  if (doc.floors && doc.floors.length) {
    let changed = false;
    const floors = doc.floors.map((f) => {
      const objects = f.objects.filter(keep);
      if (objects.length !== f.objects.length) changed = true;
      return objects.length === f.objects.length ? f : { ...f, objects };
    });
    if (!changed) return doc;
    return { ...doc, floors, objects: floors[0].objects };
  }
  const objects = doc.objects.filter(keep);
  if (objects.length === doc.objects.length) return doc;
  return { ...doc, objects };
}
