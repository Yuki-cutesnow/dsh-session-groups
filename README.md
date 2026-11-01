# dsh-session-groups

给 DeepSeek Harness 侧边栏工作区区域加一个 **纯展示用的「分组」分区**：把散落在不同工作区里的会话，
按你自己的分类收进一组组里，强迫症友好。**不改动会话归属、不移动会话文件、不动工作区数据**——只是表面整理。

> 插件只在自己保存的 `$DSH_HOME/session-groups.json` 里记录「哪个会话属于哪个分组」，
> 点击分组里的会话时，仍然是委托 DSH 原生会话行打开，所以原生导航、右键菜单、快捷键全部照旧。

## 功能

- 侧栏工作区列表末尾多出「分组」分区（**底部停靠**，不挤占工作区列表），可整体折叠
- 新建/重命名/排序/删除分组（上一版里「重命名」「下移」失效的问题都已修复）
- **分组可多层嵌套**：⋯ 菜单里「新建子分组」，子分组缩进显示，可一层层套下去
- **可以直接把侧栏里的会话拖进分组**：拖到分组标题或分组体上即加入；拖到某个会话行上则插到它前面。
  拖动时会显示一条**蓝色插入指示线**，标出会话将落到哪个位置；分组里的会话也能拖到别的分组
  （拖拽只改本插件的分组文件，不碰宿主归属）
- **拖分区顶部那条灰色分隔线可任意调节分区高度**；双击分隔线恢复自动高度
- 管理面板：按工作区列出所有会话，用下拉框把会话分到任意分组（含「＋新建分组并加入」「不分组」，
  下拉选项带层级缩进）
- 点击分组里的会话直接打开；已归档会话会提示先取消归档
- 分区状态（分组结构、嵌套、面板高度）持久化在宿主侧（`$DSH_HOME/session-groups.json`），
  换浏览器/清缓存不丢
- **默认零轮询**：页面启动时只加载一次脚本，之后不会定时请求任何接口（只有打开/保存分组时才调用本机 API）。
  开发调试时可创建 `$DSH_HOME/session-groups.dev` 标记文件临时启用热更新（见「手动安装」一节）

## 使用

- 分区标题栏右侧：`＋` 新建顶级分组，`⚙` 打开整理面板
- 分组行右侧 `⋯` 菜单：重命名 / 新建子分组 / 上移 / 下移 / 删除分组
- **拖拽**：把侧栏工作区里的会话直接拖到分组标题或分组内容上即加入；拖到某个会话行上则插到它前面；
  拖动过程中会显示**蓝色插入指示线**（带左端圆点）提示落点，分组本身同时高亮；从分组里拖到另一个分组可换组
- 拖分区**顶部灰色分隔线**调整高度，双击恢复自动高度
- 分组内会话行右侧 `×`（悬停显示）把会话移出分组；点击会话本身打开原生会话

## 从 GitHub / 插件页安装（推荐）

本插件是一个自带 `cordis.patch.yml` 的 cordis「组合包（bundle）」，**无需构建、没有 npm 依赖**，
仓库根目录本身就是插件包（`package.json`、`cordis.patch.yml`、`lib/`、`client/` 都在根目录），
所以可以直接从 Git 仓库安装：

1. 打开 DeepSeek Harness 桌面端 → 侧栏「插件」页 → 「添加插件」（或标题栏箭头菜单里的「安装第三方插件」），
   粘贴仓库地址 `https://github.com/Yuki-cutesnow/dsh-session-groups`，然后按提示安装。
   - 也可以用 CLI：`dsh plugin --profile desktop add github:Yuki-cutesnow/dsh-session-groups`
2. 安装成功后如果出现「立即启用」，点它（组合包会被追加到 profile 的 `dsh.profile.bundles`）。
3. **完全退出并重新打开 DeepSeek Harness 一次**——桌面版的 index 注入表只在宿主启动时收集，
   不重启的话侧栏不会出现「分组」分区。

注意事项：

- 安装前 Host 会用 `git ls-remote` 探测 GitHub（默认 5 秒超时）。**国内网络直连 GitHub 失败时**，
  对话框会提示「无法访问 GitHub」；「改用国内镜像」只覆盖注册表里的包，不会代替 GitHub 下载。
  这时可以改用：发布到 npm 后按包名安装（`dsh plugin --profile desktop add dsh-session-groups`）、
  把仓库打包成 tarball 地址、或直接用本地目录安装。
- 第三方插件**没有自动更新**：升级 = 先卸载再重新安装（从 GitHub 安装会重新拉取仓库内容）。
- 从 GitHub 安装时 `node_modules` 由 pnpm 放在 profile 里，源码是复制的快照，改本地副本不会影响已安装版本。
- 插件在宿主进程里运行（DSH 插件体系本身没有沙箱），装第三方插件前请自己检查代码——包括本插件。

## 手动安装（本地目录 / 开发）

插件是标准的 cordis「组合包（bundle）」：

1. 把本目录链接进 profile 的 `node_modules`（目录联接即可）：

   ```powershell
   $plugin = "D:\src\dsh-session-groups"   # ← 改成你 clone 下来的目录
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-groups" `
     -Target $plugin
   ```

2. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 中登记：

   ```json
   {
     "dsh": { "profile": { "bundles": [ "…原有条目…", "dsh-session-groups" ] } },
     "dependencies": { "dsh-session-groups": "link:D:\\src\\dsh-session-groups" }
   }
   ```

3. **完全退出并重新启动 DeepSeek Harness**（桌面端的 index 注入表只在宿主启动时收集一次，
   profile 里也没有启用 HMR 热重载）。

启动后侧栏工作区列表底部会出现「分组」分区；`$DSH_HOME/session-groups.log` 里出现一行 `apply v0.7.0` 即代表宿主半区加载成功。

> **改代码之后**：只改 `client/` 或只改 `lib/`，都需要**完全退出并重开应用**才生效
> （桌面版窗口没有刷新快捷键，Ctrl+R 无效）。v0.7.0 起默认不再轮询，只有开发调试时才会临时开启热更新：

```powershell
# 开发调试：创建标记文件后重启应用，浏览器半区开始每 5 秒比对一次 /api/version
New-Item -ItemType File -Force "$env:USERPROFILE\.dsh\session-groups.dev"
# 调试结束：删掉标记文件并重启，恢复零轮询
Remove-Item "$env:USERPROFILE\.dsh\session-groups.dev"
```

## 卸载

1. 从 profile `package.json` 的 `dsh.profile.bundles` 和 `dependencies` 中删掉 `dsh-session-groups`
2. 删除 `node_modules\dsh-session-groups` 联接
3. 重启 DeepSeek Harness；可选删除 `$DSH_HOME/session-groups.json` 与 `.log`

也可以直接用仓库里的脚本：

```powershell
node tools/uninstall-profile.mjs            # 移除注册与联接，保留分组数据
node tools/uninstall-profile.mjs --purge    # 连同 $DSH_HOME/session-groups.json 与 .log 一起删除
```

（`package.json.bak-dsg-session-groups` 是 install 脚本首次安装时的备份，如有需要请手动删除。）

## 数据、残留与清理（会不会留垃圾）

正常使用下**不会无限累积**。插件产生的全部文件如下，且都有上限：

| 路径 | 内容 | 上限 / 清理 |
| --- | --- | --- |
| `$DSH_HOME/session-groups.json` | 分组结构（哪个会话属于哪个分组、嵌套、面板高度） | 由宿主清洗：最多 200 个分组、每组最多 500 个会话、高度 0–1200px，正常几十 KB；卸载时用 `--purge` 删除 |
| `$DSH_HOME/session-groups.log` | 诊断日志（apply、路由、状态读写、浏览器回传） | 超过 512 KB 时**清空重写**，不会无限增长 |
| `$DSH_HOME/session-groups.json.tmp-*` | 原子写临时文件 | 写入后立刻改名消失；只有进程恰好在写入瞬间崩溃才会残留几 KB，下次宿主启动时自动清理 |
| profile 里的安装痕迹 | `node_modules/dsh-session-groups`（联接或目录）、`package.json` 的 `dsh.profile.bundles` + `dependencies` 各一条 | 卸载脚本会删除；`package.json.bak-dsg-session-groups` 备份需手动删 |
| 浏览器端 | 一个注入的 `<style>`、一个 `<script>`、分区/弹窗/toast DOM | 随页面生命周期存在；**不使用** localStorage/cookie，也没有定时器/轮询 |

插件**不会**写入：工作区数据 `storages/workspace.json`、会话日志、附件库、模型/凭据数据。
**默认没有任何轮询请求**：页面启动时加载一次 `client.js`，分组状态只在打开 / 拖动 / 保存时读写一次本机 API。
只有创建了 `session-groups.dev` 开发标记时，页面才会每 5 秒请求一次 `/api/version`（仅回环、不写盘）。

从「插件」页安装时，DSH 自己会在 profile 的 `.plugin-manager/logs` 下保留 pnpm 的诊断日志，
那是 DSH 的行为，不属于本插件。

## 工作原理

- **宿主半区** `lib/index.js`：cordis 插件。`apply()` 里第一件事监听 `webserver/index-inject`，
  推入一条 `{kind:'style'}`（内联 CSS）和一条 `{kind:'script', placement:'body'}`（内联加载器，只加载一次
  `/dsh-session-groups/client.js`，无轮询；存在 `session-groups.dev` 标记时才换成轮询版）；随后
  `root.inject(['webServer'], …)` 注册五条 exact 路由：
  - `GET /dsh-session-groups/client.js` / `client.css`：静态资源
  - `GET /dsh-session-groups/api/version`：浏览器半区的构建版本（文件 mtime+size），仅开发模式热更新比对用
  - `GET|POST /dsh-session-groups/api/state`：读写分组状态。GET 现读
    `$DSH_HOME/storages/workspace.json` 返回工作区/会话/归档快照；POST 校验、清洗、去重后原子写入
    `$DSH_HOME/session-groups.json`
  - `POST /dsh-session-groups/api/log`：浏览器半区的诊断日志通道（分区是注入的 DOM，出问题只能靠它回传）
- **浏览器半区** `client/client.js`：不用构建的普通 IIFE。找到侧栏工作区列表的 `[role="tree"]` 容器，
  在其父节点里插入分区节点；用 `MutationObserver` 在 DSH 重渲染后重新挂载。
  会话标题直接读原生行里的标题元素；点击条目时对 `[data-row-key="session:<id>"]` 调 `.click()`，
  需要时先展开折叠的工作区分组。
- **安全栅栏**：所有路由只接受回环地址、回环 `Host`、同源 `Origin`，拒绝 `Sec-Fetch-Site: cross-site`；
  只监听 GET/HEAD/POST，POST 仅接受 `application/json` 且 ≤ 256 KB。
- **诊断**：`$DSH_HOME/session-groups.log` 记录宿主 apply、路由注册、状态读写，以及浏览器半区回传的
  boot / state / section mounted / 打开会话失败等信息。排查 UI 问题时先看这个文件。

## 已知限制

- 是**表面分组**：不会把会话移进别的工作区（DSH 的会话归属由会话创建时的不可变 `cwd` 决定，没有移动接口）
- 改 `lib/` 或改 `client/` 都需要**完全重启应用**才生效（v0.7.0 起默认不轮询；
  开发调试可建 `$DSH_HOME/session-groups.dev` 标记临时启用热更新，用完删掉并重启）
- 首次安装必须重启应用一次（注入表只在宿主启动时收集）
- DSH 升级若改了侧栏 DOM 结构（会话行的 `data-row-key`、标题类名等），分区可能挂载失败或标题读不到；
  宿主日志 `$DSH_HOME/session-groups.log` 和浏览器控制台是排查入口
- 已归档会话无法直接打开（这是 DSH 的限制，不是插件行为）

## 版本记录

| 版本 | 内容 |
| --- | --- |
| 0.1.0 | 侧栏「分组」分区、新建/重命名/折叠、管理面板、点击打开会话 |
| 0.2.0 | 诊断回传通道 `/api/log`，修复 dsh-app 下 sendBeacon 不生效 |
| 0.3.0 | 修复重命名、底部停靠 + 拖动调高、嵌套分组、宿主清洗 schema v2 |
| 0.4.0 | 修复「下移」、支持从侧栏直接拖会话进分组 |
| 0.5.0 | 浏览器半区自动热更新（`/api/version` + 轮询加载器 + dispose 重载），不再依赖重启/刷新 |
| 0.6.0 | 发布准备：`.gitignore`/LICENSE；宿主启动时清理原子写残留的 `.tmp-*`；README 增加插件页/GitHub 安装与数据清理说明 |
| 0.7.0 | 默认取消每 5 秒轮询：页面只加载一次 `client.js`，不再有后台请求；热更新改为 `$DSH_HOME/session-groups.dev` 标记文件启用的开发模式 |

## 目录

```
dsh-session-groups/
  package.json          # dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml      # 组合包 patch：insert 本插件
  lib/index.js          # 宿主半区（注入行 + HTTP 路由 + 状态持久化）
  client/client.js      # 浏览器半区（侧栏分区 DOM）
  client/client.css     # 样式（沿用 DSH 主题变量）
  tools/                # install-profile.mjs / uninstall-profile.mjs / extract-asar.mjs
  test/mock-test.mjs    # 无 GUI 的离线冒烟测试：node test/mock-test.mjs
  LICENSE               # MIT
  .gitignore
```
