import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { request } from "@/services/workspace";

type Connection = {
  revision: number;
  name: string;
  endpoint: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  testedAt: string | null;
  testOk: boolean | null;
  testCode: string | null;
};
type Settings = { connection: Connection | null; encryptionReady: boolean };
const path = "/api/settings/model-connection";
const errors: Record<string, string> = {
  model_connection_invalid:
    "请检查连接名称、服务地址和模型名称。地址不能包含用户名、密码、查询参数或片段。",
  model_key_required: "首次保存需要填写 API key。",
  model_key_required_for_endpoint: "更换模型服务地址后，请重新填写该服务的 API key。",
  model_connection_conflict: "连接已被更新。你的输入仍在，请重新载入当前配置后再保存。",
  model_encryption_unavailable: "服务器尚未配置可用的模型加密密钥，请联系部署管理员。",
  administrator_required: "只有管理员可以配置模型连接。",
};
export function ModelConnectionSettings() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["model-connection-settings"],
    queryFn: () => request<Settings>(path),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [notice, setNotice] = useState("");
  if (query.isPending) return <p className="text-sm text-muted-foreground">正在读取模型连接…</p>;
  if (query.error || !query.data)
    return (
      <section className="member-card p-6">
        <p role="alert">暂时无法读取模型连接。</p>
        <Button variant="outline" className="mt-4" onClick={() => void query.refetch()}>
          重试
        </Button>
      </section>
    );
  return (
    <>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <ConnectionForm
        key={query.data.connection?.revision ?? 0}
        settings={query.data}
        onResult={(data, message) => {
          client.setQueryData(["model-connection-settings"], data);
          setNotice(message);
        }}
        onReload={() => void query.refetch()}
      />
    </>
  );
}
function ConnectionForm({
  settings,
  onResult,
  onReload,
}: {
  settings: Settings;
  onResult: (value: Settings, notice: string) => void;
  onReload: () => void;
}) {
  const connection = settings.connection;
  const [name, setName] = useState(connection?.name ?? "");
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [model, setModel] = useState(connection?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const dirty =
    !connection ||
    !!apiKey ||
    name !== connection.name ||
    endpoint !== connection.endpoint ||
    model !== connection.model ||
    enabled !== connection.enabled;
  async function run(action: "save" | "test") {
    setBusy(action);
    setError("");
    try {
      const data = await request<Settings & { test?: { ok: boolean } }>(
        action === "save" ? path : `${path}/test`,
        {
          method: action === "save" ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "save"
              ? { revision: connection?.revision ?? 0, name, endpoint, model, apiKey, enabled }
              : { revision: connection?.revision },
          ),
        },
      );
      if (action === "save") setApiKey("");
      onResult(
        data,
        action === "save"
          ? "模型连接已保存。"
          : data.test?.ok
            ? "连接测试通过。"
            : "连接测试失败，请检查地址、模型名称和密钥后重试。",
      );
    } catch (cause) {
      setError(
        errors[cause instanceof Error ? cause.message : ""] ??
          "操作失败，当前输入已保留，请稍后重试。",
      );
    } finally {
      setBusy(null);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void run("save");
  }
  return (
    <section className="member-card profile-card">
      <div className="member-card-head">
        <h2>兼容模型服务</h2>
        <p>供项目助手与数据处理使用。更新连接后，请重新测试。</p>
      </div>
      <form className="profile-form" onSubmit={save}>
        {!settings.encryptionReady && (
          <p role="alert" className="text-sm text-destructive">
            服务器尚未配置模型加密密钥，暂时不能保存或测试连接。
          </p>
        )}
        {error && (
          <div role="alert" className="text-sm text-destructive">
            <p>{error}</p>
            {error === errors["model_connection_conflict"] && (
              <Button type="button" variant="outline" className="mt-2" onClick={onReload}>
                重新载入配置
              </Button>
            )}
          </div>
        )}
        {[
          {
            id: "model-connection-name",
            label: "连接名称",
            value: name,
            change: setName,
            placeholder: "例如：团队测试模型",
            max: 80,
          },
          {
            id: "model-connection-endpoint",
            label: "服务地址",
            value: endpoint,
            change: setEndpoint,
            placeholder: "https://model.example.com/v1",
            max: 2048,
          },
          {
            id: "model-connection-model",
            label: "模型名称",
            value: model,
            change: setModel,
            placeholder: "服务端提供的模型标识",
            max: 200,
          },
        ].map((field) => (
          <div className="profile-row" key={field.id}>
            <label className="profile-row-label" htmlFor={field.id}>
              {field.label}
            </label>
            <Input
              id={field.id}
              required
              maxLength={field.max}
              value={field.value}
              placeholder={field.placeholder}
              disabled={!!busy}
              onChange={(event) => field.change(event.target.value)}
            />
          </div>
        ))}
        <div className="profile-row">
          <label className="profile-row-label" htmlFor="model-connection-key">
            API key
          </label>
          <div className="min-w-0 space-y-2">
            <Input
              id="model-connection-key"
              type="password"
              autoComplete="new-password"
              maxLength={8192}
              required={!connection?.hasKey}
              value={apiKey}
              placeholder={connection?.hasKey ? "已保存，留空保持原密钥" : "请输入 API key"}
              disabled={!!busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">密钥加密保存在服务器，保存后不回显。</p>
          </div>
        </div>
        <div className="profile-row">
          <label className="profile-row-label" htmlFor="model-connection-enabled">
            启用连接
          </label>
          <div className="flex items-center gap-3">
            <Switch
              id="model-connection-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!!busy}
            />
            <span className="text-sm text-muted-foreground">
              {enabled ? "允许项目使用此连接" : "暂停新模型操作"}
            </span>
          </div>
        </div>
        <div className="profile-row">
          <span className="profile-row-label">最近测试</span>
          <p className="text-sm text-muted-foreground">
            {connection?.testedAt
              ? `${connection.testOk ? "通过" : "失败"} · ${new Date(connection.testedAt).toLocaleString()}`
              : "尚未测试当前配置"}
          </p>
        </div>
        <div className="profile-form-footer flex-wrap gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!connection || dirty || !!busy || !settings.encryptionReady}
            onClick={() => void run("test")}
          >
            {busy === "test" ? "正在测试…" : "测试连接"}
          </Button>
          <Button type="submit" disabled={!dirty || !!busy || !settings.encryptionReady}>
            {busy === "save" ? "正在保存…" : "保存连接"}
          </Button>
        </div>
      </form>
    </section>
  );
}
