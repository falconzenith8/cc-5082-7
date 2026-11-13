# 新旧运行对照

## 方法

重构前（提交 `7d98d85` 之前的扁平 `src/*.js` 实现）运行 `scripts/runtime-trace.js`，把完整演示场景的确定性轨迹固化为黄金文件 `scenarios/expected/runtime-trace.json`（106783 字节）。重构后同一脚本改为从分层后的模块（`src/time`、`src/compose`、`src/runtime`）导入，场景逻辑一字未动。

`npm run compare`（即 `scripts/compare-runtime.js`）重新生成轨迹并与黄金文件逐字节比对；任何差异都按字段路径列出并以退出码 1 失败。

## 轨迹覆盖的业务行为

- 独立装配（合成层离线入口）的 digest、输入摘要、告警
- v1/v2 发布与跨日生效边界（`2026-11-12T00:00+08:00` 前后、UTC 与本地日不一致的临界）
- 拒绝诊断：缺失资源（逐条 `missing`）、未判定叠加、显式优先级、互斥、空窗提示
- 跨轮换边界的两场并行对局：采用版本、冻结回合、得分账本、允许地图/能力
- 并行对局逐字段比较、时刻规则调查（在线与离线两个入口）
- 并行对局时间线（冻结绑定 vs 包当前选择）
- 回退（追加式）与 `resolveMatch` 诊断
- 降级目录导致的快照拒绝
- 引擎历史与拒绝记录
- 夏令时不存在/重复区间、跨日 1 秒推进

## 结果

```
$ npm run compare
runtime comparison: IDENTICAL (106783 bytes, golden scenarios/expected/runtime-trace.json)
```

重构前后轨迹**逐字节一致**：时间表解析、规则合成、资源约束检查、比赛内判定拆分为独立模块后，赛季切换的业务含义（选择规则、冻结语义、优先级与冲突诊断、得分与能力判定）没有任何改变。

## 复现

```bash
npm run compare     # 重新生成轨迹并比对黄金文件
npm run trace       # 只生成当前实现的轨迹（标准输出）
```

若有意变更行为：先更新实现与测试，再以 `npm run trace > scenarios/expected/runtime-trace.json` 重新固化基线，并在提交信息中说明变更点。
