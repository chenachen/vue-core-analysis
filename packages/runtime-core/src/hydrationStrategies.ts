/**
 * 文件说明：定义异步组件的水合触发策略，如 idle 和 visible 两类延迟激活方案。
 */
import { getGlobalThis, isString } from '@vue/shared'
import { DOMNodeTypes, isComment } from './hydration'

// Polyfills for Safari support
// see https://caniuse.com/requestidlecallback
const requestIdleCallback: Window['requestIdleCallback'] =
  getGlobalThis().requestIdleCallback || (cb => setTimeout(cb, 1))
const cancelIdleCallback: Window['cancelIdleCallback'] =
  getGlobalThis().cancelIdleCallback || (id => clearTimeout(id))

/**
 * A lazy hydration strategy for async components.
 * @param hydrate - call this to perform the actual hydration.
 * @param forEachElement - iterate through the root elements of the component's
 *                         non-hydrated DOM, accounting for possible fragments.
 * @returns a teardown function to be called if the async component is unmounted
 *          before it is hydrated. This can be used to e.g. remove DOM event
 *          listeners.
 */
export type HydrationStrategy = (
  hydrate: () => void,
  forEachElement: (cb: (el: Element) => any) => void,
) => (() => void) | void

export type HydrationStrategyFactory<Options> = (
  options?: Options,
) => HydrationStrategy

/**
 * 封装 `hydrateOnIdle` 辅助逻辑。
 */

export const hydrateOnIdle: HydrationStrategyFactory<number> =
  (timeout = 10000) =>
  hydrate => {
    const id = requestIdleCallback(hydrate, { timeout })
    return () => cancelIdleCallback(id)
  }

/**
 * 封装 `elementIsVisibleInViewport` 辅助逻辑。
 */

function elementIsVisibleInViewport(el: Element) {
  const { top, left, bottom, right } = el.getBoundingClientRect()
  // eslint-disable-next-line no-restricted-globals
  const { innerHeight, innerWidth } = window
  return (
    ((top > 0 && top < innerHeight) || (bottom > 0 && bottom < innerHeight)) &&
    ((left > 0 && left < innerWidth) || (right > 0 && right < innerWidth))
  )
}

/**
 * 封装 `hydrateOnVisible` 辅助逻辑。
 */

export const hydrateOnVisible: HydrationStrategyFactory<
  IntersectionObserverInit
> = opts => (hydrate, forEach) => {
  const ob = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      ob.disconnect()
      hydrate()
      break
    }
  }, opts)
  forEach(el => {
    if (!(el instanceof Element)) return
    if (elementIsVisibleInViewport(el)) {
      hydrate()
      ob.disconnect()
      return false
    }
    ob.observe(el)
  })
  return () => ob.disconnect()
}

/**
 * 封装 `hydrateOnMediaQuery` 辅助逻辑。
 */

export const hydrateOnMediaQuery: HydrationStrategyFactory<string> =
  query => hydrate => {
    if (query) {
      const mql = matchMedia(query)
      if (mql.matches) {
        hydrate()
      } else {
        mql.addEventListener('change', hydrate, { once: true })
        return () => mql.removeEventListener('change', hydrate)
      }
    }
  }

/**
 * 封装 `hydrateOnInteraction` 辅助逻辑。
 */

export const hydrateOnInteraction: HydrationStrategyFactory<
  keyof HTMLElementEventMap | Array<keyof HTMLElementEventMap>
> =
  (interactions = []) =>
  (hydrate, forEach) => {
    if (isString(interactions)) interactions = [interactions]
    let hasHydrated = false

    /**
     * 封装 `doHydrate` 辅助逻辑。
     */

    const doHydrate = (e: Event) => {
      if (!hasHydrated) {
        hasHydrated = true
        teardown()
        hydrate()
        // replay event
        e.target!.dispatchEvent(new (e.constructor as any)(e.type, e))
      }
    }

    /**
     * 封装 `teardown` 辅助逻辑。
     */

    const teardown = () => {
      forEach(el => {
        for (const i of interactions) {
          el.removeEventListener(i, doHydrate)
        }
      })
    }
    forEach(el => {
      for (const i of interactions) {
        el.addEventListener(i, doHydrate, { once: true })
      }
    })
    return teardown
  }

/**
 * 封装 `forEachElement` 辅助逻辑。
 */

export function forEachElement(
  node: Node,
  cb: (el: Element) => void | false,
): void {
  // fragment
  if (isComment(node) && node.data === '[') {
    let depth = 1
    let next = node.nextSibling
    while (next) {
      if (next.nodeType === DOMNodeTypes.ELEMENT) {
        const result = cb(next as Element)
        if (result === false) {
          break
        }
      } else if (isComment(next)) {
        if (next.data === ']') {
          if (--depth === 0) break
        } else if (next.data === '[') {
          depth++
        }
      }
      next = next.nextSibling
    }
  } else {
    cb(node as Element)
  }
}
