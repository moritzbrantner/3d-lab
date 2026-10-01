import type { Metadata } from "next";
import Link from "next/link";
import { PlaybackTimingLab } from "@/components/playback-timing-lab";
import styles from "@/components/playback-timing-lab.module.css";

export const metadata: Metadata = {
  title: "Playback Timing | 3D Lab",
  description:
    "Compare Rust elapsed-time clip playback and cross-fades across uneven frame partitions with an intentionally wrong fixed-per-frame clock.",
};

export default function AnimationTimingPage() {
  return (
    <main>
      <Link href="/" className={styles.backLink}>
        ← Back to fundamentals
      </Link>
      <header className={styles.pageHeader}>
        <p className="eyebrow">3d-lab / playback timing</p>
        <h1>Advance clips by elapsed time, not by frames.</h1>
        <p className="lede">
          <code>three-d-playback</code> turns measured frame deltas into clip time and transition progress, so 30 Hz, 120 Hz and a
          hitching frame stream land on the same pose at the same wall time.
        </p>
      </header>
      <PlaybackTimingLab />
    </main>
  );
}
