/**
 * 文件说明：兼容 Vue 2 函数式组件写法，包装成 Vue 3 可运行的形式。
 */
import {
  type ComponentOptions,
  type FunctionalComponent,
  getCurrentInstance,
} from '../component'
import { resolveInjections } from '../componentOptions'
import type { InternalSlots } from '../componentSlots'
import { getCompatListeners } from './instanceListeners'
import { compatH } from './renderFn'

const normalizedFunctionalComponentMap = new WeakMap<
  ComponentOptions,
  FunctionalComponent
>()
export const legacySlotProxyHandlers: ProxyHandler<InternalSlots> = {
  /**
   * 读取目标值。
   */

  get(target, key: string) {
    const slot = target[key]
    return slot && slot()
  },
}

/**
 * 封装 `convertLegacyFunctionalComponent` 辅助逻辑。
 */

export function convertLegacyFunctionalComponent(
  comp: ComponentOptions,
): FunctionalComponent {
  if (normalizedFunctionalComponentMap.has(comp)) {
    return normalizedFunctionalComponentMap.get(comp)!
  }

  const legacyFn = comp.render as any

  /**
   * 封装 `Func` 辅助逻辑。
   */

  const Func: FunctionalComponent = (props, ctx) => {
    const instance = getCurrentInstance()!

    const legacyCtx = {
      props,
      children: instance.vnode.children || [],
      data: instance.vnode.props || {},
      scopedSlots: ctx.slots,
      parent: instance.parent && instance.parent.proxy,

      /**
       * 封装 `slots` 辅助逻辑。
       */
      slots() {
        return new Proxy(ctx.slots, legacySlotProxyHandlers)
      },

      /**
       * 读取`listeners`。
       */
      get listeners() {
        return getCompatListeners(instance)
      },

      /**
       * 读取`injections`。
       */
      get injections() {
        if (comp.inject) {
          const injections = {}
          resolveInjections(comp.inject, injections)
          return injections
        }
        return {}
      },
    }
    return legacyFn(compatH, legacyCtx)
  }
  Func.props = comp.props
  Func.displayName = comp.name
  Func.compatConfig = comp.compatConfig
  // v2 functional components do not inherit attrs
  Func.inheritAttrs = false

  normalizedFunctionalComponentMap.set(comp, Func)
  return Func
}
