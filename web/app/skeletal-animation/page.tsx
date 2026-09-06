import type { Metadata } from "next";
import Link from "next/link";
import { CharacterRigLab } from "@/components/character-rig-lab";
import { SkeletalAnimationLab } from "@/components/skeletal-animation-lab";
import styles from "@/components/skeletal-animation-lab.module.css";

export const metadata: Metadata = {
  title: "Skeletal Animation Deep Dive | 3D Lab",
  description:
    "Interactive 3D character rig plus explanations of skeleton hierarchies, bind poses, inverse bind matrices, linear blend skinning, animation evaluation, and glTF model assembly.",
};

export default function SkeletalAnimationPage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">3d-lab / skeletal animation deep dive</p>
        <h1>Move a real 3D rig, then inspect the math underneath it.</h1>
        <p className="lede">
          Start with a playable humanoid hierarchy you can orbit, scrub and animate. Then use the deliberately small three-joint teaching model to trace local bone transforms through world matrices, inverse bind matrices, weighted skinning, GPU-ready joint palettes, and glTF references.
        </p>
        <Link href="/" className={styles.backLink}>← Back to 3D fundamentals</Link>
      </header>
      <CharacterRigLab />
      <SkeletalAnimationLab />
    </main>
  );
}
