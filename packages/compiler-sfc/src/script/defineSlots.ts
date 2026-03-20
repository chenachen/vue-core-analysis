/**
 * 处理 `<script setup>` 中的 `defineSlots` 宏。
 */
import type { LVal, Node } from '@babel/types'
import { isCallOf } from './utils'
import type { ScriptCompileContext } from './context'

export const DEFINE_SLOTS = 'defineSlots'

/**
 * 识别 `defineSlots()`，并在有接收变量时改写成 `useSlots()`。
 */
export function processDefineSlots(
  ctx: ScriptCompileContext,
  node: Node,
  declId?: LVal,
): boolean {
  if (!isCallOf(node, DEFINE_SLOTS)) {
    return false
  }
  if (ctx.hasDefineSlotsCall) {
    ctx.error(`duplicate ${DEFINE_SLOTS}() call`, node)
  }
  ctx.hasDefineSlotsCall = true

  if (node.arguments.length > 0) {
    ctx.error(`${DEFINE_SLOTS}() cannot accept arguments`, node)
  }

  if (declId) {
    ctx.s.overwrite(
      ctx.startOffset! + node.start!,
      ctx.startOffset! + node.end!,
      `${ctx.helper('useSlots')}()`,
    )
  }

  return true
}
