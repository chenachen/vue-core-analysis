import { pauseTracking, resetTracking } from '@vue/reactivity'
import type { VNode } from './vnode'
import type { ComponentInternalInstance } from './component'
import { popWarningContext, pushWarningContext, warn } from './warning'
import { EMPTY_OBJ, isArray, isFunction, isPromise } from '@vue/shared'
import { LifecycleHooks } from './enums'
import { WatchErrorCodes } from '@vue/reactivity'

// contexts where user provided function may be executed, in addition to
// lifecycle hooks.
export enum ErrorCodes {
  SETUP_FUNCTION,
  RENDER_FUNCTION,
  // The error codes for the watch have been transferred to the reactivity
  // package along with baseWatch to maintain code compatibility. Hence,
  // it is essential to keep these values unchanged.
  // WATCH_GETTER,
  // WATCH_CALLBACK,
  // WATCH_CLEANUP,
  NATIVE_EVENT_HANDLER = 5,
  COMPONENT_EVENT_HANDLER,
  VNODE_HOOK,
  DIRECTIVE_HOOK,
  TRANSITION_HOOK,
  APP_ERROR_HANDLER,
  APP_WARN_HANDLER,
  FUNCTION_REF,
  ASYNC_COMPONENT_LOADER,
  SCHEDULER,
  COMPONENT_UPDATE,
  APP_UNMOUNT_CLEANUP,
}

export const ErrorTypeStrings: Record<ErrorTypes, string> = {
  [LifecycleHooks.SERVER_PREFETCH]: 'serverPrefetch hook',
  [LifecycleHooks.BEFORE_CREATE]: 'beforeCreate hook',
  [LifecycleHooks.CREATED]: 'created hook',
  [LifecycleHooks.BEFORE_MOUNT]: 'beforeMount hook',
  [LifecycleHooks.MOUNTED]: 'mounted hook',
  [LifecycleHooks.BEFORE_UPDATE]: 'beforeUpdate hook',
  [LifecycleHooks.UPDATED]: 'updated',
  [LifecycleHooks.BEFORE_UNMOUNT]: 'beforeUnmount hook',
  [LifecycleHooks.UNMOUNTED]: 'unmounted hook',
  [LifecycleHooks.ACTIVATED]: 'activated hook',
  [LifecycleHooks.DEACTIVATED]: 'deactivated hook',
  [LifecycleHooks.ERROR_CAPTURED]: 'errorCaptured hook',
  [LifecycleHooks.RENDER_TRACKED]: 'renderTracked hook',
  [LifecycleHooks.RENDER_TRIGGERED]: 'renderTriggered hook',
  [ErrorCodes.SETUP_FUNCTION]: 'setup function',
  [ErrorCodes.RENDER_FUNCTION]: 'render function',
  [WatchErrorCodes.WATCH_GETTER]: 'watcher getter',
  [WatchErrorCodes.WATCH_CALLBACK]: 'watcher callback',
  [WatchErrorCodes.WATCH_CLEANUP]: 'watcher cleanup function',
  [ErrorCodes.NATIVE_EVENT_HANDLER]: 'native event handler',
  [ErrorCodes.COMPONENT_EVENT_HANDLER]: 'component event handler',
  [ErrorCodes.VNODE_HOOK]: 'vnode hook',
  [ErrorCodes.DIRECTIVE_HOOK]: 'directive hook',
  [ErrorCodes.TRANSITION_HOOK]: 'transition hook',
  [ErrorCodes.APP_ERROR_HANDLER]: 'app errorHandler',
  [ErrorCodes.APP_WARN_HANDLER]: 'app warnHandler',
  [ErrorCodes.FUNCTION_REF]: 'ref function',
  [ErrorCodes.ASYNC_COMPONENT_LOADER]: 'async component loader',
  [ErrorCodes.SCHEDULER]: 'scheduler flush',
  [ErrorCodes.COMPONENT_UPDATE]: 'component update',
  [ErrorCodes.APP_UNMOUNT_CLEANUP]: 'app unmount cleanup function',
}

export type ErrorTypes = LifecycleHooks | ErrorCodes | WatchErrorCodes

export function callWithErrorHandling(
  fn: Function,
  instance: ComponentInternalInstance | null | undefined,
  type: ErrorTypes,
  args?: unknown[],
): any {
  try {
    return args ? fn(...args) : fn()
  } catch (err) {
    handleError(err, instance, type)
  }
}

/**
 * 使用异步错误处理调用函数或函数数组。
 *
 * - 当传入单个函数时：同步调用该函数；若返回值是 Promise，则附加 `.catch` 来捕获并通过 `handleError` 处理异步错误。
 * - 当传入函数数组时：对数组内每个函数递归调用 `callWithAsyncErrorHandling` 并返回结果数组。
 * - 在开发模式下，如果传入的 `fn` 既不是函数也不是数组，会发出警告。
 *
 * @param {Function | Function[]} fn - 要执行的函数或函数数组。
 * @param {ComponentInternalInstance | null} instance - 与调用关联的组件内部实例（可为 `null`）。
 * @param {ErrorTypes} type - 错误类型，用于错误上报和上下文信息。
 * @param {unknown[]} [args] - 可选参数，会按顺序转发给被调用函数。
 * @returns {any | any[]} 返回单个函数的执行结果，或当 `fn` 为数组时返回结果数组。
 */
export function callWithAsyncErrorHandling(
  fn: Function | Function[],
  instance: ComponentInternalInstance | null,
  type: ErrorTypes,
  args?: unknown[],
): any {
  // 单个函数的处理：使用 callWithErrorHandling 保证同步错误被捕获，
  // 若返回 Promise 则附加 catch 以处理异步错误。
  if (isFunction(fn)) {
    const res = callWithErrorHandling(fn, instance, type, args)
    if (res && isPromise(res)) {
      res.catch(err => {
        handleError(err, instance, type)
      })
    }
    return res
  }

  // 数组的处理：递归调用以支持数组中既有同步也有异步函数
  if (isArray(fn)) {
    const values = []
    for (let i = 0; i < fn.length; i++) {
      values.push(callWithAsyncErrorHandling(fn[i], instance, type, args))
    }
    return values
  } else if (__DEV__) {
    // 开发模式下提示类型错误，帮助定位调用处传参问题
    warn(
      `Invalid value type passed to callWithAsyncErrorHandling(): ${typeof fn}`,
    )
  }
}

export function handleError(
  err: unknown,
  instance: ComponentInternalInstance | null | undefined,
  type: ErrorTypes,
  throwInDev = true,
): void {
  const contextVNode = instance ? instance.vnode : null
  // 获取注册在app.config的错误处理函数
  const { errorHandler, throwUnhandledErrorInProduction } =
    (instance && instance.appContext.config) || EMPTY_OBJ
  if (instance) {
    let cur = instance.parent
    // the exposed instance is the render proxy to keep it consistent with 2.x
    const exposedInstance = instance.proxy
    // in production the hook receives only the error code
    const errorInfo = __DEV__
      ? ErrorTypeStrings[type]
      : `https://vuejs.org/error-reference/#runtime-${type}`
    while (cur) {
      const errorCapturedHooks = cur.ec
      if (errorCapturedHooks) {
        for (let i = 0; i < errorCapturedHooks.length; i++) {
          if (
            errorCapturedHooks[i](err, exposedInstance, errorInfo) === false
          ) {
            return
          }
        }
      }
      cur = cur.parent
    }
    // app-level handling
    if (errorHandler) {
      pauseTracking()
      callWithErrorHandling(errorHandler, null, ErrorCodes.APP_ERROR_HANDLER, [
        err,
        exposedInstance,
        errorInfo,
      ])
      resetTracking()
      return
    }
  }
  logError(err, type, contextVNode, throwInDev, throwUnhandledErrorInProduction)
}

function logError(
  err: unknown,
  type: ErrorTypes,
  contextVNode: VNode | null,
  throwInDev = true,
  throwInProd = false,
) {
  if (__DEV__) {
    const info = ErrorTypeStrings[type]
    if (contextVNode) {
      pushWarningContext(contextVNode)
    }
    warn(`Unhandled error${info ? ` during execution of ${info}` : ``}`)
    if (contextVNode) {
      popWarningContext()
    }
    // crash in dev by default so it's more noticeable
    if (throwInDev) {
      throw err
    } else if (!__TEST__) {
      console.error(err)
    }
  } else if (throwInProd) {
    throw err
  } else {
    // recover in prod to reduce the impact on end-user
    console.error(err)
  }
}
