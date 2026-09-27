import { useState } from "react";
import type { DatasetKind } from "@/types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  SAMPLE_CSV,
  applyMapping,
  freezeVersion,
  parseFile,
  validateSamples,
} from "@/services/datasets";
import type {
  DatasetSample,
  FieldMapping,
  FieldTarget,
  ParsedFile,
  ValidationIssue,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  ErrorBlock,
  PageHeader,
  RunningBlock,
  SuccessBlock,
  WarningBlock,
} from "@/components/state-view";

export const Route = createFileRoute("/datasets/new")({
  head: () => ({
    meta: [
      { title: "新建数据集 · AgentEval Hub" },
      { name: "description", content: "文件导入、字段映射、预览、校验并固化不可变数据集版本。" },
      { property: "og:title", content: "新建数据集 · AgentEval Hub" },
      { property: "og:description", content: "文件导入、字段映射、预览、校验并固化数据集版本。" },
    ],
  }),
  component: NewDatasetPage,
});

const STEPS = ["文件导入", "字段映射", "数据预览", "校验", "固化版本"];

function NewDatasetPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [samples, setSamples] = useState<DatasetSample[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DatasetKind>("test_set");
  const [description, setDescription] = useState("");
  const [page, setPage] = useState(0);

  const parseMutation = useMutation({
    mutationFn: (input: { fileName: string; content: string }) =>
      parseFile(input.fileName, input.content),
    onSuccess: (parsed) => {
      setFile(parsed);
      setMappings(
        parsed.columns.map((c) => ({
          sourceColumn: c,
          target: guessTarget(c),
        })),
      );
      setName((n) => n || parsed.fileName.replace(/\.(csv|jsonl)$/i, ""));
      setStep(1);
    },
  });

  const validateMutation = useMutation({
    mutationFn: validateSamples,
    onSuccess: setIssues,
  });

  const freezeMutation = useMutation({
    mutationFn: freezeVersion,
    onSuccess: async ({ dataset, version }) => {
      await qc.invalidateQueries({ queryKey: ["datasets"] });
      toast.success(`已固化 ${version.version}`, { description: version.contentHash });
      void navigate({ to: "/datasets/$id", params: { id: dataset.id } });
    },
  });

  const errorCount = issues?.filter((i) => i.level === "error").length ?? 0;
  const warnCount = issues?.filter((i) => i.level === "warning").length ?? 0;

  async function onFileSelected(f: File) {
    const content = await f.text();
    parseMutation.mutate({ fileName: f.name, content });
  }

  function goPreview() {
    if (!file) return;
    const hasQuestion = mappings.some((m) => m.target === "question");
    const hasExpected = mappings.some((m) => m.target === "expected_output");
    if (!hasQuestion || !hasExpected) {
      toast.error("必须分别映射 question 与 expected_output 各一列");
      return;
    }
    setSamples(applyMapping(file, mappings));
    setIssues(null);
    setPage(0);
    setStep(2);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="新建数据集"
        description="五步完成：导入 → 映射 → 预览 → 校验 → 固化版本。"
      />

      <ol className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`flex size-6 items-center justify-center rounded-full border text-xs ${
                i < step
                  ? "border-chart-2/50 bg-chart-2/20 text-chart-2"
                  : i === step
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground"
              }`}
            >
              {i < step ? <Check className="size-3" /> : i + 1}
            </span>
            <span className={i === step ? "text-foreground" : "text-muted-foreground"}>{s}</span>
            {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">›</span>}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. 文件导入</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <label
              htmlFor="file-input"
              className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-12 text-center transition-colors hover:border-primary/60"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) void onFileSelected(f);
              }}
            >
              <FileUp className="mb-2 size-7 text-muted-foreground" />
              <span className="text-sm font-medium">拖拽 CSV / JSONL 文件到此处，或点击选择</span>
              <span className="mt-1 text-xs text-muted-foreground">
                首行需为列名；expected_output 只保存期望答案，不保存模型实际输出
              </span>
              <input
                id="file-input"
                type="file"
                accept=".csv,.jsonl,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFileSelected(f);
                }}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  parseMutation.mutate({ fileName: "示例数据集.csv", content: SAMPLE_CSV })
                }
              >
                使用示例文件
              </Button>
              {parseMutation.isPending && (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> 解析中…
                </span>
              )}
            </div>
            {parseMutation.isError && (
              <ErrorBlock
                message={parseMutation.error.message}
                onRetry={() => parseMutation.reset()}
              />
            )}
          </CardContent>
        </Card>
      )}

      {step === 1 && file && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              2. 字段映射 · {file.fileName}（{file.rows.length} 行）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>源列</TableHead>
                  <TableHead>样例值</TableHead>
                  <TableHead className="w-56">映射目标</TableHead>
                  <TableHead className="w-48">metadata key</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappings.map((m, i) => (
                  <TableRow key={m.sourceColumn}>
                    <TableCell className="font-mono text-xs">{m.sourceColumn}</TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                      {file.rows[0]?.[m.sourceColumn] || "—"}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={m.target}
                        onValueChange={(v) =>
                          setMappings((prev) =>
                            prev.map((x, xi) =>
                              xi === i ? { ...x, target: v as FieldTarget } : x,
                            ),
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="question">question（问题）</SelectItem>
                          <SelectItem value="expected_output">
                            expected_output（期望答案）
                          </SelectItem>
                          <SelectItem value="metadata">metadata</SelectItem>
                          <SelectItem value="ignore">忽略</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        disabled={m.target !== "metadata"}
                        placeholder={m.sourceColumn}
                        value={m.metadataKey ?? ""}
                        onChange={(e) =>
                          setMappings((prev) =>
                            prev.map((x, xi) =>
                              xi === i ? { ...x, metadataKey: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(0)}>
                上一步
              </Button>
              <Button onClick={goPreview}>下一步：数据预览</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. 数据预览（{samples.length} 条）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">#</TableHead>
                  <TableHead>question</TableHead>
                  <TableHead>expected_output</TableHead>
                  <TableHead className="w-56">metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {samples.slice(page * 10, page * 10 + 10).map((s, i) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{page * 10 + i + 1}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm">{s.question || "—"}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm">
                      {s.expected_output || <span className="text-destructive">（空）</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {Object.entries(s.metadata)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" · ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </Button>
                <span className="text-muted-foreground">
                  第 {page + 1} / {Math.max(1, Math.ceil(samples.length / 10))} 页
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * 10 >= samples.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>
                  上一步
                </Button>
                <Button
                  onClick={() => {
                    setStep(3);
                    validateMutation.mutate(samples);
                  }}
                >
                  下一步：校验
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">4. 校验</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {validateMutation.isPending && <RunningBlock label="正在执行字段级校验…" />}
            {validateMutation.isError && (
              <ErrorBlock
                message={validateMutation.error.message}
                onRetry={() => validateMutation.mutate(samples)}
              />
            )}
            {issues && issues.length === 0 && (
              <SuccessBlock title="校验通过">所有样本均满足数据集契约，可以固化版本。</SuccessBlock>
            )}
            {issues && issues.length > 0 && (
              <>
                {errorCount > 0 ? (
                  <ErrorBlock
                    message={`存在 ${errorCount} 条阻断性错误，修复后才能固化版本；另有 ${warnCount} 条警告。`}
                  />
                ) : (
                  <WarningBlock title={`存在 ${warnCount} 条警告，可继续固化`} />
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">行号</TableHead>
                      <TableHead className="w-40">字段</TableHead>
                      <TableHead className="w-24">级别</TableHead>
                      <TableHead>说明</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {issues.map((iss, i) => (
                      <TableRow key={`${iss.row}-${iss.field}-${i}`}>
                        <TableCell className="font-mono text-xs">{iss.row}</TableCell>
                        <TableCell className="font-mono text-xs">{iss.field}</TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={
                              iss.level === "error"
                                ? "border-destructive/40 text-destructive"
                                : "border-chart-5/40 text-chart-5"
                            }
                          >
                            {iss.level === "error" ? "错误" : "警告"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{iss.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                上一步
              </Button>
              <Button disabled={!issues || errorCount > 0} onClick={() => setStep(4)}>
                下一步：固化版本
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">5. 固化版本</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <WarningBlock title="固化后不可修改">
              版本一旦生成即为只读，包含内容哈希与样本快照；后续修改需要创建新版本。
            </WarningBlock>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ds-name">数据集名称</Label>
                <Input id="ds-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ds-kind">数据集类型</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as DatasetKind)}>
                  <SelectTrigger id="ds-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="test_set">测试集（发布到 Langfuse）</SelectItem>
                    <SelectItem value="evaluated_result">评测结果集（可用于端到端计算）</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  测试集固化后进入发布流程；评测结果集固化后才能作为端到端计算输入。
                </p>
              </div>
              <div className="space-y-2">
                <Label>样本数</Label>
                <Input readOnly value={samples.length} className="mono" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-desc">描述</Label>
              <Textarea
                id="ds-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="说明该数据集的业务场景与使用范围"
              />
            </div>
            {freezeMutation.isPending && <RunningBlock label="正在生成不可变版本…" />}
            {freezeMutation.isError && <ErrorBlock message={freezeMutation.error.message} />}
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(3)}>
                上一步
              </Button>
              <Button
                disabled={!name.trim() || freezeMutation.isPending}
                onClick={() =>
                  freezeMutation.mutate({ datasetName: name, description, kind, samples })
                }
              >
                固化版本
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function guessTarget(column: string): FieldTarget {
  const c = column.toLowerCase();
  if (["question", "input", "query", "问题"].some((k) => c.includes(k))) return "question";
  if (["expected", "answer", "reference", "期望"].some((k) => c.includes(k)))
    return "expected_output";
  return "metadata";
}
