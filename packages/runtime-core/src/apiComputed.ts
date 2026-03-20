/**
 * 文件说明：导出计算属性 API 的运行时包装，补充开发环境下的递归警告支持。
 */
import { type ComputedRefImpl, computed as _computed } from '@vue/reactivity'
import { getCurrentInstance, isInSSRComponentSetup } from './component'

/**
 * 封装 `computed` 辅助逻辑。
 */

export const computed: typeof _computed = (
  getterOrOptions: any,
  debugOptions?: any,
) => {
  // @ts-expect-error
  const c = _computed(getterOrOptions, debugOptions, isInSSRComponentSetup)
  if (__DEV__) {
    const i = getCurrentInstance()
    if (i && i.appContext.config.warnRecursiveComputed) {
      ;(c as unknown as ComputedRefImpl<any>)._warnRecursive = true
    }
  }
  return c as any
}
