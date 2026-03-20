/**
 * `v-show` DOM transform。
 *
 * `v-show` 主要依赖运行时指令处理，这里只负责参数校验并返回对应 helper。
 */
import type { DirectiveTransform } from '@vue/compiler-core'
import { DOMErrorCodes, createDOMCompilerError } from '../errors'
import { V_SHOW } from '../runtimeHelpers'

/**
 * 为 `v-show` 注册运行时指令。
 */
export const transformShow: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_SHOW_NO_EXPRESSION, loc),
    )
  }

  return {
    props: [],
    needRuntime: context.helper(V_SHOW),
  }
}
