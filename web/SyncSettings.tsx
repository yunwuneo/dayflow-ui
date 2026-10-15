import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, ExternalLink, FileText, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from './api';
import './sync-settings.css';

interface SyncStatus {
  cloud_enabled: boolean; notion_enabled: boolean; configured: boolean; template_url: string | null;
  pending: number; failed: number; synced: number; last_upload_at: string | null;
  connection: null | { workspace_name: string; workspace_id: string; page_id: string | null; data_source_id: string | null;
    connected_at: string; last_success_at: string | null; last_error: string | null; retry_at: string | null };
}
interface Pages { pages: { id: string; title: string }[]; next_cursor: string | null }
const format = (date: string | null) => date ? new Date(date).toLocaleString('zh-CN') : '暂无';
const resultMessages: Record<string, string> = {
  connected: 'Notion 授权成功。请确认目标页面，然后开启同步。', denied: '已取消 Notion 授权，可以随时重新连接。',
  failed: 'Notion 授权未完成，请重新尝试；如持续失败，请检查服务器的连接配置。',
  workspace_mismatch: '授权工作区与当前连接不同。请先断开当前连接，再更换工作区。',
};

export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [pages, setPages] = useState<Pages>({ pages: [], next_cursor: null });
  const [pageId, setPageId] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [disconnect, setDisconnect] = useState(false);
  const [notice, setNotice] = useState(() => resultMessages[new URLSearchParams(location.search).get('notion') || ''] || '');
  const version = useRef(0); const acting = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++version.current;
    try {
      const value = await api<SyncStatus>('/integrations/sync', { signal });
      if (current === version.current) { setStatus(value); setError(''); }
    } catch (e) { if ((e as Error).name !== 'AbortError' && current === version.current) setError((e as Error).message); }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); void refresh(controller.signal);
    const timer = setInterval(() => { if (!acting.current) void refresh(controller.signal); }, 10000);
    return () => { controller.abort(); clearInterval(timer); version.current++; };
  }, [refresh]);
  async function act(action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true; version.current++; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); acting.current = false; }
  }
  async function toggle(key: 'cloud_enabled' | 'notion_enabled', value: boolean) {
    await act(async () => {
      setStatus(await api<SyncStatus>('/integrations/sync', { method: 'PATCH', body: JSON.stringify({ [key]: value }) }));
      setNotice(value ? '同步已开启。服务器会继续处理队列，新的本地数据将在客户端下次同步时到达。' : '同步已关闭，已有档案保留。');
    });
  }
  async function loadPages(more = false) {
    await act(async () => {
      const result = await api<Pages>(`/integrations/notion/pages${more && pages.next_cursor ? `?cursor=${encodeURIComponent(pages.next_cursor)}` : ''}`);
      setPages({ ...result, pages: more ? [...pages.pages, ...result.pages.filter(p => !pages.pages.some(old => old.id === p.id))] : result.pages });
    });
  }
  const connection = status?.connection;
  const target = pageId || connection?.page_id || '';
  return <div className="sync-settings" aria-label="同步方式设置">
    <div className="sync-intro"><h2>选择同步方式</h2><p>可以分别开启，也可以同时开启。客户端仅上传一次，由服务器同步到所选位置。</p></div>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button disabled={busy} onClick={() => void refresh()}>重新加载</button></div>}
    {notice && <p className="sync-notice" role="status">{notice}</p>}
    {!status ? <p aria-live="polite">{error ? '暂时无法读取同步设置。' : <><LoaderCircle className="spin" size={16} />正在读取同步设置…</>}</p> : <>
      {!status.cloud_enabled && !status.notion_enabled && <p className="sync-warning">所有同步方式均已关闭，客户端将暂停上传。</p>}
      <section className="sync-card">
        <div className="sync-card-heading"><Cloud size={23} /><div><h3>云端同步</h3><p>在 Dayflow 网页和移动端查看活动、截图与回顾。</p></div>
          <label className="sync-switch"><input type="checkbox" role="switch" aria-label="云端同步" checked={status.cloud_enabled} disabled={busy} onChange={e => void toggle('cloud_enabled', e.target.checked)} /><span>{status.cloud_enabled ? '已开启' : '已关闭'}</span></label></div>
        <p className="sync-caption">关闭后不再新增云端档案，已有数据保留。仅开启 Notion 时，服务器暂存待发送文字，成功后清除中转正文。</p>
        <p className="sync-caption">最近客户端上传：{format(status.last_upload_at)}</p>
      </section>
      <section className="sync-card">
        <div className="sync-card-heading"><FileText size={23} /><div><h3>Notion 同步</h3><p>把活动文字、日报和周报整理到自己的 Notion 页面。</p></div>
          <label className="sync-switch"><input type="checkbox" role="switch" aria-label="Notion 同步" checked={status.notion_enabled} disabled={busy || !status.configured || !connection?.data_source_id} onChange={e => void toggle('notion_enabled', e.target.checked)} /><span>{status.notion_enabled ? '已开启' : '已关闭'}</span></label></div>
        {!status.configured ? <p className="sync-warning">尚未配置 Notion 接入。管理员需要创建公开连接并配置授权凭据与模板，随后即可在这里授权。</p> : <>
          <div className="sync-connection"><ShieldCheck size={18} /><div><strong>{connection ? `已授权 · ${connection.workspace_name}` : '尚未授权 Notion'}</strong><p>{connection ? `授权时间：${format(connection.connected_at)}` : '授权时可使用开发者提供的模板，或选择已有页面。'}</p></div></div>
          <div className="sync-actions"><button className="primary" disabled={busy} onClick={() => void act(async () => {
            const result = await api<{ url: string }>('/integrations/notion/authorize', { method: 'POST' });
            location.assign(result.url);
          })}>{busy ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}{connection ? '重新授权' : '连接 Notion'}</button>
            {status.template_url && <a href={status.template_url} target="_blank" rel="noreferrer">预览开发者模板 <ExternalLink size={14} /></a>}
          </div>
          {!status.template_url && <p className="sync-caption">开发者模板尚未发布。可先授权已有页面，确认后会在其中创建标准同步数据库。</p>}
          {connection && <>
            <div className="sync-target"><h4>同步目标</h4>
              {connection.data_source_id ? <p><a href={`https://www.notion.so/${connection.page_id?.replaceAll('-', '')}`} target="_blank" rel="noreferrer">打开同步页面 <ExternalLink size={14} /></a><span className="sync-caption"> · 目标已就绪</span></p> : <>
                <p className="sync-caption">{connection.page_id ? '已识别授权时复制的模板。确认后将检查或创建同步数据库。' : '选择一个已授权页面，在其中创建「Dayflow 同步记录」数据库。'}</p>
                <label>目标页面<select value={target} onChange={e => setPageId(e.target.value)} disabled={busy}>
                  <option value="">请选择页面</option>
                  {connection.page_id && !pages.pages.some(p => p.id === connection.page_id) && <option value={connection.page_id}>授权时复制的开发者模板</option>}
                  {pages.pages.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select></label>
                <div className="sync-actions"><button disabled={busy} onClick={() => void loadPages()}>刷新授权页面</button>
                  {pages.next_cursor && <button disabled={busy} onClick={() => void loadPages(true)}>加载更多页面</button>}
                  <button className="primary" disabled={busy || !target} onClick={() => void act(async () => {
                    setStatus(await api<SyncStatus>('/integrations/notion/target', { method: 'POST', body: JSON.stringify({ page_id: target }) }));
                    setNotice('目标页面已就绪。开启 Notion 同步后，服务器将开始发送记录。');
                  })}>确认同步页面</button></div>
                {!pages.pages.length && <p className="sync-caption">找不到页面时，请在 Notion 页面中添加此连接，或重新授权选择页面，再刷新列表。</p>}
              </>}
            </div>
            <dl className="sync-metrics"><div><dt>已同步记录</dt><dd>{status.synced}</dd></div><div><dt>等待同步</dt><dd>{status.pending}</dd></div><div><dt>失败待重试</dt><dd>{status.failed}</dd></div><div><dt>最近同步成功</dt><dd>{format(connection.last_success_at)}</dd></div></dl>
            {connection.last_error && <p className="sync-warning" role="status">{connection.last_error}{connection.retry_at && `。下次重试：${format(connection.retry_at)}`}</p>}
            {!status.notion_enabled && status.pending > 0 && <p className="sync-caption">队列已暂停，{status.pending} 条待发送记录保留在服务器，开启后继续。</p>}
            <div className="sync-actions"><button disabled={busy || !status.notion_enabled || !status.pending} onClick={() => void act(async () => {
              setStatus(await api<SyncStatus>('/integrations/notion/retry', { method: 'POST' })); setNotice('已安排服务端重试，状态会自动更新。');
            })}><RefreshCw size={15} />立即重试</button><button disabled={busy} onClick={() => setDisconnect(true)}>断开连接</button></div>
            {disconnect && <div className="sync-disconnect" role="group" aria-label="确认断开 Notion">
              <p>断开将撤销授权并清除服务器上的 Notion 待发送队列。已创建的 Notion 页面和云端档案保留。重新接入后，数据需要从云端档案或客户端重新同步。</p>
              <div className="sync-actions"><button disabled={busy} onClick={() => setDisconnect(false)}>取消</button><button disabled={busy} onClick={() => void act(async () => {
                setStatus(await api<SyncStatus>('/integrations/notion', { method: 'DELETE' })); setDisconnect(false); setPages({ pages: [], next_cursor: null }); setPageId(''); setNotice('已断开 Notion，已有页面保留。');
              })}>确认断开</button></div>
            </div>}
          </>}
        </>}
        <details className="sync-template"><summary>模板内容与同步范围</summary><p>「Dayflow · 活动与回顾」包含使用说明和同步记录数据库，可按类型、日期、设备、分类和时长筛选。活动以本地记录 ID 更新；源端删除会添加标记并保留记录。</p><p>单向同步到 Notion，不回写 Dayflow。记录正文与属性由同步管理，个人笔记请放在数据库之外。截图仅通过云端同步保存，不发送到 Notion。</p></details>
      </section>
    </>}
  </div>;
}
