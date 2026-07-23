import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { goalElapsedMs, useGoalStore, type GoalRecord } from '../../stores/goalStore';
import { resumeGoalExecution } from '../../lib/goal-continuation';
import { formatElapsedCompact } from '../../lib/elapsed-time';
import { useT } from '../../lib/i18n';
import { announceHeaderPopover, subscribeHeaderPopover } from '../../lib/header-popover';

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function statusLabel(goal: GoalRecord, t: (key: string) => string): string {
  if (goal.status === 'active' && goal.waitReason) return t(`goal.wait.${goal.waitReason}`);
  return t(`goal.status.${goal.status}`);
}

export function GoalControl({
  compact = false,
  active = false,
  disabled = false,
  onSelect,
}: {
  compact?: boolean;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const tabId = useSessionStore((state) => state.selectedSessionId);
  const goal = useGoalStore((state) => tabId ? state.goals[tabId] : undefined);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => subscribeHeaderPopover('goal', () => setOpen(false)), []);

  const elapsed = goal ? formatElapsedCompact(goalElapsedMs(goal, now)) : '';
  const tokenText = goal?.tokenBudget
    ? `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`
    : goal ? formatTokenCount(goal.tokensUsed) : '';
  const selectMode = () => {
    setOpen(false);
    announceHeaderPopover('goal');
    onSelect();
  };

  return (
    <div ref={ref} className="relative mr-1 flex items-center">
      <button
        type="button"
        data-testid="goal-button"
        data-active={active ? 'true' : 'false'}
        onClick={selectMode}
        disabled={disabled || Boolean(goal)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px]
          transition-smooth disabled:cursor-not-allowed disabled:opacity-40 ${active
            ? 'border-accent/40 bg-accent/15 text-accent'
            : goal
            ? 'border-accent/25 bg-accent/10 text-accent'
            : 'border-border-subtle text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
          }`}
        title={t('goal.title')}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${goal?.status === 'active' ? 'bg-accent animate-pulse-soft' : 'bg-text-tertiary/40'}`} />
        <span className={compact ? 'hidden' : 'max-[1040px]:hidden'}>Goal</span>
        <span className={compact ? 'inline' : 'hidden max-[1040px]:inline'} aria-hidden="true">G</span>
        {goal && <span className="text-text-tertiary max-[1040px]:hidden">{elapsed}</span>}
      </button>

      <button
        type="button"
        data-testid="goal-manage"
        onClick={() => setOpen((value) => {
          const next = !value;
          if (next) announceHeaderPopover('goal');
          return next;
        })}
        aria-label={goal ? t('goal.current') : t('goal.title')}
        className="ml-0.5 rounded-md p-1 text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[400px]
          rounded-xl border border-border-subtle bg-bg-card shadow-xl p-3"
          data-testid="goal-popover">
          {goal ? (
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] uppercase tracking-wider text-text-tertiary">{t('goal.current')}</span>
                  <span className="text-[10px] text-accent">{statusLabel(goal, t)}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-text-primary whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {goal.objective}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div className="rounded-md bg-bg-secondary px-2 py-1.5"><span className="text-text-tertiary">{t('goal.time')}</span><div className="text-text-primary mt-0.5">{elapsed}</div></div>
                <div className="rounded-md bg-bg-secondary px-2 py-1.5"><span className="text-text-tertiary">{t('goal.tokens')}</span><div className="text-text-primary mt-0.5">{tokenText}</div></div>
                <div className="rounded-md bg-bg-secondary px-2 py-1.5"><span className="text-text-tertiary">{t('goal.turns')}</span><div className="text-text-primary mt-0.5">{goal.turns}</div></div>
              </div>
              {goal.completionEvidence && (
                <p className="text-[10px] leading-relaxed text-text-muted border-l-2 border-accent/30 pl-2">
                  {goal.completionEvidence}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                {goal.status === 'active' && !goal.waitReason && (
                  <button data-testid="goal-pause"
                    onClick={() => tabId && useGoalStore.getState().pauseGoal(tabId, 'interrupted')}
                    className="px-2.5 py-1.5 rounded-md text-[10px] border border-border-subtle text-text-muted hover:bg-bg-secondary">
                    {t('goal.pause')}
                  </button>
                )}
                {(goal.status === 'paused' || goal.status === 'blocked' || (goal.status === 'active' && goal.waitReason)) && (
                  <button data-testid="goal-resume"
                    onClick={() => tabId && resumeGoalExecution(tabId)}
                    className="px-2.5 py-1.5 rounded-md text-[10px] bg-accent text-text-inverse hover:bg-accent-hover">
                    {t('goal.resume')}
                  </button>
                )}
                <button data-testid="goal-clear"
                  onClick={() => tabId && useGoalStore.getState().clearGoal(tabId)}
                  className="px-2.5 py-1.5 rounded-md text-[10px] text-error hover:bg-error/10">
                  {t('goal.clear')}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div>
                <div className="text-sm font-semibold text-text-primary">{t('goal.create')}</div>
                <div data-testid="goal-explainer" className="mt-1 text-xs leading-relaxed text-text-tertiary">
                  {t('goal.createHint')}
                </div>
              </div>
              <div className="rounded-lg border border-accent/15 bg-accent/[0.05] px-3 py-2
                text-[10px] leading-relaxed text-text-muted">
                {t('composerMode.useMainInput')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GoalBanner() {
  const t = useT();
  const tabId = useSessionStore((state) => state.selectedSessionId);
  const goal = useGoalStore((state) => tabId ? state.goals[tabId] : undefined);
  const label = useMemo(() => goal ? statusLabel(goal, t) : '', [goal, t]);
  if (!goal) return null;

  return (
    <div data-testid="goal-banner" className="flex items-center gap-2 px-5 py-1.5 border-b border-border-subtle bg-accent/[0.04]">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${goal.status === 'active' ? 'bg-accent animate-pulse-soft' : 'bg-text-tertiary/40'}`} />
      <span className="text-[10px] font-semibold text-accent">Goal</span>
      <span className="text-[10px] text-text-muted truncate">{goal.objective}</span>
      <span className="ml-auto text-[9px] text-text-tertiary whitespace-nowrap">{label}</span>
    </div>
  );
}
