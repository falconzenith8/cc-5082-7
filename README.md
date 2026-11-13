# 赛季规则装配器（season-rules-assembler）

把赛程、地图池限制、得分倍率与允许能力组合成**可执行、可校验、可回退**的规则包，并在比赛运行时按严格边界接入。

这不是活动日历或公告页面：交付物是装配、校验与运行接入三部分——一个纯 Node.js 领域引擎、一个 CLI、一个对局操作图形界面、一份可复现的演示场景，以及覆盖边界条件的测试。

## 快速开始

```bash
node --version        # >= 20
npm test              # 62 项测试
npm run demo          # 完整场景演示（发布、拒绝、快进、并行对局、回退）
npm run ui            # 对局操作图形界面 http://localhost:8080
npm run compare       # 新旧运行对照（与重构前黄金轨迹逐字节比对）
```

无第三方依赖。

## 分层结构

赛季工具拆成四层，各自可独立执行与测试：

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 时间表解析 | `src/time/` | 墙钟/时刻解析（`civil.js`）、显式时间源（`clock.js`）、轮次时间窗解析与纯时间查询（`schedule.js`，无需任何游戏场景） |
| 规则合成 | `src/compose/` | 形状规范化（`normalize.js`）、资源约束检查（`constraints.js`）、摘要（`summary.js`）、装配并冻结规则包（`assemble.js`） |
| 运行（只读接口） | `src/runtime/` | 纯规则解析（`rules.js`）、只读规则视图（`view.js`）、版本存储（`store.js`）、比赛内判定（`match.js`）、引擎门面（`engine.js`）、离线调查（`inspect.js`） |
| 接入 | `cli/`、`ui/`、`scripts/` | CLI 仅辅助赛季规则；图形界面承载对局操作；演示与新旧对照脚本 |

合成层产出的规则包在 `assemble.js` 内即被深冻结（**可冻结的规则包**）；运行侧通过 `RulePackageView`（**只读运行接口**）查询——每个查询都带显式时刻，结果冻结并按 （时刻， 回合） 缓存，缓存挂在视图实例上，不同 digest 永不共享。活动查询返回冻结快照，无法改变正在执行的规则对象。

## 核心不变量

| 不变量 | 实现位置 |
| --- | --- |
| 规则包身份 = 内容指纹，不是人手填写的版本名 | `src/fingerprint.js`, `src/runtime/package.js` |
| 明确时区 + 显式生效边界；跨日按本地墙钟判定 | `src/time/civil.js`, `src/runtime/store.js` |
| 已开始的比赛绑定其创建时的包与回合，之后永不改变 | `src/runtime/match.js`, `src/runtime/engine.js` |
| 活动叠加必须可判定（优先级或互斥），否则拒绝装配 | `src/compose/normalize.js`, `src/runtime/rules.js` |
| 缺失地图/能力定义时拒绝生成可用包 | `src/compose/constraints.js` |
| 回退是追加新版本，不删除历史，不动进行中对局 | `src/runtime/engine.js` |
| 同一套规则解析函数用于装配校验与运行时结算 | `src/runtime/rules.js`（被 `src/compose` 与 `src/runtime` 共用） |
| 引擎不读墙钟；时间源显式注入 | `src/time/clock.js`, `src/runtime/engine.js` |

版本边界（`publishedAt` / `effectiveFrom` / 选择规则 / 回退 / 时钟注入）的完整语义见 [docs/version-boundaries.md](docs/version-boundaries.md)。

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
- 快照校验（`src/runtime/validate.js`）：任何已开始且未结束的对局不得因新发布而改变归属。

任何阶段被拒绝都不污染现状：head 不变、进行中对局不受影响、旧包仍可加载与结算。

## 运行时接入

```js
import { SeasonEngine } from "./src/runtime/engine.js";
import { VirtualClock } from "./src/time/clock.js";

const engine = new SeasonEngine({
  catalog,
  timeSource: new VirtualClock("2026-11-10T00:00:00Z"),  // 显式注入时间来源
});
const published = engine.publish(packageJson);     // status: published | refused | duplicate

// 对局创建时刻决定用包：之后发布的版本够不到它
const match = engine.startMatch({ matchId: "alpha", at: "2026-11-12T20:00:00+08:00" });
engine.reportResult("alpha", { kind: "map-result", side: "a", mapId: "neon-docks", abilityId: "blink" });

engine.skipTo("2026-11-13T09:00:00+08:00");        // 时间快进（驱动注入的时间源）
engine.observations(["alpha", "beta"]);            // 并行视图（只读，返回冻结快照）
engine.compareObservations("alpha", "beta");       // 逐字段差异
engine.timeline(["alpha", "beta"], { from, to });  // 冻结绑定 vs 包当前选择
```

- `startMatch` 会把对局冻结到**唯一的** `pin`（版本 + digest + 内容 + 目录 + 创建时解析出的回合）。`reportResult` 只用 pin 结算；比赛中的得分是提交时写死的账本，不会事后重算。
- 查询类方法（`selectAt` / `inspectRulesAt` / `observations` / `stateAt` / `timeline`）只读：返回冻结快照，不提供可改写执行中规则对象的途径。
- `skipTo` 是时间快进工具；注入源不可驱动时抛 `TIME_SOURCE_IMMUTABLE`，倒退抛 `CLOCK_BACKWARDS`。
- `resolveMatch` 检查 pin 是否仍完整、当前版本是否已推进，并说明"必须继续用哪个版本"。
- `rollback({ toVersion, at, publishedAt })` 以追加方式重放旧输入：新版本、新 digest，但输入分区摘要与源版本一致；进行中对局不受影响。

## 图形入口（对局操作界面）

```bash
npm run ui          # http://localhost:8080（PORT 环境变量可改）
```

对局操作界面把赛季规则操作与对局操作放在同一页面，全部数字由重构后的模块实际运算：

- **赛季规则面板**：载入示例包 / 粘贴规则包 JSON 发布、按时刻调查规则、查看已发布版本与生效边界；发布拒绝、对局异常（如 `MATCH_ABILITY_NOT_ALLOWED`、`CLOCK_BACKWARDS`）都在此面板提示。
- **对局操作面板**：快进赛程、按当前时刻创建对局、上报地图结果；对局画面实时显示规则版本（`vN` + digest 摘要）、冻结回合、得分倍率、允许地图/能力与比分账本。

典型核对流程：发布 v1 → 快进到 `2026-11-12T20:00:00+08:00` → 创建 `alpha` 并上报 → 快进到 `2026-11-13T00:00:00+08:00` 发布 v2 → 快进到 09:00 → 创建 `beta` 并上报 → 两场比赛的对局画面分别显示 v1/v2 规则版本、不同倍率（1.5 vs 0.8）与不同能力白名单。

## CLI（仅辅助赛季规则）

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

`--json` 输出机器可读结构。示例输入位于 `scenarios/inputs/`。CLI 只做赛季规则的装配/发布/调查；创建对局、上报结果、快进赛程等操作请使用上方的图形界面。

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

## 新旧运行对照

`npm run compare` 把当前实现跑出的确定性轨迹与重构前固化的黄金轨迹（`scenarios/expected/runtime-trace.json`）逐字节比对，证明分层重构没有改变赛季切换的业务含义。方法与覆盖范围见 [docs/runtime-comparison.md](docs/runtime-comparison.md)。

## 时区处理

- 本地墙钟统一写成 `YYYY-MM-DDTHH:mm:ss`，由包的 `timeZone`（IANA）解析为绝对时刻；也接受带偏移或 `Z` 的 ISO 时刻。
- 夏令时不存在区间返回 `status: "nonexistent"`；重复区间返回 `"ambiguous"` 并给出两个候选（发布取较早者并提示）。装配遇到不存在区间直接拒绝。
- 已验证跨日：`2026-11-12T23:59:59+08:00` → `2026-11-13T00:00:00+08:00` 恰好 1000ms。

## 测试覆盖

`npm test`（`node:test`，62 项）：

- 跨日启用与 UTC 差异边界
- 衔接空窗（有/无兜底池）
- 缺失地图与缺失能力的拒绝
- 未判定叠加拒绝、priority 生效、互斥阻断
- 版本发布不影响进行中对局；比分账本冻结
- 并行对局跨边界逐字段分歧
- 摘要关联输入配置（含同名不同内容）；独立执行合成层与在线入口摘要一致
- 回退重放输入摘要、进行中对局不受影响
- 降级目录引用失效、重复发布、时间戳未推进、乐观并发
- 时间快进倒退拒绝、夏令时不存在/重复区间
- 时间查询层脱离游戏场景独立测试（`test/schedule.test.js`）
- 只读运行接口：快照冻结、缓存不跨包、错误码传播（`test/view.test.js`）
- 显式时间源注入、拒绝候选后旧包仍可加载（`test/timesource.test.js`）
- 对局操作界面：快进 + 两场对局后画面与规则版本、异常提示（`test/ui.test.js`）
- CLI 装配/发布/调查的退出码与诊断输出
- 时间线冻结语义

## 目录

```
src/time/      时间表解析（civil 墙钟/时刻、clock 时间源、schedule 轮次时间窗）
src/compose/   规则合成（normalize 规范化、constraints 资源约束、summary 摘要、assemble 装配冻结）
src/runtime/   只读运行（rules 解析、view 规则视图、store 版本存储、match 比赛内判定、
               engine 门面、inspect 离线调查、validate 快照校验、timeline、report、package 封存）
cli/           可执行入口（仅辅助赛季规则）
ui/            对局操作图形界面（server + 静态页面）
scenarios/     场景数据、导出输入与黄金轨迹（expected/runtime-trace.json）
scripts/       演示、轨迹生成与新旧对照脚本
docs/          版本边界说明、新旧运行对照
test/          node:test 测试
```
