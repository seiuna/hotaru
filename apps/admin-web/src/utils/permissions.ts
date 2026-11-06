import type { Scope } from '@skymatrix/shared-types';
import type { PermissionView } from '@skymatrix/api-contract';

export interface ScopeMeta {
  scope: Scope;
  label: string;
  description: string;
  group: '平台' | '管理';
  tone: 'sky' | 'mint' | 'amber';
}

/** Human copy for every scope the backend knows about (mirrors SCOPES). */
export const SCOPE_META: ScopeMeta[] = [
  {
    scope: 'skymatrix:profile',
    label: '账户资料',
    description: '读取自己的账户资料，所有玩家默认拥有',
    group: '平台',
    tone: 'sky',
  },
  {
    scope: 'skymatrix:resource',
    label: '资源服务',
    description: '访问 Mod 资源下载服务',
    group: '平台',
    tone: 'mint',
  },
  {
    scope: 'skymatrix:ircserver',
    label: 'IRC 服务',
    description: '连接内部 IRC 通讯服务',
    group: '平台',
    tone: 'mint',
  },
  {
    scope: 'skymatrix:license',
    label: '许可证',
    description: '查询软件许可证（保留能力）',
    group: '平台',
    tone: 'amber',
  },
  {
    scope: 'admin:users',
    label: '用户管理',
    description: '进入控制台：检索用户、改权限、封禁、查看审计',
    group: '管理',
    tone: 'amber',
  },
];

export function scopeMeta(scope: string): ScopeMeta {
  return (
    SCOPE_META.find((entry) => entry.scope === scope) ?? {
      scope: scope as Scope,
      label: scope,
      description: '未知权限',
      group: '平台',
      tone: 'sky',
    }
  );
}

export interface GrantDiff {
  added: Scope[];
  removed: Scope[];
  updated: Scope[];
  unchanged: Scope[];
}

export interface GrantInput {
  scope: Scope;
  expiresAt: string | null;
}

/** Existing grants keyed by scope, for the editor. */
export function grantsOf(permissions: PermissionView[]): GrantInput[] {
  return permissions.map((permission) => ({
    scope: permission.scope,
    expiresAt: permission.expiresAt,
  }));
}

/**
 * Computes what an operator's edit actually changes. The server replaces the
 * whole set, but the UI should describe the delta so a misclick is obvious
 * before it is saved.
 */
export function computeGrantDiff(current: GrantInput[], desired: GrantInput[]): GrantDiff {
  const before = new Map(current.map((grant) => [grant.scope, grant.expiresAt] as const));
  const after = new Map(desired.map((grant) => [grant.scope, grant.expiresAt] as const));

  const diff: GrantDiff = { added: [], removed: [], updated: [], unchanged: [] };

  for (const [scope, expiresAt] of after) {
    if (!before.has(scope)) diff.added.push(scope);
    else if (before.get(scope) !== expiresAt) diff.updated.push(scope);
    else diff.unchanged.push(scope);
  }
  for (const scope of before.keys()) {
    if (!after.has(scope)) diff.removed.push(scope);
  }

  const byScope = (left: Scope, right: Scope) => left.localeCompare(right);
  diff.added.sort(byScope);
  diff.removed.sort(byScope);
  diff.updated.sort(byScope);
  diff.unchanged.sort(byScope);
  return diff;
}

export function isDiffEmpty(diff: GrantDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0;
}

/** `2026-11-20T10:00` -> ISO, or null when the field was cleared. */
export function toIsoOrNull(localDateTime: string | null | undefined): string | null {
  if (!localDateTime) return null;
  const date = new Date(localDateTime);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** ISO -> value for `<input type="datetime-local">`. */
export function toLocalInputValue(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
