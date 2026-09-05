import Link from "next/link";
import styles from "./model-pipeline-lab.module.css";

export function ModelPipelineTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="model-pipeline-teaser-heading">
      <div>
        <p className="eyebrow">Model pipeline</p>
        <h2 id="model-pipeline-teaser-heading">See how a glTF file turns byte ranges into a materialized mesh.</h2>
        <p className={styles.teaserCopy}>
          Follow scene, node, mesh, primitive, accessor, buffer-view, buffer, and material references through one deliberately tiny asset before adding general-purpose loaders.
        </p>
      </div>
      <Link href="/model-pipeline/" className={styles.teaserLink}>
        Open model pipeline →
      </Link>
    </section>
  );
}
