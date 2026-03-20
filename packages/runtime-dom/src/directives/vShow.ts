/**
 * 文件说明：实现 v-show 指令，通过切换 display 样式来控制元素显隐，并支持过渡。
 */
import type { ObjectDirective } from '@vue/runtime-core'

export const vShowOriginalDisplay: unique symbol = Symbol('_vod')
export const vShowHidden: unique symbol = Symbol('_vsh')

export interface VShowElement extends HTMLElement {
  // _vod = vue original display
  [vShowOriginalDisplay]: string
  [vShowHidden]: boolean
}

export const vShow: ObjectDirective<VShowElement> & { name?: 'show' } = {
  /**
   * 封装 `beforeMount` 辅助逻辑。
   */

  beforeMount(el, { value }, { transition }) {
    el[vShowOriginalDisplay] =
      el.style.display === 'none' ? '' : el.style.display
    if (transition && value) {
      transition.beforeEnter(el)
    } else {
      setDisplay(el, value)
    }
  },

  /**
   * 封装 `mounted` 辅助逻辑。
   */
  mounted(el, { value }, { transition }) {
    if (transition && value) {
      transition.enter(el)
    }
  },

  /**
   * 封装 `updated` 辅助逻辑。
   */
  updated(el, { value, oldValue }, { transition }) {
    if (!value === !oldValue) return
    if (transition) {
      if (value) {
        transition.beforeEnter(el)
        setDisplay(el, true)
        transition.enter(el)
      } else {
        transition.leave(el, () => {
          setDisplay(el, false)
        })
      }
    } else {
      setDisplay(el, value)
    }
  },

  /**
   * 封装 `beforeUnmount` 辅助逻辑。
   */
  beforeUnmount(el, { value }) {
    setDisplay(el, value)
  },
}

if (__DEV__) {
  vShow.name = 'show'
}

/**
 * 写入display。
 */

function setDisplay(el: VShowElement, value: unknown): void {
  el.style.display = value ? el[vShowOriginalDisplay] : 'none'
  el[vShowHidden] = !value
}

// SSR vnode transforms, only used when user includes client-oriented render
// function in SSR
export function initVShowForSSR(): void {
  vShow.getSSRProps = ({ value }) => {
    if (!value) {
      return { style: { display: 'none' } }
    }
  }
}
