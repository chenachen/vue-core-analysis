/**
 * 普通 `<script>` 编译辅助。
 *
 * 它负责处理非 setup 脚本下的默认导出重写、绑定分析与 CSS 变量注入。
 */
import { analyzeScriptBindings } from './analyzeScriptBindings'
import type { ScriptCompileContext } from './context'
import MagicString from 'magic-string'
import { rewriteDefaultAST } from '../rewriteDefault'
import { genNormalScriptCssVarsCode } from '../style/cssVars'
import type { SFCScriptBlock } from '../parse'

export const normalScriptDefaultVar = `__default__`

/**
 * 处理只有普通 `<script>` 的 SFC。
 */
export function processNormalScript(
  ctx: ScriptCompileContext,
  scopeId: string,
): SFCScriptBlock {
  const script = ctx.descriptor.script!
  if (script.lang && !ctx.isJS && !ctx.isTS) {
    // do not process non js/ts script blocks
    return script
  }
  try {
    let content = script.content
    let map = script.map
    const scriptAst = ctx.scriptAst!
    const bindings = analyzeScriptBindings(scriptAst.body)
    const { cssVars } = ctx.descriptor
    const { genDefaultAs, isProd } = ctx.options

    if (cssVars.length || genDefaultAs) {
      const defaultVar = genDefaultAs || normalScriptDefaultVar
      const s = new MagicString(content)
      rewriteDefaultAST(scriptAst.body, s, defaultVar)
      content = s.toString()
      if (cssVars.length && !ctx.options.templateOptions?.ssr) {
        content += genNormalScriptCssVarsCode(
          cssVars,
          bindings,
          scopeId,
          !!isProd,
          defaultVar,
        )
      }
      if (!genDefaultAs) {
        content += `\nexport default ${defaultVar}`
      }
    }
    return {
      ...script,
      content,
      map,
      bindings,
      scriptAst: scriptAst.body,
    }
  } catch (e: any) {
    // silently fallback if parse fails since user may be using custom
    // babel syntax
    return script
  }
}
