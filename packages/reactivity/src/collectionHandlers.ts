import {
  type Target,
  isReadonly,
  isShallow,
  toRaw,
  toReactive,
  toReadonly,
} from './reactive'
import { ITERATE_KEY, MAP_KEY_ITERATE_KEY, track, trigger } from './dep'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import {
  capitalize,
  extend,
  hasChanged,
  hasOwn,
  isMap,
  toRawType,
} from '@vue/shared'
import { warn } from './warning'

type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = (Map<any, any> | Set<any>) & Target
type WeakCollections = (WeakMap<any, any> | WeakSet<any>) & Target
type MapTypes = (Map<any, any> | WeakMap<any, any>) & Target
type SetTypes = (Set<any> | WeakSet<any>) & Target

const toShallow = <T extends unknown>(value: T): T => value

const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean,
) {
  return function (
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable<unknown> & Iterator<unknown> {
    // 获取本次代理的对象
    const target = this[ReactiveFlags.RAW]
    // 获取源对象，本次代理的对象不一定是基础对象类型，有可能是经过代理的对象，比如readonly(reactive(Map))这种套娃的场景
    const rawTarget = toRaw(target)
    // 判断是否map
    const targetIsMap = isMap(rawTarget)
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
    const isKeyOnly = method === 'keys' && targetIsMap
    const innerIterator = target[method](...args)
    // 根据是否是只读和浅层监听来决定返回的值
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    // 如果是只读的情况，不做依赖追踪
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY,
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    return {
      // 模拟一个迭代器对象，对迭代对象做包装
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done
          ? { value, done }
          : {
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done,
            }
      },
      // iterable protocol
      [Symbol.iterator]() {
        return this
      },
    }
  }
}

// 只读集合的增删改方法
function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this),
      )
    }
    return type === TriggerOpTypes.DELETE
      ? false
      : type === TriggerOpTypes.CLEAR
        ? undefined
        : this
  }
}

type Instrumentations = Record<string | symbol, Function | number>

function createInstrumentations(
  readonly: boolean,
  shallow: boolean,
): Instrumentations {
  const instrumentations: Instrumentations = {
    get(this: MapTypes, key: unknown) {
      // #1772: readonly(reactive(Map)) should return readonly + reactive version
      // of the value
      // 被代理的对象
      const target = this[ReactiveFlags.RAW]
      // 代理对象的原始版本，target和rawTarget不一致的场景包含但应该不限于readonly(reactive(Map))这种套娃的场景
      const rawTarget = toRaw(target)
      // key可以是对象，所以这里获取原始版本的key
      const rawKey = toRaw(key)
      if (!readonly) {
        // 其实是判断key是否也是代理对象而不是真的判断key是否有被改过
        if (hasChanged(key, rawKey)) {
          // 对key执行追踪
          track(rawTarget, TrackOpTypes.GET, key)
        }
        // 对原始key执行追踪
        track(rawTarget, TrackOpTypes.GET, rawKey)
      }
      const { has } = getProto(rawTarget)
      // 根据是否是只读和浅层监听来决定包装函数
      const wrap = shallow ? toShallow : readonly ? toReadonly : toReactive
      // 如果key在源中存在，则返回对应的值
      if (has.call(rawTarget, key)) {
        return wrap(target.get(key))
        // 如果key在源中不存在，但是原始版本的key存在，则返回对应的值
      } else if (has.call(rawTarget, rawKey)) {
        return wrap(target.get(rawKey))
      } else if (target !== rawTarget) {
        // #3602 readonly(reactive(Map))
        // ensure that the nested reactive `Map` can do tracking for itself
        // readonly(reactive(Map))这种套娃的场景,确保reactive自身的Map可以进行追踪
        target.get(key)
      }
    },
    get size() {
      // 获取代理对象
      const target = (this as unknown as IterableCollections)[ReactiveFlags.RAW]
      // 非只读的话执行追踪
      !readonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
      // 返回长度
      return Reflect.get(target, 'size', target)
    },
    has(this: CollectionTypes, key: unknown): boolean {
      // 获取代理对象和代理对象的源对象
      const target = this[ReactiveFlags.RAW]
      const rawTarget = toRaw(target)
      // 获取key的原始版本
      const rawKey = toRaw(key)
      // 非只读的话执行追踪
      if (!readonly) {
        // 其实是判断key是否也是代理对象而不是真的判断key是否有被改过
        if (hasChanged(key, rawKey)) {
          track(rawTarget, TrackOpTypes.HAS, key)
        }
        track(rawTarget, TrackOpTypes.HAS, rawKey)
      }
      return key === rawKey
        ? target.has(key)
        : target.has(key) || target.has(rawKey)
    },
    forEach(this: IterableCollections, callback: Function, thisArg?: unknown) {
      const observed = this
      // 获取代理对象和代理对象的源对象
      const target = observed[ReactiveFlags.RAW]
      const rawTarget = toRaw(target)
      // 根据是否是只读和浅层监听来决定包装函数
      const wrap = shallow ? toShallow : readonly ? toReadonly : toReactive
      // 非只读的话执行追踪
      !readonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
      return target.forEach((value: unknown, key: unknown) => {
        // important: make sure the callback is
        // 1. invoked with the reactive map as `this` and 3rd arg
        // 2. the value received should be a corresponding reactive/readonly.
        // 确保callback函数的this指向是响应式对象，接收到的值应该是相应的反应性/只读。
        return callback.call(thisArg, wrap(value), wrap(key), observed)
      })
    },
  }

  extend(
    instrumentations,
    readonly
      ? {
          add: createReadonlyMethod(TriggerOpTypes.ADD),
          set: createReadonlyMethod(TriggerOpTypes.SET),
          delete: createReadonlyMethod(TriggerOpTypes.DELETE),
          clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
        }
      : {
          add(this: SetTypes, value: unknown) {
            // 查值是否是浅层、只读或已经是响应式对象，如果不是，则将其转换为原始值
            if (!shallow && !isShallow(value) && !isReadonly(value)) {
              value = toRaw(value)
            }
            // 获取代理对象的原始版本
            const target = toRaw(this)
            // 获取原型对象
            const proto = getProto(target)

            // 通过原始集合的 has 方法检查值是否已存在。如果值不存在，则将其添加到集合中，并触发依赖收集
            const hadKey = proto.has.call(target, value)
            if (!hadKey) {
              target.add(value)
              trigger(target, TriggerOpTypes.ADD, value, value)
            }
            return this
          },
          set(this: MapTypes, key: unknown, value: unknown) {
            // 查值是否是浅层、只读或已经是响应式对象，如果不是，则将其转换为原始值
            if (!shallow && !isShallow(value) && !isReadonly(value)) {
              value = toRaw(value)
            }
            // 获取代理对象的原始版本
            const target = toRaw(this)
            const { has, get } = getProto(target)

            // 判断是否存在该key，不存在的话尝试获取key的原始版本再判断一次
            let hadKey = has.call(target, key)
            if (!hadKey) {
              key = toRaw(key)
              hadKey = has.call(target, key)
            } else if (__DEV__) {
              checkIdentityKeys(target, has, key)
            }

            // 先获取旧值
            const oldValue = get.call(target, key)
            // 再设置新值
            target.set(key, value)
            // 最后根据是否存在该key和新旧值是否变化来触发依
            if (!hadKey) {
              trigger(target, TriggerOpTypes.ADD, key, value)
            } else if (hasChanged(value, oldValue)) {
              trigger(target, TriggerOpTypes.SET, key, value, oldValue)
            }
            return this
          },
          delete(this: CollectionTypes, key: unknown) {
            // 获取代理对象的原始版本
            const target = toRaw(this)
            const { has, get } = getProto(target)
            // 判断是否存在该值，不存在的话尝试获取key的原始版本再判断一次
            let hadKey = has.call(target, key)
            if (!hadKey) {
              key = toRaw(key)
              hadKey = has.call(target, key)
            } else if (__DEV__) {
              checkIdentityKeys(target, has, key)
            }

            // 先获取旧值
            const oldValue = get ? get.call(target, key) : undefined
            // forward the operation before queueing reactions
            // 删除后，如果key是存在的再触发trigger
            const result = target.delete(key)
            if (hadKey) {
              trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
            }
            return result
          },
          clear(this: IterableCollections) {
            // 获取代理对象的原始版本
            const target = toRaw(this)
            // 如果原始对象的size不为0则说明有值
            const hadItems = target.size !== 0
            // 开发环境下重新拷贝一份原始数据
            // 以便在trigger作为debuggerInfo传递过去
            const oldTarget = __DEV__
              ? isMap(target)
                ? new Map(target)
                : new Set(target)
              : undefined
            // forward the operation before queueing reactions
            const result = target.clear()
            if (hadItems) {
              trigger(
                target,
                TriggerOpTypes.CLEAR,
                undefined,
                undefined,
                oldTarget,
              )
            }
            return result
          },
        },
  )

  // map set相对应的迭代器方法
  const iteratorMethods = [
    'keys',
    'values',
    'entries',
    Symbol.iterator,
  ] as const

  iteratorMethods.forEach(method => {
    instrumentations[method] = createIterableMethod(method, readonly, shallow)
  })

  return instrumentations
}

function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  const instrumentations = createInstrumentations(isReadonly, shallow)

  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes,
  ) => {
    // 和basehandler一样，一些内置key的判断
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    return Reflect.get(
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver,
    )
  }
}

// 可以看到，和baseHandlers的get函数一样，都是通过createInstrumentationGetter工厂函数创建的
// 只不过baseHandlers是针对对象的，而collectionHandlers是针对集合类型的
// 另外baseHandlers还区分了是否是数组，因为数组有一些特殊的方法需要处理
// 而collectionHandlers则只代理了get方法
// 因为map set都是通过方法来操作的，没有像对象那样通过.或者[]来访问属性
// 另外，collectionHandlers还区分了是否是只读和是否是浅层监听
// 这两个选项会影响到对值的包装方式，以及是否进行依赖追踪

export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*@__PURE__*/ createInstrumentationGetter(false, false),
}

export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*@__PURE__*/ createInstrumentationGetter(false, true),
}

export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*@__PURE__*/ createInstrumentationGetter(true, false),
}

export const shallowReadonlyCollectionHandlers: ProxyHandler<CollectionTypes> =
  {
    get: /*@__PURE__*/ createInstrumentationGetter(true, true),
  }

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown,
) {
  const rawKey = toRaw(key)
  // 检查target是否同时存在key的原始版本和代理版本，开发环境中给出提示，不建议这么做
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`,
    )
  }
}
