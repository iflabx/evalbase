import { useEffect, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "./api.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import { Input } from "./ui/input.js";

type AssetFilters = {
  name: string;
  sourceType: string;
  format: string;
  status: string;
  uploadedBy: string;
  from: string;
  to: string;
  sensitivity: string;
};

type AuditFilters = {
  objectType: string;
  objectId: string;
  action: string;
  actorId: string;
  from: string;
  to: string;
};

const AUDIT_OBJECT_TYPES = [
  "asset_upload",
  "data_asset",
  "parse_asset",
  "parsed_view",
  "project_member",
  "job",
  "source_attribution_revision",
  "working_draft",
  "draft_source",
  "test_case",
  "candidate_snapshot",
  "test_set_version",
  "transformation_run",
  "delivery_record",
  "langfuse_csv",
];

const AUDIT_ACTIONS = [
  "project_membership_changed",
  "asset_upload_capacity_blocked",
  "asset_upload_completed",
  "asset_archived",
  "asset_downloaded",
  "parse_attempt_requested",
  "parsed_view_selected",
  "parsed_view_capacity_blocked",
  "parse_failures_excluded",
  "draft_created",
  "draft_source_attached",
  "draft_source_added",
  "draft_source_removed",
  "draft_source_mapping_saved",
  "draft_recipe_saved",
  "draft_capacity_blocked",
  "draft_lease_acquired",
  "draft_lease_released",
  "draft_lease_taken_over",
  "manual_case_created",
  "manual_case_revised",
  "manual_case_deleted",
  "source_attribution_revised",
  "candidate_materialization_requested",
  "candidate_capacity_blocked",
  "materialization_retry_requested",
  "publication_requested",
  "publication_retry_requested",
  "test_set_version_published",
  "test_set_default_selected",
  "test_set_version_archived",
  "package_generation_requested",
  "package_generated",
  "delivery_downloaded",
  "langfuse_csv_generated",
  "delivery_import_attested",
  "transformation_run_registered",
  "transformation_run_annotated",
  "job_cancel_requested",
  "job_cancelled",
  "job_retry_requested",
  "job_retry_scheduled",
  "job_lease_expired",
  "job_failed",
];

function utcDate(value: string) {
  return value ? new Date(value).toISOString() : "";
}

function activeFilters(filters: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value),
  );
}

const ASSET_QUERY_KEYS = [
  "name",
  "sourceType",
  "format",
  "status",
  "uploadedBy",
  "from",
  "to",
  "sensitivity",
  "limit",
  "offset",
];
const TEST_SET_QUERY_KEYS = ["limit", "offset"];

function queryRecord() {
  return Object.fromEntries(
    new URLSearchParams(window.location.search).entries(),
  );
}

function pushQuery(
  values: Record<string, string | undefined>,
  managedKeys = Object.keys(values),
) {
  const query = new URLSearchParams(window.location.search);
  for (const key of managedKeys) query.delete(key);
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  window.history.pushState(
    {},
    "",
    `${window.location.pathname}${suffix ? `?${suffix}` : ""}`,
  );
}

export function StructuredListsPanel({
  projectId,
  testSetId,
  versionId,
  defaultCaseId,
  section,
  onNavigate,
}: {
  projectId: string;
  testSetId?: string;
  versionId?: string;
  defaultCaseId?: string;
  section?: "assets" | "test-sets" | "cases" | "audit";
  onNavigate?: (href: string) => void;
}) {
  const initialQuery = queryRecord();
  const [assetFilters, setAssetFilters] = useState<AssetFilters>({
    name: initialQuery.name ?? "",
    sourceType: initialQuery.sourceType ?? "",
    format: initialQuery.format ?? "",
    status: initialQuery.status ?? "",
    uploadedBy: initialQuery.uploadedBy ?? "",
    from: initialQuery.from?.slice(0, 10) ?? "",
    to: initialQuery.to?.slice(0, 10) ?? "",
    sensitivity: initialQuery.sensitivity ?? "",
  });
  const [submittedAssetFilters, setSubmittedAssetFilters] = useState<
    Record<string, string>
  >({
    ...activeFilters(assetFilters),
    limit: initialQuery.limit ?? "20",
    offset: initialQuery.offset ?? "0",
  });
  const [caseId, setCaseId] = useState(defaultCaseId ?? "");
  const [metadataKey, setMetadataKey] = useState("");
  const [metadataValue, setMetadataValue] = useState("");
  const [caseQuerySubmitted, setCaseQuerySubmitted] = useState(false);
  const [caseOffset, setCaseOffset] = useState(0);
  const [caseQueryValidationError, setCaseQueryValidationError] = useState<
    string | null
  >(null);
  const [testSetLimit] = useState(() =>
    Math.min(200, Math.max(1, Number(initialQuery.limit ?? 20) || 20)),
  );
  const [testSetOffset, setTestSetOffset] = useState(() =>
    Math.max(0, Number(initialQuery.offset ?? 0) || 0),
  );
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({
    objectType: "",
    objectId: "",
    action: "",
    actorId: "",
    from: "",
    to: "",
  });
  const [submittedAuditFilters, setSubmittedAuditFilters] = useState<
    Record<string, string>
  >({ limit: "25" });
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const timezoneOptions = Array.from(
    new Set([timezone, "UTC", "Asia/Shanghai", "America/New_York"]),
  );

  useEffect(() => {
    setCaseId(defaultCaseId ?? "");
    setCaseOffset(0);
  }, [defaultCaseId]);

  const testSetsQuery = useQuery({
    queryKey: ["structured-test-sets", projectId, testSetLimit, testSetOffset],
    queryFn: () =>
      api.testSets(projectId, {
        limit: String(testSetLimit),
        offset: String(testSetOffset),
      }),
    enabled: !section || section === "test-sets",
  });
  const auditQuery = useQuery({
    queryKey: ["structured-audit", projectId, versionId, submittedAuditFilters],
    queryFn: () => api.projectAudit(projectId, submittedAuditFilters),
    enabled: !section || section === "audit",
  });
  const summaryQuery = useQuery({
    queryKey: ["structured-audit-summary", projectId, versionId],
    queryFn: () => api.auditSummary(projectId),
    enabled: !section || section === "audit",
  });
  const assetsQuery = useQuery({
    queryKey: ["structured-assets", projectId, submittedAssetFilters],
    queryFn: () => api.assets(projectId, submittedAssetFilters ?? {}),
    enabled: !section || section === "assets",
  });
  const casesQuery = useQuery({
    queryKey: [
      "structured-cases",
      projectId,
      testSetId,
      versionId,
      caseId,
      metadataKey,
      metadataValue,
      caseOffset,
    ],
    queryFn: () =>
      api.versionCases(projectId, testSetId as string, versionId as string, {
        caseId,
        metadataKey,
        metadataValue,
        limit: "50",
        offset: String(caseOffset),
      }),
    enabled:
      caseQuerySubmitted &&
      !caseQueryValidationError &&
      !!testSetId &&
      !!versionId,
  });

  function formatInSelectedZone(value: string) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(value));
  }

  function submitAssetFilters() {
    const next = {
      ...activeFilters(assetFilters),
      limit: "20",
      offset: "0",
      ...(assetFilters.from && { from: utcDate(assetFilters.from) }),
      ...(assetFilters.to && { to: utcDate(assetFilters.to) }),
    };
    setSubmittedAssetFilters(next);
    pushQuery(next, ASSET_QUERY_KEYS);
  }

  function setAssetPage(offset: number) {
    const next = { ...submittedAssetFilters, offset: String(offset) };
    setSubmittedAssetFilters(next);
    pushQuery(next, ASSET_QUERY_KEYS);
  }

  function setTestSetPage(offset: number) {
    setTestSetOffset(offset);
    pushQuery(
      { limit: String(testSetLimit), offset: String(offset) },
      TEST_SET_QUERY_KEYS,
    );
  }

  function submitAuditFilters() {
    setSubmittedAuditFilters({
      ...activeFilters(auditFilters),
      limit: "25",
      offset: "0",
      ...(auditFilters.from && { from: utcDate(auditFilters.from) }),
      ...(auditFilters.to && { to: utcDate(auditFilters.to) }),
    });
  }

  function submitCaseQuery() {
    const hasMetadataKey = metadataKey.trim().length > 0;
    const hasMetadataValue = metadataValue.trim().length > 0;
    if (hasMetadataKey !== hasMetadataValue) {
      setCaseQueryValidationError("Metadata key 和 value 必须成对填写");
      setCaseQuerySubmitted(false);
      return;
    }
    setCaseQueryValidationError(null);
    setCaseOffset(0);
    setCaseQuerySubmitted(true);
  }

  const testSets = testSetsQuery.data?.testSets ?? [];
  const auditEvents = auditQuery.data?.events ?? [];
  const assets = assetsQuery.data?.assets ?? [];
  const cases = caseQueryValidationError ? undefined : casesQuery.data?.cases;
  const summary = summaryQuery.data?.summary;
  const assetPagination = assetsQuery.data?.pagination;
  const testSetPagination = testSetsQuery.data?.pagination;
  const auditPagination = auditQuery.data?.pagination;
  const casePagination = casesQuery.data?.pagination;

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

  return (
    <>
      {(!section || section === "assets") && (
        <Card
          id="structured-assets"
          className="card wide"
          role="region"
          aria-label="Data Asset 结构化列表"
        >
          <span className="step">STRUCTURED LIST / DATA ASSETS</span>
          <h3>Data Asset 结构化列表</h3>
          <div className="parser-config" aria-label="Data Asset 结构化筛选">
            <label>
              名称（精确）
              <Input
                aria-label="资产名称精确筛选"
                value={assetFilters.name}
                onChange={(event) =>
                  setAssetFilters({ ...assetFilters, name: event.target.value })
                }
              />
            </label>
            <label>
              来源类型
              <select
                aria-label="资产来源类型筛选"
                value={assetFilters.sourceType}
                onChange={(event) =>
                  setAssetFilters({
                    ...assetFilters,
                    sourceType: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                <option value="synthetic">synthetic</option>
                <option value="public">public</option>
                <option value="deidentified">deidentified</option>
              </select>
            </label>
            <label>
              格式
              <select
                aria-label="资产格式筛选"
                value={assetFilters.format}
                onChange={(event) =>
                  setAssetFilters({
                    ...assetFilters,
                    format: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                <option value="csv">csv</option>
                <option value="json">json</option>
                <option value="jsonl">jsonl</option>
              </select>
            </label>
            <label>
              状态
              <select
                aria-label="资产状态筛选"
                value={assetFilters.status}
                onChange={(event) =>
                  setAssetFilters({
                    ...assetFilters,
                    status: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                <option value="stored">stored</option>
                <option value="archived">archived</option>
              </select>
            </label>
            <label>
              上传人
              <Input
                aria-label="资产上传人筛选"
                value={assetFilters.uploadedBy}
                onChange={(event) =>
                  setAssetFilters({
                    ...assetFilters,
                    uploadedBy: event.target.value,
                  })
                }
              />
            </label>
            <label>
              起始日期（UTC）
              <Input
                type="date"
                aria-label="资产上传起始日期"
                value={assetFilters.from}
                onChange={(event) =>
                  setAssetFilters({ ...assetFilters, from: event.target.value })
                }
              />
            </label>
            <label>
              结束日期（UTC）
              <Input
                type="date"
                aria-label="资产上传结束日期"
                value={assetFilters.to}
                onChange={(event) =>
                  setAssetFilters({ ...assetFilters, to: event.target.value })
                }
              />
            </label>
            <label>
              敏感级别
              <select
                aria-label="资产敏感级别筛选"
                value={assetFilters.sensitivity}
                onChange={(event) =>
                  setAssetFilters({
                    ...assetFilters,
                    sensitivity: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                <option value="non_sensitive">non_sensitive</option>
              </select>
            </label>
          </div>
          <Button onClick={submitAssetFilters}>应用结构化筛选</Button>
          {assetsQuery.isLoading ? (
            <p className="state-view" aria-busy="true">
              正在加载资产列表…
            </p>
          ) : assetsQuery.error ? (
            <p className="state-view error" role="alert">
              结构化筛选失败：{assetsQuery.error.message}
            </p>
          ) : assets.length ? (
            <table
              className="responsive-table"
              aria-label="Data Asset 结构化列表结果"
            >
              <thead>
                <tr>
                  <th>名称</th>
                  <th>来源 / 格式</th>
                  <th>状态 / 上传人</th>
                  <th>上传时间</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((item: any) => (
                  <tr key={item.id}>
                    <td data-label="名称">
                      <a
                        href={`/assets/${encodeURIComponent(item.id)}`}
                        onClick={(event) =>
                          handleNavigate(
                            event,
                            `/assets/${encodeURIComponent(item.id)}`,
                          )
                        }
                      >
                        {item.name}
                      </a>
                      <small>{item.id}</small>
                    </td>
                    <td data-label="来源 / 格式">
                      {item.sourceType} · {item.format} · {item.sensitivity}
                    </td>
                    <td data-label="状态 / 上传人">
                      {item.status} · {item.uploadedBy}
                    </td>
                    <td data-label="上传时间">
                      <time dateTime={item.uploadedAt}>
                        {formatInSelectedZone(item.uploadedAt)}
                      </time>
                      <small>UTC {item.uploadedAt}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : submittedAssetFilters ? (
            <p className="state-view">
              暂无匹配资产；请调整结构化条件，或先上传允许的非敏感原始资产。
            </p>
          ) : (
            <p className="state-view">输入任一结构化条件后列出匹配资产。</p>
          )}
          {assetsQuery.data && assetPagination && (
            <div className="pager" aria-label="Data Asset 分页">
              <Button
                aria-label="资产上一页"
                disabled={assetPagination.offset === 0}
                onClick={() =>
                  setAssetPage(
                    Math.max(0, assetPagination.offset - assetPagination.limit),
                  )
                }
              >
                上一页
              </Button>
              <span>
                {assetPagination.total
                  ? `${assetPagination.offset + 1}-${Math.min(
                      assetPagination.offset + assetPagination.limit,
                      assetPagination.total,
                    )} / ${assetPagination.total}`
                  : "0 / 0"}
              </span>
              <Button
                aria-label="资产下一页"
                disabled={
                  assetPagination.offset + assetPagination.limit >=
                  assetPagination.total
                }
                onClick={() =>
                  setAssetPage(assetPagination.offset + assetPagination.limit)
                }
              >
                下一页
              </Button>
            </div>
          )}
        </Card>
      )}

      {(!section || section === "test-sets") && (
        <Card
          id="structured-test-sets"
          className="card wide"
          role="region"
          aria-label="Test Set 摘要列表"
        >
          <span className="step">STRUCTURED LIST / TEST SETS</span>
          <h3>Test Set 摘要列表</h3>
          {testSetsQuery.isLoading ? (
            <p className="state-view" aria-busy="true">
              正在加载测试集列表…
            </p>
          ) : testSetsQuery.error ? (
            <p className="state-view error" role="alert">
              测试集摘要读取失败：{testSetsQuery.error.message}
            </p>
          ) : testSets.length ? (
            <table
              className="responsive-table"
              aria-label="Test Set 摘要列表结果"
            >
              <thead>
                <tr>
                  <th>测试集 / 可用性</th>
                  <th>默认 / 最新版本</th>
                  <th>用例数 / 发布人</th>
                  <th>最近交付</th>
                </tr>
              </thead>
              <tbody>
                {testSets.map((item: any) => (
                  <tr key={item.id}>
                    <td data-label="测试集 / 可用性">
                      <a
                        href={`/test-sets/${encodeURIComponent(item.id)}`}
                        onClick={(event) =>
                          handleNavigate(
                            event,
                            `/test-sets/${encodeURIComponent(item.id)}`,
                          )
                        }
                      >
                        {item.name}
                      </a>
                      <br />
                      {item.availability === "unavailable_by_deletion"
                        ? "删除不可用（仅保留审计与墓碑）"
                        : item.availability}
                    </td>
                    <td data-label="默认 / 最新版本">
                      {item.defaultVersion
                        ? `默认 v${item.defaultVersion.number} · ${item.defaultVersion.status}`
                        : "默认版本未设置"}
                      <br />
                      {item.latestVersion
                        ? `最新 v${item.latestVersion.number} · ${
                            item.latestVersion.status === "archived"
                              ? "普通归档（历史可读）"
                              : item.latestVersion.status
                          }`
                        : "尚未发布"}
                    </td>
                    <td data-label="用例数 / 发布人">
                      {item.testCaseCount ?? "0"} ·{" "}
                      {item.lastPublisher ?? "未发布"}
                    </td>
                    <td data-label="最近交付">
                      {item.recentDeliveryState ?? "无交付"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="state-view">
              暂无测试集；请先上传原始资产并打开工作草稿。{" "}
              <a
                href="/assets"
                onClick={(event) => handleNavigate(event, "/assets")}
              >
                前往 Data Assets
              </a>
            </p>
          )}
          {testSetPagination && (
            <div className="pager" aria-label="Test Set 分页">
              <Button
                aria-label="测试集上一页"
                disabled={testSetPagination.offset === 0}
                onClick={() =>
                  setTestSetPage(
                    Math.max(
                      0,
                      testSetPagination.offset - testSetPagination.limit,
                    ),
                  )
                }
              >
                上一页
              </Button>
              <span>
                {testSetPagination.total
                  ? `${testSetPagination.offset + 1}-${Math.min(
                      testSetPagination.offset + testSetPagination.limit,
                      testSetPagination.total,
                    )} / ${testSetPagination.total}`
                  : "0 / 0"}
              </span>
              <Button
                aria-label="测试集下一页"
                disabled={
                  testSetPagination.offset + testSetPagination.limit >=
                  testSetPagination.total
                }
                onClick={() =>
                  setTestSetPage(
                    testSetPagination.offset + testSetPagination.limit,
                  )
                }
              >
                下一页
              </Button>
            </div>
          )}
        </Card>
      )}

      {(!section || section === "cases") && (
        <Card
          id="case-query"
          className="card wide"
          role="region"
          aria-label="固定版本 Test Case 结构化查询"
        >
          <span className="step">STRUCTURED QUERY / TEST CASES</span>
          <h3>固定版本 Test Case 结构化查询</h3>
          <p>
            当前固定版本：{testSetId ?? "未打开"} · {versionId ?? "未发布"}
          </p>
          <div className="parser-config">
            <label>
              case_id（精确）
              <Input
                aria-label="case_id 精确查询"
                value={caseId}
                onChange={(event) => setCaseId(event.target.value)}
              />
            </label>
            <label>
              Metadata key（顶层精确）
              <Input
                aria-label="业务元数据键精确查询"
                value={metadataKey}
                onChange={(event) => setMetadataKey(event.target.value)}
              />
            </label>
            <label>
              Metadata value（精确）
              <Input
                aria-label="业务元数据值精确查询"
                value={metadataValue}
                onChange={(event) => setMetadataValue(event.target.value)}
              />
            </label>
          </div>
          <Button onClick={submitCaseQuery} disabled={!testSetId || !versionId}>
            按结构化条件查询
          </Button>
          {caseQueryValidationError && (
            <p className="state-view error" role="alert">
              {caseQueryValidationError}
            </p>
          )}
          {casesQuery.error && (
            <p className="state-view error" role="alert">
              结构化用例查询失败：{casesQuery.error.message}
            </p>
          )}
          {cases?.length ? (
            <ul aria-label="固定版本用例查询结果">
              {cases.map((item: any) => (
                <li key={item.caseId}>
                  {item.caseId} · ordinal {item.ordinal} · metadata{" "}
                  {JSON.stringify(item.metadata)}
                </li>
              ))}
            </ul>
          ) : cases ? (
            <p className="state-view">
              当前固定版本没有匹配用例；请核对 case_id 或顶层业务元数据键值。
            </p>
          ) : (
            <p className="state-view">
              发布固定版本后，可按 case_id 或业务元数据精确查询。
            </p>
          )}
          {casePagination && (
            <div className="pager" aria-label="固定版本用例分页">
              <Button
                aria-label="固定版本用例上一页"
                disabled={casePagination.offset === 0}
                onClick={() =>
                  setCaseOffset(
                    Math.max(0, casePagination.offset - casePagination.limit),
                  )
                }
              >
                上一页
              </Button>
              <span>
                {casePagination.total
                  ? `${casePagination.offset + 1}-${Math.min(
                      casePagination.offset + casePagination.limit,
                      casePagination.total,
                    )} / ${casePagination.total}`
                  : "0 / 0"}
              </span>
              <Button
                aria-label="固定版本用例下一页"
                disabled={
                  casePagination.offset + casePagination.limit >=
                  casePagination.total
                }
                onClick={() =>
                  setCaseOffset(casePagination.offset + casePagination.limit)
                }
              >
                下一页
              </Button>
            </div>
          )}
        </Card>
      )}

      {(!section || section === "audit") && (
        <Card
          id="project-audit"
          className="card wide"
          role="region"
          aria-label="项目 Audit Event 列表"
        >
          <span className="step">AUDIT / RESPONSIBILITY FACTS</span>
          <h3>项目 Audit Event</h3>
          <label>
            显示时区
            <select
              aria-label="审计显示时区"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {timezoneOptions.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          <p>审计事实以 UTC 存储和比较；下方第一行仅按所选时区显示。</p>
          <div className="parser-config" aria-label="Audit Event 结构化筛选">
            <label>
              对象类型
              <select
                aria-label="审计对象类型筛选"
                value={auditFilters.objectType}
                onChange={(event) =>
                  setAuditFilters({
                    ...auditFilters,
                    objectType: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                {AUDIT_OBJECT_TYPES.map((objectType) => (
                  <option key={objectType} value={objectType}>
                    {objectType}
                  </option>
                ))}
              </select>
            </label>
            <label>
              对象 ID
              <Input
                aria-label="审计对象 ID 筛选"
                value={auditFilters.objectId}
                onChange={(event) =>
                  setAuditFilters({
                    ...auditFilters,
                    objectId: event.target.value,
                  })
                }
              />
            </label>
            <label>
              动作
              <select
                aria-label="审计动作筛选"
                value={auditFilters.action}
                onChange={(event) =>
                  setAuditFilters({
                    ...auditFilters,
                    action: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                {AUDIT_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
            </label>
            <label>
              操作者 ID
              <Input
                aria-label="审计操作者 ID 筛选"
                value={auditFilters.actorId}
                onChange={(event) =>
                  setAuditFilters({
                    ...auditFilters,
                    actorId: event.target.value,
                  })
                }
              />
            </label>
          </div>
          <Button onClick={submitAuditFilters}>应用审计结构化筛选</Button>
          {auditQuery.isLoading ? (
            <p className="state-view" aria-busy="true">
              正在加载审计事件…
            </p>
          ) : auditQuery.error ? (
            <p className="state-view error" role="alert">
              审计筛选失败：{auditQuery.error.message}
            </p>
          ) : auditEvents.length ? (
            <table
              className="responsive-table"
              aria-label="项目 Audit Event 结果"
            >
              <thead>
                <tr>
                  <th>UTC 事实 / 显示时间</th>
                  <th>操作者 / 动作</th>
                  <th>对象 / 结果</th>
                  <th>引用</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((event: any) => (
                  <tr key={`${event.id}-${event.occurredAt}`}>
                    <td data-label="UTC 事实 / 显示时间">
                      <time dateTime={event.occurredAt}>
                        {formatInSelectedZone(event.occurredAt)}
                      </time>
                      <br />
                      <small>UTC {event.occurredAt}</small>
                    </td>
                    <td data-label="操作者 / 动作">
                      {event.actor} · {event.action}
                    </td>
                    <td data-label="对象 / 结果">
                      {event.objectType} / {event.objectId} · {event.outcome}
                    </td>
                    <td data-label="引用">
                      {event.reference?.correlationId ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="state-view">暂无匹配审计事件；请调整结构化条件。</p>
          )}
          {auditPagination && (
            <div className="pager" aria-label="Audit Event 分页">
              <Button
                aria-label="审计上一页"
                disabled={auditPagination.offset === 0}
                onClick={() =>
                  setSubmittedAuditFilters((current) => ({
                    ...current,
                    offset: String(
                      Math.max(
                        0,
                        auditPagination.offset - auditPagination.limit,
                      ),
                    ),
                  }))
                }
              >
                上一页
              </Button>
              <span>
                {auditPagination.total
                  ? `${auditPagination.offset + 1}-${Math.min(
                      auditPagination.offset + auditPagination.limit,
                      auditPagination.total,
                    )} / ${auditPagination.total}`
                  : "0 / 0"}
              </span>
              <Button
                aria-label="审计下一页"
                disabled={
                  auditPagination.offset + auditPagination.limit >=
                  auditPagination.total
                }
                onClick={() =>
                  setSubmittedAuditFilters((current) => ({
                    ...current,
                    offset: String(
                      auditPagination.offset + auditPagination.limit,
                    ),
                  }))
                }
              >
                下一页
              </Button>
            </div>
          )}
          {summary && (
            <div aria-label="结构化产品漏斗事件计数">
              <strong>事件总数：{summary.total}</strong>
              <ul>
                {summary.events.map((event: any) => (
                  <li key={`${event.action}-${event.outcome}`}>
                    {event.action} · {event.outcome} · {event.count}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
