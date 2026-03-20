/**
 * 处理 `<script setup>` 中的 `defineExpose` 宏。
 */
import type { Node } from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'

export const DEFINE_EXPOSE = 'defineExpose'

/**
 * 识别并登记 `defineExpose()` 调用。
 */
export function processDefineExpose(
  ctx: ScriptCompileContext,
  node: Node,
): boolean {
  if (isCallOf(node, DEFINE_EXPOSE)) {
    if (ctx.hasDefineExposeCall) {
      ctx.error(`duplicate ${DEFINE_EXPOSE}() call`, node)
    }
    ctx.hasDefineExposeCall = true
    return true
  }
  return false
}
