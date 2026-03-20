/**
 * 浏览器运行时编译专用的表达式校验器。
 *
 * 浏览器版编译器不会像 SSR / 构建期那样把表达式全部交给 Babel 深度分析，
 * 因此这里用 `new Function()` 做一次轻量语法校验，并拦住模板表达式里的保留字误用。
 */
import type { SimpleExpressionNode } from './ast'
import type { TransformContext } from './transform'
import { ErrorCodes, createCompilerError } from './errors'

// these keywords should not appear inside expressions, but operators like
// 'typeof', 'instanceof', and 'in' are allowed
const prohibitedKeywordRE = new RegExp(
  '\\b' +
    (
      'arguments,await,break,case,catch,class,const,continue,debugger,default,' +
      'delete,do,else,export,extends,finally,for,function,if,import,let,new,' +
      'return,super,switch,throw,try,var,void,while,with,yield'
    )
      .split(',')
      .join('\\b|\\b') +
    '\\b',
)

// strip strings in expressions
const stripStringRE =
  /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*\$\{|\}(?:[^`\\]|\\.)*`|`(?:[^`\\]|\\.)*`/g

/**
 * 校验浏览器构建中的非 prefix 表达式是否合法。
 *
 * `asParams` / `asRawStatements` 会影响表达式被包裹成什么 JS 片段，
 * 从而复用一套校验逻辑覆盖 `v-on`、插值与普通绑定表达式。
 */
export function validateBrowserExpression(
  node: SimpleExpressionNode,
  context: TransformContext,
  asParams = false,
  asRawStatements = false,
): void {
  const exp = node.content

  // empty expressions are validated per-directive since some directives
  // do allow empty expressions.
  if (!exp.trim()) {
    return
  }

  try {
    new Function(
      asRawStatements
        ? ` ${exp} `
        : `return ${asParams ? `(${exp}) => {}` : `(${exp})`}`,
    )
  } catch (e: any) {
    let message = e.message
    const keywordMatch = exp
      .replace(stripStringRE, '')
      .match(prohibitedKeywordRE)
    if (keywordMatch) {
      message = `avoid using JavaScript keyword as property name: "${keywordMatch[0]}"`
    }
    context.onError(
      createCompilerError(
        ErrorCodes.X_INVALID_EXPRESSION,
        node.loc,
        undefined,
        message,
      ),
    )
  }
}
