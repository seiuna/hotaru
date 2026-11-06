/** Formats an ISO timestamp as `YYYY-MM-DD HH:mm` in local time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Relative time in Chinese, coarse on purpose (this is an ops surface). */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';

  const diff = Math.round((time - now) / 1000);
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [60, '秒'],
    [60, '分钟'],
    [24, '小时'],
    [30, '天'],
    [12, '个月'],
  ];

  let value = abs;
  let unit = '秒';
  for (const [size, label] of units) {
    if (value < size) {
      unit = label;
      break;
    }
    value = Math.floor(value / size);
    unit = label;
  }
  if (abs < 5) return '刚刚';
  return diff >= 0 ? `${value} ${unit}后` : `${value} ${unit}前`;
}

/** `8123` -> `2 小时 15 分`. Used for token/session lifetimes. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '已过期';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
  return `${secs} 秒`;
}

export function shortUuid(uuid: string): string {
  return uuid.length > 12 ? `${uuid.slice(0, 8)}…${uuid.slice(-4)}` : uuid;
}

export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length === 0 ? '?' : trimmed.slice(0, 1).toUpperCase();
}
