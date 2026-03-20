/**
 * 文件说明：兼容 Vue 2 实例方法和属性的代理访问。
 */
import {
  NOOP,
  extend,
  looseEqual,
  looseIndexOf,
  looseToNumber,
  toDisplayString,
} from '@vue/shared'
import type {
  ComponentPublicInstance,
  PublicPropertiesMap,
} from '../componentPublicInstance'
import { getCompatChildren } from './instanceChildren'
import {
  DeprecationTypes,
  assertCompatEnabled,
  isCompatEnabled,
  warnDeprecation,
} from './compatConfig'
import { off, on, once } from './instanceEventEmitter'
import { getCompatListeners } from './instanceListeners'
import { shallowReadonly } from '@vue/reactivity'
import { legacySlotProxyHandlers } from './componentFunctional'
import { compatH } from './renderFn'
import { createCommentVNode, createTextVNode } from '../vnode'
import { renderList } from '../helpers/renderList'
import {
  legacyBindDynamicKeys,
  legacyBindObjectListeners,
  legacyBindObjectProps,
  legacyCheckKeyCodes,
  legacyMarkOnce,
  legacyPrependModifier,
  legacyRenderSlot,
  legacyRenderStatic,
  legacyresolveScopedSlots,
} from './renderHelpers'
import { resolveFilter } from '../helpers/resolveAssets'
import type { Slots } from '../componentSlots'
import { resolveMergedOptions } from '../componentOptions'

export type LegacyPublicInstance = ComponentPublicInstance &
  LegacyPublicProperties

export interface LegacyPublicProperties {
  $set<T extends Record<keyof any, any>, K extends keyof T>(
    target: T,
    key: K,
    value: T[K],
  ): void
  $delete<T extends Record<keyof any, any>, K extends keyof T>(
    target: T,
    key: K,
  ): void
  $mount(el?: string | Element): this
  $destroy(): void
  $scopedSlots: Slots
  $on(event: string | string[], fn: Function): this
  $once(event: string, fn: Function): this
  $off(event?: string | string[], fn?: Function): this
  $children: LegacyPublicProperties[]
  $listeners: Record<string, Function | Function[]>
}

/**
 * 封装 `installCompatInstanceProperties` 辅助逻辑。
 */

export function installCompatInstanceProperties(
  map: PublicPropertiesMap,
): void {
  /**
   * 写入目标值。
   */

  const set = (target: any, key: any, val: any) => {
    target[key] = val
    return target[key]
  }

  /**
   * 封装 `del` 辅助逻辑。
   */

  const del = (target: any, key: any) => {
    delete target[key]
  }

  extend(map, {
    /**
     * 封装 `$set` 分支逻辑。
     */

    $set: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_SET, i)
      return set
    },

    /**
     * 封装 `$delete` 分支逻辑。
     */
    $delete: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_DELETE, i)
      return del
    },

    /**
     * 封装 `$mount` 分支逻辑。
     */
    $mount: i => {
      assertCompatEnabled(
        DeprecationTypes.GLOBAL_MOUNT,
        null /* this warning is global */,
      )
      // root mount override from ./global.ts in installCompatMount
      return i.ctx._compat_mount || NOOP
    },

    /**
     * 封装 `$destroy` 分支逻辑。
     */
    $destroy: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_DESTROY, i)
      // root destroy override from ./global.ts in installCompatMount
      return i.ctx._compat_destroy || NOOP
    },

    // overrides existing accessor
    $slots: i => {
      if (
        isCompatEnabled(DeprecationTypes.RENDER_FUNCTION, i) &&
        i.render &&
        i.render._compatWrapped
      ) {
        return new Proxy(i.slots, legacySlotProxyHandlers)
      }
      return __DEV__ ? shallowReadonly(i.slots) : i.slots
    },

    /**
     * 封装 `$scopedSlots` 分支逻辑。
     */
    $scopedSlots: i => {
      assertCompatEnabled(DeprecationTypes.INSTANCE_SCOPED_SLOTS, i)
      return __DEV__ ? shallowReadonly(i.slots) : i.slots
    },

    /**
     * 封装 `$on` 分支逻辑。
     */
    $on: i => on.bind(null, i),

    /**
     * 封装 `$once` 分支逻辑。
     */
    $once: i => once.bind(null, i),

    /**
     * 封装 `$off` 分支逻辑。
     */
    $off: i => off.bind(null, i),

    $children: getCompatChildren,
    $listeners: getCompatListeners,

    // inject additional properties into $options for compat
    // e.g. vuex needs this.$options.parent
    $options: i => {
      if (!isCompatEnabled(DeprecationTypes.PRIVATE_APIS, i)) {
        return resolveMergedOptions(i)
      }
      if (i.resolvedOptions) {
        return i.resolvedOptions
      }
      const res = (i.resolvedOptions = extend({}, resolveMergedOptions(i)))
      Object.defineProperties(res, {
        parent: {
          /**
           * 读取目标值。
           */

          get() {
            warnDeprecation(DeprecationTypes.PRIVATE_APIS, i, '$options.parent')
            return i.proxy!.$parent
          },
        },
        propsData: {
          /**
           * 读取目标值。
           */

          get() {
            warnDeprecation(
              DeprecationTypes.PRIVATE_APIS,
              i,
              '$options.propsData',
            )
            return i.vnode.props
          },
        },
      })
      return res
    },
  } as PublicPropertiesMap)

  const privateAPIs = {
    // needed by many libs / render fns
    $vnode: i => i.vnode,

    // some private properties that are likely accessed...
    _self: i => i.proxy,

    /**
     * 封装 `_uid` 分支逻辑。
     */
    _uid: i => i.uid,

    /**
     * 封装 `_data` 分支逻辑。
     */
    _data: i => i.data,

    /**
     * 封装 `_isMounted` 分支逻辑。
     */
    _isMounted: i => i.isMounted,

    /**
     * 封装 `_isDestroyed` 分支逻辑。
     */
    _isDestroyed: i => i.isUnmounted,

    // v2 render helpers
    $createElement: () => compatH,

    /**
     * 封装 `_c` 分支逻辑。
     */
    _c: () => compatH,

    /**
     * 封装 `_o` 分支逻辑。
     */
    _o: () => legacyMarkOnce,

    /**
     * 封装 `_n` 分支逻辑。
     */
    _n: () => looseToNumber,

    /**
     * 封装 `_s` 分支逻辑。
     */
    _s: () => toDisplayString,

    /**
     * 封装 `_l` 分支逻辑。
     */
    _l: () => renderList,

    /**
     * 封装 `_t` 分支逻辑。
     */
    _t: i => legacyRenderSlot.bind(null, i),

    /**
     * 封装 `_q` 分支逻辑。
     */
    _q: () => looseEqual,

    /**
     * 封装 `_i` 分支逻辑。
     */
    _i: () => looseIndexOf,

    /**
     * 封装 `_m` 分支逻辑。
     */
    _m: i => legacyRenderStatic.bind(null, i),

    /**
     * 封装 `_f` 分支逻辑。
     */
    _f: () => resolveFilter,

    /**
     * 封装 `_k` 分支逻辑。
     */
    _k: i => legacyCheckKeyCodes.bind(null, i),

    /**
     * 封装 `_b` 分支逻辑。
     */
    _b: () => legacyBindObjectProps,

    /**
     * 封装 `_v` 分支逻辑。
     */
    _v: () => createTextVNode,

    /**
     * 封装 `_e` 分支逻辑。
     */
    _e: () => createCommentVNode,

    /**
     * 封装 `_u` 分支逻辑。
     */
    _u: () => legacyresolveScopedSlots,

    /**
     * 封装 `_g` 分支逻辑。
     */
    _g: () => legacyBindObjectListeners,

    /**
     * 封装 `_d` 分支逻辑。
     */
    _d: () => legacyBindDynamicKeys,

    /**
     * 封装 `_p` 分支逻辑。
     */
    _p: () => legacyPrependModifier,
  } as PublicPropertiesMap

  for (const key in privateAPIs) {
    map[key] = i => {
      if (isCompatEnabled(DeprecationTypes.PRIVATE_APIS, i)) {
        return privateAPIs[key](i)
      }
    }
  }
}
