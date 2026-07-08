/**
 * @seatlayer/core — the shared, framework-agnostic seat-rendering engine.
 *
 * Pure TypeScript + Konva (HTML canvas). No React, no framework. This is the
 * brain shared by the SeatLayer dashboard and every SDK wrapper. It is synced
 * byte-for-byte from the main app via `scripts/sync-core.mjs` until the app
 * migrates to consume this package directly.
 */
export * from './core/types';
export * from './core/layout';
export * from './engine/SeatmapRenderer';
export * from './picker/PickerController';
