"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VertexNormalsHelper } from "three/examples/jsm/helpers/VertexNormalsHelper.js";
import { cubeMesh, triangleMesh } from "@/lib/mesh";
import { lessons, type LessonId } from "@/lib/lessons";

type TransformState = {
  rotateY: number;
  scale: number;
  lift: number;
};

type ProjectionMode = "perspective" | "orthographic";

type SceneRuntime = {
  root: THREE.Group;
  animated: THREE.Object3D | null;
  transformTarget: THREE.Object3D | null;
};

const DEFAULT_TRANSFORM: TransformState = { rotateY: 35, scale: 1, lift: 0 };

function meshGeometry(mesh: typeof cubeMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
  geometry.setIndex([...mesh.indices]);
  geometry.computeVertexNormals();
  return geometry;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function makePointCloud(positions: readonly (readonly number[])[], size = 0.12) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions.flat(), 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ size, sizeAttenuation: true }));
}

function buildLessonScene(id: LessonId): SceneRuntime {
  const root = new THREE.Group();
  let animated: THREE.Object3D | null = null;
  let transformTarget: THREE.Object3D | null = null;

  if (id === "coordinates") {
    root.add(new THREE.AxesHelper(2.4));
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(0.65, 0.65, 0.65),
      new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.72 }),
    );
    cube.position.set(0.6, 0.45, 0.35);
    root.add(cube);
  }

  if (id === "vertices") {
    root.add(makePointCloud(triangleMesh.vertices, 0.22));
    const lineGeometry = new THREE.BufferGeometry().setFromPoints(
      [...triangleMesh.vertices, triangleMesh.vertices[0]].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    );
    root.add(new THREE.Line(lineGeometry, new THREE.LineBasicMaterial()));
  }

  if (id === "triangles") {
    const geometry = meshGeometry(triangleMesh);
    root.add(new THREE.Mesh(geometry, new THREE.MeshNormalMaterial({ side: THREE.DoubleSide })));
    root.add(new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial()));
    root.add(makePointCloud(triangleMesh.vertices, 0.16));
  }

  if (id === "indexed-meshes") {
    const geometry = meshGeometry(cubeMesh);
    const cube = new THREE.Mesh(geometry, new THREE.MeshNormalMaterial({ flatShading: true }));
    root.add(cube);
    root.add(new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial()));
    root.add(makePointCloud(cubeMesh.vertices, 0.1));
  }

  if (id === "normals") {
    const geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5, 1, 1, 1);
    const cube = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0 }));
    root.add(cube);
    root.add(new VertexNormalsHelper(cube, 0.35));
  }

  if (id === "transforms") {
    const cube = new THREE.Mesh(
      meshGeometry(cubeMesh),
      new THREE.MeshNormalMaterial({ flatShading: true }),
    );
    root.add(cube);
    root.add(new THREE.AxesHelper(1.8));
    transformTarget = cube;
  }

  if (id === "projection") {
    [-1.5, 0, 1.5].forEach((z, index) => {
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.7, 0.7),
        new THREE.MeshNormalMaterial(),
      );
      cube.position.set((index - 1) * 0.8, 0, z);
      root.add(cube);
    });
  }

  if (id === "lighting") {
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }),
    );
    root.add(sphere);
  }

  if (id === "animation") {
    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.82, 0.24, 128, 20),
      new THREE.MeshNormalMaterial(),
    );
    root.add(knot);
    animated = knot;
  }

  return { root, animated, transformTarget };
}

export function ThreeLab() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const animationEnabledRef = useRef(true);
  const transformRef = useRef<TransformState>(DEFAULT_TRANSFORM);
  const projectionRef = useRef<ProjectionMode>("perspective");

  const [lessonId, setLessonId] = useState<LessonId>("coordinates");
  const [animationEnabled, setAnimationEnabled] = useState(true);
  const [transform, setTransform] = useState<TransformState>(DEFAULT_TRANSFORM);
  const [projection, setProjection] = useState<ProjectionMode>("perspective");

  const lesson = useMemo(() => lessons.find((entry) => entry.id === lessonId) ?? lessons[0], [lessonId]);

  useEffect(() => {
    animationEnabledRef.current = animationEnabled;
  }, [animationEnabled]);

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  useEffect(() => {
    projectionRef.current = projection;
  }, [projection]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    viewport.appendChild(renderer.domElement);

    const perspectiveCamera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    perspectiveCamera.position.set(3.4, 2.5, 4.4);

    const orthographicCamera = new THREE.OrthographicCamera(-2.6, 2.6, 2.6, -2.6, 0.1, 100);
    orthographicCamera.position.copy(perspectiveCamera.position);

    const controls = new OrbitControls(perspectiveCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 1.4);
    const directional = new THREE.DirectionalLight(0xffffff, 3.4);
    directional.position.set(3, 4, 2);
    scene.add(ambient, directional);

    const grid = new THREE.GridHelper(8, 16);
    grid.position.y = -1.35;
    scene.add(grid);

    const lessonRoot = new THREE.Group();
    scene.add(lessonRoot);

    function installLesson(id: LessonId) {
      if (runtimeRef.current) {
        lessonRoot.remove(runtimeRef.current.root);
        disposeObject(runtimeRef.current.root);
      }
      const runtime = buildLessonScene(id);
      lessonRoot.add(runtime.root);
      runtimeRef.current = runtime;
    }

    installLesson(lessonId);

    const resize = () => {
      const width = Math.max(viewport.clientWidth, 1);
      const height = Math.max(viewport.clientHeight, 1);
      renderer.setSize(width, height, false);
      perspectiveCamera.aspect = width / height;
      perspectiveCamera.updateProjectionMatrix();
      const aspect = width / height;
      const heightUnits = 5.2;
      orthographicCamera.left = (-heightUnits * aspect) / 2;
      orthographicCamera.right = (heightUnits * aspect) / 2;
      orthographicCamera.top = heightUnits / 2;
      orthographicCamera.bottom = -heightUnits / 2;
      orthographicCamera.updateProjectionMatrix();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);

    const clock = new THREE.Clock();
    let frame = 0;
    const render = () => {
      const delta = Math.min(clock.getDelta(), 0.05);
      const runtime = runtimeRef.current;

      if (runtime?.animated && animationEnabledRef.current) {
        runtime.animated.rotation.x += delta * 0.55;
        runtime.animated.rotation.y += delta * 0.9;
      }

      if (runtime?.transformTarget) {
        const current = transformRef.current;
        runtime.transformTarget.rotation.y = THREE.MathUtils.degToRad(current.rotateY);
        runtime.transformTarget.scale.setScalar(current.scale);
        runtime.transformTarget.position.y = current.lift;
      }

      const camera = projectionRef.current === "orthographic" ? orthographicCamera : perspectiveCamera;
      controls.object = camera;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (runtimeRef.current) disposeObject(runtimeRef.current.root);
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, [lessonId]);

  return (
    <section className="lab-shell" aria-label="Interactive 3D fundamentals lab">
      <nav className="lesson-nav" aria-label="3D lessons">
        {lessons.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === lessonId ? "lesson-button active" : "lesson-button"}
            onClick={() => setLessonId(entry.id)}
          >
            <span>{entry.number}</span>
            <strong>{entry.title}</strong>
          </button>
        ))}
      </nav>

      <div className="workspace">
        <div className="viewport-panel">
          <div className="viewport-heading">
            <div>
              <p className="eyebrow">{lesson.number} / interactive example</p>
              <h2>{lesson.title}</h2>
            </div>
            <p>{lesson.summary}</p>
          </div>
          <div ref={viewportRef} className="viewport" aria-label={`Interactive 3D view for ${lesson.title}`} />

          {lessonId === "transforms" && (
            <div className="controls-grid" aria-label="Transform controls">
              <label>
                Rotate Y <output>{transform.rotateY}°</output>
                <input type="range" min="-180" max="180" value={transform.rotateY} onChange={(event) => setTransform((current) => ({ ...current, rotateY: Number(event.target.value) }))} />
              </label>
              <label>
                Scale <output>{transform.scale.toFixed(1)}×</output>
                <input type="range" min="0.3" max="2" step="0.1" value={transform.scale} onChange={(event) => setTransform((current) => ({ ...current, scale: Number(event.target.value) }))} />
              </label>
              <label>
                Lift Y <output>{transform.lift.toFixed(1)}</output>
                <input type="range" min="-0.8" max="1" step="0.1" value={transform.lift} onChange={(event) => setTransform((current) => ({ ...current, lift: Number(event.target.value) }))} />
              </label>
              <button type="button" className="secondary-button" onClick={() => setTransform(DEFAULT_TRANSFORM)}>Reset transform</button>
            </div>
          )}

          {lessonId === "projection" && (
            <div className="segmented" aria-label="Projection mode">
              <button type="button" className={projection === "perspective" ? "active" : ""} onClick={() => setProjection("perspective")}>Perspective</button>
              <button type="button" className={projection === "orthographic" ? "active" : ""} onClick={() => setProjection("orthographic")}>Orthographic</button>
            </div>
          )}

          {lessonId === "animation" && (
            <button type="button" className="secondary-button animation-toggle" onClick={() => setAnimationEnabled((value) => !value)}>
              {animationEnabled ? "Pause animation" : "Resume animation"}
            </button>
          )}
        </div>

        <aside className="lesson-copy">
          <section>
            <p className="eyebrow">Concept</p>
            <p className="explanation">{lesson.explanation}</p>
          </section>
          <section className="notice">
            <strong>What to notice</strong>
            <p>{lesson.notice}</p>
          </section>
          <section>
            <p className="eyebrow">Data inspector</p>
            <dl className="stats">
              {lesson.stats.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="mapping">
            <div><span>Three.js</span><code>{lesson.three}</code></div>
            <div><span>Rust</span><code>{lesson.rust}</code></div>
          </section>
        </aside>
      </div>
    </section>
  );
}
