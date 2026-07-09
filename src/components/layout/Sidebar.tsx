import { useSettingsStore } from '../../stores/settingsStore';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { ConversationList } from '../conversations/ConversationList';
import { useT } from '../../lib/i18n';
import { useAgentStore } from '../../stores/agentStore';

export function Sidebar() {
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const toggleSettings = useSettingsStore((s) => s.toggleSettings);
  const t = useT();

  return (
    <div className="flex flex-col h-full pt-7 pb-3">
      {/* Logo area */}
      <div
        className="flex items-center justify-between mb-4 mt-1 pl-5 pr-3.5 cursor-default">
        <span className="text-[15px] font-bold tracking-tight text-text-primary pointer-events-none">
          Black <span style={{color: 'var(--color-accent)'}}>Box</span>
        </span>
        <button onClick={toggleSidebar}
          className="p-1 rounded-md hover:bg-bg-tertiary text-text-tertiary
            transition-smooth" title={t('sidebar.hide')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M10 4L6 8L10 12" />
          </svg>
        </button>
      </div>

      {/* New Chat — ghost style */}
      <div className="px-3">
      <button onClick={() => {
        const currentTabId = useSessionStore.getState().selectedSessionId;
        if (currentTabId) {
          useChatStore.getState().saveToCache(currentTabId);
          useAgentStore.getState().saveToCache(currentTabId);
        }
        useSessionStore.getState().setSelectedSession(null);
        useSettingsStore.getState().setWorkingDirectory('');
      }}
        {...(import.meta.env.DEV && { 'data-testid': 'new-session-button' })}
        className="w-full py-1.5 px-3 rounded-md text-xs font-medium
          bg-transparent border border-border-subtle text-text-secondary
          hover:border-accent/40 hover:text-accent hover:bg-accent/5
          transition-smooth mb-2
          flex items-center justify-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t('sidebar.newChat')}
      </button>
      </div>

      {/* Conversation History */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 no-scrollbar">
        <ConversationList />
      </div>

      {/* Footer */}
      <div className="pt-2 mt-2 border-t border-border-subtle px-3">
        <button onClick={toggleSettings}
          {...(import.meta.env.DEV && { 'data-testid': 'settings-button' })}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md
            text-sm text-text-muted hover:bg-bg-secondary hover:text-text-primary
            transition-smooth">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {t('settings.title')}
        </button>
      </div>
    </div>
  );
}
