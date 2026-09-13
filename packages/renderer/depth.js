export function webGpuProjectionToWebGl(values) {
  const converted = [...values]
  for (const index of [2, 6, 10, 14]) {
    converted[index] = 2 * values[index] - values[index + 1]
  }
  return converted
}
