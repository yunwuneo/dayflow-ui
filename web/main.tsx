import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity as ActivityIcon, ArrowLeft, ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight,
  Clock3, Cloud, CloudOff, FileText, ImageOff, Layers3, LoaderCircle, LogOut, Maximize2,
  Menu, Search, SlidersHorizontal, Sun, X, RefreshCw, ShieldCheck, Monitor, BarChart3, AlertCircle } from 'lucide-react';
import { api, Activity, Overview, screenshotURL } from './api';
import './style.css';

const duration = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)}小时${Math.round(minutes % 60) ? ` ${Math.round(minutes % 60)}分` : ''}` : `${Math.round(minutes)}分钟`;
const shiftDate = (date: string, offset: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric' }) => new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const routeFromURL = () => { const q = new URLSearchParams(location.search); return { view: q.get('view') || 'timeline', date: q.get('date') || '' }; };
function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} className={`icon-button ${props.className || ''}`} aria-label={label} title={label}>{children}</button>;
}
function Empty({ text, icon: Icon = CalendarDays }: { text: string; icon?: typeof CalendarDays }) {
  return <div className="empty"><Icon size={30} strokeWidth={1.4} /><p>{text}</p></div>;
}
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [initialError, setInitialError] = useState('');
  const checkSession = () => { setInitialError(''); api('/auth/session').then(() => setAuthenticated(true)).catch(e => {
    if (e.status === 401) setAuthenticated(false); else setInitialError(e.message);
  }); };
  useEffect(() => {
    checkSession(); const handler = () => setAuthenticated(false);
    window.addEventListener('session-expired', handler);
    return () => window.removeEventListener('session-expired', handler);
  }, []);
  if (initialError) return <div className="login-shell"><AlertCircle /><p>{initialError}</p><button onClick={checkSession}>重新连接</button></div>;
  if (authenticated === null) return <div className="app-loading"><LoaderCircle className="spin" /><span>正在连接</span></div>;
  return authenticated ? <Workspace onLogout={async () => { await api('/auth/logout', { method: 'POST' }); setAuthenticated(false); }} /> : <Login onSuccess={() => setAuthenticated(true)} />;
}
function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('neo'); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <main className="login-shell"><div className="brand-mark large"><Sun size={30} /></div><h1>Dayflow Archive</h1>
    <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError('');
      try { await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); onSuccess(); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>
      <h2>登录个人空间</h2>
      <label>用户名<input autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>密码<input autoComplete="current-password" type="password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}登录</button>
    </form><span className="login-footer"><ShieldCheck size={14} />个人活动档案</span>
  </main>;
}
function Workspace({ onLogout }: { onLogout: () => Promise<void> }) {
  const [route, setRoute] = useState(routeFromURL);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [items, setItems] = useState<Activity[]>([]); const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [category, setCategory] = useState(''); const [includeDeleted, setIncludeDeleted] = useState(true);
  const [selected, setSelected] = useState<Activity | null>(null); const [imageOpen, setImageOpen] = useState(false);
  const [busy, setBusy] = useState(true); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false); const searchInput = useRef<HTMLInputElement>(null);
  const date = route.date || overview?.today || '';
  const zone = overview?.time_zone || 'Asia/Shanghai';
  const time = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  const navigate = (view: string, nextDate = date) => {
    const next = { view, date: nextDate }; const params = new URLSearchParams({ view }); if (nextDate) params.set('date', nextDate);
    history.pushState(null, '', `?${params}`); setRoute(next); setPage(1); setSelected(null); setCategory(''); setSidebarOpen(false);
  };
  useEffect(() => { const handler = () => { setRoute(routeFromURL()); setPage(1); setSelected(null); }; window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, []);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { const timer = setInterval(() => setRefresh(r => r + 1), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (route.view === 'search') searchInput.current?.focus(); }, [route.view]);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setBusy(true);
    api<Overview>(`/overview${route.date ? `?date=${route.date}` : ''}`, { signal: controller.signal }).then(setOverview)
      .catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [route.date, refresh]);
  useEffect(() => {
    if (!date || !['timeline', 'search'].includes(route.view)) return;
    const controller = new AbortController(); setBusy(true); setError('');
    const params = new URLSearchParams({ page: String(page), limit: '30' });
    if (route.view === 'timeline') params.set('date', date);
    else { if (search) params.set('q', search); params.set('include_deleted', String(includeDeleted)); }
    if (category) params.set('category', category);
    api<{ activities: Activity[]; total: number }>(`/activities?${params}`, { signal: controller.signal }).then(result => {
      setItems(result.activities); setTotal(result.total);
      setSelected(old => old ? result.activities.find(item => item.device_id === old.device_id && item.record_id === old.record_id) || null : null);
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [date, route.view, search, includeDeleted, category, page, refresh]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (imageOpen) setImageOpen(false); else { setSelected(null); setSidebarOpen(false); } } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [imageOpen]);
  const colors = new Map(overview?.categories.map(c => [c.name, c.color_hex]));
  const color = (name: string) => colors.get(name) || '#8b929b';
  const totalMinutes = overview?.totals.reduce((sum, item) => sum + item.minutes, 0) || 0;
  const count = overview?.totals.reduce((sum, item) => sum + item.count, 0) || 0;
  const primaryDevice = overview?.devices[0];
  const fresh = primaryDevice && Date.now() - new Date(primaryDevice.last_sync_at).getTime() < 45 * 60 * 1000;
  const title = route.view === 'search' ? '活动搜索' : route.view === 'status' ? '同步状态' : date ? dayLabel(date) : '时间线';
  return <div className="workspace">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <a className="brand" href="?view=timeline" onClick={e => { e.preventDefault(); navigate('timeline', overview?.today); }}><span className="brand-mark"><Sun size={23} /></span><span>Dayflow<span className="brand-sub">ARCHIVE</span></span></a>
      <div className="nav-label">个人空间</div>
      <nav>
        <button className={['timeline', 'daily', 'weekly'].includes(route.view) ? 'active' : ''} onClick={() => navigate('timeline')}><CalendarDays size={18} />时间线</button>
        <button className={route.view === 'search' ? 'active' : ''} onClick={() => navigate('search')}><Search size={18} />搜索活动</button>
        <button className={route.view === 'status' ? 'active' : ''} onClick={() => navigate('status')}><Cloud size={18} />同步状态</button>
      </nav>
      <div className="sidebar-days"><div className="nav-label">最近记录</div>{overview?.available_days.slice(0, 7).map(day => <button className={day === date && route.view !== 'search' && route.view !== 'status' ? 'current' : ''} key={day} onClick={() => navigate('timeline', day)}><span>{dayLabel(day)}</span><span>{day === overview.today ? '今天' : dayLabel(day, { weekday: 'short' })}</span></button>)}</div>
      <div className="sidebar-bottom"><button className="device-link" onClick={() => navigate('status')}><span className={`status-dot ${fresh ? 'good' : ''}`} /><span>{primaryDevice ? 'Mac 已连接' : '等待首次同步'}<small>{primaryDevice ? `最近同步 ${time(primaryDevice.last_sync_at)}` : '尚无设备'}</small></span></button>
        <div className="account"><span className="avatar">N</span><span>个人档案<small>私有空间</small></span><IconButton label="退出登录" onClick={() => onLogout().catch(e => setError(e.message))}><LogOut size={17} /></IconButton></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumb"><IconButton className="mobile-menu" label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={19} /></IconButton><span>我的档案</span><ChevronRight size={14} /><strong>{route.view === 'search' ? '搜索' : route.view === 'status' ? '同步状态' : '时间线'}</strong></div>
        <div className="topbar-actions"><span className="private-label"><ShieldCheck size={14} />仅自己可见</span><IconButton label="刷新数据" onClick={() => setRefresh(r => r + 1)} disabled={busy}><RefreshCw size={17} className={busy ? 'spin' : ''} /></IconButton></div></header>
      <div className={`content ${selected ? 'with-detail' : ''}`}>
        <section className="primary-content">
          <div className="page-heading"><div><div className="eyebrow">{route.view === 'search' ? '历史记录' : route.view === 'status' ? '设备与数据' : date ? `${dayLabel(date, { year: 'numeric' })} · ${dayLabel(date, { weekday: 'long' })}` : '活动记录'}</div><h1>{title}{date === overview?.today && ['timeline', 'daily', 'weekly'].includes(route.view) && <span className="today-label">今天</span>}</h1></div>
            {!['search', 'status'].includes(route.view) && date && <div className="date-controls"><IconButton label="前一天" onClick={() => navigate(route.view, shiftDate(date, -1))}><ChevronLeft size={18} /></IconButton><label className="date-picker"><CalendarDays size={16} /><input aria-label="选择日期" type="date" value={date} max={overview?.today} onChange={e => { if (e.target.value) navigate(route.view, e.target.value); }} /></label><IconButton label="后一天" disabled={date >= (overview?.today || date)} onClick={() => navigate(route.view, shiftDate(date, 1))}><ChevronRight size={18} /></IconButton></div>}
          </div>
          {error && <div className="error-banner" role="alert"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setRefresh(r => r + 1)}>重试</button></div>}
          {!['search', 'status'].includes(route.view) && <>
            <div className="metrics"><div><span><Clock3 size={15} />记录时长</span><strong>{duration(totalMinutes)}</strong></div><div><span><Layers3 size={15} />活动记录</span><strong>{count}<small>条</small></strong></div><div><span><ActivityIcon size={15} />活动分类</span><strong>{overview?.totals.length || 0}<small>类</small></strong></div></div>
            {totalMinutes > 0 && <div className="day-distribution" aria-label="当天分类时间分布">{overview?.totals.map(item => <div key={item.category} style={{ width: `${item.minutes / totalMinutes * 100}%`, background: color(item.category) }} title={`${item.category} · ${duration(item.minutes)}`} />)}</div>}
            <div className="tabs" role="tablist" aria-label="记录视图">{[['timeline', '时间线', CalendarDays], ['daily', '日报', FileText], ['weekly', '周统计', BarChart3]].map(([key, label, Icon]) => { const I = Icon as typeof CalendarDays; return <button key={key as string} role="tab" aria-selected={route.view === key} className={route.view === key ? 'active' : ''} onClick={() => navigate(key as string)}><I size={16} />{label as string}</button>; })}</div>
          </>}
          {route.view === 'search' && <div className="search-tools"><div className="search-input"><Search size={19} /><input ref={searchInput} aria-label="搜索活动" placeholder="搜索标题、详情或应用…" value={query} onChange={e => setQuery(e.target.value)} />{query && <IconButton label="清除搜索" onClick={() => setQuery('')}><X size={16} /></IconButton>}</div><label className="checkbox-label"><input type="checkbox" checked={includeDeleted} onChange={e => { setIncludeDeleted(e.target.checked); setPage(1); }} />包含源端已删除</label></div>}
          {['timeline', 'search'].includes(route.view) && <>
            <div className="list-toolbar"><span>{route.view === 'search' ? `${total} 条结果` : '活动记录'}</span><label className="category-select"><SlidersHorizontal size={14} /><select aria-label="筛选分类" value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}><option value="">全部分类</option>{overview?.categories.map(c => <option key={c.name}>{c.name}</option>)}</select></label></div>
            {busy && !items.length ? <div className="list-loading"><LoaderCircle className="spin" size={22} />正在加载</div> : !items.length ? <Empty text={route.view === 'search' ? '没有找到匹配的活动' : '当天暂无活动记录'} icon={route.view === 'search' ? Search : CalendarDays} /> : <div className={`activity-list ${busy ? 'refreshing' : ''}`}>{items.map(item => <button key={`${item.device_id}-${item.record_id}`} className={`activity-row ${selected?.record_id === item.record_id && selected.device_id === item.device_id ? 'selected' : ''}`} onClick={() => setSelected(item)}>
              <div className="activity-time">{route.view === 'search' && <span className="search-date">{dayLabel(item.day)}</span>}<strong>{time(item.start)}</strong><span>{time(item.end)}</span></div>
              <div className="timeline-track"><span style={{ background: color(item.category) }} /></div>
              <div className="activity-text"><div className="activity-tags"><span className="category-dot" style={{ background: color(item.category) }} /><span>{item.category}</span><span className="tag-divider">·</span><span>{duration(item.duration_minutes)}</span>{item.source_deleted && <span className="archived-tag">源端已删除</span>}</div><h3>{item.title}</h3><p>{item.summary}</p><div className="app-names">{item.apps.slice(0, 3).map(app => <span key={app}>{app}</span>)}</div></div>
              <Screenshot item={item} className="activity-thumbnail" />
            </button>)}</div>}
            {total > 30 && <div className="pagination"><span>共 {total} 条 · 第 {page} / {Math.ceil(total / 30)} 页</span><IconButton label="上一页" disabled={page === 1 || busy} onClick={() => { setPage(p => p - 1); setSelected(null); }}><ChevronLeft size={17} /></IconButton><IconButton label="下一页" disabled={page * 30 >= total || busy} onClick={() => { setPage(p => p + 1); setSelected(null); }}><ChevronRight size={17} /></IconButton></div>}
          </>}
          {route.view === 'daily' && <Daily data={overview?.daily || null} />}
          {route.view === 'weekly' && <Weekly data={overview?.weekly || null} color={color} />}
          {route.view === 'status' && <Status overview={overview} />}
        </section>
        {selected && <aside className="detail" aria-label="活动详情"><div className="detail-header"><span>活动详情</span><IconButton label="关闭详情" onClick={() => setSelected(null)}><X size={18} /></IconButton></div><div className="detail-content"><div className="detail-category"><span className="category-dot" style={{ background: color(selected.category) }} />{selected.category}{selected.source_deleted && <span className="archived-tag">源端已删除</span>}</div><h2>{selected.title}</h2><div className="detail-time"><CalendarDays size={14} />{dayLabel(selected.day)}<span>{time(selected.start)} – {time(selected.end)}</span></div><div className="detail-duration"><Clock3 size={14} />{duration(selected.duration_minutes)}</div>
          <button className="screenshot-button" disabled={!selected.has_screenshot} onClick={() => setImageOpen(true)} aria-label="放大截图"><Screenshot key={`${selected.device_id}-${selected.record_id}`} item={selected} className="detail-screenshot" />{selected.has_screenshot && <span><Maximize2 size={16} /></span>}</button>
          <h3>活动摘要</h3><p className="detail-summary">{selected.summary || '暂无摘要'}</p>{selected.detailed_summary && <><h3>详细记录</h3><div className="detail-writeup">{selected.detailed_summary}</div></>}
          {!!selected.apps.length && <><h3>相关应用</h3><div className="detail-apps">{selected.apps.map(app => <span key={app}><Monitor size={14} />{app}</span>)}</div></>}
          <footer>记录 #{selected.record_id}</footer></div></aside>}
      </div>
    </main>
    {imageOpen && selected && <ImageDialog item={selected} onClose={() => setImageOpen(false)} />}
  </div>;
}
function Screenshot({ item, className }: { item: Activity; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!item.has_screenshot || failed) return <div className={`${className} screenshot-empty`}><ImageOff size={19} /><span>{failed ? '截图不可用' : '暂无截图'}</span></div>;
  return <img className={className} loading="lazy" src={screenshotURL(item)} alt={`${item.title}的活动截图`} onError={() => setFailed(true)} />;
}
function ImageDialog({ item, onClose }: { item: Activity; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="image-dialog" onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}><div><IconButton label="关闭大图" onClick={onClose}><X size={22} /></IconButton><img src={screenshotURL(item)} alt={item.title} /><p>{item.title}</p></div></dialog>;
}
function Daily({ data }: { data: Overview['daily'] }) {
  if (!data) return <Empty text="当天暂无日报" icon={FileText} />;
  const blockers = Array.isArray(data.blockers) ? data.blockers : data.blockers ? [data.blockers] : [];
  return <div className="daily-view"><div className="section-heading"><FileText size={18} /><h2>每日回顾</h2></div>
    <section><h3><span className="section-marker green" />工作亮点</h3>{data.highlights?.length ? <ul>{data.highlights.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="muted">暂无工作亮点</p>}</section>
    <section><h3><span className="section-marker blue" />后续任务</h3>{data.tasks?.length ? <ul className="task-list">{data.tasks.map((item, i) => <li key={i}><span className="task-box" />{item}</li>)}</ul> : <p className="muted">暂无后续任务</p>}</section>
    <section><h3><span className="section-marker amber" />阻碍与待解决</h3>{blockers.length ? <ul>{blockers.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="muted"><Check size={15} />暂无阻碍</p>}</section>
  </div>;
}
function Weekly({ data, color }: { data: Overview['weekly']; color: (category: string) => string }) {
  if (!data) return <Empty text="本周暂无统计" icon={BarChart3} />;
  const weekStart = data.week_start.slice(0, 10); const weekEnd = shiftDate(data.week_end.slice(0, 10), -1);
  return <div className="weekly-view"><div className="section-heading"><BarChart3 size={18} /><h2>本周时间分配</h2><span>{dayLabel(weekStart)} – {dayLabel(weekEnd)}</span></div>
    <div className="weekly-metrics"><div><span>记录时长</span><strong>{duration(data.tracked_minutes)}</strong></div><div><span>专注时长</span><strong>{duration(data.focus_minutes)}</strong></div></div>
    <div className="weekly-categories">{data.categories.map(item => <div className="weekly-category" key={item.name}><div><span><i style={{ background: color(item.name) }} />{item.name}</span><strong>{duration(item.minutes)}<small>{Math.round(item.share * 100)}%</small></strong></div><div className="bar-track"><div style={{ width: `${Math.min(100, item.share * 100)}%`, background: color(item.name) }} /></div></div>)}</div>
  </div>;
}
function Status({ overview }: { overview: Overview | null }) {
  if (!overview?.devices.length) return <Empty text="等待客户端首次同步" icon={CloudOff} />;
  const format = (value?: string) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: overview.time_zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '暂无';
  return <div className="status-view">{overview.devices.map(device => <section key={device.id}><div className="device-heading"><Monitor size={26} /><div><h2>{device.name}</h2><span>{device.time_zone}</span></div><span className="connected"><Check size={14} />已配对</span></div><dl><div><dt>最近同步</dt><dd>{format(device.last_sync_at)}</dd></div><div><dt>最近采集</dt><dd>{format(device.status.last_capture_at)}</dd></div><div><dt>等待分析</dt><dd>{device.status.pending_batches ?? 0} 批次</dd></div><div><dt>分析失败</dt><dd>{device.status.failed_batches ?? 0} 批次</dd></div><div><dt>已确认同步批次</dt><dd>{device.revision}</dd></div><div><dt>日期分界</dt><dd>{String(overview.day_boundary_hour).padStart(2, '0')}:00</dd></div><div><dt>设备 ID</dt><dd className="mono">{device.id}</dd></div></dl></section>)}</div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
