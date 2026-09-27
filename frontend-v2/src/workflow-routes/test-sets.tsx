import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList, Plus } from "lucide-react";

import { EmptyState } from "@/components/workflow-state";

export const Route = createFileRoute("/test-sets")({
  head: () => ({
    meta: [
      { title: "测试集 · AgentBench" },
      { name: "description", content: "创建、迭代和下载版本化测试集。" },
    ],
  }),
  component: TestSetsPage,
});

function TestSetsPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header>
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Workspace 02
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">测试集</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          从原始资料中选择记录，编辑并保存为可追溯的测试集版本。
        </p>
      </header>

      <section aria-labelledby="test-sets-empty-title" className="min-h-[26rem]">
        <EmptyState
          icon={ClipboardList}
          title="还没有测试集"
          description="完成原始资料上传后，可以从选中的记录创建第一个测试集。"
          actionLabel="新建测试集"
          actionIcon={Plus}
          actionDisabled
        />
      </section>
    </div>
  );
}
