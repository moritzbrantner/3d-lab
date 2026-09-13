export function evictUnusedResources(cache, liveKeys) {
  for (const [key, resource] of cache) {
    if (liveKeys.has(key)) continue
    resource.dispose()
    cache.delete(key)
  }
}
