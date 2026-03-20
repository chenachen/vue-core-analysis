# Vue 编译器源码导读（compiler-core / compiler-dom / compiler-sfc）

> 目标：把 Vue 3 编译器三层目录如何协作讲清楚，并把“`.vue` 文件 / 模板字符串 → AST → transform → render 函数 → 运行时渲染器”的完整闭环串起来。

> 配套阅读：本轮已经完成 `packages/compiler-core/src` 与 `packages/compiler-dom/src` 的全量文件级、函数级注释补充；`packages/compiler-sfc/src` 目前仍以主链路阅读为主，后续会继续展开。建议你一边看本文，一边打开对应源码顺着注释读。

---

## 1. 先给结论：Vue 编译器到底解决什么问题

Vue 编译器本质上是在做一件事：

**把更适合人写的模板 / SFC 语法，转换成更适合运行时高效执行的 JavaScript render 函数。**

这件事被拆成三层：

- **`compiler-core`**：平台无关的模板编译内核
- **`compiler-dom`**：在 core 上加 DOM 平台规则与 DOM 专属指令 transform
- **`compiler-sfc`**：在前两者之上再处理 `.vue` 单文件组件的拆块、脚本宏、样式编译

可以用一句话概括它们的关系：

- `compiler-core` 决定 **模板应该如何被理解和改写**
- `compiler-dom` 决定 **浏览器 DOM 模板有哪些额外规则**
- `compiler-sfc` 决定 **`.vue` 文件如何被拆开并分别交给不同编译器**

---

## 2. 三层编译器与运行时渲染器的闭环

```text
.vue 文件
  │
  ├─ compiler-sfc.parse()
  │    ├─ 拆出 template
  │    ├─ 拆出 script / script setup
  │    ├─ 拆出 style
  │    └─ 产出 SFCDescriptor
  │
  ├─ compiler-sfc.compileScript()
  │    ├─ 处理 defineProps / defineEmits / defineModel 等宏
  │    ├─ 分析 import / bindings
  │    ├─ 按需内联 template render
  │    └─ 生成组件脚本
  │
  ├─ compiler-sfc.compileTemplate()
  │    └─ 调用 compiler-dom.compile()
  │          └─ 调用 compiler-core.baseCompile()
  │                ├─ baseParse()      -> AST
  │                ├─ transform()      -> 改写 AST / 收集 helpers
  │                └─ generate()       -> render 函数字符串
  │
  ├─ compiler-sfc.compileStyle()
  │    ├─ 预处理器
  │    ├─ scoped 重写
  │    ├─ CSS vars 注入
  │    └─ CSS Modules
  │
  └─ 最终得到 JS + CSS
       │
       └─ 运行时执行 render()
             │
             └─ runtime-core / runtime-dom renderer
                   ├─ 创建 VNode
                   ├─ patch 旧新子树
                   └─ 更新真实 DOM
```

所以要真正看懂 Vue，不应该把“编译器”和“渲染器”完全割裂开。更准确的闭环是：

1. **编译器**把模板变成 render 函数
2. **响应式系统**触发 render 重新执行
3. **渲染器**根据 render 返回的新旧 VNode 做最小化更新
4. **编译器的优化结果**（如 patch flags、静态提升、block tree）直接影响渲染器性能

---

## 3. 建议阅读顺序

推荐按下面顺序通读：

1. `packages/compiler-core/src/index.ts`
2. `packages/compiler-core/src/compile.ts`
3. `packages/compiler-core/src/parser.ts`
4. `packages/compiler-core/src/transform.ts`
5. `packages/compiler-core/src/codegen.ts`
6. `packages/compiler-core/src/transforms/*`
7. `packages/compiler-dom/src/index.ts`
8. `packages/compiler-dom/src/parserOptions.ts`
9. `packages/compiler-dom/src/transforms/*`
10. `packages/compiler-sfc/src/parse.ts`
11. `packages/compiler-sfc/src/compileTemplate.ts`
12. `packages/compiler-sfc/src/compileStyle.ts`
13. `packages/compiler-sfc/src/compileScript.ts`
14. `packages/compiler-sfc/src/script/*`

阅读原则是：

- **先主链路，后细节文件**
- **先入口函数，后辅助函数**
- **先理解“为什么要这样拆”，再理解“具体怎么写”**

---

## 4. 目录树

### 4.1 `packages/compiler-core`

```text
packages/compiler-core
├── README.md
├── __tests__
├── index.js
├── package.json
└── src
    ├── ast.ts
    ├── babelUtils.ts
    ├── codegen.ts
    ├── compat/
    ├── compile.ts
    ├── errors.ts
    ├── index.ts
    ├── options.ts
    ├── parser.ts
    ├── runtimeHelpers.ts
    ├── tokenizer.ts
    ├── transform.ts
    ├── transforms/
    ├── utils.ts
    └── validateExpression.ts
```

### 4.2 `packages/compiler-dom`

```text
packages/compiler-dom
├── README.md
├── __tests__
├── index.js
├── package.json
└── src
    ├── decodeHtmlBrowser.ts
    ├── errors.ts
    ├── htmlNesting.ts
    ├── index.ts
    ├── parserOptions.ts
    ├── runtimeHelpers.ts
    └── transforms/
```

### 4.3 `packages/compiler-sfc`

```text
packages/compiler-sfc
├── LICENSE
├── __tests__
├── package.json
└── src
    ├── cache.ts
    ├── compileScript.ts
    ├── compileStyle.ts
    ├── compileTemplate.ts
    ├── index.ts
    ├── parse.ts
    ├── rewriteDefault.ts
    ├── script/
    ├── style/
    ├── template/
    └── warn.ts
```

---

## 5. 每一层的职责

### 5.1 compiler-core：平台无关的模板编译内核

它解决的是：

- 模板字符串如何被解析成 AST
- 指令、插值、插槽、组件节点如何被改写成更接近运行时代码的数据结构
- 最终如何生成 render 函数字符串

你可以把它理解成：

**“只要给我模板和编译规则，我就能产出 render 函数；至于最终是不是用于浏览器 DOM，由上层决定。”**

### 5.2 compiler-dom：DOM 平台增强层

它解决的是：

- HTML / SVG / MathML 命名空间切换
- `Transition` / `TransitionGroup` 识别
- `v-html` / `v-text` / DOM 版 `v-model` / `v-show` 的平台特化
- 静态 HTML 字符串化、HTML 嵌套校验

它本质上没有重写编译器主流程，只是给 core 提供额外配置。

### 5.3 compiler-sfc：单文件组件编排层

它解决的是：

- `.vue` 文件如何拆成多个 block
- `<script setup>` 如何做宏编译
- `<style scoped>` 如何重写选择器
- `<template>` 如何把 scopeId、cssVars、资源 URL 改写等信息一起带进编译

它更像一个 **总导演**：把不同 block 交给最适合的编译器处理，再把结果拼回去。

---

## 6. compiler-core 主链路

## 6.1 `src/index.ts`

这是 `compiler-core` 的门面文件，主要作用是把内部关键能力统一导出。

重点导出：

- `baseCompile`
- `baseParse`
- `transform`
- `generate`
- `ast` / `options` / `runtimeHelpers`
- 各种内置 transform，如 `transformModel`、`transformOn`、`processIf`、`processFor`

阅读意义：

- 帮你先建立“这个包对外提供了哪些核心能力”的全貌
- 能快速定位主入口与高频工具函数

## 6.2 `src/compile.ts`

这个文件是真正把编译三个阶段串起来的地方。

### 核心函数：`getBaseTransformPreset()`

作用：返回默认启用的 transform 组合。

重点理解：

- `transformIf`、`transformFor` 这种结构型 transform 为什么要排在前面
- `transformExpression` 为什么依赖 `prefixIdentifiers`
- `transformElement`、`transformText` 为什么要在结构改写之后执行

你从这里能学到一个重要设计：

**Vue 把“编译能力”设计成了可组合的 transform 管线。**

### 核心函数：`baseCompile()`

作用：平台无关编译入口。

执行步骤：

1. 校验并归一化 options
2. 如果输入是字符串，调用 `baseParse()` 得到 AST
3. 调用 `transform()` 改写 AST
4. 调用 `generate()` 输出 render 函数字符串

实现原理要点：

- 支持直接传 AST，从而复用 parse 结果
- 支持上层编译器插入自己的 node/directive transform
- 会根据 module 模式和 TS 场景补全编译选项

### 对你写 Vue 代码的帮助

- 理解 `v-if`、`v-for`、插槽、指令为什么能被统一处理
- 明白很多“模板语法糖”最终都会被拆成 transform 规则，而不是运行时魔法

---

## 7. parser：模板是怎么变成 AST 的

对应文件：`packages/compiler-core/src/parser.ts`

### 它做了什么

`parser.ts` 不直接自己逐字符扫描，而是配合 `tokenizer.ts` 一起工作：

- `tokenizer.ts` 负责识别当前读到了什么 token
- `parser.ts` 负责根据这些 token 组装 Vue AST

### 关键函数

#### `baseParse(input, options)`

作用：整个 parse 阶段的总入口。

会做的事：

- 重置 parser 全局状态
- 合并本次 parse 选项
- 切换 tokenizer 模式（`base` / `html` / `sfc`）
- 根据自定义分隔符处理插值边界
- 驱动 tokenizer 扫描整段模板
- 最后补齐根节点位置和空白压缩

#### `endOpenTag(end)`

作用：开始标签结束后，把 `currentOpenTag` 真正挂到 AST 上。

重要点：

- void tag 会立即闭合
- 非 void tag 会入栈，等待后续子节点和结束标签
- `pre`、XML 模式、SFC 根标签 innerLoc 都在这里同步切换

#### `onText(content, start, end)`

作用：处理文本 token。

重要点：

- 需要时做 HTML entity 解码
- 连续文本节点会被合并
- 为后续 whitespace 优化打基础

#### `onCloseTag(el, end, isImplied)`

作用：某个元素真正结束时的统一收尾。

重要点：

- 补结束位置
- 修正 `tagType`（原生元素 / 组件 / slot / 特殊 template）
- 压缩空白
- 恢复 `pre` / `v-pre` / XML 状态
- 执行 compat 模式兼容检查

#### `parseForExpression(input)`

作用：把 `v-for` 表达式拆成 `source / value / key / index`。

这个函数非常值得读，因为它展示了 Vue 的一个典型思路：

**不做无意义的泛化 JS 解释器，只针对编译需要提取最关键的语义片段。**

#### `createExp(content, isStatic, loc, constType, parseMode)`

作用：创建 `SimpleExpressionNode`，并在需要时交给 Babel 预解析。

重要点：

- `prefixIdentifiers` 模式下会尝试得到表达式 AST
- 为后续 identifier 分析、作用域判断、patch flag 推导打基础

### 你需要重点理解的设计

#### 1. parser 维护的是“增量状态”

`currentOpenTag`、`currentProp`、`stack` 这些状态变量一起构成了当前解析现场。

这说明 Vue parser 的设计不是一次性“正则抽象”，而是一个**状态机 + 语法树装配器**。

#### 2. 所有节点都带 `loc`

这直接决定了：

- 报错可以精确定位
- source map 可以持续传递到后续编译阶段
- IDE / 构建工具有更好的调试体验

#### 3. parser 已经开始做“编译友好”处理

比如：

- whitespace 压缩
- template/tagType 区分
- component 判定
- `v-pre` / `pre` 特殊处理

也就是说，parser 输出的 AST 不是“纯语法 AST”，而是**面向后续 transform 的编译 AST**。

---

## 8. transform：Vue 模板语义是怎么被改写的

对应文件：`packages/compiler-core/src/transform.ts`

### 它做了什么

transform 阶段是 Vue 编译器的核心。

它把 parser 产出的 AST，改写成更适合 codegen 和运行时优化的数据结构。

### 核心函数

#### `createTransformContext(root, options)`

作用：创建 transform 阶段共享上下文。

上下文里最重要的东西有：

- `helpers`
- `components`
- `directives`
- `hoists`
- `imports`
- `cached`
- `identifiers`
- `parent / grandParent / childIndex / currentNode`

本质上它是 transform 之间共享状态的中枢。

#### `transform(root, options)`

作用：整个 transform 阶段入口。

步骤：

1. 创建上下文
2. 调用 `traverseNode(root, context)` 深度遍历整棵 AST
3. 如果开启 `hoistStatic`，执行静态提升
4. 为根节点生成 `codegenNode`
5. 把 helpers/components/directives/hoists 等结果回写到 root

#### `traverseNode(node, context)`

作用：遍历单个节点并执行所有注册的 transform。

这是整个 transform 机制最值得学习的地方。

设计特点：

- 先执行所有“进入时”的 transform
- 再递归遍历子节点
- 最后反向执行所有“退出回调”

这和很多编译器 / Babel 插件系统的设计类似。

优点是：

- 进入时适合改结构
- 退出时适合利用子节点处理结果生成当前节点 codegen

#### `traverseChildren(parent, context)`

作用：遍历一个父节点的 children。

重点：

- 会动态维护 `parent`、`grandParent`、`childIndex`
- 允许 transform 在遍历过程中删改节点

#### `createRootCodegen(root, context)`

作用：为根节点决定最终 codegen 入口。

规则：

- 单根元素：尽量直接复用该元素 codegen
- 多根节点：包装成 `Fragment`
- 空根：交给 codegen 输出 `null`

#### `createStructuralDirectiveTransform(name, fn)`

作用：创建 `v-if` / `v-for` 这类结构型指令 transform。

这类指令的关键不是“生成一个 prop”，而是“改写整棵子树结构”。

### 常见 transform 分类

#### NodeTransform

处理节点级语义，例如：

- `transformIf`
- `transformFor`
- `transformElement`
- `transformText`
- `transformExpression`

#### DirectiveTransform

处理单个指令属性，例如：

- `transformOn`
- `transformBind`
- `transformModel`

### 对你写 Vue 代码的帮助

#### 1. 理解为什么某些模板写法更容易优化

因为 transform 阶段会判断：

- 哪些是静态节点
- 哪些是动态 prop
- 哪些必须保留为 block

#### 2. 理解为什么复杂模板会带来更重的生成代码

你写的每一个 `v-if`、`v-for`、动态 class/style、slot，最后都会变成额外的 transform 成果和运行时代码。

#### 3. 理解为什么 Vue 模板“不是字符串替换”

它本质上是一套完整的编译器中间层设计。

---

## 9. codegen：AST 怎么生成 render 函数

对应文件：`packages/compiler-core/src/codegen.ts`

### 它做了什么

把 transform 阶段产出的 codegen tree 输出成真正的 JS 源码字符串。

### 核心函数

#### `createCodegenContext(ast, options)`

作用：创建 codegen 上下文。

管理内容：

- 当前输出代码字符串
- 行列号与 offset
- 缩进层级
- helper 输出
- source map 写入

#### `generate(ast, options)`

作用：代码生成总入口。

步骤：

1. 创建上下文
2. 生成 preamble
3. 输出 render / ssrRender 函数签名
4. 输出组件/指令/临时变量解析语句
5. 递归生成 VNode tree 对应代码

#### `genFunctionPreamble()`

作用：函数模式下生成 helper 与 hoist 声明。

#### `genModulePreamble()`

作用：模块模式下输出 import/export。

#### `genAssets()`

作用：把组件 / 指令 / filter 名称转成运行时解析语句。

#### `genNode()`

作用：整个 codegen 的分发表。

它会根据 node 类型，分发到：

- `genText`
- `genExpression`
- `genInterpolation`
- `genObjectExpression`
- `genArrayExpression`
- `genConditionalExpression`
- `genVNodeCall`
- 等等

#### `genVNodeCall()`

作用：输出创建 VNode 的调用表达式。

这是最关键的函数之一，因为模板的大多数节点最终都会落到这里。

它会拼出：

- tag
- props
- children
- patchFlag
- dynamicProps
- directives
- block tracking

### 为什么这一步对性能关键

因为 codegen 输出的不是随便一段 render 代码，而是**高度配合运行时优化结构**的代码：

- patch flags
- block tree
- hoist 静态节点
- cache handlers
- helper 按需导入

也就是说：

**运行时快，不是只靠 diff 算法，还因为编译器提前把很多信息埋进 render 函数了。**

---

## 10. compiler-core/transforms：模板能力是如何拆成插件的

这一目录下的文件基本都可以理解成一项模板语义能力。

| 文件 | 作用 |
| --- | --- |
| `vIf.ts` | 把 `v-if / v-else-if / v-else` 改写成条件分支结构 |
| `vFor.ts` | 把 `v-for` 改写成循环渲染结构 |
| `vOn.ts` | 处理事件绑定表达式 |
| `vBind.ts` | 处理动态绑定 |
| `vModel.ts` | 处理 `v-model` 的编译期改写 |
| `vSlot.ts` | 处理具名插槽、作用域插槽和 slot scope 追踪 |
| `transformElement.ts` | 把元素节点组织成 VNode 调用参数 |
| `transformExpression.ts` | 在 prefixIdentifiers 等模式下分析和改写表达式 |
| `transformText.ts` | 合并相邻文本和插值，减少运行时开销 |
| `vMemo.ts` | 处理 `v-memo` |
| `vOnce.ts` | 处理 `v-once` |
| `transformSlotOutlet.ts` | 处理 `<slot />` 输出 |
| `cacheStatic.ts` | 做静态提升与常量性判断 |
| `noopDirectiveTransform.ts` | 空指令 transform，占位用 |

### 为什么这个拆法值得学

这是一种非常好的“能力模块化”设计：

- 每个语义点单独实现
- 入口统一由 transform 管线调度
- 上层平台编译器可以覆写某些 transform

这比把所有模板逻辑堆进一个大 switch 里更易扩展、更易测试。

---

## 11. compiler-dom：DOM 平台到底额外做了什么

## 11.1 `src/index.ts`

这是 DOM 编译入口。

核心不是重写 compile，而是：

- 预置 `parserOptions`
- 注入 `DOMNodeTransforms`
- 注入 `DOMDirectiveTransforms`
- 然后调用 `baseCompile()`

### 核心点：`DOMNodeTransforms`

默认包含：

- `transformStyle`
- 开发环境下的 `transformTransition`
- 开发环境下的 `validateHtmlNesting`

### 核心点：`DOMDirectiveTransforms`

默认包含：

- `v-html`
- `v-text`
- DOM 版 `v-model`
- DOM 版 `v-on`
- `v-show`
- `v-cloak` 占位 transform

### 你应该得出的结论

**Vue 编译器不是“为 DOM 写的”，而是“先有平台无关内核，再通过 compiler-dom 适配 DOM”。**

这也是它能继续扩展到 SSR 的关键原因。

## 11.2 `src/parserOptions.ts`

它把 DOM 世界的语义补给 parser：

- 哪些是原生 HTML/SVG/MathML 标签
- 哪些是 void tag
- 哪些是内建组件（如 `Transition`）
- 子节点该落在哪个 namespace

### 这里值得你学习的一点

**平台差异不要污染通用内核，而应该通过配置边界注入。**

---

## 12. compiler-dom/transforms：DOM 专属 transform

| 文件 | 作用 |
| --- | --- |
| `vHtml.ts` | `v-html` 改写 |
| `vText.ts` | `v-text` 改写 |
| `vModel.ts` | DOM 平台下的 `v-model` 行为分发 |
| `vOn.ts` | DOM 事件修饰符与事件选项相关编译 |
| `vShow.ts` | `v-show` 编译 |
| `transformStyle.ts` | 静态 style 字符串预处理 |
| `Transition.ts` | `Transition` 子节点结构检查 |
| `stringifyStatic.ts` | 把足够静态的 DOM 片段直接字符串化 |
| `ignoreSideEffectTags.ts` | 忽略不应生成副作用的标签 |
| `validateHtmlNesting.ts` | 开发环境 HTML 嵌套校验 |

### 对前端编码的实际帮助

#### 1. 理解 `v-html` / `v-text` / `v-model` 为什么行为并不等价

这些语法在编译时走的是完全不同分支，最终运行时代码结构也不同。

#### 2. 理解哪些模板是“天然更利于静态化”的

如果你的模板更静态、更规整，`stringifyStatic` 和 hoist 才更容易命中。

---

## 13. compiler-sfc：`.vue` 文件是如何被拆解和再编排的

## 13.1 `src/index.ts`

这是整个 SFC 包的门面。

它导出：

- `parse`
- `compileTemplate`
- `compileStyle`
- `compileScript`
- `rewriteDefault`
- 类型解析相关工具

阅读价值：

- 先建立 `.vue` 编译链路的全貌
- 明确 SFC 层到底负责哪些事、不负责哪些事

## 13.2 `src/parse.ts`

### 核心函数：`parse()`

作用：把完整的 `.vue` 文件解析成 `SFCDescriptor`。

产物里最关键的是：

- `template`
- `script`
- `scriptSetup`
- `styles`
- `customBlocks`
- `cssVars`
- `shouldForceReload()`

### 关键 helper

#### `createBlock()`

把顶层 AST 元素节点切成 SFC block 描述对象，并保留：

- 内容
- 属性
- `lang`
- `src`
- `loc`
- `map`

#### `generateSourceMap()`

为 block 构造从块内部到整份 SFC 的映射。

#### `padContent()`

通过插空格/换行保留原始行号，方便后续脚本或样式单独编译时仍能把错误回映到 SFC 原文件。

#### `hmrShouldReload()`

判断模板改动是否会导致脚本输出变化，进而决定 HMR 是“rerender”还是“reload”。

### 这层设计值得学习的点

SFC parse 并不急着“做所有事情”，而是优先构造一个稳定的 **描述符对象**。

这是一种非常经典的编译管线分层：

- 先做结构切分
- 再做针对性编译
- 各阶段通过中间表示解耦

## 13.3 `src/compileTemplate.ts`

作用：编译 `<template>` block。

它的关键工作不是重新实现模板编译，而是把 SFC 语义嫁接到 `compiler-dom` / `compiler-ssr`：

- 模板预处理
- 资源 URL transform
- scopeId 注入
- slotted 标记
- cssVars 注入
- parse 阶段 source map 与 template 编译 source map 合并

### 关键函数

- `compileTemplate()`：模板编译入口
- `doCompileTemplate()`：真正执行编译
- `mapLines()`：把模板 map 对齐回 `.vue`
- `patchErrors()`：修正模板报错位置

## 13.4 `src/compileStyle.ts`

作用：编译 `<style>` block。

能力包括：

- 预处理器接入
- PostCSS 插件链组装
- `v-bind()` CSS 变量注入
- scoped 样式重写
- CSS Modules
- source map / dependencies 输出

### 关键函数

- `compileStyle()`：同步入口
- `compileStyleAsync()`：异步入口
- `doCompileStyle()`：样式编译主流程
- `preprocess()`：包装预处理器

### 对业务开发的帮助

你写的这些语法背后都不是“运行时魔法”：

- `<style scoped>` = 选择器改写 + 模板节点注入 scopeId
- `v-bind(color)` = CSS 变量注入
- CSS Modules = 编译结果额外导出映射表

## 13.5 `src/compileScript.ts`

这是 SFC 最复杂的部分。

### 它负责什么

- 合并普通 `<script>` 与 `<script setup>`
- 处理编译期宏
- 收集 bindingMetadata
- 分析 import 是否会在模板中使用
- 支持顶层 await
- 支持内联 template render
- 处理 CSS 变量注入
- 合并 source map

### 关键函数

#### `compileScript()`

整个脚本编译入口。

它会：

1. 建立 `ScriptCompileContext`
2. 解析宏与 import
3. 识别 setup binding
4. 生成 runtime props/emits/model 代码
5. 按需调用 `compileTemplate()` 做 render 内联
6. 组装最终导出组件代码

#### `registerUserImport()`

登记 import 来源、别名、是否 type import、模板是否使用。

#### `walkDeclaration()` / `walkPattern()`

深度分析变量声明与解构结构，为 bindingMetadata 提供数据。

#### `canNeverBeRef()`

判断某个表达式是否不可能成为 ref，这会影响自动解包与 binding 类型分类。

#### `isStaticNode()`

判断表达式是否是纯静态，影响提升和 binding 分类。

#### `mergeSourceMaps()`

合并脚本和模板内联过程中产生的多个 source map。

### 这一层最值得学习的设计

#### 1. 宏是“编译时能力”，不是运行时能力

`defineProps`、`defineEmits`、`defineExpose`、`defineModel`、`defineSlots` 都不是 runtime API，它们是编译期被识别和抹去的。

这意味着：

- 你平时写的 `<script setup>` 非常简洁
- 但真正运行的 JS 会被改写成更显式的组件选项 / setup 代码

#### 2. 绑定分析是整个系统优化的基础

Vue 需要知道某个标识符是：

- 普通常量
- 可能是 ref
- 一定是 ref
- props
- setup let
- setup const

这会直接影响模板表达式如何生成代码。

---

## 14. 这些能力是怎么串起来形成闭环的

下面用一个稍微完整的例子：

```vue
<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ count: number }>()
const doubled = computed(() => props.count * 2)
</script>

<template>
  <div class="counter">{{ doubled }}</div>
</template>

<style scoped>
.counter { color: red; }
</style>
```

### 第一步：SFC parse

`compiler-sfc.parse()` 会得到：

- `scriptSetup` block
- `template` block
- `style scoped` block

### 第二步：compileScript

`compileScript()` 会：

- 识别 `defineProps` 宏
- 识别 `computed` import
- 把 `props`、`doubled` 等绑定类型记录到 metadata
- 生成最终 setup 相关脚本代码

### 第三步：compileTemplate

模板会经过 `compiler-dom.compile()` → `compiler-core.baseCompile()`：

- parse：得到插值与元素 AST
- transform：知道 `doubled` 是 setup 绑定
- codegen：生成 render 函数

### 第四步：compileStyle

`<style scoped>` 会被改写成带 scopeId 的选择器。

### 第五步：运行时渲染

render 执行后生成 VNode，渲染器再把它 patch 到 DOM。

### 这就是完整闭环

- 编译器提前做静态分析
- 运行时只执行编译结果
- 响应式变化触发 render 重跑
- patch 依赖编译期埋下的优化信息完成高效更新

---

## 15. 编译器原理对你日常写 Vue 的实际帮助

## 15.1 多写稳定结构，少写无必要动态结构

原因：

- 越静态的模板越容易被 hoist / stringify
- 越稳定的节点树越容易让 block tree 与 patch flags 发挥作用

实践建议：

- 能写静态 class/style 就别都写成对象/函数动态生成
- 避免无意义的内联对象、内联数组
- 避免把复杂逻辑都堆进模板表达式

## 15.2 理解 `v-if` 与 `v-show` 的真正差异

编译阶段它们就已经走了不同路径：

- `v-if` 改的是结构
- `v-show` 改的是运行时指令行为

这意味着：

- 频繁切换：`v-show` 常更合适
- 条件很少变化且不想初次渲染全部内容：`v-if` 常更合适

## 15.3 理解为什么 `key` 很重要

transform 与运行时 patch 都高度依赖稳定 identity。

如果你理解了编译输出和渲染器如何协作，就更容易明白：

- 列表 diff 不是“自动完美猜出来”
- `key` 是帮助渲染器降低不必要移动与复用错误的关键信息

## 15.4 理解 `<script setup>` 的本质

它不是“换一种写法”，而是：

**让编译器有更多静态分析空间。**

所以很多体验更好的地方，其实是靠编译期能力完成的：

- 宏抹除
- 更好的绑定分析
- 更容易做模板内联

## 15.5 理解 scoped 样式不是“浏览器原生隔离”

它本质上是：

- 模板节点带上 scopeId
- 选择器被编译改写

知道这一点后，你会更容易理解：

- 深度选择器为什么存在
- scoped 不是 Shadow DOM
- 某些跨组件样式覆盖为什么会失败或表现特殊

---

## 16. 值得重点学习的设计与实现

## 16.1 分层清晰：core / dom / sfc

这是最值得学的架构点之一。

优点：

- 通用内核不被平台污染
- 平台差异通过配置和 transform 注入
- 文件格式层（SFC）与模板编译层解耦

这类分层设计在前端工程里非常通用：

- 核心算法层
- 平台适配层
- 产品形态层

## 16.2 transform 管线设计

优点：

- 易扩展
- 易测试
- 易覆写
- 易拆分复杂语义

对业务代码的启发：

如果你有一条复杂数据处理链，也可以用“上下文 + 插件 + 进入/退出回调”的方式组织，而不是写成单个巨型函数。

## 16.3 中间表示（AST / Descriptor / CodegenNode）设计

Vue 编译器不是一步到位，而是不断在不同层次的中间表示之间转换：

- 模板 AST
- transform 后 AST
- codegenNode
- SFCDescriptor

这能极大降低复杂系统的耦合。

## 16.4 编译期做尽可能多的事，运行时只做必要的事

这就是 Vue 3 性能设计的重要思想：

- 编译期静态分析
- 运行时按优化信息执行

对你自己的前端代码也有启发：

- 可以预计算的，不要拖到运行时每次重算
- 可以在构建期解决的，别都压给浏览器执行时

## 16.5 source map 与错误定位贯穿全链路

这是工程成熟度很高的体现。

说明一个优秀系统不只要“能跑”，还要：

- 易调试
- 易定位问题
- 易和工具链集成

---

## 17. 读源码时建议重点问自己的问题

读每个文件时，建议你都问这几个问题：

1. 这个文件在整个链路里的位置是什么？
2. 它的输入是什么？输出是什么？
3. 它改写了什么中间表示？
4. 它依赖上游给它准备了哪些信息？
5. 它又为下游准备了哪些信息？
6. 这一步如果拿掉，整个闭环会断在哪里？

如果你带着这六个问题读，速度会快很多。

---

## 18. 最后一张心智图

```text
compiler-sfc
  ├─ parse SFC -> descriptor
  ├─ compileScript -> 处理 script/setup 宏与绑定
  ├─ compileTemplate -> 交给 compiler-dom
  └─ compileStyle -> 处理样式系统

compiler-dom
  ├─ 注入 DOM parserOptions
  ├─ 注入 DOM transforms
  └─ 调用 compiler-core.baseCompile

compiler-core
  ├─ baseParse -> AST
  ├─ transform -> 改写 AST / 收集优化信息
  └─ generate -> render 函数代码

runtime renderer
  ├─ render 执行 -> VNode
  ├─ patch 新旧子树
  └─ 更新真实 DOM
```

一句话收尾：

**Vue 不是“模板在运行时神奇执行”，而是“编译器提前理解模板，运行时只执行已经优化过的渲染指令”。**
