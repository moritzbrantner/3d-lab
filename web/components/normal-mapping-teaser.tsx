import Link from "next/link";
import styles from "./normal-mapping-lab.module.css";

export function NormalMappingTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="normal-mapping-teaser-heading">
      <div>
        <p className="eyebrow">Tangent space</p>
        <h2 id="normal-mapping-teaser-heading">See how a flat surface borrows detail from a normal map.</h2>
        <p className={styles.teaserCopy}>
          Derive tangent and bitangent directions from geometry plus UVs, inspect the handedness sign, and then watch a tangent-space normal map change lighting without changing the mesh.
        </p>
      </div>
      <Link href="/normal-mapping/" className={styles.teaserLink}>
        Open normal mapping lab →
      </Link>
    </section>
  );
}
