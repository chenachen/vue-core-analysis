/**
 * `compiler-sfc/script` 共享工具集合。
 */
import type {
  CallExpression,
  Expression,
  Identifier,
  ImportDefaultSpecifier,
  ImportNamespaceSpecifier,
  ImportSpecifier,
  Node,
  StringLiteral,
} from '@babel/types'
import path from 'path'

export const UNKNOWN_TYPE = 'Unknown'

/**
 * 把对象 key AST 节点解析成静态字符串键名。
 */
export function resolveObjectKey(
  node: Node,
  computed: boolean,
): string | undefined {
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
      return String(node.value)
    case 'Identifier':
      if (!computed) return node.name
  }
  return undefined
}

/**
 * 过滤空值并把字符串片段拼成逗号分隔列表。
 */
export function concatStrings(
  strs: Array<string | null | undefined | false>,
): string {
  return strs.filter((s): s is string => !!s).join(', ')
}

/**
 * 判断节点是否属于各种字面量节点。
 */
export function isLiteralNode(node: Node): boolean {
  return node.type.endsWith('Literal')
}

/**
 * 判断节点是否是指定 callee 名称的调用表达式。
 */
export function isCallOf(
  node: Node | null | undefined,
  test: string | ((id: string) => boolean) | null | undefined,
): node is CallExpression {
  return !!(
    node &&
    test &&
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    (typeof test === 'string'
      ? node.callee.name === test
      : test(node.callee.name))
  )
}

/**
 * 把运行时类型数组转成 Vue props 选项所需的字符串形式。
 */
export function toRuntimeTypeString(types: string[]): string {
  return types.length > 1 ? `[${types.join(', ')}]` : types[0]
}

/**
 * 获取 import specifier 对应的原始导入名。
 */
export function getImportedName(
  specifier:
    | ImportSpecifier
    | ImportDefaultSpecifier
    | ImportNamespaceSpecifier,
): string {
  if (specifier.type === 'ImportSpecifier')
    return specifier.imported.type === 'Identifier'
      ? specifier.imported.name
      : specifier.imported.value
  else if (specifier.type === 'ImportNamespaceSpecifier') return '*'
  return 'default'
}

/** 从 Identifier / StringLiteral 表达式中提取字符串 id。 */
export function getId(node: Identifier | StringLiteral): string
/** 从一般表达式中提取静态可识别的字符串 id。 */
export function getId(node: Expression): string | null
/** 从一般表达式中提取静态可识别的字符串 id。 */
export function getId(node: Expression) {
  return node.type === 'Identifier'
    ? node.name
    : node.type === 'StringLiteral'
      ? node.value
      : null
}

/**
 * 恒等函数，供大小写敏感文件系统直接复用。
 */
const identity = (str: string) => str
const fileNameLowerCaseRegExp = /[^\u0130\u0131\u00DFa-z0-9\\/:\-_\. ]+/g
/**
 * 安全地把文件名字符降为小写。
 */
const toLowerCase = (str: string) => str.toLowerCase()

/**
 * 按 TypeScript 内部规则把文件名正规化为不区分大小写版本。
 */
function toFileNameLowerCase(x: string) {
  return fileNameLowerCaseRegExp.test(x)
    ? x.replace(fileNameLowerCaseRegExp, toLowerCase)
    : x
}

/**
 * We need `getCanonicalFileName` when creating ts module resolution cache,
 * but TS does not expose it directly. This implementation is repllicated from
 * the TS source code.
 */
export function createGetCanonicalFileName(
  useCaseSensitiveFileNames: boolean,
): (str: string) => string {
  return useCaseSensitiveFileNames ? identity : toFileNameLowerCase
}

// in the browser build, the polyfill doesn't expose posix, but defaults to
// posix behavior.
const normalize = (path.posix || path).normalize
const windowsSlashRE = /\\/g
/**
 * 统一把路径转换成使用 `/` 的规范形式。
 */
export function normalizePath(p: string): string {
  return normalize(p.replace(windowsSlashRE, '/'))
}

export const joinPaths: (...paths: string[]) => string = (path.posix || path)
  .join

/**
 * key may contain symbols
 * e.g. onUpdate:modelValue -> "onUpdate:modelValue"
 */
export const propNameEscapeSymbolsRE: RegExp =
  /[ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~\-]/

/**
 * 为运行时代码中的属性名按需加上字符串引号。
 */
export function getEscapedPropName(key: string): string {
  return propNameEscapeSymbolsRE.test(key) ? JSON.stringify(key) : key
}
