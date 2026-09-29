import type { OnlineUser } from "@/services/collaboration";

const roleName = { admin: "管理员", editor: "编辑", viewer: "查看" };
export function OnlineAvatars({
  users,
  selfId,
  className = "",
  small = false,
  editingField,
}: {
  users: OnlineUser[];
  selfId?: string;
  className?: string;
  small?: boolean;
  editingField?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-[5px] ${className}`} aria-label="在线成员">
      {users.map((user) => {
        const label = editingField
          ? `${user.name}正在编辑${editingField}`
          : `${user.name}${user.id === selfId ? "（我）" : ""} · ${roleName[user.role]} · 在线`;
        return (
          <span
            key={user.id}
            role="img"
            tabIndex={0}
            aria-label={label}
            className={`group relative inline-grid shrink-0 cursor-default place-items-center rounded-full font-semibold text-white outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary ${small ? "size-[22px] text-[10px]" : "size-[30px] text-xs"}`}
            style={{ backgroundColor: user.avatarColor }}
          >
            {Array.from(user.name.trim())[0]?.toLocaleUpperCase() ?? "?"}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-0 top-[calc(100%+8px)] z-50 hidden min-w-[120px] whitespace-nowrap rounded-md border bg-card px-[10px] py-2 text-left text-xs font-normal text-foreground shadow-md group-hover:block group-focus-visible:block"
            >
              <b className="block">
                {user.name}
                {user.id === selfId ? "（我）" : ""}
              </b>
              <small className="mt-[3px] block text-muted-foreground">
                {roleName[user.role]} · {editingField ? `正在编辑${editingField}` : "在线"}
              </small>
            </span>
          </span>
        );
      })}
    </span>
  );
}
