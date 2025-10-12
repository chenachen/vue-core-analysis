import { getGlobalThis } from '@vue/shared'

/**
 * 初始化 Vue 的功能标志（Feature Flags）。
 *
 * This is only called in esm-bundler builds.
 * It is called when a renderer is created, in `baseCreateRenderer` so that
 * importing runtime-core is side-effects free.
 * 该函数仅在 esm-bundler 构建中调用。
 * 它会在渲染器创建时（`baseCreateRenderer` 中）调用，
 * 以确保导入 runtime-core 时没有副作用。
 *
 * https://cn.vuejs.org/api/compile-time-flags
 * 说人话就是：在打包时，可以通过配置这些编译时功能标志，
 * 来启用或禁用某些 Vue 功能，从而实现更好的 Tree-Shaking 效果。达到更小的打包体积。
 */
export function initFeatureFlags(): void {
  // 用于存储需要警告的功能标志名称
  const needWarn = []

  // 检查是否定义了 __FEATURE_OPTIONS_API__ 标志
  if (typeof __FEATURE_OPTIONS_API__ !== 'boolean') {
    // 如果未定义且处于开发模式，添加警告
    __DEV__ && needWarn.push(`__VUE_OPTIONS_API__`)
    // 设置默认值为 true
    getGlobalThis().__VUE_OPTIONS_API__ = true
  }

  // 检查是否定义了 __FEATURE_PROD_DEVTOOLS__ 标志
  if (typeof __FEATURE_PROD_DEVTOOLS__ !== 'boolean') {
    // 如果未定义且处于开发模式，添加警告
    __DEV__ && needWarn.push(`__VUE_PROD_DEVTOOLS__`)
    // 设置默认值为 false
    getGlobalThis().__VUE_PROD_DEVTOOLS__ = false
  }

  // 检查是否定义了 __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__ 标志
  if (typeof __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__ !== 'boolean') {
    // 如果未定义且处于开发模式，添加警告
    __DEV__ && needWarn.push(`__VUE_PROD_HYDRATION_MISMATCH_DETAILS__`)
    // 设置默认值为 false
    getGlobalThis().__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false
  }

  // 如果有未定义的功能标志且处于开发模式，输出警告信息
  if (__DEV__ && needWarn.length) {
    const multi = needWarn.length > 1
    console.warn(
      `功能标志${multi ? `s` : ``} ${needWarn.join(', ')} ${
        multi ? `未` : `未`
      }显式定义。您正在运行 Vue 的 esm-bundler 构建版本，` +
        `该版本期望通过打包器配置全局注入这些编译时功能标志，` +
        `以便在生产环境中实现更好的 Tree-Shaking。\n\n` +
        `详情请参阅：https://link.vuejs.org/feature-flags。`,
    )
  }
}
