import Link from "next/link";
import styles from "./skeletal-animation-lab.module.css";

export function SkeletalAnimationTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="skeletal-animation-deep-dive">
      <div>
        <p className="eyebrow">Deep dive</p>
        <h2 id="skeletal-animation-deep-dive">Follow one vertex through a complete skeletal-animation frame.</h2>
        <p className={styles.teaserCopy}>
          Explore joint hierarchies, bind poses, inverse bind matrices, linear blend skinning, clip sampling,
          and how glTF connects meshes, skins, nodes, and animation tracks.
        </p>
      </div>
      <Link href="/skeletal-animation/" className={styles.teaserLink}>
        Open skeletal animation lab →
      </Link>
    </section>
  );
}
