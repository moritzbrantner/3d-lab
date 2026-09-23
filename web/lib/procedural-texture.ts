export type ProceduralPattern = "checker" | "stripes" | "dots" | "rings" | "noise";
export type TextureBlendMode = "mix" | "multiply" | "screen" | "difference";

export type TextureLayer = {
  pattern: ProceduralPattern;
  frequency: number;
  seed: number;
};

export type ProceduralTextureRecipe = {
  size: number;
  primary: TextureLayer;
  secondary?: TextureLayer;
  blendMode: TextureBlendMode;
  blendAmount: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const fract = (value: number) => value - Math.floor(value);

function cellNoise(x: number, y: number, seed: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 982451653);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0xffffffff;
}

export function sampleProceduralPattern(layer: TextureLayer, u: number, v: number): number {
  const frequency = Math.max(0.25, Math.min(64, layer.frequency));
  const x = u * frequency;
  const y = v * frequency;

  if (layer.pattern === "checker") {
    return (Math.floor(x) + Math.floor(y)) % 2 === 0 ? 0.92 : 0.24;
  }
  if (layer.pattern === "stripes") {
    return Math.floor(x) % 2 === 0 ? 0.94 : 0.28;
  }
  if (layer.pattern === "dots") {
    const dx = fract(x) - 0.5;
    const dy = fract(y) - 0.5;
    return dx * dx + dy * dy < 0.085 ? 0.22 : 0.94;
  }
  if (layer.pattern === "rings") {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const band = Math.floor(Math.hypot(dx, dy) * frequency * 2);
    return band % 2 === 0 ? 0.92 : 0.3;
  }

  return 0.2 + cellNoise(Math.floor(x), Math.floor(y), layer.seed) * 0.78;
}

export function blendProceduralValues(
  primary: number,
  secondary: number,
  mode: TextureBlendMode,
  amount: number,
): number {
  const a = clamp01(primary);
  const b = clamp01(secondary);
  let combined = b;

  if (mode === "multiply") combined = a * b;
  if (mode === "screen") combined = 1 - (1 - a) * (1 - b);
  if (mode === "difference") combined = Math.abs(a - b);

  const mix = clamp01(amount);
  return clamp01(a * (1 - mix) + combined * mix);
}

export function generateProceduralRgba(recipe: ProceduralTextureRecipe): Uint8Array {
  const size = Math.max(4, Math.min(512, Math.round(recipe.size)));
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const primary = sampleProceduralPattern(recipe.primary, u, v);
      const value = recipe.secondary
        ? blendProceduralValues(
            primary,
            sampleProceduralPattern(recipe.secondary, u, v),
            recipe.blendMode,
            recipe.blendAmount,
          )
        : primary;
      const channel = Math.round(clamp01(value) * 255);
      const offset = (y * size + x) * 4;
      pixels[offset] = channel;
      pixels[offset + 1] = channel;
      pixels[offset + 2] = channel;
      pixels[offset + 3] = 255;
    }
  }

  return pixels;
}
