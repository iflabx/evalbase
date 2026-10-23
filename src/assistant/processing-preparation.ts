import { projectQueryFields } from "./query-contract.js";
import { bindTaskInput, planSource, sourceWithinTask } from "./plan.js";
import { selectionParameters } from "./plan.js";
import { explicitRequirementCount } from "./requirements.js";
import { canonicalJson } from "../package/contract.js";
import { selectionProblems } from "../selection/index.js";
import type {
  PreparationIssue,
  PreparationResult,
} from "./plan-preparation.js";

// These helpers only recognize explicit directives. Unknown or conflicting scope stays a clarification.
const clauses = (text: string) =>
  text
    .split(/[，,。；;！!？?\n]/u)
    .map((s) => s.trim())
    .filter(Boolean);
const denied = (text: string) =>
  /(?:不要|不得|不许|不允许|不需要|不改|不动|不可|不做|禁止|无需|不需|不能|不想|别|保持.{0,12}不变|保留.{0,12}原)/u.test(
    text,
  );
function scopeIntent(text: string): "all" | "partial" | undefined {
  let all = false,
    partial = false;
  for (const clause of clauses(text)) {
    const match = clause.match(/全部|所有|整份|整个|全量/u);
    const fieldOnly =
      match &&
      /^(?:问题|期望输出|metadata|元数据|字段|标点)/iu.test(
        clause.slice(match.index! + match[0].length),
      );
    if (match && !fieldOnly) {
      if (denied(clause)) partial = true;
      else all = true;
    }
    if (
      !match &&
      /(?:只|仅)(?:清洗|处理|改写|选取|保留).+(?:记录|数据)/u.test(clause)
    )
      partial = true;
    if (
      /第[一二三四五六七八九十0-9]+条|(?:前|后)[0-9]+条|这几条|(?:只|仅)(?:清洗|处理|改写|选取|保留)?[一二三四五六七八九十0-9]+条|部分(?:记录|数据)|选中|勾选|随机|抽取|指定记录/u.test(
        clause,
      )
    )
      partial = true;
  }
  return partial ? "partial" : all ? "all" : undefined;
}
/** Only actual user scope directives tied to successful source receipts may survive clarification. */
export function sourceScopeRequest(
  history: { user_text: string; tool_results: any[]; status?: string }[],
  source: Record<string, any> | null | undefined,
) {
  if (!source) return "";
  const wanted = canonicalJson(planSource(source));
  let active: string | undefined,
    request = "";
  for (const row of history) {
    const targets = (row.tool_results ?? [])
      .filter((t) => t.status === "succeeded")
      .map((t) => t.result?.task?.target ?? t.result?.state?.resolvedSource)
      .filter(Boolean);
    const next = targets.length
      ? canonicalJson(planSource(targets.at(-1)))
      : active;
    if (next !== active) request = "";
    active = next;
    const intent = scopeIntent(row.user_text);
    const confirmed =
      row.status === "succeeded" &&
      (row.tool_results ?? []).some(
        (t) =>
          t.name === "plan_task" &&
          t.status === "succeeded" &&
          t.result?.task?.target &&
          canonicalJson(planSource(t.result.task.target)) === wanted &&
          ["plan", "execute"].includes(
            t.result.control?.mode ?? t.result.task.turnControl?.mode,
          ),
      );
    if (
      active === wanted &&
      (intent === "partial" || (intent === "all" && confirmed))
    )
      request = row.user_text;
    // Once the service asks to resolve a range, ordinary continuation must not
    // revive an older whole-source grant. Keep the user choice unresolved.
    const unresolvedScope = (row.tool_results ?? []).some(
      (tool) =>
        tool.result?.task?.processingClarification?.kind === "scope" ||
        tool.result?.clarification?.kind === "scope" ||
        (["read_records", "submit_processing", "preview_selection"].includes(
          tool.name,
        ) &&
          tool.result?.requiresClarification === true) ||
        (tool.status === "failed" &&
          (tool.error?.code === "processing_scope_invalid" ||
            tool.error?.issues?.some(
              (issue: any) => issue.code === "processing_scope_invalid",
            ))),
    );
    if (active === wanted && unresolvedScope) request = "";
  }
  return active === wanted ? request : "";
}
export function wholeSourceAuthorized(request: string, prior: string) {
  const current = scopeIntent(request);
  if (current) return current === "all";
  const parts = clauses(request);
  const continuation =
    /^(?:请)?(?:执行方案|按方案执行|继续(?:执行)?|开始(?:执行|清洗|处理|改写))$/u;
  // Extra clauses must be known field/trim constraints; an unrecognized subset
  // cannot inherit earlier permission for the whole source.
  return (
    scopeIntent(prior) === "all" &&
    parts.some((p) => continuation.test(p)) &&
    parts.every((p) => continuation.test(p) || defaultCleanClause(p))
  );
}
const semanticChange =
  /(?:纠错|错别字|标点|改写|翻译|格式|统一|抽取|分类|标注)/u;
/** Recognize only complete default trim and explicit field preservation. */
function defaultCleanClause(text: string): "trim" | "preserve" | undefined {
  const normalized = text
    .replace(/question/giu, "问题")
    .replace(/expectedOutput/giu, "期望输出")
    .replace(/metadata/giu, "元数据")
    .replace(/\s+/gu, "");
  const trim =
    /^(?:仅|只)?(?:整理|去掉|去除|清理)(?:问题(?:字段)?的?)?(?:首尾|前后)(?:的)?(?:空白|空格(?:和|及|、)换行|换行(?:和|及|、)空格)$/u;
  const preserve =
    /^(?:(?:不修改|不改变)(?:问题(?:内部)?内容|期望输出|元数据)(?:(?:和|及|、)(?:期望输出|元数据))*|(?:问题(?:内部)?内容|期望输出|元数据)(?:(?:和|及|、)(?:期望输出|元数据))*(?:保持原样|保持不变))$/u;
  return trim.test(normalized)
    ? "trim"
    : preserve.test(normalized)
      ? "preserve"
      : undefined;
}
function defaultCleanDescription(text: string) {
  const parts = clauses(text).map(defaultCleanClause);
  return parts.includes("trim") && parts.every(Boolean);
}
function cleanDirective(facts: ToolFacts) {
  const current = clauses(facts.request);
  const positive = (text: string) =>
    clauses(text).some((c) => semanticChange.test(c) && !denied(c));
  if (positive(facts.request)) return facts.request.trim();
  if (
    current.some(
      (c) => (semanticChange.test(c) || /语义|内容/u.test(c)) && denied(c),
    )
  )
    return undefined;
  return (facts.authorizedText ?? "")
    .split("\n")
    .reverse()
    .find(positive)
    ?.trim();
}
function fieldChangeAuthorized(facts: ToolFacts, field: string) {
  const label =
    field === "metadata"
      ? /metadata|元数据/iu
      : field === "question"
        ? /问题|原文/u
        : /期望输出/u;
  const has = (text: string) =>
    clauses(text).some(
      (c) =>
        label.test(c) &&
        /(?:修改|清洗|整理|处理|允许|纠正)/u.test(c) &&
        !denied(c),
    );
  if (clauses(facts.request).some((c) => label.test(c) && denied(c)))
    return false;
  return has(facts.request) || has(facts.authorizedText ?? "");
}
export type ToolFacts = {
  task: Record<string, any>;
  request: string;
  picked?: Record<string, any> | null;
  partial?: boolean;
  metadataKeys?: string[];
  sourceCount?: number;
  authorizedText?: string;
  authorizedScopeText?: string;
};
export const preparedTools = new Set([
  "query_project",
  "read_background",
  "read_records",
  "create_draft",
  "preview_selection",
  "submit_processing",
  "generate_candidates",
  "select_candidates",
  "refine_candidates",
  "request_processing_apply",
]);
/** Pure conditional checks. Actual object access, fixed ranges and transaction guards stay with their services. */
export function prepareToolProposal(
  name: string,
  supplied: Record<string, any>,
  facts: ToolFacts,
): PreparationResult {
  const input = bindTaskInput(
    name,
    structuredClone(supplied),
    facts.task,
    undefined,
    facts.picked,
  );
  const issues: PreparationIssue[] = [];
  const operation = String(input.operation ?? name);
  const add = (
    path: string,
    message: string,
    code = "assistant_tool_input_invalid",
    keyword = "business",
  ) => issues.push({ tool: name, operation, path, keyword, code, message });
  const defined = (key: string) => input[key] !== undefined;
  const modes = (keys: string[]) =>
    keys.filter(
      (k) =>
        Array.isArray(input[k]) ||
        (input[k] && typeof input[k] === "object") ||
        input[k] === true,
    );
  const selection = (value: Record<string, any>, path: string) => {
    const count = explicitRequirementCount(facts.request, "new")?.targetCount;
    const normalized = selectionParameters(
      value,
      count ?? facts.task.targetCount,
    );
    for (const p of selectionProblems(normalized, path))
      add(p.path, p.message, "selection_invalid", p.keyword);
    return normalized;
  };
  if (
    input.selection &&
    typeof input.selection === "object" &&
    !Array.isArray(input.selection)
  )
    input.selection = selection(input.selection, "/selection");
  if (name === "preview_selection") {
    const configured = selection(
      Object.fromEntries(
        ["method", "conditions", "mode", "value", "seed"]
          .filter((k) => defined(k))
          .map((k) => [k, input[k]]),
      ),
      "",
    );
    Object.assign(input, configured);
  }
  if (Array.isArray(input.conditions)) {
    for (const p of selectionProblems({
      method: "all",
      conditions: input.conditions,
    }))
      add(p.path, p.message, "selection_invalid", p.keyword);
  }
  if (input.where && typeof input.where === "object") {
    for (const p of selectionProblems({
      method: "all",
      conditions: [input.where],
    }))
      add(
        p.path.replace("/conditions/0", "/where"),
        p.message,
        "selection_invalid",
        p.keyword,
      );
  }
  if (Array.isArray(input.groups))
    input.groups.forEach((g: any, i: number) => {
      if (g && typeof g === "object")
        for (const p of selectionProblems(
          {
            method: "random",
            mode: "count",
            value: g.count,
            conditions: g.conditions,
          },
          "/groups/" + i,
        ))
          add(p.path, p.message, "selection_invalid", p.keyword);
    });
  if (name === "select_candidates") {
    if (
      input.reselect === true &&
      !/(?:重新|重选|再抽|换.{0,5}种子)/u.test(facts.request)
    )
      add(
        "/reselect",
        "只有用户明确要求重新抽取才能改变原固定选择。",
        "assistant_candidate_selection_changed",
      );
    const prior = facts.task.candidateScope;
    const proposedSeed = input.seed?.trim() || input.selection?.seed?.trim();
    if (
      prior &&
      proposedSeed &&
      proposedSeed !== prior.seed &&
      input.reselect !== true
    )
      add(
        "/seed",
        "原选择已经固定，更换随机种子须用户明确要求。",
        "assistant_candidate_selection_changed",
      );

    if (
      [
        defined("selection"),
        defined("groups"),
        input.deduplicate === true,
      ].filter(Boolean).length !== 1
    )
      add(
        "/selection",
        "按一个选取规则或分组选取，不能同时提供或全部省略。",
        "selection_invalid",
      );
    const inner = input.selection?.seed;
    if (
      typeof inner === "string" &&
      typeof input.seed === "string" &&
      input.seed.trim() &&
      inner.trim() &&
      inner.trim() !== input.seed.trim()
    )
      add("/seed", "内外随机种子必须一致。", "selection_invalid");
  }
  if (name === "read_records" && defined("selection") && defined("conditions"))
    add(
      "/conditions",
      "条件请放在同一个选取规则中，不能同时提供两组条件。",
      "processing_scope_invalid",
    );
  if (name === "query_project") {
    const allowed = projectQueryFields[String(input.kind)];
    const fields = allowed
      ? ["search", "offset", "testSetId"].filter(
          (key) => !allowed.includes(key),
        )
      : [];
    for (const key of fields)
      if (defined(key))
        add("/" + key, "当前查询类型不使用此字段，请保留明确的查询范围。");
  }
  for (const key of ["query", "search"])
    if (defined(key) && typeof input[key] === "string" && !input[key].trim())
      add("/" + key, "查询文字不能为空白。");
  if (name === "create_draft") {
    if (defined("testSetId") !== defined("parentVersionId"))
      add(
        defined("testSetId") ? "/parentVersionId" : "/testSetId",
        "从版本建立草稿须同时指定测试集和父版本。",
      );
    if (defined("testSetId") || defined("parentVersionId"))
      for (const key of ["name", "purpose"])
        if (defined(key))
          add("/" + key, "版本草稿继承名称与用途，不能同时提供新建字段。");
    if (typeof input.name === "string" && !input.name.trim())
      add("/name", "草稿名称不能为空白。");
  }
  if (
    name === "request_processing_apply" &&
    input.target &&
    typeof input.target === "object"
  ) {
    const t = input.target;
    if (
      t.kind === "draft" &&
      ((!facts.partial && !t.id) ||
        (t.id !== undefined && typeof t.id !== "string"))
    )
      add("/target/id", "请选择目标草稿。");
    if (
      t.kind === "newDraft" &&
      ((!facts.partial && !t.name) ||
        (t.name !== undefined &&
          (typeof t.name !== "string" || !t.name.trim())))
    )
      add("/target/name", "请填写新草稿名称。");
    const allowed =
      t.kind === "asset"
        ? ["kind"]
        : t.kind === "draft"
          ? ["kind", "id"]
          : ["kind", "name", "purpose"];
    for (const k of Object.keys(t))
      if (!allowed.includes(k)) add("/target/" + k, "该保存位置不使用此字段。");
  }
  if (
    [
      "submit_processing",
      "refine_candidates",
      "request_processing_apply",
    ].includes(name)
  ) {
    const keys =
      name === "submit_processing"
        ? ["recordIds", "allRecords", "selection"]
        : name === "refine_candidates"
          ? ["resultIds", "allSelected", "allResults", "where"]
          : ["resultIds", "allSelected", "allValid"];
    const selected = modes(keys);
    if (selected.length > 1)
      add(
        "/" + selected[1],
        "请使用一个明确的记录范围，不能混用全部、勾选、条件或指定记录。",
        "processing_scope_invalid",
      );
    const sameScope =
      name === "submit_processing" &&
      facts.task.processingScope &&
      input.source &&
      JSON.stringify(planSource(facts.task.processingScope.source)) ===
        JSON.stringify(planSource(input.source));
    if (
      !facts.partial &&
      !selected.length &&
      !sameScope &&
      !(
        name === "request_processing_apply" &&
        input.allTask === true &&
        input.allValid === undefined
      )
    )
      add(
        "/" + keys[0],
        "请明确处理全部当前来源、选定记录或已固定范围。",
        "processing_scope_invalid",
      );
    if (
      facts.picked &&
      name !== "submit_processing" &&
      input.allSelected !== true &&
      (input.allResults === true ||
        input.where ||
        input.allValid === true ||
        input.allTask === true)
    )
      add(
        "/allSelected",
        "已有固定勾选，请使用该范围，或先明确取消勾选再处理其他范围。",
        "assistant_candidate_selection_changed",
      );
    if (input.allSelected === true && !facts.picked)
      add(
        "/allSelected",
        "当前没有可用的固定勾选。",
        "assistant_candidate_selection_invalid",
      );
    if (
      name === "request_processing_apply" &&
      input.allTask === true &&
      (input.resultIds || input.allValid === false)
    )
      add(
        "/allTask",
        "整个任务范围不能混用单批记录或否定全部有效结果。",
        "processing_scope_invalid",
      );
  }
  if (
    ["submit_processing", "generate_candidates", "refine_candidates"].includes(
      name,
    )
  ) {
    const op =
      name === "generate_candidates"
        ? "generate"
        : name === "refine_candidates"
          ? "rewrite"
          : input.operation;
    if (op !== "augment" && op !== "generate" && defined("outputCount"))
      add(
        "/outputCount",
        "清洗和改写的数量由固定输入确定，不填写新增数量。",
        "processing_configuration_invalid",
      );
    if (
      !facts.partial &&
      ["augment", "generate"].includes(op) &&
      !Number.isSafeInteger(input.outputCount)
    )
      add(
        "/outputCount",
        "请明确需要新增的记录数量。",
        "processing_configuration_invalid",
      );
    if (typeof input.instructions === "string") {
      const max = name === "refine_candidates" ? 2000 : 8000;
      if (input.instructions.length > max)
        add(
          "/instructions",
          "完整处理要求超过当前指令容量；输入保留，请按当前交付缩小本轮范围。",
          "processing_configuration_invalid",
          "capacity",
        );
      if (op !== "clean" && !input.instructions.trim())
        add(
          "/instructions",
          "请说明具体处理要求，不能是空白。",
          "processing_configuration_invalid",
        );
      else input.instructions = input.instructions.trim();
    }
    const allowed = input.allowedFields;
    if (Array.isArray(allowed))
      for (const f of allowed)
        if (facts.task.allowedFields && !facts.task.allowedFields.includes(f))
          add(
            "/allowedFields",
            "当前要求保护该字段，本次不能扩大修改范围。",
            "assistant_requirement_conflict",
          );
    if (Array.isArray(input.metadataKeys)) {
      const norm = input.metadataKeys
        .filter((k: any) => typeof k === "string")
        .map((k: string) => k.trim().toLowerCase());
      if (norm.some((k: string) => !k) || new Set(norm).size !== norm.length)
        add(
          "/metadataKeys",
          "Metadata字段名须非空，整理空白后不能重复。",
          "processing_configuration_invalid",
        );
      if (Array.isArray(allowed) && !allowed.includes("metadata"))
        add(
          "/metadataKeys",
          "Metadata保持原值时不能指定可修改的子字段。",
          "processing_configuration_invalid",
        );
      if (Array.isArray(facts.task.metadataKeys))
        for (const k of norm)
          if (
            !facts.task.metadataKeys.some(
              (v: string) => v.trim().toLowerCase() === k,
            )
          )
            add(
              "/metadataKeys",
              "该Metadata字段不在当前允许范围内。",
              "assistant_requirement_conflict",
            );
      if (facts.metadataKeys)
        input.metadataKeys.forEach((k: any, i: number) => {
          if (typeof k !== "string") return;
          const key = k.trim().toLowerCase();
          const known = [
            ...(facts.metadataKeys ?? []),
            ...(facts.task.metadataKeys ?? []),
          ].some((v) => v.trim().toLowerCase() === key);
          const text = facts.authorizedText ?? facts.request;
          if (!known && !text.toLowerCase().includes(key))
            add(
              "/metadataKeys/" + i,
              "请使用资料中存在或用户明确要求新增的Metadata子字段，顶层字段名不能代替它。",
              "processing_configuration_invalid",
            );
        });
    }
    if (Array.isArray(input.scenarios)) {
      if (
        input.scenarios.some((s: any) => typeof s === "string" && !s.trim()) ||
        new Set(
          input.scenarios
            .filter((s: any) => typeof s === "string")
            .map((s: string) => s.trim()),
        ).size !== input.scenarios.length
      )
        add(
          "/scenarios",
          "场景须非空且不能在整理空白后重复。",
          "processing_configuration_invalid",
        );
    }
    if (
      name === "submit_processing" &&
      input.source &&
      facts.task.target &&
      !sourceWithinTask(input.source, facts.task.target)
    )
      add(
        "/source",
        "处理来源已变化，请核对当前对象及范围。",
        "assistant_step_context_changed",
      );
    if (op === "clean") {
      const directive = cleanDirective(facts);
      if (directive) {
        input.instructions = directive;
        if (directive.length > 8000)
          add(
            "/instructions",
            "完整清洗要求超过8000字符，输入保留，请缩小本轮范围。",
            "processing_configuration_invalid",
            "capacity",
          );
      } else if (
        typeof input.instructions === "string" &&
        defaultCleanDescription(input.instructions)
      ) {
        input.instructions = "";
      } else if (input.instructions)
        add(
          "/instructions",
          "默认清洗不接受模型自行增加的语义处理，请保留用户实际要求。",
          "assistant_requirement_conflict",
        );
      const explicitFields = ["question", "expectedOutput", "metadata"].filter(
        (field) => fieldChangeAuthorized(facts, field),
      );
      const cleanFields = explicitFields.length ? explicitFields : ["question"];
      if (Array.isArray(allowed))
        for (const field of allowed)
          if (!cleanFields.includes(field))
            add(
              "/allowedFields",
              "清洗字段须匹配用户实际要求；默认只整理问题，不能将否定或未提及的字段改动当作授权。",
              "assistant_requirement_conflict",
            );
    }

    if (facts.sourceCount !== undefined) {
      const inputCount = (text: string) => {
        const match = text.match(
          /(?:全部|所有|输入|来源|原始数据|这)[\s：:共]*(\d+)\s*条/u,
        );
        return match ? Number(match[1]) : undefined;
      };
      const count =
        inputCount(facts.request) ??
        inputCount(facts.authorizedScopeText ?? facts.authorizedText ?? "");
      if (
        input.allRecords === true &&
        count !== undefined &&
        count !== facts.sourceCount
      )
        add(
          "/recordIds",
          "来源数量与明确要求不同，请先核对范围。",
          "assistant_requirement_conflict",
          "revision",
        );
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, input };
}

/** A rejected field may be corrected; other valid constraints are not a new authorization. */
export function processingRepairIssues(
  name: string,
  base: Record<string, any>,
  next: Record<string, any>,
  problems: PreparationIssue[] = [],
): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const broken = (field: string) =>
    problems.some(
      (p) => p.path === "/" + field || p.path.startsWith("/" + field + "/"),
    );
  const keep = (field: string, a: unknown, b: unknown) => {
    if (!broken(field) && canonicalJson(a ?? null) !== canonicalJson(b ?? null))
      issues.push({
        tool: name,
        operation: String(next.operation ?? name),
        path: "/" + field,
        keyword: "authorization",
        code: "assistant_requirement_conflict",
        message: "参数纠正须保留未报错的来源、固定范围、字段保护和用户数量。",
      });
  };
  if (name === "request_processing_apply") {
    if (base.runId) keep("runId", base.runId, next.runId);
    if (base.allTask !== undefined) keep("allTask", base.allTask, next.allTask);
    if (Array.isArray(base.resultIds) && broken("resultIds")) {
      const invalid = new Set(
        problems.flatMap((p) => {
          const match = p.path.match(/^\/resultIds\/(\d+)$/);
          return match && p.keyword === "reference" ? [Number(match[1])] : [];
        }),
      );
      const retained = new Set(
        base.resultIds.filter((_: any, i: number) => !invalid.has(i)),
      );
      if (
        !Array.isArray(next.resultIds) ||
        next.resultIds.length > retained.size + invalid.size ||
        [...retained].some((id) => !next.resultIds.includes(id)) ||
        (next.allTask === true && base.allTask !== true) ||
        next.allValid === true ||
        next.allSelected === true
      )
        issues.push({
          tool: name,
          operation: name,
          path: "/resultIds",
          keyword: "authorization",
          code: "assistant_requirement_conflict",
          message:
            "错误结果标识只能在原批次内修正，不得扩大数量或改为全部任务、全部候选或未固定勾选。",
        });
    }
  }
  if (base.source && ["assets", "draft", "version"].includes(base.source.kind))
    keep("source", planSource(base.source), planSource(next.source));
  for (const f of ["recordIds", "resultIds", "allowedFields"])
    if (Array.isArray(base[f])) keep(f, base[f], next[f]);
  for (const f of ["allSelected", "allRecords", "allResults", "allValid"])
    if (base[f] === false && next[f] === true) keep(f, false, true);
  if (["asset", "draft", "newDraft"].includes(base.target?.kind)) {
    keep("target/kind", base.target.kind, next.target?.kind);
    for (const field of base.target.kind === "draft"
      ? ["id"]
      : base.target.kind === "newDraft"
        ? ["name", "purpose"]
        : [])
      if (typeof base.target[field] === "string")
        keep("target/" + field, base.target[field], next.target?.[field]);
  }
  for (const field of name === "create_draft"
    ? ["name", "purpose", "testSetId", "parentVersionId"]
    : [])
    if (typeof base[field] === "string" && base[field].trim())
      keep(field, base[field], next[field]);
  if (
    typeof base.instructions === "string" &&
    base.instructions.trim() &&
    base.instructions.length <= (name === "refine_candidates" ? 2000 : 8000) &&
    base.operation !== "clean"
  )
    keep("instructions", base.instructions.trim(), next.instructions);
  if (
    (name === "generate_candidates" || base.operation === "augment") &&
    Number.isSafeInteger(base.outputCount) &&
    base.outputCount > 0 &&
    base.outputCount <= 10000
  )
    keep("outputCount", base.outputCount, next.outputCount);
  return issues;
}
