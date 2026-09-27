import { useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";

export function DeliveryRecordsList({
  projectId,
  csrf,
  canWrite,
  onNavigate,
}: {
  projectId: string;
  csrf: string;
  canWrite: boolean;
  onNavigate?: (href: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingId, setConfirmingId] = useState<string>();
  const [actionError, setActionError] = useState("");
  const initialQuery = Object.fromEntries(
    new URLSearchParams(window.location.search).entries(),
  );
  const [status, setStatus] = useState(initialQuery.status ?? "");
  const [packageType, setPackageType] = useState(
    initialQuery.packageType ?? "",
  );
  const [submitted, setSubmitted] = useState<Record<string, string>>({
    limit: "20",
    offset: initialQuery.offset ?? "0",
    ...(initialQuery.status ? { status: initialQuery.status } : {}),
    ...(initialQuery.packageType
      ? { packageType: initialQuery.packageType }
      : {}),
  });
  const query = useQuery({
    queryKey: ["delivery-records", projectId, submitted],
    queryFn: () => api.deliveries(projectId, submitted),
  });
  const deliveries = query.data?.deliveries ?? [];
  const pagination = query.data?.pagination;

  function applyFilters() {
    const next = {
      limit: "20",
      offset: "0",
      ...(status ? { status } : {}),
      ...(packageType ? { packageType } : {}),
    };
    setSubmitted(next);
    const query = new URLSearchParams(window.location.search);
    for (const key of ["status", "packageType", "limit", "offset"])
      query.delete(key);
    for (const [key, value] of Object.entries(next)) query.set(key, value);
    window.history.pushState(
      {},
      "",
      `${window.location.pathname}?${query.toString()}`,
    );
  }

  function handleNavigate(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (
      onNavigate &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      onNavigate(href);
    }
  }

  function setPage(offset: number) {
    const next = { ...submitted, offset: String(offset) };
    setSubmitted(next);
    const query = new URLSearchParams(window.location.search);
    query.set("offset", next.offset);
    window.history.pushState(
      {},
      "",
      `${window.location.pathname}?${query.toString()}`,
    );
  }

  async function confirmImported(deliveryId: string) {
    if (!canWrite || confirmingId) return;
    setConfirmingId(deliveryId);
    setActionError("");
    try {
      await api.attestDeliveryImported(projectId, deliveryId, csrf);
      await queryClient.invalidateQueries({ queryKey: ["delivery-records"] });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "确认导入失败");
    } finally {
      setConfirmingId(undefined);
    }
  }

  return (
    <Card className="card wide" role="region" aria-label="交付记录列表">
      <div className="section-heading">
        <div>
          <span className="step">DELIVERY RECORDS / EVIDENCE</span>
          <h3>交付记录</h3>
          <p>
            仅显示 AgentBench 本地生成的包与用户确认事实；remoteVerified 始终为
            false。
          </p>
        </div>
      </div>
      <div className="list-toolbar" aria-label="交付记录筛选">
        <label>
          状态
          <select
            aria-label="交付状态筛选"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">全部</option>
            <option value="generated">generated</option>
            <option value="downloaded">downloaded</option>
            <option value="user_confirmed_imported">
              user_confirmed_imported
            </option>
            <option value="tombstoned">tombstoned</option>
          </select>
        </label>
        <label>
          包类型
          <select
            aria-label="交付包类型筛选"
            value={packageType}
            onChange={(event) => setPackageType(event.target.value)}
          >
            <option value="">全部</option>
            <option value="standard">standard</option>
            <option value="full_provenance">full_provenance</option>
            <option value="langfuse_csv">langfuse_csv</option>
          </select>
        </label>
        <Button onClick={applyFilters}>应用筛选</Button>
      </div>
      {query.isLoading ? (
        <p className="state-view" aria-busy="true">
          正在加载交付记录…
        </p>
      ) : query.error ? (
        <p className="state-view error" role="alert">
          交付记录读取失败：{query.error.message}
        </p>
      ) : deliveries.length ? (
        <table className="delivery-table" aria-label="交付记录结果">
          <thead>
            <tr>
              <th>测试集 / 版本</th>
              <th>包类型 / 校验级别</th>
              <th>状态 / 时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery: any) => {
              const detailHref = `/test-sets/${encodeURIComponent(
                delivery.testSetId,
              )}?version=${encodeURIComponent(delivery.versionId)}`;
              return (
                <tr key={delivery.id}>
                  <td data-label="测试集 / 版本">
                    <a
                      href={detailHref}
                      onClick={(event) => handleNavigate(event, detailHref)}
                    >
                      {delivery.testSetName}
                    </a>
                    <small>
                      v{delivery.versionNumber} · {delivery.versionStatus}
                    </small>
                  </td>
                  <td data-label="包类型 / 校验级别">
                    {delivery.packageType} · {delivery.verificationLevel}
                    <small>{delivery.formatVersion}</small>
                    {delivery.localValidation && (
                      <small>
                        本地 CSV 校验：
                        {delivery.localValidation.valid ? "通过" : "失败"}
                      </small>
                    )}
                    {delivery.offlineValidation?.valid && (
                      <small>离线包校验：生成时已通过</small>
                    )}
                    {delivery.offlineValidation?.status ===
                      "recipient_required" && (
                      <small>离线包校验：下载后由接收方运行</small>
                    )}
                  </td>
                  <td data-label="状态 / 时间">
                    {delivery.status}
                    <small>
                      {new Date(delivery.createdAt).toLocaleString()}
                    </small>
                  </td>
                  <td data-label="操作">
                    {delivery.packageType === "langfuse_csv" && !canWrite ? (
                      <span className="scope">Viewer 不可下载 CSV</span>
                    ) : (
                      <a
                        className="button button-secondary"
                        href={`/api/projects/${projectId}/deliveries/${delivery.id}/download`}
                      >
                        下载
                      </a>
                    )}
                    {delivery.packageType === "langfuse_csv" && (
                      <>
                        <small>人工导入仅是本地用户声明，未经远端验证。</small>
                        <Button
                          variant="outline"
                          onClick={() => confirmImported(delivery.id)}
                          disabled={
                            !canWrite ||
                            delivery.status === "user_confirmed_imported" ||
                            confirmingId === delivery.id
                          }
                        >
                          {delivery.status === "user_confirmed_imported"
                            ? "已确认人工导入"
                            : "确认已人工导入（仅用户声明）"}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="state-view">
          暂无交付记录；请先在测试集版本详情中生成标准包或完整溯源包。{" "}
          <a
            href="/test-sets"
            onClick={(event) => handleNavigate(event, "/test-sets")}
          >
            前往 Test Sets
          </a>
        </p>
      )}
      {actionError && (
        <p className="state-view error" role="alert">
          交付操作失败：{actionError}
        </p>
      )}
      {pagination && (
        <div className="pager" aria-label="交付记录分页">
          <Button
            aria-label="交付记录上一页"
            disabled={pagination.offset === 0}
            onClick={() =>
              setPage(Math.max(0, pagination.offset - pagination.limit))
            }
          >
            上一页
          </Button>
          <span>
            {pagination.total
              ? `${pagination.offset + 1}-${Math.min(
                  pagination.offset + pagination.limit,
                  pagination.total,
                )} / ${pagination.total}`
              : "0 / 0"}
          </span>
          <Button
            aria-label="交付记录下一页"
            disabled={pagination.offset + pagination.limit >= pagination.total}
            onClick={() => setPage(pagination.offset + pagination.limit)}
          >
            下一页
          </Button>
        </div>
      )}
    </Card>
  );
}
