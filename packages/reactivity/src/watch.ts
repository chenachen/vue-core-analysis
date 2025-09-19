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
 * Registers a cleanup callback on the current active effect. This
 * registered cleanup callback will be invoked right before the
 * associated effect re-runs.
 * 为当前effect注册一个清理函数，这个注册的清理函数会在相关的effect重新运行之前调用
 *
 * @param cleanupFn - The callback function to attach to the effect's cleanup.
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 * @param owner - The effect that this cleanup function should be attached to.
 * By default, the current active effect.
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
    return traverse(source)
  }

  let effect: ReactiveEffect
  let getter: () => any
  let cleanup: (() => void) | undefined
  let boundCleanup: typeof onWatcherCleanup
  let forceTrigger = false
  let isMultiSource = false

  // 根据不同的 source 类型，设置 getter 函数
  if (isRef(source)) {
    getter = () => source.value
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    getter = () => reactiveGetter(source)
    forceTrigger = true
  } else if (isArray(source)) {
    isMultiSource = true
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
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
