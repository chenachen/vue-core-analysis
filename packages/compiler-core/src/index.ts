/**
 * `compiler-core` 是 Vue 编译器的最内层：
 * - `parser` 把模板源码解析成 AST
 * - `transform` 在 AST 上执行一轮轮平台无关的语义变换
 * - `codegen` 把最终 AST 生成 render 函数字符串
 *
 * `compiler-dom`、`compiler-ssr` 与 `compiler-sfc` 都是在这里暴露的能力之上
 * 做平台或文件格式层面的扩展，因此阅读编译器源码时通常从本文件导出的入口开始。
 */
export { baseCompile } from './compile'

// 继续导出 parse / transform / generate 等低层能力，方便上层编译器按需复用。
export {
  type CompilerOptions,
  type ParserOptions,
  type TransformOptions,
  type CodegenOptions,
  type HoistTransform,
  type BindingMetadata,
  BindingTypes,
} from './options'
export { baseParse } from './parser'
export {
  transform,
  type TransformContext,
  createTransformContext,
  traverseNode,
  createStructuralDirectiveTransform,
  type NodeTransform,
  type StructuralDirectiveTransform,
  type DirectiveTransform,
} from './transform'
export {
  generate,
  type CodegenContext,
  type CodegenResult,
  type CodegenSourceMapGenerator,
  type RawSourceMap,
} from './codegen'
export {
  ErrorCodes,
  errorMessages,
  createCompilerError,
  type CoreCompilerError,
  type CompilerError,
} from './errors'

export * from './ast'
export * from './utils'
export * from './babelUtils'
export * from './runtimeHelpers'

// 暴露内置 transform，方便上层编译器增删改默认行为。
export { getBaseTransformPreset, type TransformPreset } from './compile'
export { transformModel } from './transforms/vModel'
export { transformOn } from './transforms/vOn'
export { transformBind } from './transforms/vBind'
export { noopDirectiveTransform } from './transforms/noopDirectiveTransform'
export { processIf } from './transforms/vIf'
export { processFor, createForLoopParams } from './transforms/vFor'
export {
  transformExpression,
  processExpression,
  stringifyExpression,
} from './transforms/transformExpression'
export {
  buildSlots,
  type SlotFnBuilder,
  trackVForSlotScopes,
  trackSlotScopes,
} from './transforms/vSlot'
export {
  transformElement,
  resolveComponentType,
  buildProps,
  buildDirectiveArgs,
  type PropsExpression,
} from './transforms/transformElement'
export { processSlotOutlet } from './transforms/transformSlotOutlet'
export { getConstantType } from './transforms/cacheStatic'
export { generateCodeFrame } from '@vue/shared'

// 2.x 兼容编译分支仅在 compat 模式下使用。
export {
  checkCompatEnabled,
  warnDeprecation,
  CompilerDeprecationTypes,
} from './compat/compatConfig'
