const dayFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const yearFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

function localDayNumber(timestamp: number): number {
  const value = new Date(timestamp);
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000;
}

export function startsNewMessageDay(timestamp: number, previousTimestamp?: number): boolean {
  return previousTimestamp === undefined || localDayNumber(timestamp) !== localDayNumber(previousTimestamp);
}

export function messageDateLabel(timestamp: number, now = Date.now()): string {
  const dayDistance = localDayNumber(now) - localDayNumber(timestamp);
  if (dayDistance === 0) return "今天";
  if (dayDistance === 1) return "昨天";
  const value = new Date(timestamp);
  return value.getFullYear() === new Date(now).getFullYear() ? dayFormatter.format(value) : yearFormatter.format(value);
}

export function messageDateValue(timestamp: number): string {
  const value = new Date(timestamp);
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

export function millisecondsUntilNextLocalDay(now = Date.now()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 50);
  return Math.max(1, next.getTime() - now);
}
