"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import { useIncidentStore, type ExternalEvent, type ExternalKind, type OutboxItem, type ReconcileStatus, type Role, type SectionClaim, type ShuttlePlan, type Station, type StationStatus } from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

function Dashboard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const state = useIncidentStore();
  const { message } = AntApp.useApp();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const [pushKind, setPushKind] = useState<ExternalKind>("停运");
  const [pushSection, setPushSection] = useState<string>("中心-滨江");
  const [pushExternalId, setPushExternalId] = useState<string>("");
  const [claimSectionName, setClaimSectionName] = useState<string>("中心-滨江");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  // 回网后本地队列自动按外部编号合并，没入账的接着重试
  useEffect(() => {
    if (!state.online) return;
    const timer = setInterval(() => state.flushOutbox(), 4000);
    return () => clearInterval(timer);
  }, [state.online]);

  const sections = Array.from(new Set(state.stations.map((station) => station.section)));
  const suggestedExternalId = `NET-${format(new Date(), "yyyyMMdd")}-${String(state.externalEvents.length + state.outbox.length + 1).padStart(3, "0")}`;

  const pushExternal = (kind: ExternalKind, section: string, externalId?: string) => {
    const id = externalId?.trim() || suggestedExternalId;
    const result = state.ingestExternalPush({ externalId: id, kind, section, payload: `${kind}：${section}区间`, pushedAt: new Date().toISOString() });
    if (result.reason === "duplicate") message.warning(`外部编号 ${id} 已入账，按外部编号只入账一次，本次重复推送已忽略`);
    else if (result.reason === "queued") message.info(`弱网：外部推送 ${id} 已记入本地队列，回网后按外部编号合并`);
    else message.success(`外部推送 ${id} 已入账并完成对账`);
    setPushExternalId("");
  };

  const doClaim = (section: string, claimant: Role) => {
    const result = state.claimSection(section, claimant);
    if (result.ok) message.success(`认领生效：${claimant} 已认领 ${section} 区段`);
    else message.error(`认领失败：${result.winner} 已先认领 ${section}，只让先到的生效`);
  };

  // 两个调度台同时认领同一区段：只让先到的生效
  const simulateClaimRace = () => {
    const section = claimSectionName;
    const first = state.claimSection(section, "调度员");
    const second = state.claimSection(section, "车站值班员");
    if (first.ok) message.success(`先到生效：调度员 先认领 ${section}`);
    else message.warning(`调度员 认领时 ${first.winner} 已在先，认领未生效`);
    if (!second.ok) message.error(`后到驳回：车站值班员 的认领被拒绝，${second.winner} 已先认领，只让先到的生效`);
  };

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "处置", render: (_, record) => <Space><Button size="small" disabled={state.role === "客服主管"} onClick={() => state.setStationStatus(record.id, "限流")}>限流</Button><Button size="small" disabled={state.role === "客服主管"} danger={record.status !== "封闭"} onClick={() => state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭")}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button></Space> }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); };

  const externalColumns: ColumnsType<ExternalEvent> = [
    { title: "外部编号", dataIndex: "externalId", render: (value: string) => <code>{value}</code> },
    { title: "类型", dataIndex: "kind", render: (value: ExternalKind) => <Tag color={value === "停运" ? "red" : "blue"}>{value}</Tag> },
    { title: "区段", dataIndex: "section" },
    { title: "推送内容", dataIndex: "payload" },
    { title: "推送时间", dataIndex: "pushedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "接收时间", dataIndex: "receivedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "对账状态", dataIndex: "status", render: (value: ReconcileStatus) => <Tag color={value === "已入账" ? "green" : value === "差异" ? "orange" : "default"}>{value}</Tag> },
    { title: "差异说明", dataIndex: "discrepancy", render: (value?: string) => value ?? "—" }
  ];

  const outboxColumns: ColumnsType<OutboxItem> = [
    { title: "外部编号", dataIndex: "externalId", render: (value: string) => <code>{value}</code> },
    { title: "类型", dataIndex: "kind", render: (value: ExternalKind) => <Tag color={value === "停运" ? "red" : "blue"}>{value}</Tag> },
    { title: "区段", dataIndex: "section" },
    { title: "缓存时间", dataIndex: "queuedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "重试次数", dataIndex: "retries" },
    { title: "最近错误", dataIndex: "lastError", render: (value?: string) => value ?? "—" },
    { title: "操作", render: (_, record) => <Button size="small" disabled={!state.online} onClick={() => { state.retryOutboxItem(record.id); message.loading({ content: `正在重试 ${record.externalId}…`, duration: 1 }); }}>立即重试</Button> }
  ];

  const claimColumns: ColumnsType<{ section: string; claim?: SectionClaim }> = [
    { title: "区段", dataIndex: "section" },
    { title: "认领台", dataIndex: "claim", render: (claim?: SectionClaim) => claim ? <Tag color="green">{claim.claimant}</Tag> : <Tag>无人认领</Tag> },
    { title: "认领时间", dataIndex: "claim", render: (claim?: SectionClaim) => claim ? format(new Date(claim.claimedAt), "HH:mm:ss") : "—" },
    { title: "操作", render: (_, record) => <Button size="small" onClick={() => doClaim(record.section, state.role)}>认领（{state.role}）</Button> }
  ];

  const claimSections = sections.map((section) => ({ section, claim: state.claims[section] }));

  return <div className="shell">
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心", "外部对账"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>最近缓存 32 秒前</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={state.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待确认计划" value={state.plans.filter((item) => item.status === "待确认").length} /></Card><Card><Statistic title="待同步操作" value={state.pendingActions.length} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，显示最近缓存数据。关键处置会进入本地队列，恢复连接后需人工确认提交。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : state.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 760 }} /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={state.stations} plans={state.plans.filter((plan) => plan.status !== "草稿")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" onClick={() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" })}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站封闭与广播口径已确认。</p><p>接驳车辆到场后需调度员和公交负责人双方确认。</p><p>恢复行车前检查区间水位和站台安全。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button>}><Table rowKey="id" pagination={false} dataSource={state.plans} columns={[{title:"接驳站",dataIndex:"stations",render:(v:string[])=>v.join(" → ")},{title:"车辆",dataIndex:"vehicles"},{title:"间隔",dataIndex:"interval",render:(v:number)=>`${v} 分钟`},{title:"运营方",dataIndex:"operator"},{title:"确认",dataIndex:"approvals",render:(v:string[])=>v.length? v.map((x)=><Tag key={x} color="green">{x}</Tag>) : <Tag>未确认</Tag>},{title:"状态",dataIndex:"status",render:(v)=> <Tag color={v==="已确认"||v==="已执行"?"green":v==="待确认"?"orange":"default"}>{v}</Tag>},{title:"操作",render:(_,record:ShuttlePlan)=><Space><Button size="small" disabled={record.status!=="草稿"} onClick={()=>state.submitPlan(record.id)}>提交确认</Button><Button size="small" disabled={record.status!=="待确认"||state.role==="客服主管"} onClick={()=>state.approvePlan(record.id,state.role)}>确认</Button><Button size="small" type="primary" disabled={record.status!=="已确认"} onClick={()=>state.executePlan(record.id)}>执行</Button></Space>}]} /></Card>}
      {panel === "确认中心" && <Card title="跨岗位确认中心"><Timeline items={state.plans.map((plan) => ({ children: <div className="approval"><b>{plan.stations.join(" → ")}</b><Tag>{plan.status}</Tag><p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p><small>已确认：{plan.approvals.join("、") || "暂无"}</small></div> }))} /><Button disabled={state.online || !state.pendingActions.length} onClick={state.syncActions}>人工确认并同步本地队列</Button></Card>}
      {panel === "外部对账" && <div className="recon-grid">
        <Card title="线网推送接入" className="wide"><Space wrap>
          <Select value={pushKind} onChange={setPushKind} style={{ width: 110 }} options={[{ value: "停运" }, { value: "预计恢复" }]} />
          <Select value={pushSection} onChange={setPushSection} style={{ width: 150 }} options={sections.map((section) => ({ value: section, label: section }))} />
          <Input value={pushExternalId} onChange={(event) => setPushExternalId(event.target.value)} style={{ width: 210 }} placeholder={suggestedExternalId} addonBefore="外部编号" />
          <Button type="primary" onClick={() => pushExternal(pushKind, pushSection)}>推送至对账</Button>
          <Button onClick={() => pushExternal("停运", "中心-滨江")}>快捷：停运（现场已封闭）</Button>
          <Button onClick={() => pushExternal("预计恢复", "中心-滨江")}>快捷：预计恢复（现场仍封闭→差异）</Button>
        </Space><p className="hint">外部推送按外部编号只入账一次；现场状态与计划执行以本地记录为准，对不上留成差异，不覆盖本地。断网时推送先记本地队列，回网后按外部编号合并，没入账的接着重试。</p></Card>
        <Card title="外部事件对账" className="wide"><Table rowKey="externalId" dataSource={state.externalEvents} columns={externalColumns} pagination={false} size="small" scroll={{ x: 900 }} /></Card>
        <Card title="本地队列（断网缓存 · 回网合并 · 未入账重试）" className="wide"><Table rowKey="id" dataSource={state.outbox} columns={outboxColumns} pagination={false} size="small" /><p className="hint">回网后首次提交模拟网络抖动会失败一次，随后每 4 秒自动重试直至按外部编号合并入账；也可手动立即重试。</p></Card>
        <Card title="区段认领（先到生效）" className="wide"><Space wrap style={{ marginBottom: 12 }}><Select value={claimSectionName} onChange={setClaimSectionName} style={{ width: 150 }} options={sections.map((section) => ({ value: section, label: section }))} /><Button onClick={simulateClaimRace}>模拟两台调度台同时认领同一区段</Button></Space><Table rowKey="section" dataSource={claimSections} columns={claimColumns} pagination={false} size="small" /></Card>
      </div>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
