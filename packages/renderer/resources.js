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
