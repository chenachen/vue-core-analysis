/**
 * `compiler-sfc` 的 TypeScript 类型解析引擎。
 *
 * 它负责把宏里的类型声明解析成可用于运行时 props / emits 推导的结构，
 * 并按需跨文件解析 import、tsconfig、namespace、utility type 与 `.vue` 文件。
 */
import type {
  Expression,
  Identifier,
  Node,
  Statement,
  TSCallSignatureDeclaration,
  TSEnumDeclaration,
  TSExpressionWithTypeArguments,
  TSFunctionType,
  TSImportType,
  TSIndexedAccessType,
  TSInterfaceDeclaration,
  TSMappedType,
  TSMethodSignature,
  TSModuleBlock,
  TSModuleDeclaration,
  TSPropertySignature,
  TSQualifiedName,
  TSType,
  TSTypeAnnotation,
  TSTypeElement,
  TSTypeLiteral,
  TSTypeQuery,
  TSTypeReference,
  TemplateLiteral,
} from '@babel/types'
import {
  UNKNOWN_TYPE,
  createGetCanonicalFileName,
  getId,
  getImportedName,
  joinPaths,
  normalizePath,
} from './utils'
import { type ScriptCompileContext, resolveParserPlugins } from './context'
import type { ImportBinding, SFCScriptCompileOptions } from '../compileScript'
import { capitalize, hasOwn } from '@vue/shared'
import { parse as babelParse } from '@babel/parser'
import { parse } from '../parse'
import { createCache } from '../cache'
import type TS from 'typescript'
import { dirname, extname, join } from 'path'
import { minimatch as isMatch } from 'minimatch'
import * as process from 'process'

export type SimpleTypeResolveOptions = Partial<
  Pick<
    SFCScriptCompileOptions,
    'globalTypeFiles' | 'fs' | 'babelParserPlugins' | 'isProd'
  >
>

/**
 * TypeResolveContext is compatible with ScriptCompileContext
 * but also allows a simpler version of it with minimal required properties
 * when resolveType needs to be used in a non-SFC context, e.g. in a babel
 * plugin. The simplest context can be just:
 * ```ts
 * const ctx: SimpleTypeResolveContext = {
 *   filename: '...',
 *   source: '...',
 *   options: {},
 *   error() {},
 *   ast: []
 * }
 * ```
 */
export type SimpleTypeResolveContext = Pick<
  ScriptCompileContext,
  // file
  | 'source'
  | 'filename'

  // utils
  | 'error'
  | 'helper'
  | 'getString'

  // props
  | 'propsTypeDecl'
  | 'propsRuntimeDefaults'
  | 'propsDestructuredBindings'

  // emits
  | 'emitsTypeDecl'

  // customElement
  | 'isCE'
> &
  Partial<
    Pick<ScriptCompileContext, 'scope' | 'globalScopes' | 'deps' | 'fs'>
  > & {
    ast: Statement[]
    options: SimpleTypeResolveOptions
  }

export type TypeResolveContext = ScriptCompileContext | SimpleTypeResolveContext

type Import = Pick<ImportBinding, 'source' | 'imported'>

interface WithScope {
  _ownerScope: TypeScope
}

// scope types always has ownerScope attached
type ScopeTypeNode = Node &
  WithScope & { _ns?: TSModuleDeclaration & WithScope }

export class TypeScope {
  constructor(
    public filename: string,
    public source: string,
    public offset: number = 0,
    public imports: Record<string, Import> = Object.create(null),
    public types: Record<string, ScopeTypeNode> = Object.create(null),
    public declares: Record<string, ScopeTypeNode> = Object.create(null),
  ) {}
  isGenericScope = false
  resolvedImportSources: Record<string, string> = Object.create(null)
  exportedTypes: Record<string, ScopeTypeNode> = Object.create(null)
  exportedDeclares: Record<string, ScopeTypeNode> = Object.create(null)
}

export interface MaybeWithScope {
  _ownerScope?: TypeScope
}

interface ResolvedElements {
  props: Record<
    string,
    (TSPropertySignature | TSMethodSignature) & {
      // resolved props always has ownerScope attached
      _ownerScope: TypeScope
    }
  >
  calls?: (TSCallSignatureDeclaration | TSFunctionType)[]
}

/**
 * Resolve arbitrary type node to a list of type elements that can be then
 * mapped to runtime props or emits.
 */
export function resolveTypeElements(
  ctx: TypeResolveContext,
  node: Node & MaybeWithScope & { _resolvedElements?: ResolvedElements },
  scope?: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  const canCache = !typeParameters
  if (canCache && node._resolvedElements) {
    return node._resolvedElements
  }
  const resolved = innerResolveTypeElements(
    ctx,
    node,
    node._ownerScope || scope || ctxToScope(ctx),
    typeParameters,
  )
  return canCache ? (node._resolvedElements = resolved) : resolved
}

/**
 * 递归解析任意 TS 类型节点，产出统一的 props / call signatures 结构。
 */
function innerResolveTypeElements(
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  if (
    node.leadingComments &&
    node.leadingComments.some(c => c.value.includes('@vue-ignore'))
  ) {
    return { props: {} }
  }
  switch (node.type) {
    case 'TSTypeLiteral':
      return typeElementsToMap(ctx, node.members, scope, typeParameters)
    case 'TSInterfaceDeclaration':
      return resolveInterfaceMembers(ctx, node, scope, typeParameters)
    case 'TSTypeAliasDeclaration':
    case 'TSTypeAnnotation':
    case 'TSParenthesizedType':
      return resolveTypeElements(
        ctx,
        node.typeAnnotation,
        scope,
        typeParameters,
      )
    case 'TSFunctionType': {
      return { props: {}, calls: [node] }
    }
    case 'TSUnionType':
    case 'TSIntersectionType':
      return mergeElements(
        node.types.map(t => resolveTypeElements(ctx, t, scope, typeParameters)),
        node.type,
      )
    case 'TSMappedType':
      return resolveMappedType(ctx, node, scope, typeParameters)
    case 'TSIndexedAccessType': {
      const types = resolveIndexType(ctx, node, scope)
      return mergeElements(
        types.map(t => resolveTypeElements(ctx, t, t._ownerScope)),
        'TSUnionType',
      )
    }
    case 'TSExpressionWithTypeArguments': // referenced by interface extends
    case 'TSTypeReference': {
      const typeName = getReferenceName(node)
      if (
        (typeName === 'ExtractPropTypes' ||
          typeName === 'ExtractPublicPropTypes') &&
        node.typeParameters &&
        scope.imports[typeName]?.source === 'vue'
      ) {
        return resolveExtractPropTypes(
          resolveTypeElements(
            ctx,
            node.typeParameters.params[0],
            scope,
            typeParameters,
          ),
          scope,
        )
      }
      const resolved = resolveTypeReference(ctx, node, scope)
      if (resolved) {
        let typeParams: Record<string, Node> | undefined
        if (
          (resolved.type === 'TSTypeAliasDeclaration' ||
            resolved.type === 'TSInterfaceDeclaration') &&
          resolved.typeParameters &&
          node.typeParameters
        ) {
          typeParams = Object.create(null)
          resolved.typeParameters.params.forEach((p, i) => {
            let param = typeParameters && typeParameters[p.name]
            if (!param) param = node.typeParameters!.params[i]
            typeParams![p.name] = param
          })
        }
        return resolveTypeElements(
          ctx,
          resolved,
          resolved._ownerScope,
          typeParams,
        )
      } else {
        if (typeof typeName === 'string') {
          if (typeParameters && typeParameters[typeName]) {
            return resolveTypeElements(
              ctx,
              typeParameters[typeName],
              scope,
              typeParameters,
            )
          }
          if (
            // @ts-expect-error
            SupportedBuiltinsSet.has(typeName)
          ) {
            return resolveBuiltin(
              ctx,
              node,
              typeName as any,
              scope,
              typeParameters,
            )
          } else if (typeName === 'ReturnType' && node.typeParameters) {
            // limited support, only reference types
            const ret = resolveReturnType(
              ctx,
              node.typeParameters.params[0],
              scope,
            )
            if (ret) {
              return resolveTypeElements(ctx, ret, scope)
            }
          }
        }
        return ctx.error(
          `Unresolvable type reference or unsupported built-in utility type`,
          node,
          scope,
        )
      }
    }
    case 'TSImportType': {
      if (
        getId(node.argument) === 'vue' &&
        node.qualifier?.type === 'Identifier' &&
        node.qualifier.name === 'ExtractPropTypes' &&
        node.typeParameters
      ) {
        return resolveExtractPropTypes(
          resolveTypeElements(ctx, node.typeParameters.params[0], scope),
          scope,
        )
      }
      const sourceScope = importSourceToScope(
        ctx,
        node.argument,
        scope,
        node.argument.value,
      )
      const resolved = resolveTypeReference(ctx, node, sourceScope)
      if (resolved) {
        return resolveTypeElements(ctx, resolved, resolved._ownerScope)
      }
      break
    }
    case 'TSTypeQuery':
      {
        const resolved = resolveTypeReference(ctx, node, scope)
        if (resolved) {
          return resolveTypeElements(ctx, resolved, resolved._ownerScope)
        }
      }
      break
  }
  return ctx.error(`Unresolvable type: ${node.type}`, node, scope)
}

/**
 * 把 type literal / interface body 成员列表映射为属性表与调用签名表。
 */
function typeElementsToMap(
  ctx: TypeResolveContext,
  elements: TSTypeElement[],
  scope = ctxToScope(ctx),
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  const res: ResolvedElements = { props: {} }
  for (const e of elements) {
    if (e.type === 'TSPropertySignature' || e.type === 'TSMethodSignature') {
      // capture generic parameters on node's scope
      if (typeParameters) {
        scope = createChildScope(scope)
        scope.isGenericScope = true
        Object.assign(scope.types, typeParameters)
      }
      ;(e as MaybeWithScope)._ownerScope = scope
      const name = getId(e.key)
      if (name && !e.computed) {
        res.props[name] = e as ResolvedElements['props'][string]
      } else if (e.key.type === 'TemplateLiteral') {
        for (const key of resolveTemplateKeys(ctx, e.key, scope)) {
          res.props[key] = e as ResolvedElements['props'][string]
        }
      } else {
        ctx.error(
          `Unsupported computed key in type referenced by a macro`,
          e.key,
          scope,
        )
      }
    } else if (e.type === 'TSCallSignatureDeclaration') {
      ;(res.calls || (res.calls = [])).push(e)
    }
  }
  return res
}

/**
 * 合并 union / intersection 分支解析出的属性集合。
 */
function mergeElements(
  maps: ResolvedElements[],
  type: 'TSUnionType' | 'TSIntersectionType',
): ResolvedElements {
  if (maps.length === 1) return maps[0]
  const res: ResolvedElements = { props: {} }
  const { props: baseProps } = res
  for (const { props, calls } of maps) {
    for (const key in props) {
      if (!hasOwn(baseProps, key)) {
        baseProps[key] = props[key]
      } else {
        baseProps[key] = createProperty(
          baseProps[key].key,
          {
            type,
            // @ts-expect-error
            types: [baseProps[key], props[key]],
          },
          baseProps[key]._ownerScope,
          baseProps[key].optional || props[key].optional,
        )
      }
    }
    if (calls) {
      ;(res.calls || (res.calls = [])).push(...calls)
    }
  }
  return res
}

/**
 * 构造一个带 owner scope 的虚拟属性签名节点。
 */
function createProperty(
  key: Expression,
  typeAnnotation: TSType,
  scope: TypeScope,
  optional: boolean,
): TSPropertySignature & WithScope {
  return {
    type: 'TSPropertySignature',
    key,
    kind: 'get',
    optional,
    typeAnnotation: {
      type: 'TSTypeAnnotation',
      typeAnnotation,
    },
    _ownerScope: scope,
  }
}

/**
 * 解析 interface 成员，并递归并入 extends 基类中的属性。
 */
function resolveInterfaceMembers(
  ctx: TypeResolveContext,
  node: TSInterfaceDeclaration & MaybeWithScope,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  const base = typeElementsToMap(
    ctx,
    node.body.body,
    node._ownerScope,
    typeParameters,
  )
  if (node.extends) {
    for (const ext of node.extends) {
      try {
        const { props, calls } = resolveTypeElements(ctx, ext, scope)
        for (const key in props) {
          if (!hasOwn(base.props, key)) {
            base.props[key] = props[key]
          }
        }
        if (calls) {
          ;(base.calls || (base.calls = [])).push(...calls)
        }
      } catch (e) {
        ctx.error(
          `Failed to resolve extends base type.\nIf this previously worked in 3.2, ` +
            `you can instruct the compiler to ignore this extend by adding ` +
            `/* @vue-ignore */ before it, for example:\n\n` +
            `interface Props extends /* @vue-ignore */ Base {}\n\n` +
            `Note: both in 3.2 or with the ignore, the properties in the base ` +
            `type are treated as fallthrough attrs at runtime.`,
          ext,
          scope,
        )
      }
    }
  }
  return base
}

/**
 * 展开 mapped type，生成对应的属性映射。
 */
function resolveMappedType(
  ctx: TypeResolveContext,
  node: TSMappedType,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  const res: ResolvedElements = { props: {} }
  let keys: string[]
  if (node.nameType) {
    const { name, constraint } = node.typeParameter
    scope = createChildScope(scope)
    Object.assign(scope.types, { ...typeParameters, [name]: constraint })
    keys = resolveStringType(ctx, node.nameType, scope)
  } else {
    keys = resolveStringType(ctx, node.typeParameter.constraint!, scope)
  }
  for (const key of keys) {
    res.props[key] = createProperty(
      {
        type: 'Identifier',
        name: key,
      },
      node.typeAnnotation!,
      scope,
      !!node.optional,
    )
  }
  return res
}

/**
 * 解析索引访问类型，得到被访问成员的具体类型列表。
 */
function resolveIndexType(
  ctx: TypeResolveContext,
  node: TSIndexedAccessType,
  scope: TypeScope,
): (TSType & MaybeWithScope)[] {
  if (node.indexType.type === 'TSNumberKeyword') {
    return resolveArrayElementType(ctx, node.objectType, scope)
  }

  const { indexType, objectType } = node
  const types: TSType[] = []
  let keys: string[]
  let resolved: ResolvedElements
  if (indexType.type === 'TSStringKeyword') {
    resolved = resolveTypeElements(ctx, objectType, scope)
    keys = Object.keys(resolved.props)
  } else {
    keys = resolveStringType(ctx, indexType, scope)
    resolved = resolveTypeElements(ctx, objectType, scope)
  }
  for (const key of keys) {
    const targetType = resolved.props[key]?.typeAnnotation?.typeAnnotation
    if (targetType) {
      ;(targetType as TSType & MaybeWithScope)._ownerScope =
        resolved.props[key]._ownerScope
      types.push(targetType)
    }
  }
  return types
}

/**
 * 从数组、元组或 `Array<T>` 引用中提取元素类型。
 */
function resolveArrayElementType(
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
): TSType[] {
  // type[]
  if (node.type === 'TSArrayType') {
    return [node.elementType]
  }
  // tuple
  if (node.type === 'TSTupleType') {
    return node.elementTypes.map(t =>
      t.type === 'TSNamedTupleMember' ? t.elementType : t,
    )
  }
  if (node.type === 'TSTypeReference') {
    // Array<type>
    if (getReferenceName(node) === 'Array' && node.typeParameters) {
      return node.typeParameters.params
    } else {
      const resolved = resolveTypeReference(ctx, node, scope)
      if (resolved) {
        return resolveArrayElementType(ctx, resolved, scope)
      }
    }
  }
  return ctx.error(
    'Failed to resolve element type from target type',
    node,
    scope,
  )
}

/**
 * 把类型节点解析成有限字符串字面量集合。
 */
function resolveStringType(
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): string[] {
  switch (node.type) {
    case 'StringLiteral':
      return [node.value]
    case 'TSLiteralType':
      return resolveStringType(ctx, node.literal, scope, typeParameters)
    case 'TSUnionType':
      return node.types
        .map(t => resolveStringType(ctx, t, scope, typeParameters))
        .flat()
    case 'TemplateLiteral': {
      return resolveTemplateKeys(ctx, node, scope)
    }
    case 'TSTypeReference': {
      const resolved = resolveTypeReference(ctx, node, scope)
      if (resolved) {
        return resolveStringType(ctx, resolved, scope, typeParameters)
      }
      if (node.typeName.type === 'Identifier') {
        const name = node.typeName.name
        if (typeParameters && typeParameters[name]) {
          return resolveStringType(
            ctx,
            typeParameters[name],
            scope,
            typeParameters,
          )
        }
        /**
         * 读取当前 utility type 的某个类型参数，并继续解析为字符串集合。
         */
        const getParam = (index = 0) =>
          resolveStringType(
            ctx,
            node.typeParameters!.params[index],
            scope,
            typeParameters,
          )
        switch (name) {
          case 'Extract':
            return getParam(1)
          case 'Exclude': {
            const excluded = getParam(1)
            return getParam().filter(s => !excluded.includes(s))
          }
          case 'Uppercase':
            return getParam().map(s => s.toUpperCase())
          case 'Lowercase':
            return getParam().map(s => s.toLowerCase())
          case 'Capitalize':
            return getParam().map(capitalize)
          case 'Uncapitalize':
            return getParam().map(s => s[0].toLowerCase() + s.slice(1))
          default:
            ctx.error(
              'Unsupported type when resolving index type',
              node.typeName,
              scope,
            )
        }
      }
    }
  }
  return ctx.error('Failed to resolve index type into finite keys', node, scope)
}

/**
 * 展开模板字面量类型，生成所有可能的字符串 key。
 */
function resolveTemplateKeys(
  ctx: TypeResolveContext,
  node: TemplateLiteral,
  scope: TypeScope,
): string[] {
  if (!node.expressions.length) {
    return [node.quasis[0].value.raw]
  }

  const res: string[] = []
  const e = node.expressions[0]
  const q = node.quasis[0]
  const leading = q ? q.value.raw : ``
  const resolved = resolveStringType(ctx, e, scope)
  const restResolved = resolveTemplateKeys(
    ctx,
    {
      ...node,
      expressions: node.expressions.slice(1),
      quasis: q ? node.quasis.slice(1) : node.quasis,
    },
    scope,
  )

  for (const r of resolved) {
    for (const rr of restResolved) {
      res.push(leading + r + rr)
    }
  }

  return res
}

const SupportedBuiltinsSet = new Set([
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
] as const)

type GetSetType<T> = T extends Set<infer V> ? V : never

/**
 * 解析内建 utility types（如 `Partial` / `Pick` / `Omit`）到属性映射。
 */
function resolveBuiltin(
  ctx: TypeResolveContext,
  node: TSTypeReference | TSExpressionWithTypeArguments,
  name: GetSetType<typeof SupportedBuiltinsSet>,
  scope: TypeScope,
  typeParameters?: Record<string, Node>,
): ResolvedElements {
  const t = resolveTypeElements(
    ctx,
    node.typeParameters!.params[0],
    scope,
    typeParameters,
  )
  switch (name) {
    case 'Partial': {
      const res: ResolvedElements = { props: {}, calls: t.calls }
      Object.keys(t.props).forEach(key => {
        res.props[key] = { ...t.props[key], optional: true }
      })
      return res
    }
    case 'Required': {
      const res: ResolvedElements = { props: {}, calls: t.calls }
      Object.keys(t.props).forEach(key => {
        res.props[key] = { ...t.props[key], optional: false }
      })
      return res
    }
    case 'Readonly':
      return t
    case 'Pick': {
      const picked = resolveStringType(
        ctx,
        node.typeParameters!.params[1],
        scope,
        typeParameters,
      )
      const res: ResolvedElements = { props: {}, calls: t.calls }
      for (const key of picked) {
        res.props[key] = t.props[key]
      }
      return res
    }
    case 'Omit':
      const omitted = resolveStringType(
        ctx,
        node.typeParameters!.params[1],
        scope,
        typeParameters,
      )
      const res: ResolvedElements = { props: {}, calls: t.calls }
      for (const key in t.props) {
        if (!omitted.includes(key)) {
          res.props[key] = t.props[key]
        }
      }
      return res
  }
}

type ReferenceTypes =
  | TSTypeReference
  | TSExpressionWithTypeArguments
  | TSImportType
  | TSTypeQuery

/**
 * 解析类型引用，并对非泛型场景启用缓存。
 */
function resolveTypeReference(
  ctx: TypeResolveContext,
  node: ReferenceTypes & {
    _resolvedReference?: ScopeTypeNode
  },
  scope?: TypeScope,
  name?: string,
  onlyExported = false,
): ScopeTypeNode | undefined {
  const canCache = !scope?.isGenericScope
  if (canCache && node._resolvedReference) {
    return node._resolvedReference
  }
  const resolved = innerResolveTypeReference(
    ctx,
    scope || ctxToScope(ctx),
    name || getReferenceName(node),
    node,
    onlyExported,
  )
  return canCache ? (node._resolvedReference = resolved) : resolved
}

/**
 * 在当前作用域、导入源、全局类型与命名空间链中查找具体类型定义。
 */
function innerResolveTypeReference(
  ctx: TypeResolveContext,
  scope: TypeScope,
  name: string | string[],
  node: ReferenceTypes,
  onlyExported: boolean,
): ScopeTypeNode | undefined {
  if (typeof name === 'string') {
    if (scope.imports[name]) {
      return resolveTypeFromImport(ctx, node, name, scope)
    } else {
      const lookupSource =
        node.type === 'TSTypeQuery'
          ? onlyExported
            ? scope.exportedDeclares
            : scope.declares
          : onlyExported
            ? scope.exportedTypes
            : scope.types
      if (lookupSource[name]) {
        return lookupSource[name]
      } else {
        // fallback to global
        const globalScopes = resolveGlobalScope(ctx)
        if (globalScopes) {
          for (const s of globalScopes) {
            const src = node.type === 'TSTypeQuery' ? s.declares : s.types
            if (src[name]) {
              ;(ctx.deps || (ctx.deps = new Set())).add(s.filename)
              return src[name]
            }
          }
        }
      }
    }
  } else {
    let ns = innerResolveTypeReference(ctx, scope, name[0], node, onlyExported)
    if (ns) {
      if (ns.type !== 'TSModuleDeclaration') {
        // namespace merged with other types, attached as _ns
        ns = ns._ns
      }
      if (ns) {
        const childScope = moduleDeclToScope(ctx, ns, ns._ownerScope || scope)
        return innerResolveTypeReference(
          ctx,
          childScope,
          name.length > 2 ? name.slice(1) : name[name.length - 1],
          node,
          !ns.declare,
        )
      }
    }
  }
}

/**
 * 读取引用类型节点对应的名字或命名空间路径。
 */
function getReferenceName(node: ReferenceTypes): string | string[] {
  const ref =
    node.type === 'TSTypeReference'
      ? node.typeName
      : node.type === 'TSExpressionWithTypeArguments'
        ? node.expression
        : node.type === 'TSImportType'
          ? node.qualifier
          : node.exprName
  if (ref?.type === 'Identifier') {
    return ref.name
  } else if (ref?.type === 'TSQualifiedName') {
    return qualifiedNameToPath(ref)
  } else {
    return 'default'
  }
}

/**
 * 把限定名 `Foo.Bar.Baz` 展开成路径数组。
 */
function qualifiedNameToPath(node: Identifier | TSQualifiedName): string[] {
  if (node.type === 'Identifier') {
    return [node.name]
  } else {
    return [...qualifiedNameToPath(node.left), node.right.name]
  }
}

/**
 * 加载用户提供的全局类型文件并转换成作用域对象。
 */
function resolveGlobalScope(ctx: TypeResolveContext): TypeScope[] | undefined {
  if (ctx.options.globalTypeFiles) {
    const fs = resolveFS(ctx)
    if (!fs) {
      throw new Error('[vue/compiler-sfc] globalTypeFiles requires fs access.')
    }
    return ctx.options.globalTypeFiles.map(file =>
      fileToScope(ctx, normalizePath(file), true),
    )
  }
}

let ts: typeof TS | undefined
let loadTS: (() => typeof TS) | undefined

/**
 * @private
 */
export function registerTS(_loadTS: () => typeof TS): void {
  loadTS = () => {
    try {
      return _loadTS()
    } catch (err: any) {
      if (
        typeof err.message === 'string' &&
        err.message.includes('Cannot find module')
      ) {
        throw new Error(
          'Failed to load TypeScript, which is required for resolving imported types. ' +
            'Please make sure "typescript" is installed as a project dependency.',
        )
      } else {
        throw new Error(
          'Failed to load TypeScript for resolving imported types.',
        )
      }
    }
  }
}

type FS = NonNullable<SFCScriptCompileOptions['fs']>

/**
 * 解析并缓存当前上下文可用的文件系统抽象。
 */
function resolveFS(ctx: TypeResolveContext): FS | undefined {
  if (ctx.fs) {
    return ctx.fs
  }
  if (!ts && loadTS) {
    ts = loadTS()
  }
  const fs = ctx.options.fs || ts?.sys
  if (!fs) {
    return
  }
  return (ctx.fs = {
    fileExists(file) {
      if (file.endsWith('.vue.ts') && !file.endsWith('.d.vue.ts')) {
        file = file.replace(/\.ts$/, '')
      }
      return fs.fileExists(file)
    },
    readFile(file) {
      if (file.endsWith('.vue.ts') && !file.endsWith('.d.vue.ts')) {
        file = file.replace(/\.ts$/, '')
      }
      return fs.readFile(file)
    },
    realpath: fs.realpath,
  })
}

/**
 * 从 import 绑定解析到它真正引用的类型定义节点。
 */
function resolveTypeFromImport(
  ctx: TypeResolveContext,
  node: ReferenceTypes,
  name: string,
  scope: TypeScope,
): ScopeTypeNode | undefined {
  const { source, imported } = scope.imports[name]
  const sourceScope = importSourceToScope(ctx, node, scope, source)
  return resolveTypeReference(ctx, node, sourceScope, imported, true)
}

/**
 * 把 import source 解析成对应文件的 `TypeScope`。
 */
function importSourceToScope(
  ctx: TypeResolveContext,
  node: Node,
  scope: TypeScope,
  source: string,
): TypeScope {
  let fs: FS | undefined
  try {
    fs = resolveFS(ctx)
  } catch (err: any) {
    return ctx.error(err.message, node, scope)
  }
  if (!fs) {
    return ctx.error(
      `No fs option provided to \`compileScript\` in non-Node environment. ` +
        `File system access is required for resolving imported types.`,
      node,
      scope,
    )
  }

  let resolved: string | undefined = scope.resolvedImportSources[source]
  if (!resolved) {
    if (source.startsWith('..')) {
      const osSpecificJoinFn = process.platform === 'win32' ? join : joinPaths

      const filename = osSpecificJoinFn(dirname(scope.filename), source)
      resolved = resolveExt(filename, fs)
    } else if (source[0] === '.') {
      // relative import - fast path
      const filename = joinPaths(dirname(scope.filename), source)
      resolved = resolveExt(filename, fs)
    } else {
      // module or aliased import - use full TS resolution, only supported in Node
      if (!__CJS__) {
        return ctx.error(
          `Type import from non-relative sources is not supported in the browser build.`,
          node,
          scope,
        )
      }
      if (!ts) {
        if (loadTS) ts = loadTS()
        if (!ts) {
          return ctx.error(
            `Failed to resolve import source ${JSON.stringify(source)}. ` +
              `typescript is required as a peer dep for vue in order ` +
              `to support resolving types from module imports.`,
            node,
            scope,
          )
        }
      }
      resolved = resolveWithTS(scope.filename, source, ts, fs)
    }
    if (resolved) {
      resolved = scope.resolvedImportSources[source] = normalizePath(resolved)
    }
  }
  if (resolved) {
    // (hmr) register dependency file on ctx
    ;(ctx.deps || (ctx.deps = new Set())).add(resolved)
    return fileToScope(ctx, resolved)
  } else {
    return ctx.error(
      `Failed to resolve import source ${JSON.stringify(source)}.`,
      node,
      scope,
    )
  }
}

/**
 * 依次尝试常见 TS 扩展名，把裸文件名解析成真实存在的文件路径。
 */
function resolveExt(filename: string, fs: FS) {
  // #8339 ts may import .js but we should resolve to corresponding ts or d.ts
  filename = filename.replace(/\.js$/, '')
  /**
   * 如果候选文件存在则直接返回。
   */
  const tryResolve = (filename: string) => {
    if (fs.fileExists(filename)) return filename
  }
  return (
    tryResolve(filename) ||
    tryResolve(filename + `.ts`) ||
    tryResolve(filename + `.tsx`) ||
    tryResolve(filename + `.d.ts`) ||
    tryResolve(joinPaths(filename, `index.ts`)) ||
    tryResolve(joinPaths(filename, `index.tsx`)) ||
    tryResolve(joinPaths(filename, `index.d.ts`))
  )
}

interface CachedConfig {
  config: TS.ParsedCommandLine
  cache?: TS.ModuleResolutionCache
}

const tsConfigCache = createCache<CachedConfig[]>()
const tsConfigRefMap = new Map<string, string>()

/**
 * 借助 TypeScript 官方模块解析流程处理非相对导入。
 */
function resolveWithTS(
  containingFile: string,
  source: string,
  ts: typeof TS,
  fs: FS,
): string | undefined {
  if (!__CJS__) return

  // 1. resolve tsconfig.json
  const configPath = ts.findConfigFile(containingFile, fs.fileExists)
  // 2. load tsconfig.json
  let tsCompilerOptions: TS.CompilerOptions
  let tsResolveCache: TS.ModuleResolutionCache | undefined
  if (configPath) {
    let configs: CachedConfig[]
    const normalizedConfigPath = normalizePath(configPath)
    const cached = tsConfigCache.get(normalizedConfigPath)
    if (!cached) {
      configs = loadTSConfig(configPath, ts, fs).map(config => ({ config }))
      tsConfigCache.set(normalizedConfigPath, configs)
    } else {
      configs = cached
    }
    let matchedConfig: CachedConfig | undefined
    if (configs.length === 1) {
      matchedConfig = configs[0]
    } else {
      // resolve which config matches the current file
      for (const c of configs) {
        const base = normalizePath(
          (c.config.options.pathsBasePath as string) ||
            dirname(c.config.options.configFilePath as string),
        )
        const included: string[] | undefined = c.config.raw?.include
        const excluded: string[] | undefined = c.config.raw?.exclude
        if (
          (!included && (!base || containingFile.startsWith(base))) ||
          included?.some(p => isMatch(containingFile, joinPaths(base, p)))
        ) {
          if (
            excluded &&
            excluded.some(p => isMatch(containingFile, joinPaths(base, p)))
          ) {
            continue
          }
          matchedConfig = c
          break
        }
      }
      if (!matchedConfig) {
        matchedConfig = configs[configs.length - 1]
      }
    }
    tsCompilerOptions = matchedConfig.config.options
    tsResolveCache =
      matchedConfig.cache ||
      (matchedConfig.cache = ts.createModuleResolutionCache(
        process.cwd(),
        createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames),
        tsCompilerOptions,
      ))
  } else {
    tsCompilerOptions = {}
  }

  // 3. resolve
  const res = ts.resolveModuleName(
    source,
    containingFile,
    tsCompilerOptions,
    fs,
    tsResolveCache,
  )

  if (res.resolvedModule) {
    let filename = res.resolvedModule.resolvedFileName
    if (filename.endsWith('.vue.ts') && !filename.endsWith('.d.vue.ts')) {
      filename = filename.replace(/\.ts$/, '')
    }
    return fs.realpath ? fs.realpath(filename) : filename
  }
}

/**
 * 读取 tsconfig，并递归展开 project references。
 */
function loadTSConfig(
  configPath: string,
  ts: typeof TS,
  fs: FS,
  visited = new Set<string>(),
): TS.ParsedCommandLine[] {
  // The only case where `fs` is NOT `ts.sys` is during tests.
  // parse config host requires an extra `readDirectory` method
  // during tests, which is stubbed.
  const parseConfigHost = __TEST__
    ? {
        ...fs,
        useCaseSensitiveFileNames: true,
        readDirectory: () => [],
      }
    : ts.sys
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, fs.readFile).config,
    parseConfigHost,
    dirname(configPath),
    undefined,
    configPath,
  )
  const res = [config]
  visited.add(configPath)
  if (config.projectReferences) {
    for (const ref of config.projectReferences) {
      const refPath = ts.resolveProjectReferencePath(ref)
      if (visited.has(refPath) || !fs.fileExists(refPath)) {
        continue
      }
      tsConfigRefMap.set(refPath, configPath)
      res.unshift(...loadTSConfig(refPath, ts, fs, visited))
    }
  }
  return res
}

const fileToScopeCache = createCache<TypeScope>()

/**
 * @private
 */
export function invalidateTypeCache(filename: string): void {
  filename = normalizePath(filename)
  fileToScopeCache.delete(filename)
  tsConfigCache.delete(filename)
  const affectedConfig = tsConfigRefMap.get(filename)
  if (affectedConfig) tsConfigCache.delete(affectedConfig)
}

/**
 * 把任意类型源文件解析为 `TypeScope`，并写入缓存。
 */
export function fileToScope(
  ctx: TypeResolveContext,
  filename: string,
  asGlobal = false,
): TypeScope {
  const cached = fileToScopeCache.get(filename)
  if (cached) {
    return cached
  }
  // fs should be guaranteed to exist here
  const fs = resolveFS(ctx)!
  const source = fs.readFile(filename) || ''
  const body = parseFile(filename, source, fs, ctx.options.babelParserPlugins)
  const scope = new TypeScope(filename, source, 0, recordImports(body))
  recordTypes(ctx, body, scope, asGlobal)
  fileToScopeCache.set(filename, scope)
  return scope
}

/**
 * 解析 `.ts` / `.d.ts` / `.vue` 等文件，提取顶层 statements。
 */
function parseFile(
  filename: string,
  content: string,
  fs: FS,
  parserPlugins?: SFCScriptCompileOptions['babelParserPlugins'],
): Statement[] {
  const ext = extname(filename)
  if (ext === '.ts' || ext === '.mts' || ext === '.tsx' || ext === '.mtsx') {
    return babelParse(content, {
      plugins: resolveParserPlugins(
        ext.slice(1),
        parserPlugins,
        /\.d\.m?ts$/.test(filename),
      ),
      sourceType: 'module',
    }).program.body
  }

  // simulate `allowArbitraryExtensions` on TypeScript >= 5.0
  const isUnknownTypeSource = !/\.[cm]?[tj]sx?$/.test(filename)
  const arbitraryTypeSource = `${filename.slice(0, -ext.length)}.d${ext}.ts`
  const hasArbitraryTypeDeclaration =
    isUnknownTypeSource && fs.fileExists(arbitraryTypeSource)
  if (hasArbitraryTypeDeclaration) {
    return babelParse(fs.readFile(arbitraryTypeSource)!, {
      plugins: resolveParserPlugins('ts', parserPlugins, true),
      sourceType: 'module',
    }).program.body
  }

  if (ext === '.vue') {
    const {
      descriptor: { script, scriptSetup },
    } = parse(content)
    if (!script && !scriptSetup) {
      return []
    }

    // ensure the correct offset with original source
    const scriptOffset = script ? script.loc.start.offset : Infinity
    const scriptSetupOffset = scriptSetup
      ? scriptSetup.loc.start.offset
      : Infinity
    const firstBlock = scriptOffset < scriptSetupOffset ? script : scriptSetup
    const secondBlock = scriptOffset < scriptSetupOffset ? scriptSetup : script

    let scriptContent =
      ' '.repeat(Math.min(scriptOffset, scriptSetupOffset)) +
      firstBlock!.content
    if (secondBlock) {
      scriptContent +=
        ' '.repeat(secondBlock.loc.start.offset - script!.loc.end.offset) +
        secondBlock.content
    }
    const lang = script?.lang || scriptSetup?.lang
    return babelParse(scriptContent, {
      plugins: resolveParserPlugins(lang!, parserPlugins),
      sourceType: 'module',
    }).program.body
  }
  return []
}

/**
 * 从当前编译上下文派生出可复用的类型作用域。
 */
function ctxToScope(ctx: TypeResolveContext): TypeScope {
  if (ctx.scope) {
    return ctx.scope
  }

  const body =
    'ast' in ctx
      ? ctx.ast
      : ctx.scriptAst
        ? [...ctx.scriptAst.body, ...ctx.scriptSetupAst!.body]
        : ctx.scriptSetupAst!.body

  const scope = new TypeScope(
    ctx.filename,
    ctx.source,
    'startOffset' in ctx ? ctx.startOffset! : 0,
    'userImports' in ctx ? Object.create(ctx.userImports) : recordImports(body),
  )

  recordTypes(ctx, body, scope)

  return (ctx.scope = scope)
}

/**
 * 把 TS namespace/module declaration 转换成子作用域。
 */
function moduleDeclToScope(
  ctx: TypeResolveContext,
  node: TSModuleDeclaration & { _resolvedChildScope?: TypeScope },
  parentScope: TypeScope,
): TypeScope {
  if (node._resolvedChildScope) {
    return node._resolvedChildScope
  }

  const scope = createChildScope(parentScope)

  if (node.body.type === 'TSModuleDeclaration') {
    const decl = node.body as TSModuleDeclaration & WithScope
    decl._ownerScope = scope
    const id = getId(decl.id)
    scope.types[id] = scope.exportedTypes[id] = decl
  } else {
    recordTypes(ctx, node.body.body, scope)
  }

  return (node._resolvedChildScope = scope)
}

/**
 * 基于父作用域创建可继承 imports/types/declares 的子作用域。
 */
function createChildScope(parentScope: TypeScope) {
  return new TypeScope(
    parentScope.filename,
    parentScope.source,
    parentScope.offset,
    Object.create(parentScope.imports),
    Object.create(parentScope.types),
    Object.create(parentScope.declares),
  )
}

const importExportRE = /^Import|^Export/

/**
 * 扫描 statements，把类型声明、declare 声明与导出信息记录到作用域。
 */
function recordTypes(
  ctx: TypeResolveContext,
  body: Statement[],
  scope: TypeScope,
  asGlobal = false,
) {
  const { types, declares, exportedTypes, exportedDeclares, imports } = scope
  const isAmbient = asGlobal
    ? !body.some(s => importExportRE.test(s.type))
    : false
  for (const stmt of body) {
    if (asGlobal) {
      if (isAmbient) {
        if ((stmt as any).declare) {
          recordType(stmt, types, declares)
        }
      } else if (stmt.type === 'TSModuleDeclaration' && stmt.global) {
        for (const s of (stmt.body as TSModuleBlock).body) {
          recordType(s, types, declares)
        }
      }
    } else {
      recordType(stmt, types, declares)
    }
  }
  if (!asGlobal) {
    for (const stmt of body) {
      if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.declaration) {
          recordType(stmt.declaration, types, declares)
          recordType(stmt.declaration, exportedTypes, exportedDeclares)
        } else {
          for (const spec of stmt.specifiers) {
            if (spec.type === 'ExportSpecifier') {
              const local = spec.local.name
              const exported = getId(spec.exported)
              if (stmt.source) {
                // re-export, register an import + export as a type reference
                imports[exported] = {
                  source: stmt.source.value,
                  imported: local,
                }
                exportedTypes[exported] = {
                  type: 'TSTypeReference',
                  typeName: {
                    type: 'Identifier',
                    name: local,
                  },
                  _ownerScope: scope,
                }
              } else if (types[local]) {
                // exporting local defined type
                exportedTypes[exported] = types[local]
              }
            }
          }
        }
      } else if (stmt.type === 'ExportAllDeclaration') {
        const sourceScope = importSourceToScope(
          ctx,
          stmt.source,
          scope,
          stmt.source.value,
        )
        Object.assign(scope.exportedTypes, sourceScope.exportedTypes)
      } else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration) {
        if (stmt.declaration.type !== 'Identifier') {
          recordType(stmt.declaration, types, declares, 'default')
          recordType(
            stmt.declaration,
            exportedTypes,
            exportedDeclares,
            'default',
          )
        } else if (types[stmt.declaration.name]) {
          exportedTypes['default'] = types[stmt.declaration.name]
        }
      }
    }
  }
  for (const key of Object.keys(types)) {
    const node = types[key]
    node._ownerScope = scope
    if (node._ns) node._ns._ownerScope = scope
  }
  for (const key of Object.keys(declares)) {
    declares[key]._ownerScope = scope
  }
}

/**
 * 把单个声明节点登记进 `types` / `declares` 表。
 */
function recordType(
  node: Node,
  types: Record<string, Node>,
  declares: Record<string, Node>,
  overwriteId?: string,
) {
  switch (node.type) {
    case 'TSInterfaceDeclaration':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration': {
      const id = overwriteId || getId(node.id)
      let existing = types[id]
      if (existing) {
        if (node.type === 'TSModuleDeclaration') {
          if (existing.type === 'TSModuleDeclaration') {
            mergeNamespaces(existing as typeof node, node)
          } else {
            attachNamespace(existing, node)
          }
          break
        }
        if (existing.type === 'TSModuleDeclaration') {
          // replace and attach namespace
          types[id] = node
          attachNamespace(node, existing)
          break
        }

        if (existing.type !== node.type) {
          // type-level error
          break
        }
        if (node.type === 'TSInterfaceDeclaration') {
          ;(existing as typeof node).body.body.push(...node.body.body)
        } else {
          ;(existing as typeof node).members.push(...node.members)
        }
      } else {
        types[id] = node
      }
      break
    }
    case 'ClassDeclaration':
      if (overwriteId || node.id) types[overwriteId || getId(node.id!)] = node
      break
    case 'TSTypeAliasDeclaration':
      types[node.id.name] = node.typeParameters ? node : node.typeAnnotation
      break
    case 'TSDeclareFunction':
      if (node.id) declares[node.id.name] = node
      break
    case 'VariableDeclaration': {
      if (node.declare) {
        for (const decl of node.declarations) {
          if (decl.id.type === 'Identifier' && decl.id.typeAnnotation) {
            declares[decl.id.name] = (
              decl.id.typeAnnotation as TSTypeAnnotation
            ).typeAnnotation
          }
        }
      }
      break
    }
  }
}

/**
 * 合并同名 namespace/module declaration。
 */
function mergeNamespaces(to: TSModuleDeclaration, from: TSModuleDeclaration) {
  const toBody = to.body
  const fromBody = from.body
  if (toBody.type === 'TSModuleDeclaration') {
    if (fromBody.type === 'TSModuleDeclaration') {
      // both decl
      mergeNamespaces(toBody, fromBody)
    } else {
      // to: decl -> from: block
      fromBody.body.push({
        type: 'ExportNamedDeclaration',
        declaration: toBody,
        exportKind: 'type',
        specifiers: [],
      })
    }
  } else if (fromBody.type === 'TSModuleDeclaration') {
    // to: block <- from: decl
    toBody.body.push({
      type: 'ExportNamedDeclaration',
      declaration: fromBody,
      exportKind: 'type',
      specifiers: [],
    })
  } else {
    // both block
    toBody.body.push(...fromBody.body)
  }
}

/**
 * 把 namespace 声明挂接到已有类型节点上。
 */
function attachNamespace(
  to: Node & { _ns?: TSModuleDeclaration },
  ns: TSModuleDeclaration,
) {
  if (!to._ns) {
    to._ns = ns
  } else {
    mergeNamespaces(to._ns, ns)
  }
}

/**
 * 记录文件里的所有 import 绑定。
 */
export function recordImports(body: Statement[]): Record<string, Import> {
  const imports: TypeScope['imports'] = Object.create(null)
  for (const s of body) {
    recordImport(s, imports)
  }
  return imports
}

/**
 * 记录单条 import declaration 中的本地绑定与来源。
 */
function recordImport(node: Node, imports: TypeScope['imports']) {
  if (node.type !== 'ImportDeclaration') {
    return
  }
  for (const s of node.specifiers) {
    imports[s.local.name] = {
      imported: getImportedName(s),
      source: node.source.value,
    }
  }
}

/**
 * 从 TS 类型节点推导运行时需要保留的构造器类型集合。
 */
export function inferRuntimeType(
  ctx: TypeResolveContext,
  node: Node & MaybeWithScope,
  scope: TypeScope = node._ownerScope || ctxToScope(ctx),
  isKeyOf = false,
): string[] {
  try {
    switch (node.type) {
      case 'TSStringKeyword':
        return ['String']
      case 'TSNumberKeyword':
        return ['Number']
      case 'TSBooleanKeyword':
        return ['Boolean']
      case 'TSObjectKeyword':
        return ['Object']
      case 'TSNullKeyword':
        return ['null']
      case 'TSTypeLiteral':
      case 'TSInterfaceDeclaration': {
        // TODO (nice to have) generate runtime property validation
        const types = new Set<string>()
        const members =
          node.type === 'TSTypeLiteral' ? node.members : node.body.body

        for (const m of members) {
          if (isKeyOf) {
            if (
              m.type === 'TSPropertySignature' &&
              m.key.type === 'NumericLiteral'
            ) {
              types.add('Number')
            } else if (m.type === 'TSIndexSignature') {
              const annotation = m.parameters[0].typeAnnotation
              if (annotation && annotation.type !== 'Noop') {
                const type = inferRuntimeType(
                  ctx,
                  annotation.typeAnnotation,
                  scope,
                )[0]
                if (type === UNKNOWN_TYPE) return [UNKNOWN_TYPE]
                types.add(type)
              }
            } else {
              types.add('String')
            }
          } else if (
            m.type === 'TSCallSignatureDeclaration' ||
            m.type === 'TSConstructSignatureDeclaration'
          ) {
            types.add('Function')
          } else {
            types.add('Object')
          }
        }

        return types.size
          ? Array.from(types)
          : [isKeyOf ? UNKNOWN_TYPE : 'Object']
      }
      case 'TSPropertySignature':
        if (node.typeAnnotation) {
          return inferRuntimeType(
            ctx,
            node.typeAnnotation.typeAnnotation,
            scope,
          )
        }
        break
      case 'TSMethodSignature':
      case 'TSFunctionType':
        return ['Function']
      case 'TSArrayType':
      case 'TSTupleType':
        // TODO (nice to have) generate runtime element type/length checks
        return ['Array']

      case 'TSLiteralType':
        switch (node.literal.type) {
          case 'StringLiteral':
            return ['String']
          case 'BooleanLiteral':
            return ['Boolean']
          case 'NumericLiteral':
          case 'BigIntLiteral':
            return ['Number']
          default:
            return [UNKNOWN_TYPE]
        }

      case 'TSTypeReference': {
        const resolved = resolveTypeReference(ctx, node, scope)
        if (resolved) {
          // #13240
          // Special case for function type aliases to ensure correct runtime behavior
          // other type aliases still fallback to unknown as before
          if (
            resolved.type === 'TSTypeAliasDeclaration' &&
            resolved.typeAnnotation.type === 'TSFunctionType'
          ) {
            return ['Function']
          }
          return inferRuntimeType(ctx, resolved, resolved._ownerScope, isKeyOf)
        }

        if (node.typeName.type === 'Identifier') {
          if (isKeyOf) {
            switch (node.typeName.name) {
              case 'String':
              case 'Array':
              case 'ArrayLike':
              case 'Parameters':
              case 'ConstructorParameters':
              case 'ReadonlyArray':
                return ['String', 'Number']

              // TS built-in utility types
              case 'Record':
              case 'Partial':
              case 'Required':
              case 'Readonly':
                if (node.typeParameters && node.typeParameters.params[0]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[0],
                    scope,
                    true,
                  )
                }
                break
              case 'Pick':
              case 'Extract':
                if (node.typeParameters && node.typeParameters.params[1]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[1],
                    scope,
                  )
                }
                break

              case 'Function':
              case 'Object':
              case 'Set':
              case 'Map':
              case 'WeakSet':
              case 'WeakMap':
              case 'Date':
              case 'Promise':
              case 'Error':
              case 'Uppercase':
              case 'Lowercase':
              case 'Capitalize':
              case 'Uncapitalize':
              case 'ReadonlyMap':
              case 'ReadonlySet':
                return ['String']
            }
          } else {
            switch (node.typeName.name) {
              case 'Array':
              case 'Function':
              case 'Object':
              case 'Set':
              case 'Map':
              case 'WeakSet':
              case 'WeakMap':
              case 'Date':
              case 'Promise':
              case 'Error':
                return [node.typeName.name]

              // TS built-in utility types
              // https://www.typescriptlang.org/docs/handbook/utility-types.html
              case 'Partial':
              case 'Required':
              case 'Readonly':
              case 'Record':
              case 'Pick':
              case 'Omit':
              case 'InstanceType':
                return ['Object']

              case 'Uppercase':
              case 'Lowercase':
              case 'Capitalize':
              case 'Uncapitalize':
                return ['String']

              case 'Parameters':
              case 'ConstructorParameters':
              case 'ReadonlyArray':
                return ['Array']

              case 'ReadonlyMap':
                return ['Map']
              case 'ReadonlySet':
                return ['Set']

              case 'NonNullable':
                if (node.typeParameters && node.typeParameters.params[0]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[0],
                    scope,
                  ).filter(t => t !== 'null')
                }
                break
              case 'Extract':
                if (node.typeParameters && node.typeParameters.params[1]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[1],
                    scope,
                  )
                }
                break
              case 'Exclude':
              case 'OmitThisParameter':
                if (node.typeParameters && node.typeParameters.params[0]) {
                  return inferRuntimeType(
                    ctx,
                    node.typeParameters.params[0],
                    scope,
                  )
                }
                break
            }
          }
        }
        // cannot infer, fallback to UNKNOWN: ThisParameterType
        break
      }

      case 'TSParenthesizedType':
        return inferRuntimeType(ctx, node.typeAnnotation, scope)

      case 'TSUnionType':
        return flattenTypes(ctx, node.types, scope, isKeyOf)
      case 'TSIntersectionType': {
        return flattenTypes(ctx, node.types, scope, isKeyOf).filter(
          t => t !== UNKNOWN_TYPE,
        )
      }

      case 'TSEnumDeclaration':
        return inferEnumType(node)

      case 'TSSymbolKeyword':
        return ['Symbol']

      case 'TSIndexedAccessType': {
        const types = resolveIndexType(ctx, node, scope)
        return flattenTypes(ctx, types, scope, isKeyOf)
      }

      case 'ClassDeclaration':
        return ['Object']

      case 'TSImportType': {
        const sourceScope = importSourceToScope(
          ctx,
          node.argument,
          scope,
          node.argument.value,
        )
        const resolved = resolveTypeReference(ctx, node, sourceScope)
        if (resolved) {
          return inferRuntimeType(ctx, resolved, resolved._ownerScope)
        }
        break
      }

      case 'TSTypeQuery': {
        const id = node.exprName
        if (id.type === 'Identifier') {
          // typeof only support identifier in local scope
          const matched = scope.declares[id.name]
          if (matched) {
            return inferRuntimeType(ctx, matched, matched._ownerScope, isKeyOf)
          }
        }
        break
      }

      // e.g. readonly
      case 'TSTypeOperator': {
        return inferRuntimeType(
          ctx,
          node.typeAnnotation,
          scope,
          node.operator === 'keyof',
        )
      }

      case 'TSAnyKeyword': {
        if (isKeyOf) {
          return ['String', 'Number', 'Symbol']
        }
        break
      }
    }
  } catch (e) {
    // always soft fail on failed runtime type inference
  }
  return [UNKNOWN_TYPE] // no runtime check
}

/**
 * 把多个类型分支推导出的运行时类型拍平成去重数组。
 */
function flattenTypes(
  ctx: TypeResolveContext,
  types: TSType[],
  scope: TypeScope,
  isKeyOf: boolean = false,
): string[] {
  if (types.length === 1) {
    return inferRuntimeType(ctx, types[0], scope, isKeyOf)
  }
  return [
    ...new Set(
      ([] as string[]).concat(
        ...types.map(t => inferRuntimeType(ctx, t, scope, isKeyOf)),
      ),
    ),
  ]
}

/**
 * 根据枚举成员初始化值推断枚举的运行时类型。
 */
function inferEnumType(node: TSEnumDeclaration): string[] {
  const types = new Set<string>()
  for (const m of node.members) {
    if (m.initializer) {
      switch (m.initializer.type) {
        case 'StringLiteral':
          types.add('String')
          break
        case 'NumericLiteral':
          types.add('Number')
          break
      }
    }
  }
  return types.size ? [...types] : ['Number']
}

/**
 * support for the `ExtractPropTypes` helper - it's non-exhaustive, mostly
 * tailored towards popular component libs like element-plus and antd-vue.
 */
function resolveExtractPropTypes(
  { props }: ResolvedElements,
  scope: TypeScope,
): ResolvedElements {
  const res: ResolvedElements = { props: {} }
  for (const key in props) {
    const raw = props[key]
    res.props[key] = reverseInferType(
      raw.key,
      raw.typeAnnotation!.typeAnnotation,
      scope,
    )
  }
  return res
}

/**
 * 反向从 `PropType` / `xxxConstructor` 这类声明推回属性签名。
 */
function reverseInferType(
  key: Expression,
  node: TSType,
  scope: TypeScope,
  optional = true,
  checkObjectSyntax = true,
): TSPropertySignature & WithScope {
  if (checkObjectSyntax && node.type === 'TSTypeLiteral') {
    // check { type: xxx }
    const typeType = findStaticPropertyType(node, 'type')
    if (typeType) {
      const requiredType = findStaticPropertyType(node, 'required')
      const optional =
        requiredType &&
        requiredType.type === 'TSLiteralType' &&
        requiredType.literal.type === 'BooleanLiteral'
          ? !requiredType.literal.value
          : true
      return reverseInferType(key, typeType, scope, optional, false)
    }
  } else if (
    node.type === 'TSTypeReference' &&
    node.typeName.type === 'Identifier'
  ) {
    if (node.typeName.name.endsWith('Constructor')) {
      return createProperty(
        key,
        ctorToType(node.typeName.name),
        scope,
        optional,
      )
    } else if (node.typeName.name === 'PropType' && node.typeParameters) {
      // PropType<{}>
      return createProperty(key, node.typeParameters.params[0], scope, optional)
    }
  }
  if (
    (node.type === 'TSTypeReference' || node.type === 'TSImportType') &&
    node.typeParameters
  ) {
    // try if we can catch Foo.Bar<XXXConstructor>
    for (const t of node.typeParameters.params) {
      const inferred = reverseInferType(key, t, scope, optional)
      if (inferred) return inferred
    }
  }
  return createProperty(key, { type: `TSNullKeyword` }, scope, optional)
}

/**
 * 把 `StringConstructor` 之类的名字转换成对应 TS 类型节点。
 */
function ctorToType(ctorType: string): TSType {
  const ctor = ctorType.slice(0, -11)
  switch (ctor) {
    case 'String':
    case 'Number':
    case 'Boolean':
      return { type: `TS${ctor}Keyword` }
    case 'Array':
    case 'Function':
    case 'Object':
    case 'Set':
    case 'Map':
    case 'WeakSet':
    case 'WeakMap':
    case 'Date':
    case 'Promise':
      return {
        type: 'TSTypeReference',
        typeName: { type: 'Identifier', name: ctor },
      }
  }
  // fallback to null
  return { type: `TSNullKeyword` }
}

/**
 * 查找对象字面量类型中某个静态属性的类型注解。
 */
function findStaticPropertyType(node: TSTypeLiteral, key: string) {
  const prop = node.members.find(
    m =>
      m.type === 'TSPropertySignature' &&
      !m.computed &&
      getId(m.key) === key &&
      m.typeAnnotation,
  )
  return prop && prop.typeAnnotation!.typeAnnotation
}

/**
 * 尝试解析函数类型或声明的返回类型，用于支持 `ReturnType<T>`。
 */
function resolveReturnType(
  ctx: TypeResolveContext,
  arg: Node,
  scope: TypeScope,
) {
  let resolved: Node | undefined = arg
  if (
    arg.type === 'TSTypeReference' ||
    arg.type === 'TSTypeQuery' ||
    arg.type === 'TSImportType'
  ) {
    resolved = resolveTypeReference(ctx, arg, scope)
  }
  if (!resolved) return
  if (resolved.type === 'TSFunctionType') {
    return resolved.typeAnnotation?.typeAnnotation
  }
  if (resolved.type === 'TSDeclareFunction') {
    return resolved.returnType
  }
}

/**
 * 展开 union 类型引用，返回最底层的类型节点数组。
 */
export function resolveUnionType(
  ctx: TypeResolveContext,
  node: Node & MaybeWithScope & { _resolvedElements?: ResolvedElements },
  scope?: TypeScope,
): Node[] {
  if (node.type === 'TSTypeReference') {
    const resolved = resolveTypeReference(ctx, node, scope)
    if (resolved) node = resolved
  }

  let types: Node[]
  if (node.type === 'TSUnionType') {
    types = node.types.flatMap(node => resolveUnionType(ctx, node, scope))
  } else {
    types = [node]
  }

  return types
}
