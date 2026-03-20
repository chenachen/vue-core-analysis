# Vue 渲染器源码导读（runtime-core + runtime-dom）

> 目标：把 `packages/runtime-core` 与 `packages/runtime-dom` 这两层如何协作讲清楚，帮助你把“编译产物 → VNode → patch → DOM 更新 → 生命周期/指令/调度”的闭环完整串起来。

> 本轮补充说明：`packages/runtime-core/src` 下 65 个 `.ts` 文件、`packages/runtime-dom/src` 下 17 个 `.ts` 文件，现已统一补齐文件级说明，并在全量运行时函数周围补入函数级注释；其中 `renderer.ts`、`component.ts`、`hydration.ts`、`componentOptions.ts`、`componentProps.ts`、`scheduler.ts`、`Suspense.ts`、`patchProp.ts`、`directives/vModel.ts`、`apiCustomElement.ts`、`components/Transition.ts` 等高复杂度文件，还补了更细的流程节点与关键分支说明。阅读时可以先看每个文件顶部的“文件说明”，再顺着本文梳理主链路。

## 1. 先给结论：Vue 渲染器到底在做什么

Vue 运行时渲染器本质上做三件事：

1. **把组件 render 返回的 VNode 树变成宿主平台节点**
2. **在响应式数据变化后，计算新旧 VNode 的差异，并尽量少地更新宿主节点**
3. **把组件、指令、过渡、Teleport、Suspense、KeepAlive、调度器等能力挂到同一条更新链路上**

这套体系被拆成两层：

- **`runtime-core`**：平台无关，只关心“应该怎么 patch / mount / update / unmount”
- **`runtime-dom`**：DOM 平台实现，只关心“怎么创建 DOM、怎么 patch class/style/event/attr/prop”

可以把它理解成：

- `runtime-core` 决定 **做什么**
- `runtime-dom` 决定 **怎么在浏览器里做**

---

## 2. 建议的阅读顺序

如果你要顺着主链路读，建议顺序如下：

1. `packages/runtime-dom/src/index.ts`
2. `packages/runtime-core/src/renderer.ts`
3. `packages/runtime-core/src/vnode.ts`
4. `packages/runtime-core/src/component.ts`
5. `packages/runtime-core/src/componentRenderUtils.ts`
6. `packages/runtime-core/src/componentProps.ts`
7. `packages/runtime-core/src/componentSlots.ts`
8. `packages/runtime-core/src/scheduler.ts`
9. `packages/runtime-dom/src/nodeOps.ts`
10. `packages/runtime-dom/src/patchProp.ts`
11. `packages/runtime-dom/src/modules/*`
12. `packages/runtime-core/src/components/{Teleport,Suspense,KeepAlive,BaseTransition}.ts`
13. `packages/runtime-core/src/hydration.ts`
14. `packages/runtime-dom/src/components/{Transition,TransitionGroup}.ts`

---

## 3. 目录树

### 3.1 `packages/runtime-core/src`

```text
packages/runtime-core/src
├── apiAsyncComponent.ts
├── apiComputed.ts
├── apiCreateApp.ts
├── apiDefineComponent.ts
├── apiInject.ts
├── apiLifecycle.ts
├── apiSetupHelpers.ts
├── apiWatch.ts
├── compat
│   ├── attrsFallthrough.ts
│   ├── compatConfig.ts
│   ├── component.ts
│   ├── componentAsync.ts
│   ├── componentFunctional.ts
│   ├── componentVModel.ts
│   ├── customDirective.ts
│   ├── data.ts
│   ├── global.ts
│   ├── globalConfig.ts
│   ├── instance.ts
│   ├── instanceChildren.ts
│   ├── instanceEventEmitter.ts
│   ├── instanceListeners.ts
│   ├── props.ts
│   ├── renderFn.ts
│   └── renderHelpers.ts
├── component.ts
├── componentEmits.ts
├── componentOptions.ts
├── componentProps.ts
├── componentPublicInstance.ts
├── componentRenderContext.ts
├── componentRenderUtils.ts
├── componentSlots.ts
├── components
│   ├── BaseTransition.ts
│   ├── KeepAlive.ts
│   ├── Suspense.ts
│   └── Teleport.ts
├── customFormatter.ts
├── devtools.ts
├── directives.ts
├── enums.ts
├── errorHandling.ts
├── featureFlags.ts
├── h.ts
├── helpers
│   ├── createSlots.ts
│   ├── renderList.ts
│   ├── renderSlot.ts
│   ├── resolveAssets.ts
│   ├── toHandlers.ts
│   ├── useId.ts
│   ├── useModel.ts
│   ├── useSsrContext.ts
│   ├── useTemplateRef.ts
│   └── withMemo.ts
├── hmr.ts
├── hydration.ts
├── hydrationStrategies.ts
├── index.ts
├── internalObject.ts
├── profiling.ts
├── renderer.ts
├── rendererTemplateRef.ts
├── scheduler.ts
├── vnode.ts
└── warning.ts
```

### 3.2 `packages/runtime-dom/src`

```text
packages/runtime-dom/src
├── apiCustomElement.ts
├── components
│   ├── Transition.ts
│   └── TransitionGroup.ts
├── directives
│   ├── vModel.ts
│   ├── vOn.ts
│   └── vShow.ts
├── helpers
│   ├── useCssModule.ts
│   └── useCssVars.ts
├── index.ts
├── jsx.ts
├── modules
│   ├── attrs.ts
│   ├── class.ts
│   ├── events.ts
│   ├── props.ts
│   └── style.ts
├── nodeOps.ts
└── patchProp.ts
```

---

## 4. 每个文件的职责

> 这一节按“文件级”解释，先解决“这个文件存在的意义是什么”。

### 4.1 runtime-core 根目录文件

| 文件 | 职责 |
| --- | --- |
| `renderer.ts` | 渲染器核心。负责 `patch / mount / update / unmount` 的主流程，是整套运行时渲染系统的中枢。 |
| `vnode.ts` | VNode 定义与工厂。负责创建、克隆、规范化 VNode，并维护 block tree / dynamicChildren 等优化结构。 |
| `component.ts` | 组件实例系统。负责创建组件实例、初始化 props/slots、执行 setup、维护 currentInstance。 |
| `componentRenderUtils.ts` | 组件渲染辅助逻辑。负责执行 render、合并 fallthrough attrs、判断组件是否需要更新。 |
| `componentProps.ts` | props 的归一化、初始化、校验、更新。 |
| `componentSlots.ts` | slots 的初始化、标准化和更新。 |
| `componentOptions.ts` | Options API 合并、标准化与缓存。 |
| `componentEmits.ts` | emits 规范化与事件监听器判定。 |
| `componentPublicInstance.ts` | 组件对外实例代理（模板里的 `this`、`$props`、`$attrs`、`$refs` 等都从这里暴露）。 |
| `componentRenderContext.ts` | 当前渲染实例、scopeId、slot 渲染上下文等运行时上下文。 |
| `rendererTemplateRef.ts` | 模板 ref 的收集、更新与清理。 |
| `scheduler.ts` | 更新调度器。负责批量更新、去重、排序、pre/post flush 队列、`nextTick`。 |
| `hydration.ts` | SSR 水合逻辑，把现有 DOM 与 VNode 树对齐。 |
| `hydrationStrategies.ts` | 异步水合策略。 |
| `directives.ts` | 运行时指令的绑定结构与生命周期调用入口。 |
| `errorHandling.ts` | 统一的错误捕获、冒泡、`errorCaptured`、`app.config.errorHandler`。 |
| `warning.ts` | 开发环境 warning 输出与上下文栈。 |
| `devtools.ts` | devtools 集成。 |
| `profiling.ts` | 开发环境性能打点。 |
| `featureFlags.ts` | 初始化运行时功能标志，保证 esm-bundler 构建能正确 Tree-Shaking。 |
| `apiCreateApp.ts` | `createApp` / `app.mount` / `app.use` / `app.provide` 等应用级 API。 |
| `apiAsyncComponent.ts` | 异步组件包装器。 |
| `apiComputed.ts` | 运行时 `computed` 的导出适配。 |
| `apiDefineComponent.ts` | `defineComponent` 的类型与运行时入口。 |
| `apiInject.ts` | `provide / inject`。 |
| `apiLifecycle.ts` | `onMounted` / `onUpdated` / `onUnmounted` 等生命周期 API。 |
| `apiSetupHelpers.ts` | `useAttrs / useSlots / useModel` 等 setup 帮助函数。 |
| `apiWatch.ts` | `watch / watchEffect` 等监听 API。 |
| `h.ts` | 手写 render 函数常用的 `h`。 |
| `index.ts` | runtime-core 对外总出口。 |
| `hmr.ts` | HMR 支持。 |
| `enums.ts` | 生命周期等枚举定义。 |
| `internalObject.ts` | 内部对象标记。 |
| `customFormatter.ts` | 开发工具自定义格式化。 |

### 4.2 runtime-core/components

| 文件 | 职责 |
| --- | --- |
| `BaseTransition.ts` | 过渡抽象层，给 `Transition` / `TransitionGroup` 提供运行时过渡钩子拼装能力。 |
| `KeepAlive.ts` | 组件缓存与激活/失活。 |
| `Suspense.ts` | 异步依赖收集、fallback 分支、主分支切换。 |
| `Teleport.ts` | 把一段子树渲染到逻辑父级之外的目标容器。 |

### 4.3 runtime-core/helpers

| 文件 | 职责 |
| --- | --- |
| `createSlots.ts` | 编译产物生成 slots 时的辅助。 |
| `renderList.ts` | `v-for` 渲染辅助。 |
| `renderSlot.ts` | 运行时插槽渲染入口。 |
| `resolveAssets.ts` | 组件/指令/过滤器等资源解析。 |
| `toHandlers.ts` | 把对象转成 `onXxx` 事件对象。 |
| `useId.ts` | 生成稳定 id。 |
| `useModel.ts` | `<script setup>` / 组件 v-model 的运行时辅助。 |
| `useSsrContext.ts` | 获取 SSR 上下文。 |
| `useTemplateRef.ts` | 模板 ref 组合式 API。 |
| `withMemo.ts` | `v-memo` 对应的运行时缓存。 |

### 4.4 runtime-core/compat

| 文件 | 职责 |
| --- | --- |
| `compatConfig.ts` | Vue 2 兼容开关与弃用警告管理。 |
| `global.ts` / `globalConfig.ts` | 兼容全局 API 与全局配置。 |
| `component.ts` / `componentAsync.ts` / `componentFunctional.ts` / `componentVModel.ts` | Vue 2 组件行为兼容。 |
| `customDirective.ts` | 指令兼容层。 |
| `data.ts` / `props.ts` / `attrsFallthrough.ts` | 选项、props、attrs 兼容逻辑。 |
| `instance.ts` / `instanceChildren.ts` / `instanceEventEmitter.ts` / `instanceListeners.ts` | 组件实例行为兼容。 |
| `renderFn.ts` / `renderHelpers.ts` | 旧版 render 函数与 helper 兼容。 |

### 4.5 runtime-dom 根目录文件

| 文件 | 职责 |
| --- | --- |
| `index.ts` | DOM 平台入口：创建 DOM renderer、导出 `render/createApp/hydrate/createSSRApp`。 |
| `nodeOps.ts` | 对 DOM 的最小操作集合：创建节点、插入、删除、找父节点/兄弟节点。 |
| `patchProp.ts` | DOM 平台属性分发器：决定 `class/style/event/attr/dom prop` 怎么走。 |
| `apiCustomElement.ts` | 把 Vue 组件包装为 Web Components。 |
| `jsx.ts` | JSX 类型与运行时支持。 |

### 4.6 runtime-dom/modules

| 文件 | 职责 |
| --- | --- |
| `class.ts` | 更新 class。 |
| `style.ts` | 更新内联 style。 |
| `events.ts` | 事件绑定、更新、解绑。 |
| `attrs.ts` | 原生 attribute 更新。 |
| `props.ts` | DOM property 更新。 |

### 4.7 runtime-dom/directives

| 文件 | 职责 |
| --- | --- |
| `vModel.ts` | `v-model` 在 input/textarea/select/checkbox/radio 上的具体行为。 |
| `vOn.ts` | 事件修饰符。 |
| `vShow.ts` | 通过 `display` 控制显隐。 |

### 4.8 runtime-dom/components / helpers

| 文件 | 职责 |
| --- | --- |
| `components/Transition.ts` | 浏览器平台过渡实现（CSS class、时机、duration 检测）。 |
| `components/TransitionGroup.ts` | 列表过渡与移动动画。 |
| `helpers/useCssModule.ts` | 获取 CSS Modules 注入结果。 |
| `helpers/useCssVars.ts` | 组件状态驱动 CSS Variables。 |

---

## 5. 主链路：这些文件是怎么串成闭环的

```text
createApp() / render()
  ↓
runtime-dom/src/index.ts
  ↓ ensureRenderer()
createRenderer(rendererOptions)
  ↓
runtime-core/src/renderer.ts
  ↓ render(vnode, container)
patch(oldVNode, newVNode, container)
  ↓ 根据 vnode 类型分发
processText / processComment / processFragment / processElement / processComponent / Teleport / Suspense
  ↓
如果是组件：
  createComponentInstance → setupComponent → setupRenderEffect
  ↓
  renderComponentRoot(instance)
  ↓
  得到 subTree（VNode 树）
  ↓
  patch(null, subTree, ...)
  ↓
如果是元素：
  mountElement / patchElement
  ↓
  hostCreateElement / hostPatchProp / hostInsert
  ↓
  这些 host 方法来自 runtime-dom/nodeOps.ts + patchProp.ts
  ↓
真实 DOM 完成挂载/更新
  ↓
queuePostRenderEffect / scheduler
  ↓
mounted / updated / directive hook / transition hook
```

这就是完整闭环：

- **render 产出 VNode**
- **patch 递归消费 VNode**
- **host 操作落到 DOM**
- **响应式触发 effect 重新执行 render**
- **再进入 patch 完成更新**

---

## 6. 核心文件与关键函数详解

> 这一节不追求把每一个小 helper 都展开，而是把“渲染主链路上的关键函数”讲透。

### 6.1 `runtime-dom/src/index.ts`

#### 关键函数

| 函数 | 作用 | 实现要点 |
| --- | --- | --- |
| `ensureRenderer()` | 懒创建 renderer | 首次调用时才把 `patchProp + nodeOps` 传给 `createRenderer`，避免纯响应式场景把渲染器也打进去。 |
| `render()` | DOM 平台 render 入口 | 直接转调 core renderer。 |
| `hydrate()` | DOM 平台 hydration 入口 | 转调 hydration renderer。 |
| `createApp()` | 创建 DOM 应用实例 | 先拿到 core 的 app，再重写 `app.mount`，加上 DOM 特有流程。 |
| `normalizeContainer()` | 规范化挂载容器 | 支持选择器、Element、ShadowRoot。 |
| `resolveRootNamespace()` | 根命名空间判断 | 识别 `svg` / `mathml`。 |

#### 关键理解

这一层没有 diff 算法。它只是把：

- **`nodeOps`**：怎么操作 DOM 节点
- **`patchProp`**：怎么更新 DOM 属性

交给 `runtime-core`。

也就是说，浏览器平台的渲染能力，并不是写死在 `renderer.ts`，而是通过这层“注入”进去的。

---

### 6.2 `runtime-core/src/renderer.ts`

这是最重要的文件。

#### 关键函数总览

| 函数 | 作用 | 原理 |
| --- | --- | --- |
| `createRenderer()` | 创建普通 renderer | 把宿主平台实现包装成 `render + createApp`。 |
| `createHydrationRenderer()` | 创建带 hydration 的 renderer | 除普通渲染外，再注入 hydration 能力。 |
| `baseCreateRenderer()` | 真正的 renderer 工厂 | 形成一个闭包，把所有 host 方法存起来。 |
| `patch()` | 核心分发器 | 对比新旧 vnode 类型，决定挂载、更新、卸载、替换。 |
| `processElement()` | 处理元素 vnode | 区分 mount 和 patch。 |
| `mountElement()` | 首次挂载元素 | 创建真实节点、挂子节点、打 props、调用指令/过渡钩子、插入容器。 |
| `patchElement()` | 更新已有元素 | 复用 el，按 patchFlag / full diff 更新 props 与 children。 |
| `patchProps()` | 完整 props diff | 先删旧、再加新、最后单独处理 value。 |
| `processFragment()` | 处理 Fragment | 用起止锚点包裹一段连续子节点。 |
| `processComponent()` | 处理组件 vnode | 区分首次挂载、更新、KeepAlive 激活。 |
| `mountComponent()` | 首次挂载组件 | 创建实例、初始化 props/slots、执行 setup、建立渲染 effect。 |
| `updateComponent()` | 组件更新入口 | 先判断是否要更新，再触发 instance.update。 |
| `setupRenderEffect()` | 连接响应式系统与 patch 系统 | 首次执行完成 mount，后续数据变化由 scheduler 重新调度同一 effect。 |
| `updateComponentPreRender()` | 组件更新前预处理 | 先同步 vnode/props/slots，再清 pre-flush 回调。 |
| `patchChildren()` | children diff 总入口 | 根据 patchFlag / shapeFlag 选择文本 diff、unkeyed diff、keyed diff。 |
| `patchUnkeyedChildren()` | 无 key 列表 diff | 按索引对齐 patch，多余的删掉或补上。 |
| `patchKeyedChildren()` | 有 key 列表 diff | 头尾同步 + 建索引表 + 最长递增子序列，尽量少移动 DOM。 |
| `move()` | 移动 vnode 对应节点 | 给 Transition / Teleport / Fragment / Static 统一移动入口。 |
| `unmount()` | 卸载 vnode | 负责 refs、指令、组件、子树、过渡等清理。 |
| `remove()` | 移除真实节点 | 真正从宿主树里删节点，考虑 transition。 |
| `render()` | 根 render 入口 | 挂到容器 `_vnode` 上，做初次渲染/更新/卸载。 |

#### `patch()` 是如何分发的

`patch()` 做的第一件事，不是立刻 diff children，而是先判断：

- 新旧 vnode 是不是同类型
- 当前 vnode 是 Text / Comment / Static / Fragment / Element / Component / Teleport / Suspense 中的哪一种

这决定了后续逻辑完全不同。

你可以把 `patch()` 看成渲染器总调度中心。

#### `patchFlag` 与优化路径

`patchElement()` 和 `patchChildren()` 的性能关键，在于尽量利用编译器产物里的 `patchFlag`。

典型例子：

- `PatchFlags.CLASS`：只需要更新 class
- `PatchFlags.STYLE`：只需要更新 style
- `PatchFlags.PROPS`：只更新动态 props 列表
- `PatchFlags.TEXT`：只更新文本
- `PatchFlags.KEYED_FRAGMENT`：子节点走 keyed diff 快速路径
- `PatchFlags.UNKEYED_FRAGMENT`：子节点走无 key 快速路径
- `PatchFlags.FULL_PROPS`：有动态 key，退回完整 props diff

这就是 Vue 性能好的重要原因之一：

**不是每次都全量 diff，而是让编译器尽可能告诉运行时“变的可能只有哪里”。**

#### `patchKeyedChildren()` 为什么是性能核心

这个函数是整个渲染器里最值得细读的算法之一。

它大致分五步：

1. **从头同步**：前缀相同的节点直接 patch
2. **从尾同步**：后缀相同的节点直接 patch
3. **旧节点先耗尽**：剩余新节点直接 mount
4. **新节点先耗尽**：剩余旧节点直接 unmount
5. **中间乱序区间**：
   - 建立 `key -> newIndex` 映射
   - 遍历旧节点，找可复用的新节点
   - 记录 `newIndexToOldIndexMap`
   - 用 **LIS（最长递增子序列）** 找出“不需要移动”的最大稳定子序列
   - 只移动真正需要移动的节点

这个算法的设计目标不是“少比较”，而是：

- **尽量复用节点**
- **尽量少移动 DOM**

这对前端性能非常重要，因为 DOM 移动通常比 JS 对比更贵。

---

### 6.3 `runtime-core/src/vnode.ts`

#### 关键函数

| 函数 | 作用 | 原理 |
| --- | --- | --- |
| `createVNode()` | 创建 VNode | 根据 type/props/children 生成统一 vnode 结构，并打上 shapeFlag。 |
| `normalizeChildren()` | 规范 children | 把字符串、数组、slots、null 统一成可消费结构。 |
| `normalizeVNode()` | 规范任意 vnode 输入 | 把 `string/number/null/array/VNode` 转成标准 vnode。 |
| `cloneVNode()` | 克隆 vnode | 处理 attrs 透传、指令继承、过渡继承等场景。 |
| `isSameVNodeType()` | 判断能否复用节点 | 核心条件是 `type + key`，HMR 下会额外强制失配。 |
| `openBlock()` / `createBlock()` | block tree 优化 | 收集动态子节点，更新时跳过稳定静态区域。 |
| `setBlockTracking()` | 控制 block 收集 | 给 `v-once` / cache 这类场景临时关闭收集。 |

#### 关键理解

VNode 不是“简化版 DOM”，而是 Vue 自己的 **中间表示层**。

它至少承担四件事：

1. 表达节点类型
2. 携带 props / children / ref / key / patchFlag
3. 记录运行时信息（`el`、`component`、`anchor`、`dynamicChildren`）
4. 作为 patch 算法的输入输出结构

Vue 的 diff 算法并不是直接操作模板，而是操作 VNode。

---

### 6.4 `runtime-core/src/component.ts`

#### 关键函数

| 函数 | 作用 | 原理 |
| --- | --- | --- |
| `createComponentInstance()` | 创建组件实例 | 为 vnode 创建内部实例对象，挂载 appContext、parent、scope、proxy 等。 |
| `setupComponent()` | 组件初始化总入口 | 先 initProps / initSlots，再区分 stateful / functional component。 |
| `setupStatefulComponent()` | 初始化有状态组件 | 创建代理，执行 `setup`，处理 `setupResult`。 |
| `handleSetupResult()` | 处理 setup 返回值 | 返回函数则作为 render，返回对象则作为 setupState。 |
| `finishComponentSetup()` | 收尾 | 补全 render、编译模板（如果是 runtime compiler build）。 |

#### 关键理解

组件实例并不是 DOM 节点，也不是 VNode。

三者关系是：

- **VNode**：组件在父级视角下的描述
- **ComponentInternalInstance**：组件运行期实体
- **subTree**：这个组件 render 后得到的子 VNode 树

所以组件更新，本质上不是“直接更新组件”，而是：

- 组件 render 重新执行
- 生成新的 `subTree`
- 再拿 `旧 subTree` 和 `新 subTree` 去 patch

---

### 6.5 `runtime-core/src/componentRenderUtils.ts`

#### 关键函数

| 函数 | 作用 | 原理 |
| --- | --- | --- |
| `renderComponentRoot()` | 执行组件 render | 处理 stateful / functional 组件差异、attrs fallthrough、根节点修正、指令/transition 继承。 |
| `filterSingleRoot()` | 找到唯一根节点 | 用于 Fragment 根场景下的 attrs / scopeId / 指令判断。 |
| `shouldUpdateComponent()` | 判断组件是否需要更新 | 结合 patchFlag、props、slots、children 稳定性做剪枝。 |
| `updateHOCHostEl()` | 更新高阶组件 host el | 让父级能拿到正确的根 DOM。 |

#### 关键理解

这个文件的价值在于它处理了很多“不是 diff 主算法，但又对组件渲染极其关键”的细节：

- attrs 什么时候透传
- 指令为什么会继承到组件根节点
- Transition 为什么要求组件根节点可动画
- Fragment 根怎么找真正的元素根

---

### 6.6 `runtime-core/src/componentProps.ts`

#### 关键函数

| 函数 | 作用 |
| --- | --- |
| `initProps()` | 首次初始化 props / attrs |
| `updateProps()` | 组件更新时同步 props / attrs |
| `setFullProps()` | 遍历原始 vnode props，按声明分类到 props/attrs |
| `normalizePropsOptions()` | 规范化组件 props 选项并缓存 |
| `validateProps()` | 开发环境 props 校验 |

#### 关键理解

这里决定了一个非常重要的边界：

- **声明过的** 进入 `props`
- **没声明的** 进入 `attrs`

而 `attrs` 后续是否会透传到组件根节点，则要由 `componentRenderUtils.ts` 再决定。

---

### 6.7 `runtime-core/src/componentSlots.ts`

#### 关键函数

| 函数 | 作用 |
| --- | --- |
| `initSlots()` | 初始化 slots |
| `updateSlots()` | 更新 slots |
| `normalizeObjectSlots()` / `normalizeVNodeSlots()` | 把不同来源的 slots 标准化 |
| `normalizeSlotValue()` | 统一 slot 返回值为 VNode 数组 |

#### 关键理解

slot 最终不是“模板黑魔法”，而是函数。

父组件把 slot 作为函数传给子组件，子组件在 render 时执行它，得到一段 VNode。这样 slot 才能天然依赖父作用域。

---

### 6.8 `runtime-core/src/scheduler.ts`

#### 关键函数

| 函数 | 作用 | 重点 |
| --- | --- | --- |
| `queueJob()` | 把组件更新任务入队 | 去重、按 id 排序，保证父先子后。 |
| `queuePostFlushCb()` | 把 post-render 回调入队 | 生命周期、指令 updated 等常走这里。 |
| `flushPreFlushCbs()` | 刷新 pre-flush 回调 | watch pre、部分更新前逻辑。 |
| `flushPostFlushCbs()` | 刷新 post-flush 回调 | updated / mounted / directive post hook。 |
| `nextTick()` | 下一轮微任务后执行 | 用户侧常用。 |

#### 关键理解

Vue 不是数据一变立刻同步 patch，而是：

- 标记 effect dirty
- 入调度队列
- 本轮事件循环末尾统一 flush

这样能把多次同步修改合并成一次渲染。

---

### 6.9 `runtime-dom/src/nodeOps.ts`

#### 关键函数

| 函数 | 作用 |
| --- | --- |
| `insert()` | `insertBefore` 封装 |
| `remove()` | 删除节点 |
| `createElement()` | 创建普通元素 / SVG / MathML / customized built-in |
| `createText()` | 创建文本节点 |
| `createComment()` | 创建注释节点 |
| `setText()` | 更新文本节点值 |
| `setElementText()` | 更新元素 `textContent` |
| `parentNode()` / `nextSibling()` | DOM 遍历 |
| `querySelector()` | 选择器挂载支持 |
| `setScopeId()` | SFC scopeId 落到 DOM |
| `insertStaticContent()` | 静态提升节点快速插入 |

#### 关键理解

这一层的价值，是把浏览器 DOM API 抽象成一组最小 host operations。这样 renderer 核心就不需要依赖浏览器对象模型本身。

---

### 6.10 `runtime-dom/src/patchProp.ts`

#### 关键函数

| 函数 | 作用 |
| --- | --- |
| `patchProp()` | DOM 属性总分发器 |
| `shouldSetAsProp()` | 判定走 DOM prop 还是 attribute |
| `isNativeOn()` | 判定原生事件名 |

#### 分发规则

`patchProp()` 的逻辑非常关键：

1. `class` → `patchClass`
2. `style` → `patchStyle`
3. `onXxx` → `patchEvent`
4. 满足 property 条件 → `patchDOMProp`
5. 其他情况 → `patchAttr`

这也是 Vue 能兼顾：

- HTML / SVG / MathML
- 原生 attribute / DOM property
- 原生事件 / 组件事件
- custom element

的关键桥梁。

---

### 6.11 `runtime-dom/src/modules/*`

#### `class.ts`

- 负责写 class
- 特别处理了 `Transition` 临时类名与正常 class 的合并

#### `style.ts`

- 负责 style diff
- 支持字符串与对象
- 支持 CSS 变量与 `!important`
- 处理旧 style 清理

#### `events.ts`

- 不是每次都 remove 再 add，而是维护 invoker 缓存
- 更新事件回调时尽量复用已有 listener，减少 DOM 监听器抖动
- 支持 once/passive/capture 等修饰符解析

#### `attrs.ts`

- 负责 attribute 更新
- 包括布尔 attribute、xlink、移除逻辑

#### `props.ts`

- 负责 DOM property 更新
- 特别处理 `innerHTML`、`textContent`、`value` 等特殊属性

---

### 6.12 `runtime-core/src/components/Teleport.ts`

#### 关键理解

Teleport 的本质不是“单独的渲染器”，而是：

- 逻辑上它仍在原组件树里
- 物理上它的 children 被挂到别的容器

所以它要同时维护两套位置语义：

- 原位置：锚点
- 目标位置：target / targetAnchor

这也是为什么 renderer 里要专门识别 Teleport vnode，而不是把它当普通组件处理。

---

### 6.13 `runtime-core/src/components/Suspense.ts`

#### 关键理解

Suspense 管的是“异步依赖什么时候准备好”。

它会：

- 先挂 fallback 分支
- 统计 pending async deps
- 等依赖全部 resolve 后切回主分支

所以它不是简单的条件渲染，而是“带异步协调能力的边界”。

---

### 6.14 `runtime-core/src/components/KeepAlive.ts`

#### 关键理解

KeepAlive 不是“组件不卸载”，而是：

- 把组件子树从真实 DOM 中挪走 / 挪回
- 保留组件实例和状态
- 触发 activated / deactivated，而不是 mounted / unmounted

这说明：

**组件生命周期与 DOM 是否存在，并不是一一对应的。**

---

### 6.15 `runtime-core/src/hydration.ts`

#### 关键理解

hydration 不是重新 mount，而是：

- 复用服务端已生成的 DOM
- 用 vnode 树去“认领”这些 DOM
- 只补事件、实例、指令、必要差异

它的目标是：

- 避免白屏重建 DOM
- 保持服务端首屏结果
- 让客户端接管后续更新

---

## 7. Vue 是如何形成完整闭环的

### 7.1 首次挂载闭环

```text
createApp(App).mount('#app')
  ↓
runtime-dom/index.ts 重写 mount
  ↓
createVNode(rootComponent)
  ↓
renderer.render(vnode, container)
  ↓
patch(null, vnode, container)
  ↓
processComponent
  ↓
mountComponent
  ↓
setupComponent
  ↓
setupRenderEffect
  ↓
renderComponentRoot
  ↓
得到 subTree
  ↓
patch(null, subTree, container)
  ↓
processElement / processFragment / ...
  ↓
hostCreateElement + hostPatchProp + hostInsert
  ↓
真实 DOM 完成
  ↓
mounted / directive mounted / transition enter
```

### 7.2 响应式更新闭环

```text
响应式数据变更
  ↓
触发组件 render effect 的 scheduler
  ↓
queueJob(instance.update)
  ↓
flushJobs()
  ↓
instance.update()
  ↓
renderComponentRoot(instance) 得到 nextTree
  ↓
patch(prevTree, nextTree, ...)
  ↓
patchElement / patchChildren / patchKeyedChildren
  ↓
最小化更新 DOM
  ↓
updated / directive updated / post flush callbacks
```

### 7.3 卸载闭环

```text
父级不再渲染某个 vnode
  ↓
patch 中发现旧节点存在、新节点不存在或类型不匹配
  ↓
unmount(vnode)
  ↓
清 ref / 指令 beforeUnmount / 组件 beforeUnmount
  ↓
递归卸载子树
  ↓
remove(vnode)
  ↓
transition leave（如果有）
  ↓
hostRemove
  ↓
unmounted / directive unmounted / effect stop
```

---

## 8. 这些原理对日常 Vue 编码有什么实际帮助

### 8.1 为什么稳定的 key 非常重要

因为 keyed diff 的优化建立在：

- key 能稳定标识节点身份
- 旧节点可复用
- DOM 移动能最小化

实际建议：

- `v-for` 尽量用稳定业务 id，而不是 index
- 不要频繁制造随机 key
- key 不只是“消除警告”，它直接影响 diff 质量和状态复用

### 8.2 为什么要尽量让模板结构稳定

block tree、patchFlag、dynamicChildren 这些优化都依赖“结构稳定”。

实际建议：

- 避免不必要的动态节点层级变化
- 尽量让静态内容真静态
- 复杂条件渲染可以拆子组件，让更新边界更清晰

### 8.3 为什么 attrs / props / emits 要明确声明

因为 Vue 运行时要靠这些声明决定：

- 哪些是 props
- 哪些是 fallthrough attrs
- 哪些是组件事件
- 哪些应该透传到根节点

实际建议：

- 公共组件明确声明 `props` 和 `emits`
- 少依赖“神奇透传”，尤其组件根是 Fragment 时更要小心

### 8.4 为什么组件拆分有时能提升性能

组件一旦形成边界：

- 更新 effect 独立
- props 变化可剪枝
- patch 范围更局部

实际建议：

- 对大模板拆成合理子组件，通常更利于更新隔离
- 但不要过度碎片化，关键看边界是否稳定、数据依赖是否清晰

### 8.5 为什么 `v-memo` / `v-once` / computed / slot 优化能生效

因为它们都是在帮助渲染器做“少算、少 patch、少移动”。

实际建议：

- 极稳定的大块内容可考虑 `v-once`
- 某些依赖明确且昂贵的区域可考虑 `v-memo`
- slot 内容昂贵时，要关注父组件频繁重渲染带来的 slot 重新执行

### 8.6 为什么不要滥用内联对象 / 内联函数

虽然 Vue 不会因此立刻“炸性能”，但它会让某些比较与优化失去意义：

- props 每次都是新引用
- 子组件更容易被判定为需要更新
- 事件/样式/对象类 props 更容易触发 patch

实际建议：

- 高频更新路径里，尽量把稳定对象提出来
- 公共组件的复杂 props 尤其要注意引用稳定性

---

## 9. 有什么设计与实现值得学习

### 9.1 平台无关核心 + 平台适配层

这是 Vue 渲染器最值得学的架构点：

- `runtime-core` 完全不依赖 DOM
- `runtime-dom` 只提供宿主实现

这让 Vue 可以：

- 支持浏览器 DOM
- 支持 SSR hydration
- 支持自定义 renderer

这是一种非常经典且高级的设计：

**把“业务规则”与“平台能力”分开。**

### 9.2 编译器和运行时联动优化

Vue 不是只靠运行时聪明，而是：

- 编译期提前分析动态点
- 运行期利用 patchFlag / block tree 定点更新

值得学习的是：

**复杂性能优化，往往要编译期 + 运行期协同设计。**

### 9.3 用统一的数据结构承载多阶段信息

VNode 同时承载：

- 模板转译结果
- diff 输入
- patch 输出（`el/component/anchor`）
- 优化信息（`patchFlag/dynamicChildren`）

说明优秀的中间层结构，能把多个阶段串起来，而不是每个阶段都重新发明一套格式。

### 9.4 调度器把“正确性”和“性能”一起解决

scheduler 不只是为了快，更是为了：

- 避免重复更新
- 保证父子更新顺序
- 统一 pre/post 生命周期时机

这说明：

**调度系统常常是框架时序正确性的核心，而不只是性能附属品。**

### 9.5 小接口承载大扩展

`RendererOptions` 只有一小组 host 方法，但它足够让整个 renderer 跑起来。

这非常值得学：

- 抽象接口不需要很多
- 关键在于边界是否稳定、职责是否干净

### 9.6 特殊能力不是外挂，而是接入主链路

Teleport、Suspense、KeepAlive、Transition、Directive 都不是独立系统，它们都接进了同一条 patch 链路。

这比“某处 if/else 魔改一下”高级得多。

值得学习的是：

**扩展能力最好作为主流程的一等公民接入，而不是事后打补丁。**

---

## 10. 如果你要继续深挖，建议重点读这几段

### 必读 1：`renderer.ts`

重点看：

- `patch`
- `mountElement`
- `patchElement`
- `processComponent`
- `setupRenderEffect`
- `patchChildren`
- `patchKeyedChildren`
- `unmount`

### 必读 2：`vnode.ts`

重点看：

- `createVNode`
- `normalizeVNode`
- `isSameVNodeType`
- block tree 相关 API

### 必读 3：`component.ts`

重点看：

- `createComponentInstance`
- `setupComponent`
- `setupStatefulComponent`
- `finishComponentSetup`

### 必读 4：`scheduler.ts`

重点看：

- `queueJob`
- `flushPreFlushCbs`
- `flushPostFlushCbs`
- `nextTick`

### 必读 5：`patchProp.ts + nodeOps.ts + modules/*`

重点看：

- `patchProp`
- `shouldSetAsProp`
- `patchClass`
- `patchStyle`
- `patchEvent`
- `patchDOMProp`
- `patchAttr`

---

## 11. 用一句话总结 Vue 渲染器

Vue 渲染器的本质是：

**以 VNode 为中间层、以 patch 为核心算法、以响应式 effect 为驱动力、以 scheduler 为时序控制、以 host operations 为平台抽象的一套可扩展渲染闭环。**

如果你把这句话里的每个名词都顺着源码读通，Vue 渲染器就真的读懂了。
