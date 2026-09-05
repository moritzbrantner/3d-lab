"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { deriveTangents, uvQuadMesh } from "@/lib/mesh";
import styles from "./normal-mapping-lab.module.css";

function createNormalMap(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const frequency = Math.PI * 8;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const dx = Math.cos(u * frequency) * Math.sin(v * frequency) * 1.35;
      const dy = Math.sin(u * frequency) * Math.cos(v * frequency) * 1.35;
      const normal = new THREE.Vector3(-dx, -dy, 1).normalize();
      const offset = (y * size + x) * 4;
      data[offset] = Math.round((normal.x * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function NormalMappingLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const basisRef = useRef<THREE.Group | null>(null);
  const [normalMapEnabled, setNormalMapEnabled] = useState(true);
  const [showBasis, setShowBasis] = useState(true);
  const [strength, setStrength] = useState(1);
  const tangents = useMemo(() => deriveTangents(uvQuadMesh), []);
  const tangent = tangents[0];
  const normal = uvQuadMesh.attributes?.normals?.[0] ?? [0, 0, 1];
  const bitangent = useMemo(() => {
    const normalVector = new THREE.Vector3(...normal);
    const tangentVector = new THREE.Vector3(tangent[0], tangent[1], tangent[2]);
    return normalVector.cross(tangentVector).multiplyScalar(tangent[3]).toArray();
  }, [normal, tangent]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0.15, 3.7);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(uvQuadMesh.vertices.flat(), 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(uvQuadMesh.attributes?.normals?.flat() ?? [], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvQuadMesh.attributes?.uvs?.flat() ?? [], 2));
    geometry.setAttribute("tangent", new THREE.Float32BufferAttribute(tangents.flat(), 4));
    geometry.setIndex([...uvQuadMesh.indices]);

    const normalMap = createNormalMap();
    const material = new THREE.MeshStandardMaterial({
      color: 0xa9b8d5,
      roughness: 0.58,
      metalness: 0.02,
      normalMap,
      normalScale: new THREE.Vector2(strength, strength),
      side: THREE.DoubleSide,
    });
    materialRef.current = material;

    const root = new THREE.Group();
    root.rotation.set(-0.12, 0.28, 0);
    root.add(new THREE.Mesh(geometry, material));

    const basis = new THREE.Group();
    const origin = new THREE.Vector3(-0.76, -0.76, 0.035);
    const tangentDirection = new THREE.Vector3(tangent[0], tangent[1], tangent[2]);
    const normalDirection = new THREE.Vector3(...normal);
    const bitangentDirection = new THREE.Vector3(...bitangent);
    basis.add(
      new THREE.ArrowHelper(tangentDirection, origin, 0.72, 0xff887a, 0.12, 0.07),
      new THREE.ArrowHelper(bitangentDirection, origin, 0.72, 0x8ee0a1, 0.12, 0.07),
      new THREE.ArrowHelper(normalDirection, origin, 0.72, 0x8db8ff, 0.12, 0.07),
    );
    basis.visible = showBasis;
    basisRef.current = basis;
    root.add(basis);
    scene.add(root);

    const key = new THREE.DirectionalLight(0xffffff, 3.6);
    key.position.set(2.6, 2.2, 3.5);
    const rim = new THREE.DirectionalLight(0x9bbcff, 1.1);
    rim.position.set(-2.4, 1.2, 2);
    scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.42));

    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    let frameId = 0;
    const render = () => {
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      geometry.dispose();
      normalMap.dispose();
      material.dispose();
      renderer.dispose();
      materialRef.current = null;
      basisRef.current = null;
    };
  }, [bitangent, normal, tangent, tangents]);

  useEffect(() => {
    const material = materialRef.current;
    if (!material) return;
    material.normalScale.set(strength, strength);
    material.normalMap = normalMapEnabled ? material.normalMap : null;
    if (normalMapEnabled && !material.normalMap) {
      material.normalMap = createNormalMap();
    }
    material.needsUpdate = true;
  }, [normalMapEnabled, strength]);

  useEffect(() => {
    if (basisRef.current) basisRef.current.visible = showBasis;
  }, [showBasis]);

  return (
    <section className={styles.lab} aria-labelledby="normal-mapping-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">Tangent-space shading</p>
            <h2 id="normal-mapping-heading">The surface stays flat. Only the lighting normal changes.</h2>
          </div>
          <p>
            The geometry supplies normal, tangent, handedness, and UVs. The normal map supplies a local direction that is transformed through that basis.
          </p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Flat quad shaded with a procedural tangent-space normal map" />
        <div className={styles.controls}>
          <label>
            Normal strength
            <output>{strength.toFixed(2)}</output>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={strength}
              onChange={(event) => setStrength(Number(event.target.value))}
            />
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={normalMapEnabled}
              onChange={(event) => setNormalMapEnabled(event.target.checked)}
            />
            Apply normal map
          </label>
          <label className={styles.toggle}>
            <input type="checkbox" checked={showBasis} onChange={(event) => setShowBasis(event.target.checked)} />
            Show T/B/N basis
          </label>
        </div>
      </div>

      <div className={styles.copyPanel}>
        <section>
          <p className="eyebrow">One vertex basis</p>
          <div className={styles.basisRows}>
            <div><strong>Tangent T</strong><code>[{tangent.slice(0, 3).join(", ")}]</code></div>
            <div><strong>Bitangent B</strong><code>[{bitangent.map((value) => value.toFixed(0)).join(", ")}]</code></div>
            <div><strong>Normal N</strong><code>[{normal.join(", ")}]</code></div>
            <div><strong>Handedness w</strong><code>{tangent[3]}</code></div>
          </div>
        </section>
        <section className={styles.explanation}>
          <h3>Why the fourth tangent component exists</h3>
          <p>
            A tangent stores its XYZ direction plus a sign. Reconstruct the bitangent as <code>B = w × cross(N, T)</code>. That sign preserves mirrored UV orientation without storing another three floats per vertex.
          </p>
        </section>
        <section className={styles.explanation}>
          <h3>What the texture means</h3>
          <p>
            RGB values in a tangent-space normal map encode a direction around the local +Z normal. The renderer remaps those channels to -1..1 and transforms the direction by the T/B/N basis before evaluating lighting.
          </p>
        </section>
        <div className={styles.boundary}>
          <strong>Current asset boundary</strong>
          <p>
            `three-d-core` now owns tangent vectors and derivation, and `three-d-formats` can preserve glTF <code>TANGENT</code> attributes. Encoded normal-map images and texture bindings still remain outside `three-d-assets`; that is the next lossless asset-model step.
          </p>
        </div>
      </div>
    </section>
  );
}
