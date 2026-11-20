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
  has_daily_brief?: boolean;
}
export interface DailyBriefPerson { name: string; note?: string }
export interface DailyBriefLink { title: string; url?: string; app?: string }
export interface DailyBriefFeedbackNote { name: string; source?: string; text: string; url?: string }
export interface DailyBriefDocketItem {
  title: string; detail?: string; due?: string; people?: DailyBriefPerson[]; links?: DailyBriefLink[];
  prompt?: string; agent?: boolean; feedback?: DailyBriefFeedbackNote[];
  feedbackSummary?: string; feedbackUrl?: string; attach?: string[]; thread?: string; newThreadApp?: string;
}
export interface DailyBriefTrackingItem { label: string; status: string; app?: string; asOf?: string; url?: string }
export interface DailyBriefCompletedItem { project?: string; title: string; apps?: string[]; cardId?: number; imageFile?: string }
export interface DailyBriefDecisionItem { decision: string; date?: string; people?: string[]; place?: string; app?: string; url?: string }
export interface DailyBriefReadingItem {
  title: string; source?: string; url: string; reason?: string; imageUrl?: string;
  hook?: string; minutes?: number; imageFile?: string; imageIsTitleCard?: boolean;
}
export interface DailyBriefNewsItem {
  headline: string; source?: string; url: string; published?: string; imageFile?: string; imageIsTitleCard?: boolean;
}
export interface DailyBriefContent {
  order?: string[];
  docket?: DailyBriefDocketItem[];
  keep_tracking?: DailyBriefTrackingItem[];
  completed_yesterday?: DailyBriefCompletedItem[];
  team_decisions?: DailyBriefDecisionItem[];
  related_reading_intro?: string;
  related_reading?: DailyBriefReadingItem[];
  industry_news?: DailyBriefNewsItem[];
}
export interface DailyBriefHandoff {
  title: string; dismissed?: boolean; agent?: string; method?: string; at?: string;
  reason?: string; reviewed?: boolean; outputFile?: string; finishedAt?: string; failed?: boolean;
}
export interface DailyBriefUserState {
  checkedItemKeys?: string[];
  dismissedItemKeys?: string[];
  addedTasks?: { id: string; title: string }[];
  hasBeenShown?: boolean;
  promptEdits?: Record<string, string>;
  folders?: Record<string, string>;
  handoffs?: DailyBriefHandoff[];
  docketRating?: number;
  docketFeedback?: string;
}
export interface DailyBrief {
  device_id: string; day: string; source_day: string; source: string; generated_at: string;
  content: DailyBriefContent; user_state: DailyBriefUserState;
  stats?: { durationSeconds?: number; model?: string; costUSD?: number; cardCount?: number } | null;
  images: string[];
}
export interface DailyBriefResponse {
  date: string; today: string; time_zone: string; day_boundary_hour: number;
  available_days: string[]; brief: DailyBrief | null;
}
export interface LobehubAssistant { id: string; name: string; agent_id: string }
export interface LobehubSettings {
  base_url: string;
  default_assistant_id: string;
  handoff_mode: 'auto_send' | 'copy_open';
  assistants: LobehubAssistant[];
}
export const screenshotURL = (item: Activity) => `/api/v1/activities/${item.device_id}/${item.record_id}/screenshot`;
export const briefImageURL = (deviceId: string, day: string, file: string) => {
  const clean = file.replace(/^images\//, '');
  return `/api/v1/daily-briefs/${deviceId}/${day}/images/${encodeURIComponent(clean)}`;
};
export const safeWebURL = (raw?: string) => {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch { return undefined; }
};
