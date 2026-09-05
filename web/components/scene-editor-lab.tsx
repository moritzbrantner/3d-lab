"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  childrenOf,
  commitMeshVertex,
  commitNodeTransform,
  createEditorHistory,
  createEditorScene,
  redoEditorHistory,
  replaceEditorScene,
  triangleVertexIndices,
  undoEditorHistory,
  type EditableTransform,
  type EditorNode,
  type MeshEdge,
} from "@/lib/scene-editor";
import type { Vec3 } from "@/lib/mesh";
import styles from "./scene-editor-lab.module.css";

type Axis = 0 | 1 | 2;
type SelectionMode = "object" | "vertex" | "edge" | "face";
type GizmoMode = "translate" | "rotate" | "scale";
type GizmoSpace = "local" | "world";

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  transform: TransformControls;
  objects: Map<string, THREE.Object3D>;
  vertexPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null;
  vertexTarget: THREE.Object3D | null;
  componentOverlay: THREE.Object3D | null;
  resizeObserver: ResizeObserver;
  suppressNextPick: boolean;
  frameId: number;
};

const AXES: readonly [label: string, axis: Axis][] = [
  ["X", 0],
  ["Y", 1],
  ["Z", 2],
];

const SELECTION_MODES: readonly [SelectionMode, string][] = [
  ["object", "Object"],
  ["vertex", "Vertex"],
  ["edge", "Edge"],
  ["face", "Face"],
];

const GIZMO_MODES: readonly [GizmoMode, string, string][] = [
  ["translate", "Move", "W"],
  ["rotate", "Rotate", "E"],
  ["scale", "Scale", "R"],
];

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function mutableVec3(value: Vec3): [number, number, number] {
  return [value[0], value[1], value[2]];
}

function canonicalEdge(a: number, b: number): MeshEdge {
  return a < b ? [a, b] : [b, a];
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

function disposeRenderable(object: THREE.Object3D | null): void {
  if (!object) return;
  object.removeFromParent();
  if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  }
}

function closestEdge(hit: THREE.Intersection<THREE.Object3D>): MeshEdge | null {
  if (!(hit.object instanceof THREE.Mesh) || !hit.face) return null;
  const position = hit.object.geometry.getAttribute("position");
  if (!(position instanceof THREE.BufferAttribute)) return null;

  const point = hit.object.worldToLocal(hit.point.clone());
  const candidates = [
    canonicalEdge(hit.face.a, hit.face.b),
    canonicalEdge(hit.face.b, hit.face.c),
    canonicalEdge(hit.face.c, hit.face.a),
  ] as const;
  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  const nearest = new THREE.Vector3();
  let best: MeshEdge | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  candidates.forEach((edge) => {
    start.fromBufferAttribute(position, edge[0]);
    end.fromBufferAttribute(position, edge[1]);
    new THREE.Line3(start, end).closestPointToPoint(point, true, nearest);
    const distance = nearest.distanceToSquared(point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = edge;
    }
  });
  return best;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
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
  nodes,
  selectedNodeId,
  onSelect,
}: {
  nodes: readonly EditorNode[];
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  const renderBranch = (parent: string | null): ReactNode => {
    const children = childrenOf({ nodes }, parent);
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
  const selectionModeRef = useRef<SelectionMode>("object");
  const [history, setHistory] = useState(() => createEditorHistory());
  const [selectedNodeId, setSelectedNodeId] = useState("body");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("object");
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<MeshEdge | null>(null);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("translate");
  const [gizmoSpace, setGizmoSpace] = useState<GizmoSpace>("local");
  const [showVertices, setShowVertices] = useState(true);
  const [wireframe, setWireframe] = useState(false);

  const editorScene = history.present;
  const selectedNode = useMemo(
    () => editorScene.nodes.find((node) => node.id === selectedNodeId) ?? editorScene.nodes[0],
    [editorScene, selectedNodeId],
  );
  const selectedVertex =
    selectedVertexIndex === null || !selectedNode.mesh ? null : selectedNode.mesh.vertices[selectedVertexIndex] ?? null;
  const selectedFaceVertices = selectedFaceIndex === null || !selectedNode.mesh
    ? null
    : triangleVertexIndices(selectedNode.mesh, selectedFaceIndex);
  const vertexGizmoActive = selectionMode === "vertex" && selectedVertexIndex !== null && selectedVertex !== null;
  const effectiveGizmoMode: GizmoMode = vertexGizmoActive ? "translate" : gizmoMode;

  useEffect(() => {
    selectionModeRef.current = selectionMode;
  }, [selectionMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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

    const transform = new TransformControls(camera, canvas);
    scene.add(transform.getHelper());

    scene.add(new THREE.HemisphereLight(0xdce8ff, 0x20283a, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.4);
    key.position.set(4, 6, 5);
    scene.add(key);

    const grid = new THREE.GridHelper(12, 24, 0x53627a, 0x263243);
    grid.position.y = -0.75;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(1.5));

    const objects = new Map<string, THREE.Object3D>();
    const initialNodes = createEditorScene().nodes;
    initialNodes.forEach((node) => {
      const object = node.mesh
        ? new THREE.Mesh(
            createGeometry(node),
            new THREE.MeshStandardMaterial({ color: 0xaebbc9, roughness: 0.7, metalness: 0.08 }),
          )
        : new THREE.Group();
      object.name = node.name;
      object.userData.nodeId = node.id;
      object.userData.editorTargetKind = "node";
      objects.set(node.id, object);
    });
    initialNodes.forEach((node) => {
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

    transform.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
      const runtime = runtimeRef.current;
      if (runtime && event.value) runtime.suppressNextPick = true;
    });
    transform.addEventListener("mouseUp", () => {
      const object = transform.object;
      if (!object) return;
      if (object.userData.editorTargetKind === "vertex") {
        const nodeId = object.userData.nodeId as string;
        const vertexIndex = object.userData.vertexIndex as number;
        setHistory((current) => commitMeshVertex(current, nodeId, vertexIndex, [
          object.position.x,
          object.position.y,
          object.position.z,
        ]));
        return;
      }
      const nodeId = object.userData.nodeId as string | undefined;
      if (!nodeId) return;
      setHistory((current) => commitNodeTransform(current, nodeId, {
        translation: [object.position.x, object.position.y, object.position.z],
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
        scale: [object.scale.x, object.scale.y, object.scale.z],
      }));
    });

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.16 };
    const pointer = new THREE.Vector2();
    const pick = (event: MouseEvent) => {
      const runtime = runtimeRef.current;
      if (runtime?.suppressNextPick) {
        runtime.suppressNextPick = false;
        return;
      }

      const bounds = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const mode = selectionModeRef.current;
      if (mode === "vertex" && runtime?.vertexPoints) {
        const vertexHit = raycaster.intersectObject(runtime.vertexPoints, false)[0];
        if (vertexHit && vertexHit.index !== undefined) {
          const nodeId = runtime.vertexPoints.userData.nodeId as string;
          setSelectedNodeId(nodeId);
          setSelectedVertexIndex(vertexHit.index);
          setSelectedEdge(null);
          setSelectedFaceIndex(null);
          return;
        }
      }

      const meshes = [...objects.values()].filter((object): object is THREE.Mesh => object instanceof THREE.Mesh);
      const meshHit = raycaster.intersectObjects(meshes, false)[0];
      if (!meshHit) return;
      const nodeId = meshHit.object.userData.nodeId as string;
      setSelectedNodeId(nodeId);

      if (mode === "edge") {
        setSelectedVertexIndex(null);
        setSelectedFaceIndex(null);
        setSelectedEdge(closestEdge(meshHit));
      } else if (mode === "face") {
        setSelectedVertexIndex(null);
        setSelectedEdge(null);
        setSelectedFaceIndex(meshHit.faceIndex ?? null);
      } else {
        setSelectedVertexIndex(null);
        setSelectedEdge(null);
        setSelectedFaceIndex(null);
      }
    };
    canvas.addEventListener("click", pick);

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
      transform,
      objects,
      vertexPoints: null,
      vertexTarget: null,
      componentOverlay: null,
      resizeObserver,
      suppressNextPick: false,
      frameId,
    };
    render();

    return () => {
      canvas.removeEventListener("click", pick);
      cancelAnimationFrame(runtimeRef.current?.frameId ?? frameId);
      resizeObserver.disconnect();
      controls.dispose();
      transform.detach();
      transform.getHelper().removeFromParent();
      transform.dispose();
      objects.forEach((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      disposeRenderable(runtimeRef.current?.vertexPoints ?? null);
      disposeRenderable(runtimeRef.current?.componentOverlay ?? null);
      runtimeRef.current?.vertexTarget?.removeFromParent();
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, []);

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
    disposeRenderable(runtime.vertexPoints);
    runtime.vertexPoints = null;

    if (!showVertices || selectionMode !== "vertex" || !selectedNode.mesh) return;
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
  }, [editorScene, selectedNode, selectedVertexIndex, selectionMode, showVertices]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    disposeRenderable(runtime.componentOverlay);
    runtime.componentOverlay = null;
    if (!selectedNode.mesh) return;
    const selectedObject = runtime.objects.get(selectedNode.id);
    if (!selectedObject) return;

    if (selectionMode === "edge" && selectedEdge) {
      const positions = [
        ...selectedNode.mesh.vertices[selectedEdge[0]],
        ...selectedNode.mesh.vertices[selectedEdge[1]],
      ];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x79a9ff, depthTest: false }));
      line.renderOrder = 6;
      selectedObject.add(line);
      runtime.componentOverlay = line;
    }

    if (selectionMode === "face" && selectedFaceVertices) {
      const positions = selectedFaceVertices.flatMap((index) => [...selectedNode.mesh!.vertices[index]]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex([0, 1, 2]);
      const face = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: 0x79a9ff,
          transparent: true,
          opacity: 0.34,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
      );
      face.renderOrder = 5;
      selectedObject.add(face);
      runtime.componentOverlay = face;
    }
  }, [editorScene, selectedEdge, selectedFaceVertices, selectedNode, selectionMode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    runtime.transform.detach();
    runtime.vertexTarget?.removeFromParent();
    runtime.vertexTarget = null;
    runtime.transform.setSpace(gizmoSpace);

    const selectedObject = runtime.objects.get(selectedNode.id);
    if (!selectedObject) return;

    if (vertexGizmoActive && selectedVertex) {
      const target = new THREE.Object3D();
      target.position.set(...selectedVertex);
      target.userData.editorTargetKind = "vertex";
      target.userData.nodeId = selectedNode.id;
      target.userData.vertexIndex = selectedVertexIndex;
      selectedObject.add(target);
      runtime.vertexTarget = target;
      runtime.transform.setMode("translate");
      runtime.transform.attach(target);
      return;
    }

    runtime.transform.setMode(gizmoMode);
    runtime.transform.attach(selectedObject);
  }, [editorScene, gizmoMode, gizmoSpace, selectedNode.id, selectedVertex, selectedVertexIndex, vertexGizmoActive]);

  useEffect(() => {
    if (!selectedNode.mesh) {
      setSelectedVertexIndex(null);
      setSelectedEdge(null);
      setSelectedFaceIndex(null);
    }
  }, [selectedNode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setHistory((current) => event.shiftKey ? redoEditorHistory(current) : undoEditorHistory(current));
        return;
      }
      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        setHistory((current) => redoEditorHistory(current));
        return;
      }
      if (event.key.toLowerCase() === "w") setGizmoMode("translate");
      if (event.key.toLowerCase() === "e") setGizmoMode("rotate");
      if (event.key.toLowerCase() === "r") setGizmoMode("scale");
      if (event.key.toLowerCase() === "q") setGizmoSpace((current) => current === "local" ? "world" : "local");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const clearComponentSelection = () => {
    setSelectedVertexIndex(null);
    setSelectedEdge(null);
    setSelectedFaceIndex(null);
  };

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    clearComponentSelection();
  };

  const chooseSelectionMode = (mode: SelectionMode) => {
    setSelectionMode(mode);
    clearComponentSelection();
  };

  const updateTransformVector = (field: keyof EditableTransform, axis: Axis, value: number) => {
    setHistory((current) => {
      const node = current.present.nodes.find((candidate) => candidate.id === selectedNodeId);
      if (!node) return current;
      const source = mutableVec3(node.transform[field]);
      source[axis] = field === "rotation" ? toRadians(value) : value;
      const patch: Partial<EditableTransform> =
        field === "translation"
          ? { translation: source }
          : field === "rotation"
            ? { rotation: source }
            : { scale: source };
      return commitNodeTransform(current, selectedNodeId, patch);
    });
  };

  const updateVertexAxis = (axis: Axis, value: number) => {
    if (selectedVertexIndex === null) return;
    setHistory((current) => {
      const node = current.present.nodes.find((candidate) => candidate.id === selectedNodeId);
      const vertex = node?.mesh?.vertices[selectedVertexIndex];
      if (!vertex) return current;
      const next = mutableVec3(vertex);
      next[axis] = value;
      return commitMeshVertex(current, selectedNodeId, selectedVertexIndex, next);
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

  const resetScene = () => {
    setHistory((current) => replaceEditorScene(current, createEditorScene()));
    setSelectedNodeId("body");
    clearComponentSelection();
  };

  const rotationDegrees: Vec3 = [
    toDegrees(selectedNode.transform.rotation[0]),
    toDegrees(selectedNode.transform.rotation[1]),
    toDegrees(selectedNode.transform.rotation[2]),
  ];

  const selectionSummary = selectedVertexIndex !== null
    ? `vertex ${selectedVertexIndex}`
    : selectedEdge
      ? `edge ${selectedEdge[0]}–${selectedEdge[1]}`
      : selectedFaceIndex !== null
        ? `face ${selectedFaceIndex}`
        : selectionMode;

  return (
    <section className={styles.editor} aria-labelledby="scene-editor-heading">
      <aside className={styles.hierarchyPanel}>
        <p className="eyebrow">Hierarchy</p>
        <h2 id="scene-editor-heading">Scene graph</h2>
        <p className={styles.panelCopy}>Select a node here or pick geometry in the viewport.</p>
        <HierarchyTree nodes={editorScene.nodes} selectedNodeId={selectedNodeId} onSelect={selectNode} />
      </aside>

      <div className={styles.viewportPanel}>
        <div className={styles.toolbar}>
          <div>
            <p className="eyebrow">Authoring viewport</p>
            <strong>{selectedNode.name}</strong>
            <span> / {selectionSummary}</span>
          </div>
          <div className={styles.toolbarActions}>
            <button
              type="button"
              className={styles.toolButton}
              onClick={() => setHistory((current) => undoEditorHistory(current))}
              disabled={history.undo.length === 0}
            >
              Undo
            </button>
            <button
              type="button"
              className={styles.toolButton}
              onClick={() => setHistory((current) => redoEditorHistory(current))}
              disabled={history.redo.length === 0}
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
          </div>
        </div>

        <div className={styles.modeBar} aria-label="Editor interaction modes">
          <div className={styles.modeGroup}>
            <span>Select</span>
            {SELECTION_MODES.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={selectionMode === mode ? styles.modeButtonActive : styles.modeButton}
                onClick={() => chooseSelectionMode(mode)}
                aria-pressed={selectionMode === mode}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={styles.modeGroup}>
            <span>Gizmo</span>
            {GIZMO_MODES.map(([mode, label, shortcut]) => (
              <button
                key={mode}
                type="button"
                className={effectiveGizmoMode === mode ? styles.modeButtonActive : styles.modeButton}
                onClick={() => setGizmoMode(mode)}
                disabled={vertexGizmoActive && mode !== "translate"}
                aria-pressed={effectiveGizmoMode === mode}
                title={`${label} (${shortcut})`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={styles.modeGroup}>
            <span>Space</span>
            {(["local", "world"] as const).map((space) => (
              <button
                key={space}
                type="button"
                className={gizmoSpace === space ? styles.modeButtonActive : styles.modeButton}
                onClick={() => setGizmoSpace(space)}
                aria-pressed={gizmoSpace === space}
              >
                {space === "local" ? "Local" : "World"}
              </button>
            ))}
          </div>
        </div>

        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Interactive 3D scene editor with transform gizmos and object, vertex, edge, and face picking."
        />
        <p className={styles.viewportHint}>
          Drag the gizmo to edit the selected node. In vertex mode, pick a handle and the same gizmo edits that local position. W/E/R change gizmo mode, Q toggles local/world, and Ctrl/Cmd+Z undoes.
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
          <section className={styles.componentSection}>
            <div className={styles.vertexHeading}>
              <div>
                <span className={styles.sectionLabel}>Component selection</span>
                <strong>
                  {selectedVertexIndex !== null && `Vertex ${selectedVertexIndex}`}
                  {selectedEdge && `Edge ${selectedEdge[0]}–${selectedEdge[1]}`}
                  {selectedFaceIndex !== null && `Face ${selectedFaceIndex}`}
                  {selectedVertexIndex === null && !selectedEdge && selectedFaceIndex === null && `Pick a ${selectionMode}`}
                </strong>
              </div>
              {(selectedVertexIndex !== null || selectedEdge || selectedFaceIndex !== null) && (
                <button type="button" className={styles.clearButton} onClick={clearComponentSelection}>
                  Clear
                </button>
              )}
            </div>
            {selectedVertex && (
              <VectorEditor label="Vertex local position" value={selectedVertex} step={0.05} onChange={updateVertexAxis} />
            )}
            {selectedEdge && (
              <p>Indexed edge connects vertices <code>{selectedEdge[0]}</code> and <code>{selectedEdge[1]}</code>.</p>
            )}
            {selectedFaceVertices && (
              <p>
                Indexed triangle references vertices <code>{selectedFaceVertices.join(", ")}</code>.
              </p>
            )}
            <p>
              Component ids come from the indexed mesh, not Three.js object identity. Position edits invalidate derived normals and tangents.
            </p>
          </section>
        )}

        <section className={styles.boundary}>
          <strong>Ownership boundary</strong>
          <p>
            Gizmos commit local model values only when a drag finishes. Undo/redo replays bounded format-neutral edit commands. Three.js stays responsible for rendering, ray picking, and transient manipulation handles.
          </p>
        </section>

        <button type="button" className={styles.resetButton} onClick={resetScene}>
          Reset scene
        </button>
      </aside>
    </section>
  );
}
