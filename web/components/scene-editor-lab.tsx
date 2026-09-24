"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  childrenOf,
  createEditorScene,
  type EditableTransform,
  type EditorNode,
  type EditorScene,
} from "@/lib/scene-editor";
import {
  parseEditorSceneSnapshot,
  serializeEditorSceneSnapshot,
  validateEditorSceneSnapshotFileSize,
} from "@/lib/scene-editor-snapshot";
import {
  effectiveEditorGizmoMode,
  effectiveEditorGizmoSpace,
  type EditorGizmoMode,
  type EditorGizmoSpace,
} from "@/lib/scene-editor-gizmo";
import {
  canRedoEditorCommand,
  canUndoEditorCommand,
  commitMeshVertex,
  commitNodeTransform,
  createEditorCommandLog,
  materializeEditorCommandLog,
  redoEditorCommand,
  undoEditorCommand,
  type EditorCommandLog,
} from "@/lib/scene-editor-history";
import { shouldSelectVertexHit } from "@/lib/scene-editor-picking";
import type { Vec3 } from "@/lib/mesh";
import styles from "./scene-editor-lab.module.css";

type Axis = 0 | 1 | 2;

type GizmoTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "vertex"; nodeId: string; vertexIndex: number };

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  transformControls: TransformControls;
  transformHelper: THREE.Object3D;
  gizmoAnchor: THREE.Object3D;
  objects: Map<string, THREE.Object3D>;
  vertexPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null;
  resizeObserver: ResizeObserver;
  frameId: number;
};

const AXES: readonly [label: string, axis: Axis][] = [
  ["X", 0],
  ["Y", 1],
  ["Z", 2],
];

const GIZMO_MODES: readonly EditorGizmoMode[] = ["translate", "rotate", "scale"];
const GIZMO_SPACES: readonly EditorGizmoSpace[] = ["local", "world"];

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function mutableVec3(value: Vec3): [number, number, number] {
  return [value[0], value[1], value[2]];
}

function vectorFromThree(value: THREE.Vector3): Vec3 {
  return [value.x, value.y, value.z];
}

function transformFromObject(object: THREE.Object3D): EditableTransform {
  return {
    translation: vectorFromThree(object.position),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: vectorFromThree(object.scale),
  };
}

function createGeometry(node: EditorNode): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  if (!node.mesh) return geometry;
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(node.mesh.vertices.flat(), 3));
  geometry.setIndex([...node.mesh.indices]);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function previewVertexPosition(runtime: Runtime, target: Extract<GizmoTarget, { kind: "vertex" }>, position: Vec3): void {
  const object = runtime.objects.get(target.nodeId);
  if (!(object instanceof THREE.Mesh)) return;
  const positionAttribute = object.geometry.getAttribute("position") as THREE.BufferAttribute;
  if (target.vertexIndex < 0 || target.vertexIndex >= positionAttribute.count) return;
  positionAttribute.setXYZ(target.vertexIndex, position[0], position[1], position[2]);
  positionAttribute.needsUpdate = true;
  object.geometry.computeVertexNormals();
  object.geometry.computeBoundingSphere();

  const points = runtime.vertexPoints;
  if (!points || points.userData.nodeId !== target.nodeId) return;
  const pointPositions = points.geometry.getAttribute("position") as THREE.BufferAttribute;
  if (target.vertexIndex < 0 || target.vertexIndex >= pointPositions.count) return;
  pointPositions.setXYZ(target.vertexIndex, position[0], position[1], position[2]);
  pointPositions.needsUpdate = true;
}

function VectorEditor({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: Vec3;
  step: number;
  onChange: (axis: Axis, value: number) => void;
}) {
  return (
    <fieldset className={styles.vectorEditor}>
      <legend>{label}</legend>
      <div className={styles.vectorGrid}>
        {AXES.map(([axisLabel, axis]) => (
          <label key={axisLabel}>
            <span>{axisLabel}</span>
            <input
              type="number"
              step={step}
              value={Number(value[axis].toFixed(3))}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) onChange(axis, next);
              }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function HierarchyTree({
  scene,
  selectedNodeId,
  onSelect,
}: {
  scene: EditorScene;
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  const renderBranch = (parent: string | null): ReactNode => {
    const children = childrenOf(scene, parent);
    if (children.length === 0) return null;
    return (
      <ul className={parent === null ? styles.treeRoot : styles.treeBranch}>
        {children.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              className={`${styles.treeNode} ${selectedNodeId === node.id ? styles.treeNodeActive : ""}`}
              onClick={() => onSelect(node.id)}
              aria-pressed={selectedNodeId === node.id}
            >
              <span className={styles.nodeKind}>{node.mesh ? "Mesh" : "Group"}</span>
              <strong>{node.name}</strong>
            </button>
            {renderBranch(node.id)}
          </li>
        ))}
      </ul>
    );
  };

  return <nav aria-label="Scene node hierarchy">{renderBranch(null)}</nav>;
}

export function SceneEditorLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const initialSceneRef = useRef<EditorScene | null>(null);
  const snapshotInputRef = useRef<HTMLInputElement>(null);
  const importRequestRef = useRef(0);
  const gizmoTargetRef = useRef<GizmoTarget | null>(null);
  const suppressPickRef = useRef(false);
  const cancelledDragRef = useRef(false);
  const [history, setHistory] = useState<EditorCommandLog>(() => {
    const scene = createEditorScene();
    initialSceneRef.current = scene;
    return createEditorCommandLog(scene);
  });
  const editorScene = history.scene;
  const [selectedNodeId, setSelectedNodeId] = useState("body");
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [showVertices, setShowVertices] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [gizmoMode, setGizmoMode] = useState<EditorGizmoMode>("translate");
  const [gizmoSpace, setGizmoSpace] = useState<EditorGizmoSpace>("local");
  const [gizmoDragging, setGizmoDragging] = useState(false);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);

  const selectedNode = useMemo(
    () => editorScene.nodes.find((node) => node.id === selectedNodeId) ?? editorScene.nodes[0],
    [editorScene, selectedNodeId],
  );
  const selectedVertex =
    selectedVertexIndex === null || !selectedNode.mesh ? null : selectedNode.mesh.vertices[selectedVertexIndex] ?? null;
  const gizmoTargetKind = selectedVertexIndex === null ? "node" : "vertex";
  const effectiveGizmoMode = effectiveEditorGizmoMode(gizmoTargetKind, gizmoMode);
  const effectiveGizmoSpace = effectiveEditorGizmoSpace(effectiveGizmoMode, gizmoSpace);

  useEffect(() => {
    const canvas = canvasRef.current;
    const initialScene = initialSceneRef.current;
    if (!canvas || !initialScene) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    camera.position.set(4.2, 3.1, 5.4);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 0.2, 0);
    controls.update();

    const transformControls = new TransformControls(camera, canvas);
    const transformHelper = transformControls.getHelper();
    scene.add(transformHelper);
    const gizmoAnchor = new THREE.Object3D();
    gizmoAnchor.name = "Selected vertex gizmo anchor";

    scene.add(new THREE.HemisphereLight(0xdce8ff, 0x20283a, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.4);
    key.position.set(4, 6, 5);
    scene.add(key);

    const grid = new THREE.GridHelper(12, 24, 0x53627a, 0x263243);
    grid.position.y = -0.75;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(1.5));

    const objects = new Map<string, THREE.Object3D>();
    initialScene.nodes.forEach((node) => {
      const object = node.mesh
        ? new THREE.Mesh(
            createGeometry(node),
            new THREE.MeshStandardMaterial({ color: 0xaebbc9, roughness: 0.7, metalness: 0.08 }),
          )
        : new THREE.Group();
      object.name = node.name;
      object.userData.nodeId = node.id;
      objects.set(node.id, object);
    });
    initialScene.nodes.forEach((node) => {
      const object = objects.get(node.id);
      if (!object) return;
      const parent = node.parent ? objects.get(node.parent) : null;
      (parent ?? scene).add(object);
    });

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

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.16 };
    const pointer = new THREE.Vector2();
    const pick = (event: MouseEvent) => {
      if (suppressPickRef.current || transformControls.dragging) {
        suppressPickRef.current = false;
        return;
      }
      const bounds = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const meshes = [...objects.values()].filter((object): object is THREE.Mesh => object instanceof THREE.Mesh);
      const meshHit = raycaster.intersectObjects(meshes, false)[0];
      const runtime = runtimeRef.current;
      if (runtime?.vertexPoints) {
        const vertexHit = raycaster.intersectObject(runtime.vertexPoints, false)[0];
        if (
          vertexHit &&
          vertexHit.index !== undefined &&
          shouldSelectVertexHit(vertexHit.distance, meshHit?.distance ?? null)
        ) {
          const nodeId = runtime.vertexPoints.userData.nodeId as string;
          setSelectedNodeId(nodeId);
          setSelectedVertexIndex(vertexHit.index);
          return;
        }
      }

      if (meshHit) {
        setSelectedNodeId(meshHit.object.userData.nodeId as string);
        setSelectedVertexIndex(null);
      }
    };
    canvas.addEventListener("click", pick);

    const handleDraggingChanged = () => {
      const dragging = transformControls.dragging;
      controls.enabled = !dragging;
      setGizmoDragging(dragging);
    };
    const handleMouseDown = () => {
      cancelledDragRef.current = false;
    };
    const handleObjectChange = () => {
      const target = gizmoTargetRef.current;
      const runtime = runtimeRef.current;
      if (!runtime || target?.kind !== "vertex") return;
      previewVertexPosition(runtime, target, vectorFromThree(runtime.gizmoAnchor.position));
    };
    const handleMouseUp = () => {
      const target = gizmoTargetRef.current;
      if (!target) return;
      if (cancelledDragRef.current) {
        cancelledDragRef.current = false;
      } else if (target.kind === "node") {
        const object = objects.get(target.nodeId);
        if (object) {
          const next = transformFromObject(object);
          setHistory((log) => commitNodeTransform(log, target.nodeId, next));
        }
      } else {
        const next = vectorFromThree(gizmoAnchor.position);
        setHistory((log) => commitMeshVertex(log, target.nodeId, target.vertexIndex, next));
      }
      suppressPickRef.current = true;
      window.setTimeout(() => {
        suppressPickRef.current = false;
      }, 0);
    };
    transformControls.addEventListener("dragging-changed", handleDraggingChanged);
    transformControls.addEventListener("mouseDown", handleMouseDown);
    transformControls.addEventListener("objectChange", handleObjectChange);
    transformControls.addEventListener("mouseUp", handleMouseUp);

    let frameId = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(render);
      const runtime = runtimeRef.current;
      if (runtime) runtime.frameId = frameId;
    };

    runtimeRef.current = {
      renderer,
      scene,
      camera,
      controls,
      transformControls,
      transformHelper,
      gizmoAnchor,
      objects,
      vertexPoints: null,
      resizeObserver,
      frameId,
    };
    render();

    return () => {
      canvas.removeEventListener("click", pick);
      transformControls.removeEventListener("dragging-changed", handleDraggingChanged);
      transformControls.removeEventListener("mouseDown", handleMouseDown);
      transformControls.removeEventListener("objectChange", handleObjectChange);
      transformControls.removeEventListener("mouseUp", handleMouseUp);
      transformControls.detach();
      transformControls.dispose();
      transformHelper.removeFromParent();
      gizmoAnchor.removeFromParent();
      cancelAnimationFrame(runtimeRef.current?.frameId ?? frameId);
      resizeObserver.disconnect();
      controls.dispose();
      objects.forEach((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      const points = runtimeRef.current?.vertexPoints;
      points?.geometry.dispose();
      points?.material.dispose();
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, [runtimeRevision]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    editorScene.nodes.forEach((node) => {
      const object = runtime.objects.get(node.id);
      if (!object) return;
      object.position.set(...node.transform.translation);
      object.rotation.set(...node.transform.rotation);
      object.scale.set(...node.transform.scale);
      if (!(object instanceof THREE.Mesh) || !node.mesh) return;

      const position = object.geometry.getAttribute("position") as THREE.BufferAttribute;
      node.mesh.vertices.forEach((vertex, index) => position.setXYZ(index, vertex[0], vertex[1], vertex[2]));
      position.needsUpdate = true;
      object.geometry.computeVertexNormals();
      object.geometry.computeBoundingSphere();

      const material = object.material;
      if (material instanceof THREE.MeshStandardMaterial) {
        material.wireframe = wireframe;
        material.emissive.set(node.id === selectedNodeId ? 0x173a66 : 0x000000);
        material.emissiveIntensity = node.id === selectedNodeId ? 0.65 : 0;
      }
    });
  }, [editorScene, selectedNodeId, wireframe]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    if (runtime.vertexPoints) {
      runtime.vertexPoints.removeFromParent();
      runtime.vertexPoints.geometry.dispose();
      runtime.vertexPoints.material.dispose();
      runtime.vertexPoints = null;
    }

    if (!showVertices || !selectedNode.mesh) return;
    const selectedObject = runtime.objects.get(selectedNode.id);
    if (!selectedObject) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(selectedNode.mesh.vertices.flat(), 3));
    const colors = selectedNode.mesh.vertices.flatMap((_, index) =>
      index === selectedVertexIndex ? [0.48, 0.76, 1] : [0.92, 0.95, 1],
    );
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size: 0.13, sizeAttenuation: true, vertexColors: true });
    const points = new THREE.Points(geometry, material);
    points.userData.nodeId = selectedNode.id;
    points.renderOrder = 4;
    selectedObject.add(points);
    runtime.vertexPoints = points;
  }, [editorScene, selectedNode, selectedVertexIndex, showVertices]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const controls = runtime.transformControls;
    controls.detach();

    if (selectedVertexIndex !== null && selectedVertex && selectedNode.mesh) {
      const selectedObject = runtime.objects.get(selectedNode.id);
      if (!selectedObject) return;
      if (runtime.gizmoAnchor.parent !== selectedObject) {
        runtime.gizmoAnchor.removeFromParent();
        selectedObject.add(runtime.gizmoAnchor);
      }
      runtime.gizmoAnchor.position.set(...selectedVertex);
      runtime.gizmoAnchor.rotation.set(0, 0, 0);
      runtime.gizmoAnchor.scale.set(1, 1, 1);
      gizmoTargetRef.current = {
        kind: "vertex",
        nodeId: selectedNode.id,
        vertexIndex: selectedVertexIndex,
      };
      controls.setMode(effectiveEditorGizmoMode("vertex", gizmoMode));
      controls.setSpace(effectiveEditorGizmoSpace("translate", gizmoSpace));
      controls.attach(runtime.gizmoAnchor);
      return;
    }

    runtime.gizmoAnchor.removeFromParent();
    const selectedObject = runtime.objects.get(selectedNode.id);
    if (!selectedObject) {
      gizmoTargetRef.current = null;
      return;
    }
    gizmoTargetRef.current = { kind: "node", nodeId: selectedNode.id };
    const mode = effectiveEditorGizmoMode("node", gizmoMode);
    controls.setMode(mode);
    controls.setSpace(effectiveEditorGizmoSpace(mode, gizmoSpace));
    controls.attach(selectedObject);
  }, [selectedNode, selectedVertex, selectedVertexIndex, gizmoMode, gizmoSpace]);

  useEffect(() => {
    if (!selectedNode.mesh && selectedVertexIndex !== null) setSelectedVertexIndex(null);
  }, [selectedNode, selectedVertexIndex]);

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      const runtime = runtimeRef.current;
      if (event.key === "Escape" && runtime?.transformControls.dragging) {
        event.preventDefault();
        cancelledDragRef.current = true;
        runtime.transformControls.reset();
        return;
      }
      if (runtime?.transformControls.dragging) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const undo = key === "z" && !event.shiftKey;
      const redo = (key === "z" && event.shiftKey) || key === "y";
      if (!undo && !redo) return;
      event.preventDefault();
      setHistory((log) => (undo ? undoEditorCommand(log) : redoEditorCommand(log)));
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, []);

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedVertexIndex(null);
  };

  const updateTransformVector = (field: keyof EditableTransform, axis: Axis, value: number) => {
    setHistory((log) => {
      const node = log.scene.nodes.find((candidate) => candidate.id === selectedNodeId);
      if (!node) return log;
      const source = mutableVec3(node.transform[field]);
      source[axis] = field === "rotation" ? toRadians(value) : value;
      const patch: Partial<EditableTransform> =
        field === "translation"
          ? { translation: source }
          : field === "rotation"
            ? { rotation: source }
            : { scale: source };
      return commitNodeTransform(log, selectedNodeId, patch);
    });
  };

  const updateVertexAxis = (axis: Axis, value: number) => {
    if (selectedVertexIndex === null) return;
    setHistory((log) => {
      const node = log.scene.nodes.find((candidate) => candidate.id === selectedNodeId);
      const vertex = node?.mesh?.vertices[selectedVertexIndex];
      if (!vertex) return log;
      const next = mutableVec3(vertex);
      next[axis] = value;
      return commitMeshVertex(log, selectedNodeId, selectedVertexIndex, next);
    });
  };

  const frameSelected = () => {
    const runtime = runtimeRef.current;
    const object = runtime?.objects.get(selectedNodeId);
    if (!runtime || !object) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const distance = Math.max(size.length() * 1.35, 2.4);
    const direction = runtime.camera.position.clone().sub(runtime.controls.target);
    if (direction.lengthSq() < 0.001) direction.set(1, 0.7, 1);
    direction.normalize();
    runtime.controls.target.copy(center);
    runtime.camera.position.copy(center).addScaledVector(direction, distance);
    runtime.camera.lookAt(center);
    runtime.controls.update();
  };

  const exportSceneSnapshot = () => {
    try {
      const materialized = materializeEditorCommandLog(history).scene;
      const source = serializeEditorSceneSnapshot(materialized);
      const url = URL.createObjectURL(new Blob([source], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "3d-lab-scene.snapshot.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setSnapshotStatus(`Exported ${materialized.nodes.length} nodes.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSnapshotStatus(`Export failed: ${message}`);
    }
  };

  const importSceneSnapshot = async (file: File | null) => {
    if (!file) return;
    const requestId = importRequestRef.current + 1;
    importRequestRef.current = requestId;
    try {
      validateEditorSceneSnapshotFileSize(file.size);
      const source = await file.text();
      if (requestId !== importRequestRef.current) return;
      const scene = parseEditorSceneSnapshot(source);
      const selected = scene.nodes.find((node) => node.mesh) ?? scene.nodes[0];
      initialSceneRef.current = scene;
      setHistory(createEditorCommandLog(scene));
      setSelectedNodeId(selected.id);
      setSelectedVertexIndex(null);
      setRuntimeRevision((revision) => revision + 1);
      setSnapshotStatus(`Imported ${scene.nodes.length} nodes; undo history reset.`);
    } catch (error) {
      if (requestId !== importRequestRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setSnapshotStatus(`Import failed: ${message}`);
    } finally {
      if (requestId === importRequestRef.current && snapshotInputRef.current) {
        snapshotInputRef.current.value = "";
      }
    }
  };

  const resetScene = () => {
    importRequestRef.current += 1;
    if (snapshotInputRef.current) snapshotInputRef.current.value = "";
    const scene = createEditorScene();
    initialSceneRef.current = scene;
    setHistory(createEditorCommandLog(scene));
    setSelectedNodeId("body");
    setSelectedVertexIndex(null);
    setRuntimeRevision((revision) => revision + 1);
    setSnapshotStatus(null);
  };

  const rotationDegrees: Vec3 = [
    toDegrees(selectedNode.transform.rotation[0]),
    toDegrees(selectedNode.transform.rotation[1]),
    toDegrees(selectedNode.transform.rotation[2]),
  ];

  return (
    <section className={styles.editor} aria-labelledby="scene-editor-heading">
      <aside className={styles.hierarchyPanel}>
        <p className="eyebrow">Hierarchy</p>
        <h2 id="scene-editor-heading">Scene graph</h2>
        <p className={styles.panelCopy}>Select a node here or click a mesh in the viewport.</p>
        <HierarchyTree scene={editorScene} selectedNodeId={selectedNodeId} onSelect={selectNode} />
      </aside>

      <div className={styles.viewportPanel}>
        <div className={styles.toolbar}>
          <div>
            <p className="eyebrow">Authoring viewport</p>
            <strong>{selectedNode.name}</strong>
            {selectedVertexIndex !== null && <span> / vertex {selectedVertexIndex}</span>}
          </div>
          <div className={styles.toolbarActions}>
            {GIZMO_MODES.map((mode) => {
              const vertexBlocked = selectedVertexIndex !== null && mode !== "translate";
              return (
                <button
                  key={mode}
                  type="button"
                  className={`${styles.toolButton} ${effectiveGizmoMode === mode ? styles.toolButtonActive : ""}`}
                  onClick={() => setGizmoMode(mode)}
                  disabled={vertexBlocked || gizmoDragging}
                  aria-pressed={effectiveGizmoMode === mode}
                  title={vertexBlocked ? "Selected vertices are position-only" : `${mode} gizmo`}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              );
            })}
            {GIZMO_SPACES.map((space) => {
              const scaleBlocked = effectiveGizmoMode === "scale" && space === "world";
              return (
                <button
                  key={space}
                  type="button"
                  className={`${styles.toolButton} ${effectiveGizmoSpace === space ? styles.toolButtonActive : ""}`}
                  onClick={() => setGizmoSpace(space)}
                  disabled={scaleBlocked || gizmoDragging}
                  aria-pressed={effectiveGizmoSpace === space}
                  title={scaleBlocked ? "Scale uses local axes" : `${space} coordinate axes`}
                >
                  {space[0].toUpperCase() + space.slice(1)}
                </button>
              );
            })}
            <button
              type="button"
              className={styles.toolButton}
              onClick={() => setHistory((log) => undoEditorCommand(log))}
              disabled={!canUndoEditorCommand(history) || gizmoDragging}
              aria-keyshortcuts="Control+Z Meta+Z"
              title="Undo (Ctrl/Cmd+Z)"
            >
              Undo
            </button>
            <button
              type="button"
              className={styles.toolButton}
              onClick={() => setHistory((log) => redoEditorCommand(log))}
              disabled={!canRedoEditorCommand(history) || gizmoDragging}
              aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z"
              title="Redo (Ctrl+Y or Ctrl/Cmd+Shift+Z)"
            >
              Redo
            </button>
            <button type="button" className={styles.toolButton} onClick={frameSelected}>
              Frame selected
            </button>
            <button
              type="button"
              className={`${styles.toolButton} ${showVertices ? styles.toolButtonActive : ""}`}
              onClick={() => setShowVertices((value) => !value)}
              aria-pressed={showVertices}
            >
              Vertex handles
            </button>
            <button
              type="button"
              className={`${styles.toolButton} ${wireframe ? styles.toolButtonActive : ""}`}
              onClick={() => setWireframe((value) => !value)}
              aria-pressed={wireframe}
            >
              Wireframe
            </button>
            <button type="button" className={styles.toolButton} onClick={exportSceneSnapshot} disabled={gizmoDragging}>
              Export JSON
            </button>
            <button
              type="button"
              className={styles.toolButton}
              onClick={() => snapshotInputRef.current?.click()}
              disabled={gizmoDragging}
            >
              Import JSON
            </button>
            <input
              ref={snapshotInputRef}
              className={styles.snapshotInput}
              type="file"
              accept="application/json,.json"
              aria-label="Import scene snapshot"
              onChange={(event) => void importSceneSnapshot(event.currentTarget.files?.[0] ?? null)}
            />
            {snapshotStatus && <span className={styles.snapshotStatus} role="status">{snapshotStatus}</span>}
          </div>
        </div>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Interactive 3D scene editor with local/world transform gizmos, mesh picking, and vertex handles."
        />
        <p className={styles.viewportHint}>
          Drag the colored gizmo axes to edit the selection. Node translate/rotate support local or world axes; scale is local. Selected vertices use translation in local or world axes. One completed drag creates one undoable command; press Escape during a drag to cancel it.
        </p>
      </div>

      <aside className={styles.inspectorPanel}>
        <div className={styles.inspectorHeading}>
          <div>
            <p className="eyebrow">Inspector</p>
            <h2>{selectedNode.name}</h2>
          </div>
          <span className={styles.kindBadge}>{selectedNode.mesh ? "Mesh" : "Group"}</span>
        </div>

        <VectorEditor
          label="Translation"
          value={selectedNode.transform.translation}
          step={0.05}
          onChange={(axis, value) => updateTransformVector("translation", axis, value)}
        />
        <VectorEditor
          label="Rotation (degrees)"
          value={rotationDegrees}
          step={1}
          onChange={(axis, value) => updateTransformVector("rotation", axis, value)}
        />
        <VectorEditor
          label="Scale"
          value={selectedNode.transform.scale}
          step={0.05}
          onChange={(axis, value) => updateTransformVector("scale", axis, value)}
        />

        {selectedNode.mesh && (
          <section className={styles.vertexSection}>
            <div className={styles.vertexHeading}>
              <div>
                <span className={styles.sectionLabel}>Vertex editing</span>
                <strong>{selectedVertexIndex === null ? "Pick a handle in the viewport" : `Vertex ${selectedVertexIndex}`}</strong>
              </div>
              {selectedVertexIndex !== null && (
                <button type="button" className={styles.clearButton} onClick={() => setSelectedVertexIndex(null)}>
                  Clear
                </button>
              )}
            </div>
            {selectedVertex && (
              <VectorEditor label="Local position" value={selectedVertex} step={0.05} onChange={updateVertexAxis} />
            )}
            <p>
              Position edits mutate the format-neutral mesh draft. The drag gizmo previews in Three.js, then commits one semantic vertex command on pointer release. Derived normals/tangents are treated as stale and rebuilt downstream.
            </p>
          </section>
        )}

        <section className={styles.boundary}>
          <strong>Ownership boundary</strong>
          <p>
            The editor owns selection, local/world gizmo semantics, semantic edit commands, undo/redo, and the versioned scene-snapshot boundary. Snapshot JSON contains only format-neutral hierarchy, transforms, meshes, and vertex attributes; selection, history, topology caches, camera state, and Three.js objects stay transient.
          </p>
        </section>

        <button type="button" className={styles.resetButton} onClick={resetScene}>
          Reset scene
        </button>
      </aside>
    </section>
  );
}
