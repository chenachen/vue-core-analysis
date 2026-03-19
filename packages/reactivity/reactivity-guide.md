# Vue 3 响应式原理详解（packages/reactivity）

本文基于当前仓库 `packages/reactivity` 源码整理，目标是把 Vue 3 响应式系统从“目录结构、文件职责、函数作用、运行闭环、工程价值、设计亮点”几个层面串起来，帮助你把零散源码理解成一套完整机制。

---

## 1. 先建立总图：Vue 响应式到底在做什么

Vue 3 响应式系统的本质可以概括成一句话：

> **用 Proxy / Ref 包装状态，用依赖收集记录“谁依赖了谁”，在状态变化时按需、按顺序、批量地重新调度 effect / computed / watch。**

核心闭环是：

1. **创建响应式入口**：`reactive` / `readonly` / `ref` / `computed` / `watch`
2. **读取时收集依赖**：`track()` -> `Dep.track()` -> 建立 `Dep <-> Subscriber` 双向关系
3. **写入时触发依赖**：`trigger()` -> `Dep.notify()` -> 批量调度订阅者
4. **订阅者重新执行**：`ReactiveEffect.run()` / `refreshComputed()` / `watch job`
5. **重新读取新值并再次收集依赖**：形成持续闭环

其中最重要的抽象有 5 个：

- **Proxy Handler**：决定对象/数组/集合在读写时如何被拦截
- **Dep**：某个“依赖点”的订阅中心
- **Link**：Dep 与订阅者之间的双向链表节点
- **Subscriber**：订阅者，主要是 `ReactiveEffect` 和 `ComputedRefImpl`
- **ReactiveEffect**：副作用执行器，是 watch / 组件渲染 / 用户 effect 的底层基础

---

## 2. 目录树与每个文件的职责

> 这里不仅列 `src`，也把测试和 benchmark 一并说明，这有助于你理解每个模块被如何验证。

```text
packages/reactivity
├── LICENSE
├── README.md
├── index.js
├── package.json
├── reactivity-guide.md
├── src
│   ├── index.ts
│   ├── constants.ts
│   ├── reactive.ts
│   ├── baseHandlers.ts
│   ├── arrayInstrumentations.ts
│   ├── collectionHandlers.ts
│   ├── dep.ts
│   ├── effect.ts
│   ├── effectScope.ts
│   ├── computed.ts
│   ├── ref.ts
│   ├── watch.ts
│   └── warning.ts
├── __tests__
│   ├── reactive.spec.ts
│   ├── reactiveArray.spec.ts
│   ├── readonly.spec.ts
│   ├── shallowReactive.spec.ts
│   ├── shallowReadonly.spec.ts
│   ├── ref.spec.ts
│   ├── computed.spec.ts
│   ├── effect.spec.ts
│   ├── effectScope.spec.ts
│   ├── watch.spec.ts
│   ├── gc.spec.ts
│   └── collections
│       ├── Map.spec.ts
│       ├── Set.spec.ts
│       ├── WeakMap.spec.ts
│       ├── WeakSet.spec.ts
│       └── shallowReadonly.spec.ts
└── __benchmarks__
    ├── reactiveObject.bench.ts
    ├── reactiveArray.bench.ts
    ├── reactiveMap.bench.ts
    ├── ref.bench.ts
    ├── effect.bench.ts
    └── computed.bench.ts
```

### `src` 每个文件的作用

- **index.ts**：统一导出响应式 API，是 `@vue/reactivity` 的公共入口。
- **constants.ts**：定义追踪类型、触发类型、响应式标记位等常量枚举。
- **reactive.ts**：对象代理入口，负责创建/缓存 `reactive`、`readonly`、`shallowReactive`、`shallowReadonly`。
- **baseHandlers.ts**：普通对象/数组的 Proxy handler。
- **arrayInstrumentations.ts**：专门重写数组方法，解决 includes/indexOf、迭代、变更方法与依赖追踪之间的细节问题。
- **collectionHandlers.ts**：Map/Set/WeakMap/WeakSet 的 handler 与方法劫持逻辑。
- **dep.ts**：依赖中心；定义 `Dep`、`Link`、`track`、`trigger`。
- **effect.ts**：副作用系统核心；定义 `ReactiveEffect`、批处理、脏检查、computed 刷新。
- **effectScope.ts**：作用域系统，让一组 effect/computed/watch 可以被成组销毁。
- **computed.ts**：计算属性实现，核心特性是“惰性求值 + 缓存 + 脏标记”。
- **ref.ts**：`ref` 家族 API，以及 `toRef` / `toRefs` / `proxyRefs` / `customRef`。
- **watch.ts**：`watch` / `watchEffect` / 深度遍历 / cleanup 机制。
- **warning.ts**：开发环境警告输出。

### `__tests__` 的价值

- 普通对象、数组、Map/Set、ref、computed、watch、effectScope 都有专门测试。
- 这些测试本身就是理解源码的“行为规格说明书”。
- 你在阅读源码时，如果某个分支不明白，优先找对应 spec。

### `__benchmarks__` 的价值

- 展示 Vue 团队不仅关注正确性，也持续关注性能。
- 这能帮助你理解为什么源码里大量使用：
  - `WeakMap`
  - 双向链表
  - `globalVersion`
  - `DIRTY / NOTIFIED / TRACKING` 位标记
  - 惰性订阅与批处理

---

## 3. 从 API 入口看整体分层

从调用层次看，可以把响应式系统拆成四层：

### 第 1 层：用户 API

- `reactive`
- `readonly`
- `ref`
- `computed`
- `watch`
- `effect`

### 第 2 层：代理与包装层

- `baseHandlers.ts`
- `arrayInstrumentations.ts`
- `collectionHandlers.ts`
- `RefImpl`
- `ComputedRefImpl`

### 第 3 层：依赖图层

- `targetMap: WeakMap<object, Map<key, Dep>>`
- `Dep`
- `Link`

### 第 4 层：调度执行层

- `ReactiveEffect`
- `batch/startBatch/endBatch`
- `refreshComputed`
- `watch` 的 `job`

理解源码时，建议一直带着一句话：

> **任何响应式功能，最终都要落到“谁在读 -> 记录依赖；谁在写 -> 触发依赖”。**

---

## 4. 文件级详解：每个函数/类在做什么

> 这里按源码文件顺序展开，尽量覆盖每个重要函数与类。

---

## 4.1 `src/index.ts`

它本身没有业务逻辑，作用是**把各模块导出的 API 聚合为公开接口**。

### 导出内容

- `ref`、`shallowRef`、`isRef`、`toRef`、`toRefs`、`proxyRefs`、`customRef`、`triggerRef`
- `reactive`、`readonly`、`shallowReactive`、`shallowReadonly`、`markRaw`、`toRaw`
- `computed`
- `effect`、`stop`、`pauseTracking`、`enableTracking`、`resetTracking`
- `track`、`trigger`、迭代 key 常量
- `effectScope`、`getCurrentScope`、`onScopeDispose`
- `watch`、`traverse`、`onWatcherCleanup`

**理解价值**：看 `index.ts` 就知道这个包暴露了哪些“稳定对外能力”。

---

## 4.2 `src/constants.ts`

这个文件很小，但很关键。

### 主要内容

- **`TrackOpTypes`**：依赖收集的操作类型，如 `GET`、`HAS`、`ITERATE`
- **`TriggerOpTypes`**：触发更新的操作类型，如 `SET`、`ADD`、`DELETE`、`CLEAR`
- **`ReactiveFlags`**：响应式对象/Ref/Readonly/Shallow/Raw/Skip 等内部标记位

### 作用

这些常量贯穿所有模块：

- handler 用它们区分当前是“读取、判断存在、遍历”还是“新增、修改、删除”
- `isReactive` / `isReadonly` / `toRaw` 依赖这些 flag 工作
- 调试 hooks `onTrack` / `onTrigger` 也依赖这些类型输出更准确的信息

---

## 4.3 `src/reactive.ts`

这是“对象响应式入口层”。

### 核心数据结构

#### `reactiveMap / shallowReactiveMap / readonlyMap / shallowReadonlyMap`

四个 `WeakMap`，作用是：

- 缓存 **原对象 -> 代理对象** 的映射
- 保证同一个原对象在同一种模式下只代理一次
- 避免重复创建 Proxy

这也是 `reactive(obj) === reactive(obj)` 成立的原因。

### 主要函数

#### `targetTypeMap(rawType)`

根据原始类型字符串判断对象属于哪一类：

- `Object` / `Array` -> `COMMON`
- `Map` / `Set` / `WeakMap` / `WeakSet` -> `COLLECTION`
- 其他 -> `INVALID`

**实现意义**：对象/数组和集合类型不能共用同一套 handler，因为集合类型依赖方法劫持。

#### `getTargetType(value)`

判断一个值是否值得被代理：

- 被 `markRaw` 标记，直接跳过
- 不可扩展对象，直接跳过
- 否则按 `toRawType` 分类

#### `reactive(target)`

创建深层可变响应式代理。

关键点：

- 如果传入的是 readonly proxy，直接返回它
- 最终走 `createReactiveObject(..., false, mutableHandlers, mutableCollectionHandlers, reactiveMap)`

#### `shallowReactive(target)`

只代理第一层属性。

关键点：

- 根属性是响应式的
- 嵌套对象不继续递归转代理
- ref 不自动深度解包

#### `readonly(target)`

创建深层只读代理。

关键点：

- 仍然会收集依赖，保证“读”能跟随底层源值更新
- 只是屏蔽外部直接写入

#### `shallowReadonly(target)`

只让第一层只读，内部嵌套对象保持原样。

#### `createReactiveObject(target, isReadonly, baseHandlers, collectionHandlers, proxyMap)`

这是本文件最关键的工厂函数。

它做了几件事：

1. **非对象直接返回**
2. **若已经是 Vue Proxy，通常直接复用**
   - 但 `readonly(reactive(obj))` 是例外，需要再套一层 readonly proxy
3. **判断目标类型是否允许代理**
4. **从 WeakMap 缓存中取已有代理**
5. **创建 Proxy 并缓存**

#### `isReactive(value)`

判断是否是 reactive/shallowReactive 创建的代理。

特殊点：

- 如果传入 readonly(proxy)，会继续递归看它的 `RAW` 是否为 reactive

#### `isReadonly(value)`

判断值是否为只读对象，或只读 computed。

#### `isShallow(value)`

判断值是否为浅层响应式/浅层只读/浅层 ref。

#### `isProxy(value)`

判断值是不是 Vue 创建的代理对象。

#### `toRaw(observed)`

递归返回最原始对象。

用途：

- 比较原值
- 避免代理身份影响逻辑
- 在某些优化场景下跳过追踪

#### `markRaw(value)`

给对象打上 `SKIP` 标记，让它永远不被转成响应式代理。

前端实践里很常见：

- 三方类实例
- 大对象缓存
- DOM / 图表实例
- 不需要响应式的大型静态配置

#### `toReactive(value)`

如果是对象就转 `reactive`，否则原样返回。

#### `toReadonly(value)`

如果是对象就转 `readonly`，否则原样返回。

---

## 4.4 `src/baseHandlers.ts`

这是普通对象与数组的 Proxy handler。

### 顶层辅助内容

#### `isNonTrackableKeys`

列出不应该参与依赖追踪的 key，比如：

- `__proto__`
- `__v_isRef`
- `__isVue`

#### `builtInSymbols`

收集内置 Symbol，例如：

- `Symbol.iterator`
- `Symbol.toStringTag`

这些 key 不应该触发普通依赖追踪，否则会引入很多无意义依赖。

#### `hasOwnProperty(key)`

自定义 `hasOwnProperty` 劫持：

- 调用原始对象的 `hasOwnProperty`
- 同时为该 key 建立 `HAS` 类型依赖

### 类：`BaseReactiveHandler`

#### `get(target, key, receiver)`

这是最核心的读取拦截逻辑。

它依次处理：

1. **内部标记位读取**
   - `IS_REACTIVE`
   - `IS_READONLY`
   - `IS_SHALLOW`
   - `RAW`
2. **数组方法替换**
   - 如果是数组，返回 `arrayInstrumentations` 中重写后的方法
3. **`hasOwnProperty` 劫持**
4. **`Reflect.get` 取值**
   - 对 ref/computed 使用特殊 receiver，修正 `this` 指向
5. **跳过无意义追踪的 key**
6. **执行 `track(target, GET, key)`**
7. **浅层代理直接返回**
8. **ref 自动解包**
   - 但数组索引位置不自动解包
9. **对象递归代理**
   - `readonly` 下递归 `readonly`
   - 否则递归 `reactive`

### 类：`MutableReactiveHandler`

#### `set(target, key, value, receiver)`

写入拦截逻辑：

1. 记录旧值
2. 深层模式下做 `toRaw` 对齐比较
3. 若旧值是 ref、新值不是 ref，则直接写 `oldRef.value`
4. 判断本次是 `ADD` 还是 `SET`
5. `Reflect.set`
6. 只有当 `target === toRaw(receiver)` 时才触发依赖
   - 避免原型链上层级混淆造成重复触发
7. 根据情况调用 `trigger(..., ADD)` 或 `trigger(..., SET)`

#### `deleteProperty(target, key)`

- 记录是否存在旧值
- 删除成功后触发 `DELETE`

#### `has(target, key)`

- 执行 `Reflect.has`
- 除内置 Symbol 外，为 `in` 操作建立 `HAS` 依赖

#### `ownKeys(target)`

- 为 `for...in` / `Object.keys` / 数组长度等迭代场景建立 `ITERATE` 依赖
- 数组用 `length` 作为特殊 key

### 类：`ReadonlyReactiveHandler`

#### `set(target, key)`

开发环境下警告，然后返回 `true`，表示写入失败但不中断程序。

#### `deleteProperty(target, key)`

同理，对只读对象删除属性会警告。

### 导出 handler 实例

- `mutableHandlers`
- `readonlyHandlers`
- `shallowReactiveHandlers`
- `shallowReadonlyHandlers`

---

## 4.5 `src/arrayInstrumentations.ts`

这个文件专门处理数组，因为数组是“对象语义 + 特殊方法语义”的混合体。

### 主要函数

#### `reactiveReadArray(array)`

- 返回原始数组
- 同时为数组迭代行为收集依赖
- 若不是 shallow，则把元素转成 reactive

#### `shallowReadArray(arr)`

- 为数组迭代建立依赖
- 但元素不继续转 reactive

#### `iterator(self, method, wrapValue)`

封装数组迭代器方法（如 `entries` / `values` / `keys`）

作用：

- 在迭代开始时建立迭代依赖
- 对返回值做浅/深包装

#### `apply(self, method, fn, thisArg, wrappedRetFn, args)`

统一处理很多数组高阶方法，如：

- `map`
- `filter`
- `find`
- `some`
- `every`
- `forEach`

作用：

- 正确地为迭代建立依赖
- 在回调中把元素包装成期望的响应式形式

#### `reduce(self, method, fn, args)`

统一处理 `reduce` / `reduceRight`。

#### `searchProxy(self, method, args)`

处理：

- `includes`
- `indexOf`
- `lastIndexOf`

这是数组代理里非常关键的兼容逻辑。

原因：

- 数组里存的可能是 raw
- 查询参数传进来的可能是 proxy
- 或反过来

所以它会先按当前值查一遍，查不到再把参数 `toRaw` 后再查一遍。

#### `noTracking(self, method, args)`

处理会修改 length 的数组方法，如：

- `push`
- `pop`
- `shift`
- `unshift`
- `splice`

作用：

- 在执行这些方法时暂时关闭追踪
- 避免因为 length 访问与写入相互嵌套，产生多余依赖或死循环
- 同时利用批处理减少重复触发

### `arrayInstrumentations` 对象

它重写了大量数组方法，核心目标只有两个：

1. **读的时候正确 track**
2. **写的时候正确 trigger 且避免错误递归**

---

## 4.6 `src/collectionHandlers.ts`

Map/Set 系列和普通对象完全不是一回事，所以 Vue 专门为它们写了一套拦截逻辑。

### 辅助函数

#### `toShallow(value)`

浅层模式下直接返回值。

#### `getProto(v)`

获取集合对象原型，方便调用原始方法。

#### `createIterableMethod(method, isReadonly, isShallow)`

统一封装集合迭代方法：

- `keys`
- `values`
- `entries`
- `Symbol.iterator`

职责：

- 建立 `ITERATE` / `MAP_KEY_ITERATE_KEY` 依赖
- 对迭代产出的值做 `toReactive` / `toReadonly` / `toShallow`

#### `createReadonlyMethod(type)`

为只读集合创建写操作占位方法：

- `add`
- `set`
- `delete`
- `clear`

只读模式下这些方法只警告，不真正修改。

#### `createInstrumentations(isReadonly, shallow)`

整个文件的核心工厂。

会创建一组适用于某种模式（mutable/readonly/shallow）的集合方法实现，包括：

- `get`
- `get size`
- `has`
- `forEach`
- `add`
- `set`
- `delete`
- `clear`
- 迭代器方法

### `createInstrumentationGetter(isReadonly, shallow)`

返回集合类型 Proxy 的 `get` trap。

核心逻辑：

- 读取内部 flag 时返回对应状态
- 其他 key 优先从“重写后的 instrumentation 对象”取
- 否则退回原目标对象

### `checkIdentityKeys(target, has, key)`

处理 `Map`/`Set` 中 raw key 与 proxy key 混用的情况。

这是集合源码里很重要的细节：

- `map.set(rawObj, 1)`
- 再 `map.get(proxyObj)`

如果不特别处理，就会出现逻辑歧义。

### 导出 handler

- `mutableCollectionHandlers`
- `readonlyCollectionHandlers`
- `shallowCollectionHandlers`
- `shallowReadonlyCollectionHandlers`

---

## 4.7 `src/dep.ts`

这是依赖图的中心。

### 全局变量：`globalVersion`

每次响应式变更时递增。

**作用**：给 computed 一个快速路径——如果自上次求值后全局版本没变，就可以跳过很多检查。

### 类：`Link`

Link 是 Dep 与订阅者之间的连接节点。

它同时属于两条双向链表：

- `sub.deps`：某个订阅者依赖了哪些 dep
- `dep.subs`：某个 dep 被哪些订阅者订阅

#### `version`

- effect/computed 每次重新执行前，把旧 link 的 `version` 设为 `-1`
- 执行过程中若再次访问该 dep，就把 `version` 同步回 dep 当前版本
- 执行结束后仍为 `-1` 的 link 代表“这次没再用到”，需要清理

这是 Vue 3.5 当前依赖清理机制的关键设计。

### 类：`Dep`

一个 Dep 可以理解为：**“某个依赖点的订阅中心”**。

例如：

- `target.foo`
- 数组 length
- 对象迭代
- Map 的 key 迭代
- ref.value
- computed.value

都可能对应一个 Dep。

#### 关键字段

- `version`：该 dep 当前版本号
- `activeLink`：当前活跃订阅者与该 dep 的 link
- `subs`：订阅者链表尾
- `subsHead`：开发环境下的头节点，保证 onTrigger 顺序
- `map` / `key`：用于属性依赖的回收
- `sc`：订阅者数量
- `computed`：若此 dep 属于 computed，则关联对应 computed 实例

#### `track(debugInfo?)`

依赖收集核心函数。

流程：

1. 没有 `activeSub` 时直接退出
2. 若当前 dep 对当前订阅者还没有 link，则新建 `Link`
3. 把 link 挂到订阅者的 deps 链表尾部
4. 再把 link 挂到 dep 的 subs 链表尾部
5. 若是旧 link 且 `version === -1`，复用旧 link 并移动到 deps 链表尾部
6. 开发环境下触发 `onTrack`

#### `trigger(debugInfo?)`

- `version++`
- `globalVersion++`
- 调用 `notify()`

#### `notify(debugInfo?)`

- 进入批处理
- 先按正序触发调试 `onTrigger`
- 再倒序遍历订阅者，调用 `sub.notify()`
- 若订阅者是 computed，会额外触发 computed 自己那个 `dep.notify()`
- 最后结束批处理

### 函数：`addSub(link)`

把某个 link 加入 dep 的订阅链表。

特殊逻辑：

- 如果 dep 属于 computed，且这是 computed 第一次拥有订阅者
- 会把 computed 置为 `TRACKING | DIRTY`
- 然后递归把 computed 对其所有依赖的订阅关系补齐

这体现了 computed 的**惰性订阅**思想：

- 没人读 computed 时，不需要真正把它挂到所有上游 dep 上
- 有人订阅它了，再建立完整链路

### `targetMap`

```ts
WeakMap<object, Map<key, Dep>>
```

这是整个响应式依赖索引表。

### 依赖 key 常量

- `ITERATE_KEY`
- `MAP_KEY_ITERATE_KEY`
- `ARRAY_ITERATE_KEY`

它们代表的不是“属性名”，而是“某种迭代依赖”。

### `track(target, type, key)`

全局依赖收集入口。

流程：

1. 通过 `targetMap` 找到目标对象的 depsMap
2. 再通过 key 找到某个 dep
3. 没有就创建
4. 调用 `dep.track()`

### `trigger(target, type, key, newValue, oldValue, oldTarget)`

全局触发入口。

会根据操作类型和 key 决定该唤醒哪些 dep：

- 精确属性 dep
- 数组 length dep
- 数组迭代 dep
- 对象迭代 dep
- Map key 迭代 dep
- clear 时整个 depsMap 全部 dep

这是“为什么 `obj.foo = 1` 只更新相关 effect，而不是全量更新”的根源。

### `getDepFromReactive(object, key)`

从 `targetMap` 中读出某个属性已有的 dep。

主要给 `toRef` / `triggerRef` 这类场景复用。

---

## 4.8 `src/effect.ts`

这是响应式执行层核心。

### 全局变量

#### `activeSub`

当前正在执行依赖收集的订阅者：

- 可能是 `ReactiveEffect`
- 也可能是 `ComputedRefImpl`

谁在执行，谁就是“当前读到的 dep 应该挂到谁身上”。

### `EffectFlags`

位标记非常关键：

- `ACTIVE`：是否活跃
- `RUNNING`：是否正在执行
- `TRACKING`：是否需要追踪依赖
- `NOTIFIED`：当前批处理中是否已经入队
- `DIRTY`：是否需要重新计算
- `ALLOW_RECURSE`：是否允许递归触发
- `PAUSED`：是否暂停
- `EVALUATED`：computed 是否至少求值过一次

### 接口：`Subscriber`

订阅者统一抽象，要求具备：

- `deps / depsTail`
- `flags`
- `next`
- `notify()`

这样 `ReactiveEffect` 与 `ComputedRefImpl` 才能共用 dep 机制。

### 类：`ReactiveEffect`

这是最核心的执行器。

#### `constructor(fn)`

- 保存副作用函数
- 若当前有活跃 `effectScope`，自动收集到作用域里

#### `pause()` / `resume()`

- 暂停 effect 响应
- 恢复时若暂停期间有触发过，会补执行一次

#### `notify()`

- effect 被 dep 通知时调用
- 若正在运行且不允许递归，则忽略
- 否则通过 `batch(this)` 入批处理队列

#### `run()`

整个响应式执行流程的核心：

1. 非活跃 effect 直接执行 fn，不做依赖逻辑
2. 标记 `RUNNING`
3. 执行 cleanup
4. `prepareDeps(this)`：把旧 link 版本重置为 `-1`
5. 切换 `activeSub = this`
6. 打开 `shouldTrack`
7. 执行用户函数 `fn()`
8. `cleanupDeps(this)`：移除本轮未访问的旧依赖
9. 恢复 `activeSub` 和追踪状态
10. 清除 `RUNNING`

#### `stop()`

- 从所有依赖中解除订阅
- 清空 dep 链表
- 执行 cleanup / onStop
- 关闭 ACTIVE 标记

#### `trigger()`

- 若暂停，则仅记录到暂停队列
- 有 scheduler 则走 scheduler
- 否则直接 `runIfDirty()`

#### `runIfDirty()`

脏了才运行。

#### `dirty getter`

通过 `isDirty(this)` 判断是否需要重新执行。

### 批处理相关

#### `batch(sub, isComputed = false)`

把订阅者加入批处理链表，并打上 `NOTIFIED` 标记。

Vue 分两条链：

- `batchedComputed`
- `batchedSub`

目的是把 computed 与普通 effect 分开处理。

#### `startBatch()`

批处理深度 `+1`。

#### `endBatch()`

当最外层批处理结束时：

1. 先把 computed 队列的 `NOTIFIED` 标记清掉
2. 再执行普通 effect 队列
3. 若中间出错，最后统一抛错

### 依赖准备与清理

#### `prepareDeps(sub)`

- 遍历订阅者当前 deps 链表
- 把每个 link.version 设为 `-1`
- 保存 `dep.activeLink` 旧值到 `prevActiveLink`
- 设置当前 dep.activeLink

#### `cleanupDeps(sub)`

- 从尾到头遍历 deps 链表
- `version === -1` 的 link 说明本轮没再访问，需要删除
- 恢复 `dep.activeLink`
- 重建新的头尾指针

这套设计比“每次先全量清空再重建 Set”更节省分配与遍历成本。

### `isDirty(sub)`

逐个检查依赖 link：

- `dep.version !== link.version` 说明上游变了
- 如果 dep 属于 computed，还会递归 `refreshComputed`

### `refreshComputed(computed)`

computed 刷新核心，后面单独讲 computed 时还会串起来。

它主要做：

1. 若正在 tracking 且不脏，则跳过
2. 清除 DIRTY
3. 利用 `globalVersion` 做快速跳过
4. 非 SSR 且已评估且依赖未变时，直接复用缓存
5. 否则切换 `activeSub = computed`
6. `prepareDeps(computed)`
7. 执行 computed getter
8. 若值变化则更新 `_value` 与 `dep.version`
9. `cleanupDeps(computed)`
10. 恢复状态

### 删除关系相关

#### `removeSub(link, soft = false)`

从 dep 的订阅链表中移除 link。

特殊逻辑：

- 如果 dep 属于 computed，且 computed 已无任何外部订阅者
- 会把 computed 从它所有上游 dep 里“软取消订阅”
- 让 computed 有机会被 GC

#### `removeDep(link)`

从订阅者自身 deps 链表中移除 link。

### 顶层 API

#### `effect(fn, options?)`

- 若 `fn` 已是 effect runner，则取其原始 fn
- 创建 `ReactiveEffect`
- 合并 options
- 立即执行一次 `run()`
- 返回 runner，并把 effect 挂到 runner.effect 上

#### `stop(runner)`

停止 effect。

#### `pauseTracking()` / `enableTracking()` / `resetTracking()`

临时控制全局是否允许收集依赖。

常用于：

- cleanup 阶段
- 某些数组变异方法内部

#### `onEffectCleanup(fn, failSilently = false)`

给当前 active effect 注册 cleanup。

#### `cleanupEffect(e)`

实际执行 cleanup 时的内部函数。

---

## 4.9 `src/effectScope.ts`

这是 effect 的生命周期管理层。

### 全局变量：`activeEffectScope`

当前活跃作用域。

### 类：`EffectScope`

#### 字段职责

- `effects`：该作用域内创建的 effect 列表
- `cleanups`：手动注册的清理函数
- `parent`：父作用域
- `scopes`：子作用域数组
- `_active`：是否活跃
- `_isPaused`：是否暂停
- `detached`：是否与父作用域脱离

#### `active getter`

返回作用域是否活跃。

#### `pause()`

暂停当前作用域内所有 effect 和子作用域。

#### `resume()`

恢复当前作用域内所有 effect 和子作用域。

#### `run(fn)`

临时把当前作用域设为 `activeEffectScope`，执行 `fn`，结束后恢复现场。

#### `on()` / `off()`

内部 API，用于成对切换活跃作用域状态。

#### `stop(fromParent?)`

- 停止本作用域内所有 effect
- 执行所有 cleanup
- 递归停止子作用域
- 从父作用域的 scopes 数组中 O(1) 移除自己

### 顶层函数

#### `effectScope(detached?)`

创建一个新的作用域对象。

#### `getCurrentScope()`

返回当前活跃作用域。

#### `onScopeDispose(fn, failSilently = false)`

向当前作用域注册销毁回调。

**实际开发价值非常高**：组合式函数里统一释放事件、定时器、监听器都很好用。

---

## 4.10 `src/computed.ts`

computed 是 Vue 响应式里最能体现“惰性 + 缓存 + 精准通知”的模块。

### 接口与类型

- `ComputedRef<T>`：只读计算属性
- `WritableComputedRef<T, S>`：可写计算属性
- `ComputedGetter<T>`：getter
- `ComputedSetter<T>`：setter
- `WritableComputedOptions<T, S>`：`{ get, set }`

### 类：`ComputedRefImpl`

computed 既是一个 ref，也是一个 subscriber。

#### 关键字段

- `_value`：缓存值
- `dep`：依赖“这个 computed.value 的订阅者集合”
- `deps / depsTail`：这个 computed 自己依赖了哪些上游 dep
- `flags`：脏标记、是否 tracking、是否运行中等
- `globalVersion`：上次同步的全局版本
- `isSSR`：SSR 特殊逻辑开关
- `fn`：getter
- `setter`：可选 setter

#### `notify()`

computed 上游依赖变化时调用。

作用：

1. 把自己标记为 `DIRTY`
2. 如果还没被批处理入队，则 `batch(this, true)`
3. 避免在自身求值过程中递归通知自己

#### `get value()`

computed 真正的读取入口。

顺序非常重要：

1. `this.dep.track()`
   - 收集“谁依赖了这个 computed”
2. `refreshComputed(this)`
   - 惰性刷新，按需重算
3. 同步 `link.version`
4. 返回缓存 `_value`

#### `set value(newValue)`

- 有 setter 则调用 setter
- 没 setter 则在开发环境警告

### 顶层函数：`computed(getterOrOptions, debugOptions?, isSSR = false)`

根据传参类型创建只读或可写 computed：

- 若传函数，getter-only
- 若传对象，取 `get` 与 `set`
- 创建 `ComputedRefImpl`
- 开发环境可挂调试钩子

### computed 的实现原理总结

computed 的核心不是“每次依赖变了就立刻重新计算”，而是：

- 依赖变了 -> **先标脏**
- 真正有人读 `.value` -> **再重新计算**
- 如果全局版本和依赖版本都没变 -> **直接复用缓存**

这就是它比普通方法更高效的本质。

---

## 4.11 `src/ref.ts`

ref 是“值级别响应式”的核心实现。

### 接口与类型

- `Ref<T, S>`：标准 ref 接口
- `ShallowRef<T, S>`：浅层 ref
- `MaybeRef` / `MaybeRefOrGetter`
- `ToRef` / `ToRefs`
- `UnwrapRef` / `UnwrapRefSimple`

### 函数与类

#### `isRef(r)`

通过内部 flag 判断一个值是否为 ref。

#### `ref(value?)`

创建深层 ref。

#### `shallowRef(value?)`

创建浅层 ref。

#### `createRef(rawValue, shallow)`

- 若已经是 ref，则直接返回
- 否则创建 `RefImpl`

#### 类：`RefImpl`

##### 字段

- `_rawValue`：原始值，用于变更比较
- `_value`：对外暴露值；深 ref 时会被 `toReactive`
- `dep`：订阅 `ref.value` 的依赖中心

##### `get value()`

- 读取时对 `value` 建立依赖
- 返回 `_value`

##### `set value(newValue)`

- 对新值按 shallow/readonly/raw 规则处理
- 用 `hasChanged` 比较新旧值
- 更新 `_rawValue` / `_value`
- 触发 `dep.trigger()`

#### `triggerRef(ref)`

手动触发 ref 的依赖。

典型场景：

- `shallowRef` 内部对象被深层修改后，希望手动通知外界更新

#### `unref(ref)`

- 是 ref 就返回 `.value`
- 否则原样返回

#### `toValue(source)`

把“值 / ref / getter”统一转成值。

#### `shallowUnwrapHandlers`

`proxyRefs` 的底层代理逻辑：

- 读：顶层 ref 自动解包
- 写：若旧值是 ref 且新值不是 ref，则写回 `oldRef.value`

#### `proxyRefs(objectWithRefs)`

对对象做一层“模板式 ref 自动解包”。

常见于组件 setup 返回值。

#### 类型：`CustomRefFactory<T>`

约定 `customRef` 工厂函数签名。

#### 类：`CustomRefImpl`

- 内部维护 `dep`
- 把 `track` / `trigger` 交给用户工厂决定
- 用户可自定义追踪与触发时机

#### `customRef(factory)`

创建自定义 ref。

非常适合：

- 防抖输入
- 节流更新
- 延迟提交

#### `toRefs(object)`

把一个 reactive 对象的每个属性都转成 `toRef`。

作用：

- 避免解构 reactive 时丢失响应式

#### 类：`ObjectRefImpl`

把 `source[key]` 包装成一个 ref 视图。

##### `get value()`

读取源对象属性，必要时使用默认值。

##### `set value(newVal)`

写回源对象属性。

##### `get dep()`

返回源对象该 key 已存在的 dep（若有）。

#### 类：`GetterRefImpl`

把 getter 函数包装成只读 ref。

- 每次读 `.value` 都实时执行 getter
- 不做 computed 那种缓存

#### `toRef(source, key?, defaultValue?)`

非常重要的归一化 API：

- 传 ref -> 原样返回
- 传 getter -> 返回 `GetterRefImpl`
- 传对象 + key -> 返回 `ObjectRefImpl`
- 传普通值 -> 返回 `ref(value)`

#### `propertyToRef(source, key, defaultValue?)`

- 如果源属性本来就是 ref，直接复用
- 否则创建 `ObjectRefImpl`

### 这一文件对业务开发最实用的点

- 解构 reactive 前优先 `toRef/toRefs`
- 大对象或第三方实例优先考虑 `shallowRef`
- 复杂输入节流/防抖可用 `customRef`
- setup 返回值若包含多个 ref，可用 `proxyRefs` 思路理解模板自动解包

---

## 4.12 `src/watch.ts`

watch 建立在 `ReactiveEffect` 之上，但比 effect 多了：

- oldValue / newValue
- cleanup
- deep traverse
- immediate / once / scheduler

### 类型与常量

#### `WatchErrorCodes`

watch 内部错误分类：

- `WATCH_GETTER`
- `WATCH_CALLBACK`
- `WATCH_CLEANUP`

#### `WatchEffect`

`watchEffect` 形式的函数签名。

#### `WatchSource<T>`

watch 可接受的数据源类型：

- ref
- computed
- getter

#### `WatchCallback<V, OV>`

watch 回调签名。

#### `WatchOptions`

支持：

- `immediate`
- `deep`
- `once`
- `scheduler`
- `onWarn`
- `onTrack`
- `onTrigger`
- `augmentJob`
- `call`

#### `cleanupMap`

`WeakMap<ReactiveEffect, cleanupFns[]>`

存储某个 watcher effect 对应的 cleanup 列表。

#### `activeWatcher`

当前活跃 watcher，用于 `onWatcherCleanup()` 绑定 cleanup。

### 函数

#### `getCurrentWatcher()`

返回当前 active watcher。

#### `onWatcherCleanup(cleanupFn, failSilently = false, owner = activeWatcher)`

向当前 watcher 注册清理函数。

#### `watch(source, cb?, options = EMPTY_OBJ)`

本文件核心。

主要流程：

1. 解析 options
2. 根据 source 类型创建 `getter`
   - ref -> 读 `.value`
   - reactive -> `reactiveGetter`
   - array -> 多源 map
   - function + cb -> 普通 watch getter
   - function 无 cb -> `watchEffect`
3. 若 `deep`，则外层再包一层 `traverse`
4. 创建 `watchHandle`
5. 处理 `once`
6. 初始化 `oldValue`
7. 定义 `job`
8. 创建 `ReactiveEffect(getter)`
9. 配置 scheduler
10. 配置 cleanup 绑定
11. 执行首次运行逻辑
12. 返回带 `pause/resume/stop` 的句柄

#### `reactiveGetter(source)`（watch 内部）

- `deep === true`：原值返回，后续再 traverse
- `deep === false | 0` 或 shallow：只遍历一层
- 未显式 deep 且 source 是 reactive：默认深遍历

#### `job(immediateFirstRun?)`（watch 内部）

watch 的真正调度任务。

若有 `cb`：

- `effect.run()` 先求出 `newValue`
- 再按 `deep / forceTrigger / hasChanged` 判断是否真的回调
- 回调前先执行 cleanup
- 回调参数包括 `newValue / oldValue / boundCleanup`
- 然后刷新 `oldValue`

若无 `cb`：

- 这就是 `watchEffect`
- 直接 `effect.run()` 即可

#### `traverse(value, depth = Infinity, seen?)`

深度侦听底层关键函数。

作用：

- 递归读取对象内部所有可达属性
- 从而触发这些属性的 getter，建立依赖
- 用 `seen` 避免循环引用死递归
- 支持 depth 限制

支持遍历：

- ref
- array
- set/map
- plain object
- symbol key

### watch 与 watchEffect 的底层区别

- `watch(source, cb)`：显式指定监听源，比较新旧值，再决定回调
- `watchEffect(fn)`：直接执行副作用，fn 内读取到什么就监听什么

---

## 4.13 `src/warning.ts`

只有一个函数：

#### `warn(msg, ...args)`

统一输出开发环境警告。

虽然简单，但好处是：

- 让各模块不直接依赖 `console.warn` 细节
- 后续若需替换行为，集中处理即可

---

## 5. 这些模块如何串起来形成闭环

下面用三个最重要的链路，把整个响应式系统串起来。

---

## 5.1 链路一：`reactive + effect`

```ts
const state = reactive({ count: 0 })
effect(() => {
  console.log(state.count)
})
state.count++
```

### 第一次执行

1. `reactive()` 创建 Proxy
2. `effect()` 创建 `ReactiveEffect` 并立刻 `run()`
3. `run()` 时把 `activeSub` 设为当前 effect
4. 读取 `state.count`
5. 命中 `baseHandlers.get`
6. `track(stateRaw, GET, 'count')`
7. `targetMap -> depsMap -> dep`
8. `dep.track()` 建立 `dep <-> effect` 的双向 Link
9. effect 执行结束

### 更新时

1. `state.count++`
2. 命中 `baseHandlers.set`
3. `trigger(stateRaw, SET, 'count', newValue, oldValue)`
4. 找到对应 dep
5. `dep.notify()`
6. 当前 effect 被 `batch()` 入队
7. 批处理结束时执行 effect.trigger()
8. effect.runIfDirty() -> run()
9. effect 再次读取 `state.count`
10. 输出新值，并重新校正依赖

这就是最基础闭环。

---

## 5.2 链路二：`reactive + computed + effect`

```ts
const state = reactive({ count: 1 })
const double = computed(() => state.count * 2)
effect(() => {
  console.log(double.value)
})
state.count++
```

### 首次读取 `double.value`

1. effect 运行，读取 `double.value`
2. `ComputedRefImpl.get value()` 先收集“外层 effect 对 computed 的依赖”
3. `refreshComputed(double)` 开始计算
4. 把 `activeSub` 切到 computed
5. 执行 getter，读取 `state.count`
6. `state.count` 的 dep 记录“computed 依赖了它”
7. 计算出结果，缓存到 `double._value`
8. effect 得到返回值，完成首轮渲染

### 当 `state.count++`

1. `state.count` 的 dep 被触发
2. 它通知 computed：`computed.notify()`
3. computed 只把自己标记为 `DIRTY`，并入批处理队列
4. computed 自己的 `dep.notify()` 再通知依赖它的外层 effect
5. 外层 effect 下一轮执行时再次读取 `double.value`
6. 因为 computed 已脏，`refreshComputed()` 重新求值
7. effect 拿到新缓存值

**关键理解**：

- computed 不是“依赖一变立刻算”
- 而是“依赖一变先标脏，真正读取时再算”

---

## 5.3 链路三：`watch`

```ts
const state = reactive({ count: 0 })
watch(
  () => state.count,
  (n, o, onCleanup) => {
    onCleanup(() => {
      // 清理副作用
    })
  },
)
```

### 建立监听

1. `watch()` 根据 source 生成 getter
2. 创建 `ReactiveEffect(getter)`
3. 首次 `effect.run()` 读取 `state.count`
4. `state.count` 建立到 watcher effect 的依赖关系
5. `oldValue` 被记录

### 变化时

1. `state.count` 触发 dep
2. watcher 的 scheduler/job 被调度
3. `effect.run()` 得到 `newValue`
4. 若 `hasChanged(newValue, oldValue)`
   - 先执行旧 cleanup
   - 再执行用户回调
   - 用户可注册新的 cleanup
5. 更新 `oldValue`

**本质**：watch 只是 effect 的一个更高级封装。

---

## 6. 为什么 Vue 这样设计，而不是更简单的 Set 方案

很多初学者会想：

> “为什么不用 `Map<key, Set<effect>>` 就好了？”

Vue 现在的实现更复杂，是因为它要同时解决：

1. **依赖清理要高效**
2. **computed 要惰性、可缓存**
3. **批处理要可控**
4. **effect/computed/watch 要统一抽象**
5. **内存回收要友好**
6. **对象/数组/Map/Set 行为差异要精确覆盖**

所以才会出现：

- `WeakMap -> Map -> Dep`
- `Dep <-> Subscriber` 双向链表
- `version/globalVersion`
- `DIRTY / NOTIFIED / TRACKING`
- `effectScope`
- 专门的数组与集合 instrumentation

这是“工程级响应式系统”和“教学 demo”最大的区别。

---

## 7. 这些原理对你平时写 Vue 代码有什么实际帮助

这一节是最值得转化到业务开发里的部分。

### 7.1 不要滥用深度 watch

原因：

- `watch(..., { deep: true })` 底层要 `traverse()` 递归读取整棵对象树
- 数据越大，成本越高

建议：

- 能监听具体字段就不要监听整个对象
- 能拆成多个小 source 就别全量 deep watch
- 明确需要浅层时用 `deep: 1` / `false` 或 shallow API

### 7.2 大对象、第三方实例、图表实例优先考虑 `shallowRef` / `markRaw`

原因：

- deep reactive 会递归代理，成本高
- 第三方实例通常不需要被 Proxy 化

典型场景：

- ECharts 实例
- 地图实例
- 富文本编辑器实例
- 大型静态 schema

### 7.3 解构 reactive 前要想到 `toRef / toRefs`

因为：

```ts
const state = reactive({ foo: 1 })
const { foo } = state
```

这里 `foo` 会变成普通值，丢失响应式连接。

更稳妥的是：

- `const foo = toRef(state, 'foo')`
- `const { foo } = toRefs(state)`

### 7.4 理解 computed 的缓存特性，避免把可缓存逻辑写成 method

如果一个值依赖响应式状态，且会被反复读取：

- 用 `computed` 更合适
- 它只在依赖变化且被读取时重算

而普通函数/方法每次都会执行。

### 7.5 理解“读取才会追踪”

这能解释很多业务现象：

- `watchEffect` 里没读到的值，不会建立依赖
- 条件分支切换后，旧依赖会在下轮 effect 中被清理
- 为什么某些字段改了 UI 不更新：往往是因为根本没被读取过

### 7.6 理解数组和集合的特殊性

数组：

- `length` 变化会影响索引依赖
- `includes/indexOf` 需要 raw/proxy 双向兼容

Map/Set：

- `size`、`forEach`、`keys()`、`entries()` 都对应不同依赖语义
- 业务里如果大量使用 Map/Set，Vue 其实已经帮你做了很细的追踪设计

### 7.7 善用 readonly 做边界隔离

`readonly` 的意义不只是“防写”，更是：

- 暴露只读状态给外部模块
- 明确谁有权修改状态
- 降低组件/模块之间的耦合风险

### 7.8 组合式函数里学会用 `effectScope`

如果你自己写复杂 composable：

- 内部开了 watch / watchEffect / computed
- 又要统一销毁

那 `effectScope` 的思想非常值得借鉴。

---

## 8. Vue 响应式里最值得学习的设计与实现

### 8.1 把“依赖关系”从简单集合升级为双向链表

优点：

- 清理旧依赖高效
- 可复用 link 节点
- 可以同时从 dep 和 sub 两侧进行删除

这是非常工程化的设计。

### 8.2 大量使用位标记而不是多个布尔字段

例如 `EffectFlags`。

优点：

- 内存紧凑
- 判断快
- 状态组合灵活

### 8.3 通过 `globalVersion + dep.version + link.version` 做多层缓存判断

这是 Vue 3.5 当前源码里非常漂亮的性能设计。

它让 computed 不必每次都暴力重算，而是先走快速路径。

### 8.4 统一抽象 Subscriber，让 effect 与 computed 共用底层设施

这是很好的架构思路：

- 上层能力不同
- 底层订阅模型统一

这样整个系统既可扩展，又不会重复实现。

### 8.5 把对象、数组、集合拆成不同 handler/instrumentation

这说明 Vue 没有强行抽象成“一套万能逻辑”，而是：

- 先抓住共性
- 再承认差异
- 对高差异对象单独优化

这是实战工程里非常重要的思路。

### 8.6 用测试和 benchmark 双维度约束实现

一个优秀底层库不能只“能跑”，还要：

- 行为稳定
- 性能可控
- 边界明确

`packages/reactivity` 这套目录结构本身就体现了这种工程文化。

---

## 9. 建议你按什么顺序继续精读源码

如果你想系统读透，推荐顺序如下：

1. `constants.ts`
2. `reactive.ts`
3. `baseHandlers.ts`
4. `dep.ts`
5. `effect.ts`
6. `computed.ts`
7. `ref.ts`
8. `watch.ts`
9. `collectionHandlers.ts`
10. `arrayInstrumentations.ts`
11. `effectScope.ts`

### 为什么这样排

- 先理解对象代理入口
- 再理解依赖图和 effect 执行模型
- 然后再看 computed/ref/watch 这些高阶 API
- 最后补数组/集合等细节优化模块

---

## 10. 一句话总结整套响应式系统

如果要把 Vue 3 响应式源码压缩成一句话，可以这样记：

> **Proxy/Ref 负责“拦截状态”，Dep/Link 负责“记录关系”，ReactiveEffect/Computed/Watch 负责“调度执行”，EffectScope 负责“生命周期收束”，最终形成一个按需收集、按需触发、惰性计算、批量更新的高性能闭环。**

如果你继续精读源码，建议一边读 `packages/reactivity/src`，一边对照 `__tests__`，这样最容易把“代码分支”映射成“真实行为”。
