import Link from "next/link";
import { ModelPipelineLab } from "@/components/model-pipeline-lab";
import styles from "@/components/model-pipeline-lab.module.css";

export default function ModelPipelinePage() {
  return (
    <main>
      <Link href="/" className={styles.backLink}>
        ← Back to fundamentals
      </Link>
      <header className={styles.pageHeader}>
        <p className="eyebrow">3d-lab / model pipeline</p>
        <h1>A model file is a graph of references before it is a mesh on screen.</h1>
        <p className="lede">
          Start with one self-contained glTF 2.0 asset and trace exactly where scene structure, geometry interpretation, raw bytes, and material intent live. The Rust side keeps only the durable asset semantics after decoding.
        </p>
      </header>
      <ModelPipelineLab />
    </main>
  );
}
