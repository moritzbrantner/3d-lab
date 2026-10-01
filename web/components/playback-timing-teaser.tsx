import Link from "next/link";
import styles from "./playback-timing-lab.module.css";

export function PlaybackTimingTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="playback-timing-teaser-heading">
      <div>
        <p className="eyebrow">Playback timing</p>
        <h2 id="playback-timing-teaser-heading">Same wall time, same pose at any frame rate.</h2>
        <p className={styles.teaserCopy}>
          Scrub Rust-evaluated clamp, loop, reverse and cross-fade playback across steady and uneven frame partitions, next to a
          deliberately wrong fixed-per-frame clock.
        </p>
      </div>
      <Link href="/animation-timing/" className={styles.teaserLink}>
        Open timing lab →
      </Link>
    </section>
  );
}
