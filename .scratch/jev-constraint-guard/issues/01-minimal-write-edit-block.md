# 01: 最小闭环 — write 与 edit 被 Jev 拦下

**What to build:** 开发者在项目根目录写一个 `constraints.md`，配好 TypeSafe API key，然后让 agent 写一个违反其中某条规则的文件。这次 `write` 被拦住，agent 收到的工具结果里是被违反的那条约束原文，于是它自己改正后重试。同一个流程对 `edit` 同样生效。如果没有配 key，一切照常放行，只是弹一次提示告诉他怎么配。

这是第一个 ticket，所以它得把整条路径穿透一遍：包骨架、可注入依赖的 factory、测试替身、配置读取、约束读取与切分、Jev 请求、阈值判定、阻断。后续每个 ticket 都在这条路径上加宽某一段。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] npm 包骨架就位，`package.json` 带 `pi.extensions` 字段，零运行时依赖，TypeScript 由 pi 直接加载、无构建步骤
- [x] 扩展 factory 接受可注入依赖（HTTP transport、文件系统根、时钟、日志 sink），各自默认为真实实现；对外入口是调用该 factory 并传入真实默认值的薄包装
- [x] pi 的 `ExtensionAPI` 与 `ExtensionContext` 测试替身：能捕获注册的事件处理器与命令，能脚本化 UI 应答并记录被问过什么，能配置「是否有交互 UI」、工作目录与 abort signal
- [x] 从 pi 全局 settings 读取 `jevGuard` 块，支持 `apiKey` / `threshold` / `model` / `log` 四项，均可省略；缺失、类型不对、文件无法解析时全部退回默认值且不报错
- [x] `threshold` 默认 `0.6`，`model` 默认固定版本号（非 `jev-latest` 别名），`log` 默认 `false`
- [x] 环境变量 `TYPESAFE_API_KEY` 优先于配置中的 `apiKey`
- [x] 读取项目根目录的 `constraints.md`，按 `##` 标题切成条目，每条得到条目名与正文
- [x] 在 `tool_call` 事件上拦截 `write` 与 `edit`，二者一律送检
- [x] 送出的 `state` 只含操作类型、目标路径、变更内容；`write` 用文件内容，`edit` 用 oldText/newText 对；超长内容截断并在 state 中显式标注已截断
- [x] 一次请求内每条约束一个独立 `noul` 问题，问题的 instructions 携带该条约束完整正文
- [x] 通过注入的 transport 以 bearer token 直连 TypeSafe System One 端点，不引入任何 SDK
- [x] `noul` 超过阈值即判定违规，返回 `{ block: true, reason }`，reason 含被违反约束的原文；不使用 `terminate`
- [x] 未配置 key 时放行，并发出一次性的配置提示
- [x] 测试全部通过 factory 接缝驱动，HTTP transport 始终是测试替身，不产生真实网络请求；约束文件 fixture 放在临时目录，不触碰开发者真实的 pi agent 目录
- [x] 测试覆盖：write 超阈值被阻断且 reason 含约束原文、write 低于阈值放行、阈值边界、`edit` 同上、自定义阈值生效、无 key 放行并告警
