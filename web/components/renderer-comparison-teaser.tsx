import Link from "next/link";
import styles from "./renderer-comparison-lab.module.css";

export function RendererComparisonTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="renderer-comparison-deep-dive">
      <div>
        <p className="eyebrow">Renderer comparison</p>
        <h2 id="renderer-comparison-deep-dive">Trace one indexed cube from mesh data to a draw call.</h2>
        <p className={styles.teaserCopy}>
          Compare what Three.js creates for you with the buffers, shader pipeline, render pass, and indexed draw
          made explicit by the native wgpu baseline.
        </p>
      </div>
      <Link href="/renderer-comparison/" className={styles.teaserLink}>
        Open renderer comparison →
      </Link>
    </section>
  );
}
