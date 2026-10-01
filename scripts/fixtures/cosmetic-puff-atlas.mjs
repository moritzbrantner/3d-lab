// Generated 2x2 impact/puff flipbook fixture shared by renderer tests and Chromium evidence.
// Each 8x8 cell is one solid opaque color so frame selection is readable from pixels; the corners
// of each cell are transparent so alpha blending is observable too.

export const PUFF_FRAME_COLORS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];

export function createPuffAtlas({ cell = 8, resourceKey = "fixture:puff-2x2", filter = "nearest" } = {}) {
  const columns = 2;
  const rows = 2;
  const width = cell * columns;
  const height = cell * rows;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const frame = Math.floor(y / cell) * columns + Math.floor(x / cell);
      const [r, g, b] = PUFF_FRAME_COLORS[frame];
      const localX = x % cell;
      const localY = y % cell;
      const corner = (localX === 0 || localX === cell - 1) && (localY === 0 || localY === cell - 1);
      pixels.set([r, g, b, corner ? 0 : 255], (y * width + x) * 4);
    }
  }
  return { resourceKey, width, height, pixels, columns, rows, frameCount: 4, filter };
}
