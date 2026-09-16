export type Role = "owner" | "manager" | "editor" | "agent" | "viewer";
export type Permission =
  | "settings.write"
  | "channels.connect"
  | "audit.read"
  | "system.read"
  | "posts.write"
  | "replies.write"
  | "approvals.write";
const permissions: Record<Role, Permission[]> = {
  owner: [
    "settings.write",
    "channels.connect",
    "audit.read",
    "system.read",
    "posts.write",
    "replies.write",
    "approvals.write",
  ],
  manager: [
    "audit.read",
    "system.read",
    "posts.write",
    "replies.write",
    "approvals.write",
  ],
  editor: ["posts.write"],
  agent: ["replies.write", "approvals.write"],
  viewer: ["audit.read", "system.read"],
};
export function can(
  role: Role,
  scope: string[],
  permission: Permission,
  channel?: string,
  denied: string[] = [],
): boolean {
  return (
    permissions[role].includes(permission) &&
    (role === "owner" || !denied.includes(permission)) &&
    (!channel || scope.includes("*") || scope.includes(channel))
  );
}
