/**
 * HTML 嵌套关系校验 transform。
 *
 * 开发环境下对原生元素父子关系做一层静态校验，
 * 尽早提示会导致 hydration 或浏览器解析异常的非法结构。
 */
import {
  type CompilerError,
  ElementTypes,
  type NodeTransform,
  NodeTypes,
} from '@vue/compiler-core'
import { isValidHTMLNesting } from '../htmlNesting'

/**
 * 在父子元素都是原生 HTML 元素时检查其嵌套是否合法。
 */
export const validateHtmlNesting: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.ELEMENT &&
    context.parent &&
    context.parent.type === NodeTypes.ELEMENT &&
    context.parent.tagType === ElementTypes.ELEMENT &&
    !isValidHTMLNesting(context.parent.tag, node.tag)
  ) {
    const error = new SyntaxError(
      `<${node.tag}> cannot be child of <${context.parent.tag}>, ` +
        'according to HTML specifications. ' +
        'This can cause hydration errors or ' +
        'potentially disrupt future functionality.',
    ) as CompilerError
    error.loc = node.loc
    context.onWarn(error)
  }
}
