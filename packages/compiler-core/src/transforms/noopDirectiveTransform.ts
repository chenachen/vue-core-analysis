/**
 * 空指令 transform。
 *
 * 某些指令在编译阶段只需要“识别但不生成额外 props”，
 * 这时可以复用这个占位实现保持 transform 管线结构一致。
 */
import type { DirectiveTransform } from '../transform'

/**
 * 不做任何改写，仅返回空 props。
 */
export const noopDirectiveTransform: DirectiveTransform = () => ({ props: [] })
