import Link from "next/link";
import { RendererComparisonLab } from "@/components/renderer-comparison-lab";
import styles from "@/components/renderer-comparison-lab.module.css";

export default function RendererComparisonPage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Renderer comparison / indexed draw</p>
        <h1>One mesh. Two levels of abstraction.</h1>
        <p className="lede">
          Follow the same indexed cube from renderer-independent geometry into Three.js and native wgpu.
          The data is the same; the amount of GPU machinery each API exposes is not.
        </p>
      </header>
      <RendererComparisonLab />
      <Link href="/" className={styles.backLink}>
        ← Back to 3D fundamentals
      </Link>
    </main>
  );
}
