/**
 * Langfuse 连接管理（Mock 数据服务层）
 * Secret 只能填写或替换，服务层永不回显。
 */
import { delay, fail, nowIso, uid } from "./store";

export type ConnectionStatus = "ACTIVE" | "DISABLED" | "ERROR";

export interface LangfuseConnection {
  id: string;
  name: string;
  host: string;
  projectId: string;
  status: ConnectionStatus;
  lastTestedAt: string | null;
  lastTestMessage: string | null;
  /** 能力检测结果 */
  capabilities: { datasets: boolean; experiments: boolean; scores: boolean };
  hasSecret: boolean;
}

const connections: LangfuseConnection[] = [
  {
    id: "conn-prod",
    name: "生产 · agent-eval-prod",
    host: "https://cloud.langfuse.com",
    projectId: "lf-prod",
    status: "ACTIVE",
    lastTestedAt: "2026-08-05T09:12:00Z",
    lastTestMessage: "连接正常，检测到 12 个 Dataset、5 个已完成 Experiment。",
    capabilities: { datasets: true, experiments: true, scores: true },
    hasSecret: true,
  },
  {
    id: "conn-staging",
    name: "预发 · agent-eval-staging",
    host: "https://cloud.langfuse.com",
    projectId: "lf-staging",
    status: "ACTIVE",
    lastTestedAt: "2026-08-03T11:40:00Z",
    lastTestMessage: "连接正常，Scores 读取权限受限（只读）。",
    capabilities: { datasets: true, experiments: true, scores: false },
    hasSecret: true,
  },
  {
    id: "conn-sandbox",
    name: "沙箱 · agent-eval-sandbox",
    host: "https://us.cloud.langfuse.com",
    projectId: "lf-sandbox",
    status: "ERROR",
    lastTestedAt: "2026-08-04T02:05:00Z",
    lastTestMessage: "401 Unauthorized：Secret Key 已失效，请替换后重新测试。",
    capabilities: { datasets: false, experiments: false, scores: false },
    hasSecret: true,
  },
];

const store = { connections: [...connections] };

export async function listConnections(): Promise<LangfuseConnection[]> {
  return delay(
    store.connections.map((c) => ({ ...c })),
    350,
  );
}

export async function createConnection(input: {
  name: string;
  host: string;
  projectId: string;
  secret: string;
}): Promise<LangfuseConnection> {
  if (!input.name.trim()) return fail("连接名称不能为空");
  if (!/^https?:\/\//.test(input.host)) return fail("Host 需要以 http(s):// 开头");
  if (!input.secret.trim()) return fail("Secret Key 不能为空");
  const conn: LangfuseConnection = {
    id: uid("conn"),
    name: input.name,
    host: input.host,
    projectId: input.projectId,
    status: "ACTIVE",
    lastTestedAt: null,
    lastTestMessage: null,
    capabilities: { datasets: true, experiments: true, scores: true },
    hasSecret: true,
  };
  store.connections = [conn, ...store.connections];
  return delay({ ...conn }, 500);
}

export async function testConnection(id: string): Promise<LangfuseConnection> {
  const conn = store.connections.find((c) => c.id === id);
  if (!conn) return fail(`连接 ${id} 不存在`);
  const ok = conn.status !== "ERROR";
  conn.lastTestedAt = nowIso();
  conn.lastTestMessage = ok
    ? "连接正常，能力检测通过。"
    : "401 Unauthorized：Secret Key 已失效，请替换后重新测试。";
  store.connections = store.connections.map((c) => (c.id === id ? { ...conn } : c));
  return delay({ ...conn }, 900);
}

export async function setConnectionEnabled(id: string, enabled: boolean) {
  const conn = store.connections.find((c) => c.id === id);
  if (!conn) return fail(`连接 ${id} 不存在`);
  conn.status = enabled ? "ACTIVE" : "DISABLED";
  store.connections = store.connections.map((c) => (c.id === id ? { ...conn } : c));
  return delay({ ...conn }, 350);
}
