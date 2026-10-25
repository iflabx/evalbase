import { planningContinuation } from "./intent.js";
import type { Database } from "../db/pool.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { hasProjectCapability } from "../security/project-access.js";
import { assistantAccess, type AssistantScope } from "./store.js";

/** Resolve a continuation against the current task, even when the first discovery failed. */
export function sourceDiscoveryRequest(
  task: Record<string, any>,
  request: string,
) {
  return planningContinuation(request)
    ? String(task.sourceDiscovery?.requestText ?? task.goal ?? request)
    : request;
}
export function sourceDiscoveryApplies(
  task: Record<string, any>,
  request: string,
  input: Record<string, any>,
) {
  const work = sourceDiscoveryRequest(task, request);
  if (input.kind === "versions" && /版本|v\d+/iu.test(request)) return false;
  return (
    /整理|清洗|改写|扩写|扩充|处理/u.test(work) ||
    (!!task.sourceDiscovery &&
      (/继续|下一页|翻页|换|找|选择|第.+份/u.test(request) ||
        task.sourceDiscovery.items?.some((item: any) =>
          request.includes(item.name),
        )))
  );
}
const genericSourceReference =
  /^(?:(?:这些|这份|当前|所有|全部)(?:的)?(?:数据|资料|文件|记录|问题)?|数据|资料|文件|原始数据|当前项目|问题|期望输出|Metadata|文本|内容|清洗|整理|处理|改写|扩写|扩充|去重|筛选)$/iu;

/** Keep literal names as well as complete affirmative source commands. */
function sourceReferences(value: string) {
  const text = value
    .trim()
    .replace(/[。！!]+$/u, "")
    .replace(/^(?:(?:请(?:你)?|帮我|麻烦(?:你)?)\s*)+/u, "");
  const unquote = (s: string) => s.replace(/^[“「"]|[”」"]$/gu, "").trim();
  return [
    unquote(text),
    unquote(
      text.replace(
        /^(?:选择|使用|清洗|整理|处理|改写|扩写|扩充|用|选)(?:一下)?\s*/u,
        "",
      ),
    ),
  ];
}
/** Replies, searches and continuation all require the same single uncontradicted choice. */
function explicitSourceChoice(
  task: Record<string, any>,
  request: string,
  searchedName?: string,
) {
  const items = task.sourceDiscovery?.items ?? [];
  const names = [
    ...items.map((item: any) => item.name),
    ...(searchedName ? [searchedName] : []),
  ];
  const clean = (value: string) => value.trim().replace(/[。！!]+$/u, "");
  function itemFor(clause: string) {
    const references = sourceReferences(clause);
    const named = items.filter((item: any) => references.includes(item.name));
    if (named.length === 1) return named[0];
    const choice = references
      .map((text) => text.match(/^第([1-5一二三四五])份$/u))
      .find(Boolean);
    return choice
      ? items[
          Number(choice[1])
            ? Number(choice[1]) - 1
            : "一二三四五".indexOf(choice[1]!)
        ]
      : undefined;
  }
  function referencesSource(clause: string) {
    const [literal, operand] = sourceReferences(clause);
    return (
      /第[0-9一二两三四五六七八九十]+份/u.test(literal) ||
      /^(?:不要|别|不必|无需|不需要|不)(?:再)?(?:用|使用|选|选择)/u.test(
        literal,
      ) ||
      names.some((name) => clause.includes(name)) ||
      /\.(?:csv|jsonl?|pdf|txt|md)(?:[”」"]|$)/iu.test(literal) ||
      (/^(?:选择|使用|清洗|整理|处理|改写|扩写|扩充|用|选)/u.test(literal) &&
        !!operand &&
        !genericSourceReference.test(operand))
    );
  }
  const whole = itemFor(request);
  if (whole)
    return {
      referenced: true,
      source: toSource(whole),
      searchConfirmed: false,
    };
  const clauses = clean(request)
    .split(/[，,；;。\n]/u)
    .filter(referencesSource);
  const choices = clauses.map(itemFor);
  const first = choices[0];
  const source =
    first &&
    choices.every(
      (item: any) => item?.id === first.id && item?.kind === first.kind,
    )
      ? toSource(first)
      : undefined;
  const searchConfirmed =
    !!searchedName &&
    !!clauses.length &&
    clauses.every((clause) =>
      sourceReferences(clause).some(
        (reference) => reference.toLowerCase() === searchedName.toLowerCase(),
      ),
    );
  return { referenced: !!clauses.length, source, searchConfirmed };
}
export function sourceReply(task: Record<string, any>, request: string) {
  if (task.processingClarification?.kind !== "source") return undefined;
  return explicitSourceChoice(task, request).source;
}
/** One bounded source catalogue; legacy kind switches cannot open another search allowance. */
export async function discoverSources(
  db: Pick<Database, "query">,
  scope: AssistantScope,
  args: {
    task: Record<string, any>;
    request: string;
    requestId: string;
    input: Record<string, any>;
    preferred?: Record<string, any>;
  },
) {
  await assistantAccess(db, scope);
  const canWrite = await hasProjectCapability(
    db,
    scope.projectId,
    scope.actorId,
    "write",
  );
  const old = args.task.sourceDiscovery;

  const request = sourceDiscoveryRequest(args.task, args.request);
  const generic =
    /^(?:这些数据|这些|数据|资料|文件|原始数据|当前项目|全部|所有|清洗|整理|处理|改写|扩写|扩充|去重|筛选)$/u;
  const search =
    typeof args.input.search === "string" ? args.input.search.trim() : "";
  const choice = explicitSourceChoice(
    args.task,
    request,
    generic.test(search) ? undefined : search,
  );
  const unresolvedChoice =
    choice.referenced && !choice.source && !choice.searchConfirmed;
  const explicitName =
    !unresolvedChoice &&
    !!search &&
    !generic.test(search) &&
    choice.searchConfirmed;
  let query = choice.source
    ? ""
    : unresolvedChoice
      ? ""
      : explicitName
        ? search
        : (old?.query ?? "");
  const pageAsked = /下一页|翻页|换一页/u.test(args.request);
  const offset =
    pageAsked && old && old.requestId !== args.requestId
      ? (old.nextOffset ?? old.offset ?? 0)
      : old?.requestId === args.requestId
        ? (old.offset ?? 0)
        : 0;

  let preferred = unresolvedChoice
    ? undefined
    : (choice.source ??
      (old?.question && !explicitName
        ? undefined
        : (args.preferred ??
          args.task.target ??
          args.task.processingScope?.source ??
          old?.resolvedSource)));
  if (
    !explicitName &&
    preferred &&
    old?.resolvedSource &&
    canonicalJson(preferred) !== canonicalJson(old.resolvedSource)
  )
    query = "";
  const signature = sha256(
    canonicalJson({
      goal: args.task.goal ?? null,
      query,
      offset,
      canWrite,
      preferred: preferred ?? null,
    }),
  );
  const sql = `WITH candidates AS (
    SELECT 'asset'::text AS kind,a.id,a.file_name AS name,p.record_count::int AS count,NULL::bigint AS revision FROM data_asset a JOIN parsed_view p ON p.asset_id=a.id AND p.is_current WHERE a.project_id=$1 AND a.status='stored'
    UNION ALL
    SELECT 'draft',d.id,d.name,count(r.id) FILTER(WHERE NOT r.deleted)::int,d.revision FROM collaborative_draft d LEFT JOIN collaborative_draft_record r ON r.draft_id=d.id WHERE $2 AND d.project_id=$1 AND d.status='editing' GROUP BY d.id
    UNION ALL
    SELECT 'version',v.id,t.name||' · '||v.version_label,v.item_count::int,NULL::bigint FROM test_set_version v JOIN test_set t ON t.id=v.test_set_id WHERE $5='version' AND v.id=$6 AND t.project_id=$1 AND t.status='available' AND v.status='published'
  ) SELECT * FROM candidates WHERE ($3::text='' OR name ILIKE '%'||$3||'%') AND ($7::text[] IS NULL OR id=ANY($7)) ORDER BY name,kind,id LIMIT 6 OFFSET $4`;
  let preferredIds =
    preferred?.kind === "assets"
      ? preferred.assetIds
      : preferred?.id
        ? [preferred.id]
        : null;
  const cached = old?.signature === signature;
  // Revalidation uses only cached identities; it does not enumerate new candidates.
  const ids = preferredIds ?? (cached ? old.items.map((i: any) => i.id) : null);
  let reads = cached ? old.reads : 0;
  let rows = (
    await db.query(sql, [
      scope.projectId,
      canWrite,
      preferredIds && explicitName ? "" : query,
      ids ? 0 : offset,
      preferred?.kind ?? null,
      preferred?.id ?? null,
      ids,
    ])
  ).rows;
  if (!cached) reads++;
  if (
    preferredIds &&
    explicitName &&
    !cached &&
    (rows.some(
      (r) => !String(r.name).toLowerCase().includes(query.toLowerCase()),
    ) ||
      (!rows.length && old && query !== old.query))
  ) {
    preferred = undefined;
    preferredIds = null;
    rows = (
      await db.query(sql, [
        scope.projectId,
        canWrite,
        query,
        offset,
        null,
        null,
        null,
      ])
    ).rows;
    reads++;
  }
  if (!rows.length && query && !preferredIds && !cached && reads < 2) {
    query = "";
    rows = (
      await db.query(sql, [
        scope.projectId,
        canWrite,
        "",
        offset,
        null,
        null,
        null,
      ])
    ).rows;
    reads++;
  }
  const items = rows.slice(0, 5);
  const nextOffset = cached
    ? old.nextOffset
    : rows.length > 5
      ? offset + 5
      : null;
  const exactPreferred = preferredIds && items.length === preferredIds.length;
  const selected = exactPreferred
    ? preferred
    : explicitName && query && items.length === 1
      ? toSource(items[0])
      : undefined;
  const question = selected
    ? undefined
    : items.length
      ? "请选择要处理的资料：" +
        items
          .map(
            (i: any, n: number) =>
              "第" +
              (n + 1) +
              "份「" +
              i.name.slice(0, 80) +
              "」（" +
              (i.kind === "draft" ? "草稿" : "文件") +
              "，" +
              i.count +
              "条）",
          )
          .join("；") +
        "。"
      : preferredIds
        ? "先前选择的资料已不可用，请重新选择当前资料。"
        : "没有找到匹配资料，请说明资料名称或上传资料。";
  const state = {
    version: 1,
    signature: sha256(
      canonicalJson({
        goal: args.task.goal ?? null,
        query,
        offset,
        canWrite,
        preferred: selected ?? preferred ?? null,
      }),
    ),
    query,
    offset,
    nextOffset,
    reads,
    items,
    requestId: args.requestId,
    requestText: sourceDiscoveryRequest(args.task, args.request),
    ...(selected ? { resolvedSource: selected } : {}),
    ...(question ? { question } : {}),
  };
  return {
    state,
    items,
    nextOffset,
    logicalReads: reads,
    ...(selected ? { resolvedSource: selected } : {}),
    ...(question ? { question, requiresClarification: true } : {}),
  };
}
function toSource(item: Record<string, any>) {
  return item.kind === "asset"
    ? { kind: "assets", assetIds: [item.id] }
    : { kind: item.kind, id: item.id };
}
