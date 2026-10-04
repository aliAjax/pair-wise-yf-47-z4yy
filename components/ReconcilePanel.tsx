"use client";

import { useState } from "react";
import { App as AntApp, Alert, Badge, Button, Card, Form, Input, Radio, Select, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { format } from "date-fns";
import { SECTION_CATALOG, type ExternalPush, type LedgerEntry, type Discrepancy, type RecoveryConclusion, type InboxPush, type SectionClaim } from "../lib/reconcile";
import { useIncidentStore, type Station } from "../store/incident";

const fmt = (v?: string) => (v ? format(new Date(v), "HH:mm:ss") : "—");
const fmtFull = (v?: string) => (v ? format(new Date(v), "MM-dd HH:mm:ss") : "—");

const DISPATCH_DESKS = ["1号调度台", "2号调度台"];

/** 推送场景样例：覆盖一致入账、现场对不上、恢复被现场推翻等情形 */
function buildPush(scenario: string, externalId: string): ExternalPush | null {
  const pushedAt = new Date().toISOString();
  switch (scenario) {
    case "suspend-cb":
      return { externalId, kind: "区段停运", sectionId: "SEC-CB", sectionName: "中心—滨江区间", stationIds: ["s1"], reason: "区间水位超限", pushedAt };
    case "suspend-hj":
      // 会展中心站本地为「限流」，线网按停运要求封闭 -> 留差异
      return { externalId, kind: "区段停运", sectionId: "SEC-HJ", sectionName: "会展—滨江区间", stationIds: ["s2"], reason: "接触网故障", pushedAt };
    case "suspend-bd":
      // 东港站本地「正常」且无接驳计划 -> 现场、计划两条差异
      return { externalId, kind: "区段停运", sectionId: "SEC-BD", sectionName: "滨江—东港区间", stationIds: ["s3"], reason: "异物侵限", pushedAt };
    case "resume-cb":
      // 滨江站本地已在「恢复中」、无封闭限流 -> 形成有效恢复结论
      return { externalId, kind: "预计恢复", sectionId: "SEC-CB", sectionName: "中心—滨江区间", stationIds: ["s1"], eta: new Date(Date.now() + 20 * 60000).toISOString(), reason: "区间抽水完成", pushedAt };
    case "resume-blocked":
      // 会展中心站仍限流 -> 预计恢复被现场推翻，留差异、结论无效
      return { externalId, kind: "预计恢复", sectionId: "SEC-HJ", sectionName: "会展—滨江区间", stationIds: ["s2"], eta: new Date(Date.now() + 15 * 60000).toISOString(), pushedAt };
    default:
      return null;
  }
}

export function ReconcilePanel() {
  const { message } = AntApp.useApp();
  const state = useIncidentStore();
  const [form] = Form.useForm();
  const [scenario, setScenario] = useState("suspend-cb");
  const [externalId, setExternalId] = useState(`NET-${Date.now().toString().slice(-8)}-01`);
  const [claimSection, setClaimSection] = useState<string>("SEC-HJ");
  const [desk, setDesk] = useState<string>(DISPATCH_DESKS[0]);

  const stationName = (s: Station[], id: string) => s.find((item) => item.id === id)?.name ?? id;

  const sendPush = () => {
    const push = buildPush(scenario, externalId.trim());
    if (!push) return;
    const res = state.ingestPush(push);
    if (res.outcome === "stored") message.warning(`断网：推送 ${res.externalId} 已暂存本地收件箱（${res.inboxCount} 条），回网后合并`);
    else if (res.outcome === "duplicate") message.info(`外部编号 ${res.externalId} 已入账（${fmtFull(res.bookedAt)}），重复推送不重复入账`);
    else message.success(`已入账 ${res.externalId}${res.discrepancies ? `，生成 ${res.discrepancies} 条差异待核` : "，核对一致"}`);
  };

  const sendSameAgain = () => {
    const push = buildPush(scenario, externalId.trim());
    if (!push) return;
    state.ingestPush(push);
    message.info("已按相同外部编号重发，用于验证只入账一次");
  };

  const doClaim = () => {
    const arrivedAt = Date.now();
    const res = state.claimSection(claimSection, desk, arrivedAt);
    if (res.won) message.success(`${desk} 认领成功（到达 ${arrivedAt}）${res.replaced ? `，先到请求挤掉了 ${res.replaced}` : ""}`);
    else message.warning(`${desk} 认领失败：${res.holder} 先到，已持有该区段`);
  };

  const doContest = () => {
    const base = Date.now();
    const res = state.contestClaim(claimSection, "1号调度台", "2号调度台", base);
    message.loading({ content: "两张票据同时到达，故意先处理 2 号台…", duration: 0.6 });
    setTimeout(() => {
      if (res.winner === "1号调度台") message.success(`并发裁决：1号台到达 ${base} 早于 2号台 ${base + 1}，只让先到的生效；2号台被拒`);
      else message.warning(`当前持有：${res.winner}，被拒：${res.rejected.join("、")}`);
    }, 650);
  };

  const ledgerColumns: ColumnsType<LedgerEntry> = [
    { title: "外部编号", dataIndex: "externalId", render: (v: string) => <b>{v}</b> },
    { title: "推送类型", dataIndex: ["push", "kind"], render: (v: string) => <Tag color={v === "预计恢复" ? "green" : "red"}>{v}</Tag> },
    { title: "区段", render: (_, r) => r.push.sectionName },
    { title: "涉及车站", render: (_, r) => r.push.stationIds.map((id) => stationName(state.stations, id)).join("、") },
    { title: "入账时间", dataIndex: "bookedAt", render: fmt },
    { title: "来源", dataIndex: "source", render: (v: string) => <Tag color={v === "回网合并" ? "orange" : "blue"}>{v}</Tag> },
    { title: "差异", dataIndex: "discrepancyIds", render: (ids: string[]) => ids.length ? <Tag color="warning">{ids.length} 条待核</Tag> : <Tag color="success">一致</Tag> }
  ];

  const discrepancyColumns: ColumnsType<Discrepancy> = [
    { title: "类型", dataIndex: "type", render: (v: string) => <Tag color={v === "现场状态不一致" ? "volcano" : "gold"}>{v}</Tag> },
    { title: "对象", dataIndex: "scopeName" },
    { title: "外部口径", dataIndex: "external" },
    { title: "本地记录（为准）", dataIndex: "local" },
    { title: "状态", dataIndex: "status", render: (v: Discrepancy["status"]) => <Badge status={v === "待核" ? "error" : v === "已核实" ? "success" : "default"} text={v} /> },
    { title: "操作", render: (_, r) => r.status === "待核" ? (
      <Space direction="vertical" size={2}>
        <Button size="small" type="link" onClick={() => { state.resolveDiscrepancy(r.id, "已核实"); message.success("已标记核实"); }}>核实并维持本地</Button>
        <Button size="small" type="link" danger onClick={() => { state.resolveDiscrepancy(r.id, "已忽略"); message.info("已忽略该差异"); }}>忽略</Button>
      </Space>
    ) : <small style={{ color: "#8b95a6" }}>{r.note ?? fmtFull(r.resolvedAt)}</small> }
  ];

  const conclusionColumns: ColumnsType<RecoveryConclusion> = [
    { title: "外部编号", dataIndex: "externalId", render: (v: string) => <b>{v}</b> },
    { title: "区段", dataIndex: "sectionName" },
    { title: "预计恢复", dataIndex: "eta", render: fmt },
    { title: "结论", key: "valid", render: (_, r) => r.valid ? <Tag color="green">有效</Tag> : <Tag color="red">已作废</Tag> },
    { title: "作废原因", key: "reason", render: (_, r) => r.valid ? <span style={{ color: "#8b95a6" }}>本地车站状态一变即作废</span> : <span>{r.invalidReason}{r.invalidatedAt ? `（${fmt(r.invalidatedAt)}）` : ""}</span> }
  ];

  const inboxColumns: ColumnsType<InboxPush> = [
    { title: "外部编号", render: (_, r) => <b>{r.push.externalId}</b> },
    { title: "类型", render: (_, r) => <Tag color={r.push.kind === "预计恢复" ? "green" : "red"}>{r.push.kind}</Tag> },
    { title: "区段", render: (_, r) => r.push.sectionName },
    { title: "本地收到", render: (_, r) => fmt(r.receivedAt) },
    { title: "重试", dataIndex: "attempts" }
  ];

  const claimColumns: ColumnsType<SectionClaim> = [
    { title: "区段", render: (_, r) => SECTION_CATALOG.find((s) => s.sectionId === r.sectionId)?.sectionName ?? r.sectionId },
    { title: "持有调度台", dataIndex: "desk", render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: "到达时刻", dataIndex: "arrivedAt", render: (v: number) => v },
    { title: "认领时间", dataIndex: "claimedAt", render: fmt },
    { title: "操作", render: (_, r) => <Button size="small" danger onClick={() => { state.releaseClaim(r.sectionId, r.desk); message.info(`${r.desk} 已释放区段`); }}>释放</Button> }
  ];

  const pendingDiff = state.discrepancies.filter((item) => item.status === "待核").length;
  const validConclusions = state.conclusions.filter((item) => item.valid).length;

  return (
    <div className="reconcile">
      <Alert
        type="info"
        showIcon
        className="reconcile-banner"
        message="外部推送对账规则"
        description="① 区段停运/预计恢复按外部编号只入账一次，重复推送仅记录；② 现场状态、接驳计划以本地记录为准，对不上留成差异不回写；③ 预计恢复形成结论后，本地车站状态一变立即作废；④ 断网时推送先暂存本地，回网按外部编号合并、未入账的继续重试；⑤ 两个调度台同时认领同一区段，按到达时刻先到先得。"
      />

      <div className="reconcile-stats">
        <Card size="small"><div><small>已入账推送</small><b>{state.ledger.length}</b></div></Card>
        <Card size="small"><div><small>待核差异</small><b className={pendingDiff ? "warn" : "ok"}>{pendingDiff}</b></div></Card>
        <Card size="small"><div><small>有效恢复结论</small><b className={validConclusions ? "ok" : ""}>{validConclusions}</b></div></Card>
        <Card size="small"><div><small>本地收件箱</small><b className={state.inbox.length ? "warn" : ""}>{state.inbox.length}</b></div></Card>
      </div>

      <Card
        size="small"
        title={<Space>线网中心推送接入 {state.online ? <Tag color="green">在线 · 直接入账</Tag> : <Tag color="orange">弱网 · 先记本地</Tag>}</Space>}
        extra={<Button size="small" disabled={state.online || !state.inbox.length} onClick={() => { const r = state.retryInbox(); message.success(`回网合并：入账 ${r.booked} 条，重复丢弃 ${r.duplicates} 条`); }}>手动重试收件箱</Button>}
      >
        <Form layout="inline" form={form}>
          <Form.Item label="推送场景">
            <Select value={scenario} onChange={setScenario} style={{ width: 250 }} options={[
              { value: "suspend-cb", label: "区段停运 · 中心—滨江（一致）" },
              { value: "suspend-hj", label: "区段停运 · 会展—滨江（现场对不上）" },
              { value: "suspend-bd", label: "区段停运 · 滨江—东港（现场+计划双差异）" },
              { value: "resume-cb", label: "预计恢复 · 中心—滨江（结论有效）" },
              { value: "resume-blocked", label: "预计恢复 · 会展—滨江（被现场推翻）" }
            ]} />
          </Form.Item>
          <Form.Item label="外部编号">
            <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} style={{ width: 190 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" onClick={sendPush}>接收推送</Button>
              <Button onClick={sendSameAgain}>相同编号重发</Button>
            </Space>
          </Form.Item>
        </Form>
        <p className="hint">提示：切到「弱网」后接收推送会进入本地收件箱；改回「在线」自动按外部编号合并。把滨江站在「恢复中/封闭」间切换可验证恢复结论立即作废。</p>
      </Card>

      <Card size="small" title="外部推送入账台账（外部编号唯一）">
        <Table rowKey="externalId" size="small" pagination={false} dataSource={state.ledger} columns={ledgerColumns} scroll={{ x: 900 }} />
      </Card>

      <div className="reconcile-grid">
        <Card size="small" title={<Space>对账差异{<Badge count={pendingDiff} showZero color={pendingDiff ? "#faad14" : "#52c41a"} />}</Space>}>
          <Table rowKey="id" size="small" pagination={false} dataSource={state.discrepancies} columns={discrepancyColumns} scroll={{ x: 640 }} />
        </Card>
        <Card size="small" title="恢复结论（随本地现场状态联动）">
          <Table rowKey="id" size="small" pagination={false} dataSource={state.conclusions} columns={conclusionColumns} scroll={{ x: 560 }} />
        </Card>
      </div>

      <div className="reconcile-grid">
        <Card size="small" title={<Space>断网本地收件箱 {state.online ? <Tag>当前在线</Tag> : <Tag color="orange">等待回网合并</Tag>}</Space>}>
          <Table rowKey="id" size="small" pagination={false} dataSource={state.inbox} columns={inboxColumns} locale={{ emptyText: "收件箱为空" }} />
        </Card>
        <Card size="small" title="区段认领（先到先得）">
          <Space wrap style={{ marginBottom: 12 }}>
            <Select value={claimSection} onChange={setClaimSection} style={{ width: 200 }} options={SECTION_CATALOG.map((s) => ({ value: s.sectionId, label: s.sectionName }))} />
            <Radio.Group value={desk} onChange={(e) => setDesk(e.target.value)} options={DISPATCH_DESKS.map((d) => ({ value: d, label: d }))} optionType="button" buttonStyle="solid" size="small" />
            <Button size="small" type="primary" onClick={doClaim}>认领</Button>
            <Button size="small" danger onClick={doContest}>两台同时认领</Button>
          </Space>
          <Table rowKey="sectionId" size="small" pagination={false} dataSource={state.claims} columns={claimColumns} locale={{ emptyText: "暂无区段被认领" }} />
        </Card>
      </div>
    </div>
  );
}
