import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Bot, Check, ChevronDown, ChevronLeft, ChevronRight,
  Clock, Copy, ExternalLink, FolderKanban, Layers, List, Maximize2,
  MessageSquare, Newspaper, RotateCcw, Settings, Sparkles, TrendingUp, X,
} from 'lucide-react';
import {
  briefImageURL, DailyBrief, DailyBriefDocketItem, DailyBriefHandoff,
  DailyBriefResponse, LobehubSettings, safeWebURL,
} from './api';
import { buildLobehubLaunch, LobehubSettingsPanel } from './LobehubSettings';
import './daily-brief.css';

const dayTitle = (date: string) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC',
    }).format(new Date(`${date}T12:00:00Z`));
  } catch {
    return date;
  }
};

type DocketStatusInfo = {
  key: 'new' | 'dismissed' | 'in_progress' | 'ready' | 'reviewed' | 'failed';
  label: string;
  agent?: string;
};

function resolveDocketStatus(item: DailyBriefDocketItem, handoffs: DailyBriefHandoff[] = []): DocketStatusInfo {
  const entry = [...handoffs].reverse().find(h => h.title === item.title);
  if (!entry) return { key: 'new', label: 'New' };
  if (entry.dismissed) return { key: 'dismissed', label: 'Dismissed' };
  const agent = entry.agent || undefined;
  if (entry.reviewed) return { key: 'reviewed', label: 'Reviewed', agent };
  if (entry.failed) return { key: 'failed', label: "Didn't finish", agent };
  if (entry.method === 'run' && entry.finishedAt) return { key: 'ready', label: 'Ready for review', agent };
  return { key: 'in_progress', label: 'In progress', agent };
}

function getPrompt(brief: DailyBrief, item: DailyBriefDocketItem) {
  return brief.user_state?.promptEdits?.[item.title] ?? item.prompt ?? '';
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function hasImageFile(brief: DailyBrief, file?: string) {
  if (!file) return false;
  const clean = file.replace(/^images\//, '');
  return brief.images.includes(clean);
}

export function DailyBriefView({
  data,
  loading,
  lobehub,
  onLobehubSaved,
  onSelectDate,
  zone,
}: {
  data: DailyBriefResponse | null;
  loading: boolean;
  lobehub: LobehubSettings;
  onLobehubSaved: (next: LobehubSettings) => void;
  onSelectDate: (date: string) => void;
  zone: string;
}) {
  const [docketMode, setDocketMode] = useState<'list' | 'card'>('list');
  const [expandedTitle, setExpandedTitle] = useState<string | null>(null);
  const [cardIndex, setCardIndex] = useState(0);
  const [selectedAssistantId, setSelectedAssistantId] = useState(lobehub.default_assistant_id || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [zoomImage, setZoomImage] = useState<{ src: string; title: string } | null>(null);

  useEffect(() => {
    if (!selectedAssistantId || !lobehub.assistants.some(a => a.id === selectedAssistantId)) {
      setSelectedAssistantId(lobehub.default_assistant_id || lobehub.assistants[0]?.id || '');
    }
  }, [lobehub, selectedAssistantId]);

  useEffect(() => {
    setExpandedTitle(null);
    setCardIndex(0);
  }, [data?.brief?.day]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const brief = data?.brief || null;
  const docket = brief?.content?.docket || [];

  const extraSections = useMemo(() => {
    if (!brief) return [];
    const content = brief.content || {};
    const valid = new Set(['related_reading', 'industry_news', 'completed_yesterday', 'team_decisions', 'keep_tracking']);
    const hasItems = (kind: string) => {
      const list = (content as Record<string, unknown>)[kind];
      return Array.isArray(list) && list.length > 0;
    };
    const ordered: string[] = [];
    for (const kind of content.order || []) {
      if (valid.has(kind) && hasItems(kind) && !ordered.includes(kind)) ordered.push(kind);
    }
    for (const kind of valid) {
      if (hasItems(kind) && !ordered.includes(kind)) ordered.push(kind);
    }
    return ordered;
  }, [brief]);

  if (loading && !data) {
    return (
      <div className="brief-empty">
        <Sparkles size={26} />
        <p>正在读取每日简报…</p>
      </div>
    );
  }

  if (!brief) {
    const recentDays = data?.available_days?.slice(0, 5) || [];
    return (
      <div className="brief-empty">
        <Sparkles size={30} strokeWidth={1.5} />
        <h2>当天暂无每日简报</h2>
        <p>每日简报由 Mac 上的原版 Dayflow 在逻辑日（凌晨 4 点后）生成并自动同步至云端只读归档。</p>
        {recentDays.length > 0 && (
          <div className="brief-recent-jumps">
            <span>查看已有简报：</span>
            {recentDays.map(day => (
              <button key={day} onClick={() => onSelectDate(day)}>{day}</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const activeCard = docket[Math.min(cardIndex, Math.max(0, docket.length - 1))];
  const currentAssistant = lobehub.assistants.find(a => a.id === selectedAssistantId) || lobehub.assistants[0];

  const handleCopyPrompt = async (prompt: string) => {
    if (!prompt) return;
    const ok = await copyText(prompt);
    setToast(ok ? '已复制完整 Agent Prompt' : '无法自动写入剪贴板，请手动复制');
  };

  const handleHandoffClick = async (
    event: React.MouseEvent<HTMLAnchorElement>,
    prompt: string,
    launch: NonNullable<ReturnType<typeof buildLobehubLaunch>>,
  ) => {
    if (launch.mode === 'copy_open') {
      event.preventDefault();
      await copyText(prompt);
      setToast(
        launch.truncatedToCopy
          ? `Prompt 过长，已复制到剪贴板，正在打开 ${launch.assistantName}`
          : `已复制 Prompt，正在打开 ${launch.assistantName}`,
      );
      window.open(launch.url, '_blank', 'noopener,noreferrer');
    }
  };

  const formatTime = (value?: string) => {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: zone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date(value));
    } catch {
      return value;
    }
  };

  return (
    <div className="brief-shell">
      {toast && (
        <div className="brief-toast" role="status">
          <Check size={15} />
          <span>{toast}</span>
        </div>
      )}

      {data && data.available_days.length > 1 && (
        <div className="brief-date-strip" aria-label="已有简报日期">
          <span>已归档简报</span>
          <div>
            {data.available_days.slice(0, 7).map(day => (
              <button
                key={day}
                className={day === brief.day ? 'active' : ''}
                onClick={() => onSelectDate(day)}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="brief-canvas">
        <header className="brief-hero">
          <div className="brief-hero-date">{dayTitle(brief.day)}</div>
          {docket.length > 0 && (
            <>
              <h2>Take these off your plate</h2>
              <p>Let your agents complete these tasks for you.</p>
            </>
          )}
        </header>

        {docket.length > 0 && (
          <section className="brief-docket-section" aria-label="Take these off your plate">
            {docketMode === 'list' ? (
              <div className="docket-table-card">
                <div className="docket-table-head">
                  <span>TITLE</span>
                  <span>AGENT PROMPT</span>
                  <span>STATUS</span>
                  <span className="docket-head-actions">ACTION</span>
                </div>
                <div className="docket-rows">
                  {docket.map(item => {
                    const expanded = expandedTitle === item.title;
                    const prompt = getPrompt(brief, item);
                    const status = resolveDocketStatus(item, brief.user_state?.handoffs);
                    const handoffEntry = [...(brief.user_state?.handoffs || [])].reverse().find(h => h.title === item.title);
                    const launch = buildLobehubLaunch(lobehub, prompt, selectedAssistantId);
                    return (
                      <div key={item.title} className={`docket-row-wrap ${expanded ? 'expanded' : ''}`}>
                        <div className="docket-row">
                          <button
                            type="button"
                            className="docket-title-btn"
                            onClick={() => setExpandedTitle(expanded ? null : item.title)}
                            aria-expanded={expanded}
                          >
                            <ChevronDown size={15} className={`docket-chevron ${expanded ? 'open' : ''}`} />
                            <span>{item.title}</span>
                          </button>

                          <button
                            type="button"
                            className="docket-prompt-preview"
                            onClick={() => setExpandedTitle(expanded ? null : item.title)}
                            title="点击展开完整 Prompt"
                          >
                            {prompt || '暂无 Agent Prompt'}
                          </button>

                          <div className="docket-status-cell">
                            <DocketStatusBadge status={status} />
                          </div>

                          <div className="docket-action-cell">
                            <button
                              type="button"
                              className="docket-mini-btn"
                              onClick={() => void handleCopyPrompt(prompt)}
                              disabled={!prompt}
                              title="复制完整 Prompt"
                            >
                              <Copy size={13} />
                              <span>复制</span>
                            </button>
                            {launch && (
                              <a
                                className="docket-lobehub-btn"
                                href={launch.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={event => void handleHandoffClick(event, prompt, launch)}
                                title={`发送给 LobeHub 助理：${launch.assistantName}`}
                              >
                                <Bot size={13} />
                                <span>LobeHub</span>
                              </a>
                            )}
                          </div>
                        </div>

                        {expanded && (
                          <div className="docket-expanded">
                            {item.detail && (
                              <div className="docket-detail-block">
                                <strong>任务背景</strong>
                                <p>{item.detail}</p>
                              </div>
                            )}

                            <div className="docket-meta-badges">
                              {item.due && <span>截止：{item.due}</span>}
                              {item.agent === true && <span>适合 Agent 独立完成</span>}
                              {item.agent === false && <span>需本人确认或参与</span>}
                              {item.people?.map(person => (
                                <span key={person.name}>{person.name}{person.note ? ` · ${person.note}` : ''}</span>
                              ))}
                            </div>

                            {prompt && (
                              <div className="docket-prompt-full">
                                <div className="docket-prompt-full-head">
                                  <strong>完整 Agent Prompt</strong>
                                  <button type="button" onClick={() => void handleCopyPrompt(prompt)}>
                                    <Copy size={12} /> 复制
                                  </button>
                                </div>
                                <pre>{prompt}</pre>
                              </div>
                            )}

                            {item.links && item.links.length > 0 && (
                              <div className="docket-links">
                                <strong>参考资料</strong>
                                <div>
                                  {item.links.map((link, idx) => {
                                    const href = safeWebURL(link.url);
                                    return href ? (
                                      <a key={idx} href={href} target="_blank" rel="noopener noreferrer">
                                        {link.app ? `[${link.app}] ` : ''}{link.title}
                                        <ExternalLink size={12} />
                                      </a>
                                    ) : (
                                      <span key={idx}>{link.app ? `[${link.app}] ` : ''}{link.title}</span>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {(item.feedbackSummary || (item.feedback && item.feedback.length > 0)) && (
                              <div className="docket-feedback">
                                <strong>相关讨论与反馈</strong>
                                {item.feedbackSummary ? (
                                  <p>
                                    {item.feedbackSummary}
                                    {safeWebURL(item.feedbackUrl) && (
                                      <a href={safeWebURL(item.feedbackUrl)} target="_blank" rel="noopener noreferrer">
                                        查看原消息 <ExternalLink size={11} />
                                      </a>
                                    )}
                                  </p>
                                ) : (
                                  <ul>
                                    {item.feedback!.map((note, idx) => (
                                      <li key={idx}>
                                        <strong>{note.name}</strong>
                                        {note.source && <small>（{note.source}）</small>}：{note.text}
                                        {safeWebURL(note.url) && (
                                          <a href={safeWebURL(note.url)} target="_blank" rel="noopener noreferrer">
                                            <ExternalLink size={11} />
                                          </a>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}

                            {handoffEntry && !handoffEntry.dismissed && (
                              <div className="docket-handoff-note">
                                本机记录：已通过 {handoffEntry.agent || 'Agent'}（{handoffEntry.method || 'handoff'}）派发
                                {handoffEntry.finishedAt ? ` · 结束于 ${formatTime(handoffEntry.finishedAt)}` : ''}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              activeCard && (
                <div className="docket-deck-card">
                  <div className="docket-deck-top">
                    <span className="docket-deck-counter">任务 {cardIndex + 1} / {docket.length}</span>
                    <DocketStatusBadge status={resolveDocketStatus(activeCard, brief.user_state?.handoffs)} />
                  </div>
                  <h3>{activeCard.title}</h3>
                  {activeCard.detail && <p className="docket-deck-detail">{activeCard.detail}</p>}
                  {getPrompt(brief, activeCard) && (
                    <div className="docket-prompt-full">
                      <div className="docket-prompt-full-head">
                        <strong>Agent Prompt</strong>
                      </div>
                      <pre>{getPrompt(brief, activeCard)}</pre>
                    </div>
                  )}
                  <div className="docket-deck-actions">
                    <div className="docket-deck-nav">
                      <button
                        type="button"
                        aria-label="上一张任务卡"
                        disabled={cardIndex <= 0}
                        onClick={() => setCardIndex(i => Math.max(0, i - 1))}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <button
                        type="button"
                        aria-label="下一张任务卡"
                        disabled={cardIndex >= docket.length - 1}
                        onClick={() => setCardIndex(i => Math.min(docket.length - 1, i + 1))}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                    <div className="docket-deck-send">
                      <button
                        type="button"
                        onClick={() => void handleCopyPrompt(getPrompt(brief, activeCard))}
                        disabled={!getPrompt(brief, activeCard)}
                      >
                        <Copy size={14} /> 复制 Prompt
                      </button>
                      {(() => {
                        const prompt = getPrompt(brief, activeCard);
                        const launch = buildLobehubLaunch(lobehub, prompt, selectedAssistantId);
                        return launch ? (
                          <a
                            className="docket-lobehub-btn large"
                            href={launch.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={event => void handleHandoffClick(event, prompt, launch)}
                          >
                            <Bot size={15} />
                            <span>发送给 {launch.assistantName}</span>
                          </a>
                        ) : null;
                      })()}
                    </div>
                  </div>
                </div>
              )
            )}

            <div className="docket-controls-bar">
              <div className="docket-mode-toggle" role="group" aria-label="视图切换">
                <button
                  type="button"
                  className={docketMode === 'card' ? 'active' : ''}
                  onClick={() => setDocketMode('card')}
                >
                  <Layers size={13} /> Card
                </button>
                <button
                  type="button"
                  className={docketMode === 'list' ? 'active' : ''}
                  onClick={() => setDocketMode('list')}
                >
                  <List size={13} /> List
                </button>
              </div>

              <button
                type="button"
                className="docket-gear-btn"
                aria-label="设置 LobeHub 助理"
                title="配置 LobeHub 地址与特定助理"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={15} />
              </button>

              {lobehub.assistants.length > 0 && (
                <label className="docket-assistant-picker">
                  <Bot size={14} />
                  <span>目标助理</span>
                  <select
                    aria-label="选择 LobeHub 目标助理"
                    value={currentAssistant?.id || ''}
                    onChange={e => setSelectedAssistantId(e.target.value)}
                  >
                    {lobehub.assistants.map(item => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </section>
        )}

        <div className="brief-sections">
          {extraSections.map(kind => {
            if (kind === 'related_reading') {
              const items = brief.content.related_reading || [];
              return (
                <section key={kind} className="brief-section brief-reading-section">
                  <div className="brief-section-split">
                    <div className="brief-section-label">
                      <h3>Related to your interests</h3>
                      {brief.content.related_reading_intro && <p>{brief.content.related_reading_intro}</p>}
                    </div>
                    <div className="brief-reading-grid">
                      {items.map((item, idx) => {
                        const href = safeWebURL(item.url);
                        const showPhoto = hasImageFile(brief, item.imageFile) && !item.imageIsTitleCard;
                        const CardTag = href ? 'a' : 'div';
                        return (
                          <CardTag
                            key={`${item.url}-${idx}`}
                            className="brief-reading-card"
                            {...(href ? { href, target: '_blank', rel: 'noopener noreferrer' } : {})}
                          >
                            <div className={`brief-reading-visual palette-${idx % 4}`}>
                              {showPhoto ? (
                                <img
                                  src={briefImageURL(brief.device_id, brief.day, item.imageFile!)}
                                  alt={item.title}
                                  loading="lazy"
                                />
                              ) : (
                                <div className="brief-title-card-text">
                                  {item.hook || item.title}
                                </div>
                              )}
                            </div>
                            <div className="brief-reading-body">
                              <h4>{item.title}</h4>
                              {item.reason && <p>{item.reason}</p>}
                              <div className="brief-reading-meta">
                                <span>{[item.source, item.minutes ? `${item.minutes} min` : ''].filter(Boolean).join(' · ')}</span>
                                {href && <ExternalLink size={12} />}
                              </div>
                            </div>
                          </CardTag>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            }

            if (kind === 'industry_news') {
              const items = brief.content.industry_news || [];
              return (
                <section key={kind} className="brief-section">
                  <div className="brief-section-split">
                    <div className="brief-section-label">
                      <h3><Newspaper size={16} /> Latest in your industry</h3>
                    </div>
                    <div className="brief-reading-grid">
                      {items.map((item, idx) => {
                        const href = safeWebURL(item.url);
                        const showPhoto = hasImageFile(brief, item.imageFile) && !item.imageIsTitleCard;
                        const CardTag = href ? 'a' : 'div';
                        return (
                          <CardTag
                            key={`${item.url}-${idx}`}
                            className="brief-reading-card"
                            {...(href ? { href, target: '_blank', rel: 'noopener noreferrer' } : {})}
                          >
                            <div className={`brief-reading-visual palette-${(idx + 2) % 4}`}>
                              {showPhoto ? (
                                <img
                                  src={briefImageURL(brief.device_id, brief.day, item.imageFile!)}
                                  alt={item.headline}
                                  loading="lazy"
                                />
                              ) : (
                                <div className="brief-title-card-text">{item.headline}</div>
                              )}
                            </div>
                            <div className="brief-reading-body">
                              <h4>{item.headline}</h4>
                              <div className="brief-reading-meta">
                                <span>{[item.source, item.published].filter(Boolean).join(' · ')}</span>
                                {href && <ExternalLink size={12} />}
                              </div>
                            </div>
                          </CardTag>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            }

            if (kind === 'completed_yesterday') {
              const items = brief.content.completed_yesterday || [];
              return (
                <section key={kind} className="brief-section">
                  <div className="brief-section-split">
                    <div className="brief-section-label">
                      <h3><FolderKanban size={16} /> What you completed yesterday</h3>
                    </div>
                    <div className="brief-completed-grid">
                      {items.map((item, idx) => {
                        const hasImg = hasImageFile(brief, item.imageFile);
                        const imgSrc = hasImg ? briefImageURL(brief.device_id, brief.day, item.imageFile!) : '';
                        return (
                          <div key={`${item.title}-${idx}`} className="brief-completed-card">
                            {hasImg && (
                              <button
                                type="button"
                                className="brief-completed-thumb-btn"
                                onClick={() => setZoomImage({ src: imgSrc, title: item.title })}
                                aria-label={`放大 ${item.title} 的截图`}
                              >
                                <img src={imgSrc} alt={item.title} loading="lazy" />
                                <span><Maximize2 size={14} /></span>
                              </button>
                            )}
                            <div className="brief-completed-body">
                              {item.project && <span className="brief-pill">{item.project}</span>}
                              <h4>{item.title}</h4>
                              {item.apps && item.apps.length > 0 && (
                                <div className="brief-app-tags">
                                  {item.apps.map(app => <span key={app}>{app}</span>)}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            }

            if (kind === 'team_decisions') {
              const items = brief.content.team_decisions || [];
              return (
                <section key={kind} className="brief-section">
                  <div className="brief-section-split">
                    <div className="brief-section-label">
                      <h3><MessageSquare size={16} /> Key team decisions</h3>
                    </div>
                    <div className="brief-flat-list">
                      {items.map((item, idx) => {
                        const href = safeWebURL(item.url);
                        return (
                          <div key={idx} className="brief-flat-item">
                            <p>{item.decision}</p>
                            <div className="brief-flat-meta">
                              {item.people && item.people.length > 0 && <span>{item.people.join('、')}</span>}
                              {item.place && <span>{item.place}</span>}
                              {item.date && <span>{item.date}</span>}
                              {href && (
                                <a href={href} target="_blank" rel="noopener noreferrer">
                                  原文 <ExternalLink size={11} />
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            }

            if (kind === 'keep_tracking') {
              const items = brief.content.keep_tracking || [];
              return (
                <section key={kind} className="brief-section">
                  <div className="brief-section-split">
                    <div className="brief-section-label">
                      <h3><TrendingUp size={16} /> Keep tracking</h3>
                    </div>
                    <div className="brief-flat-list">
                      {items.map((item, idx) => {
                        const href = safeWebURL(item.url);
                        return (
                          <div key={idx} className="brief-flat-item">
                            <div className="brief-tracking-head">
                              <strong>{item.label}</strong>
                              {item.asOf && <small>{item.asOf}</small>}
                            </div>
                            <p>{item.status}</p>
                            {href && (
                              <div className="brief-flat-meta">
                                <a href={href} target="_blank" rel="noopener noreferrer">
                                  查看来源{item.app ? ` (${item.app})` : ''} <ExternalLink size={11} />
                                </a>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              );
            }
            return null;
          })}
        </div>

        <footer className="brief-footer">
          <span>基于 {brief.source_day} 活动生成 · 同步时间 {formatTime(brief.generated_at)}</span>
          {brief.stats?.model && <span> · {brief.stats.model}</span>}
          <span> · 只读归档（跳转 LobeHub：{lobehub.base_url}）</span>
        </footer>
      </div>

      {settingsOpen && (
        <LobehubModal
          settings={lobehub}
          onClose={() => setSettingsOpen(false)}
          onSaved={next => { onLobehubSaved(next); setSettingsOpen(false); setToast('LobeHub 助理设置已更新'); }}
        />
      )}

      {zoomImage && (
        <BriefImageDialog src={zoomImage.src} title={zoomImage.title} onClose={() => setZoomImage(null)} />
      )}
    </div>
  );
}

function DocketStatusBadge({ status }: { status: DocketStatusInfo }) {
  const icon = status.key === 'dismissed'
    ? <RotateCcw size={11} />
    : status.key === 'failed'
      ? <AlertCircle size={11} />
      : status.key === 'reviewed' || status.key === 'ready'
        ? <Check size={11} />
        : status.key === 'in_progress'
          ? <Clock size={11} />
          : <Layers size={11} />;
  return (
    <span className={`docket-status-tag status-${status.key}`}>
      {icon}
      <span>{status.label}</span>
      {status.agent && <small>· {status.agent}</small>}
    </span>
  );
}

function LobehubModal({
  settings,
  onClose,
  onSaved,
}: {
  settings: LobehubSettings;
  onClose: () => void;
  onSaved: (next: LobehubSettings) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="brief-modal"
      onCancel={onClose}
      onClick={event => { if (event.target === dialogRef.current) onClose(); }}
    >
      <div className="brief-modal-inner">
        <div className="brief-modal-head">
          <div>
            <h3>LobeHub 跳转与特定助理</h3>
            <p>选择目标 LobeHub 地址、默认助理和发送方式。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭设置" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <LobehubSettingsPanel settings={settings} onSaved={onSaved} compact />
      </div>
    </dialog>
  );
}

function BriefImageDialog({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="image-dialog"
      onCancel={onClose}
      onClick={event => { if (event.target === dialogRef.current) onClose(); }}
    >
      <div>
        <button type="button" className="icon-button" aria-label="关闭大图" onClick={onClose}>
          <X size={22} />
        </button>
        <img src={src} alt={title} />
        <p>{title}</p>
      </div>
    </dialog>
  );
}
