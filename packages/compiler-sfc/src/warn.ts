/**
 * `compiler-sfc` 统一警告输出入口。
 */
const hasWarned: Record<string, boolean> = {}

/**
 * 同一条警告在非测试、非生产环境下只输出一次。
 */
export function warnOnce(msg: string): void {
  const isNodeProd =
    typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
  if (!isNodeProd && !__TEST__ && !hasWarned[msg]) {
    hasWarned[msg] = true
    warn(msg)
  }
}

/**
 * 输出带有 `compiler-sfc` 前缀的控制台警告。
 */
export function warn(msg: string): void {
  console.warn(
    `\x1b[1m\x1b[33m[@vue/compiler-sfc]\x1b[0m\x1b[33m ${msg}\x1b[0m\n`,
  )
}
