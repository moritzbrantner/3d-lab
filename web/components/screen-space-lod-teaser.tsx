import Link from "next/link";
import styles from "./screen-space-lod-lab.module.css";

export function ScreenSpaceLodTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="screen-space-lod-teaser-heading">
      <div>
        <p className="eyebrow">Level of detail</p>
        <h2 id="screen-space-lod-teaser-heading">Trade triangles for distance without visible popping.</h2>
        <p className={styles.teaserCopy}>
          Compare Rust-simplified levels, set a pixel-error budget and hysteresis band, and see exactly where each level switches in or out.
        </p>
      </div>
      <Link href="/lod/" className={styles.teaserLink}>
        Open LOD lab →
      </Link>
    </section>
  );
}
