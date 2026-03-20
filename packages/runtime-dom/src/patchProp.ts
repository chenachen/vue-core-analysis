/**
 * 文件说明：作为 DOM 属性分发总入口，根据属性类型把更新路由到 class、style、事件、attr 或 prop 模块。
 */
import { patchClass } from './modules/class'
import { patchStyle } from './modules/style'
import { patchAttr } from './modules/attrs'
import { patchDOMProp } from './modules/props'
import { patchEvent } from './modules/events'
import {
  camelize,
  isFunction,
  isModelListener,
  isOn,
  isString,
} from '@vue/shared'
import type { RendererOptions } from '@vue/runtime-core'
import type { VueElement } from './apiCustomElement'

/**
 * 判断给定的 key 是否为原生 DOM 事件监听器。
 * 原生事件监听器的 key 以 "on" 开头，第三个字符为小写字母。
 * 例如："onclick"、"onchange"。
 */
const isNativeOn = (key: string) =>
  key.charCodeAt(0) === 111 /* o */ &&
  key.charCodeAt(1) === 110 /* n */ &&
  // 小写字母
  key.charCodeAt(2) > 96 &&
  key.charCodeAt(2) < 123

type DOMRendererOptions = RendererOptions<Node, Element>

/**
 * DOM 平台的属性分发入口。
 *
 * runtime-core 只知道“某个 prop 需要更新了”，至于它应该走 class、style、事件、
 * DOM property 还是普通 attribute，交给 runtime-dom 在这里按浏览器语义做分派。
 */
export const patchProp: DOMRendererOptions['patchProp'] = (
  el,
  key,
  prevValue,
  nextValue,
  namespace,
  parentComponent,
) => {
  const isSVG = namespace === 'svg'
  if (key === 'class') {
    // 处理class
    patchClass(el, nextValue, isSVG)
  } else if (key === 'style') {
    // 处理style
    patchStyle(el, prevValue, nextValue)
  } else if (isOn(key)) {
    // ignore v-model listeners
    if (!isModelListener(key)) {
      patchEvent(el, key, prevValue, nextValue, parentComponent)
    }
  } else if (
    key[0] === '.'
      ? ((key = key.slice(1)), true)
      : key[0] === '^'
        ? ((key = key.slice(1)), false)
        : shouldSetAsProp(el, key, nextValue, isSVG)
  ) {
    patchDOMProp(el, key, nextValue, parentComponent)
    // #6007 also set form state as attributes so they work with
    // <input type="reset"> or libs / extensions that expect attributes
    // #11163 custom elements may use value as an prop and set it as object
    if (
      !el.tagName.includes('-') &&
      (key === 'value' || key === 'checked' || key === 'selected')
    ) {
      patchAttr(el, key, nextValue, isSVG, parentComponent, key !== 'value')
    }
  } else if (
    // #11081 force set props for possible async custom element
    (el as VueElement)._isVueCE &&
    (/[A-Z]/.test(key) || !isString(nextValue))
  ) {
    patchDOMProp(el, camelize(key), nextValue, parentComponent, key)
  } else {
    // special case for <input v-model type="checkbox"> with
    // :true-value & :false-value
    // store value as dom properties since non-string values will be
    // stringified.
    if (key === 'true-value') {
      ;(el as any)._trueValue = nextValue
    } else if (key === 'false-value') {
      ;(el as any)._falseValue = nextValue
    }
    patchAttr(el, key, nextValue, isSVG, parentComponent)
  }
}

/**
 * 决定当前 key 应该写入 DOM property 还是 attribute。
 *
 * 这一步封装了大量浏览器兼容性细节：SVG/MathML、枚举属性、只读属性，以及
 * 原生内联事件字符串等场景都不能简单地使用 `el[key] = value`。
 */
/**
 * 判断当前 key 在浏览器中应走 DOM property 还是 attribute 语义。
 *
 * 这个判断函数把平台差异集中收口：一旦判错，更新结果就可能出现类型强转、只读属性
 * 失败或 SVG 行为异常，因此这里保存了大量“看似零散、实际上很关键”的分支。
 */
function shouldSetAsProp(
  el: Element,
  key: string,
  value: unknown,
  isSVG: boolean,
) {
  if (isSVG) {
    // most keys must be set as attribute on svg elements to work
    // ...except innerHTML & textContent
    if (key === 'innerHTML' || key === 'textContent') {
      return true
    }
    // or native onclick with function values
    if (key in el && isNativeOn(key) && isFunction(value)) {
      return true
    }
    return false
  }

  // these are enumerated attrs, however their corresponding DOM properties
  // are actually booleans - this leads to setting it with a string "false"
  // value leading it to be coerced to `true`, so we need to always treat
  // them as attributes.
  // Note that `contentEditable` doesn't have this problem: its DOM
  // property is also enumerated string values.
  if (
    key === 'spellcheck' ||
    key === 'draggable' ||
    key === 'translate' ||
    key === 'autocorrect'
  ) {
    return false
  }

  // #1787, #2840 form property on form elements is readonly and must be set as
  // attribute.
  if (key === 'form') {
    return false
  }

  // #1526 <input list> must be set as attribute
  if (key === 'list' && el.tagName === 'INPUT') {
    return false
  }

  // #2766 <textarea type> must be set as attribute
  if (key === 'type' && el.tagName === 'TEXTAREA') {
    return false
  }

  // #8780 the width or height of embedded tags must be set as attribute
  if (key === 'width' || key === 'height') {
    const tag = el.tagName
    if (
      tag === 'IMG' ||
      tag === 'VIDEO' ||
      tag === 'CANVAS' ||
      tag === 'SOURCE'
    ) {
      return false
    }
  }

  // native onclick with string value, must be set as attribute
  if (isNativeOn(key) && isString(value)) {
    return false
  }

  return key in el
}
