import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SelectionCondition } from "@/services/selection";

export function ProcessingFilters({
  search,
  conditions,
  onChange,
  disabled,
}: {
  search: string;
  conditions: SelectionCondition[];
  onChange: (search: string, conditions: SelectionCondition[]) => void;
  disabled: boolean;
}) {
  const [key, setKey] = useState(""),
    [operator, setOperator] = useState<SelectionCondition["operator"]>("contains"),
    [value, setValue] = useState("");
  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
        <Input
          aria-label="搜索输入记录"
          className="pl-9"
          placeholder="搜索问题、期望输出或 Metadata"
          value={search}
          maxLength={200}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value, conditions)}
        />
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Metadata 筛选{conditions.length ? `（${conditions.length}）` : ""}
        </summary>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            aria-label="Metadata 字段名"
            className="w-36"
            placeholder="字段名"
            value={key}
            maxLength={250}
            onChange={(event) => setKey(event.target.value)}
          />
          <Select value={operator} onValueChange={(v) => setOperator(v as typeof operator)}>
            <SelectTrigger aria-label="Metadata 比较方式" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries({
                contains: "包含",
                equals: "等于",
                empty: "为空",
                filled: "不为空",
              }).map(([op, label]) => (
                <SelectItem key={op} value={op}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {["contains", "equals"].includes(operator) && (
            <Input
              aria-label="Metadata 筛选值"
              className="w-36"
              value={value}
              placeholder="比较值"
              maxLength={200}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={
              disabled ||
              !key.trim() ||
              conditions.length >= 20 ||
              (["contains", "equals"].includes(operator) && !value.trim())
            }
            onClick={() => {
              onChange(search, [
                ...conditions,
                {
                  field: "metadata",
                  key: key.trim(),
                  operator,
                  ...(["contains", "equals"].includes(operator) ? { value } : {}),
                },
              ]);
              setKey("");
              setValue("");
            }}
          >
            添加筛选
          </Button>
        </div>
      </details>
      {conditions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {conditions.map((condition, index) => (
            <Button
              key={index}
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                onChange(
                  search,
                  conditions.filter((_, i) => i !== index),
                )
              }
            >
              {condition.key} ·{" "}
              {
                { contains: "包含", equals: "等于", empty: "为空", filled: "不为空" }[
                  condition.operator
                ]
              }{" "}
              {condition.value} ×
            </Button>
          ))}
        </div>
      )}
      {(search.length > 0 || conditions.length > 0) && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange("", [])}>
          清除搜索和筛选
        </Button>
      )}
    </div>
  );
}
