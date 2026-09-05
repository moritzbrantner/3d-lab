"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ANATOMY_STEPS, MINIMAL_MODEL_GLTF } from "@/lib/model-pipeline";
import styles from "./model-pipeline-lab.module.css";

export function ModelPipelineLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedId, setSelectedId] = useState(ANATOMY_STEPS[0].id);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const selected = useMemo(
    () => ANATOMY_STEPS.find((step) => step.id === selectedId) ?? ANATOMY_STEPS[0],
    [selectedId],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0.2, 3.1);

    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(2.5, 3.5, 4);
    const fillLight = new THREE.DirectionalLight(0x9bbcff, 1.2);
    fillLight.position.set(-3, 1, 2);
    scene.add(keyLight, fillLight, new THREE.AmbientLight(0xffffff, 0.65));

    let root: THREE.Object3D | null = null;
    let frameId = 0;
    let disposed = false;
    const clock = new THREE.Clock();

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

    new GLTFLoader().parse(
      MINIMAL_MODEL_GLTF,
      "",
      (gltf) => {
        if (disposed) return;
        root = gltf.scene;
        scene.add(root);
        setLoadState("loaded");
      },
      () => {
        if (!disposed) setLoadState("error");
      },
    );

    const render = () => {
      const delta = clock.getDelta();
      if (root) root.rotation.y += delta * 0.42;
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(render);
    };
    render();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      root?.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      renderer.dispose();
    };
  }, []);

  return (
    <section className={styles.lab} aria-labelledby="model-pipeline-heading">
      <div className={styles.previewPanel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className="eyebrow">Loaded result</p>
            <h2 id="model-pipeline-heading">One triangle, all the indirection visible.</h2>
          </div>
          <p className={styles.loadState} data-state={loadState}>
            {loadState === "loading" && "Parsing glTF…"}
            {loadState === "loaded" && "Loaded through GLTFLoader"}
            {loadState === "error" && "glTF parsing failed"}
          </p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Rotating triangle loaded from the minimal glTF asset" />
        <p className={styles.previewCopy}>
          Three.js resolves the file-format machinery into renderable objects. The anatomy browser beside it keeps the original links visible instead of hiding them behind the resulting mesh.
        </p>
      </div>

      <div className={styles.anatomyPanel}>
        <p className="eyebrow">glTF anatomy</p>
        <h2>Follow the reference chain before thinking about rendering.</h2>
        <div className={styles.stepRail} role="list" aria-label="glTF anatomy layers">
          {ANATOMY_STEPS.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className={`${styles.stepButton} ${selectedId === step.id ? styles.activeStep : ""}`}
              onClick={() => setSelectedId(step.id)}
              aria-pressed={selectedId === step.id}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{step.title}</strong>
            </button>
          ))}
        </div>
        <div className={styles.detail} aria-live="polite">
          <p className={styles.detailLabel}>{selected.title}</p>
          <code>{selected.reference}</code>
          <p>{selected.explanation}</p>
        </div>
        <div className={styles.boundary}>
          <strong>Rust ownership boundary</strong>
          <p>
            glTF accessors and buffers end at the adapter. <code>three-d-assets</code> receives validated mesh primitives and material references; it does not retain glTF indices or binary-layout vocabulary.
          </p>
        </div>
      </div>
    </section>
  );
}
