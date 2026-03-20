/**
 * `v-html` DOM transform。
 *
 * 它会把 `v-html` 直接编译成 `innerHTML` prop，
 * 并在缺失表达式或已有子节点时给出 DOM 专属错误。
 */
import {
  type DirectiveTransform,
  createObjectProperty,
  createSimpleExpression,
} from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

/**
 * 把 `v-html` 改写成 `innerHTML` 赋值。
 */
export const transformVHtml: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_NO_EXPRESSION, loc),
    )
  }
  if (node.children.length) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_WITH_CHILDREN, loc),
    )
    node.children.length = 0
  }
  return {
    props: [
      createObjectProperty(
        createSimpleExpression(`innerHTML`, true, loc),
        exp || createSimpleExpression('', true),
      ),
    ],
  }
}
