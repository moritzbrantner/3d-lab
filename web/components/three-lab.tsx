"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VertexNormalsHelper } from "three/examples/jsm/helpers/VertexNormalsHelper.js";
import {
  coloredTriangleMesh,
  cubeMesh,
  subdividedPlane,
  triangleMesh,
  triangleNormal,
  uvQuadMesh,
  validateMesh,
  type IndexedMesh,
} from "@/lib/mesh";
import { lessons, type LessonId } from "@/lib/lessons";

type TransformState = {
  rotateY: number;
  scale: number;
  lift: number;
};

type ProjectionMode = "perspective" | "orthographic";
type CullMode = "front" | "double";

type SceneRuntime = {
  root: THREE.Group;
  animated: THREE.Object3D | null;
  transformTarget: THREE.Object3D | null;
  setCullMode: ((mode: CullMode) => void) | null;
  updateSubdivisions: ((segments: number) => void) | null;
};

const DEFAULT_TRANSFORM: TransformState = { rotateY: 35, scale: 1, lift: 0 };
const DEFAULT_SUBDIVISIONS = 4;

function meshGeometry(mesh: IndexedMesh): THREE.BufferGeometry {
  validateMesh(mesh);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
  geometry.setIndex([...mesh.indices]);

  if (mesh.attributes?.normals) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.attributes.normals.flat(), 3));
  } else {
    geometry.computeVertexNormals();
  }

  if (mesh.attributes?.uvs) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(mesh.attributes.uvs.flat(), 2));
  }

  if (mesh.attributes?.colors) {
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(mesh.attributes.colors.flat(), 3));
  }

  return geometry;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        const mappedMaterial = material as THREE.Material & { map?: THREE.Texture | null };
        mappedMaterial.map?.dispose();
        material.dispose();
      });
    }
  });
}

function makePointCloud(positions: readonly (readonly number[])[], size = 0.12) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions.flat(), 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ size, sizeAttenuation: true }));
}

function makeCheckerTexture(): THREE.DataTexture {
  const size = 8;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const light = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
      const value = light ? 235 : 42;
      data[offset] = value;
      data[offset + 1] = light ? 235 : 112;
      data[offset + 2] = light ? 235 : 185;
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function buildLessonScene(
  id: LessonId,
  options: { cullMode: CullMode; subdivisions: number },
): SceneRuntime {
  const root = new THREE.Group();
  let animated: THREE.Object3D | null = null;
  let transformTarget: THREE.Object3D | null = null;
  let setCullMode: SceneRuntime["setCullMode"] = null;
  let updateSubdivisions: SceneRuntime["updateSubdivisions"] = null;

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

  if (id === "normal-modes") {
    const flatGeometry = new THREE.IcosahedronGeometry(0.88, 2);
    const smoothGeometry = flatGeometry.clone();
    smoothGeometry.computeVertexNormals();

    const flat = new THREE.Mesh(
      flatGeometry,
      new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0, flatShading: true }),
    );
    const smooth = new THREE.Mesh(
      smoothGeometry,
      new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0, flatShading: false }),
    );
    flat.position.x = -1.15;
    smooth.position.x = 1.15;
    root.add(flat, smooth);
  }

  if (id === "uvs") {
    const geometry = meshGeometry(uvQuadMesh);
    const material = new THREE.MeshBasicMaterial({
      map: makeCheckerTexture(),
      side: THREE.DoubleSide,
    });
    root.add(new THREE.Mesh(geometry, material));
    root.add(new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial()));
  }

  if (id === "vertex-colors") {
    const geometry = meshGeometry(coloredTriangleMesh);
    root.add(new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    ));
    root.add(new THREE.Points(
      geometry.clone(),
      new THREE.PointsMaterial({ size: 0.16, sizeAttenuation: true, vertexColors: true }),
    ));
  }

  if (id === "winding") {
    const materials: THREE.MeshNormalMaterial[] = [];
    const addTriangle = (reversed: boolean, x: number) => {
      const mesh = reversed
        ? { vertices: triangleMesh.vertices, indices: [0, 2, 1] as const }
        : triangleMesh;
      const geometry = meshGeometry(mesh);
      const material = new THREE.MeshNormalMaterial({
        side: options.cullMode === "front" ? THREE.FrontSide : THREE.DoubleSide,
      });
      const group = new THREE.Group();
      group.position.x = x;
      group.scale.setScalar(0.72);
      group.add(new THREE.Mesh(geometry, material));
      group.add(new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial()));

      const normal = triangleNormal(mesh, 0);
      if (normal) {
        group.add(new THREE.ArrowHelper(
          new THREE.Vector3(...normal),
          new THREE.Vector3(0, -0.16, 0),
          0.9,
        ));
      }

      materials.push(material);
      root.add(group);
    };

    addTriangle(false, -1.2);
    addTriangle(true, 1.2);
    setCullMode = (mode) => {
      materials.forEach((material) => {
        material.side = mode === "front" ? THREE.FrontSide : THREE.DoubleSide;
        material.needsUpdate = true;
      });
    };
  }

  if (id === "procedural") {
    const proceduralRoot = new THREE.Group();
    root.add(proceduralRoot);

    const install = (segments: number) => {
      disposeObject(proceduralRoot);
      proceduralRoot.clear();
      const geometry = meshGeometry(subdividedPlane(segments));
      proceduralRoot.add(new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0, side: THREE.DoubleSide }),
      ));
      proceduralRoot.add(new THREE.LineSegments(
        new THREE.WireframeGeometry(geometry),
        new THREE.LineBasicMaterial(),
      ));
    };

    install(options.subdivisions);
    updateSubdivisions = install;
  }

  return { root, animated, transformTarget, setCullMode, updateSubdivisions };
}

export function ThreeLab() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const animationEnabledRef = useRef(true);
  const transformRef = useRef<TransformState>(DEFAULT_TRANSFORM);
  const projectionRef = useRef<ProjectionMode>("perspective");
  const cullModeRef = useRef<CullMode>("front");
  const subdivisionsRef = useRef(DEFAULT_SUBDIVISIONS);

  const [lessonId, setLessonId] = useState<LessonId>("coordinates");
  const [animationEnabled, setAnimationEnabled] = useState(true);
  const [transform, setTransform] = useState<TransformState>(DEFAULT_TRANSFORM);
  const [projection, setProjection] = useState<ProjectionMode>("perspective");
  const [cullMode, setCullMode] = useState<CullMode>("front");
  const [subdivisions, setSubdivisions] = useState(DEFAULT_SUBDIVISIONS);

  const lesson = useMemo(() => lessons.find((entry) => entry.id === lessonId) ?? lessons[0], [lessonId]);
  const stats = useMemo(() => {
    if (lessonId !== "procedural") return lesson.stats;
    return [
      ["segments", String(subdivisions)],
      ["vertices", String((subdivisions + 1) ** 2)],
      ["triangles", String(2 * subdivisions ** 2)],
    ] as const;
  }, [lesson, lessonId, subdivisions]);

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
    cullModeRef.current = cullMode;
    runtimeRef.current?.setCullMode?.(cullMode);
  }, [cullMode]);

  useEffect(() => {
    subdivisionsRef.current = subdivisions;
    runtimeRef.current?.updateSubdivisions?.(subdivisions);
  }, [subdivisions]);

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

    const perspectiveControls = new OrbitControls(perspectiveCamera, renderer.domElement);
    perspectiveControls.enableDamping = true;
    perspectiveControls.target.set(0, 0, 0);

    const orthographicControls = new OrbitControls(orthographicCamera, renderer.domElement);
    orthographicControls.enableDamping = true;
    orthographicControls.target.copy(perspectiveControls.target);
    orthographicControls.enabled = false;

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
      const runtime = buildLessonScene(id, {
        cullMode: cullModeRef.current,
        subdivisions: subdivisionsRef.current,
      });
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

      const orthographic = projectionRef.current === "orthographic";
      perspectiveControls.enabled = !orthographic;
      orthographicControls.enabled = orthographic;
      const controls = orthographic ? orthographicControls : perspectiveControls;
      const camera = orthographic ? orthographicCamera : perspectiveCamera;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      perspectiveControls.dispose();
      orthographicControls.dispose();
      disposeObject(scene);
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

          {lessonId === "winding" && (
            <div className="segmented" aria-label="Back-face culling mode">
              <button type="button" className={cullMode === "front" ? "active" : ""} onClick={() => setCullMode("front")}>Front faces only</button>
              <button type="button" className={cullMode === "double" ? "active" : ""} onClick={() => setCullMode("double")}>Double-sided</button>
            </div>
          )}

          {lessonId === "procedural" && (
            <div className="controls-grid procedural-controls" aria-label="Subdivision controls">
              <label>
                Segments <output>{subdivisions}</output>
                <input type="range" min="1" max="16" value={subdivisions} onChange={(event) => setSubdivisions(Number(event.target.value))} />
              </label>
              <div className="mesh-readout">
                <strong>{(subdivisions + 1) ** 2}</strong> vertices · <strong>{2 * subdivisions ** 2}</strong> triangles
              </div>
            </div>
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
              {stats.map(([label, value]) => (
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
