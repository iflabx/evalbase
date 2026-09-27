import { db, delay, fail, nowIso, uid, faultInjection } from "./store";
import type {
  Dataset,
  DatasetKind,
  DatasetSample,
  DatasetVersion,
  FieldMapping,
  ParsedFile,
  ValidationIssue,
} from "@/types";

export async function listDatasets(): Promise<Dataset[]> {
  if (faultInjection.datasetsListFails) return fail("数据集服务暂不可用（503）");
  return delay(db.datasets);
}

export async function getDataset(id: string): Promise<Dataset> {
  const found = db.datasets.find((d) => d.id === id);
  if (!found) return fail(`数据集 ${id} 不存在`);
  return delay(found);
}

export async function listVersions(datasetId: string): Promise<DatasetVersion[]> {
  return delay(
    db.datasetVersions
      .filter((v) => v.datasetId === datasetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

export async function getVersion(versionId: string): Promise<DatasetVersion> {
  const found = db.datasetVersions.find((v) => v.id === versionId);
  if (!found) return fail(`数据集版本 ${versionId} 不存在`);
  return delay(found);
}

/** 解析上传文件（CSV / JSONL） */
export async function parseFile(fileName: string, content: string): Promise<ParsedFile> {
  const format: ParsedFile["format"] = fileName.endsWith(".jsonl") ? "jsonl" : "csv";
  let columns: string[] = [];
  let rows: Record<string, string>[] = [];

  if (format === "jsonl") {
    const lines = content.split("\n").filter((l) => l.trim());
    const parsed = lines.map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    });
    columns = Array.from(new Set(parsed.flatMap((o) => Object.keys(o))));
    rows = parsed.map((o) =>
      Object.fromEntries(columns.map((c) => [c, o[c] == null ? "" : String(o[c])])),
    );
  } else {
    const lines = content.split("\n").filter((l) => l.trim());
    if (!lines.length) return fail("文件为空或无法解析");
    columns = splitCsvLine(lines[0]!);
    rows = lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]));
    });
  }

  if (!columns.length) return fail("未识别到任何列，请检查文件格式");
  return delay({ fileName, format, columns, rows }, 600);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim().replace(/\r$/, ""));
  return out;
}

export function applyMapping(file: ParsedFile, mappings: FieldMapping[]): DatasetSample[] {
  const q = mappings.find((m) => m.target === "question");
  const e = mappings.find((m) => m.target === "expected_output");
  const metas = mappings.filter((m) => m.target === "metadata");
  return file.rows.map((row, i) => ({
    id: `S${String(i + 1).padStart(3, "0")}`,
    question: q ? (row[q.sourceColumn] ?? "") : "",
    expected_output: e ? (row[e.sourceColumn] ?? "") : "",
    metadata: Object.fromEntries(
      metas.map((m) => [m.metadataKey || m.sourceColumn, row[m.sourceColumn] ?? ""]),
    ),
  }));
}

export async function validateSamples(samples: DatasetSample[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number>();
  samples.forEach((s, idx) => {
    const row = idx + 1;
    if (!s.question.trim()) {
      issues.push({ row, field: "question", level: "error", message: "必填字段 question 为空" });
    } else if (s.question.trim().length < 4) {
      issues.push({
        row,
        field: "question",
        level: "warning",
        message: "question 过短，可能是列映射错误",
      });
    }
    if (!s.expected_output.trim()) {
      issues.push({
        row,
        field: "expected_output",
        level: "error",
        message: "必填字段 expected_output 为空（该字段只能保存期望答案）",
      });
    }
    const key = s.question.trim();
    if (key) {
      const prev = seen.get(key);
      if (prev) {
        issues.push({
          row,
          field: "question",
          level: "warning",
          message: `与第 ${prev} 行重复`,
        });
      } else seen.set(key, row);
    }
  });
  return delay(issues, 700);
}

export async function freezeVersion(input: {
  datasetId?: string;
  datasetName: string;
  description: string;
  kind?: DatasetKind;
  samples: DatasetSample[];
}): Promise<{ dataset: Dataset; version: DatasetVersion }> {
  if (!input.samples.length) return fail("没有可固化的样本");

  let dataset = input.datasetId ? db.datasets.find((d) => d.id === input.datasetId) : undefined;
  if (!dataset) {
    dataset = {
      id: uid("ds"),
      name: input.datasetName,
      description: input.description,
      kind: input.kind ?? "test_set",
      source: "file",
      owner: "current.user",
      status: "ACTIVE",
      currentVersion: null,
      sampleCount: 0,
      updatedAt: nowIso(),
      tags: ["新建"],
    };
    db.datasets = [dataset, ...db.datasets];
  }

  const target = dataset;
  const existing = db.datasetVersions.filter((v) => v.datasetId === target.id).length;
  const version: DatasetVersion = {
    id: uid("dv"),
    datasetId: target.id,
    version: `v${existing + 1}`,
    contentHash: `sha256:${hash(JSON.stringify(input.samples))}`,
    sampleCount: input.samples.length,
    createdAt: nowIso(),
    createdBy: "current.user",
    frozen: true,
    status: "READY",
    isDefault: true,
    samples: input.samples,
  };
  db.datasetVersions = [...db.datasetVersions, version];
  target.currentVersion = version.version;
  target.sampleCount = version.sampleCount;
  target.updatedAt = version.createdAt;
  db.datasets = db.datasets.map((d) => (d.id === target.id ? { ...target } : d));

  return delay({ dataset: target, version }, 900);
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(10, "0");
}

export const SAMPLE_CSV = `question,expected_answer,category,difficulty
近三年新能源汽车行业的市场集中度如何变化？,应说明 CR5 变化趋势并给出数据来源与区间。,行业,medium
帮我总结这份季度财报中的主要风险提示。,应列出至少三条风险并标注出处段落。,个股,easy
对比 A 股与港股当前的估值水平并说明依据。,应给出 PE/PB 对比与时间区间说明。,策略,hard
解释一下当前央行公开市场操作对流动性的影响。,,宏观,medium
半导体设备国产化率目前处于什么阶段？,应给出国产化率区间与关键环节说明。,行业,hard`;
