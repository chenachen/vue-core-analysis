import { TrackOpTypes } from './constants'
import { endBatch, pauseTracking, resetTracking, startBatch } from './effect'
import { isProxy, isShallow, toRaw, toReactive } from './reactive'
import { ARRAY_ITERATE_KEY, track } from './dep'
import { isArray } from '@vue/shared'

/**
 * Track array iteration and return:
 * - if input is reactive: a cloned raw array with reactive values
 * - if input is non-reactive or shallowReactive: the original raw array
 * 依赖收集，并返回原始数组或者深度代理后的新数组
 * - 如果输入的是响应式数组：返回一个克隆的原始数组，数组项是响应式的
 * - 如果输入的是非响应式或者浅层响应式数组：返回原始数组
 */
export function reactiveReadArray<T>(array: T[]): T[] {
  const raw = toRaw(array)
  // 判断是否响应式数组，如果是的话依赖收集，如果不是浅层监听，则将数组项继续深层遍历设置为reactive
  if (raw === array) return raw
  track(raw, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return isShallow(array) ? raw : raw.map(toReactive)
}

/**
 * Track array iteration and return raw array
 * 依赖收集，并返回原始数组
 */
export function shallowReadArray<T>(arr: T[]): T[] {
  track((arr = toRaw(arr)), TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return arr
}

// 代理劫持对象的数组方法
// 这些方法会被重新定义，以便在调用时进行依赖收集和触发更新
// 这些方法分为三类：
// 1. 迭代器方法，如 forEach、map、filter 等，这些方法会遍历数组并对每个元素进行操作
// 2. 查找方法，如 includes、indexOf、lastIndexOf 等，这些方法会查找数组中的某个元素
// 3. 变更数组长度的方法，如 push、pop、shift、unshift、splice 等，这些方法会改变数组的长度
// 其中，变更数组长度的方法会暂停依赖收集，以避免触发不必要的更新
// 其他方法会进行依赖收集，以便在数组发生变化时触发更新
// 这些方法在调用时会先获取原始数组，然后根据需要进行深度代理或浅层代理，最后返回结果
// 通过这种方式，可以确保对数组的操作能够正确地触发响应式更新
export const arrayInstrumentations: Record<string | symbol, Function> = <any>{
  __proto__: null,

  // 迭代器
  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, toReactive)
  },

  concat(...args: unknown[]) {
    // 对原数组和拼接进来的数组都进行依赖收集
    return reactiveReadArray(this).concat(
      ...args.map(x => (isArray(x) ? reactiveReadArray(x) : x)),
    )
  },

  entries() {
    return iterator(this, 'entries', (value: [number, unknown]) => {
      value[1] = toReactive(value[1])
      return value
    })
  },

  every(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'every', fn, thisArg, undefined, arguments)
  },

  filter(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'filter', fn, thisArg, v => v.map(toReactive), arguments)
  },

  find(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'find', fn, thisArg, toReactive, arguments)
  },

  findIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findIndex', fn, thisArg, undefined, arguments)
  },

  findLast(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLast', fn, thisArg, toReactive, arguments)
  },

  findLastIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLastIndex', fn, thisArg, undefined, arguments)
  },

  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement

  forEach(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'forEach', fn, thisArg, undefined, arguments)
  },

  includes(...args: unknown[]) {
    return searchProxy(this, 'includes', args)
  },

  indexOf(...args: unknown[]) {
    return searchProxy(this, 'indexOf', args)
  },

  join(separator?: string) {
    return reactiveReadArray(this).join(separator)
  },

  // keys() iterator only reads `length`, no optimisation required

  lastIndexOf(...args: unknown[]) {
    return searchProxy(this, 'lastIndexOf', args)
  },

  map(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'map', fn, thisArg, undefined, arguments)
  },

  pop() {
    return noTracking(this, 'pop')
  },

  push(...args: unknown[]) {
    return noTracking(this, 'push', args)
  },

  reduce(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduce', fn, args)
  },

  reduceRight(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduceRight', fn, args)
  },

  shift() {
    return noTracking(this, 'shift')
  },

  // slice could use ARRAY_ITERATE but also seems to beg for range tracking

  some(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'some', fn, thisArg, undefined, arguments)
  },

  splice(...args: unknown[]) {
    return noTracking(this, 'splice', args)
  },

  toReversed() {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toReversed()
  },

  toSorted(comparer?: (a: unknown, b: unknown) => number) {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toSorted(comparer)
  },

  toSpliced(...args: unknown[]) {
    // @ts-expect-error user code may run in es2016+
    return (reactiveReadArray(this).toSpliced as any)(...args)
  },

  unshift(...args: unknown[]) {
    return noTracking(this, 'unshift', args)
  },

  values() {
    return iterator(this, 'values', toReactive)
  },
}

// instrument iterators to take ARRAY_ITERATE dependency
function iterator(
  self: unknown[],
  method: keyof Array<unknown>,
  wrapValue: (value: any) => unknown,
) {
  // note that taking ARRAY_ITERATE dependency here is not strictly equivalent
  // to calling iterate on the proxified array.
  // creating the iterator does not access any array property:
  // it is only when .next() is called that length and indexes are accessed.
  // pushed to the extreme, an iterator could be created in one effect scope,
  // partially iterated in another, then iterated more in yet another.
  // given that JS iterator can only be read once, this doesn't seem like
  // a plausible use-case, so this tracking simplification seems ok.
  // 请注意，此处获取ARRAY_ITERATE依赖项并不严格等同于在代理数组上调用 iterate
  // 创建迭代器不会访问任何数组属性：只有在调用 .next（） 时，才会访问 length 和 indexs
  // 如果极端一点，可以在一个 Effect Scope 中创建迭代器，在另一个 Effect Scope 中部分迭代，然后在另一个 Effect Scope 中迭代更多
  // 鉴于 JS 迭代器只能读取一次，这似乎不是一个合理的用例，因此这种跟踪简化似乎还可以。

  // 浅层监听并获取源对象
  const arr = shallowReadArray(self)
  // 获取迭代器
  const iter = (arr[method] as any)() as IterableIterator<unknown> & {
    _next: IterableIterator<unknown>['next']
  }
  // arr !== self意味着是代理对象，!isShallow(self)非浅层监听
  // 同时满足以上情形时做深度监听代理，并且返回结果
  if (arr !== self && !isShallow(self)) {
    iter._next = iter.next
    iter.next = () => {
      const result = iter._next()
      if (result.value) {
        result.value = wrapValue(result.value)
      }
      return result
    }
  }
  return iter
}

// in the codebase we enforce es2016, but user code may run in environments
// higher than that
type ArrayMethods = keyof Array<any> | 'findLast' | 'findLastIndex'

const arrayProto = Array.prototype
// instrument functions that read (potentially) all items
// to take ARRAY_ITERATE dependency
function apply(
  self: unknown[],
  method: ArrayMethods,
  fn: (item: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
  wrappedRetFn?: (result: any) => unknown,
  args?: IArguments,
) {
  // 依赖收集
  const arr = shallowReadArray(self)
  // 判断是否需要深度监听
  const needsWrap = arr !== self && !isShallow(self)
  // @ts-expect-error our code is limited to es2016 but user code is not
  const methodFn = arr[method]

  // #11759
  // If the method being called is from a user-extended Array, the arguments will be unknown
  // (unknown order and unknown parameter types). In this case, we skip the shallowReadArray
  // handling and directly call apply with self.
  // 如果是扩展的方法，参数是未知的，直接用apply执行，跳过shallowReadArray，然后对结果判断是否需要继续包装成reactive
  if (methodFn !== arrayProto[method as any]) {
    const result = methodFn.apply(self, args)
    return needsWrap ? toReactive(result) : result
  }

  let wrappedFn = fn
  if (arr !== self) {
    // 如果需要深度监听，则将数组项继续深层遍历设置为reactive
    if (needsWrap) {
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, toReactive(item), index, self)
      }
    } else if (fn.length > 2) {
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, item, index, self)
      }
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg)
  // 判断是否需要对结果响应式处理
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result
}

// instrument reduce and reduceRight to take ARRAY_ITERATE dependency
// reduce 和 reduceRight 方法的特殊处理
function reduce(
  self: unknown[],
  method: keyof Array<any>,
  fn: (acc: unknown, item: unknown, index: number, array: unknown[]) => unknown,
  args: unknown[],
) {
  // 依赖收集
  const arr = shallowReadArray(self)
  let wrappedFn = fn
  // 判断是否需要深层代理
  if (arr !== self) {
    if (!isShallow(self)) {
      wrappedFn = function (this: unknown, acc, item, index) {
        return fn.call(this, acc, toReactive(item), index, self)
      }
    } else if (fn.length > 3) {
      wrappedFn = function (this: unknown, acc, item, index) {
        return fn.call(this, acc, item, index, self)
      }
    }
  }
  return (arr[method] as any)(wrappedFn, ...args)
}

// instrument identity-sensitive methods to account for reactive proxies
function searchProxy(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[],
) {
  const arr = toRaw(self) as any
  // 依赖收集
  track(arr, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  // we run the method using the original args first (which may be reactive)
  const res = arr[method](...args)

  /**
   * 如果查不到数据，则用源对象再查找一次
   * 例如：
   * const obj = { a: 1 }
   * const reactiveObj = reactive(obj)
   * const arr = reactive([obj])
   * arr.includes(reactiveObj) // true
   */
  if ((res === -1 || res === false) && isProxy(args[0])) {
    args[0] = toRaw(args[0])
    return arr[method](...args)
  }

  return res
}

// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
// 变更数组长度的方法会暂停依赖收集，以避免触发不必要的更新
function noTracking(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[] = [],
) {
  // 暂停依赖收集
  pauseTracking()
  // 开始批量统计
  startBatch()
  const res = (toRaw(self) as any)[method].apply(self, args)
  // 结束收集并执行批量任务
  endBatch()
  // 重置可收集状态
  resetTracking()
  return res
}
