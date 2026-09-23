import type { Metadata } from "next";
import Link from "next/link";
import { MaterialTextureLab } from "@/components/material-texture-lab";
import styles from "@/components/material-texture-lab.module.css";

export const metadata: Metadata = {
  title: "Materials & Textures | 3D Lab",
  description: "Interactive PBR, procedural texture composition, UV transform and stretching playground for 3d-lab.",
};

export default function MaterialsTexturesPage() {
  return (
    <main>
      <Link href="/" className={styles.backLink}>← Back to fundamentals</Link>
      <header className={styles.pageHeader}>
        <p className="eyebrow">3d-lab / materials & textures</p>
        <h1>Play with the surface model separately from the mesh.</h1>
        <p className="lede">
          Compose deterministic procedural texture layers, inspect UV stretching, and tune repeat, offset, rotation and sampler wrapping independently from PBR material factors. The durable asset model owns portable texture mapping intent; procedural recipes remain authoring-side until they are baked to pixels.
        </p>
      </header>
      <MaterialTextureLab />
    </main>
  );
}
