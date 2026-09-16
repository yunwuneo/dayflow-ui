export class APIError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...options, credentials: 'same-origin',
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Dayflow-Request': '1', ...options.headers } });
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new APIError((await response.json().catch(() => ({}))).error || '请求失败', response.status);
  }
  return response.json();
}
export interface Activity {
  record_id: number; device_id: string; day: string; title: string; summary: string;
  detailed_summary: string; category: string; subcategory: string; start: string; end: string;
  duration_minutes: number; apps: string[]; source_deleted: boolean; has_screenshot: boolean;
}
export interface Category { name: string; color_hex: string; is_idle: boolean; is_system: boolean }
export interface Overview {
  date: string; today: string; time_zone: string; day_boundary_hour: number; available_days: string[];
  categories: Category[]; totals: { category: string; minutes: number; count: number }[];
  devices: { id: string; name: string; last_sync_at: string; time_zone: string; revision: number;
    status: { last_capture_at?: string; pending_batches?: number; failed_batches?: number } }[];
  daily: { highlights?: string[]; tasks?: string[]; blockers?: string | string[] } | null;
  weekly: { tracked_minutes: number; focus_minutes: number; week_start: string; week_end: string;
    categories: { name: string; minutes: number; share: number }[] } | null;
}
export const screenshotURL = (item: Activity) => `/api/v1/activities/${item.device_id}/${item.record_id}/screenshot`;
