# 版本边界说明

本文档定义赛季规则包的时间边界语义。重构（`src/time` / `src/compose` / `src/runtime` 分层）不改变其中任何一条；`npm run compare` 用重构前的黄金轨迹逐字节核对。

## 两个时间戳，两种边界

每个规则包携带两个时间字段，含义严格不同：

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `publishedAt` | 包被发布的时刻（绝对时刻） | 必须严格晚于上一版（`PUBLISH_STALE` / `PUBLISH_SAME_PUBLISHED_AT`） |
| `effectiveFrom` | 包开始对局可见的生效边界 | 不得早于 `publishedAt`（`EFFECTIVE_BEFORE_PUBLICATION`） |

`effectiveFrom` 可写成包时区下的本地墙钟（`YYYY-MM-DDTHH:mm:ss`），由 `src/time/civil.js` 按包的 `timeZone` 解析为绝对时刻；夏令时不存在区间直接拒绝装配（`ROUND_START_NONEXISTENT`），重复区间取较早候选并提示（`ROUND_START_AMBIGUOUS`）。

## 选择规则（赛季切换的业务含义）

在时刻 `t` 创建对局时，候选集为同时满足以下两条的版本，取**版本号最大者**：

1. `effectiveFrom <= t`（生效边界已过）
2. `publishedAt <= t`（发布时刻已过）

这意味着：

- **跨轮换边界**：v1 在 `2026-11-12T00:00+08:00` 生效、v2 在 `2026-11-13T00:00+08:00` 生效时，`2026-11-12T20:00+08:00` 创建的对局永远拿到 v1，`2026-11-13T09:00+08:00` 创建的拿到 v2。边界前后 1 秒的选择结果不同，这是定义行为。
- **发布但未生效**的版本不可见：发布动作本身不改变任何对局可用的规则，只有生效边界到达才改变。
- **对局创建即冻结**：`startMatch` 把选中版本的完整内容（包 + 目录 + 创建时解析出的回合）固化为 pin，之后发布任何版本都够不到它。进行中对局的得分账本在提交时写死，不事后重算。

## 回退是追加，不是删除

`rollback({ toVersion, at, publishedAt })` 重放旧版本的输入生成一个**新版本**（新 digest、新生效边界）。历史版本全部保留，进行中对局仍绑原包；只有生效边界之后创建的对局才使用回退内容。完全相同内容的重复发布不占版本号（`duplicate`）。

## 时钟注入

引擎自身从不读取墙钟。所有"现在"都来自构造时注入的时间源（`timeSource`，任何实现 `now(): number` 的对象）：

- `publish` / `reportResult` / `observations` 的时间戳取自注入源；
- `skipTo` 是时间快进工具，只在注入源支持 `advanceTo` 时可用，否则抛 `TIME_SOURCE_IMMUTABLE`；倒退抛 `CLOCK_BACKWARDS`；
- 缺少时间源时引擎拒绝构造（`TIME_SOURCE_REQUIRED`）。

## 失败不污染现状

候选包在任何阶段被拒绝（装配 `assemble`、快照 `snapshot`、发布守卫 `publish`、回退 `rollback`）都不会改动已发布历史：head 不变、选择结果不变、进行中对局的 pin 与账本不变。拒绝记录进入 `engine.refusals`，由赛季规则界面提示。
