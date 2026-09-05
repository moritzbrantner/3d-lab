"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  childrenOf,
  createEditorScene,
  updateMeshVertex,
  updateNodeTransform,
  type EditableTransform,
  type EditorNode,
  type EditorScene,
} from "@/lib/scene-editor";
import type { Vec3 } from "@/lib/mesh";
import styles from "./scene-editor-lab.module.css";

type Axis = 0 | 1 | 2;

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
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

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function mutableVec3(value: Vec3): [number, number, number] {
  return [value[0], value[1], value[2]];
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
  const [editorScene, setEditorScene] = useState<EditorScene>(() => {
    const scene = createEditorScene();
    initialSceneRef.current = scene;
    return scene;
  });
  const [selectedNodeId, setSelectedNodeId] = useState("body");
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [showVertices, setShowVertices] = useState(true);
  const [wireframe, setWireframe] = useState(false);

  const selectedNode = useMemo(
    () => editorScene.nodes.find((node) => node.id === selectedNodeId) ?? editorScene.nodes[0],
    [editorScene, selectedNodeId],
  );
  const selectedVertex =
    selectedVertexIndex === null || !selectedNode.mesh ? null : selectedNode.mesh.vertices[selectedVertexIndex] ?? null;

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
      const bounds = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const runtime = runtimeRef.current;
      if (runtime?.vertexPoints) {
        const vertexHit = raycaster.intersectObject(runtime.vertexPoints, false)[0];
        if (vertexHit && vertexHit.index !== undefined) {
          const nodeId = runtime.vertexPoints.userData.nodeId as string;
          setSelectedNodeId(nodeId);
          setSelectedVertexIndex(vertexHit.index);
          return;
        }
      }

      const meshes = [...objects.values()].filter((object): object is THREE.Mesh => object instanceof THREE.Mesh);
      const meshHit = raycaster.intersectObjects(meshes, false)[0];
      if (meshHit) {
        setSelectedNodeId(meshHit.object.userData.nodeId as string);
        setSelectedVertexIndex(null);
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
      objects,
      vertexPoints: null,
      resizeObserver,
      frameId,
    };
    render();

    return () => {
      canvas.removeEventListener("click", pick);
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
    if (!selectedNode.mesh && selectedVertexIndex !== null) setSelectedVertexIndex(null);
  }, [selectedNode, selectedVertexIndex]);

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedVertexIndex(null);
  };

  const updateTransformVector = (field: keyof EditableTransform, axis: Axis, value: number) => {
    setEditorScene((scene) => {
      const node = scene.nodes.find((candidate) => candidate.id === selectedNodeId);
      if (!node) return scene;
      const source = mutableVec3(node.transform[field]);
      source[axis] = field === "rotation" ? toRadians(value) : value;
      const patch: Partial<EditableTransform> =
        field === "translation"
          ? { translation: source }
          : field === "rotation"
            ? { rotation: source }
            : { scale: source };
      return updateNodeTransform(scene, selectedNodeId, patch);
    });
  };

  const updateVertexAxis = (axis: Axis, value: number) => {
    if (selectedVertexIndex === null) return;
    setEditorScene((scene) => {
      const node = scene.nodes.find((candidate) => candidate.id === selectedNodeId);
      const vertex = node?.mesh?.vertices[selectedVertexIndex];
      if (!vertex) return scene;
      const next = mutableVec3(vertex);
      next[axis] = value;
      return updateMeshVertex(scene, selectedNodeId, selectedVertexIndex, next);
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
    setEditorScene(createEditorScene());
    setSelectedNodeId("body");
    setSelectedVertexIndex(null);
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
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Interactive 3D scene editor. Orbit the camera, click meshes, and select visible vertex handles."
        />
        <p className={styles.viewportHint}>
          Drag to orbit, scroll to zoom, click a mesh to select it, then click a vertex handle to edit that position.
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
              Position edits mutate the format-neutral mesh draft. Derived normals/tangents are treated as stale and rebuilt downstream.
            </p>
          </section>
        )}

        <section className={styles.boundary}>
          <strong>Ownership boundary</strong>
          <p>
            The editor owns selection and draft edits. Mesh validity stays aligned with <code>three-d-core</code>; hierarchy ordering stays aligned with <code>three-d-animation</code>. Three.js only renders and ray-picks the current model.
          </p>
        </section>

        <button type="button" className={styles.resetButton} onClick={resetScene}>
          Reset scene
        </button>
      </aside>
    </section>
  );
}
