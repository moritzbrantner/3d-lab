import Link from "next/link";
import { ScreenSpaceLodLab } from "@/components/screen-space-lod-lab";
import styles from "@/components/screen-space-lod-lab.module.css";

export default function ScreenSpaceLodPage() {
  return (
    <main>
      <Link href="/" className={styles.backLink}>
        ← Back to fundamentals
      </Link>
      <header className={styles.pageHeader}>
        <p className="eyebrow">3d-lab / level of detail</p>
        <h1>Screen-space level of detail</h1>
        <p className="lede">
          <code>three-d-lod</code> picks the coarsest level whose projected error fits the pixel budget; a hysteresis band keeps that choice stable near a threshold.
        </p>
      </header>
      <ScreenSpaceLodLab />
    </main>
  );
}
