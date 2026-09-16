import { TopologyRendererPerformanceCanary } from "@/components/topology-renderer-performance-canary";

export default function TopologyPerformancePage() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">3d-lab / performance</p>
        <h1>Topology renderer boundary canary</h1>
        <p className="lede">
          A deterministic browser workload for measuring the cost of turning persistent topology edits into Three.js geometry.
        </p>
      </header>
      <TopologyRendererPerformanceCanary />
    </main>
  );
}
