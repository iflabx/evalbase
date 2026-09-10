import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { MetadataEntry } from "@/services/workspace";

export function MetadataEditor({
  open,
  entries,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  entries: MetadataEntry[];
  onOpenChange: (open: boolean) => void;
  onSave: (entries: MetadataEntry[]) => void;
}) {
  const [draft, setDraft] = useState<MetadataEntry[]>(entries);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setDraft(entries);
      setError("");
    }
  }, [entries, open]);

  function save() {
    const normalized = draft.map((entry) => ({ ...entry, key: entry.key.trim() }));
    if (normalized.some((entry) => !entry.key)) {
      setError("请填写每个 Metadata 字段名。");
      return;
    }
    if (
      new Set(normalized.map((entry) => entry.key.toLocaleLowerCase())).size !== normalized.length
    ) {
      setError("同一条记录不能使用重复的 Metadata 字段名。");
      return;
    }
    onSave(normalized);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑 Metadata</DialogTitle>
          <DialogDescription>将字段和值分开保存，便于之后浏览和筛选。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            删除某一项不会改动原始资料，只影响本次创建的测试集版本。
          </p>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2 text-xs text-muted-foreground">
            <span>字段名</span>
            <span>值</span>
            <span />
          </div>
          {draft.map((entry, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2">
              <Input
                aria-label={`第 ${index + 1} 项 Metadata 字段名`}
                placeholder="例如：渠道"
                value={entry.key}
                onChange={(event) =>
                  setDraft((items) =>
                    items.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, key: event.target.value } : item,
                    ),
                  )
                }
              />
              <Input
                aria-label={`第 ${index + 1} 项 Metadata 值`}
                placeholder="例如：帮助中心"
                value={entry.value}
                onChange={(event) =>
                  setDraft((items) =>
                    items.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`删除第 ${index + 1} 项 Metadata`}
                title="删除"
                onClick={() =>
                  setDraft((items) => items.filter((_, itemIndex) => itemIndex !== index))
                }
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={() => setDraft((items) => [...items, { key: "", value: "" }])}
          >
            <Plus className="size-4" /> 添加字段
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save}>保存 Metadata</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
