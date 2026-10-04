import { format } from "date-fns";
import type { PlanStatus, ShuttlePlan, Station } from "../store/incident";

/** 线网中心推送类型 */
export type PushKind = "区段停运" | "预计恢复";

/** 线网中心外部推送（externalId 为线网侧编号，是入账幂等键） */
export interface ExternalPush {
  externalId: string;
  kind: PushKind;
  sectionId: string;
  sectionName: string;
  /** 推送涉及的本地车站 id，用于现场状态比对和恢复结论失效范围 */
  stationIds: string[];
  /** 预计恢复时间（预计恢复推送必填） */
  eta?: string;
  reason?: string;
  pushedAt: string;
}

export type DiscrepancyType = "现场状态不一致" | "接驳计划不一致";
export type DiscrepancyStatus = "待核" | "已核实" | "已忽略";

/** 对账差异：外部口径与本地记录对不上时留痕，以本地记录为准，不自动改本地 */
export interface Discrepancy {
  id: string;
  externalId: string;
  type: DiscrepancyType;
  scopeId: string;
  scopeName: string;
  external: string;
  local: string;
  status: DiscrepancyStatus;
  createdAt: string;
  resolvedAt?: string;
  note?: string;
}

/** 外部推送入账记录：同一 externalId 全局只出现一次 */
export interface LedgerEntry {
  externalId: string;
  push: ExternalPush;
  bookedAt: string;
  source: "在线入账" | "回网合并";
  discrepancyIds: string[];
}

/** 预计恢复结论：本地车站状态一旦变化，命中范围的结论立即作废 */
export interface RecoveryConclusion {
  id: string;
  externalId: string;
  sectionId: string;
  sectionName: string;
  stationIds: string[];
  eta?: string;
  valid: boolean;
  createdAt: string;
  invalidatedAt?: string;
  invalidReason?: string;
}

/** 断网期间暂存本地的推送，回网后按外部编号合并重试 */
export interface InboxPush {
  id: string;
  push: ExternalPush;
  receivedAt: string;
  attempts: number;
  lastError?: string;
}

/** 区段认领记录（调度台先到先得） */
export interface SectionClaim {
  sectionId: string;
  desk: string;
  claimedAt: string;
  /** 认领请求的实际到达时刻，并发裁决只认它 */
  arrivedAt: number;
}

export const SECTION_CATALOG = [
  { sectionId: "SEC-CB", sectionName: "中心—滨江区间", stationIds: ["s1"] },
  { sectionId: "SEC-HJ", sectionName: "会展—滨江区间", stationIds: ["s2"] },
  { sectionId: "SEC-BD", sectionName: "滨江—东港区间", stationIds: ["s3"] }
] as const;

const ACTIVE_PLAN_STATUSES: PlanStatus[] = ["待确认", "已确认", "已执行"];

const defaultClock = () => new Date().toISOString();
const defaultId = () => crypto.randomUUID();

export interface BookContext {
  stations: Station[];
  plans: ShuttlePlan[];
  source?: LedgerEntry["source"];
  clock?: () => string;
  id?: () => string;
}

export type BookResult =
  | { duplicate: true; entry: LedgerEntry }
  | { duplicate: false; entry: LedgerEntry; discrepancies: Discrepancy[]; recovery?: RecoveryConclusion };

/**
 * 外部推送入账。
 * 规则：外部编号只入账一次；现场状态、接驳计划以本地记录为准，对不上留成差异；
 * 预计恢复推送在无差异时给出有效恢复结论。
 */
export function bookPush(push: ExternalPush, ledger: LedgerEntry[], ctx: BookContext): BookResult {
  const existing = ledger.find((entry) => entry.externalId === push.externalId);
  if (existing) return { duplicate: true, entry: existing };

  const clock = ctx.clock ?? defaultClock;
  const id = ctx.id ?? defaultId;
  const ts = clock();
  const discrepancies: Discrepancy[] = [];

  // 1) 现场状态以本地车站记录为准
  push.stationIds.forEach((sid) => {
    const station = ctx.stations.find((item) => item.id === sid);
    if (!station) {
      discrepancies.push({ id: id(), externalId: push.externalId, type: "现场状态不一致", scopeId: sid, scopeName: sid, external: "线网：区段涉及该车站", local: "本地：无此车站", status: "待核", createdAt: ts });
      return;
    }
    if (push.kind === "区段停运" && station.status !== "封闭") {
      discrepancies.push({ id: id(), externalId: push.externalId, type: "现场状态不一致", scopeId: station.id, scopeName: station.name, external: "线网：区段已停运，车站应封闭", local: `现场：${station.status}运营`, status: "待核", createdAt: ts });
    }
    if (push.kind === "预计恢复" && (station.status === "封闭" || station.status === "限流")) {
      const etaText = push.eta ? format(new Date(push.eta), "HH:mm") : "—";
      discrepancies.push({ id: id(), externalId: push.externalId, type: "现场状态不一致", scopeId: station.id, scopeName: station.name, external: `线网：预计 ${etaText} 恢复行车`, local: `现场：车站仍为「${station.status}」`, status: "待核", createdAt: ts });
    }
  });

  // 2) 计划执行以本地接驳计划为准：停运区段理应有在执行的接驳安排
  if (push.kind === "区段停运") {
    const names = push.stationIds.map((sid) => ctx.stations.find((item) => item.id === sid)?.name ?? sid);
    const covered = ctx.plans.some((plan) => ACTIVE_PLAN_STATUSES.includes(plan.status) && plan.stations.some((name) => names.includes(name)));
    if (!covered) {
      discrepancies.push({ id: id(), externalId: push.externalId, type: "接驳计划不一致", scopeId: push.sectionId, scopeName: push.sectionName, external: "线网：区段停运需安排公交接驳", local: "本地：无在执行的接驳计划", status: "待核", createdAt: ts });
    }
  }

  const entry: LedgerEntry = {
    externalId: push.externalId,
    push,
    bookedAt: ts,
    source: ctx.source ?? "在线入账",
    discrepancyIds: discrepancies.map((item) => item.id)
  };

  let recovery: RecoveryConclusion | undefined;
  if (push.kind === "预计恢复") {
    recovery = {
      id: id(),
      externalId: push.externalId,
      sectionId: push.sectionId,
      sectionName: push.sectionName,
      stationIds: push.stationIds,
      eta: push.eta,
      valid: discrepancies.length === 0,
      createdAt: ts,
      invalidReason: discrepancies.length ? "现场状态或接驳计划与推送不一致，暂不能恢复" : undefined
    };
  }

  return { duplicate: false, entry, discrepancies, recovery };
}

export interface DrainResult {
  /** 合并完成后的完整台账（保持最新在前） */
  ledger: LedgerEntry[];
  entries: LedgerEntry[];
  discrepancies: Discrepancy[];
  recoveries: RecoveryConclusion[];
  /** 与已入账记录撞号、被丢弃的重复推送 */
  mergedDuplicates: ExternalPush[];
}

/**
 * 回网后合并断网收件箱：
 * 收件箱内同外部编号先自行去重（保留最早一条），再按接收顺序入账；
 * 已入账的编号丢弃，没入账的全部入账（调用方负责失败重试）。
 */
export function drainInbox(inbox: InboxPush[], ledger: LedgerEntry[], ctx: BookContext): DrainResult {
  const earliest = new Map<string, InboxPush>();
  inbox.forEach((item) => {
    const prev = earliest.get(item.push.externalId);
    if (!prev || item.receivedAt < prev.receivedAt) earliest.set(item.push.externalId, item);
  });

  const ordered = [...earliest.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const entries: LedgerEntry[] = [];
  const discrepancies: Discrepancy[] = [];
  const recoveries: RecoveryConclusion[] = [];
  const mergedDuplicates: ExternalPush[] = [];
  let working = [...ledger];

  for (const item of ordered) {
    const res = bookPush(item.push, working, { ...ctx, source: "回网合并" });
    if (res.duplicate) {
      mergedDuplicates.push(item.push);
      continue;
    }
    working = [res.entry, ...working];
    entries.push(res.entry);
    discrepancies.push(...res.discrepancies);
    if (res.recovery) recoveries.push(res.recovery);
  }

  return { ledger: working, entries, discrepancies, recoveries, mergedDuplicates };
}

/**
 * 本地车站状态变化时，命中该站的有效恢复结论立刻作废。
 * 已作废的保留首次作废原因，不覆盖。
 */
export function invalidateConclusions(conclusions: RecoveryConclusion[], station: Station, clock: () => string = defaultClock): RecoveryConclusion[] {
  return conclusions.map((conclusion) =>
    conclusion.valid && conclusion.stationIds.includes(station.id)
      ? { ...conclusion, valid: false, invalidatedAt: clock(), invalidReason: `本地车站状态变化：${station.name} → ${station.status}` }
      : conclusion
  );
}

export interface ClaimResult {
  claims: SectionClaim[];
  won: boolean;
  holder: string;
  /** 被更早到达挤掉的原持有台（迟到的更早时间戳覆盖场景） */
  replaced?: string;
}

/**
 * 区段认领 CAS：只比较请求到达时刻，与处理顺序无关。
 * 先到的生效；同台重复认领幂等；后到的拒绝。
 */
export function applyClaim(claims: SectionClaim[], sectionId: string, desk: string, arrivedAt: number, clock: () => string = defaultClock): ClaimResult {
  const current = claims.find((claim) => claim.sectionId === sectionId);
  if (current?.desk === desk) return { claims, won: true, holder: desk };
  if (!current || arrivedAt < current.arrivedAt) {
    const claim: SectionClaim = { sectionId, desk, arrivedAt, claimedAt: clock() };
    return { claims: [...claims.filter((item) => item.sectionId !== sectionId), claim], won: true, holder: desk, replaced: current?.desk };
  }
  return { claims, won: false, holder: current.desk };
}

export interface ContestResult {
  claims: SectionClaim[];
  winner?: string;
  rejected: string[];
}

/**
 * 模拟两个调度台同时认领：故意后处理"先到"的请求，
 * 验证裁决只取决于到达时刻、不取决于处理顺序。
 */
export function contestSection(claims: SectionClaim[], sectionId: string, earlierDesk: string, laterDesk: string, base: number, clock: () => string = defaultClock): ContestResult {
  const later = applyClaim(claims, sectionId, laterDesk, base + 1, clock);
  const earlier = applyClaim(later.claims, sectionId, earlierDesk, base, clock);
  const holder = earlier.claims.find((claim) => claim.sectionId === sectionId)?.desk;
  const tried = [earlierDesk, laterDesk];
  return { claims: earlier.claims, winner: holder, rejected: tried.filter((desk) => desk !== holder) };
}
