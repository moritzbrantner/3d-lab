export class FlipbookContractError extends Error {}

export type FlipbookLayout = Readonly<{columns: number; rows: number; frameCount: number}>

export type FlipbookPlayback = {startTime: number; duration: number; loops: number}

export type FlipbookSample = {
  phase: "pending" | "active" | "expired"
  age: number
  /** Atlas frame index while active, otherwise -1. */
  frame: number
  loop: number
  progress: number
}

export function compileFlipbookLayout(layout: {columns: number; rows: number; frameCount?: number}): FlipbookLayout

export function compileFlipbookPlayback(playback: {
  startTime: number
  duration: number
  loops?: number
}): FlipbookPlayback

export function sampleFlipbook(layout: FlipbookLayout, playback: FlipbookPlayback, time: number): FlipbookSample

/**
 * UV rectangle `[u, v, width, height]` of `frame`. Pass `texelInset` (the atlas size in pixels)
 * for bilinear filtering: the rectangle is inset by half a texel so edge samples never blend the
 * adjacent frame. Without it the rectangle spans the exact cell, which suits nearest filtering.
 */
export function flipbookFrameRect(
  layout: FlipbookLayout,
  frame: number,
  target?: [number, number, number, number],
  texelInset?: {width: number; height: number},
): [number, number, number, number]

/** Throws `FlipbookContractError` unless the atlas divides into whole-texel cells for `layout`. */
export function requireWholeTexelCells(layout: FlipbookLayout, width: number, height: number): void

/** Upper bound on `count` for one burst. */
export const MAX_BURST_PARTICLES: 256

/**
 * Emission and motion of a seeded cosmetic burst, independent of origin and atlas. This is the
 * preset shape effect recipes (asset tooling) produce; the consumer adds identity, origin,
 * `startTime`, and `seed` per trigger.
 */
export type BurstPreset = {
  /** Particles in the burst, 1..MAX_BURST_PARTICLES. */
  count: number
  /** Each particle's life; it plays the atlas once over this span. Positive. */
  lifetime: number
  /** Particle `i` starts at `startTime + emitDuration * i / count`; defaults to 0 (all at once). */
  emitDuration?: number
  /** Initial speed, or a `[min, max]` range drawn per particle. Non-negative. */
  speed: number | readonly [number, number]
  /** Emission cone axis; defaults to up `[0, 1, 0]`. Non-zero. */
  direction?: readonly [number, number, number]
  /** Cone half-angle in radians, 0..PI; defaults to PI (every direction). */
  spread?: number
  /** Constant acceleration (for example `[0, -9.8, 0]`); defaults to none. */
  gravity?: readonly [number, number, number]
  /** Size multiplier reached at the end of each particle's life; defaults to 1. */
  endScale?: number
  /** Alpha falls linearly to 0 over each particle's life; defaults to false. */
  fadeOut?: boolean
}

export type BurstTiming = {
  startTime: number
  /** uint32; equal seeds give equal particles. */
  seed: number
}

export type CompiledBurst = Readonly<{
  startTime: number
  seed: number
  count: number
  lifetime: number
  emitDuration: number
  speed: readonly [number, number]
  axis: readonly [number, number, number]
  tangent: readonly [number, number, number]
  bitangent: readonly [number, number, number]
  cosSpread: number
  gravity: readonly [number, number, number]
  endScale: number
  fadeOut: boolean
}>

export type BurstParticleSample = {
  phase: "pending" | "active" | "expired"
  age: number
  /** Atlas frame while active, otherwise -1. */
  frame: number
  progress: number
  /** Displacement from the burst origin while active. */
  offset: [number, number, number]
  /** Scale multiplier while active (0 otherwise). */
  size: number
  /** Alpha multiplier while active (0 otherwise). */
  opacity: number
}

export function compileBurst(burst: BurstPreset & BurstTiming): CompiledBurst

export function burstParticleStartTime(burst: CompiledBurst, index: number): number

export function sampleBurstParticle(
  layout: FlipbookLayout,
  burst: CompiledBurst,
  index: number,
  time: number,
  target?: BurstParticleSample,
): BurstParticleSample

export function sampleBurst(layout: FlipbookLayout, burst: CompiledBurst, time: number): BurstParticleSample[]
