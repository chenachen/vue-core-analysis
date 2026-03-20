/**
 * DOM 平台编译入口。
 *
 * `compiler-dom` 不会重写整条编译链，而是在 `compiler-core` 之上注入：
 * - DOM 专属 parser 选项（HTML / SVG / MathML、内建组件识别等）
 * - DOM 指令 transform（`v-html` / `v-text` / DOM 版 `v-model` / `v-show`）
 * - DOM 节点 transform（style、静态字符串化、HTML 嵌套校验等）
 */
import {
  type CodegenResult,
  type CompilerOptions,
  type DirectiveTransform,
  type NodeTransform,
  type ParserOptions,
  type RootNode,
  baseCompile,
  baseParse,
  noopDirectiveTransform,
} from '@vue/compiler-core'
import { parserOptions } from './parserOptions'
import { transformStyle } from './transforms/transformStyle'
import { transformVHtml } from './transforms/vHtml'
import { transformVText } from './transforms/vText'
import { transformModel } from './transforms/vModel'
import { transformOn } from './transforms/vOn'
import { transformShow } from './transforms/vShow'
import { transformTransition } from './transforms/Transition'
import { stringifyStatic } from './transforms/stringifyStatic'
import { ignoreSideEffectTags } from './transforms/ignoreSideEffectTags'
import { validateHtmlNesting } from './transforms/validateHtmlNesting'
import { extend } from '@vue/shared'

export { parserOptions }

// DOM 节点 transform 会在 core 默认 transform 之前/之中执行，
// 用来补齐平台相关的 AST 改写与开发期校验。
export const DOMNodeTransforms: NodeTransform[] = [
  transformStyle,
  ...(__DEV__ ? [transformTransition, validateHtmlNesting] : []),
]

// DOM 指令 transform 覆盖或补充了 core 的通用指令行为。
export const DOMDirectiveTransforms: Record<string, DirectiveTransform> = {
  cloak: noopDirectiveTransform,
  html: transformVHtml,
  text: transformVText,
  model: transformModel, // override compiler-core
  on: transformOn, // override compiler-core
  show: transformShow,
}

/**
 * DOM 编译入口。
 *
 * 它本质上只是为 `baseCompile()` 预置 DOM parser / transform 配置，
 * 然后把真正的编译工作继续交回 `compiler-core`。
 */
export function compile(
  src: string | RootNode,
  options: CompilerOptions = {},
): CodegenResult {
  return baseCompile(
    src,
    extend({}, parserOptions, options, {
      nodeTransforms: [
        // ignore <script> and <tag>
        // this is not put inside DOMNodeTransforms because that list is used
        // by compiler-ssr to generate vnode fallback branches
        ignoreSideEffectTags,
        ...DOMNodeTransforms,
        ...(options.nodeTransforms || []),
      ],
      directiveTransforms: extend(
        {},
        DOMDirectiveTransforms,
        options.directiveTransforms || {},
      ),
      transformHoist: __BROWSER__ ? null : stringifyStatic,
    }),
  )
}

/**
 * 仅执行 DOM parser，常用于测试、SFC 解析和上层自定义流程复用。
 */
export function parse(template: string, options: ParserOptions = {}): RootNode {
  return baseParse(template, extend({}, parserOptions, options))
}

export * from './runtimeHelpers'
export { transformStyle } from './transforms/transformStyle'
export {
  createDOMCompilerError,
  DOMErrorCodes,
  DOMErrorMessages,
} from './errors'
export * from '@vue/compiler-core'
