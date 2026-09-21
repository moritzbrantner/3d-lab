import Link from "next/link";
import styles from "./skeletal-animation-lab.module.css";

export function ProceduralAnimationTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="procedural-animation-teaser-heading">
      <div>
        <p className="eyebrow">Procedural animation</p>
        <h2 id="procedural-animation-teaser-heading">
          Watch foot IK keep a walking character planted on slopes, stairs and uneven ground.
        </h2>
        <p className={styles.teaserCopy}>
          Toggle the correction layer and foot locking independently to see exactly what two-bone IK,
          support contacts, pelvis correction and terrain-normal alignment contribute.
        </p>
      </div>
      <Link href="/procedural-animation/" className={styles.teaserLink}>
        Open procedural animation lab →
      </Link>
    </section>
  );
}
