/**
 * 文件说明：处理元素 class 的 patch 模块，合并过渡类名与动态类名。
 */
import { type ElementWithTransition, vtcKey } from '../components/Transition'

// compiler should normalize class + :class bindings on the same element
// into a single binding ['staticClass', dynamic]
/**
 * 更新元素的 class。
 *
 * 除了普通的静态/动态 class，这里还会把 Transition 暂存到元素上的过渡类名
 * （通过 `vtcKey` 挂载）合并进去，避免组件更新时把 enter/leave 过程中的类覆盖掉。
 */
export function patchClass(
  el: Element,
  value: string | null,
  isSVG: boolean,
): void {
  // directly setting className should be faster than setAttribute in theory
  // if this is an element during a transition, take the temporary transition
  // classes into account.
  // Transition 会把过渡期类名暂存到元素上，这里需要与最新 class 一并写回
  const transitionClasses = (el as ElementWithTransition)[vtcKey]
  if (transitionClasses) {
    value = (
      value ? [value, ...transitionClasses] : [...transitionClasses]
    ).join(' ')
  }
  if (value == null) {
    // 如果值为 null 或 undefined，则移除 class 属性
    el.removeAttribute('class')
  } else if (isSVG) {
    // SVG 元素需要使用 setAttribute 来设置 class
    el.setAttribute('class', value)
  } else {
    // 普通元素直接设置 className 属性
    el.className = value
  }
}
