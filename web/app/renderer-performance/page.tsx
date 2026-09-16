import Link from "next/link";
import { RendererPerformanceCanary } from "@/components/renderer-performance-canary";

export default function RendererPerformancePage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Performance observability / reusable renderer</p>
        <h1>Make renderer work visible before it becomes a regression.</h1>
        <p className="lede">
          This deterministic canary exercises object reuse, resource reuse, removal, eviction, and re-creation through
          the same Three.js adapter consumed by downstream applications.
        </p>
      </header>
      <RendererPerformanceCanary />
      <p>
        <Link href="/renderer-comparison/">Back to renderer comparison</Link>
      </p>
    </main>
  );
}
