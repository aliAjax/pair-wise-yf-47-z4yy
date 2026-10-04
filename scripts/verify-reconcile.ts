import { bookPush, drainInbox, invalidateConclusions, applyClaim, contestSection, type ExternalPush } from "../lib/reconcile";
import type { Station, ShuttlePlan } from "../store/incident";

let pass = 0;
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } pass++; console.log("PASS:", msg); };

let clockN = 0;
const clock = () => new Date(1_700_000_000_000 + clockN++ * 1000).toISOString();
let idN = 0;
const id = () => `id-${++idN}`;

const stations: Station[] = [
  { id: "s1", name: "滨江站", section: "a", status: "封闭", passengerRisk: "高", note: "", updatedAt: clock() },
  { id: "s2", name: "会展中心站", section: "b", status: "限流", passengerRisk: "中", note: "", updatedAt: clock() },
  { id: "s3", name: "东港站", section: "c", status: "正常", passengerRisk: "低", note: "", updatedAt: clock() }
];
const plans: ShuttlePlan[] = [{ id: "p1", stations: ["滨江站"], vehicles: 4, interval: 6, operator: "东城公交", status: "已执行", approvals: ["调度员"], note: "" }];

const ctx = { stations, plans, clock, id };

const suspendS1: ExternalPush = { externalId: "NET-1", kind: "区段停运", sectionId: "SEC-CB", sectionName: "中心—滨江", stationIds: ["s1"], pushedAt: clock() };
const r1 = bookPush(suspendS1, [], ctx);
assert(!r1.duplicate && r1.entry.externalId === "NET-1", "规则1: 首次推送入账");
assert(!r1.duplicate && r1.discrepancies.length === 0, "规则2a: 现场封闭+有接驳计划 -> 无差异");

// 相同外部编号再来（哪怕重发类型一致），只入账一次
const r1b = bookPush({ ...suspendS1, reason: "重发" }, [r1.duplicate ? null! : r1.entry].filter(Boolean) as any, ctx);
assert(r1b.duplicate && r1b.entry.source === "在线入账", "规则1: 相同外部编号重复推送不重复入账");

// 对不上：会展站限流但线网要求停运封闭
const suspendS2: ExternalPush = { externalId: "NET-2", kind: "区段停运", sectionId: "SEC-HJ", sectionName: "会展—滨江", stationIds: ["s2"], pushedAt: clock() };
const r2 = bookPush(suspendS2, [], ctx);
assert(!r2.duplicate && r2.discrepancies.some((d) => d.type === "现场状态不一致"), "规则2b: 现场限流 vs 线网停运 -> 留现场差异，不回写本地");
assert(stations[1].status === "限流", "规则2: 本地记录不被外部覆盖");

// 东港：正常 + 无接驳计划 -> 现场 + 计划双差异
const suspendS3: ExternalPush = { externalId: "NET-3", kind: "区段停运", sectionId: "SEC-BD", sectionName: "滨江—东港", stationIds: ["s3"], pushedAt: clock() };
const r3 = bookPush(suspendS3, [], ctx);
assert(!r3.duplicate && r3.discrepancies.length === 2, "规则2c: 正常车站+无接驳计划 -> 现场、计划两条差异");

// 预计恢复：站点已恢复中（非封闭/限流）-> 有效结论
stations[0] = { ...stations[0], status: "恢复中" };
const eta = clock();
const resume: ExternalPush = { externalId: "NET-4", kind: "预计恢复", sectionId: "SEC-CB", sectionName: "中心—滨江", stationIds: ["s1"], eta, pushedAt: clock() };
const r4 = bookPush(resume, [], { ...ctx, stations });
assert(!r4.duplicate && !!r4.recovery && r4.recovery.valid, "规则3a: 预计恢复无差异 -> 恢复结论有效");

// 预计恢复撞上仍限流的会展站 -> 差异 + 结论无效
const resumeBlocked: ExternalPush = { externalId: "NET-5", kind: "预计恢复", sectionId: "SEC-HJ", sectionName: "会展—滨江", stationIds: ["s2"], eta, pushedAt: clock() };
const r5 = bookPush(resumeBlocked, [], ctx);
assert(!r5.duplicate && !!r5.recovery && !r5.recovery.valid, "规则3b: 现场仍限流 -> 恢复结论无效");

// 本地车站状态一变，命中的恢复结论立刻作废
const conclusions = [r4.duplicate ? null! : r4.recovery!, r5.duplicate ? null! : r5.recovery!].filter(Boolean);
stations[0] = { ...stations[0], status: "封闭", note: "再次积水", updatedAt: clock() };
const invalidated = invalidateConclusions(conclusions, stations[0], clock);
assert(invalidated[0].valid === false && !!invalidated[0].invalidatedAt, "规则3c: 本地车站状态一变 -> 恢复结论立即作废");
assert(invalidated[1].valid === false, "规则3c: 原本无效结论保持不变");

// 断网收件箱：含两个相同外部编号 + 一个与已入账撞号
const inbox = [
  { id: "x1", push: suspendS2, receivedAt: new Date(2000).toISOString(), attempts: 1 },
  { id: "x2", push: suspendS2, receivedAt: new Date(1000).toISOString(), attempts: 1 }, // 同编号更早
  { id: "x3", push: suspendS1, receivedAt: new Date(3000).toISOString(), attempts: 1 }  // 已入账
];
const drained = drainInbox(inbox, [r1.duplicate ? null! : r1.entry].filter(Boolean) as any, { stations, plans, clock, id });
assert(drained.entries.length === 1 && drained.entries[0].externalId === "NET-2", "规则4a: 回网合并同编号去重，只入账一次");
assert(drained.entries[0].source === "回网合并", "规则4b: 来源标记为回网合并");
assert(drained.mergedDuplicates.length === 1 && drained.mergedDuplicates[0].externalId === "NET-1", "规则4c: 已入账编号在合并时丢弃");
assert(drained.ledger[0].externalId === "NET-2", "规则4d: 未入账推送继续入账成功");

// 认领 CAS：后处理的更早请求也能生效
let claims = applyClaim([], "SEC-HJ", "2号调度台", 2000, clock);
assert(claims.won && claims.holder === "2号调度台", "规则5a: 2号台先处理且先到 -> 生效");
const c2 = applyClaim(claims.claims, "SEC-HJ", "1号调度台", 1000, clock);
assert(c2.won && c2.holder === "1号调度台" && c2.replaced === "2号调度台", "规则5b: 到达更早的票据即使后处理也胜出（与处理顺序无关）");
const c3 = applyClaim(c2.claims, "SEC-HJ", "2号调度台", 3000, clock);
assert(!c3.won && c3.holder === "1号调度台", "规则5c: 后到请求被拒绝");
const c4 = applyClaim(c3.claims, "SEC-HJ", "1号调度台", 9999, clock);
assert(c4.won && c4.holder === "1号调度台", "规则5d: 同持有台重复认领幂等");

// 同时认领票据：故意先处理晚到的
const contest = contestSection([], "SEC-HJ", "1号调度台", "2号调度台", 5000, clock);
assert(contest.winner === "1号调度台" && contest.rejected.includes("2号调度台"), "规则5e: 两台同时认领只让先到的生效");

console.log(`\n全部 ${pass} 条断言通过`);
