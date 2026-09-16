import { subdividedPlane, validateMesh, type IndexedMesh } from "../web/lib/mesh";
import type { EditorNode, EditorScene } from "../web/lib/scene-editor";
import * as history from "../web/lib/scene-editor-history";
import {
  topologyStructuralBudgetViolations,
  type MeshTopologyOperation,
  type MeshTopologyWorkObservations,
} from "../web/lib/scene-editor-topology";
import {
  materializePersistentMeshTopology,
  persistentTriangleAt,
  type PersistentMeshTopology,
} from "../web/lib/scene-editor-topology-persistent";

const GRID_SEGMENTS = 96;
const AUXILIARY_NODE_COUNT = 128;
const EDGE_SPLIT_COUNT = 8;
const FACE_INSET_COUNT = 16;
const FACE_EXTRUDE_COUNT = 16;
const MESH_NODE_ID = "editable-mesh";

const historyApi = history as typeof history & {
  currentEditorTopology?: (log: history.EditorCommandLog, nodeId: string) => PersistentMeshTopology;
  currentEditorMesh?: (log: history.EditorCommandLog, nodeId: string) => IndexedMesh;
};

function identityTransform() {
  return {
    translation: [0, 0, 0] as const,
    rotation: [0, 0, 0] as const,
    scale: [1, 1, 1] as const,
  };
}

function createWorkloadScene(): EditorScene {
  const nodes: EditorNode[] = [{ id: "root", name: "Root", parent: null, transform: identityTransform() }];
  for (let index = 0; index < AUXILIARY_NODE_COUNT; index += 1) {
    nodes.push({
      id: `helper-${index}`,
      name: `Helper ${index}`,
      parent: "root",
      transform: {
        translation: [index * 0.001, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
  }
  nodes.push({
    id: MESH_NODE_ID,
    name: "Editable topology mesh",
    parent: "root",
    transform: identityTransform(),
    mesh: subdividedPlane(GRID_SEGMENTS),
  });
  return { nodes };
}

function meshFromScene(scene: EditorScene): IndexedMesh {
  const mesh = scene.nodes.find((node) => node.id === MESH_NODE_ID)?.mesh;
  if (!mesh) throw new Error("topology workload lost its mesh");
  return mesh;
}

function currentMesh(log: history.EditorCommandLog): IndexedMesh {
  return historyApi.currentEditorMesh?.(log, MESH_NODE_ID) ?? meshFromScene(log.scene);
}

function currentTopology(log: history.EditorCommandLog): PersistentMeshTopology | null {
  return historyApi.currentEditorTopology?.(log, MESH_NODE_ID) ?? null;
}

function checksumMesh(mesh: IndexedMesh): number {
  let value = 0;
  for (let index = 0; index < mesh.vertices.length; index += 1) {
    const vertex = mesh.vertices[index];
    value += vertex[0] * 3 + vertex[1] * 5 + vertex[2] * 7 + index * 0.000001;
  }
  for (let index = 0; index < mesh.indices.length; index += 1) {
    value += mesh.indices[index] * ((index % 13) + 1) * 0.00000001;
  }
  return Number(value.toFixed(6));
}

type WorkTotals = {
  createdVertices: number;
  affectedTriangles: number;
  indexValuesCopied: number;
  indexValuesWritten: number;
  vertexReferencesCopied: number;
  authoredAttributeReferencesCopied: number;
  authoredAttributeValuesCreated: number;
  topologyIndexBuildCount: number;
  topologyIndexTriangleVisits: number;
  materializationCount: number;
  materializedVertexReferences: number;
  materializedIndexValues: number;
};

const totals: WorkTotals = {
  createdVertices: 0,
  affectedTriangles: 0,
  indexValuesCopied: 0,
  indexValuesWritten: 0,
  vertexReferencesCopied: 0,
  authoredAttributeReferencesCopied: 0,
  authoredAttributeValuesCreated: 0,
  topologyIndexBuildCount: 0,
  topologyIndexTriangleVisits: 0,
  materializationCount: 0,
  materializedVertexReferences: 0,
  materializedIndexValues: 0,
};

function addObservations(operation: MeshTopologyOperation, observations: MeshTopologyWorkObservations): void {
  const violations = topologyStructuralBudgetViolations(operation, observations);
  if (violations.length > 0) throw new Error(`topology structural budget failed: ${violations.join("; ")}`);
  totals.createdVertices += observations.createdVertexCount;
  totals.affectedTriangles += observations.affectedTriangleCount;
  totals.indexValuesCopied += observations.indexValuesCopied;
  totals.indexValuesWritten += observations.indexValuesWritten;
  totals.vertexReferencesCopied += observations.vertexReferencesCopied;
  totals.authoredAttributeReferencesCopied += observations.authoredAttributeReferencesCopied;
  totals.authoredAttributeValuesCreated += observations.authoredAttributeValuesCreated;
  totals.topologyIndexBuildCount += observations.topologyIndexBuildCount;
  totals.topologyIndexTriangleVisits += observations.topologyIndexTriangleVisits;
}

function addLatestObservation(log: history.EditorCommandLog, expectedKind: MeshTopologyOperation["kind"]): void {
  const command = log.entries[log.cursor - 1];
  if (command.kind !== "edit-mesh-topology" || command.operation.kind !== expectedKind) {
    throw new Error(`${expectedKind} did not create the expected topology command`);
  }
  addObservations(command.operation, command.observations);
}

function materializeForBoundary(log: history.EditorCommandLog): IndexedMesh {
  const topology = currentTopology(log);
  if (!topology) return currentMesh(log);
  const materialized = materializePersistentMeshTopology(topology);
  totals.materializationCount += 1;
  totals.materializedVertexReferences += materialized.observations.vertexReferencesCopied;
  totals.materializedIndexValues += materialized.observations.indexValuesCopied;
  return materialized.mesh;
}

function triangleCount(log: history.EditorCommandLog): number {
  return currentTopology(log)?.triangleCount ?? currentMesh(log).indices.length / 3;
}

function edgeAt(log: history.EditorCommandLog, triangleIndex: number): readonly [number, number] {
  const topology = currentTopology(log);
  if (topology) {
    const triangle = persistentTriangleAt(topology, triangleIndex);
    return [triangle[0], triangle[1]] as const;
  }
  const mesh = currentMesh(log);
  const start = triangleIndex * 3;
  return [mesh.indices[start], mesh.indices[start + 1]] as const;
}

const initialScene = createWorkloadScene();
const initialMesh = meshFromScene(initialScene);
const initialChecksum = checksumMesh(initialMesh);
let log = history.createEditorCommandLog(initialScene);

for (let round = 0; round < EDGE_SPLIT_COUNT; round += 1) {
  const splitTriangle = (round * 997 + 17) % triangleCount(log);
  log = history.commitMeshTopology(log, MESH_NODE_ID, {
    kind: "split-edge",
    edge: edgeAt(log, splitTriangle),
  });
  addLatestObservation(log, "split-edge");

  for (let local = 0; local < 2; local += 1) {
    const edit = round * 2 + local;
    const insetTriangle = (edit * 613 + 31) % triangleCount(log);
    log = history.commitMeshTopology(log, MESH_NODE_ID, {
      kind: "inset-face",
      triangleIndex: insetTriangle,
      ratio: 0.22,
    });
    addLatestObservation(log, "inset-face");

    const extrudeTriangle = (edit * 431 + 47) % triangleCount(log);
    log = history.commitMeshTopology(log, MESH_NODE_ID, {
      kind: "extrude-face",
      triangleIndex: extrudeTriangle,
      distance: 0.035,
    });
    addLatestObservation(log, "extrude-face");
  }
}

const operationCount = EDGE_SPLIT_COUNT + FACE_INSET_COUNT + FACE_EXTRUDE_COUNT;
const finalMesh = materializeForBoundary(log);
validateMesh(finalMesh);
const finalChecksum = checksumMesh(finalMesh);

for (let index = 0; index < operationCount; index += 1) log = history.undoEditorCommand(log);
const undoneMesh = materializeForBoundary(log);
if (
  undoneMesh.vertices.length !== initialMesh.vertices.length ||
  undoneMesh.indices.length !== initialMesh.indices.length ||
  checksumMesh(undoneMesh) !== initialChecksum
) {
  throw new Error("topology undo round-trip did not restore the initial mesh");
}

for (let index = 0; index < operationCount; index += 1) log = history.redoEditorCommand(log);
const redoneMesh = materializeForBoundary(log);
if (checksumMesh(redoneMesh) !== finalChecksum) throw new Error("topology redo round-trip changed the final mesh");

console.log(
  JSON.stringify({
    semantic: {
      nodeCount: log.scene.nodes.length,
      initialVertexCount: initialMesh.vertices.length,
      initialTriangleCount: initialMesh.indices.length / 3,
      finalVertexCount: finalMesh.vertices.length,
      finalTriangleCount: finalMesh.indices.length / 3,
      edgeSplitCount: EDGE_SPLIT_COUNT,
      faceInsetCount: FACE_INSET_COUNT,
      faceExtrudeCount: FACE_EXTRUDE_COUNT,
      historyEntryCount: log.entries.length,
      historyCursor: log.cursor,
      undoCount: operationCount,
      redoCount: operationCount,
      initialChecksum,
      finalChecksum,
    },
    work: totals,
  }),
);