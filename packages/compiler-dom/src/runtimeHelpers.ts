/**
 * DOM 编译器额外使用的 runtime helper 符号表。
 *
 * 这些 symbol 会注册回 `compiler-core`，这样 DOM transform 返回 helper 时，
 * codegen 就能像处理 core helpers 一样生成正确的导入与调用代码。
 */
import { registerRuntimeHelpers } from '@vue/compiler-core'

export const V_MODEL_RADIO: unique symbol = Symbol(__DEV__ ? `vModelRadio` : ``)
export const V_MODEL_CHECKBOX: unique symbol = Symbol(
  __DEV__ ? `vModelCheckbox` : ``,
)
export const V_MODEL_TEXT: unique symbol = Symbol(__DEV__ ? `vModelText` : ``)
export const V_MODEL_SELECT: unique symbol = Symbol(
  __DEV__ ? `vModelSelect` : ``,
)
export const V_MODEL_DYNAMIC: unique symbol = Symbol(
  __DEV__ ? `vModelDynamic` : ``,
)

export const V_ON_WITH_MODIFIERS: unique symbol = Symbol(
  __DEV__ ? `vOnModifiersGuard` : ``,
)
export const V_ON_WITH_KEYS: unique symbol = Symbol(
  __DEV__ ? `vOnKeysGuard` : ``,
)

export const V_SHOW: unique symbol = Symbol(__DEV__ ? `vShow` : ``)

export const TRANSITION: unique symbol = Symbol(__DEV__ ? `Transition` : ``)
export const TRANSITION_GROUP: unique symbol = Symbol(
  __DEV__ ? `TransitionGroup` : ``,
)

registerRuntimeHelpers({
  [V_MODEL_RADIO]: `vModelRadio`,
  [V_MODEL_CHECKBOX]: `vModelCheckbox`,
  [V_MODEL_TEXT]: `vModelText`,
  [V_MODEL_SELECT]: `vModelSelect`,
  [V_MODEL_DYNAMIC]: `vModelDynamic`,
  [V_ON_WITH_MODIFIERS]: `withModifiers`,
  [V_ON_WITH_KEYS]: `withKeys`,
  [V_SHOW]: `vShow`,
  [TRANSITION]: `Transition`,
  [TRANSITION_GROUP]: `TransitionGroup`,
})
