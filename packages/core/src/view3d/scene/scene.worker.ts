import type { ChartDoc, ExpandedSeat } from '../../core/types';
import { buildSceneModel, type SceneModel } from './sceneModel';

interface SceneWorkerRequest {
  doc: ChartDoc;
  seats: ExpandedSeat[];
  eventConfigurationId?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<SceneWorkerRequest>) => void) | null;
  postMessage(message: { model: SceneModel; buildMs: number }, transfer: Transferable[]): void;
}

function transferables(model: SceneModel): Transferable[] {
  const arrays = [
    model.solids.position, model.solids.normal, model.solids.color, model.solids.floor,
    model.seats.iPosition, model.seats.iState, model.seats.iCategory,
    model.seats.iMaxRadius, model.seats.iRing, model.seats.iFloor,
    model.seats.iYaw, model.seats.iChairWidth, model.seats.iPhysicalSeat,
  ];
  return arrays.map((array) => array.buffer as ArrayBuffer);
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (event) => {
  const started = performance.now();
  const model = buildSceneModel({
    doc: event.data.doc,
    seats: event.data.seats,
    eventConfigurationId: event.data.eventConfigurationId,
  });
  scope.postMessage({ model, buildMs: performance.now() - started }, transferables(model));
};
