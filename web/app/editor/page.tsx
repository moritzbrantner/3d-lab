import Link from "next/link";
import { SceneEditorLab } from "@/components/scene-editor-lab";
import styles from "@/components/scene-editor-lab.module.css";

export default function SceneEditorPage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">3d-lab / authoring</p>
        <h1>Inspect the graph. Select the mesh. Move the vertex.</h1>
        <p className="lede">
          A small scene editor for learning how hierarchy, local transforms, indexed mesh data, picking, and rendering fit
          together. The editor mutates format-neutral model data first and lets Three.js visualize the result.
        </p>
      </header>
      <SceneEditorLab />
      <Link href="/" className={styles.backLink}>
        ← Back to 3D fundamentals
      </Link>
    </main>
  );
}
