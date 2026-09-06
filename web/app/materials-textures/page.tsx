import type { Metadata } from "next";
import Link from "next/link";
import { MaterialTextureLab } from "@/components/material-texture-lab";
import styles from "@/components/material-texture-lab.module.css";

export const metadata: Metadata = {
  title: "Materials & Textures | 3D Lab",
  description: "Interactive PBR material, texture, UV repeat and sampler wrapping playground for 3d-lab.",
};

export default function MaterialsTexturesPage() {
  return (
    <main>
      <Link href="/" className={styles.backLink}>← Back to fundamentals</Link>
      <header className={styles.pageHeader}>
        <p className="eyebrow">3d-lab / materials & textures</p>
        <h1>Play with the surface model separately from the mesh.</h1>
        <p className="lede">
          Keep geometry fixed while you change base color, metallic and roughness factors, texture patterns, UV repetition and sampler wrapping. The controls mirror the renderer-independent asset model; Three.js is only the live preview adapter.
        </p>
      </header>
      <MaterialTextureLab />
    </main>
  );
}
