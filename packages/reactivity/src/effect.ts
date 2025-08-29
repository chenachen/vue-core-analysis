import { extend, hasChanged } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { type Link, globalVersion } from './dep'
import { activeEffectScope } from './effectScope'
import { warn } from './warning'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: Subscriber
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export let activeSub: Subscriber | undefined

export enum EffectFlags {
  /**
   * ReactiveEffect only
   */
  ACTIVE = 1 << 0, // 活跃状态
  RUNNING = 1 << 1, // 运行中
  TRACKING = 1 << 2, // 正在收集依赖
  NOTIFIED = 1 << 3, // 是否已通知需要重新执行
  DIRTY = 1 << 4, // 脏状态，需要重新执行
  ALLOW_RECURSE = 1 << 5, // 是否允许递归调用
  PAUSED = 1 << 6, // 是否暂停中
  EVALUATED = 1 << 7, // 已经评估
}

/**
 * Subscriber is a type that tracks (or subscribes to) a list of deps.
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * Head of the doubly linked list representing the deps
   * 依赖链表头部
   * @internal
   */
  deps?: Link
  /**
   * Tail of the same list
   * 依赖链表尾部
   * @internal
   */
  depsTail?: Link
  /**
   * @internal
   * 标记位
   */
  flags: EffectFlags
  /**
   * 下一个订阅者
   * @internal
   */
  next?: Subscriber
  /**
   * returning `true` indicates it's a computed that needs to call notify
   * on its dep too
   * 通知函数
   * 如果该函数返回true的话意味这是一个computed，需要调用它的dep的notify
   * @internal
   */
  notify(): true | void
}

const pausedQueueEffects = new WeakSet<ReactiveEffect>()

export class ReactiveEffect<T = any>
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * @internal
   */
  deps?: Link = undefined
  /**
   * @internal
   */
  depsTail?: Link = undefined
  /**
   * @internal
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * @internal
   */
  next?: Subscriber = undefined
  /**
   * @internal
   */
  cleanup?: () => void = undefined

  scheduler?: EffectScheduler = undefined
  onStop?: () => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  constructor(public fn: () => T) {
    // 判断是否有活跃的作用域，有的话放到作用域中
    if (activeEffectScope && activeEffectScope.active) {
      activeEffectScope.effects.push(this)
    }
  }

  // 暂停
  pause(): void {
    this.flags |= EffectFlags.PAUSED
  }

  // 恢复依赖收集
  resume(): void {
    if (this.flags & EffectFlags.PAUSED) {
      this.flags &= ~EffectFlags.PAUSED
      // 如果暂停期间有被触发过，则恢复后重新执行
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this)
        this.trigger()
      }
    }
  }

  /**
   * @internal
   */
  notify(): void {
    // 如果运行中且不允许递归，则跳过
    if (
      this.flags & EffectFlags.RUNNING &&
      !(this.flags & EffectFlags.ALLOW_RECURSE)
    ) {
      return
    }
    // 还没执行过通知
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      batch(this)
    }
  }

  run(): T {
    // TODO cleanupEffect

    // 如果当前实例不是活跃状态，直接执行fn并返回执行结果
    if (!(this.flags & EffectFlags.ACTIVE)) {
      // stopped during cleanup
      return this.fn()
    }

    // 设为执行状态
    this.flags |= EffectFlags.RUNNING
    // 执行cleanup函数, cleanup函数在onEffectCleanup中注册
    cleanupEffect(this)
    // 初始化依赖
    prepareDeps(this)
    // 将当前的活跃订阅设为本实例
    const prevEffect = activeSub
    const prevShouldTrack = shouldTrack
    activeSub = this
    shouldTrack = true

    try {
      // 运行函数
      return this.fn()
    } finally {
      if (__DEV__ && activeSub !== this) {
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      // 清除已执行的
      cleanupDeps(this)
      // 状态回滚
      activeSub = prevEffect
      shouldTrack = prevShouldTrack
      this.flags &= ~EffectFlags.RUNNING
    }
  }

  stop(): void {
    if (this.flags & EffectFlags.ACTIVE) {
      // 移除依赖
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }

      // 清空依赖
      this.deps = this.depsTail = undefined
      cleanupEffect(this)
      this.onStop && this.onStop()
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  trigger(): void {
    // 如果是暂停状态，把实例缓存到pausedQueueEffects
    if (this.flags & EffectFlags.PAUSED) {
      pausedQueueEffects.add(this)
    } else if (this.scheduler) {
      // 存在调度器则调用调度器
      this.scheduler()
    } else {
      this.runIfDirty()
    }
  }

  /**
   * @internal
   */
  runIfDirty(): void {
    if (isDirty(this)) {
      this.run()
    }
  }

  get dirty(): boolean {
    return isDirty(this)
  }
}

/**
 * For debugging
 */
// function printDeps(sub: Subscriber) {
//   let d = sub.deps
//   let ds = []
//   while (d) {
//     ds.push(d)
//     d = d.nextDep
//   }
//   return ds.map(d => ({
//     id: d.id,
//     prev: d.prevDep?.id,
//     next: d.nextDep?.id,
//   }))
// }

let batchDepth = 0
let batchedSub: Subscriber | undefined
let batchedComputed: Subscriber | undefined

export function batch(sub: Subscriber, isComputed = false): void {
  sub.flags |= EffectFlags.NOTIFIED
  if (isComputed) {
    sub.next = batchedComputed
    batchedComputed = sub
    return
  }
  sub.next = batchedSub
  batchedSub = sub
}

/**
 * @internal
 */
export function startBatch(): void {
  batchDepth++
}

/**
 * Run batched effects when all batches have ended
 * @internal
 */
export function endBatch(): void {
  if (--batchDepth > 0) {
    return
  }

  if (batchedComputed) {
    let e: Subscriber | undefined = batchedComputed
    batchedComputed = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      e = next
    }
  }

  let error: unknown
  while (batchedSub) {
    let e: Subscriber | undefined = batchedSub
    batchedSub = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          // ACTIVE flag is effect-only
          ;(e as ReactiveEffect).trigger()
        } catch (err) {
          if (!error) error = err
        }
      }
      e = next
    }
  }

  if (error) throw error
}

function prepareDeps(sub: Subscriber) {
  // Prepare deps for tracking, starting from the head
  for (let link = sub.deps; link; link = link.nextDep) {
    // set all previous deps' (if any) version to -1 so that we can track
    // which ones are unused after the run
    // 设置为-1，以便追踪运行后哪些订阅没有使用
    link.version = -1
    // store previous active sub if link was being used in another context
    link.prevActiveLink = link.dep.activeLink
    link.dep.activeLink = link
  }
}

function cleanupDeps(sub: Subscriber) {
  // Cleanup unsued deps
  let head
  let tail = sub.depsTail
  let link = tail
  while (link) {
    const prev = link.prevDep
    if (link.version === -1) {
      if (link === tail) tail = prev
      // unused - remove it from the dep's subscribing effect list
      removeSub(link)
      // also remove it from this effect's dep list
      removeDep(link)
    } else {
      // The new head is the last node seen which wasn't removed
      // from the doubly-linked list
      head = link
    }

    // restore previous active link if any
    link.dep.activeLink = link.prevActiveLink
    link.prevActiveLink = undefined
    link = prev
  }
  // set the new head & tail
  sub.deps = head
  sub.depsTail = tail
}

function isDirty(sub: Subscriber): boolean {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (
      // 根据version去判断是否脏数据，需要更新
      link.dep.version !== link.version ||
      (link.dep.computed &&
        (refreshComputed(link.dep.computed) ||
          link.dep.version !== link.version))
    ) {
      return true
    }
  }
  // @ts-expect-error only for backwards compatibility where libs manually set
  // this flag - e.g. Pinia's testing module
  return !!sub._dirty
}

/**
 * Returning false indicates the refresh failed
 * @internal
 */
export function refreshComputed(computed: ComputedRefImpl): undefined {
  if (
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    return
  }
  /**
   * 清空脏状态
   * ~EffectFlags.DIRTY是按位取反 EffectFlags.DIRTY 00010000，按位取反后变成11101111
   * &则是与运算，只有当两个位都为1时结果才为1
   * 所以 computed.flags &= ~EffectFlags.DIRTY是将computed.flags中的DIRTY位清除
   */
  computed.flags &= ~EffectFlags.DIRTY

  // Global version fast path when no reactive changes has happened since
  // last refresh.
  // 上次更新后没有再变化
  if (computed.globalVersion === globalVersion) {
    return
  }
  computed.globalVersion = globalVersion

  // In SSR there will be no render effect, so the computed has no subscriber
  // and therefore tracks no deps, thus we cannot rely on the dirty check.
  // Instead, computed always re-evaluate and relies on the globalVersion
  // fast path above for caching.
  // #12337 if computed has no deps (does not rely on any reactive data) and evaluated,
  // there is no need to re-evaluate.
  // 在 SSR 中不会有渲染效果，因此计算没有订阅者，因此没有跟踪 deps，因此我们不能依赖脏检查。
  // 相反，computed 始终重新计算并依赖于上面的 globalVersion 快速路径进行缓存。
  // #12337 如果计算没有 DEPS（不依赖于任何反应性数据）并已评估，则无需重新评估。
  if (
    // 非SSR环境下
    !computed.isSSR &&
    // 如果computed的flags中包含EVALUATED标志位
    computed.flags & EffectFlags.EVALUATED &&
    // 如果computed的deps不存在或者computed的_dirty属性不存在， 或者isDirty执行结果为false
    // _dirty目前我只发现在pinia的测试模块中使用 pinia/packages/testing/src/testing.ts
    ((!computed.deps && !(computed as any)._dirty) || !isDirty(computed))
  ) {
    return
  }
  computed.flags |= EffectFlags.RUNNING

  const dep = computed.dep
  // 将当前活跃的订阅设置为本computed
  const prevSub = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = computed
  shouldTrack = true

  try {
    // 将computed的一些状态重置
    prepareDeps(computed)
    const value = computed.fn(computed._value)
    // 判断计算值是否变化
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed.flags |= EffectFlags.EVALUATED
      computed._value = value
      dep.version++
    }
  } catch (err) {
    dep.version++
    throw err
  } finally {
    // 回退状态
    activeSub = prevSub
    shouldTrack = prevShouldTrack
    cleanupDeps(computed)
    computed.flags &= ~EffectFlags.RUNNING
  }
}

function removeSub(link: Link, soft = false) {
  const { dep, prevSub, nextSub } = link
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined
  }
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined
  }
  if (__DEV__ && dep.subsHead === link) {
    // was previous head, point new head to next
    dep.subsHead = nextSub
  }

  if (dep.subs === link) {
    // was previous tail, point new tail to prev
    dep.subs = prevSub

    if (!prevSub && dep.computed) {
      // if computed, unsubscribe it from all its deps so this computed and its
      // value can be GCed
      dep.computed.flags &= ~EffectFlags.TRACKING
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        // here we are only "soft" unsubscribing because the computed still keeps
        // referencing the deps and the dep should not decrease its sub count
        removeSub(l, true)
      }
    }
  }

  if (!soft && !--dep.sc && dep.map) {
    // #11979
    // property dep no longer has effect subscribers, delete it
    // this mostly is for the case where an object is kept in memory but only a
    // subset of its properties is tracked at one time
    dep.map.delete(dep.key)
  }
}

function removeDep(link: Link) {
  const { prevDep, nextDep } = link
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined
  }
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  // 判断fn是否存在effect并且是ReactiveEffect的实例
  // 避免自身嵌套问题
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 实例化ReactiveEffect函数
  const e = new ReactiveEffect(fn)
  // 如果存在options，合并到实例
  if (options) {
    extend(e, options)
  }
  try {
    // 运行实例
    e.run()
  } catch (err) {
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  // 将实例挂在到执行器函数的effect属性上
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

/**
 * @internal
 */
export let shouldTrack = true
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking(): void {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 * 为当前活跃的effect注册一个清理函数，清理函数在下一个effect函数执行前或者effect停止时运行
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanup = fn
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(e: ReactiveEffect) {
  // 获取清除函数，并且将实例的cleanup属性置为undefined
  const { cleanup } = e
  e.cleanup = undefined
  // 如果存在清理函数
  if (cleanup) {
    // run cleanup without active effect
    // 避免当前的effect被清除
    const prevSub = activeSub
    activeSub = undefined
    try {
      cleanup()
    } finally {
      activeSub = prevSub
    }
  }
}
