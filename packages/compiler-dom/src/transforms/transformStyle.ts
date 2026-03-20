/**
 * 静态 style 属性 transform。
 *
 * 它会把 `style="color:red"` 这样的静态内联样式，
 * 预先改写成等价的动态 `:style="{ color: 'red' }"` 表达式节点。
 */
import {
  ConstantTypes,
  type NodeTransform,
  NodeTypes,
  type SimpleExpressionNode,
  type SourceLocation,
  createSimpleExpression,
} from '@vue/compiler-core'
import { parseStringStyle } from '@vue/shared'

// Parse inline CSS strings for static style attributes into an object.
// This is a NodeTransform since it works on the static `style` attribute and
// converts it into a dynamic equivalent:
// style="color: red" -> :style='{ "color": "red" }'
// It is then processed by `transformElement` and included in the generated
// props.
/**
 * 把静态 `style` 属性转换成动态 style 绑定表达式。
 */
export const transformStyle: NodeTransform = node => {
  if (node.type === NodeTypes.ELEMENT) {
    node.props.forEach((p, i) => {
      if (p.type === NodeTypes.ATTRIBUTE && p.name === 'style' && p.value) {
        // replace p with an expression node
        node.props[i] = {
          type: NodeTypes.DIRECTIVE,
          name: `bind`,
          arg: createSimpleExpression(`style`, true, p.loc),
          exp: parseInlineCSS(p.value.content, p.loc),
          modifiers: [],
          loc: p.loc,
        }
      }
    })
  }
}

/**
 * 把 CSS 文本解析成对象并包成可字符串化的简单表达式。
 */
const parseInlineCSS = (
  cssText: string,
  loc: SourceLocation,
): SimpleExpressionNode => {
  const normalized = parseStringStyle(cssText)
  return createSimpleExpression(
    JSON.stringify(normalized),
    false,
    loc,
    ConstantTypes.CAN_STRINGIFY,
  )
}
