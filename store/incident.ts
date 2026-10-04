import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";
export type ExternalKind = "停运" | "预计恢复";
export type ReconcileStatus = "已入账" | "差异" | "已作废";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
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

/** 线网中心外部推送（区段停运 / 预计恢复），按外部编号只入账一次 */
export interface ExternalEvent {
  externalId: string;
  kind: ExternalKind;
  section: string;
  payload: string;
  pushedAt: string;
  receivedAt: string;
  status: ReconcileStatus;
  discrepancy?: string;
  retries: number;
}

/** 弱网时先记在本地的外部推送队列，回网后按外部编号合并 */
export interface OutboxItem {
  id: string;
  externalId: string;
  kind: ExternalKind;
  section: string;
  payload: string;
  pushedAt: string;
  queuedAt: string;
  retries: number;
  lastError?: string;
}

/** 区段认领：两个调度台同时认领同一区段时，只让先到的生效 */
export interface SectionClaim {
  section: string;
  claimant: Role;
  claimedAt: string;
}

export interface ExternalPushInput {
  externalId: string;
  kind: ExternalKind;
  section: string;
  payload: string;
  pushedAt?: string;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  externalEvents: ExternalEvent[];
  outbox: OutboxItem[];
  claims: Record<string, SectionClaim>;
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
  ingestExternalPush: (push: ExternalPushInput) => { ok: boolean; reason?: "duplicate" | "queued" | "posted" };
  flushOutbox: () => void;
  retryOutboxItem: (id: string) => void;
  claimSection: (section: string, claimant: Role) => { ok: boolean; winner?: Role };
}

const now = () => new Date().toISOString();

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

/**
 * 外部推送与本地记录对账：现场状态和计划执行以本地记录为准。
 * 对得上 → 已入账；对不上 → 差异（本地记录不被覆盖）。
 */
function reconcilePush(kind: ExternalKind, section: string, stations: Station[], plans: ShuttlePlan[]): { status: ReconcileStatus; discrepancy?: string } {
  const inSection = stations.filter((station) => station.section === section);
  if (kind === "停运") {
    const affected = inSection.filter((station) => station.status !== "正常");
    const planned = plans.some((plan) => plan.status === "已执行" && plan.stations.some((name) => inSection.some((station) => station.name === name)));
    if (affected.length > 0 || planned) return { status: "已入账" };
    return { status: "差异", discrepancy: "线网通报区段停运，但现场车站均为正常、接驳计划未执行；现场状态以本地记录为准，停运结论暂不执行" };
  }
  const notRecovered = inSection.filter((station) => station.status === "封闭" || station.status === "限流");
  if (notRecovered.length > 0) {
    return { status: "差异", discrepancy: `线网通报预计恢复，但${notRecovered.map((station) => station.name).join("、")}仍为${notRecovered.map((station) => station.status).join("/")}；恢复结论以现场为准，暂不确认` };
  }
  return { status: "已入账" };
}

/** 本地队列项合并为一条已入账事件（或差异），并生成时间线记录 */
function buildPostedEvent(item: OutboxItem, role: Role, stations: Station[], plans: ShuttlePlan[]): { event: ExternalEvent; entry: TimelineEntry } {
  const result = reconcilePush(item.kind, item.section, stations, plans);
  const event: ExternalEvent = {
    externalId: item.externalId,
    kind: item.kind,
    section: item.section,
    payload: item.payload,
    pushedAt: item.pushedAt,
    receivedAt: now(),
    status: result.status,
    discrepancy: result.discrepancy,
    retries: item.retries
  };
  const entry: TimelineEntry = {
    id: crypto.randomUUID(),
    time: now(),
    actor: role,
    action: result.status === "差异" ? "外部推送合并入账（差异）" : "外部推送合并入账",
    detail: result.discrepancy ? `${item.externalId}：${result.discrepancy}` : `${item.kind} ${item.section} 已按外部编号 ${item.externalId} 合并入账`,
    phase: item.kind === "停运" ? "响应" : "恢复"
  };
  return { event, entry };
}

export const useIncidentStore = create<IncidentState>()(persist((set, get) => ({
  incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
  stations: seedStations,
  timeline: [
    { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
    { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
  ],
  plans: [
    { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
  ],
  role: "调度员",
  online: true,
  pendingActions: [],
  externalEvents: [],
  outbox: [],
  claims: {},
  setRole: (role) => set({ role }),
  setOnline: (online) => {
    set({ online });
    // 回网后立即按外部编号合并本地队列，没入账的接着重试
    if (online) get().flushOutbox();
  },
  setStationStatus: (id, status, note) => set((state) => {
    const target = state.stations.find((item) => item.id === id);
    // 本地车站状态一变，该段的预计恢复结论立刻作废
    const invalidated = state.externalEvents.filter((event) => event.kind === "预计恢复" && event.section === target?.section && event.status !== "已作废");
    const invalidateEntries: TimelineEntry[] = invalidated.map((event) => ({
      id: crypto.randomUUID(),
      time: now(),
      actor: state.role,
      action: "恢复结论作废",
      detail: `本地车站状态变更，外部编号 ${event.externalId} 的预计恢复结论立即作废`,
      phase: "恢复"
    }));
    return {
      stations: state.stations.map((station) => station.id === id ? { ...station, status, note: note ?? station.note, updatedAt: now() } : station),
      externalEvents: state.externalEvents.map((event) => invalidated.some((item) => item.externalId === event.externalId) ? { ...event, status: "已作废" as ReconcileStatus } : event),
      timeline: [
        ...invalidateEntries,
        { id: crypto.randomUUID(), time: now(), actor: state.role, action: "更新车站状态", detail: `${target?.name ?? id} → ${status}`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" },
        ...state.timeline
      ],
      pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: "更新车站状态", detail: `${target?.name} → ${status}`, time: now() }, ...state.pendingActions]
    };
  }),
  addTimeline: (entry) => set((state) => ({ timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline], pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: entry.action, detail: entry.detail, time: now() }, ...state.pendingActions] })),
  addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] }, ...state.plans] })),
  submitPlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "待确认" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" }, ...state.timeline] })),
  approvePlan: (id, approver) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, approvals: Array.from(new Set([...plan.approvals, approver])), status: plan.approvals.length >= 1 ? "已确认" : plan.status } : plan) })),
  executePlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "已执行" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" }, ...state.timeline] })),
  queueAction: (action, detail) => set((state) => ({ pendingActions: [{ id: crypto.randomUUID(), action, detail, time: now() }, ...state.pendingActions] })),
  syncActions: () => set({ pendingActions: [] }),
  ingestExternalPush: (push) => {
    const state = get();
    const pushedAt = push.pushedAt ?? now();
    // 按外部编号去重：已入账或已在本地队列，都不再重复入账
    const duplicated = state.externalEvents.some((event) => event.externalId === push.externalId)
      || state.outbox.some((item) => item.externalId === push.externalId);
    if (duplicated) {
      set((s) => ({
        timeline: [{ id: crypto.randomUUID(), time: now(), actor: s.role, action: "外部推送重复", detail: `外部编号 ${push.externalId} 已入账，外部推送按编号只入账一次，本次忽略`, phase: "响应" }, ...s.timeline]
      }));
      return { ok: true, reason: "duplicate" };
    }
    if (!state.online) {
      // 断网时先记在本地，回网后按外部编号合并
      const item: OutboxItem = {
        id: crypto.randomUUID(),
        externalId: push.externalId,
        kind: push.kind,
        section: push.section,
        payload: push.payload,
        pushedAt,
        queuedAt: now(),
        retries: 0
      };
      set((s) => ({
        outbox: [item, ...s.outbox],
        timeline: [{ id: crypto.randomUUID(), time: now(), actor: s.role, action: "弱网缓存外部推送", detail: `${push.kind} ${push.section}（外部编号 ${push.externalId}）已记入本地队列，回网后合并入账`, phase: push.kind === "停运" ? "响应" : "恢复" }, ...s.timeline]
      }));
      return { ok: true, reason: "queued" };
    }
    const result = reconcilePush(push.kind, push.section, state.stations, state.plans);
    const event: ExternalEvent = {
      externalId: push.externalId,
      kind: push.kind,
      section: push.section,
      payload: push.payload,
      pushedAt,
      receivedAt: now(),
      status: result.status,
      discrepancy: result.discrepancy,
      retries: 0
    };
    set((s) => ({
      externalEvents: [event, ...s.externalEvents],
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: s.role, action: result.status === "差异" ? "外部推送入账（差异）" : "外部推送入账", detail: result.discrepancy ? `${push.externalId}：${result.discrepancy}` : `${push.kind} ${push.section} 已按外部编号 ${push.externalId} 入账`, phase: push.kind === "停运" ? "响应" : "恢复" }, ...s.timeline]
    }));
    return { ok: true, reason: "posted" };
  },
  flushOutbox: () => {
    const state = get();
    if (!state.online || state.outbox.length === 0) return;
    const remaining: OutboxItem[] = [];
    const posted: ExternalEvent[] = [];
    const entries: TimelineEntry[] = [];
    for (const item of state.outbox) {
      // 回网后按外部编号合并：已入账的直接丢弃，不重复入账
      if (state.externalEvents.some((event) => event.externalId === item.externalId) || posted.some((event) => event.externalId === item.externalId)) continue;
      // 模拟弱网后首次提交抖动：第一次重试失败，第二次自动成功（没入账的接着重试）
      if (item.retries < 1) {
        remaining.push({ ...item, retries: item.retries + 1, lastError: "模拟网络抖动，提交未确认" });
        continue;
      }
      const { event, entry } = buildPostedEvent(item, state.role, state.stations, state.plans);
      posted.push(event);
      entries.push(entry);
    }
    if (remaining.length > 0 || posted.length > 0) {
      set((s) => ({ outbox: remaining, externalEvents: [...posted, ...s.externalEvents], timeline: [...entries, ...s.timeline] }));
    }
  },
  retryOutboxItem: (id) => {
    const state = get();
    const item = state.outbox.find((entry) => entry.id === id);
    if (!item || !state.online) return;
    if (state.externalEvents.some((event) => event.externalId === item.externalId)) {
      set((s) => ({ outbox: s.outbox.filter((entry) => entry.id !== id) }));
      return;
    }
    if (item.retries < 1) {
      set((s) => ({ outbox: s.outbox.map((entry) => entry.id === id ? { ...entry, retries: entry.retries + 1, lastError: "模拟网络抖动，提交未确认" } : entry) }));
      return;
    }
    const { event, entry } = buildPostedEvent(item, state.role, state.stations, state.plans);
    set((s) => ({ outbox: s.outbox.filter((entry) => entry.id !== id), externalEvents: [event, ...s.externalEvents], timeline: [entry, ...s.timeline] }));
  },
  claimSection: (section, claimant) => {
    const state = get();
    const existing = state.claims[section];
    // 两个调度台同时认领同一区段：只让先到的生效
    if (existing && existing.claimant !== claimant) return { ok: false, winner: existing.claimant };
    if (existing) return { ok: true, winner: existing.claimant };
    const claim: SectionClaim = { section, claimant, claimedAt: now() };
    set((s) => ({
      claims: { ...s.claims, [section]: claim },
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: claimant, action: "认领区段", detail: `${claimant} 认领 ${section} 区段应急指挥权`, phase: "响应" }, ...s.timeline]
    }));
    return { ok: true, winner: claimant };
  }
}), { name: "pair-wise-yf-47/incident" }));
