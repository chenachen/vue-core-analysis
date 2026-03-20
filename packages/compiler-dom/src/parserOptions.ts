/**
 * DOM 平台专用 parser 选项。
 *
 * `compiler-core` 的 parser 是平台无关的，而这里把 HTML 语义补了进去：
 * - 哪些标签是 void tag / 原生标签 / 内建组件
 * - 何时切换 HTML、SVG、MathML 命名空间
 * - 浏览器构建下如何解码 HTML entity
 */
import { Namespaces, NodeTypes, type ParserOptions } from '@vue/compiler-core'
import { isHTMLTag, isMathMLTag, isSVGTag, isVoidTag } from '@vue/shared'
import { TRANSITION, TRANSITION_GROUP } from './runtimeHelpers'
import { decodeHtmlBrowser } from './decodeHtmlBrowser'

export const parserOptions: ParserOptions = {
  parseMode: 'html',
  isVoidTag,
  isNativeTag: tag => isHTMLTag(tag) || isSVGTag(tag) || isMathMLTag(tag),
  isPreTag: tag => tag === 'pre',
  isIgnoreNewlineTag: tag => tag === 'pre' || tag === 'textarea',
  decodeEntities: __BROWSER__ ? decodeHtmlBrowser : undefined,

  // 把编译期会特殊处理的内建组件映射到对应 runtime helper。
  isBuiltInComponent: tag => {
    if (tag === 'Transition' || tag === 'transition') {
      return TRANSITION
    } else if (tag === 'TransitionGroup' || tag === 'transition-group') {
      return TRANSITION_GROUP
    }
  },

  // https://html.spec.whatwg.org/multipage/parsing.html#tree-construction-dispatcher
  // 根据当前父节点所在命名空间，推导子节点应该使用 HTML / SVG / MathML 中的哪一种。
  getNamespace(tag, parent, rootNamespace) {
    let ns = parent ? parent.ns : rootNamespace
    if (parent && ns === Namespaces.MATH_ML) {
      if (parent.tag === 'annotation-xml') {
        if (tag === 'svg') {
          return Namespaces.SVG
        }
        if (
          parent.props.some(
            a =>
              a.type === NodeTypes.ATTRIBUTE &&
              a.name === 'encoding' &&
              a.value != null &&
              (a.value.content === 'text/html' ||
                a.value.content === 'application/xhtml+xml'),
          )
        ) {
          ns = Namespaces.HTML
        }
      } else if (
        /^m(?:[ions]|text)$/.test(parent.tag) &&
        tag !== 'mglyph' &&
        tag !== 'malignmark'
      ) {
        ns = Namespaces.HTML
      }
    } else if (parent && ns === Namespaces.SVG) {
      if (
        parent.tag === 'foreignObject' ||
        parent.tag === 'desc' ||
        parent.tag === 'title'
      ) {
        ns = Namespaces.HTML
      }
    }

    if (ns === Namespaces.HTML) {
      if (tag === 'svg') {
        return Namespaces.SVG
      }
      if (tag === 'math') {
        return Namespaces.MATH_ML
      }
    }
    return ns
  },
}
