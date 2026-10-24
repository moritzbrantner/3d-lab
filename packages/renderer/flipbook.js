// Renderer-independent baked-flipbook sampling for cosmetic effects.
//
// This module does not import Three.js. It owns atlas layout validation and the deterministic
// mapping from an effect's age to its atlas frame, so renderers, tests, and asset tooling share one
// definition of fixed-time sampling. Effects are cosmetic: nothing here feeds game state.

export class FlipbookContractError extends Error {
  constructor(message) {
    super(message)
    this.name = "FlipbookContractError"
  }
}

function requirePositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FlipbookContractError(`${name} must be a positive integer`)
  }
}

/**
 * Validates an atlas layout once and returns a frozen compiled layout. Frames are numbered
 * row-major from the top-left cell of the atlas image.
 */
export function compileFlipbookLayout(layout) {
  if (!layout || typeof layout !== "object") {
    throw new FlipbookContractError("flipbook layout must be an object")
  }
  requirePositiveInteger("flipbook columns", layout.columns)
  requirePositiveInteger("flipbook rows", layout.rows)
  const frameCount = layout.frameCount ?? layout.columns * layout.rows
  requirePositiveInteger("flipbook frameCount", frameCount)
  if (frameCount > layout.columns * layout.rows) {
    throw new FlipbookContractError("flipbook frameCount must fit in columns * rows")
  }
  return Object.freeze({columns: layout.columns, rows: layout.rows, frameCount})
}

/** Validates one effect's playback timing. Returns the normalized timing. */
export function compileFlipbookPlayback(playback) {
  if (!playback || typeof playback !== "object") {
    throw new FlipbookContractError("flipbook playback must be an object")
  }
  if (!Number.isFinite(playback.startTime)) {
    throw new FlipbookContractError("flipbook startTime must be finite")
  }
  if (!Number.isFinite(playback.duration) || playback.duration <= 0) {
    throw new FlipbookContractError("flipbook duration must be finite and positive")
  }
  const loops = playback.loops ?? 1
  requirePositiveInteger("flipbook loops", loops)
  return {startTime: playback.startTime, duration: playback.duration, loops}
}

/**
 * Samples a flipbook at an absolute `time` (same clock as `startTime`).
 *
 * - `age = time - startTime`. A negative age is `pending` and draws nothing.
 * - While `0 <= age < duration * loops` the effect is `active`. Within one loop,
 *   `frame = floor((age mod duration) / duration * frameCount)`, clamped to the last frame.
 * - At and after `duration * loops` the effect is `expired` and draws nothing.
 *
 * The result depends only on `time`, never on previously sampled times, so seeking and any
 * partition of updates produce the same frame. `progress` is the age within the current loop
 * divided by `duration` (0 while pending, 1 once expired).
 */
export function sampleFlipbook(layout, playback, time) {
  if (!Number.isFinite(time)) {
    throw new FlipbookContractError("flipbook sample time must be finite")
  }
  const age = time - playback.startTime
  if (!Number.isFinite(age)) {
    throw new FlipbookContractError("flipbook age must be finite")
  }
  if (age < 0) return {phase: "pending", age, frame: -1, loop: 0, progress: 0}
  const lifetime = playback.duration * playback.loops
  if (age >= lifetime) {
    return {phase: "expired", age, frame: -1, loop: playback.loops - 1, progress: 1}
  }
  const loop = Math.min(playback.loops - 1, Math.floor(age / playback.duration))
  const loopAge = age - loop * playback.duration
  const progress = loopAge / playback.duration
  const frame = Math.min(layout.frameCount - 1, Math.floor(progress * layout.frameCount))
  return {phase: "active", age, frame, loop, progress}
}

/**
 * UV rectangle of `frame` as `[u, v, width, height]` in texture space with `v` growing upward,
 * for an atlas image whose first row is the top row.
 *
 * Without `texelInset` the rectangle spans the cell's exact boundaries, which is cell-safe only for
 * nearest filtering. For bilinear filtering pass `texelInset: {width, height}`, the atlas size in
 * pixels: the rectangle then shrinks by half a texel on every side, so samples at the cell edge
 * stop at the outermost texel centers and never blend texels from the adjacent frame. Cells must
 * span whole texels (`width % columns === 0`, `height % rows === 0`) for this to hold.
 */
export function flipbookFrameRect(layout, frame, target = [0, 0, 0, 0], texelInset = undefined) {
  const column = frame % layout.columns
  const row = Math.floor(frame / layout.columns)
  const width = 1 / layout.columns
  const height = 1 / layout.rows
  const insetU = texelInset ? 0.5 / texelInset.width : 0
  const insetV = texelInset ? 0.5 / texelInset.height : 0
  target[0] = column * width + insetU
  target[1] = 1 - (row + 1) * height + insetV
  target[2] = width - 2 * insetU
  target[3] = height - 2 * insetV
  return target
}

/**
 * Validates that an atlas of `width x height` pixels divides into whole-texel cells for `layout`,
 * so every frame's texels belong to exactly one cell and edge sampling can stay inside it.
 */
export function requireWholeTexelCells(layout, width, height) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new FlipbookContractError("flipbook atlas width and height must be positive integers")
  }
  if (width % layout.columns !== 0 || height % layout.rows !== 0) {
    throw new FlipbookContractError(
      `flipbook atlas ${width}x${height} must divide into whole-texel cells for ${layout.columns}x${layout.rows}`,
    )
  }
}

// Seeded cosmetic bursts: a fixed number of independently moving billboard particles, each playing
// the flipbook once over its own lifetime. Sampling is stateless like `sampleFlipbook`: a particle's
// state is a closed-form function of (burst, index, time), so seeking and any update partition give
// identical output and replay is a new `startTime` (or `seed`). Nothing here owns game randomness.

/** Upper bound on `count` for one burst; renderers additionally cap drawn particles per frame. */
export const MAX_BURST_PARTICLES = 256

const UINT32 = 0x1_0000_0000

// Integer hash (lowbias32) of seed, particle index, and channel; returns a uniform value in [0, 1).
function random(seed, index, channel) {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return (x >>> 0) / UINT32
}

function requireFiniteVector(name, value) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new FlipbookContractError(`${name} must contain exactly 3 finite numbers`)
  }
}

/**
 * Validates one burst's emission and motion and returns the normalized burst. Fields:
 * `startTime`, `seed` (uint32), `count` (1..MAX_BURST_PARTICLES), `lifetime` (> 0, one flipbook
 * pass per particle), `emitDuration` (>= 0, default 0: particle `i` starts at
 * `startTime + emitDuration * i / count`), `speed` (number or `[min, max]`, >= 0), `direction`
 * (non-zero, default up `[0, 1, 0]`), `spread` (cone half-angle in radians, 0..PI, default PI),
 * `gravity` (constant acceleration, default `[0, 0, 0]`), `endScale` (size multiplier reached at
 * the end of each particle's life, >= 0, default 1), and `fadeOut` (alpha falls linearly to 0,
 * default false).
 */
export function compileBurst(burst) {
  if (!burst || typeof burst !== "object") throw new FlipbookContractError("burst must be an object")
  if (!Number.isFinite(burst.startTime)) throw new FlipbookContractError("burst startTime must be finite")
  if (!Number.isInteger(burst.seed) || burst.seed < 0 || burst.seed >= UINT32) {
    throw new FlipbookContractError("burst seed must be a uint32 integer")
  }
  if (!Number.isSafeInteger(burst.count) || burst.count < 1 || burst.count > MAX_BURST_PARTICLES) {
    throw new FlipbookContractError(`burst count must be an integer from 1 to ${MAX_BURST_PARTICLES}`)
  }
  if (!Number.isFinite(burst.lifetime) || burst.lifetime <= 0) {
    throw new FlipbookContractError("burst lifetime must be finite and positive")
  }
  const emitDuration = burst.emitDuration ?? 0
  if (!Number.isFinite(emitDuration) || emitDuration < 0) {
    throw new FlipbookContractError("burst emitDuration must be finite and non-negative")
  }
  const speed = typeof burst.speed === "number" ? [burst.speed, burst.speed] : burst.speed
  if (!Array.isArray(speed) || speed.length !== 2 || !speed.every(Number.isFinite) || speed[0] < 0 || speed[1] < speed[0]) {
    throw new FlipbookContractError("burst speed must be a non-negative number or [min, max] with min <= max")
  }
  const direction = burst.direction ?? [0, 1, 0]
  requireFiniteVector("burst direction", direction)
  const length = Math.hypot(direction[0], direction[1], direction[2])
  if (!(length > 0) || !Number.isFinite(length)) throw new FlipbookContractError("burst direction must be non-zero")
  const spread = burst.spread ?? Math.PI
  if (!Number.isFinite(spread) || spread < 0 || spread > Math.PI) {
    throw new FlipbookContractError("burst spread must be between 0 and PI radians")
  }
  const gravity = burst.gravity ?? [0, 0, 0]
  requireFiniteVector("burst gravity", gravity)
  const endScale = burst.endScale ?? 1
  if (!Number.isFinite(endScale) || endScale < 0) throw new FlipbookContractError("burst endScale must be non-negative")
  if (burst.fadeOut !== undefined && typeof burst.fadeOut !== "boolean") {
    throw new FlipbookContractError("burst fadeOut must be a boolean")
  }

  // Orthonormal basis (tangent, bitangent, axis) around the emission axis.
  const axis = direction.map((component) => component / length)
  const helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const tangent = normalize(cross(helper, axis))
  const bitangent = cross(axis, tangent)
  return Object.freeze({
    startTime: burst.startTime,
    seed: burst.seed,
    count: burst.count,
    lifetime: burst.lifetime,
    emitDuration,
    speed: Object.freeze([speed[0], speed[1]]),
    axis: Object.freeze(axis),
    tangent: Object.freeze(tangent),
    bitangent: Object.freeze(bitangent),
    cosSpread: Math.cos(spread),
    gravity: Object.freeze([gravity[0], gravity[1], gravity[2]]),
    endScale,
    fadeOut: burst.fadeOut ?? false,
  })
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2])
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** Absolute start time of particle `index` of a compiled burst. */
export function burstParticleStartTime(burst, index) {
  return burst.startTime + (burst.emitDuration * index) / burst.count
}

/**
 * Samples particle `index` of a compiled burst at absolute `time`. Like `sampleFlipbook` the
 * particle is `pending` before its start, `active` for `lifetime`, then `expired`. While active,
 * `offset` is its displacement from the burst origin (`velocity * age + gravity * age^2 / 2`, with
 * the velocity drawn once from the seed uniformly over the spread cone and speed range), `size` the
 * scale multiplier (`1 -> endScale`), and `opacity` the alpha multiplier (`1`, or `1 -> 0` with
 * `fadeOut`). Writes into and returns `target` when given.
 */
export function sampleBurstParticle(layout, burst, index, time, target = undefined) {
  if (!Number.isFinite(time)) throw new FlipbookContractError("burst sample time must be finite")
  const sample = target ?? {phase: "pending", age: 0, frame: -1, progress: 0, offset: [0, 0, 0], size: 0, opacity: 0}
  const startTime = burstParticleStartTime(burst, index)
  const age = time - startTime
  if (!Number.isFinite(age)) throw new FlipbookContractError("burst age must be finite")
  sample.age = age
  sample.offset[0] = 0
  sample.offset[1] = 0
  sample.offset[2] = 0
  if (age < 0 || age >= burst.lifetime) {
    sample.phase = age < 0 ? "pending" : "expired"
    sample.frame = -1
    sample.progress = age < 0 ? 0 : 1
    sample.size = 0
    sample.opacity = 0
    return sample
  }
  const progress = age / burst.lifetime
  const cosTheta = 1 - random(burst.seed, index, 0) * (1 - burst.cosSpread)
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
  const phi = 2 * Math.PI * random(burst.seed, index, 1)
  const speed = burst.speed[0] + (burst.speed[1] - burst.speed[0]) * random(burst.seed, index, 2)
  const along = sinTheta * Math.cos(phi)
  const across = sinTheta * Math.sin(phi)
  const halfAgeSquared = 0.5 * age * age
  for (let axis = 0; axis < 3; axis += 1) {
    const direction = burst.tangent[axis] * along + burst.bitangent[axis] * across + burst.axis[axis] * cosTheta
    sample.offset[axis] = direction * speed * age + burst.gravity[axis] * halfAgeSquared
  }
  sample.phase = "active"
  sample.progress = progress
  sample.frame = Math.min(layout.frameCount - 1, Math.floor(progress * layout.frameCount))
  sample.size = 1 + (burst.endScale - 1) * progress
  sample.opacity = burst.fadeOut ? 1 - progress : 1
  return sample
}

/** Samples every particle of a compiled burst at `time` (allocating; convenient for baking/tests). */
export function sampleBurst(layout, burst, time) {
  return Array.from({length: burst.count}, (_, index) => sampleBurstParticle(layout, burst, index, time))
}
