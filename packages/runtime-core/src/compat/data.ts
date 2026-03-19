/**
 * 文件说明：兼容 Vue 2 data 选项的深度合并逻辑。
 */
import { isPlainObject } from '@vue/shared'
import { DeprecationTypes, warnDeprecation } from './compatConfig'

export function deepMergeData(to: any, from: any): any {
  for (const key in from) {
    const toVal = to[key]
    const fromVal = from[key]
    if (key in to && isPlainObject(toVal) && isPlainObject(fromVal)) {
      __DEV__ && warnDeprecation(DeprecationTypes.OPTIONS_DATA_MERGE, null, key)
      deepMergeData(toVal, fromVal)
    } else {
      to[key] = fromVal
    }
  }
  return to
}
