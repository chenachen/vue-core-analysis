/**
 * PostCSS 插件：裁剪规则前后的多余空白，使 SFC 输出样式更稳定。
 */
import type { PluginCreator } from 'postcss'

/**
 * 生成用于标准化规则前后 raw 空白的 PostCSS 插件。
 */
const trimPlugin: PluginCreator<{}> = () => {
  return {
    postcssPlugin: 'vue-sfc-trim',
    Once(root) {
      root.walk(({ type, raws }) => {
        if (type === 'rule' || type === 'atrule') {
          if (raws.before) raws.before = '\n'
          if ('after' in raws && raws.after) raws.after = '\n'
        }
      })
    },
  }
}

trimPlugin.postcss = true
export default trimPlugin
