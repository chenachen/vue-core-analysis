import { extend, isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import { type TrackOpTypes, TriggerOpTypes } from './constants'
import {
  type DebuggerEventExtraInfo,
  EffectFlags,
  type Subscriber,
  activeSub,
  endBatch,
  shouldTrack,
  startBatch,
} from './effect'

/**
 * Incremented every time a reactive change happens
 * This is used to give computed a fast path to avoid re-compute when nothing
 * has changed.
 * 每次响应式发生更改时递增
 * 这用于为computed提供快速路径，以避免在没有任何更改时重新计算。
 */
export let globalVersion = 0

/**
 * Represents a link between a source (Dep) and a subscriber (Effect or Computed).
 * Deps and subs have a many-to-many relationship - each link between a
 * dep and a sub is represented by a Link instance.
 *
 * 表示源 （Dep） 和订阅者 （Effect 或 Computed） 之间的链接。
 * deps 和 sub 具有多对多关系 - dep 和 sub 之间的每个链接都由一个 Link 实例表示。
 *
 * A Link is also a node in two doubly-linked lists - one for the associated
 * sub to track all its deps, and one for the associated dep to track all its
 * subs.
 *
 * Link 也是两个双链表中的一个节点
 * 一个用于关联的 sub 跟踪其所有 deps
 * 另一个用于关联的 dep 跟踪其所有 subs。
 *
 * @internal
 */
export class Link {
  /**
   * - Before each effect run, all previous dep links' version are reset to -1
   * - During the run, a link's version is synced with the source dep on access
   * - After the run, links with version -1 (that were never used) are cleaned
   *   up
   *
   *   在每次effect运行之前，所有以前的 dep 链接的版本都重置为 -1
   *   在运行期间，Link的版本在访问时与源 dep 同步
   *   运行后，将清理版本为 -1（从未使用过）的链接
   */
  version: number

  /**
   * Pointers for doubly-linked lists
   */
  /**
   * link为何链接dep和sub两个双向链表
   * 因为一个dep可以对应多个sub，一个sub也可以对应多个dep
   * 所以需要四个指针来表示前后节点
   *
   * const foo = reactive({ a: 1 })
   * const computed1 = computed(() => foo.a + 1)
   * const computed2 = computed(() => foo.a + 2)
   * 一个dep（foo.a）对应两个sub（computed1, computed2）
   *
   * const bar = reactive({ b: 1 })
   * const foo = reactive({ a: 2 })
   * const computed1 = computed(() => foo.a + bar.b)
   * 一个sub（computed1）对应两个dep（foo.a, bar.b）
   */
  nextDep?: Link
  prevDep?: Link
  nextSub?: Link
  prevSub?: Link
  prevActiveLink?: Link

  constructor(
    public sub: Subscriber,
    public dep: Dep,
  ) {
    this.version = dep.version
    this.nextDep =
      this.prevDep =
      this.nextSub =
      this.prevSub =
      this.prevActiveLink =
        undefined
  }
}

/**
 * @internal
 */
export class Dep {
  version = 0
  /**
   * Link between this dep and the current active effect
   */
  activeLink?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (tail)
   * 订阅者双向链表（尾节点）
   */
  subs?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (head)
   * DEV only, for invoking onTrigger hooks in correct order
   * 订阅者双向链表（头节点）
   * 仅限开发环境，用于按正确顺序调用 onTrigger 钩子
   */
  subsHead?: Link

  /**
   * For object property deps cleanup
   * 当前dep所属的target对象的key到dep的映射
   */
  map?: KeyToDepMap = undefined
  key?: unknown = undefined

  /**
   * Subscriber counter
   * 订阅者数量，如果为空需要清理依赖
   */
  sc: number = 0

  /**
   * @internal
   */
  readonly __v_skip = true
  // TODO isolatedDeclarations ReactiveFlags.SKIP

  constructor(public computed?: ComputedRefImpl | undefined) {
    if (__DEV__) {
      this.subsHead = undefined
    }
  }

  track(debugInfo?: DebuggerEventExtraInfo): Link | undefined {
    /**
     * 没有activeSub，也就是没有活跃的订阅者
     * 或者不应该追踪（pauseTracking被执行）
     * 或者活跃的订阅者就是当前dep的computed，避免computed内部读取自己的值时造成死循环
     */
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return
    }

    let link = this.activeLink
    // 判断当前link是否未定义或者订阅者不是当前活跃的订阅
    if (link === undefined || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this)

      // add the link to the activeEffect as a dep (as tail)
      // 将当前link连接到当前活跃的订阅者的deps的双向链表尾部
      // 主要用于执行完依赖后清除已执行的依赖
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link
      } else {
        // 链表操作，将当前link放到已有的activeSub的尾部
        link.prevDep = activeSub.depsTail
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link
      }
      // 添加订阅者
      addSub(link)
    } else if (link.version === -1) {
      // 也就是第二次及以后执行e.run的场景，上面这个if是第一次执行
      // reused from last run - already a sub, just sync version
      link.version = this.version

      // If this dep has a next, it means it's not at the tail - move it to the
      // tail. This ensures the effect's dep list is in the order they are
      // accessed during evaluation.
      // 如果这个 dep 有 next，则表示它不在尾部
      // 将其移动到尾部
      // 这可确保effect的 dep 列表按照评估期间访问它们的顺序排列。
      if (link.nextDep) {
        // link的上下游链接在一起，相当于把当前link从链表中删除
        const next = link.nextDep
        next.prevDep = link.prevDep
        if (link.prevDep) {
          link.prevDep.nextDep = next
        }

        // 把当前link放到尾节点
        link.prevDep = activeSub.depsTail
        link.nextDep = undefined
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link

        // this was the head - point to the new head
        // 如果link是首节点，则重新指向下一个节点
        if (activeSub.deps === link) {
          activeSub.deps = next
        }
      }
    }

    // 如果是开发环境，并且当前活跃的订阅者有onTrack钩子函数，则调用该函数
    if (__DEV__ && activeSub.onTrack) {
      activeSub.onTrack(
        extend(
          {
            effect: activeSub,
          },
          debugInfo,
        ),
      )
    }

    return link
  }

  trigger(debugInfo?: DebuggerEventExtraInfo): void {
    // version+1，可以快速判断依赖是否变化，如无变化可以避免一些重复计算（主要是computed的）
    this.version++
    globalVersion++
    this.notify(debugInfo)
  }

  notify(debugInfo?: DebuggerEventExtraInfo): void {
    startBatch()
    try {
      if (__DEV__) {
        // subs are notified and batched in reverse-order and then invoked in
        // original order at the end of the batch, but onTrigger hooks should
        // be invoked in original order here.
        // 触发通知函数是按照倒序，但是在批处理结束时按原始顺序调用，所以这里的 onTrigger 钩子函数应该按原始顺序调用。
        // 具体可以看下effect的notify方法以及effect.ts里的batch startBatch和endBatch方法
        for (let head = this.subsHead; head; head = head.nextSub) {
          if (head.sub.onTrigger && !(head.sub.flags & EffectFlags.NOTIFIED)) {
            head.sub.onTrigger(
              extend(
                {
                  effect: head.sub,
                },
                debugInfo,
              ),
            )
          }
        }
      }
      // 倒序遍历订阅者，触发通知函数
      for (let link = this.subs; link; link = link.prevSub) {
        // 执行结果为true意味着是computed，则继续执行ComputedRefImpl的notify方法
        if (link.sub.notify()) {
          // if notify() returns `true`, this is a computed. Also call notify
          // on its dep - it's called here instead of inside computed's notify
          // in order to reduce call stack depth.
          ;(link.sub as ComputedRefImpl).dep.notify()
        }
      }
    } finally {
      // 结束批量执行
      endBatch()
    }
  }
}

function addSub(link: Link) {
  // 订阅者计数
  link.dep.sc++
  if (link.sub.flags & EffectFlags.TRACKING) {
    const computed = link.dep.computed
    // computed getting its first subscriber
    // enable tracking + lazily subscribe to all its deps
    // computed接受第一个订阅者
    if (computed && !link.dep.subs) {
      // 将computed的状态置为TRACKING和DIRTY
      computed.flags |= EffectFlags.TRACKING | EffectFlags.DIRTY
      // 递归computed的所有依赖，挂上订阅者
      for (let l = computed.deps; l; l = l.nextDep) {
        addSub(l)
      }
    }

    // 将当前link加到当前dep的订阅者链表尾部
    const currentTail = link.dep.subs
    if (currentTail !== link) {
      link.prevSub = currentTail
      if (currentTail) currentTail.nextSub = link
    }

    // 设置为当前dep的头节点，方便按序执行onTrigger钩子函数
    if (__DEV__ && link.dep.subsHead === undefined) {
      link.dep.subsHead = link
    }

    // 将当前link设置为当前dep的尾节点
    link.dep.subs = link
  }
}

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>

export const targetMap: WeakMap<object, KeyToDepMap> = new WeakMap()

export const ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Object iterate' : '',
)
export const MAP_KEY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Map keys iterate' : '',
)
export const ARRAY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Array iterate' : '',
)

/**
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
export function track(target: object, type: TrackOpTypes, key: unknown): void {
  // targetMap是个WeakMap，以原始对象为key，Map为值，而这个map则以target的key为key，存储Dep对象
  if (shouldTrack && activeSub) {
    let depsMap = targetMap.get(target)
    // 初次追踪则创建Map
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    if (!dep) {
      // 创建dep对象
      depsMap.set(key, (dep = new Dep()))
      dep.map = depsMap
      dep.key = key
    }
    // 创建完毕之后调用dep对象的track方法
    if (__DEV__) {
      dep.track({
        target,
        type,
        key,
      })
    } else {
      dep.track()
    }
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 * 找出与目标（或特定属性）相关的所有依赖，并触发其中存储的效果。
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 * @param newValue - 新的值
 * @param oldValue - 旧的值
 * @param oldTarget - 旧对象
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
): void {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // 未被调用，所以没有相关追踪
    // never been tracked
    globalVersion++
    return
  }

  const run = (dep: Dep | undefined) => {
    if (dep) {
      // 调用dep对象的trigger方法
      if (__DEV__) {
        dep.trigger({
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget,
        })
      } else {
        dep.trigger()
      }
    }
  }

  /**
   * 开始批量执行
   * 主要是为了合并多次变更，避免重复执行，并确保computed和副作用等按照正确的执行顺序执行
   * 提升性能和一致性
   * 具体场景包括但不限于下面的depsMap.forEach等
   * 见effect.ts里的startBatch和endBatch方法
   */
  startBatch()

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    // 执行对象存储的所有依赖
    depsMap.forEach(run)
  } else {
    // 判断是否数组和key是否数组索引
    const targetIsArray = isArray(target)
    const isArrayIndex = targetIsArray && isIntegerKey(key)

    if (targetIsArray && key === 'length') {
      const newLength = Number(newValue)
      depsMap.forEach((dep, key) => {
        if (
          // key是length
          key === 'length' ||
          // 或者key是遍历标记
          key === ARRAY_ITERATE_KEY ||
          // 或者key不是标记并且key（索引值）大于新的数组长度
          (!isSymbol(key) && key >= newLength)
        ) {
          run(dep)
        }
      })
    } else {
      // schedule runs for SET | ADD | DELETE
      // add set delete可以 以undefined为key
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key))
      }

      // 数组索引的话还要触发迭代类型的依赖
      // schedule ARRAY_ITERATE for any numeric key change (length is handled above)
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY))
      }

      // 根据对象的类型去获取需要触发的依赖
      // 同时还要在ADD | DELETE | Map.SET等操作中执行iteration key的依赖
      // also run for iteration key on ADD | DELETE | Map.SET
      switch (type) {
        case TriggerOpTypes.ADD:
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          } else if (isArrayIndex) {
            // new index added to array -> length changes
            run(depsMap.get('length'))
          }
          break
        case TriggerOpTypes.DELETE:
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          }
          break
        case TriggerOpTypes.SET:
          if (isMap(target)) {
            run(depsMap.get(ITERATE_KEY))
          }
          break
      }
    }
  }

  // 需要触发的订阅者队列建立完毕
  // 开始执行
  endBatch()
}

export function getDepFromReactive(
  object: any,
  key: string | number | symbol,
): Dep | undefined {
  const depMap = targetMap.get(object)
  return depMap && depMap.get(key)
}
