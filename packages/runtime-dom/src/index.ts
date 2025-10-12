import {
  type App,
  type CreateAppFunction,
  type DefineComponent,
  DeprecationTypes,
  type Directive,
  type ElementNamespace,
  type HydrationRenderer,
  type Renderer,
  type RootHydrateFunction,
  type RootRenderFunction,
  compatUtils,
  createHydrationRenderer,
  createRenderer,
  isRuntimeOnly,
  warn,
} from '@vue/runtime-core'
import { nodeOps } from './nodeOps'
import { patchProp } from './patchProp'
// Importing from the compiler, will be tree-shaken in prod
import {
  NOOP,
  extend,
  isFunction,
  isHTMLTag,
  isMathMLTag,
  isSVGTag,
  isString,
} from '@vue/shared'
import type { TransitionProps } from './components/Transition'
import type { TransitionGroupProps } from './components/TransitionGroup'
import type { vShow } from './directives/vShow'
import type { VOnDirective } from './directives/vOn'
import type { VModelDirective } from './directives/vModel'

/**
 * This is a stub implementation to prevent the need to use dom types.
 *
 * To enable proper types, add `"dom"` to `"lib"` in your `tsconfig.json`.
 */
type DomStub = {}
type DomType<T> = typeof globalThis extends { window: unknown } ? T : DomStub

declare module '@vue/reactivity' {
  export interface RefUnwrapBailTypes {
    runtimeDOMBailTypes: DomType<Node | Window>
  }
}

declare module '@vue/runtime-core' {
  interface GlobalComponents {
    Transition: DefineComponent<TransitionProps>
    TransitionGroup: DefineComponent<TransitionGroupProps>
  }

  interface GlobalDirectives {
    vShow: typeof vShow
    vOn: VOnDirective
    vBind: VModelDirective
    vIf: Directive<any, boolean>
    vOnce: Directive
    vSlot: Directive
  }
}

const rendererOptions = /*@__PURE__*/ extend({ patchProp }, nodeOps)

// lazy create the renderer - this makes core renderer logic tree-shakable
// in case the user only imports reactivity utilities from Vue.
// 延迟创建 renderer —— 这样可以让核心渲染逻辑支持按需 tree-shaking，
// 以防用户只从 Vue 导入响应式相关的工具。
let renderer: Renderer<Element | ShadowRoot> | HydrationRenderer

let enabledHydration = false

function ensureRenderer() {
  return (
    renderer ||
    (renderer = createRenderer<Node, Element | ShadowRoot>(rendererOptions))
  )
}

function ensureHydrationRenderer() {
  renderer = enabledHydration
    ? renderer
    : createHydrationRenderer(rendererOptions)
  enabledHydration = true
  return renderer as HydrationRenderer
}

// use explicit type casts here to avoid import() calls in rolled-up d.ts
export const render = ((...args) => {
  ensureRenderer().render(...args)
}) as RootRenderFunction<Element | ShadowRoot>

export const hydrate = ((...args) => {
  ensureHydrationRenderer().hydrate(...args)
}) as RootHydrateFunction

export const createApp = ((...args) => {
  // 懒加载 renderer，调用 createApp 时才创建
  const app = ensureRenderer().createApp(...args)

  if (__DEV__) {
    injectNativeTagCheck(app)
    injectCompilerOptionsCheck(app)
  }

  const { mount } = app
  app.mount = (containerOrSelector: Element | ShadowRoot | string): any => {
    const container = normalizeContainer(containerOrSelector)
    if (!container) return

    const component = app._component
    if (!isFunction(component) && !component.render && !component.template) {
      // __UNSAFE__
      // Reason: potential execution of JS expressions in in-DOM template.
      // The user must make sure the in-DOM template is trusted. If it's
      // rendered by the server, the template should not contain any user data.
      component.template = container.innerHTML
      // 2.x compat check
      if (__COMPAT__ && __DEV__ && container.nodeType === 1) {
        for (let i = 0; i < (container as Element).attributes.length; i++) {
          const attr = (container as Element).attributes[i]
          if (attr.name !== 'v-cloak' && /^(v-|:|@)/.test(attr.name)) {
            compatUtils.warnDeprecation(
              DeprecationTypes.GLOBAL_MOUNT_CONTAINER,
              null,
            )
            break
          }
        }
      }
    }

    // clear content before mounting
    if (container.nodeType === 1) {
      container.textContent = ''
    }
    const proxy = mount(container, false, resolveRootNamespace(container))
    if (container instanceof Element) {
      container.removeAttribute('v-cloak')
      container.setAttribute('data-v-app', '')
    }
    return proxy
  }

  return app
}) as CreateAppFunction<Element>

export const createSSRApp = ((...args) => {
  const app = ensureHydrationRenderer().createApp(...args)

  if (__DEV__) {
    injectNativeTagCheck(app)
    injectCompilerOptionsCheck(app)
  }

  const { mount } = app
  app.mount = (containerOrSelector: Element | ShadowRoot | string): any => {
    const container = normalizeContainer(containerOrSelector)
    if (container) {
      return mount(container, true, resolveRootNamespace(container))
    }
  }

  return app
}) as CreateAppFunction<Element>

function resolveRootNamespace(
  container: Element | ShadowRoot,
): ElementNamespace {
  if (container instanceof SVGElement) {
    return 'svg'
  }
  if (
    typeof MathMLElement === 'function' &&
    container instanceof MathMLElement
  ) {
    return 'mathml'
  }
}

function injectNativeTagCheck(app: App) {
  // Inject `isNativeTag`
  // this is used for component name validation (dev only)
  Object.defineProperty(app.config, 'isNativeTag', {
    value: (tag: string) => isHTMLTag(tag) || isSVGTag(tag) || isMathMLTag(tag),
    writable: false,
  })
}

// dev only
function injectCompilerOptionsCheck(app: App) {
  if (isRuntimeOnly()) {
    const isCustomElement = app.config.isCustomElement
    Object.defineProperty(app.config, 'isCustomElement', {
      get() {
        return isCustomElement
      },
      set() {
        warn(
          `The \`isCustomElement\` config option is deprecated. Use ` +
            `\`compilerOptions.isCustomElement\` instead.`,
        )
      },
    })

    const compilerOptions = app.config.compilerOptions
    const msg =
      `The \`compilerOptions\` config option is only respected when using ` +
      `a build of Vue.js that includes the runtime compiler (aka "full build"). ` +
      `Since you are using the runtime-only build, \`compilerOptions\` ` +
      `must be passed to \`@vue/compiler-dom\` in the build setup instead.\n` +
      `- For vue-loader: pass it via vue-loader's \`compilerOptions\` loader option.\n` +
      `- For vue-cli: see https://cli.vuejs.org/guide/webpack.html#modifying-options-of-a-loader\n` +
      `- For vite: pass it via @vitejs/plugin-vue options. See https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue#example-for-passing-options-to-vuecompiler-sfc`

    Object.defineProperty(app.config, 'compilerOptions', {
      get() {
        warn(msg)
        return compilerOptions
      },
      set() {
        warn(msg)
      },
    })
  }
}

/**
 * 规范化容器参数，确保其为有效的 DOM 元素或 ShadowRoot。
 *
 * @param {Element | ShadowRoot | string} container - 需要规范化的容器，可以是 DOM 元素、ShadowRoot 或 CSS 选择器字符串。
 * @returns {Element | ShadowRoot | null} - 返回解析后的 DOM 元素或 ShadowRoot。如果传入字符串但未找到匹配元素，则返回 null。
 *
 * @remarks
 * - 如果 container 是字符串，则会尝试通过 document.querySelector 查询 DOM 元素。
 * - 在开发模式（__DEV__）下：
 *   - 如果选择器字符串未能解析为元素，会输出警告。
 *   - 如果容器为关闭模式的 ShadowRoot，会输出警告，提示可能导致不可预期的 bug。
 */
function normalizeContainer(
  container: Element | ShadowRoot | string,
): Element | ShadowRoot | null {
  if (isString(container)) {
    const res = document.querySelector(container)
    if (__DEV__ && !res) {
      warn(
        `Failed to mount app: mount target selector "${container}" returned null.`,
      )
    }
    return res
  }
  if (
    __DEV__ &&
    window.ShadowRoot &&
    container instanceof window.ShadowRoot &&
    container.mode === 'closed'
  ) {
    warn(
      `mounting on a ShadowRoot with \`{mode: "closed"}\` may lead to unpredictable bugs`,
    )
  }
  return container as any
}

// Custom element support
export {
  defineCustomElement,
  defineSSRCustomElement,
  useShadowRoot,
  useHost,
  VueElement,
  type VueElementConstructor,
  type CustomElementOptions,
} from './apiCustomElement'

// SFC CSS utilities
export { useCssModule } from './helpers/useCssModule'
export { useCssVars } from './helpers/useCssVars'

// DOM-only components
export { Transition, type TransitionProps } from './components/Transition'
export {
  TransitionGroup,
  type TransitionGroupProps,
} from './components/TransitionGroup'

// **Internal** DOM-only runtime directive helpers
export {
  vModelText,
  vModelCheckbox,
  vModelRadio,
  vModelSelect,
  vModelDynamic,
} from './directives/vModel'
export { withModifiers, withKeys } from './directives/vOn'
export { vShow } from './directives/vShow'

import { initVModelForSSR } from './directives/vModel'
import { initVShowForSSR } from './directives/vShow'

let ssrDirectiveInitialized = false

/**
 * @internal
 */
export const initDirectivesForSSR: () => void = __SSR__
  ? () => {
      if (!ssrDirectiveInitialized) {
        ssrDirectiveInitialized = true
        initVModelForSSR()
        initVShowForSSR()
      }
    }
  : NOOP

// re-export everything from core
// h, Component, reactivity API, nextTick, flags & types
export * from '@vue/runtime-core'

export * from './jsx'
