/**
 * `ShapeFlags` 枚举定义了一组位标志，用于描述 Vue 中不同类型的节点或组件的特性。
 * 每个标志使用位运算符定义，便于高效组合和检查多个特性。
 */
export enum ShapeFlags {
  /**
   * 表示普通的 DOM 元素节点。
   */
  ELEMENT = 1,

  /**
   * 表示函数式组件。
   */
  FUNCTIONAL_COMPONENT = 1 << 1,

  /**
   * 表示有状态的组件（即带有状态和生命周期的组件）。
   */
  STATEFUL_COMPONENT = 1 << 2,

  /**
   * 表示子节点是纯文本。
   */
  TEXT_CHILDREN = 1 << 3,

  /**
   * 表示子节点是数组。
   */
  ARRAY_CHILDREN = 1 << 4,

  /**
   * 表示子节点是插槽（slots）。
   */
  SLOTS_CHILDREN = 1 << 5,

  /**
   * 表示 Teleport 组件。
   */
  TELEPORT = 1 << 6,

  /**
   * 表示 Suspense 组件。
   */
  SUSPENSE = 1 << 7,

  /**
   * 表示组件应该保持活跃状态（keep-alive）。
   */
  COMPONENT_SHOULD_KEEP_ALIVE = 1 << 8,

  /**
   * 表示组件已被保持活跃状态（kept-alive）。
   */
  COMPONENT_KEPT_ALIVE = 1 << 9,

  /**
   * 表示组件，可以是函数式组件或有状态组件的组合。
   */
  COMPONENT = ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT,
}
