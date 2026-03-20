/**
 * DOM 版 `v-on` transform。
 *
 * 相比 core 只负责基础事件 key/handler 生成，这里额外处理：
 * - `.stop` / `.prevent` 等运行时修饰符
 * - `.once` / `.capture` / `.passive` 等事件选项修饰符
 * - `.left` / `.right` / 键盘修饰符等 DOM 事件语义
 */
import {
  CompilerDeprecationTypes,
  type DirectiveTransform,
  type ExpressionNode,
  NodeTypes,
  type SimpleExpressionNode,
  type SourceLocation,
  type TransformContext,
  transformOn as baseTransform,
  checkCompatEnabled,
  createCallExpression,
  createCompoundExpression,
  createObjectProperty,
  createSimpleExpression,
  isStaticExp,
} from '@vue/compiler-core'
import { V_ON_WITH_KEYS, V_ON_WITH_MODIFIERS } from '../runtimeHelpers'
import { capitalize, makeMap } from '@vue/shared'

const isEventOptionModifier = /*@__PURE__*/ makeMap(`passive,once,capture`)
const isNonKeyModifier = /*@__PURE__*/ makeMap(
  // event propagation management
  `stop,prevent,self,` +
    // system modifiers + exact
    `ctrl,shift,alt,meta,exact,` +
    // mouse
    `middle`,
)
// left & right could be mouse or key modifiers based on event type
const maybeKeyModifier = /*@__PURE__*/ makeMap('left,right')
const isKeyboardEvent = /*@__PURE__*/ makeMap(`onkeyup,onkeydown,onkeypress`)

/**
 * 把一组修饰符拆分成键盘修饰符、非键盘修饰符和事件选项修饰符三类。
 */
const resolveModifiers = (
  key: ExpressionNode,
  modifiers: SimpleExpressionNode[],
  context: TransformContext,
  loc: SourceLocation,
) => {
  const keyModifiers = []
  const nonKeyModifiers = []
  const eventOptionModifiers = []

  for (let i = 0; i < modifiers.length; i++) {
    const modifier = modifiers[i].content

    if (
      __COMPAT__ &&
      modifier === 'native' &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_V_ON_NATIVE,
        context,
        loc,
      )
    ) {
      eventOptionModifiers.push(modifier)
    } else if (isEventOptionModifier(modifier)) {
      // eventOptionModifiers: modifiers for addEventListener() options,
      // e.g. .passive & .capture
      eventOptionModifiers.push(modifier)
    } else {
      // runtimeModifiers: modifiers that needs runtime guards
      if (maybeKeyModifier(modifier)) {
        if (isStaticExp(key)) {
          if (
            isKeyboardEvent((key as SimpleExpressionNode).content.toLowerCase())
          ) {
            keyModifiers.push(modifier)
          } else {
            nonKeyModifiers.push(modifier)
          }
        } else {
          keyModifiers.push(modifier)
          nonKeyModifiers.push(modifier)
        }
      } else {
        if (isNonKeyModifier(modifier)) {
          nonKeyModifiers.push(modifier)
        } else {
          keyModifiers.push(modifier)
        }
      }
    }
  }

  return {
    keyModifiers,
    nonKeyModifiers,
    eventOptionModifiers,
  }
}

/**
 * 把 `click.right` / `click.middle` 这类修饰符改写成真实会触发的事件名。
 */
const transformClick = (key: ExpressionNode, event: string) => {
  const isStaticClick =
    isStaticExp(key) && key.content.toLowerCase() === 'onclick'
  return isStaticClick
    ? createSimpleExpression(event, true)
    : key.type !== NodeTypes.SIMPLE_EXPRESSION
      ? createCompoundExpression([
          `(`,
          key,
          `) === "onClick" ? "${event}" : (`,
          key,
          `)`,
        ])
      : key
}

/**
 * 在 core `v-on` 结果上继续叠加 DOM 事件修饰符包装。
 */
export const transformOn: DirectiveTransform = (dir, node, context) => {
  return baseTransform(dir, node, context, baseResult => {
    const { modifiers } = dir
    if (!modifiers.length) return baseResult

    let { key, value: handlerExp } = baseResult.props[0]
    const { keyModifiers, nonKeyModifiers, eventOptionModifiers } =
      resolveModifiers(key, modifiers, context, dir.loc)

    // normalize click.right and click.middle since they don't actually fire
    if (nonKeyModifiers.includes('right')) {
      key = transformClick(key, `onContextmenu`)
    }
    if (nonKeyModifiers.includes('middle')) {
      key = transformClick(key, `onMouseup`)
    }

    if (nonKeyModifiers.length) {
      handlerExp = createCallExpression(context.helper(V_ON_WITH_MODIFIERS), [
        handlerExp,
        JSON.stringify(nonKeyModifiers),
      ])
    }

    if (
      keyModifiers.length &&
      // if event name is dynamic, always wrap with keys guard
      (!isStaticExp(key) || isKeyboardEvent(key.content.toLowerCase()))
    ) {
      handlerExp = createCallExpression(context.helper(V_ON_WITH_KEYS), [
        handlerExp,
        JSON.stringify(keyModifiers),
      ])
    }

    if (eventOptionModifiers.length) {
      const modifierPostfix = eventOptionModifiers.map(capitalize).join('')
      key = isStaticExp(key)
        ? createSimpleExpression(`${key.content}${modifierPostfix}`, true)
        : createCompoundExpression([`(`, key, `) + "${modifierPostfix}"`])
    }

    return {
      props: [createObjectProperty(key, handlerExp)],
    }
  })
}
