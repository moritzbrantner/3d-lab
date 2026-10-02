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
