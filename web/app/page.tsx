import { ModelPipelineTeaser } from "@/components/model-pipeline-teaser";
import { NormalMappingTeaser } from "@/components/normal-mapping-teaser";
import { RendererComparisonTeaser } from "@/components/renderer-comparison-teaser";
import { SkeletalAnimationTeaser } from "@/components/skeletal-animation-teaser";
import { ThreeLab } from "@/components/three-lab";

export default function Home() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">3d-lab / fundamentals</p>
        <h1>See what a 3D renderer is actually working with.</h1>
        <p className="lede">
          Move from coordinates to asset pipelines one concept at a time. Every lesson keeps the scene small,
          exposes the underlying data, and connects the Three.js view to renderer-independent Rust models.
        </p>
      </header>
      <NormalMappingTeaser />
      <ModelPipelineTeaser />
      <RendererComparisonTeaser />
      <SkeletalAnimationTeaser />
      <ThreeLab />
    </main>
  );
}
