/**
 * 文件说明：创建内部对象原型，用于 props 和 slots 规范化过程中的快速识别。
 */

/**
 * Used during vnode props/slots normalization to check if the vnode props/slots
 * are the internal attrs / slots object of a component via
 * `Object.getPrototypeOf`. This is more performant than defining a
 * non-enumerable property. (one of the optimizations done for ssr-benchmark)
 */
const internalObjectProto = {}

/**
 * 创建`internal``object`。
 */

export const createInternalObject = (): any =>
  Object.create(internalObjectProto)

/**
 * 判断当前是否满足`internal``object`。
 */

export const isInternalObject = (obj: object): boolean =>
  Object.getPrototypeOf(obj) === internalObjectProto
