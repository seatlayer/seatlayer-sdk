/**
 * The DOM half of venue labels: one absolutely-positioned element per visible
 * label, repositioned from projected 3D anchors as the camera moves.
 *
 * Kept out of `index.ts` so the render loop stays about rendering, and out of
 * `labels.ts` so the anchor/LOD logic stays pure and testable.
 *
 * ## Accessibility
 *
 * These are real DOM text nodes, which is the point. A screen reader can read the
 * venue's structure — zones, sections, booth names — where a GPU-drawn glyph is
 * invisible to it. The overlay itself is `aria-hidden` only for the decorative
 * pointer-events layer; the labels are a live region-free list of static text,
 * announced in document order.
 *
 * Pointer events pass straight through: a label must never eat a seat tap.
 */

import {
  DENSE_LABEL_BUDGET, cullOverlapping, focusScore, pickDenseLabels, projectToScreen,
  visibleLabelKinds, type SceneLabel,
} from './labels';

/**
 * Minimum gap before the farther label is dropped, CSS px — wide and short,
 * matching the shape of a line of text rather than a disc around it.
 */
const SEPARATION_X_PX = 88;
const SEPARATION_Y_PX = 20;

/** Per-kind styling. Sizes are CSS px at a nominal viewport. */
const KIND_STYLE: Record<SceneLabel['kind'], { size: number; weight: string; opacity: number }> = {
  zone: { size: 15, weight: '600', opacity: 0.95 },
  section: { size: 12, weight: '500', opacity: 0.88 },
  ga: { size: 12, weight: '500', opacity: 0.88 },
  booth: { size: 11, weight: '500', opacity: 0.85 },
  annotation: { size: 11, weight: '400', opacity: 0.75 },
  // Row and seat identity are quieter than the structure they sit inside: at
  // this range the venue is already understood and the label is a detail, so it
  // must not compete with the seating it is printed over.
  row: { size: 10.5, weight: '600', opacity: 0.8 },
  seat: { size: 9.5, weight: '500', opacity: 0.72 },
};

/**
 * Per-kind declutter spacing, CSS px. Seat and row labels are short strings sat
 * on a tight grid, so the wide section-name box would throw away almost all of
 * them — a row of seat numbers needs to survive side by side.
 */
const DENSE_KINDS = new Set<SceneLabel['kind']>(['row', 'seat']);
/**
 * Per-kind, because the two are different shapes of text. A seat number is 1–3
 * characters and wants to survive shoulder to shoulder along a row; a row name
 * is a word ("ORCH-L") and needs roughly twice the width before the next one is
 * legible. One shared value crowded the row names into each other.
 */
const DENSE_SEPARATION: Record<'row' | 'seat', { x: number; y: number }> = {
  row: { x: 62, y: 16 },
  // Widened from 24: at close range seat labels stopped overlapping at all, so
  // the separation had no work left to do and the budget was carrying the whole
  // load. A wider box means the few labels that ARE kept are spread across the
  // seating instead of clustering into one stack.
  seat: { x: 46, y: 18 },
};

export interface LabelOverlayOptions {
  /** `ChartTheme.fontFamily`, when the chart authors one. */
  fontFamily?: string;
  /** Ink colour for labels that carry no authored colour. */
  ink?: string;
}

export class LabelOverlay {
  private root: HTMLDivElement;
  private nodes = new Map<string, HTMLDivElement>();
  private labels: SceneLabel[] = [];
  private opts: LabelOverlayOptions;
  private forcedDense = false;

  constructor(container: HTMLElement, opts: LabelOverlayOptions = {}) {
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.setAttribute('data-view3d-labels', '');
    const s = this.root.style;
    s.position = 'absolute';
    s.inset = '0';
    // Never intercept a seat tap — the canvas below owns all pointer input.
    s.pointerEvents = 'none';
    s.overflow = 'hidden';
    if (opts.fontFamily) s.fontFamily = opts.fontFamily;
    container.appendChild(this.root);
  }

  /**
   * Hide or show the whole overlay without disturbing which labels exist.
   *
   * The in-scene panorama sphere is GL, so it draws BEHIND every DOM label —
   * row and seat labels floated on top of a 360 photo until this existed. The
   * old DOM panorama never needed it because its opaque div covered them.
   *
   * Deliberately not `setLabels([])`: that destroys the nodes and the declutter
   * state, so closing the panorama would rebuild and re-rank the whole overlay
   * and flash. Visibility is a view concern, not a data one.
   */
  setVisible(visible: boolean): void {
    this.root.style.visibility = visible ? '' : 'hidden';
  }

  setLabels(labels: SceneLabel[]): void {
    this.labels = labels;
    for (const [id, node] of this.nodes) {
      if (!labels.some((l) => l.id === id)) { node.remove(); this.nodes.delete(id); }
    }
  }

  /** Section/row drill-in makes their dense labels explicit, regardless of the
   * whole-venue distance heuristic used during free orbit. */
  setForcedDense(enabled: boolean): void {
    this.forcedDense = enabled;
  }

  /**
   * Reposition every label for the current camera.
   *
   * `viewProjection` is column-major, as OGL supplies it.
   */
  update(
    viewProjection: ArrayLike<number>,
    width: number,
    height: number,
    cameraDistance: number,
    venueRadius: number,
    /**
     * Camera world position, for ranking the dense rungs by real distance.
     * Optional so callers that only need structure labels need not supply it;
     * without it the dense rungs fall back to ranking by screen centre alone.
     */
    cameraWorld?: readonly [number, number, number],
  ): void {
    if (!this.labels.length) return;
    const kinds = visibleLabelKinds(cameraDistance, venueRadius);
    if (this.forcedDense) {
      kinds.add('row');
      kinds.add('seat');
    }

    const candidates: Array<{
      label: SceneLabel;
      screen: ReturnType<typeof projectToScreen>;
      focus: number;
    }> = [];
    for (const label of this.labels) {
      if (!kinds.has(label.kind)) continue;
      const screen = projectToScreen(viewProjection, label.anchor, width, height);
      if (!screen.visible) continue;
      const world = cameraWorld
        ? Math.hypot(
          label.anchor[0] - cameraWorld[0],
          label.anchor[1] - cameraWorld[1],
          label.anchor[2] - cameraWorld[2],
        )
        : 1;
      candidates.push({ label, screen, focus: focusScore(screen, world, width, height) });
    }

    // Nearest-wins declutter, then paint. Everything not kept is hidden rather
    // than removed, so a small camera move does not thrash the DOM. Dense kinds
    // declutter against their OWN spacing and separately from the structure
    // labels, so a section name never suppresses the seat numbers under it.
    const structure = candidates.filter((c) => !DENSE_KINDS.has(c.label.kind));
    const kept = [
      ...cullOverlapping(structure, SEPARATION_X_PX, SEPARATION_Y_PX),
      // The dense rungs are BUDGETED, not merely deduplicated — see
      // DENSE_LABEL_BUDGET for why the overlap test alone gets worse the closer
      // the camera gets.
      ...(['row', 'seat'] as const).flatMap((kind) => pickDenseLabels(
        candidates.filter((c) => c.label.kind === kind),
        DENSE_SEPARATION[kind].x,
        DENSE_SEPARATION[kind].y,
        DENSE_LABEL_BUDGET[kind],
      )),
    ];
    const keptIds = new Set(kept.map((k) => k.label.id));

    for (const { label, screen } of kept) {
      const node = this.nodeFor(label);
      const st = node.style;
      st.display = '';
      st.transform = `translate(-50%, -50%) translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
    }
    for (const [id, node] of this.nodes) {
      if (!keptIds.has(id)) node.style.display = 'none';
    }
  }

  private nodeFor(label: SceneLabel): HTMLDivElement {
    let node = this.nodes.get(label.id);
    if (node) return node;
    node = document.createElement('div');
    node.textContent = label.text;
    node.setAttribute('data-label-kind', label.kind);
    const style = KIND_STYLE[label.kind];
    const s = node.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.whiteSpace = 'nowrap';
    s.fontSize = `${style.size}px`;
    s.fontWeight = style.weight;
    s.opacity = String(style.opacity);
    s.color = label.color ?? this.opts.ink ?? '#e8edf5';
    // A soft dark halo keeps a label legible over both a pale deck and the dark
    // background, without a plate that would clutter a dense venue.
    s.textShadow = '0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.55)';
    s.letterSpacing = label.kind === 'zone' ? '0.08em' : '0.02em';
    if (label.kind === 'zone') s.textTransform = 'uppercase';
    s.display = 'none';
    this.root.appendChild(node);
    this.nodes.set(label.id, node);
    return node;
  }

  dispose(): void {
    this.root.remove();
    this.nodes.clear();
  }
}
