/**
 * 编译器 compat 配置表。
 *
 * compat 模式允许 Vue 3 编译器在特定语法点上保留 Vue 2 兼容行为，
 * 这里统一维护开关读取、启用判断与弃用警告输出逻辑。
 */
import type { SourceLocation } from '../ast'
import type { CompilerError } from '../errors'
import type { MergedParserOptions } from '../parser'
import type { TransformContext } from '../transform'

export type CompilerCompatConfig = Partial<
  Record<CompilerDeprecationTypes, boolean | 'suppress-warning'>
> & {
  MODE?: 2 | 3
}

export interface CompilerCompatOptions {
  compatConfig?: CompilerCompatConfig
}

export enum CompilerDeprecationTypes {
  COMPILER_IS_ON_ELEMENT = 'COMPILER_IS_ON_ELEMENT',
  COMPILER_V_BIND_SYNC = 'COMPILER_V_BIND_SYNC',
  COMPILER_V_BIND_OBJECT_ORDER = 'COMPILER_V_BIND_OBJECT_ORDER',
  COMPILER_V_ON_NATIVE = 'COMPILER_V_ON_NATIVE',
  COMPILER_V_IF_V_FOR_PRECEDENCE = 'COMPILER_V_IF_V_FOR_PRECEDENCE',
  COMPILER_NATIVE_TEMPLATE = 'COMPILER_NATIVE_TEMPLATE',
  COMPILER_INLINE_TEMPLATE = 'COMPILER_INLINE_TEMPLATE',
  COMPILER_FILTERS = 'COMPILER_FILTERS',
}

type DeprecationData = {
  message: string | ((...args: any[]) => string)
  link?: string
}

const deprecationData: Record<CompilerDeprecationTypes, DeprecationData> = {
  [CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT]: {
    message:
      `Platform-native elements with "is" prop will no longer be ` +
      `treated as components in Vue 3 unless the "is" value is explicitly ` +
      `prefixed with "vue:".`,
    link: `https://v3-migration.vuejs.org/breaking-changes/custom-elements-interop.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_BIND_SYNC]: {
    message: key =>
      `.sync modifier for v-bind has been removed. Use v-model with ` +
      `argument instead. \`v-bind:${key}.sync\` should be changed to ` +
      `\`v-model:${key}\`.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-model.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER]: {
    message:
      `v-bind="obj" usage is now order sensitive and behaves like JavaScript ` +
      `object spread: it will now overwrite an existing non-mergeable attribute ` +
      `that appears before v-bind in the case of conflict. ` +
      `To retain 2.x behavior, move v-bind to make it the first attribute. ` +
      `You can also suppress this warning if the usage is intended.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-bind.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_ON_NATIVE]: {
    message: `.native modifier for v-on has been removed as is no longer necessary.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-on-native-modifier-removed.html`,
  },

  [CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE]: {
    message:
      `v-if / v-for precedence when used on the same element has changed ` +
      `in Vue 3: v-if now takes higher precedence and will no longer have ` +
      `access to v-for scope variables. It is best to avoid the ambiguity ` +
      `with <template> tags or use a computed property that filters v-for ` +
      `data source.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/v-if-v-for.html`,
  },

  [CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE]: {
    message:
      `<template> with no special directives will render as a native template ` +
      `element instead of its inner content in Vue 3.`,
  },

  [CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE]: {
    message: `"inline-template" has been removed in Vue 3.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/inline-template-attribute.html`,
  },

  [CompilerDeprecationTypes.COMPILER_FILTERS]: {
    message:
      `filters have been removed in Vue 3. ` +
      `The "|" symbol will be treated as native JavaScript bitwise OR operator. ` +
      `Use method calls or computed properties instead.`,
    link: `https://v3-migration.vuejs.org/breaking-changes/filters.html`,
  },
}

/**
 * 从 parser/transform 上下文里读取某个 compat 配置项的最终值。
 */
function getCompatValue(
  key: CompilerDeprecationTypes | 'MODE',
  { compatConfig }: MergedParserOptions | TransformContext,
) {
  const value = compatConfig && compatConfig[key]
  if (key === 'MODE') {
    return value || 3 // compiler defaults to v3 behavior
  } else {
    return value
  }
}

/**
 * 判断某个兼容分支在当前上下文中是否处于启用状态。
 */
export function isCompatEnabled(
  key: CompilerDeprecationTypes,
  context: MergedParserOptions | TransformContext,
): boolean {
  const mode = getCompatValue('MODE', context)
  const value = getCompatValue(key, context)
  // in v3 mode, only enable if explicitly set to true
  // otherwise enable for any non-false value
  return mode === 3 ? value === true : value !== false
}

/**
 * 检查 compat 功能是否启用，并在开发环境需要时发出弃用警告。
 */
export function checkCompatEnabled(
  key: CompilerDeprecationTypes,
  context: MergedParserOptions | TransformContext,
  loc: SourceLocation | null,
  ...args: any[]
): boolean {
  const enabled = isCompatEnabled(key, context)
  if (__DEV__ && enabled) {
    warnDeprecation(key, context, loc, ...args)
  }
  return enabled
}

/**
 * 为某个 compat 语法点构造并发出弃用警告。
 */
export function warnDeprecation(
  key: CompilerDeprecationTypes,
  context: MergedParserOptions | TransformContext,
  loc: SourceLocation | null,
  ...args: any[]
): void {
  const val = getCompatValue(key, context)
  if (val === 'suppress-warning') {
    return
  }
  const { message, link } = deprecationData[key]
  const msg = `(deprecation ${key}) ${
    typeof message === 'function' ? message(...args) : message
  }${link ? `\n  Details: ${link}` : ``}`

  const err = new SyntaxError(msg) as CompilerError
  err.code = key
  if (loc) err.loc = loc
  context.onWarn(err)
}
