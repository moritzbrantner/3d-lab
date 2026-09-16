"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createEditorScene } from "@/lib/scene-editor";
import {
  canRedoEditorCommand,
  canUndoEditorCommand,
  commitMeshTopology,
  createEditorCommandLog,
  redoEditorCommand,
  undoEditorCommand,
  type EditorCommandLog,
} from "@/lib/scene-editor-history";
import {
  nearestTriangleEdge,
  topologyStructuralBudgetViolations,
  type MeshEdge,
  type MeshTopologyOperation,
  type MeshTopologyWorkObservations,
} from "@/lib/scene-editor-topology";
import type { IndexedMesh, Vec3 } from "@/lib/mesh";
import styles from "./scene-topology-lab.module.css";

type SelectionMode = "face" | "edge";

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  meshObject: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  highlight: THREE.Object3D | null;
  resizeObserver: ResizeObserver;
  frameId: number;
};

function geometryFromMesh(mesh: IndexedMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
  geometry.setIndex([...mesh.indices]);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function triangleIndices(mesh: IndexedMesh, triangleIndex: number): readonly [number, number, number] | null {
  const start = triangleIndex * 3;
  if (start < 0 || start + 2 >= mesh.indices.length) return null;
  return [mesh.indices[start], mesh.indices[start + 1], mesh.indices[start + 2]];
}

function localPoint(value: THREE.Vector3): Vec3 {
  return [value.x, value.y, value.z];
}

function disposeHighlight(highlight: THREE.Object3D | null): void {
  if (!highlight) return;
  highlight.removeFromParent();
  if (highlight instanceof THREE.Line) {
    highlight.geometry.dispose();
    highlight.material.dispose();
  } else if (highlight instanceof THREE.Mesh) {
    highlight.geometry.dispose();
    const materials = Array.isArray(highlight.material) ? highlight.material : [highlight.material];
    materials.forEach((material) => material.dispose());
  }
}

function faceHighlight(mesh: IndexedMesh, triangleIndex: number): THREE.Mesh | null {
  const triangle = triangleIndices(mesh, triangleIndex);
  if (!triangle) return null;
  const vertices = triangle.map((index) => mesh.vertices[index]);
  if (vertices.some((vertex) => !vertex)) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices.flat(), 3));
  geometry.setIndex([0, 1, 2]);
  const material = new THREE.MeshBasicMaterial({
    color: 0x68a7ff,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const highlight = new THREE.Mesh(geometry, material);
  highlight.renderOrder = 5;
  return highlight;
}

function edgeHighlight(mesh: IndexedMesh, edge: MeshEdge): THREE.Line | null {
  const a = mesh.vertices[edge[0]];
  const b = mesh.vertices[edge[1]];
  if (!a || !b) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b], 3));
  const material = new THREE.LineBasicMaterial({ color: 0xdce8ff, depthTest: false });
  const highlight = new THREE.Line(geometry, material);
  highlight.renderOrder = 6;
  return highlight;
}

function latestTopologyObservation(log: EditorCommandLog): {
  observations: MeshTopologyWorkObservations;
  operation: MeshTopologyOperation;
} | null {
  if (log.cursor === 0) return null;
  const command = log.entries[log.cursor - 1];
  if (command.kind !== "edit-mesh-topology") return null;
  return { observations: command.observations, operation: command.operation };
}

export function SceneTopologyLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const meshRef = useRef<IndexedMesh | null>(null);
  const selectionModeRef = useRef<SelectionMode>("face");
  const [history, setHistory] = useState<EditorCommandLog>(() => createEditorCommandLog(createEditorScene()));
  const [selectedNodeId, setSelectedNodeId] = useState("body");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("face");
  const [selectedFace, setSelectedFace] = useState<number | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<MeshEdge | null>(null);
  const [insetRatio, setInsetRatio] = useState(0.25);
  const [extrudeDistance, setExtrudeDistance] = useState(0.25);

  const meshNodes = history.scene.nodes.filter((node) => node.mesh);
  const selectedNode = meshNodes.find((node) => node.id === selectedNodeId) ?? meshNodes[0];
  const selectedMesh = selectedNode?.mesh ?? null;
  meshRef.current = selectedMesh;
  selectionModeRef.current = selectionMode;

  const latest = latestTopologyObservation(history);
  const budgetViolations = latest
    ? topologyStructuralBudgetViolations(latest.operation, latest.observations)
    : [];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    camera.position.set(3.4, 2.7, 4.2);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);
    controls.update();

    scene.add(new THREE.HemisphereLight(0xdce8ff, 0x20283a, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.1);
    key.position.set(4, 6, 5);
    scene.add(key);
    const grid = new THREE.GridHelper(8, 16, 0x53627a, 0x263243);
    grid.position.y = -1.1;
    scene.add(grid);

    const material = new THREE.MeshStandardMaterial({ color: 0xaebbc9, roughness: 0.72, metalness: 0.06 });
    const meshObject = new THREE.Mesh(new THREE.BufferGeometry(), material);
    scene.add(meshObject);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (event: MouseEvent) => {
      const mesh = meshRef.current;
      if (!mesh) return;
      const bounds = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(meshObject, false)[0];
      if (!hit || hit.faceIndex == null) {
        setSelectedFace(null);
        setSelectedEdge(null);
        return;
      }
      if (selectionModeRef.current === "face") {
        setSelectedFace(hit.faceIndex);
        setSelectedEdge(null);
        return;
      }
      const point = meshObject.worldToLocal(hit.point.clone());
      setSelectedEdge(nearestTriangleEdge(mesh, hit.faceIndex, localPoint(point)));
      setSelectedFace(null);
    };
    canvas.addEventListener("click", pick);

    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    let frameId = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(render);
      if (runtimeRef.current) runtimeRef.current.frameId = frameId;
    };
    runtimeRef.current = {
      renderer,
      scene,
      camera,
      controls,
      meshObject,
      highlight: null,
      resizeObserver,
      frameId,
    };
    render();

    return () => {
      canvas.removeEventListener("click", pick);
      cancelAnimationFrame(runtimeRef.current?.frameId ?? frameId);
      resizeObserver.disconnect();
      controls.dispose();
      disposeHighlight(runtimeRef.current?.highlight ?? null);
      meshObject.geometry.dispose();
      material.dispose();
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !selectedMesh) return;
    const nextGeometry = geometryFromMesh(selectedMesh);
    const previousGeometry = runtime.meshObject.geometry;
    runtime.meshObject.geometry = nextGeometry;
    previousGeometry.dispose();
  }, [selectedMesh]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !selectedMesh) return;
    disposeHighlight(runtime.highlight);
    const highlight =
      selectedFace !== null
        ? faceHighlight(selectedMesh, selectedFace)
        : selectedEdge
          ? edgeHighlight(selectedMesh, selectedEdge)
          : null;
    if (highlight) runtime.meshObject.add(highlight);
    runtime.highlight = highlight;
  }, [selectedMesh, selectedFace, selectedEdge]);

  const clearSelection = () => {
    setSelectedFace(null);
    setSelectedEdge(null);
  };

  const applySplit = () => {
    if (!selectedEdge || !selectedNode) return;
    setHistory((log) =>
      commitMeshTopology(log, selectedNode.id, { kind: "split-edge", edge: selectedEdge }),
    );
    clearSelection();
  };

  const applyInset = () => {
    if (selectedFace === null || !selectedNode) return;
    setHistory((log) =>
      commitMeshTopology(log, selectedNode.id, { kind: "inset-face", triangleIndex: selectedFace, ratio: insetRatio }),
    );
    clearSelection();
  };

  const applyExtrude = () => {
    if (selectedFace === null || !selectedNode) return;
    setHistory((log) =>
      commitMeshTopology(log, selectedNode.id, {
        kind: "extrude-face",
        triangleIndex: selectedFace,
        distance: extrudeDistance,
      }),
    );
    clearSelection();
  };

  const runUndo = () => {
    setHistory((log) => undoEditorCommand(log));
    clearSelection();
  };

  const runRedo = () => {
    setHistory((log) => redoEditorCommand(log));
    clearSelection();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const undo = key === "z" && !event.shiftKey;
    const redo = (key === "z" && event.shiftKey) || key === "y";
    if (!undo && !redo) return;
    event.preventDefault();
    event.stopPropagation();
    if (undo) runUndo();
    else runRedo();
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="topology-editor-heading"
      tabIndex={-1}
      onPointerDown={(event) => event.currentTarget.focus()}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.heading}>
        <p className="eyebrow">Topology authoring</p>
        <h2 id="topology-editor-heading">Select a face or edge, then change only that bounded patch.</h2>
        <p>
          Split, inset, and extrude operate on the format-neutral indexed mesh and enter the same deterministic undo/redo
          log as transform and vertex edits. Selection and rendering stay downstream of those semantics.
        </p>
      </div>

      <div className={styles.workspace}>
        <div className={styles.viewport}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarGroup}>
              <select
                aria-label="Topology mesh"
                value={selectedNode?.id ?? ""}
                onChange={(event) => {
                  setSelectedNodeId(event.target.value);
                  clearSelection();
                }}
              >
                {meshNodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
              <div className={styles.modeRow} aria-label="Topology selection mode">
                {(["face", "edge"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`${styles.button} ${selectionMode === mode ? styles.buttonActive : ""}`}
                    onClick={() => {
                      setSelectionMode(mode);
                      clearSelection();
                    }}
                    aria-pressed={selectionMode === mode}
                  >
                    {mode === "face" ? "Face select" : "Edge select"}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.actionRow}>
              <button type="button" className={styles.button} onClick={runUndo} disabled={!canUndoEditorCommand(history)}>
                Undo
              </button>
              <button type="button" className={styles.button} onClick={runRedo} disabled={!canRedoEditorCommand(history)}>
                Redo
              </button>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            tabIndex={0}
            aria-label="Topology editor viewport. Orbit the mesh and click a face or edge to select it."
          />
          <p className={styles.hint}>Drag to orbit, scroll to zoom, then click the mesh in the active selection mode.</p>
        </div>

        <aside className={styles.panel}>
          <h3>Bounded operation</h3>
          <p className={styles.selection}>
            {selectedFace !== null
              ? `face ${selectedFace}`
              : selectedEdge
                ? `edge ${selectedEdge[0]}:${selectedEdge[1]}`
                : `no ${selectionMode} selected`}
          </p>

          {selectionMode === "edge" ? (
            <button type="button" className={styles.button} onClick={applySplit} disabled={!selectedEdge}>
              Split selected edge
            </button>
          ) : (
            <>
              <label className={styles.field}>
                Inset ratio
                <input
                  className={styles.numberInput}
                  type="number"
                  min={0.05}
                  max={0.9}
                  step={0.05}
                  value={insetRatio}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) setInsetRatio(value);
                  }}
                />
              </label>
              <button type="button" className={styles.button} onClick={applyInset} disabled={selectedFace === null}>
                Inset selected face
              </button>
              <label className={styles.field}>
                Extrude distance
                <input
                  className={styles.numberInput}
                  type="number"
                  min={0.001}
                  max={10}
                  step={0.05}
                  value={extrudeDistance}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) setExtrudeDistance(value);
                  }}
                />
              </label>
              <button type="button" className={styles.button} onClick={applyExtrude} disabled={selectedFace === null}>
                Extrude selected face
              </button>
            </>
          )}

          <p className={styles.observations}>
            {latest
              ? `${latest.operation.kind}: ${latest.observations.createdVertexCount} vertices created, ${latest.observations.affectedTriangleCount} source triangle(s) affected, ${latest.observations.indexValuesWritten / 3} replacement triangle(s) written, ${latest.observations.indexValuesCopied} unchanged index values copied, ${latest.observations.topologyIndexTriangleVisits} adjacency triangle visits (${latest.observations.topologyIndexBuildCount} full build). Structural budget: ${budgetViolations.length === 0 ? "within bound" : budgetViolations.join(", ")}.`
              : "No topology operation has been committed yet. Structural work observations will appear here after the first edit."}
          </p>

          <p className={styles.boundary}>
            <strong>Performance boundary.</strong> Topology mutation stays on persistent typed-array chunks. Edge adjacency is
            derived lazily once and then carried forward by scanning only replaced chunks; contiguous mesh materialization is
            reserved for renderer/export/validation consumers that actually require it.
          </p>
        </aside>
      </div>
    </section>
  );
}