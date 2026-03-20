/**
 * SFC `<style>` 编译入口。
 *
 * 它围绕 PostCSS 组织样式编译流程，并按需接入：
 * - 预处理器（sass/less/stylus 等）
 * - `v-bind()` CSS 变量注入
 * - scoped 样式重写
 * - CSS Modules
 * - source map 与依赖追踪
 */
import postcss, {
  type LazyResult,
  type Message,
  type ProcessOptions,
  type Result,
  type SourceMap,
} from 'postcss'
import trimPlugin from './style/pluginTrim'
import scopedPlugin from './style/pluginScoped'
import {
  type PreprocessLang,
  type StylePreprocessor,
  type StylePreprocessorResults,
  processors,
} from './style/preprocessors'
import type { RawSourceMap } from '@vue/compiler-core'
import { cssVarsPlugin } from './style/cssVars'
import postcssModules from 'postcss-modules'

export interface SFCStyleCompileOptions {
  source: string
  filename: string
  id: string
  scoped?: boolean
  trim?: boolean
  isProd?: boolean
  inMap?: RawSourceMap
  preprocessLang?: PreprocessLang
  preprocessOptions?: any
  preprocessCustomRequire?: (id: string) => any
  postcssOptions?: any
  postcssPlugins?: any[]
  /**
   * @deprecated use `inMap` instead.
   */
  map?: RawSourceMap
}

/**
 * Aligns with postcss-modules
 * https://github.com/css-modules/postcss-modules
 */
export interface CSSModulesOptions {
  scopeBehaviour?: 'global' | 'local'
  generateScopedName?:
    | string
    | ((name: string, filename: string, css: string) => string)
  hashPrefix?: string
  localsConvention?: 'camelCase' | 'camelCaseOnly' | 'dashes' | 'dashesOnly'
  exportGlobals?: boolean
  globalModulePaths?: RegExp[]
}

export interface SFCAsyncStyleCompileOptions extends SFCStyleCompileOptions {
  isAsync?: boolean
  // css modules support, note this requires async so that we can get the
  // resulting json
  modules?: boolean
  modulesOptions?: CSSModulesOptions
}

export interface SFCStyleCompileResults {
  code: string
  map: RawSourceMap | undefined
  rawResult: Result | LazyResult | undefined
  errors: Error[]
  modules?: Record<string, string>
  dependencies: Set<string>
}

/**
 * 同步样式编译入口。
 */
export function compileStyle(
  options: SFCStyleCompileOptions,
): SFCStyleCompileResults {
  return doCompileStyle({
    ...options,
    isAsync: false,
  }) as SFCStyleCompileResults
}

/**
 * 异步样式编译入口。
 *
 * 某些能力（如 CSS Modules）依赖异步处理，因此单独暴露 async 版本。
 */
export function compileStyleAsync(
  options: SFCAsyncStyleCompileOptions,
): Promise<SFCStyleCompileResults> {
  return doCompileStyle({
    ...options,
    isAsync: true,
  }) as Promise<SFCStyleCompileResults>
}

/**
 * 样式编译主流程。
 *
 * 这里会先做可选预处理，再依次组装 PostCSS 插件链，最后返回编译结果、
 * source map、模块导出与依赖文件集合。
 */
export function doCompileStyle(
  options: SFCAsyncStyleCompileOptions,
): SFCStyleCompileResults | Promise<SFCStyleCompileResults> {
  const {
    filename,
    id,
    scoped = false,
    trim = true,
    isProd = false,
    modules = false,
    modulesOptions = {},
    preprocessLang,
    postcssOptions,
    postcssPlugins,
  } = options
  const preprocessor = preprocessLang && processors[preprocessLang]
  const preProcessedSource = preprocessor && preprocess(options, preprocessor)
  const map = preProcessedSource
    ? preProcessedSource.map
    : options.inMap || options.map
  const source = preProcessedSource ? preProcessedSource.code : options.source

  const shortId = id.replace(/^data-v-/, '')
  const longId = `data-v-${shortId}`

  const plugins = (postcssPlugins || []).slice()
  plugins.unshift(cssVarsPlugin({ id: shortId, isProd }))
  if (trim) {
    plugins.push(trimPlugin())
  }
  if (scoped) {
    plugins.push(scopedPlugin(longId))
  }
  let cssModules: Record<string, string> | undefined
  if (modules) {
    if (__GLOBAL__ || __ESM_BROWSER__) {
      throw new Error(
        '[@vue/compiler-sfc] `modules` option is not supported in the browser build.',
      )
    }
    if (!options.isAsync) {
      throw new Error(
        '[@vue/compiler-sfc] `modules` option can only be used with compileStyleAsync().',
      )
    }
    plugins.push(
      postcssModules({
        ...modulesOptions,
        getJSON: (_cssFileName: string, json: Record<string, string>) => {
          cssModules = json
        },
      }),
    )
  }

  const postCSSOptions: ProcessOptions = {
    ...postcssOptions,
    to: filename,
    from: filename,
  }
  if (map) {
    postCSSOptions.map = {
      inline: false,
      annotation: false,
      prev: map,
    }
  }

  let result: LazyResult | undefined
  let code: string | undefined
  let outMap: SourceMap | undefined
  // stylus output include plain css. so need remove the repeat item
  const dependencies = new Set(
    preProcessedSource ? preProcessedSource.dependencies : [],
  )
  // sass has filename self when provided filename option
  dependencies.delete(filename)

  const errors: Error[] = []
  if (preProcessedSource && preProcessedSource.errors.length) {
    errors.push(...preProcessedSource.errors)
  }

  const recordPlainCssDependencies = (messages: Message[]) => {
    messages.forEach(msg => {
      if (msg.type === 'dependency') {
        // postcss output path is absolute position path
        dependencies.add(msg.file)
      }
    })
    return dependencies
  }

  try {
    result = postcss(plugins).process(source, postCSSOptions)

    // In async mode, return a promise.
    if (options.isAsync) {
      return result
        .then(result => ({
          code: result.css || '',
          map: result.map && result.map.toJSON(),
          errors,
          modules: cssModules,
          rawResult: result,
          dependencies: recordPlainCssDependencies(result.messages),
        }))
        .catch(error => ({
          code: '',
          map: undefined,
          errors: [...errors, error],
          rawResult: undefined,
          dependencies,
        }))
    }

    recordPlainCssDependencies(result.messages)
    // force synchronous transform (we know we only have sync plugins)
    code = result.css
    outMap = result.map
  } catch (e: any) {
    errors.push(e)
  }

  return {
    code: code || ``,
    map: outMap && outMap.toJSON(),
    errors,
    rawResult: result,
    dependencies,
  }
}

/**
 * 执行样式预处理器，并把结果统一整理成后续 PostCSS 可继续消费的结构。
 */
function preprocess(
  options: SFCStyleCompileOptions,
  preprocessor: StylePreprocessor,
): StylePreprocessorResults {
  if ((__ESM_BROWSER__ || __GLOBAL__) && !options.preprocessCustomRequire) {
    throw new Error(
      `[@vue/compiler-sfc] Style preprocessing in the browser build must ` +
        `provide the \`preprocessCustomRequire\` option to return the in-browser ` +
        `version of the preprocessor.`,
    )
  }

  return preprocessor(
    options.source,
    options.inMap || options.map,
    {
      filename: options.filename,
      ...options.preprocessOptions,
    },
    options.preprocessCustomRequire,
  )
}
