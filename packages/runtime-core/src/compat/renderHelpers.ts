/**
 * 文件说明：兼容 Vue 2 render 助手函数，如绑定 props、listeners 等旧式辅助逻辑。
 */
import {
  camelize,
  extend,
  hyphenate,
  isArray,
  isObject,
  isReservedProp,
  normalizeClass,
} from '@vue/shared'
import type { ComponentInternalInstance, Data } from '../component'
import type { Slot } from '../componentSlots'
import { createSlots } from '../helpers/createSlots'
import { renderSlot } from '../helpers/renderSlot'
import { toHandlers } from '../helpers/toHandlers'
import { type VNode, mergeProps } from '../vnode'

/**
 * 封装 `toObject` 辅助逻辑。
 */

function toObject(arr: Array<any>): Object {
  const res = {}
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]) {
      extend(res, arr[i])
    }
  }
  return res
}

/**
 * 封装 `legacyBindObjectProps` 辅助逻辑。
 */

export function legacyBindObjectProps(
  data: any,
  _tag: string,
  value: any,
  _asProp: boolean,
  isSync?: boolean,
): any {
  if (value && isObject(value)) {
    if (isArray(value)) {
      value = toObject(value)
    }
    for (const key in value) {
      if (isReservedProp(key)) {
        data[key] = value[key]
      } else if (key === 'class') {
        data.class = normalizeClass([data.class, value.class])
      } else if (key === 'style') {
        data.style = normalizeClass([data.style, value.style])
      } else {
        const attrs = data.attrs || (data.attrs = {})
        const camelizedKey = camelize(key)
        const hyphenatedKey = hyphenate(key)
        if (!(camelizedKey in attrs) && !(hyphenatedKey in attrs)) {
          attrs[key] = value[key]

          if (isSync) {
            const on = data.on || (data.on = {})
            on[`update:${key}`] = function ($event: any) {
              value[key] = $event
            }
          }
        }
      }
    }
  }
  return data
}

/**
 * 封装 `legacyBindObjectListeners` 辅助逻辑。
 */

export function legacyBindObjectListeners(props: any, listeners: any): Data {
  return mergeProps(props, toHandlers(listeners))
}

/**
 * 封装 `legacyRenderSlot` 辅助逻辑。
 */

export function legacyRenderSlot(
  instance: ComponentInternalInstance,
  name: string,
  fallback?: VNode[],
  props?: any,
  bindObject?: any,
): VNode {
  if (bindObject) {
    props = mergeProps(props, bindObject)
  }
  return renderSlot(instance.slots, name, props, fallback && (() => fallback))
}

type LegacyScopedSlotsData = Array<
  | {
      key: string
      fn: Function
    }
  | LegacyScopedSlotsData
>

/**
 * 封装 `legacyresolveScopedSlots` 辅助逻辑。
 */

export function legacyresolveScopedSlots(
  fns: LegacyScopedSlotsData,
  raw?: Record<string, Slot>,
  // the following are added in 2.6
  hasDynamicKeys?: boolean,
): ReturnType<typeof createSlots> {
  // v2 default slot doesn't have name
  return createSlots(
    raw || ({ $stable: !hasDynamicKeys } as any),
    mapKeyToName(fns),
  )
}

/**
 * 封装 `mapKeyToName` 辅助逻辑。
 */

function mapKeyToName(slots: LegacyScopedSlotsData) {
  for (let i = 0; i < slots.length; i++) {
    const fn = slots[i]
    if (fn) {
      if (isArray(fn)) {
        mapKeyToName(fn)
      } else {
        ;(fn as any).name = fn.key || 'default'
      }
    }
  }
  return slots as any
}

const staticCacheMap =
  /*@__PURE__*/
  new WeakMap<ComponentInternalInstance, any[]>()

/**
 * 封装 `legacyRenderStatic` 辅助逻辑。
 */

export function legacyRenderStatic(
  instance: ComponentInternalInstance,
  index: number,
): any {
  let cache = staticCacheMap.get(instance)
  if (!cache) {
    staticCacheMap.set(instance, (cache = []))
  }
  if (cache[index]) {
    return cache[index]
  }
  const fn = (instance.type as any).staticRenderFns[index]
  const ctx = instance.proxy
  return (cache[index] = fn.call(ctx, null, ctx))
}

/**
 * 封装 `legacyCheckKeyCodes` 辅助逻辑。
 */

export function legacyCheckKeyCodes(
  instance: ComponentInternalInstance,
  eventKeyCode: number,
  key: string,
  builtInKeyCode?: number | number[],
  eventKeyName?: string,
  builtInKeyName?: string | string[],
): boolean | undefined {
  const config = instance.appContext.config as any
  const configKeyCodes = config.keyCodes || {}
  const mappedKeyCode = configKeyCodes[key] || builtInKeyCode
  if (builtInKeyName && eventKeyName && !configKeyCodes[key]) {
    return isKeyNotMatch(builtInKeyName, eventKeyName)
  } else if (mappedKeyCode) {
    return isKeyNotMatch(mappedKeyCode, eventKeyCode)
  } else if (eventKeyName) {
    return hyphenate(eventKeyName) !== key
  }
}

/**
 * 判断当前是否满足key`not``match`。
 */

function isKeyNotMatch<T>(expect: T | T[], actual: T): boolean {
  if (isArray(expect)) {
    return !expect.includes(actual)
  } else {
    return expect !== actual
  }
}

/**
 * 封装 `legacyMarkOnce` 辅助逻辑。
 */

export function legacyMarkOnce(tree: VNode): VNode {
  return tree
}

/**
 * 封装 `legacyBindDynamicKeys` 辅助逻辑。
 */

export function legacyBindDynamicKeys(props: any, values: any[]): any {
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]
    if (typeof key === 'string' && key) {
      props[values[i]] = values[i + 1]
    }
  }
  return props
}

/**
 * 封装 `legacyPrependModifier` 辅助逻辑。
 */

export function legacyPrependModifier(value: any, symbol: string): any {
  return typeof value === 'string' ? symbol + value : value
}
