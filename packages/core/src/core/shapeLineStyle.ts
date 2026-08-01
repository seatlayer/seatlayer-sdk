import type {
  ShapeLineCap,
  ShapeLineEnding,
  ShapeLineJoin,
  ShapeObject,
} from './types';

export const SHAPE_LINE_CAPS = ['butt', 'round', 'square'] as const satisfies readonly ShapeLineCap[];
export const SHAPE_LINE_JOINS = ['miter', 'round', 'bevel'] as const satisfies readonly ShapeLineJoin[];
export const SHAPE_LINE_ENDINGS = ['none', 'arrow'] as const satisfies readonly ShapeLineEnding[];

/** These defaults match the renderer behaviour that predates persisted line styling. */
export const DEFAULT_SHAPE_LINE_CAP: ShapeLineCap = 'round';
export const DEFAULT_SHAPE_LINE_JOIN: ShapeLineJoin = 'round';
export const DEFAULT_SHAPE_LINE_ENDING: ShapeLineEnding = 'none';

export function isOpenShapeKind(kind: ShapeObject['kind']): kind is 'line' | 'polyline' {
  return kind === 'line' || kind === 'polyline';
}

/**
 * Shape kinds whose geometry is a `points[]` array, so they can be edited
 * vertex by vertex. Lives here rather than in the Designer because both the
 * controller's boundary/handle code and `controller/shapesTextDecorFacet` need
 * the same answer, and the Designer previously carried a private copy of the
 * open-shape rule alongside `isOpenShapeKind`.
 */
export function isPointShapeKind(kind: ShapeObject['kind']): kind is 'polygon' | 'line' | 'polyline' {
  return kind === 'polygon' || isOpenShapeKind(kind);
}

export function resolvedShapeLineStyle(shape: Pick<ShapeObject, 'lineCap' | 'lineJoin' | 'startEnding' | 'endEnding'>) {
  return {
    lineCap: shape.lineCap ?? DEFAULT_SHAPE_LINE_CAP,
    lineJoin: shape.lineJoin ?? DEFAULT_SHAPE_LINE_JOIN,
    startEnding: shape.startEnding ?? DEFAULT_SHAPE_LINE_ENDING,
    endEnding: shape.endEnding ?? DEFAULT_SHAPE_LINE_ENDING,
  };
}

/** Keep arrowheads legible for hairlines without letting a 40-unit stroke
 * create unbounded decorations. Both renderers consume this exact contract. */
export function shapeArrowMetrics(strokeWidth: number): { pointerLength: number; pointerWidth: number } {
  return {
    pointerLength: Math.min(48, Math.max(8, strokeWidth * 3)),
    pointerWidth: Math.min(40, Math.max(8, strokeWidth * 2.25)),
  };
}
