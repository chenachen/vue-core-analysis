/**
 * 编译主流程调度器。
 *
 * 这个文件负责把 `parse -> transform -> generate` 三个阶段真正串起来，
 * 同时决定默认启用哪些通用 transform，以及在不同构建模式下如何补齐编译选项。
 */
import type { CompilerOptions } from './options'
import { baseParse } from './parser'
import {
  type DirectiveTransform,
  type NodeTransform,
  transform,
} from './transform'
import { type CodegenResult, generate } from './codegen'
import type { RootNode } from './ast'
import { extend, isString } from '@vue/shared'
import { transformIf } from './transforms/vIf'
import { transformFor } from './transforms/vFor'
import { transformExpression } from './transforms/transformExpression'
import { transformSlotOutlet } from './transforms/transformSlotOutlet'
import { transformElement } from './transforms/transformElement'
import { transformOn } from './transforms/vOn'
import { transformBind } from './transforms/vBind'
import { trackSlotScopes, trackVForSlotScopes } from './transforms/vSlot'
import { transformText } from './transforms/transformText'
import { transformOnce } from './transforms/vOnce'
import { transformModel } from './transforms/vModel'
import { transformFilter } from './compat/transformFilter'
import { ErrorCodes, createCompilerError, defaultOnError } from './errors'
import { transformMemo } from './transforms/vMemo'

export type TransformPreset = [
  NodeTransform[],
  Record<string, DirectiveTransform>,
]

/**
 * 返回编译器默认使用的 transform 预设。
 *
 * 这里定义了内置 node/directive transform 的顺序。顺序很关键：
 * 某些 transform 负责改写结构（如 `v-if` / `v-for`），某些 transform
 * 依赖前面的改写结果继续补充表达式、元素 codegen 或文本合并能力。
 */
export function getBaseTransformPreset(
  prefixIdentifiers?: boolean,
): TransformPreset {
  return [
    [
      transformOnce,
      transformIf,
      transformMemo,
      transformFor,
      ...(__COMPAT__ ? [transformFilter] : []),
      ...(!__BROWSER__ && prefixIdentifiers
        ? [
            // order is important
            trackVForSlotScopes,
            transformExpression,
          ]
        : __BROWSER__ && __DEV__
          ? [transformExpression]
          : []),
      transformSlotOutlet,
      transformElement,
      trackSlotScopes,
      transformText,
    ],
    {
      on: transformOn,
      bind: transformBind,
      model: transformModel,
    },
  ]
}

// we name it `baseCompile` so that higher order compilers like
// @vue/compiler-dom can export `compile` while re-exporting everything else.
/**
 * 平台无关的编译入口。
 *
 * 它会先归一化编译选项，再根据源码或 AST 执行：
 * 1. `baseParse`：把模板字符串解析成 AST
 * 2. `transform`：在 AST 上应用默认与用户传入的 transform
 * 3. `generate`：把改写后的 AST 生成 render 函数代码
 *
 * `compiler-dom`/`compiler-ssr` 的 `compile()` 本质上都会回到这里，只是会
 * 预先注入各自的平台专属 transform 与 parser 配置。
 */
export function baseCompile(
  source: string | RootNode,
  options: CompilerOptions = {},
): CodegenResult {
  const onError = options.onError || defaultOnError
  const isModuleMode = options.mode === 'module'
  /* v8 ignore start */
  if (__BROWSER__) {
    if (options.prefixIdentifiers === true) {
      onError(createCompilerError(ErrorCodes.X_PREFIX_ID_NOT_SUPPORTED))
    } else if (isModuleMode) {
      onError(createCompilerError(ErrorCodes.X_MODULE_MODE_NOT_SUPPORTED))
    }
  }
  /* v8 ignore stop */

  const prefixIdentifiers =
    !__BROWSER__ && (options.prefixIdentifiers === true || isModuleMode)
  if (!prefixIdentifiers && options.cacheHandlers) {
    onError(createCompilerError(ErrorCodes.X_CACHE_HANDLER_NOT_SUPPORTED))
  }
  if (options.scopeId && !isModuleMode) {
    onError(createCompilerError(ErrorCodes.X_SCOPE_ID_NOT_SUPPORTED))
  }

  // 先基于用户选项推导出本轮编译真正使用的基础配置。
  const resolvedOptions = extend({}, options, {
    prefixIdentifiers,
  })
  // 上层可以直接传 AST 复用 parse 结果；否则这里负责把模板源码转成 AST。
  const ast = isString(source) ? baseParse(source, resolvedOptions) : source
  const [nodeTransforms, directiveTransforms] =
    getBaseTransformPreset(prefixIdentifiers)

  if (!__BROWSER__ && options.isTS) {
    const { expressionPlugins } = options
    if (!expressionPlugins || !expressionPlugins.includes('typescript')) {
      options.expressionPlugins = [...(expressionPlugins || []), 'typescript']
    }
  }

  // transform 阶段会在 AST 上做结构改写、表达式分析、静态提升等工作。
  transform(
    ast,
    extend({}, resolvedOptions, {
      nodeTransforms: [
        ...nodeTransforms,
        ...(options.nodeTransforms || []), // user transforms
      ],
      directiveTransforms: extend(
        {},
        directiveTransforms,
        options.directiveTransforms || {}, // user transforms
      ),
    }),
  )

  // generate 根据 transform 产出的 codegenNode 生成最终 render 函数字符串。
  return generate(ast, resolvedOptions)
}
