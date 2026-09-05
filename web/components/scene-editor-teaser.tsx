import Link from "next/link";
import styles from "./scene-editor-lab.module.css";

export function SceneEditorTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="scene-editor-teaser-heading">
      <div>
        <p className="eyebrow">Authoring and inspection</p>
        <h2 id="scene-editor-teaser-heading">Select nodes and vertices instead of only watching the scene render.</h2>
        <p className={styles.teaserCopy}>
          Browse a parent/child scene graph, pick meshes in the viewport, expose indexed vertex handles, and edit local transforms or vertex positions while the renderer follows the model.
        </p>
      </div>
      <Link href="/editor/" className={styles.teaserLink}>
        Open scene editor →
      </Link>
    </section>
  );
}
