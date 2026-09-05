import Link from "next/link";
import { BrowserWebGpuLab } from "@/components/browser-webgpu-lab";
import { RendererComparisonLab } from "@/components/renderer-comparison-lab";
import styles from "@/components/renderer-comparison-lab.module.css";

export default function RendererComparisonPage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Renderer comparison / indexed draw</p>
        <h1>One mesh. Two levels of abstraction.</h1>
        <p className="lede">
          Follow renderer-independent geometry into Three.js, native wgpu, and one deliberately small raw browser
          WebGPU pipeline. The concepts stay shared even when each API exposes different machinery.
        </p>
      </header>
      <RendererComparisonLab />
      <BrowserWebGpuLab />
      <Link href="/" className={styles.backLink}>
        ← Back to 3D fundamentals
      </Link>
    </main>
  );
}
