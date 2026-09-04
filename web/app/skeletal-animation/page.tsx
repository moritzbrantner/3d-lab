import type { Metadata } from "next";
import Link from "next/link";
import { SkeletalAnimationLab } from "@/components/skeletal-animation-lab";
import styles from "@/components/skeletal-animation-lab.module.css";

export const metadata: Metadata = {
  title: "Skeletal Animation Deep Dive | 3D Lab",
  description:
    "Interactive explanations of skeleton hierarchies, bind poses, inverse bind matrices, linear blend skinning, animation evaluation, and glTF model assembly.",
};

export default function SkeletalAnimationPage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">3d-lab / skeletal animation deep dive</p>
        <h1>See how a rig turns keyframes into moving vertices.</h1>
        <p className="lede">
          Use one deliberately small three-joint model to trace the entire path from local bone transforms to
          world matrices, inverse bind matrices, weighted skinning, GPU-ready joint palettes, and the references
          that connect an animated glTF model.
        </p>
        <Link href="/" className={styles.backLink}>← Back to 3D fundamentals</Link>
      </header>
      <SkeletalAnimationLab />
    </main>
  );
}
