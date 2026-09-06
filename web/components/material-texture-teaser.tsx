import Link from "next/link";
import styles from "./material-texture-lab.module.css";

export function MaterialTextureTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="material-texture-teaser-heading">
      <div>
        <p className="eyebrow">Materials & textures</p>
        <h2 id="material-texture-teaser-heading">Turn one mesh into plastic, metal, matte paint, or a tiled textured surface.</h2>
        <p className={styles.teaserCopy}>
          Change PBR factors, switch procedural textures, alter UV repetition and sampler wrapping, and compare the same material across several geometries.
        </p>
      </div>
      <Link href="/materials-textures/" className={styles.teaserLink}>
        Open material playground →
      </Link>
    </section>
  );
}
