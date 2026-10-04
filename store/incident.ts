import { create } from "zustand";
import { persist } from "zustand/middleware";
import { format } from "date-fns";
import {
  bookPush,
  drainInbox,
  invalidateConclusions,
  applyClaim,
  contestSection,
  SECTION_CATALOG,
  type ExternalPush,
  type LedgerEntry,
  type Discrepancy,
  type RecoveryConclusion,
  type InboxPush,
  type SectionClaim
} from "../lib/reconcile";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type TimelineActor = Role | "线网中心" | "系统";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: TimelineActor;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: string[];
  note: string;
}

export interface PendingAction {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export type IngestResult =
  | { outcome: "duplicate"; externalId: string; bookedAt: string }
  | { outcome: "booked"; externalId: string; discrepancies: number; source: LedgerEntry["source"] }
  | { outcome: "stored"; externalId: string; inboxCount: number };

export interface RetryResult {
  booked: number;
  duplicates: number;
  remaining: number;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  // —— 外部推送事件对账 ——
  ledger: LedgerEntry[];
  discrepancies: Discrepancy[];
  conclusions: RecoveryConclusion[];
  inbox: InboxPush[];
  claims: SectionClaim[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: string) => void;
  executePlan: (id: string) => void;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
  /** 接收线网中心推送：在线入账（外部编号只入账一次），断网先进本地收件箱 */
  ingestPush: (push: ExternalPush) => IngestResult;
  /** 回网合并/手动重试：按外部编号去重后把收件箱入账，未成功的留下继续重试 */
  retryInbox: () => RetryResult;
  /** 调度台认领区段，先到先得（arrivedAt 为请求到达时刻） */
  claimSection: (sectionId: string, desk: string, arrivedAt: number) => { won: boolean; holder: string; replaced?: string };
  /** 两个调度台同时认领同一区段的并发票据裁决 */
  contestClaim: (sectionId: string, earlierDesk: string, laterDesk: string, base: number) => { winner?: string; rejected: string[] };
  releaseClaim: (sectionId: string, desk: string) => void;
  resolveDiscrepancy: (id: string, status: Exclude<Discrepancy["status"], "待核">, note?: string) => void;
}

const now = () => new Date().toISOString();

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

const seedPlans: ShuttlePlan[] = [
  { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
];

// 对账台账种子：线网一条中心—滨江停运推送已按外部编号入账，现场与本地接驳计划一致
const seedPush: ExternalPush = {
  externalId: "NET-20260929-1107",
  kind: "区段停运",
  sectionId: "SEC-CB",
  sectionName: "中心—滨江区间",
  stationIds: ["s1"],
  reason: "区间水位超限",
  pushedAt: new Date(Date.now() - 31 * 60000).toISOString()
};
const seedBook = bookPush(seedPush, [], {
  stations: seedStations,
  plans: seedPlans,
  source: "在线入账",
  clock: () => new Date(Date.now() - 30 * 60000).toISOString(),
  id: (() => { let n = 0; return () => `seed-${++n}`; })()
});
const seedLedger: LedgerEntry[] = seedBook.duplicate ? [] : [seedBook.entry];
const seedDiscrepancies: Discrepancy[] = seedBook.duplicate ? [] : seedBook.discrepancies;

export const useIncidentStore = create<IncidentState>()(persist((set, get) => ({
  incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
  stations: seedStations,
  timeline: [
    { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
    { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" },
    { id: "e3", time: new Date(Date.now() - 30 * 60000).toISOString(), actor: "线网中心", action: "外部推送入账", detail: `区段停运 ${seedPush.externalId}：${seedPush.sectionName}，现场状态与接驳计划核对一致`, phase: "响应" }
  ],
  plans: seedPlans,
  role: "调度员",
  online: true,
  pendingActions: [],
  ledger: seedLedger,
  discrepancies: seedDiscrepancies,
  conclusions: [],
  inbox: [],
  claims: [],
  setRole: (role) => set({ role }),
  // 回网时自动按外部编号合并本地收件箱；断网只切状态
  setOnline: (online) => {
    if (!online) { set({ online }); return; }
    get().retryInbox();
    set({ online });
  },
  // 本地车站现场状态为准：状态一变，命中区段的恢复结论立刻作废
  setStationStatus: (id, status, note) => set((state) => {
    const station = state.stations.find((item) => item.id === id);
    if (!station) return state;
    const updated: Station = { ...station, status, note: note ?? station.note, updatedAt: now() };
    const conclusions = invalidateConclusions(state.conclusions, updated);
    const invalidated = state.conclusions.filter((c) => c.valid && conclusions.find((n) => n.id === c.id)?.valid === false);
    const timeline: TimelineEntry[] = [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "更新车站状态", detail: `${station.name} → ${status}`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" }, ...state.timeline];
    invalidated.forEach((c) => {
      timeline.unshift({ id: crypto.randomUUID(), time: now(), actor: "系统", action: "恢复结论作废", detail: `外部推送 ${c.externalId} 的恢复结论因${station.name}状态变为「${status}」立即作废`, phase: "响应" });
    });
    return {
      stations: state.stations.map((item) => item.id === id ? updated : item),
      conclusions,
      timeline,
      pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: "更新车站状态", detail: `${station.name} → ${status}`, time: now() }, ...state.pendingActions]
    };
  }),
  addTimeline: (entry) => set((state) => ({ timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline], pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: entry.action, detail: entry.detail, time: now() }, ...state.pendingActions] })),
  addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] }, ...state.plans] })),
  submitPlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "待确认" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" }, ...state.timeline] })),
  approvePlan: (id, approver) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, approvals: Array.from(new Set([...plan.approvals, approver])), status: plan.approvals.length >= 1 ? "已确认" : plan.status } : plan) })),
  executePlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "已执行" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" }, ...state.timeline] })),
  queueAction: (action, detail) => set((state) => ({ pendingActions: [{ id: crypto.randomUUID(), action, detail, time: now() }, ...state.pendingActions] })),
  syncActions: () => set({ pendingActions: [] }),
  ingestPush: (push) => {
    const state = get();
    // 断网：先记在本地收件箱，回网后合并
    if (!state.online) {
      const inbox = [...state.inbox, { id: crypto.randomUUID(), push, receivedAt: now(), attempts: 0 }];
      set({ inbox, timeline: [{ id: crypto.randomUUID(), time: now(), actor: "线网中心", action: "外部推送本地暂存", detail: `${push.kind} ${push.externalId}：断网期间先记本地，回网后按外部编号合并`, phase: "响应" }, ...state.timeline] });
      return { outcome: "stored", externalId: push.externalId, inboxCount: inbox.length };
    }
    const res = bookPush(push, state.ledger, { stations: state.stations, plans: state.plans });
    if (res.duplicate) {
      set({ timeline: [{ id: crypto.randomUUID(), time: now(), actor: "系统", action: "外部推送重复忽略", detail: `${push.kind} ${push.externalId} 已于 ${formatTs(res.entry.bookedAt)} 入账（${res.entry.source}），不再重复入账`, phase: "响应" }, ...state.timeline] });
      return { outcome: "duplicate", externalId: push.externalId, bookedAt: res.entry.bookedAt };
    }
    const timeline: TimelineEntry[] = [{
      id: crypto.randomUUID(),
      time: now(),
      actor: "线网中心",
      action: "外部推送入账",
      detail: `${push.kind} ${push.externalId}：${push.sectionName}${res.discrepancies.length ? `，留差异 ${res.discrepancies.length} 条待核（现场/计划以本地为准）` : "，与本地记录核对一致"}`,
      phase: push.kind === "预计恢复" ? "恢复" : "响应"
    }, ...state.timeline];
    if (res.recovery) {
      timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: "系统",
        action: res.recovery.valid ? "形成恢复结论" : "恢复结论受限",
        detail: res.recovery.valid
          ? `预计 ${res.recovery.eta ? formatTs(res.recovery.eta) : "—"} 恢复行车，结论有效；本地车站状态一旦变化立即作废`
          : `外部预计恢复 ${push.externalId} 存在对账差异，暂不能形成有效恢复结论`,
        phase: "恢复"
      });
    }
    set({
      ledger: [res.entry, ...state.ledger],
      discrepancies: [...res.discrepancies, ...state.discrepancies],
      conclusions: res.recovery ? [res.recovery, ...state.conclusions] : state.conclusions,
      timeline
    });
    return { outcome: "booked", externalId: push.externalId, discrepancies: res.discrepancies.length, source: "在线入账" };
  },
  retryInbox: () => {
    const state = get();
    if (!state.inbox.length) return { booked: 0, duplicates: 0, remaining: 0 };
    const result = drainInbox(state.inbox, state.ledger, { stations: state.stations, plans: state.plans });
    const timeline: TimelineEntry[] = [];
    result.entries.forEach((entry) => {
      timeline.push({ id: crypto.randomUUID(), time: now(), actor: "线网中心", action: "外部推送回网合并入账", detail: `${entry.push.kind} ${entry.externalId}：${entry.push.sectionName}（断网本地暂存，回网合并入账）`, phase: entry.push.kind === "预计恢复" ? "恢复" : "响应" });
    });
    result.recoveries.forEach((recovery) => {
      timeline.unshift({ id: crypto.randomUUID(), time: now(), actor: "系统", action: recovery.valid ? "形成恢复结论" : "恢复结论受限", detail: recovery.valid ? `预计 ${recovery.eta ? formatTs(recovery.eta) : "—"} 恢复行车，结论有效；本地车站状态一旦变化立即作废` : `外部预计恢复 ${recovery.externalId} 存在对账差异，暂不能形成有效恢复结论`, phase: "恢复" });
    });
    result.mergedDuplicates.forEach((push) => {
      timeline.push({ id: crypto.randomUUID(), time: now(), actor: "系统", action: "外部推送重复丢弃", detail: `${push.kind} ${push.externalId} 在断网前已入账，回网合并时按外部编号丢弃`, phase: "响应" });
    });
    set({
      ledger: result.ledger,
      discrepancies: [...result.discrepancies, ...state.discrepancies],
      conclusions: [...result.recoveries, ...state.conclusions],
      inbox: [],
      timeline: [...timeline, ...state.timeline]
    });
    return { booked: result.entries.length, duplicates: result.mergedDuplicates.length, remaining: 0 };
  },
  claimSection: (sectionId, desk, arrivedAt) => {
    const res = applyClaim(get().claims, sectionId, desk, arrivedAt);
    set({ claims: res.claims });
    return { won: res.won, holder: res.holder, replaced: res.replaced };
  },
  contestClaim: (sectionId, earlierDesk, laterDesk, base) => {
    const res = contestSection(get().claims, sectionId, earlierDesk, laterDesk, base);
    set({ claims: res.claims });
    return { winner: res.winner, rejected: res.rejected };
  },
  releaseClaim: (sectionId, desk) => set((state) => ({ claims: state.claims.filter((claim) => !(claim.sectionId === sectionId && claim.desk === desk)) })),
  resolveDiscrepancy: (id, status, note) => set((state) => ({
    discrepancies: state.discrepancies.map((item) => item.id === id ? { ...item, status, resolvedAt: now(), note: note ?? item.note } : item),
    timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "核实对账差异", detail: `差异 ${id.slice(0, 8)} 标记为「${status}」${note ? `：${note}` : ""}`, phase: "响应" }, ...state.timeline]
  }))
}), {
  name: "pair-wise-yf-47/incident",
  version: 2,
  partialize: (state) => ({
    incident: state.incident, stations: state.stations, timeline: state.timeline, plans: state.plans,
    role: state.role, online: state.online, pendingActions: state.pendingActions,
    ledger: state.ledger, discrepancies: state.discrepancies, conclusions: state.conclusions, inbox: state.inbox, claims: state.claims
  })
}));

function formatTs(value: string): string {
  return format(new Date(value), "MM-dd HH:mm");
}

export { SECTION_CATALOG };
