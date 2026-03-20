/**
 * 文件说明：兼容 Vue 2 的 $children 属性访问。
 */
import { ShapeFlags } from '@vue/shared'
import type { ComponentInternalInstance } from '../component'
import type { ComponentPublicInstance } from '../componentPublicInstance'
import type { VNode } from '../vnode'
import { DeprecationTypes, assertCompatEnabled } from './compatConfig'

/**
 * 读取`compat`子节点。
 */

export function getCompatChildren(
  instance: ComponentInternalInstance,
): ComponentPublicInstance[] {
  assertCompatEnabled(DeprecationTypes.INSTANCE_CHILDREN, instance)
  const root = instance.subTree
  const children: ComponentPublicInstance[] = []
  if (root) {
    walk(root, children)
  }
  return children
}

/**
 * 封装 `walk` 辅助逻辑。
 */

function walk(vnode: VNode, children: ComponentPublicInstance[]) {
  if (vnode.component) {
    children.push(vnode.component.proxy!)
  } else if (vnode.shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
    const vnodes = vnode.children as VNode[]
    for (let i = 0; i < vnodes.length; i++) {
      walk(vnodes[i], children)
    }
  }
}
