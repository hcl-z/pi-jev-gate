# 06: 降级矩阵

**What to build:** 这个守卫是约束顾问，不是安全边界。网络抖一下、TypeSafe 限流、响应体解析失败——任何一种情况都不该让开发者改不了文件。所有异常一律放行，但必须带告警：他绝不能把「守卫没发现问题」和「守卫压根没跑」搞混。`pi -p` 和 JSON 模式下没有对话框可弹，结论注定是放行，所以连请求都不该发——为一个已知结果付费是浪费。另外，检查过程中按 Esc 应当取消在飞的请求，而不是让他干等一个已经不关心的网络调用。

**Blocked by:** 01, 05

**Status:** done

- [x] 网络失败、超时、HTTP 401/422/429/529 及其他错误状态、响应体无法解析——全部放行并发出告警
- [x] 约束清单为空时放行且**静默**，不发告警（见下方说明）
- [x] 请求设短超时并单次重试
- [x] 无交互 UI 时（print / JSON 模式）放行，且完全不构造请求、不调用 API
- [x] 将 pi 当前的 agent abort signal 传入 HTTP 调用，Esc 可取消在飞判断
- [x] abort 触发时结束本次检查且不阻断调用
- [x] 每次降级放行都对用户可见
- [x] 测试覆盖：网络错误、超时、各相关 HTTP 状态码、响应体畸形——逐项断言放行且有告警；无 UI 模式额外断言无请求产生；abort 后不阻断

## 澄清：约束清单为空不算降级

本 ticket 原先要求「约束清单为空」也发告警，这与 PRD user story 16 冲突：

> As a developer with no constraints file, I want the guard to stay completely
> silent and never call the API, so that installing it globally costs nothing in
> projects that don't use it.

Story 16 优先。这个插件预期被全局安装，而多数项目没有 `constraints.md`；若此时每次写文件都告警，用户会立刻卸载。没有约束不是故障，是「这个项目不用这个功能」，因此静默。

真正的降级（网络、限流、响应畸形）仍然必须告警，因为那些情况下用户**期待**检查发生却没发生。
