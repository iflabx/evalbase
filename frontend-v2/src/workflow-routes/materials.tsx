import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderOpen, Pencil, Plus, RefreshCw } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";

import { api, type Collection } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/materials")({
  head: () => ({
    meta: [
      { title: "原始资料 · AgentBench" },
      { name: "description", content: "按资料集合管理和浏览原始文件。" },
    ],
  }),
  component: MaterialsPage,
});

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function MaterialsPage() {
  const queryClient = useQueryClient();
  const collectionsQuery = useQuery({
    queryKey: ["raw-material-collections"],
    queryFn: () => api.collections(),
  });
  const [selectedId, setSelectedId] = useState<string>();
  const [openId, setOpenId] = useState<string>();
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<"create" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const collections = useMemo(
    () => collectionsQuery.data?.collections ?? [],
    [collectionsQuery.data],
  );
  const visibleCollections = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    if (!normalized) return collections;
    return collections.filter((collection) =>
      `${collection.name} ${collection.description}`.toLocaleLowerCase().includes(normalized),
    );
  }, [collections, search]);
  const selected = collections.find((collection) => collection.id === selectedId);
  const opened = collections.find((collection) => collection.id === openId);
  const detailQuery = useQuery({
    queryKey: ["raw-material-collection", openId],
    queryFn: () => api.collection(openId!),
    enabled: Boolean(openId),
  });

  useEffect(() => {
    if (!selectedId && collections[0]) setSelectedId(collections[0].id);
    if (selectedId && !collections.some((collection) => collection.id === selectedId))
      setSelectedId(collections[0]?.id);
  }, [collections, selectedId]);

  const createMutation = useMutation({
    mutationFn: () => api.createCollection({ name: name.trim(), description: description.trim() }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["raw-material-collections"] });
      setSelectedId(result.collection.id);
      setDialog(null);
      setName("");
      setDescription("");
    },
  });
  const renameMutation = useMutation({
    mutationFn: () => api.renameCollection(selectedId!, name.trim()),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["raw-material-collections"] });
      queryClient.invalidateQueries({ queryKey: ["raw-material-collection", selectedId] });
      setSelectedId(result.collection.id);
      setDialog(null);
      setName("");
    },
  });

  function openCreate() {
    setName("");
    setDescription("");
    setDialog("create");
  }

  function openRename() {
    if (!selected || selected.isUnfiled) return;
    setName(selected.name);
    setDialog("rename");
  }

  function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    if (dialog === "create") createMutation.mutate();
    if (dialog === "rename") renameMutation.mutate();
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Workspace 01
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">原始资料</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            先按领域或方向整理资料集合，再进入集合查看文件。集合只负责归类，不改变原始内容。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="rounded-full px-3 py-1 text-xs">
            非生产工作区
          </Badge>
          <Button onClick={openCreate}>
            <Plus aria-hidden="true" />
            新建资料集合
          </Button>
        </div>
      </header>

      {collectionsQuery.isError ? (
        <Card role="alert" className="border-destructive/40">
          <CardContent className="flex items-center justify-between gap-4 p-5 text-sm">
            <span>资料集合暂时无法加载，请确认非生产服务正在运行。</span>
            <Button variant="outline" size="sm" onClick={() => collectionsQuery.refetch()}>
              <RefreshCw aria-hidden="true" /> 重试
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <CardHeader className="gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>资料集合</CardTitle>
              <CardDescription>
                {collectionsQuery.isLoading
                  ? "正在读取集合..."
                  : `共 ${collections.length} 个集合，固定保留一个“未整理”入口。`}
              </CardDescription>
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索资料集合"
              aria-label="搜索资料集合"
              className="sm:max-w-56"
            />
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>资料集合</TableHead>
                  <TableHead className="w-28">文件</TableHead>
                  <TableHead className="w-40">最近更新</TableHead>
                  <TableHead className="w-24 text-right">进入</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {collectionsQuery.isLoading ? (
                  Array.from({ length: 3 }, (_, index) => (
                    <TableRow key={`loading-${index}`}>
                      <TableCell colSpan={4} className="h-14 text-muted-foreground">
                        正在加载...
                      </TableCell>
                    </TableRow>
                  ))
                ) : visibleCollections.length ? (
                  visibleCollections.map((collection) => (
                    <CollectionRow
                      key={collection.id}
                      collection={collection}
                      selected={collection.id === selectedId}
                      onSelect={() => setSelectedId(collection.id)}
                      onOpen={() => {
                        setSelectedId(collection.id);
                        setOpenId(collection.id);
                      }}
                    />
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="h-28 text-center text-muted-foreground">
                      没有匹配的资料集合。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderOpen className="size-4 text-primary" aria-hidden="true" />
              {opened ? "已打开集合" : "集合信息"}
            </CardTitle>
            <CardDescription>
              {opened ? "集合内文件摘要" : "单击列表行查看信息，点击箭头进入。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {opened ? (
              <OpenedCollection
                collection={opened}
                detail={detailQuery.data}
                loading={detailQuery.isLoading}
                onClose={() => setOpenId(undefined)}
              />
            ) : selected ? (
              <CollectionInspector collection={selected} onRename={openRename} />
            ) : (
              <p className="text-muted-foreground">暂无集合。</p>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        当前 Ticket 只提供集合归类和文件摘要；上传、内容解析与记录浏览会在后续工作流中接入。
      </p>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <form onSubmit={submitDialog}>
            <DialogHeader>
              <DialogTitle>{dialog === "rename" ? "重命名资料集合" : "新建资料集合"}</DialogTitle>
              <DialogDescription>
                {dialog === "rename"
                  ? "名称只影响归类显示，不会改变集合内文件或原始内容。"
                  : "集合是浅层归类容器，不支持目录树或自定义权限。"}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-5">
              <label className="grid gap-2 text-sm font-medium" htmlFor="collection-name">
                名称
                <Input
                  id="collection-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：客服公开资料"
                  maxLength={200}
                  autoFocus
                />
              </label>
              {dialog === "create" ? (
                <label className="grid gap-2 text-sm font-medium" htmlFor="collection-description">
                  说明（可选）
                  <Input
                    id="collection-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="说明这个集合包含的领域或方向"
                    maxLength={1_000}
                  />
                </label>
              ) : null}
              {(createMutation.isError || renameMutation.isError) && (
                <p role="alert" className="text-sm text-destructive">
                  操作失败：{(createMutation.error ?? renameMutation.error)?.message}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || createMutation.isPending || renameMutation.isPending}
              >
                {dialog === "rename" ? "保存名称" : "创建集合"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CollectionRow({
  collection,
  selected,
  onSelect,
  onOpen,
}: {
  collection: Collection;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      aria-selected={selected}
    >
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FolderOpen className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{collection.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {collection.description || "暂无说明"}
            </p>
          </div>
          {collection.isUnfiled ? (
            <Badge variant="secondary" className="shrink-0">
              系统入口
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell>{collection.fileCount} 个文件</TableCell>
      <TableCell className="text-muted-foreground">{formatDate(collection.updatedAt)}</TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`进入 ${collection.name}`}
          title={`进入 ${collection.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <ArrowRight aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CollectionInspector({
  collection,
  onRename,
}: {
  collection: Collection;
  onRename: () => void;
}) {
  return (
    <>
      <div>
        <p className="font-medium">{collection.name}</p>
        <p className="mt-1 leading-5 text-muted-foreground">
          {collection.description || "暂无说明"}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3">
        <div>
          <dt className="text-xs text-muted-foreground">文件数</dt>
          <dd className="mt-1 font-medium">{collection.fileCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">最近更新</dt>
          <dd className="mt-1 font-medium">{formatDate(collection.updatedAt)}</dd>
        </div>
      </dl>
      {collection.isUnfiled ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
          “未整理”是每个项目固定的集合，不能重命名或删除。
        </p>
      ) : (
        <Button variant="outline" size="sm" onClick={onRename}>
          <Pencil aria-hidden="true" /> 重命名
        </Button>
      )}
    </>
  );
}

function OpenedCollection({
  collection,
  detail,
  loading,
  onClose,
}: {
  collection: Collection;
  detail: Awaited<ReturnType<typeof api.collection>> | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <>
      <div>
        <p className="font-medium">{collection.name}</p>
        <p className="mt-1 leading-5 text-muted-foreground">
          {collection.description || "暂无说明"}
        </p>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">文件摘要</p>
        {loading ? (
          <p className="mt-3 text-sm text-muted-foreground">正在加载文件...</p>
        ) : detail?.files.length ? (
          <ul className="mt-3 space-y-2">
            {detail.files.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate" title={file.fileName}>
                  {file.fileName}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {file.recordCount === null ? formatBytes(file.size) : `${file.recordCount} 条`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">这个集合还没有文件。</p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onClose}>
        返回集合列表
      </Button>
    </>
  );
}
