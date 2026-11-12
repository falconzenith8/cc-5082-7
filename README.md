# 赛季规则装配器（season-rules-assembler）

把赛程、地图池限制、得分倍率与允许能力组合成**可执行、可校验、可回退**的规则包，并在比赛运行时按严格边界接入。

这不是活动日历或公告页面：交付物是装配、校验与运行接入三部分——一个纯 Node.js 领域引擎、一个 CLI、一份可复现的演示场景，以及覆盖边界条件的测试。

## 快速开始

```bash
node --version        # >= 20
npm test              # 36 项测试
npm run demo          # 完整场景演示（发布、拒绝、快进、并行对局、回退）
```

无第三方依赖。

## 核心不变量

| 不变量 | 实现位置 |
| --- | --- |
| 规则包身份 = 内容指纹，不是人手填写的版本名 | `src/fingerprint.js`, `src/package.js` |
| 明确时区 + 显式生效边界；跨日按本地墙钟判定 | `src/time.js`, `src/store.js` |
| 已开始的比赛绑定其创建时的包与回合，之后永不改变 | `src/match.js`, `src/engine.js` |
| 活动叠加必须可判定（优先级或互斥），否则拒绝装配 | `src/normalize.js`, `src/rules.js` |
| 缺失地图/能力定义时拒绝生成可用包 | `src/normalize.js` |
| 回退是追加新版本，不删除历史，不动进行中对局 | `src/engine.js` |
| 同一套规则解析函数用于装配校验与运行时结算 | `src/rules.js` |

## 规则包结构

```jsonc
{
  "id": "season-26-autumn",
  "publishedAt": "2026-11-12T12:00:00",       // 可写本地墙钟或 ISO 时刻
  "effectiveFrom": "2026-11-13T00:00:00",     // 显式生效边界
  "timeZone": "Asia/Shanghai",                // 所有本地墙钟都按此解释
  "defaults": { "mapPoolId": "ranked" },       // 空窗兜底池（可选）
  "mapPool": {
    "ranked": { "maps": ["neon-docks", "highland-pass"], "defaultMap": "neon-docks" }
  },
  "scoring": { "base": 10, "perMapBonus": { "frost-cavern": 2 }, "categories": ["sprint"] },
  "abilities": { "defaultAllowed": true, "allow": [], "deny": ["drone"] },
  "composition": {
    "precedence": "declared",                 // newest | oldest | declared
    "combine": "exclusive",                   // exclusive | multiply
    "allowTies": false,
    "priority": ["sprint", "climber"],        // 声明顺序即优先级
    "exclusions": [{ "a": "sprint", "b": "climber" }]
  },
  "schedule": {
    "rounds": [{
      "id": "sprint",
      "startsAt": "2026-11-12T00:00:00",
      "endsAt": "2026-11-13T00:00:00",
      "mapPoolId": "sprint",
      "winnerCondition": "score",
      "effects": [
        { "kind": "scoring", "multiplier": 1.75, "label": "sprint-bonus" },
        { "kind": "map", "allow": ["neon-docks"], "deny": [], "require": [] },
        { "kind": "ability", "allow": [], "deny": ["blink"] }
      ],
      "abilityOverrides": { "defaultAllowed": null, "allow": [], "deny": [] },
      "requiresAbilities": ["blink"]
    }]
  }
}
```

包被装配后追加 `identity.digest`（对除 identity 外全部内容取 SHA-256）。**同一显示名、不同内容 → 不同 digest**；摘要侧按输入分区（`schedule` / `mapPool` / `scoring` / `abilities` / `composition` / `catalogDigest` / `defaults`）各自计算指纹，用于比较"到底改了什么"。

## 校验与拒绝语义

装配阶段发现以下情况直接拒绝（不产出可用包），并给出结构化 `reasonCodes` 与逐条 `missing` 明细：

- `RESOURCE_REFERENCE_MISSING` — 地图池、地图效果、能力允许/拒绝、`requiresAbilities` 引用了目录里不存在的 `contentId`。
- `ROUND_OVERLAP_UNRESOLVED` — 两轮次时间窗可同时活动，且既未列入 `composition.exclusions`，也无法由 `precedence` 唯一判定（例如同刻开始、未声明 `priority`）。
- `ROUND_START_NONEXISTENT` — 墙钟落在夏令时跳变的不存在区间。
- `PACKAGE_TIMEZONE` / `ROUND_*_INVALID` / `EFFECT_*` 等结构性问题。

仅提示（不阻断）：`SCHEDULE_GAP`、`SCHEDULE_GAP_NO_FALLBACK`、`ROUND_START_AMBIGUOUS`、`ROUND_OVERLAP_SUPERSEDED`、`ROUND_OVERLAP_BLOCKED`。

发布阶段另有守卫：

- `PUBLISHED_AT_REQUIRED` / `PUBLISH_STALE` / `PUBLISH_SAME_PUBLISHED_AT`
- `VERSION_CONFLICT` — 乐观并发：调用方持有的 head digest 已过期。
- `duplicate` — 完全相同内容重复发布不占版本号。
- 快照校验（`src/validate.js`）：任何已开始且未结束的对局不得因新发布而改变归属。

## 运行时接入

```js
import { SeasonEngine } from "./src/engine.js";
import { VirtualClock, resolveLocal } from "./src/time.js";

const engine = new SeasonEngine({ catalog });
engine.clock.set("2026-11-10T00:00:00Z");
const published = engine.publish(packageJson);     // status: published | refused | duplicate

// 对局创建时刻决定用包：之后发布的版本够不到它
const match = engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks", abilityId: "blink" });

engine.clock.advanceTo("2026-11-13T09:00:00+08:00"); // 时间快进
engine.observations(["alpha", "beta"]);             // 并行视图
engine.compareObservations("alpha", "beta");        // 逐字段差异
engine.timeline(["alpha", "beta"], { from, to });   // 冻结绑定 vs 包当前选择
```

- `StartMatch` 会把对局冻结到**唯一的** `pin`（版本 + digest + 内容 + 目录 + 创建时解析出的回合）。`reportResult` 只用 pin 结算；比赛中的得分是提交时写死的账本，不会事后重算。
- `skipTo` 是时间快进工具；倒退会抛 `CLOCK_BACKWARDS`。
- `resolveMatch` 检查 pin 是否仍完整、当前版本是否已推进，并说明"必须继续用哪个版本"。
- `rollback({ toVersion, at, publishedAt })` 以追加方式重放旧输入：新版本、新 digest，但输入分区摘要与源版本一致；进行中对局不受影响。

## 时区处理

- 本地墙钟统一写成 `YYYY-MM-DDTHH:mm:ss`，由包的 `timeZone`（IANA）解析为绝对时刻；也接受带偏移或 `Z` 的 ISO 时刻。
- 夏令时不存在区间返回 `status: "nonexistent"`；重复区间返回 `"ambiguous"` 并给出两个候选（发布取较早者并提示）。装配遇到不存在区间直接拒绝。
- 已验证跨日：`2026-11-12T23:59:59+08:00` → `2026-11-13T00:00:00+08:00` 恰好 1000ms。

## CLI

```bash
# 装配并校验单个包（拒绝时退出码 2）
node cli/season-rules.js assemble scenarios/inputs/v1.json --catalog scenarios/inputs/catalog.json

# 按发布时间顺序发布多个候选项，逐个报告
node cli/season-rules.js publish scenarios/inputs/catalog.json \
  scenarios/inputs/v1.json scenarios/inputs/v2.json scenarios/inputs/invalid-resource.json

# 查看某时刻生效的规则（不创建对局）
node cli/season-rules.js inspect scenarios/inputs/catalog.json scenarios/inputs/v2.json \
  --at "2026-11-13T09:00:00"
```

`--json` 输出机器可读结构。示例输入位于 `scenarios/inputs/`。

## 演示场景

`npm run demo` 依次输出：

1. v1 装配与跨日生效边界（`2026-11-12T00:00+08:00`）。
2. 缺失地图/能力的候选被拒绝，并列出 `missing`。
3. 未声明优先级的并列重叠被拒绝；显式 `priority` 可装配；`exclusions` 互斥可在装配通过但运行时阻断叠加。
4. 时表空窗的显式提示（含无兜底池警示）。
5. 时间快进跨过轮换边界，`alpha`（v1，sprint）与 `beta`（v2，climber）同时进行。
6. 并行比较：版本、digest、回合、倍率、地图、能力、比分逐项不同。
7. 摘要按输入配置比较——显示名相同而内容不同，digest 与输入摘要不同。
8. 回退为追加版本：输入摘要等于源版本，进行中对局仍绑原包。
9. 降级内容目录使引用失效的候选被拒绝。
10. 同一地图在 v1/v2 下得分确实不同（15 vs 8），能力白名单也不同。
11. 时间线视图把"冻结绑定"与"包当前会选什么"并列展示。
12. 引擎历史与拒绝记录。

## 测试覆盖

`npm test`（`node:test`）：

- 跨日启用与 UTC 差异边界
- 衔接空窗（有/无兜底池）
- 缺失地图与缺失能力的拒绝
- 未判定叠加拒绝、priority 生效、互斥阻断
- 版本发布不影响进行中对局；比分账本冻结
- 并行对局跨边界逐字段分歧
- 摘要关联输入配置（含同名不同内容）
- 回退重放输入摘要、进行中对局不受影响
- 降级目录引用失效、重复发布、时间戳未推进、乐观并发
- 时间快进倒退拒绝、夏令时不存在/重复区间
- CLI 装配/发布/调查的退出码与诊断输出
- 时间线冻结语义

## 目录

```
src/       领域引擎（时间、指纹、目录、规范化、规则、存储、比赛、引擎、报告、时间线）
cli/       可执行入口
scenarios/ 场景数据与导出输入
scripts/   演示脚本
test/      node:test 测试
```
