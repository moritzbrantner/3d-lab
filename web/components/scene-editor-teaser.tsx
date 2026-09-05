import Link from "next/link";
import styles from "./scene-editor-lab.module.css";

export function SceneEditorTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="scene-editor-teaser-heading">
      <div>
        <p className="eyebrow">Authoring and inspection</p>
        <h2 id="scene-editor-teaser-heading">Manipulate nodes and indexed mesh components directly.</h2>
        <p className={styles.teaserCopy}>
          Browse the hierarchy, pick objects, vertices, edges, or faces, drag local/world transform gizmos, edit vertex positions, and undo or redo model-backed authoring changes.
        </p>
      </div>
      <Link href="/editor/" className={styles.teaserLink}>
        Open scene editor →
      </Link>
    </section>
  );
}
