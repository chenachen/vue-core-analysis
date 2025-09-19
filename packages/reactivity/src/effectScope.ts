import type { ReactiveEffect } from './effect'
import { warn } from './warning'

export let activeEffectScope: EffectScope | undefined

export class EffectScope {
  /**
   * 当前作用域是否活跃
   * @internal
   */
  private _active = true
  /**
   * @internal track `on` calls, allow `on` call multiple times
   */
  private _on = 0
  /**
   * 存储的effect
   * @internal
   */
  effects: ReactiveEffect[] = []
  /**
   * @internal
   */
  cleanups: (() => void)[] = []

  // 是否暂停状态
  private _isPaused = false

  /**
   * only assigned by undetached scope
   * 父作用域
   * @internal
   */
  parent: EffectScope | undefined
  /**
   * record undetached scopes
   * 记录相关联的作用域
   * @internal
   */
  scopes: EffectScope[] | undefined
  /**
   * track a child scope's index in its parent's scopes array for optimized
   * removal
   * 记录本作用域在父作用域的索引，方便优化移除操作
   * @internal
   */
  private index: number | undefined

  constructor(public detached = false) {
    // 将当前活跃的作用域设置为父作用域
    this.parent = activeEffectScope
    if (!detached && activeEffectScope) {
      // 记录当前作用域在父作用域中的索引
      this.index =
        (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
          this,
        ) - 1
    }
  }

  get active(): boolean {
    // 是否活跃状态
    return this._active
  }

  pause(): void {
    // 如果是活跃状态
    if (this._active) {
      // 设为暂停状态
      this._isPaused = true
      let i, l
      if (this.scopes) {
        // 遍历相关联的作用域，都设置为暂停状态
        for (i = 0, l = this.scopes.length; i < l; i++) {
          this.scopes[i].pause()
        }
      }
      // 将包含的effects全部设为暂停
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].pause()
      }
    }
  }

  /**
   * Resumes the effect scope, including all child scopes and effects.
   */
  resume(): void {
    // 如果是活跃状态
    if (this._active) {
      // 如果是暂停中
      if (this._isPaused) {
        // 暂停状态设为false
        this._isPaused = false
        let i, l
        if (this.scopes) {
          // 回复相关联的作用域
          for (i = 0, l = this.scopes.length; i < l; i++) {
            this.scopes[i].resume()
          }
        }
        // 将包含的effects的状态也恢复
        for (i = 0, l = this.effects.length; i < l; i++) {
          this.effects[i].resume()
        }
      }
    }
  }

  run<T>(fn: () => T): T | undefined {
    if (this._active) {
      const currentEffectScope = activeEffectScope
      try {
        // 将当前活跃的作用域设为自己
        activeEffectScope = this
        // 执行函数
        return fn()
      } finally {
        // 回复之前的活跃作用域
        activeEffectScope = currentEffectScope
      }
    } else if (__DEV__) {
      warn(`cannot run an inactive effect scope.`)
    }
  }

  prevScope: EffectScope | undefined
  /**
   * This should only be called on non-detached scopes
   * 这个方法只应该在非分离的作用域上调用
   * @internal
   */
  on(): void {
    if (++this._on === 1) {
      // 记录之前的活跃作用域
      this.prevScope = activeEffectScope
      // 将活跃作用域设为自己
      activeEffectScope = this
    }
  }

  /**
   * This should only be called on non-detached scopes
   * 这个方法只应该在非分离的作用域上调用
   * @internal
   */
  off(): void {
    if (this._on > 0 && --this._on === 0) {
      // 将活跃作用域重置为之前的值
      activeEffectScope = this.prevScope
      this.prevScope = undefined
    }
  }

  stop(fromParent?: boolean): void {
    // 如果是活跃状态
    if (this._active) {
      // 将活跃状态置为false
      this._active = false
      // 停止包含的effects
      let i, l
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].stop()
      }
      this.effects.length = 0

      // 调用清理函数
      for (i = 0, l = this.cleanups.length; i < l; i++) {
        this.cleanups[i]()
      }
      this.cleanups.length = 0

      // 停止相关联的作用域
      if (this.scopes) {
        for (i = 0, l = this.scopes.length; i < l; i++) {
          this.scopes[i].stop(true)
        }
        this.scopes.length = 0
      }

      // nested scope, dereference from parent to avoid memory leaks
      // 如果不是分离的作用域，并且有父作用域，并且不是从父作用域调用的
      if (!this.detached && this.parent && !fromParent) {
        // optimized O(1) removal
        // 优化O(1)移除
        const last = this.parent.scopes!.pop()
        // 如果移除的不是自己
        if (last && last !== this) {
          // 将最后一个替换到自己的位置
          this.parent.scopes![this.index!] = last
          // 更新索引
          last.index = this.index!
        }
      }
      this.parent = undefined
    }
  }
}

/**
 * Creates an effect scope object which can capture the reactive effects (i.e.
 * computed and watchers) created within it so that these effects can be
 * disposed together. For detailed use cases of this API, please consult its
 * corresponding {@link https://github.com/vuejs/rfcs/blob/master/active-rfcs/0041-reactivity-effect-scope.md | RFC}.
 * 创建一个作用域对象，可以捕获在其内部创建的响应式副作用（即computed和watchers），以便这些副作用可以一起被清理。关于这个API的详细使用案例，请参考对应的RFC。
 *
 * @param detached - Can be used to create a "detached" effect scope.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#effectscope}
 */
export function effectScope(detached?: boolean): EffectScope {
  return new EffectScope(detached)
}

/**
 * Returns the current active effect scope if there is one.
 * 返回当前活跃的作用域
 *
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#getcurrentscope}
 */
export function getCurrentScope(): EffectScope | undefined {
  return activeEffectScope
}

/**
 * Registers a dispose callback on the current active effect scope. The
 * callback will be invoked when the associated effect scope is stopped.
 * 注册一个清理函数到当前活跃的作用域中，当该作用域被停止时会调用这个函数
 *
 * @param fn - The callback function to attach to the scope's cleanup.
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#onscopedispose}
 */
export function onScopeDispose(fn: () => void, failSilently = false): void {
  if (activeEffectScope) {
    activeEffectScope.cleanups.push(fn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onScopeDispose() is called when there is no active effect scope` +
        ` to be associated with.`,
    )
  }
}
