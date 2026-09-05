"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { cubeMesh, validateMesh } from "@/lib/mesh";
import styles from "./renderer-comparison-lab.module.css";

const comparisonRows = [
  {
    concept: "Vertex data",
    three: "Float32BufferAttribute → geometry.position",
    wgpu: "Packed GpuVertex bytes → VERTEX buffer",
  },
  {
    concept: "Index data",
    three: "geometry.setIndex(indices)",
    wgpu: "u32 bytes → INDEX buffer, Uint32 format",
  },
  {
    concept: "Shader / pipeline",
    three: "MeshNormalMaterial chooses and configures renderer programs",
    wgpu: "WGSL module + explicit RenderPipelineDescriptor",
  },
  {
    concept: "Submission",
    three: "renderer.render(scene, camera)",
    wgpu: "render pass → set buffers → draw_indexed → queue.submit",
  },
] as const;

function createCubeGeometry(): THREE.BufferGeometry {
  validateMesh(cubeMesh);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(cubeMesh.vertices.flat(), 3));
  geometry.setIndex([...cubeMesh.indices]);
  geometry.computeVertexNormals();
  return geometry;
}

export function RendererComparisonLab() {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(2.7, 2.0, 3.1);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    viewport.appendChild(renderer.domElement);

    const geometry = createCubeGeometry();
    const material = new THREE.MeshNormalMaterial({ flatShading: true });
    const cube = new THREE.Mesh(geometry, material);
    const wireGeometry = new THREE.WireframeGeometry(geometry);
    const wireMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45 });
    const wireframe = new THREE.LineSegments(wireGeometry, wireMaterial);
    cube.add(wireframe);
    scene.add(cube);

    const resize = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);
    resize();

    let frame = 0;
    const animate = () => {
      cube.rotation.y += 0.004;
      cube.rotation.x = -0.22;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      wireGeometry.dispose();
      wireMaterial.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <article className={styles.comparison}>
      <section className={styles.heroGrid} aria-labelledby="same-mesh-heading">
        <div className={styles.stage}>
          <div ref={viewportRef} className={styles.viewport} aria-label="Three.js rendering of the shared indexed cube" />
          <p className={styles.caption}>
            This view uses the same eight positions and 36 indices represented by <code>Mesh::unit_cube()</code> on
            the Rust side. Three.js is doing the GPU setup behind the scene.
          </p>
        </div>
        <div className={styles.explainer}>
          <p className="eyebrow">Shared input</p>
          <h2 id="same-mesh-heading">The mesh model stops before the renderer starts.</h2>
          <p>
            <code>cubeMesh</code> and <code>three_d_core::Mesh</code> describe geometry: positions, triangle
            indices, and optional vertex attributes. Neither model owns a GPU buffer, shader, render pass, or
            window.
          </p>
          <pre className={styles.dataReadout}>{`positions[0] = [-0.5, -0.5, -0.5]\nindices[0..6] = [0, 2, 1, 0, 3, 2]`}</pre>
          <p className={styles.boundaryNote}>
            The comparison begins only after that validated mesh crosses into a renderer adapter.
          </p>
        </div>
      </section>

      <section aria-labelledby="api-mapping-heading">
        <div className={styles.sectionHeading}>
          <p className="eyebrow">API mapping</p>
          <h2 id="api-mapping-heading">Three.js compresses several explicit GPU steps into higher-level objects.</h2>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.comparisonTable}>
            <thead>
              <tr>
                <th scope="col">Concept</th>
                <th scope="col">Three.js lesson</th>
                <th scope="col">Native wgpu baseline</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.concept}>
                  <th scope="row">{row.concept}</th>
                  <td><code>{row.three}</code></td>
                  <td><code>{row.wgpu}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.sequence} aria-labelledby="draw-sequence-heading">
        <div className={styles.sectionHeading}>
          <p className="eyebrow">Indexed draw sequence</p>
          <h2 id="draw-sequence-heading">The native path exposes the ordering constraints.</h2>
        </div>
        <ol>
          <li>
            <strong>Pack.</strong> Convert each renderer-independent <code>Vec3</code> to one tightly packed
            <code> Float32x3</code> vertex while preserving index order.
          </li>
          <li>
            <strong>Upload.</strong> Create one vertex buffer and one <code>u32</code> index buffer with their
            intended GPU usages.
          </li>
          <li>
            <strong>Describe.</strong> Bind the vertex layout and WGSL entry points into a render pipeline.
          </li>
          <li>
            <strong>Encode.</strong> Begin a render pass, select the pipeline and buffers, then call
            <code> draw_indexed</code> for the mesh indices.
          </li>
          <li>
            <strong>Submit.</strong> Finish the command encoder and send the command buffer to the queue.
          </li>
        </ol>
      </section>

      <aside className={styles.nextBoundary}>
        <div>
          <p className="eyebrow">Deliberately next</p>
          <h2>Camera matrices and uniforms are not hidden inside this comparison.</h2>
        </div>
        <p>
          The current native baseline renders already-positioned vertices into clip space. The next renderer slice
          should introduce one shared matrix fixture, then compare Three.js model/view/projection matrices with an
          explicit wgpu uniform buffer. That keeps camera semantics renderer-independent instead of smuggling them
          into this first GPU adapter.
        </p>
      </aside>
    </article>
  );
}
