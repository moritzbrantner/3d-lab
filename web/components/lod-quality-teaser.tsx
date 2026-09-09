import Link from "next/link";
import styles from "./lod-quality-lab.module.css";

export function LodQualityTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="lod-quality-teaser-heading">
      <div>
        <p className="eyebrow">LOD & simplification</p>
        <h2 id="lod-quality-teaser-heading">Compare real simplified index buffers and see when each level becomes visually acceptable.</h2>
        <p className={styles.teaserCopy}>
          Rust generates the source-based LOD chain and screen-space transition evidence. The browser lets you inspect triangle structure, geometric error, pixel-error budgets, and hysteresis without owning the simplifier.
        </p>
      </div>
      <Link href="/lod/" className={styles.teaserLink}>
        Open LOD lab →
      </Link>
    </section>
  );
}
