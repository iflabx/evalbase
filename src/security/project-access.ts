import type { Database } from "../db/pool.js";

export type ProjectCapability = "read" | "write" | "export" | "manage";

export interface ProjectCapabilities {
  read: boolean;
  write: boolean;
  export: boolean;
  manage: boolean;
}

const rolesByCapability: Record<ProjectCapability, readonly string[]> = {
  read: ["owner", "editor", "viewer"],
  write: ["owner", "editor"],
  export: ["owner", "editor", "viewer"],
  manage: ["owner"],
};

export function capabilitiesForRole(role: unknown): ProjectCapabilities {
  const normalized = String(role);
  return {
    read: rolesByCapability.read.includes(normalized),
    write: rolesByCapability.write.includes(normalized),
    export: rolesByCapability.export.includes(normalized),
    manage: rolesByCapability.manage.includes(normalized),
  };
}

export function isTestIdentityRole(role: unknown): boolean {
  return ["editor", "viewer"].includes(String(role));
}

export async function hasProjectCapability(
  db: Database,
  projectId: string,
  actorId: string,
  capability: ProjectCapability,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM project p
     JOIN app_user u ON u.id = $2
     LEFT JOIN project_member pm ON pm.project_id = p.id AND pm.user_id = u.id
     WHERE p.id = $1 AND (u.role = 'admin' OR pm.role = ANY($3::text[]))`,
    [projectId, actorId, rolesByCapability[capability]],
  );
  return Boolean(result.rowCount);
}

export async function requireProjectCapability(
  db: Database,
  projectId: string,
  actorId: string,
  capability: ProjectCapability,
): Promise<void> {
  if (!(await hasProjectCapability(db, projectId, actorId, capability))) {
    throw Object.assign(new Error("Project capability denied"), {
      code: "project_not_found",
    });
  }
}
