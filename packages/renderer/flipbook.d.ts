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
