/**
 * 过滤客户端组件模板中的副作用标签。
 *
 * `<script>` 和 `<style>` 不应该参与客户端组件模板渲染，
 * 这里会在开发期报警并把它们直接从 AST 中移除。
 */
import { ElementTypes, type NodeTransform, NodeTypes } from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'

/**
 * 识别并移除模板中的 `<script>` / `<style>`。
 */
export const ignoreSideEffectTags: NodeTransform = (node, context) => {
  if (
    node.type === NodeTypes.ELEMENT &&
    node.tagType === ElementTypes.ELEMENT &&
    (node.tag === 'script' || node.tag === 'style')
  ) {
    __DEV__ &&
      context.onError(
        createDOMCompilerError(
          DOMErrorCodes.X_IGNORED_SIDE_EFFECT_TAG,
          node.loc,
        ),
      )
    context.removeNode()
  }
}
