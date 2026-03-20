/**
 * `v-memo` transform。
 *
 * 它会把目标子树包装成 `withMemo()` 调用，让运行时可以基于依赖数组
 * 跳过整段子树的重新求值与 patch。
 */
import type { NodeTransform } from '../transform'
import { findDir } from '../utils'
import {
  ElementTypes,
  type MemoExpression,
  NodeTypes,
  type PlainElementNode,
  convertToBlock,
  createCallExpression,
  createFunctionExpression,
} from '../ast'
import { WITH_MEMO } from '../runtimeHelpers'

const seen = new WeakSet()

/**
 * 识别 `v-memo`，并在退出阶段把当前节点改写成 memo 包装结构。
 */
export const transformMemo: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT) {
    const dir = findDir(node, 'memo')
    if (!dir || seen.has(node)) {
      return
    }
    seen.add(node)
    return () => {
      const codegenNode =
        node.codegenNode ||
        (context.currentNode as PlainElementNode).codegenNode
      if (codegenNode && codegenNode.type === NodeTypes.VNODE_CALL) {
        // non-component sub tree should be turned into a block
        if (node.tagType !== ElementTypes.COMPONENT) {
          convertToBlock(codegenNode, context)
        }
        node.codegenNode = createCallExpression(context.helper(WITH_MEMO), [
          dir.exp!,
          createFunctionExpression(undefined, codegenNode),
          `_cache`,
          String(context.cached.length),
        ]) as MemoExpression
        // increment cache count
        context.cached.push(null)
      }
    }
  }
}
