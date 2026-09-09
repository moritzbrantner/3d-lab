import Link from "next/link";
import styles from "./playback-timing-lab.module.css";

export function PlaybackTimingTeaser() {
  return (
    <section className={styles.teaser} aria-labelledby="playback-timing-teaser-heading">
      <div>
        <p className="eyebrow">Animation timing</p>
        <h2 id="playback-timing-teaser-heading">See exactly why elapsed-time playback stays smooth when render intervals do not.</h2>
        <p className={styles.teaserCopy}>
          Rust generates an uneven frame sequence, correct and intentionally broken clocks, transition weights, and blended poses. Inspect drift and cross-fade behavior without making the browser the animation authority.
        </p>
      </div>
      <Link href="/animation-timing/" className={styles.teaserLink}>
        Open timing lab →
      </Link>
    </section>
  );
}
