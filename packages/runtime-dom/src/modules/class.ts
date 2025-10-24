import { type ElementWithTransition, vtcKey } from '../components/Transition'

// compiler should normalize class + :class bindings on the same element
// into a single binding ['staticClass', dynamic]
export function patchClass(
  el: Element,
  value: string | null,
  isSVG: boolean,
): void {
  // directly setting className should be faster than setAttribute in theory
  // if this is an element during a transition, take the temporary transition
  // classes into account.
  // 处理vue transition组件切换class时的过渡类名
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
