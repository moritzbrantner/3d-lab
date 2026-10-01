export function acquireResource(
  cache,
  key,
  createResource,
  createInput,
  observations,
  createdCountKey,
) {
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const resource = createResource(createInput)
  cache.set(key, resource)
  if (observations && createdCountKey) observations[createdCountKey] += 1
  return resource
}

export function evictUnusedResources(cache, liveKeys) {
  let evictedCount = 0
  for (const [key, resource] of cache) {
    if (liveKeys.has(key)) continue
    resource.dispose()
    cache.delete(key)
    evictedCount += 1
  }
  return evictedCount
}

/**
 * Record live cache sizes after a frame. Every node object and every instance batch owns exactly one
 * live Three.js mesh, so `liveObjectCount` includes instance batches; `liveInstanceBatchCount` is the
 * batch-specific subset. This keeps `liveObjectCount` consistent with object create/remove counts.
 */
export function recordLiveCacheCounts(observations, {objects, instanceBatches, geometries, materials}) {
  observations.liveObjectCount = objects.size + instanceBatches.size
  observations.liveGeometryCount = geometries.size
  observations.liveMaterialCount = materials.size
  observations.liveInstanceBatchCount = instanceBatches.size
}
