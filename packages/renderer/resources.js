export function acquireResource(cache, key, createResource) {
  const cached = cache.get(key)
  if (cached !== undefined) {
    return {resource: cached, created: false}
  }

  const resource = createResource()
  cache.set(key, resource)
  return {resource, created: true}
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
