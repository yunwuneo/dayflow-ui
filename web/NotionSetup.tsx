import { useState } from 'react';
import { ExternalLink, Copy, LoaderCircle } from 'lucide-react';

export interface NotionSetupInfo {
  source: 'none' | 'web' | 'environment'; client_id: string; template_url: string;
  redirect_uri: string; editable: boolean; available: boolean; error: string | null;
}
export interface NotionSetupValues { client_id: string; client_secret?: string; template_url: string }

export function NotionSetup({ setup, busy, connected, onSave }: {
  setup: NotionSetupInfo; busy: boolean; connected: boolean;
  onSave: (values: NotionSetupValues, authorize: boolean) => Promise<void>;
}) {
  const [clientId, setClientId] = useState(setup.client_id);
  const [secret, setSecret] = useState('');
  const [template, setTemplate] = useState(setup.template_url);
  const [copied, setCopied] = useState('');
  const disabled = busy || !setup.editable || !setup.available || connected;
  return <div className="notion-setup">
    <h4>配置 Notion 连接</h4>
    <p>首次接入需要创建一个 Notion 公开连接。完成下列步骤后，就可以在这里直接授权。</p>
    <ol>
      <li><a href="https://www.notion.so/profile/integrations" target="_blank" rel="noreferrer">打开 Notion 开发者控制台 <ExternalLink size={14} /></a>，创建 Public connection（公开连接），选择允许接入的工作区。</li>
      <li>勾选读取、插入和更新内容权限，将下方地址添加到 OAuth Redirect URI。</li>
      <li>在连接的 Configuration 页面复制 OAuth Client ID 和 OAuth Client Secret，填入下面的表单。</li>
    </ol>
    <label>OAuth 回调地址<input value={setup.redirect_uri} readOnly onFocus={e => e.target.select()} /></label>
    <div className="sync-actions"><button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(setup.redirect_uri); setCopied('回调地址已复制'); }
      catch { setCopied('请点击地址框，全选并复制回调地址'); }
    }}><Copy size={14} />复制回调地址</button><span role="status">{copied}</span></div>
    {!setup.available && <p className="sync-warning">{setup.error}</p>}
    {!setup.editable && <p className="sync-caption">当前连接由服务器环境变量管理，可直接点击「连接 Notion」授权。</p>}
    {connected && setup.editable && <p className="sync-caption">当前连接已授权。如需更换连接信息，请先断开授权；普通同步无需重新配置。</p>}
    {setup.editable && <form onSubmit={async e => {
      e.preventDefault();
      const authorize = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'authorize';
      await onSave({ client_id: clientId.trim(), client_secret: secret.trim() || undefined, template_url: template.trim() }, authorize);
      setSecret('');
    }}>
      <fieldset disabled={disabled}>
        <label>OAuth Client ID<input value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" required maxLength={200} placeholder="从 Notion 连接配置中复制" /></label>
        <label>OAuth Client Secret<input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="new-password"
          required={setup.source === 'none' || clientId.trim() !== setup.client_id} maxLength={2000} placeholder={setup.source === 'web' ? '已保存，留空保持现有密钥' : '仅发送到服务器加密保存'} /></label>
        <label>开发者模板 URL（可选）<input type="url" value={template} onChange={e => setTemplate(e.target.value)} maxLength={2000} placeholder="https://…notion.site/…" /></label>
        <p className="sync-caption">没有公开模板也可以授权已有页面，确认后会创建标准同步数据库。若希望授权页出现「使用开发者提供的模板」，还需在 Notion 控制台的 Notion URL for optional template 中填入同一公开模板地址。</p>
        <div className="sync-actions"><button type="submit" value="authorize" className="primary">{busy ? <LoaderCircle size={15} className="spin" /> : <ExternalLink size={15} />}保存并前往授权</button><button type="submit" value="save">仅保存配置</button></div>
      </fieldset>
    </form>}
    <p className="sync-caption">授权将在 Notion 官网完成。Dayflow 不需要你的 Notion 登录密码。</p>
  </div>;
}
