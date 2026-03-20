# Vue 总结脑图版

> 文章版请看：[vue-summary.md](./vue-summary.md)

---

## 1. Vue 总体定位

- Vue 的本质
  - 一套连接“声明式状态”和“声明式视图”的系统
  - 不是只靠模板
  - 不是只靠响应式
  - 也不是只靠虚拟 DOM
- 三大核心子系统
  - 响应式系统
    - 解决“谁该重新执行”
  - 编译器系统
    - 解决“模板 / SFC 如何变成运行时代码”
  - 渲染器系统
    - 解决“如何把变化落到宿主环境”

---

## 2. Vue 运行总闭环

- 开发阶段
  - 写 `.vue`
  - 写 `template`
  - 写 `script setup`
  - 写样式
- 编译阶段
  - `compiler-sfc`
    - 拆分 SFC block
    - 处理脚本宏
    - 处理样式与模板入口
  - `compiler-dom`
    - 增加 DOM 平台规则
  - `compiler-core`
    - parse
    - transform
    - generate
- 运行阶段
  - 创建组件实例
  - 执行 render
  - 生成 VNode
  - mount 到 DOM
- 更新阶段
  - 响应式状态变化
  - `trigger`
  - 调度器批量安排更新
  - render 重新执行
  - 生成新 VNode
  - renderer `patch`
  - 最小化更新 DOM

---

## 3. 响应式系统脑图

- 目标
  - 读时收集依赖
  - 写时触发依赖
  - 精确更新
- 入口 API
  - `reactive`
  - `readonly`
  - `ref`
  - `computed`
  - `watch`
  - `effect`
- 核心抽象
  - Proxy Handler
    - 拦截对象/数组/集合的读写
  - `Dep`
    - 某个依赖点的订阅中心
  - `Link`
    - `Dep` 与订阅者的连接结构
  - `ReactiveEffect`
    - 副作用执行器
  - `ComputedRefImpl`
    - 惰性求值
    - 缓存
    - 脏标记
- 核心流程
  - 创建响应式对象/引用
  - getter 触发 `track`
  - setter 触发 `trigger`
  - effect / computed / watch 被调度
  - 重新执行
  - 建立新依赖关系
- 工程价值
  - 精确依赖追踪
  - 批量更新
  - 计算属性缓存
  - watch cleanup
  - effectScope 成组回收

---

## 4. 编译器系统脑图

- 目标
  - 把模板 / SFC 转换成高效的运行时代码
  - 提前给运行时提供优化线索
- 三层结构
  - `compiler-core`
    - 平台无关
    - 模板编译内核
  - `compiler-dom`
    - DOM 平台增强
    - DOM 专属 transform 与规则
  - `compiler-sfc`
    - `.vue` 文件拆块与编排
    - 宏处理
    - 样式编译
- `compiler-core` 主流程
  - `baseParse()`
    - 模板 -> AST
  - `transform()`
    - 改写 AST
    - 收集 helpers
    - 注入优化信息
  - `generate()`
    - AST -> render 函数字符串
- `compiler-sfc` 主职责
  - `parse()`
    - 解析 SFC block
  - `compileScript()`
    - 处理 `defineProps` / `defineEmits` / `defineModel`
  - `compileTemplate()`
    - 调用 DOM/Core 编译链
  - `compileStyle()`
    - scoped
    - CSS vars
    - CSS Modules
- 编译期优化
  - 静态提升
  - patch flags
  - block tree
  - 动态子节点收集
- 本质结论
  - 编译器不只是“翻译”
  - 编译器还是运行时性能的前置优化器

---

## 5. 渲染器系统脑图

- 分层
  - `runtime-core`
    - 平台无关
    - patch / mount / update / unmount 主流程
  - `runtime-dom`
    - DOM 平台实现
    - `nodeOps`
    - `patchProp`
- 核心对象
  - `VNode`
    - 节点类型
    - props
    - children
    - patch flags
    - dynamicChildren
  - 组件实例
    - props
    - slots
    - attrs
    - setupState
    - 生命周期
  - 调度器
    - 批量更新
    - 去重
    - nextTick
- 主流程
  - 首次渲染
    - render -> VNode
    - mount -> DOM
  - 更新渲染
    - render -> 新 VNode
    - `patch(oldVNode, newVNode)`
    - 最小化更新宿主节点
- 关键能力
  - 组件更新
  - 指令
  - 生命周期
  - Teleport
  - Suspense
  - KeepAlive
  - 过渡系统
- 本质结论
  - 渲染器是运行时总协调中心
  - DOM 更新只是它的一部分

---

## 6. 三套系统之间的关系

- 编译器
  - 生成 render 函数
  - 生成优化信息
- 响应式
  - 驱动 render 重新执行
  - 精确找到需要更新的逻辑
- 渲染器
  - 比较新旧 VNode
  - 把变化更新到 DOM

### 关系一句话

- 编译器决定
  - “更新时代码长什么样”
- 响应式决定
  - “什么时候需要更新”
- 渲染器决定
  - “这次更新如何真正落地”

### 真正闭环

- 模板被编译
- render 首次执行建立依赖
- 状态变化触发重新执行
- 新旧 VNode 被 patch
- DOM 被更新

---

## 7. Vue 高性能的来源

- 不是单点优化
- 是体系化优化叠加

### 编译期

- 静态提升
- patch flags
- block tree

### 响应式阶段

- 精确依赖追踪
- computed 缓存
- watch / effect 调度

### 渲染阶段

- scheduler 批量更新
- 精确 patch
- 动态节点优先处理

### 结论

- Vue 的性能来自
  - 编译器
  - 响应式
  - 渲染器
  - 三层协同

---

## 8. Vue 源码最值得学习的设计思想

- 复杂度下沉
  - 用户写法简单
  - 框架内部承担复杂度
- 中间表示驱动协作
  - `SFCDescriptor`
  - AST
  - VNode
  - Component Instance
  - Dep / Link
- 编译时与运行时分工明确
  - 编译时做静态分析
  - 运行时做动态调度与更新
- 平台无关内核 + 平台适配层
  - 编译器如此
  - 渲染器也是如此

---

## 9. 日常写 Vue 的启发

- 模板尽量结构稳定
  - 更利于编译优化
- 理解 `script setup` 是编译期宏
  - 不是普通函数
- 理解依赖收集发生在读取时
  - 没读到就不会追踪
- 理解组件更新本质是 render 重跑
  - 优化重点在依赖粒度与组件边界
- 理解更新是调度后的批量行为
  - 不要用同步 DOM 心智理解 Vue

---

## 10. 推荐阅读路径

- 先读响应式
  - `packages/reactivity/src/reactive.ts`
  - `packages/reactivity/src/baseHandlers.ts`
  - `packages/reactivity/src/dep.ts`
  - `packages/reactivity/src/effect.ts`
  - `packages/reactivity/src/computed.ts`
  - `packages/reactivity/src/watch.ts`
- 再读编译器
  - `packages/compiler-core/src/compile.ts`
  - `packages/compiler-core/src/parser.ts`
  - `packages/compiler-core/src/transform.ts`
  - `packages/compiler-core/src/codegen.ts`
  - `packages/compiler-sfc/src/parse.ts`
  - `packages/compiler-sfc/src/compileScript.ts`
  - `packages/compiler-sfc/src/compileTemplate.ts`
- 最后读渲染器
  - `packages/runtime-dom/src/index.ts`
  - `packages/runtime-core/src/renderer.ts`
  - `packages/runtime-core/src/vnode.ts`
  - `packages/runtime-core/src/component.ts`
  - `packages/runtime-core/src/componentRenderUtils.ts`
  - `packages/runtime-core/src/scheduler.ts`
  - `packages/runtime-dom/src/patchProp.ts`

---

## 11. 最终压缩版结论

- 一句话
  - Vue 是一套通过编译器生成高效 render，通过响应式驱动重算，再由渲染器执行最小化宿主更新的框架
- 三句话
  - 响应式决定什么时候更新
  - 编译器决定更新时代码长什么样
  - 渲染器决定怎么把更新落到 DOM
- 源码视角
  - Vue 最厉害的地方不是某一个单点技术
  - 而是把三套复杂系统组织成了一条前后贯通的完整链路
