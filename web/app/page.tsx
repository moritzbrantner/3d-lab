import { ThreeLab } from "@/components/three-lab";

export default function Home() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">3d-lab / fundamentals</p>
        <h1>See what a 3D renderer is actually working with.</h1>
        <p className="lede">
          Move from coordinates to animation one concept at a time. Every lesson keeps the scene small,
          exposes the underlying data, and connects the Three.js view to the renderer-independent Rust model.
        </p>
      </header>
      <ThreeLab />
    </main>
  );
}
