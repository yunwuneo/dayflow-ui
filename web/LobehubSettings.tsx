import { useState } from 'react';
import { Bot, Check, ExternalLink, LoaderCircle, Plus, Star, Trash2 } from 'lucide-react';
import { api, LobehubAssistant, LobehubSettings, safeWebURL } from './api';

export const DEFAULT_LOBEHUB_SETTINGS: LobehubSettings = {
  base_url: 'https://chat.neo7.cn',
  default_assistant_id: '',
  handoff_mode: 'auto_send',
  assistants: [],
};

export function normalizeLobehubSettings(raw: unknown): LobehubSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_LOBEHUB_SETTINGS;
  const obj = raw as Partial<LobehubSettings>;
  const assistants = Array.isArray(obj.assistants) ? obj.assistants : [];
  const defaultId = typeof obj.default_assistant_id === 'string' ? obj.default_assistant_id : '';
  return {
    base_url: typeof obj.base_url === 'string' && obj.base_url ? obj.base_url : DEFAULT_LOBEHUB_SETTINGS.base_url,
    default_assistant_id: defaultId,
    handoff_mode: obj.handoff_mode === 'copy_open' ? 'copy_open' : 'auto_send',
    assistants,
  };
}

export function buildLobehubLaunch(
  settings: LobehubSettings,
  prompt: string,
  assistantId?: string,
): { url: string; mode: 'auto_send' | 'copy_open'; truncatedToCopy: boolean; assistantName: string } | null {
  const safeBase = safeWebURL(settings.base_url);
  if (!safeBase) return null;
  const base = safeBase.replace(/\/+$/, '');
  const chosenId = assistantId || settings.default_assistant_id;
  const assistant = settings.assistants.find(item => item.id === chosenId) || settings.assistants[0];
  const path = assistant?.agent_id ? `/agent/${encodeURIComponent(assistant.agent_id)}` : '/agent';
  const targetBase = `${base}${path}`;
  const assistantName = assistant?.name || '默认助理';
  const trimmed = prompt.trim();
  if (settings.handoff_mode === 'auto_send' && trimmed) {
    const withMessage = `${targetBase}?message=${encodeURIComponent(trimmed)}`;
    if (withMessage.length <= 6000) {
      return { url: withMessage, mode: 'auto_send', truncatedToCopy: false, assistantName };
    }
    return { url: targetBase, mode: 'copy_open', truncatedToCopy: true, assistantName };
  }
  return { url: targetBase, mode: 'copy_open', truncatedToCopy: false, assistantName };
}

export function LobehubSettingsPanel({
  settings,
  onSaved,
  compact = false,
}: {
  settings: LobehubSettings;
  onSaved: (next: LobehubSettings) => void;
  compact?: boolean;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.base_url || 'https://chat.neo7.cn');
  const [handoffMode, setHandoffMode] = useState<'auto_send' | 'copy_open'>(settings.handoff_mode || 'auto_send');
  const [assistants, setAssistants] = useState<LobehubAssistant[]>(settings.assistants || []);
  const [defaultId, setDefaultId] = useState(settings.default_assistant_id || '');
  const [newName, setNewName] = useState('');
  const [newAgentId, setNewAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');

  function addAssistant() {
    const name = newName.trim();
    const agentId = newAgentId.trim();
    setError('');
    setSavedNotice('');
    if (!name || !agentId) {
      setError('请填写助理名称和 LobeHub 助理 ID / Slug');
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(agentId)) {
      setError('助理 ID / Slug 仅支持字母、数字、点、下划线和连字符');
      return;
    }
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `asst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nextList = [...assistants, { id, name, agent_id: agentId }];
    setAssistants(nextList);
    if (!defaultId) setDefaultId(id);
    setNewName('');
    setNewAgentId('');
  }

  function removeAssistant(id: string) {
    const nextList = assistants.filter(item => item.id !== id);
    setAssistants(nextList);
    if (defaultId === id) setDefaultId(nextList[0]?.id || '');
    setSavedNotice('');
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSavedNotice('');
    try {
      const saved = await api<LobehubSettings>('/integrations/lobehub', {
        method: 'PUT',
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          default_assistant_id: defaultId && assistants.some(a => a.id === defaultId) ? defaultId : (assistants[0]?.id || ''),
          handoff_mode: handoffMode,
          assistants,
        }),
      });
      setBaseUrl(saved.base_url);
      setHandoffMode(saved.handoff_mode);
      setAssistants(saved.assistants);
      setDefaultId(saved.default_assistant_id);
      setSavedNotice('LobeHub 助理设置已保存');
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`lobehub-form ${compact ? 'compact' : ''}`} onSubmit={save}>
      {!compact && (
        <div className="sync-card-heading">
          <Bot size={23} />
          <div>
            <h3>LobeHub 助理跳转</h3>
            <p>配置每日简报中「Take these off your plate」任务跳转的 LobeHub 地址与特定助理。</p>
          </div>
        </div>
      )}

      <div className="lobehub-fields">
        <label>
          <span>LobeHub 地址</span>
          <input
            type="url"
            required
            placeholder="https://chat.neo7.cn"
            value={baseUrl}
            onChange={e => { setBaseUrl(e.target.value); setSavedNotice(''); }}
          />
        </label>

        <fieldset className="lobehub-mode">
          <legend>跳转方式</legend>
          <label className="lobehub-radio">
            <input
              type="radio"
              name={`handoff-mode-${compact ? 'modal' : 'page'}`}
              checked={handoffMode === 'auto_send'}
              onChange={() => { setHandoffMode('auto_send'); setSavedNotice(''); }}
            />
            <span>携带任务指令打开助理并自动发送（<code>?message=</code>）</span>
          </label>
          <label className="lobehub-radio">
            <input
              type="radio"
              name={`handoff-mode-${compact ? 'modal' : 'page'}`}
              checked={handoffMode === 'copy_open'}
              onChange={() => { setHandoffMode('copy_open'); setSavedNotice(''); }}
            />
            <span>复制 Prompt 到剪贴板并打开助理页（手动粘贴微调后发送）</span>
          </label>
        </fieldset>
      </div>

      <div className="lobehub-assistants">
        <div className="lobehub-assistants-head">
          <strong>特定助理列表</strong>
          <span>从 LobeHub 网址 <code>/agent/&lt;ID或Slug&gt;</code> 中复制标识；未配置时打开默认 <code>/agent</code></span>
        </div>

        {assistants.length > 0 && (
          <ul className="lobehub-assistant-list">
            {assistants.map(item => {
              const isDefault = defaultId === item.id;
              return (
                <li key={item.id} className={isDefault ? 'default' : ''}>
                  <div className="assistant-meta">
                    <strong>{item.name}</strong>
                    <code>{item.agent_id}</code>
                  </div>
                  <div className="assistant-actions">
                    <button
                      type="button"
                      className={`assistant-default-btn ${isDefault ? 'active' : ''}`}
                      onClick={() => { setDefaultId(item.id); setSavedNotice(''); }}
                      aria-label={`设 ${item.name} 为默认助理`}
                    >
                      <Star size={13} />
                      {isDefault ? '默认' : '设为默认'}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`删除 ${item.name}`}
                      onClick={() => removeAssistant(item.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="lobehub-add-row">
          <input
            aria-label="助理显示名称"
            placeholder="名称，如：运维助理"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <input
            aria-label="助理 ID 或 Slug"
            placeholder="LobeHub 助理 ID / Slug，如 agt_xxx 或 inbox"
            value={newAgentId}
            onChange={e => setNewAgentId(e.target.value)}
          />
          <button type="button" onClick={addAssistant}>
            <Plus size={15} />
            添加
          </button>
        </div>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {savedNotice && (
        <p className="lobehub-saved" role="status">
          <Check size={14} />
          {savedNotice}
        </p>
      )}

      <div className="lobehub-submit">
        {safeWebURL(baseUrl) && (
          <a className="lobehub-preview-link" href={safeWebURL(baseUrl)} target="_blank" rel="noopener noreferrer">
            打开 LobeHub <ExternalLink size={13} />
          </a>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
          保存配置
        </button>
      </div>
    </form>
  );
}
