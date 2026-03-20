/**
 * 为 `compiler-sfc` 提供统一的轻量缓存封装。
 *
 * Node 环境优先使用 LRU，浏览器/全局构建则退回普通 `Map`。
 */
import { LRUCache } from 'lru-cache'

/**
 * 根据运行环境创建缓存容器。
 */
export function createCache<T extends {}>(
  max = 500,
): Map<string, T> | LRUCache<string, T> {
  /* v8 ignore next 3 */
  if (__GLOBAL__ || __ESM_BROWSER__) {
    return new Map<string, T>()
  }
  return new LRUCache({ max })
}
