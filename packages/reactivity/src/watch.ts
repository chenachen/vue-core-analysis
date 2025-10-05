import {
  EMPTY_OBJ,
  NOOP,
  hasChanged,
  isArray,
  isFunction,
  isMap,
  isObject,
  isPlainObject,
  isSet,
  remove,
} from '@vue/shared'
import { warn } from './warning'
import type { ComputedRef } from './computed'
import { ReactiveFlags } from './constants'
import {
  type DebuggerOptions,
  EffectFlags,
  type EffectScheduler,
  ReactiveEffect,
  pauseTracking,
  resetTracking,
} from './effect'
import { isReactive, isShallow } from './reactive'
import { type Ref, isRef } from './ref'
import { getCurrentScope } from './effectScope'

// These errors were transferred from `packages/runtime-core/src/errorHandling.ts`
// to @vue/reactivity to allow co-location with the moved base watch logic, hence
// it is essential to keep these values unchanged.
/**
 * watch API 内部使用的错误码，用于区分不同类型的错误。
 *
 * @enum {number}
 * @property {number} WATCH_GETTER - 在评估 watch 源/getter 时发生的错误。
 * @property {number} WATCH_CALLBACK - 在 watch 回调函数中发生的错误。
 * @property {number} WATCH_CLEANUP - 在 watch 清理阶段发生的错误。
 */
export enum WatchErrorCodes {
  WATCH_GETTER = 2,
  WATCH_CALLBACK,
  WATCH_CLEANUP,
}

export type WatchEffect = (onCleanup: OnCleanup) => void

export type WatchSource<T = any> = Ref<T, any> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onCleanup: OnCleanup,
) => any

export type OnCleanup = (cleanupFn: () => void) => void

/**
 * `WatchOptions` 接口用于配置 Vue 响应式系统中的侦听器（watcher）行为。
 *
 * @template Immediate - 控制 `immediate` 选项的类型，默认为 `boolean`。
 *
 * @property {Immediate} [immediate] 是否在侦听器创建时立即执行回调函数。
 * @property {boolean | number} [deep] 是否深度侦听对象内部的属性变化，或指定递归深度。
 * @property {boolean} [once] 是否只触发一次回调，触发后自动停止侦听。
 * @property {WatchScheduler} [scheduler] 自定义调度函数，用于控制回调的执行时机。
 * @property {(msg: string, ...args: any[]) => void} [onWarn] 自定义警告处理函数。
 * @property {(job: (...args: any[]) => void) => void} [augmentJob] （内部使用）增强侦听任务的函数。
 * @property {(fn: Function | Function[], type: WatchErrorCodes, args?: unknown[]) => void} [call] （内部使用）自定义回调调用方式。
 */
export interface WatchOptions<Immediate = boolean> extends DebuggerOptions {
  immediate?: Immediate
  deep?: boolean | number
  once?: boolean
  scheduler?: WatchScheduler
  onWarn?: (msg: string, ...args: any[]) => void
  /**
   * @internal
   */
  augmentJob?: (job: (...args: any[]) => void) => void
  /**
   * @internal
   */
  call?: (
    fn: Function | Function[],
    type: WatchErrorCodes,
    args?: unknown[],
  ) => void
}

export type WatchStopHandle = () => void

export interface WatchHandle extends WatchStopHandle {
  pause: () => void
  resume: () => void
  stop: () => void
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

export type WatchScheduler = (job: () => void, isFirstRun: boolean) => void

const cleanupMap: WeakMap<ReactiveEffect, (() => void)[]> = new WeakMap()
let activeWatcher: ReactiveEffect | undefined = undefined

/**
 * Returns the current active effect if there is one.
 */
export function getCurrentWatcher(): ReactiveEffect<any> | undefined {
  return activeWatcher
}

/**
 * 为指定的响应式副作用（ReactiveEffect）注册一个清理函数。
 * 该清理函数会在副作用重新执行前被调用，常用于 watch 监听器中做资源释放等操作。
 *
 * @param cleanupFn - 要注册的清理函数。
 * @param failSilently - 如果为 true，则在没有活跃副作用时不会警告，默认为 false。
 * @param owner - 要关联的副作用对象，默认是当前活跃的副作用（activeWatcher）。
 */
export function onWatcherCleanup(
  cleanupFn: () => void,
  failSilently = false,
  owner: ReactiveEffect | undefined = activeWatcher,
): void {
  if (owner) {
    let cleanups = cleanupMap.get(owner)
    if (!cleanups) cleanupMap.set(owner, (cleanups = []))
    cleanups.push(cleanupFn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onWatcherCleanup() was called when there was no active watcher` +
        ` to associate with.`,
    )
  }
}

export function watch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb?: WatchCallback | null,
  options: WatchOptions = EMPTY_OBJ,
): WatchHandle {
  const { immediate, deep, once, scheduler, augmentJob, call } = options

  const warnInvalidSource = (s: unknown) => {
    ;(options.onWarn || warn)(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`,
    )
  }

  const reactiveGetter = (source: object) => {
    // 如果是deep，则直接返回源数据
    // traverse will happen in wrapped getter below
    if (deep) return source
    // for `deep: false | 0` or shallow reactive, only traverse root-level properties
    // 只监听最浅一层对象数据
    if (isShallow(source) || deep === false || deep === 0)
      return traverse(source, 1)
    // for `deep: undefined` on a reactive object, deeply traverse all properties
    // 深度递归所有属性
    // 这与vue2侦听对象时不太一致，如果传入的是响应式对象，默认就深度监听
    // const obj = reactive({ a: 1, b: { c: 2 } })
    // watch(obj, cb) // 默认深度监听
    return traverse(source)
  }

  // 定义一个响应式副作用对象，用于管理依赖的响应式数据和副作用逻辑
  let effect: ReactiveEffect
  // 定义一个函数，用于获取响应式数据的值或执行副作用逻辑
  let getter: () => any
  // 定义一个可选的清理函数，用于在副作用重新执行前清理资源
  let cleanup: (() => void) | undefined
  // 定义一个绑定的清理函数，用于注册清理逻辑到当前的响应式副作用
  let boundCleanup: typeof onWatcherCleanup
  // 定义一个布尔值，指示是否强制触发副作用逻辑
  let forceTrigger = false
  // 定义一个布尔值，指示是否有多个数据源
  let isMultiSource = false

  // 根据不同的 source 类型，设置 getter 函数
  if (isRef(source)) {
    // 如果 source 是一个 ref，则设置 getter 为获取 ref 的值，并根据是否为浅层 ref 设置 forceTrigger
    getter = () => source.value
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    // 如果 source 是一个响应式对象，则设置 getter 为获取响应式对象的值，并强制触发
    getter = () => reactiveGetter(source)
    forceTrigger = true
  } else if (isArray(source)) {
    // 如果 source 是一个数组，则处理多个数据源
    isMultiSource = true
    // 如果数组中有响应式对象或浅层 ref，则设置 forceTrigger 为 true
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
    // 设置 getter 为遍历数组，获取每个数据源的值
    getter = () =>
      // 监听多个来源时，遍历每个来源，返回一个包含所有来源值的数组
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return reactiveGetter(s)
        } else if (isFunction(s)) {
          return call ? call(s, WatchErrorCodes.WATCH_GETTER) : s()
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    /**
     * source是函数时，获取函数返回值
     * 例子：
     * watch(() => someReactiveObject.someProperty, cb)
     */
    if (cb) {
      // getter with cb
      getter = call
        ? () => call(source, WatchErrorCodes.WATCH_GETTER)
        : (source as () => any)
    } else {
      // no cb -> simple effect
      // 没有cb则对应这种场景
      // test('effect', () => {
      //   let dummy: any
      //   const source = ref(0)
      //   watch(() => {
      //     dummy = source.value
      //   })
      //   expect(dummy).toBe(0)
      //   source.value++
      //   expect(dummy).toBe(1)
      // })
      getter = () => {
        // 如果清理函数存在，则先暂停追踪，执行清理函数，最后重置追踪状态
        if (cleanup) {
          pauseTracking()
          try {
            cleanup()
          } finally {
            resetTracking()
          }
        }
        // 设置当前effect为activeWatcher
        const currentEffect = activeWatcher
        activeWatcher = effect
        try {
          // 如果call存在则调用，否则直接执行source函数
          return call
            ? call(source, WatchErrorCodes.WATCH_CALLBACK, [boundCleanup])
            : source(boundCleanup)
        } finally {
          // 回退状态
          activeWatcher = currentEffect
        }
      }
    }
  } else {
    // 如果 source 类型无效，则设置 getter 为 NOOP，并在开发环境下发出警告
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  if (cb && deep) {
    const baseGetter = getter
    const depth = deep === true ? Infinity : deep
    // 深度遍历时，递归执行getter
    getter = () => traverse(baseGetter(), depth)
  }

  // 获取当前作用域
  const scope = getCurrentScope()

  /**
   * 停止监听函数
   * const unwatch = watch(source, cb)
   * unwatch就是执行这个函数
   */
  const watchHandle: WatchHandle = () => {
    // 暂停本effect执行和监听
    effect.stop()
    // 如果当前作用域活跃中，将本effect在作用域中移除
    if (scope && scope.active) {
      remove(scope.effects, effect)
    }
  }

  // 如果选项中带once参数，则将callback函数重新赋值，执行一次后移除响应的effect
  if (once && cb) {
    const _cb = cb
    cb = (...args) => {
      _cb(...args)
      watchHandle()
    }
  }

  // 记录旧值
  let oldValue: any = isMultiSource
    ? new Array((source as []).length).fill(INITIAL_WATCHER_VALUE)
    : INITIAL_WATCHER_VALUE

  const job = (immediateFirstRun?: boolean) => {
    // 当前effect函数未激活，或者effect函数未脏且不是首次执行，则直接返回
    if (
      !(effect.flags & EffectFlags.ACTIVE) ||
      (!effect.dirty && !immediateFirstRun)
    ) {
      return
    }
    if (cb) {
      // watch(source, cb)， 执行effect函数得到新值
      const newValue = effect.run()
      if (
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) => hasChanged(v, oldValue[i]))
          : hasChanged(newValue, oldValue))
      ) {
        // 深度监听或强制触发或值发生变更，执行以下逻辑
        // cleanup before running cb again
        // 执行回调函数前先执行清理函数
        if (cleanup) {
          cleanup()
        }
        // 设置当前effect为activeWatcher
        const currentWatcher = activeWatcher
        activeWatcher = effect
        try {
          // 参数处理，用于执行callback函数
          const args = [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            // 如果是第一次变更则传undefined，否则传oldValue
            oldValue === INITIAL_WATCHER_VALUE
              ? undefined
              : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE
                ? []
                : oldValue,
            boundCleanup,
          ]
          // 缓存当前值为oldValue
          oldValue = newValue
          // 执行callback函数
          call
            ? call(cb!, WatchErrorCodes.WATCH_CALLBACK, args)
            : // @ts-expect-error
              cb!(...args)
        } finally {
          // 执行完毕回退状态
          activeWatcher = currentWatcher
        }
      }
    } else {
      // watchEffect
      effect.run()
    }
  }

  // 目前仅发现apiWatch.ts中使用了augmentJob
  if (augmentJob) {
    augmentJob(job)
  }

  // 创建一个effect函数，监听getter中涉及的响应式数据变化时触发执行
  effect = new ReactiveEffect(getter)

  // 设置调度器，在响应式数据变化时执行job函数
  effect.scheduler = scheduler
    ? () => scheduler(job, false)
    : (job as EffectScheduler)

  /**
   * 绑定清理函数
   * watch(source, (newValue, oldValue, onCleanup <- boundCleanup就是这个 ) => {})
   */
  boundCleanup = fn => onWatcherCleanup(fn, false, effect)

  // 设置effect的onStop钩子函数，在effect停止时执行
  cleanup = effect.onStop = () => {
    const cleanups = cleanupMap.get(effect)
    if (cleanups) {
      if (call) {
        call(cleanups, WatchErrorCodes.WATCH_CLEANUP)
      } else {
        for (const cleanup of cleanups) cleanup()
      }
      cleanupMap.delete(effect)
    }
  }

  if (__DEV__) {
    effect.onTrack = options.onTrack
    effect.onTrigger = options.onTrigger
  }

  // initial run
  // 初始化执行
  if (cb) {
    if (immediate) {
      job(true)
    } else {
      oldValue = effect.run()
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true)
  } else {
    effect.run()
  }

  // 绑定pause、resume和stop方法到watchHandle
  watchHandle.pause = effect.pause.bind(effect)
  watchHandle.resume = effect.resume.bind(effect)
  watchHandle.stop = watchHandle

  return watchHandle
}

export function traverse(
  value: unknown,
  depth: number = Infinity,
  seen?: Set<unknown>,
): unknown {
  /**
   * 递归终止条件：
   * 1. depth小于等于0
   * 2. value不是对象
   * 3. value是ReactiveFlags.SKIP标记的对象
   */
  if (depth <= 0 || !isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }

  // 为了避免循环引用导致的无限递归，函数使用 seen 集合记录已经遍历过的值：
  seen = seen || new Set()
  if (seen.has(value)) {
    return value
  }
  // 将当前值添加到 seen 集合中，表示已经遍历过
  seen.add(value)
  // 递归遍历深度减1
  depth--
  // 如果是ref类型，递归遍历其value属性
  if (isRef(value)) {
    traverse(value.value, depth, seen)
  } else if (isArray(value)) {
    // 如果是数组类型，递归遍历每个元素
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen)
    }
  } else if (isSet(value) || isMap(value)) {
    // 如果是Set或Map类型，递归遍历其每个元素
    value.forEach((v: any) => {
      traverse(v, depth, seen)
    })
  } else if (isPlainObject(value)) {
    // 如果是普通对象，递归遍历其每个属性
    for (const key in value) {
      traverse(value[key], depth, seen)
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      // 确保遍历对象的Symbol属性
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key as any], depth, seen)
      }
    }
  }
  // 返回遍历后的值
  return value
}
