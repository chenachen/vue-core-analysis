/**
 * 文件说明：实现 DOM 节点操作接口，为渲染器提供创建、插入、删除和遍历等基础 DOM 能力。
 */
import { warn } from '@vue/runtime-core'
import type { RendererOptions } from '@vue/runtime-core'
import type {
  TrustedHTML,
  TrustedTypePolicy,
  TrustedTypesWindow,
} from 'trusted-types/lib'

let policy: Pick<TrustedTypePolicy, 'name' | 'createHTML'> | undefined =
  undefined

const tt =
  typeof window !== 'undefined' &&
  (window as unknown as TrustedTypesWindow).trustedTypes

if (tt) {
  try {
    policy =
      /*@__PURE__*/
      tt.createPolicy('vue', {
        /**
         * 封装 `createHTML` 分支逻辑。
         */

        createHTML: val => val,
      })
  } catch (e: unknown) {
    // `createPolicy` throws a TypeError if the name is a duplicate
    // and the CSP trusted-types directive is not using `allow-duplicates`.
    // So we have to catch that error.
    __DEV__ && warn(`Error creating trusted types policy: ${e}`)
  }
}

// __UNSAFE__
// Reason: potentially setting innerHTML.
// This function merely perform a type-level trusted type conversion
// for use in `innerHTML` assignment, etc.
// Be careful of whatever value passed to this function.
export const unsafeToTrustedHTML: (value: string) => TrustedHTML | string =
  policy ? val => policy.createHTML(val) : val => val

export const svgNS = 'http://www.w3.org/2000/svg'
export const mathmlNS = 'http://www.w3.org/1998/Math/MathML'

const doc = (typeof document !== 'undefined' ? document : null) as Document

const templateContainer = doc && /*@__PURE__*/ doc.createElement('template')

// 封装一组操作 DOM 节点的方法，符合 Vue 渲染器所需的接口规范。
export const nodeOps: Omit<RendererOptions<Node, Element>, 'patchProp'> = {
  /**
   * 封装 `insert` 分支逻辑。
   */

  insert: (child, parent, anchor) => {
    parent.insertBefore(child, anchor || null)
  },

  /**
   * 封装 `remove` 分支逻辑。
   */
  remove: child => {
    const parent = child.parentNode
    if (parent) {
      parent.removeChild(child)
    }
  },

  // 根据命名空间和自定义内置元素配置创建真实元素节点。
  // `props.multiple` 需要在 `<select>` 创建阶段尽早写入，避免后续 value 同步失效。
  createElement: (tag, namespace, is, props): Element => {
    const el =
      namespace === 'svg'
        ? doc.createElementNS(svgNS, tag)
        : namespace === 'mathml'
          ? doc.createElementNS(mathmlNS, tag)
          : is
            ? doc.createElement(tag, { is })
            : doc.createElement(tag)

    if (tag === 'select' && props && props.multiple != null) {
      ;(el as HTMLSelectElement).setAttribute('multiple', props.multiple)
    }

    return el
  },

  /**
   * 封装 `createText` 分支逻辑。
   */
  createText: text => doc.createTextNode(text),

  /**
   * 封装 `createComment` 分支逻辑。
   */
  createComment: text => doc.createComment(text),

  /**
   * 封装 `setText` 分支逻辑。
   */
  setText: (node, text) => {
    node.nodeValue = text
  },

  /**
   * 封装 `setElementText` 分支逻辑。
   */
  setElementText: (el, text) => {
    el.textContent = text
  },

  /**
   * 封装 `parentNode` 分支逻辑。
   */
  parentNode: node => node.parentNode as Element | null,

  /**
   * 封装 `nextSibling` 分支逻辑。
   */
  nextSibling: node => node.nextSibling,

  /**
   * 封装 `querySelector` 分支逻辑。
   */
  querySelector: selector => doc.querySelector(selector),

  /**
   * 写入作用域标识。
   */
  setScopeId(el, id) {
    el.setAttribute(id, '')
  },

  // __UNSAFE__
  // Reason: innerHTML.
  // Static content here can only come from compiled templates.
  // As long as the user only uses trusted templates, this is safe.
  insertStaticContent(content, parent, anchor, namespace, start, end) {
    // 对静态提升节点优先走克隆缓存路径，只有首次插入时才会重新解析 HTML 字符串。
    // <parent> before | first ... last | anchor </parent>
    const before = anchor ? anchor.previousSibling : parent.lastChild
    // #5308 can only take cached path if:
    // - has a single root node
    // - nextSibling info is still available
    if (start && (start === end || start.nextSibling)) {
      // cached
      while (true) {
        parent.insertBefore(start!.cloneNode(true), anchor)
        if (start === end || !(start = start!.nextSibling)) break
      }
    } else {
      // fresh insert
      templateContainer.innerHTML = unsafeToTrustedHTML(
        namespace === 'svg'
          ? `<svg>${content}</svg>`
          : namespace === 'mathml'
            ? `<math>${content}</math>`
            : content,
      ) as string

      const template = templateContainer.content
      if (namespace === 'svg' || namespace === 'mathml') {
        // remove outer svg/math wrapper，保留真正的静态子节点
        const wrapper = template.firstChild!
        while (wrapper.firstChild) {
          template.appendChild(wrapper.firstChild)
        }
        template.removeChild(wrapper)
      }
      parent.insertBefore(template, anchor)
    }
    return [
      // first
      before ? before.nextSibling! : parent.firstChild!,
      // last
      anchor ? anchor.previousSibling! : parent.lastChild!,
    ]
  },
}
