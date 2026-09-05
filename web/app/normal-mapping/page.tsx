import Link from "next/link";
import { NormalMappingLab } from "@/components/normal-mapping-lab";
import styles from "@/components/normal-mapping-lab.module.css";

export default function NormalMappingPage() {
  return (
    <main>
      <Link href="/" className={styles.backLink}>
        ← Back to fundamentals
      </Link>
      <header className={styles.pageHeader}>
        <p className="eyebrow">3d-lab / tangent space</p>
        <h1>Normal mapping only works after geometry defines a local coordinate frame.</h1>
        <p className="lede">
          Follow the tangent, bitangent, normal, UV, and handedness data that lets a texture-space direction become a lighting normal. The mesh stays flat; only the shading frame changes.
        </p>
      </header>
      <NormalMappingLab />
    </main>
  );
}
