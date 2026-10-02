export interface BadgeNavigator {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

export function totalUnreadCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0), 0);
}

export async function syncUnreadAppBadge(counts: Record<string, number>, target: BadgeNavigator = navigator as BadgeNavigator): Promise<void> {
  const unread = totalUnreadCount(counts);
  try {
    if (unread > 0 && target.setAppBadge) await target.setAppBadge(unread);
    else if (unread === 0 && target.clearAppBadge) await target.clearAppBadge();
  } catch {
    // Badging is progressive enhancement and must never block sync or startup.
  }
}
