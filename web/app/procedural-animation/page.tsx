import type { Metadata } from "next";
import Link from "next/link";
import { ProceduralAnimationLab } from "@/components/procedural-animation-lab";
import styles from "@/components/procedural-animation-lab.module.css";

export const metadata: Metadata = {
  title: "Procedural Character Animation | 3D Lab",
  description:
    "Interactive two-bone IK, foot planting, foot locking, pelvis correction, and terrain-normal alignment layered over authored character motion.",
};

export default function ProceduralAnimationPage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">3d-lab / procedural character animation</p>
        <h1>Keep animated feet attached to the world instead of the animation file.</h1>
        <p className="lede">
          Compare authored locomotion with a procedural correction layer. Ground samples choose contact
          targets, analytical two-bone IK solves the legs, foot locking removes skating, pelvis correction
          keeps both legs reachable, and the final feet align to the support surface.
        </p>
        <div className={styles.heroLinks}>
          <Link href="/skeletal-animation/" className={styles.secondaryLink}>
            ← Skeletal animation foundations
          </Link>
          <Link href="/" className={styles.secondaryLink}>
            3D fundamentals
          </Link>
        </div>
      </header>
      <ProceduralAnimationLab />
    </main>
  );
}
