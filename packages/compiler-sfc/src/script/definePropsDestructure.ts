/**
 * `defineProps` 响应式解构支持。
 *
 * 这里负责登记解构绑定，并把 setup 代码里对局部变量的访问重写回 `__props.xxx`。
 */
import type {
  BlockStatement,
  Expression,
  Identifier,
  Node,
  ObjectPattern,
  Program,
  VariableDeclaration,
} from '@babel/types'
import { walk } from 'estree-walker'
import {
  BindingTypes,
  TS_NODE_TYPES,
  extractIdentifiers,
  isFunctionType,
  isInDestructureAssignment,
  isReferencedIdentifier,
  isStaticProperty,
  unwrapTSNode,
  walkFunctionParams,
} from '@vue/compiler-dom'
import { genPropsAccessExp } from '@vue/shared'
import { isCallOf, resolveObjectKey } from './utils'
import type { ScriptCompileContext } from './context'
import { DEFINE_PROPS } from './defineProps'

/**
 * 解析 `const { ... } = defineProps()` 结构，登记别名、默认值与 rest 标识符。
 */
export function processPropsDestructure(
  ctx: ScriptCompileContext,
  declId: ObjectPattern,
): void {
  if (ctx.options.propsDestructure === 'error') {
    ctx.error(`Props destructure is explicitly prohibited via config.`, declId)
  } else if (ctx.options.propsDestructure === false) {
    return
  }

  ctx.propsDestructureDecl = declId

  const registerBinding = (
    key: string,
    local: string,
    defaultValue?: Expression,
  ) => {
    ctx.propsDestructuredBindings[key] = { local, default: defaultValue }
    if (local !== key) {
      ctx.bindingMetadata[local] = BindingTypes.PROPS_ALIASED
      ;(ctx.bindingMetadata.__propsAliases ||
        (ctx.bindingMetadata.__propsAliases = {}))[local] = key
    }
  }

  for (const prop of declId.properties) {
    if (prop.type === 'ObjectProperty') {
      const propKey = resolveObjectKey(prop.key, prop.computed)

      if (!propKey) {
        ctx.error(
          `${DEFINE_PROPS}() destructure cannot use computed key.`,
          prop.key,
        )
      }

      if (prop.value.type === 'AssignmentPattern') {
        // default value { foo = 123 }
        const { left, right } = prop.value
        if (left.type !== 'Identifier') {
          ctx.error(
            `${DEFINE_PROPS}() destructure does not support nested patterns.`,
            left,
          )
        }
        registerBinding(propKey, left.name, right)
      } else if (prop.value.type === 'Identifier') {
        // simple destructure
        registerBinding(propKey, prop.value.name)
      } else {
        ctx.error(
          `${DEFINE_PROPS}() destructure does not support nested patterns.`,
          prop.value,
        )
      }
    } else {
      // rest spread
      ctx.propsDestructureRestId = (prop.argument as Identifier).name
      // register binding
      ctx.bindingMetadata[ctx.propsDestructureRestId] =
        BindingTypes.SETUP_REACTIVE_CONST
    }
  }
}

/**
 * true -> prop binding
 * false -> local binding
 */
type Scope = Record<string, boolean>

/**
 * 遍历 `<script setup>` AST，把解构 props 的局部引用改写回 `__props` 访问。
 */
export function transformDestructuredProps(
  ctx: ScriptCompileContext,
  vueImportAliases: Record<string, string>,
): void {
  if (ctx.options.propsDestructure === false) {
    return
  }

  const rootScope: Scope = Object.create(null)
  const scopeStack: Scope[] = [rootScope]
  let currentScope: Scope = rootScope
  const excludedIds = new WeakSet<Identifier>()
  const parentStack: Node[] = []
  const propsLocalToPublicMap: Record<string, string> = Object.create(null)

  for (const key in ctx.propsDestructuredBindings) {
    const { local } = ctx.propsDestructuredBindings[key]
    rootScope[local] = true
    propsLocalToPublicMap[local] = key
  }

  /**
   * 进入一个新的词法作用域。
   */
  function pushScope() {
    scopeStack.push((currentScope = Object.create(currentScope)))
  }

  /**
   * 退出当前词法作用域。
   */
  function popScope() {
    scopeStack.pop()
    currentScope = scopeStack[scopeStack.length - 1] || null
  }

  /**
   * 把标识符登记为当前作用域中的本地绑定，避免被误判为 props 引用。
   */
  function registerLocalBinding(id: Identifier) {
    excludedIds.add(id)
    if (currentScope) {
      currentScope[id.name] = false
    } else {
      ctx.error(
        'registerBinding called without active scope, something is wrong.',
        id,
      )
    }
  }

  /**
   * 预扫描一个 block / program 中声明出的本地变量。
   */
  function walkScope(node: Program | BlockStatement, isRoot = false) {
    for (const stmt of node.body) {
      if (stmt.type === 'VariableDeclaration') {
        walkVariableDeclaration(stmt, isRoot)
      } else if (
        stmt.type === 'FunctionDeclaration' ||
        stmt.type === 'ClassDeclaration'
      ) {
        if (stmt.declare || !stmt.id) continue
        registerLocalBinding(stmt.id)
      } else if (
        (stmt.type === 'ForOfStatement' || stmt.type === 'ForInStatement') &&
        stmt.left.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.left)
      } else if (
        stmt.type === 'ExportNamedDeclaration' &&
        stmt.declaration &&
        stmt.declaration.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.declaration, isRoot)
      } else if (
        stmt.type === 'LabeledStatement' &&
        stmt.body.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.body, isRoot)
      }
    }
  }

  /**
   * 处理变量声明中的标识符提取与 defineProps 特殊排除逻辑。
   */
  function walkVariableDeclaration(stmt: VariableDeclaration, isRoot = false) {
    if (stmt.declare) {
      return
    }
    for (const decl of stmt.declarations) {
      const isDefineProps =
        isRoot && decl.init && isCallOf(unwrapTSNode(decl.init), 'defineProps')
      for (const id of extractIdentifiers(decl.id)) {
        if (isDefineProps) {
          // for defineProps destructure, only exclude them since they
          // are already passed in as knownProps
          excludedIds.add(id)
        } else {
          registerLocalBinding(id)
        }
      }
    }
  }

  /**
   * 把对解构 prop 的读取重写成 `__props.xxx`。
   */
  function rewriteId(id: Identifier, parent: Node, parentStack: Node[]) {
    if (
      (parent.type === 'AssignmentExpression' && id === parent.left) ||
      parent.type === 'UpdateExpression'
    ) {
      ctx.error(`Cannot assign to destructured props as they are readonly.`, id)
    }

    if (isStaticProperty(parent) && parent.shorthand) {
      // let binding used in a property shorthand
      // skip for destructure patterns
      if (
        !(parent as any).inPattern ||
        isInDestructureAssignment(parent, parentStack)
      ) {
        // { prop } -> { prop: __props.prop }
        ctx.s.appendLeft(
          id.end! + ctx.startOffset!,
          `: ${genPropsAccessExp(propsLocalToPublicMap[id.name])}`,
        )
      }
    } else {
      // x --> __props.x
      ctx.s.overwrite(
        id.start! + ctx.startOffset!,
        id.end! + ctx.startOffset!,
        genPropsAccessExp(propsLocalToPublicMap[id.name]),
      )
    }
  }

  /**
   * 校验某些 API（如 `watch` / `toRef`）没有直接拿到解构 prop 值。
   */
  function checkUsage(node: Node, method: string, alias = method) {
    if (isCallOf(node, alias)) {
      const arg = unwrapTSNode(node.arguments[0])
      if (arg.type === 'Identifier' && currentScope[arg.name]) {
        ctx.error(
          `"${arg.name}" is a destructured prop and should not be passed directly to ${method}(). ` +
            `Pass a getter () => ${arg.name} instead.`,
          arg,
        )
      }
    }
  }

  // check root scope first
  const ast = ctx.scriptSetupAst!
  walkScope(ast, true)
  walk(ast, {
    enter(node: Node, parent: Node | null) {
      parent && parentStack.push(parent)

      // skip type nodes
      if (
        parent &&
        parent.type.startsWith('TS') &&
        !TS_NODE_TYPES.includes(parent.type)
      ) {
        return this.skip()
      }

      checkUsage(node, 'watch', vueImportAliases.watch)
      checkUsage(node, 'toRef', vueImportAliases.toRef)

      // function scopes
      if (isFunctionType(node)) {
        pushScope()
        walkFunctionParams(node, registerLocalBinding)
        if (node.body.type === 'BlockStatement') {
          walkScope(node.body)
        }
        return
      }

      // catch param
      if (node.type === 'CatchClause') {
        pushScope()
        if (node.param && node.param.type === 'Identifier') {
          registerLocalBinding(node.param)
        }
        walkScope(node.body)
        return
      }

      // non-function block scopes
      if (node.type === 'BlockStatement' && !isFunctionType(parent!)) {
        pushScope()
        walkScope(node)
        return
      }

      if (node.type === 'Identifier') {
        if (
          isReferencedIdentifier(node, parent!, parentStack) &&
          !excludedIds.has(node)
        ) {
          if (currentScope[node.name]) {
            rewriteId(node, parent!, parentStack)
          }
        }
      }
    },
    leave(node: Node, parent: Node | null) {
      parent && parentStack.pop()
      if (
        (node.type === 'BlockStatement' && !isFunctionType(parent!)) ||
        isFunctionType(node) ||
        node.type === 'CatchClause'
      ) {
        popScope()
      }
    },
  })
}
