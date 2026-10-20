'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  isStaleServerActionError,
  markStaleActionState,
} from '../lib/staleActionState';

interface ActionPollingOptions {
  intervalMs: number;
  enabled?: boolean;
  runImmediately?: boolean;
  maxBackoffMs?: number;
  /**
   * Skip scheduled polls while the tab is hidden and poll once when it becomes
   * visible again. Background tabs otherwise keep firing server actions.
   */
  pauseWhenHidden?: boolean;
  onError?: (error: unknown, retryDelayMs: number) => void;
}

interface ActionPollingResult {
  runNow: () => Promise<void>;
}

type PollAttemptResult =
  | { outcome: 'success' }
  | { outcome: 'retry'; retryDelayMs: number }
  | { outcome: 'halted' };

export function useActionPolling(
  action: () => Promise<unknown> | unknown,
  {
    intervalMs,
    enabled = true,
    runImmediately = true,
    maxBackoffMs = intervalMs * 16,
    pauseWhenHidden = true,
    onError,
  }: ActionPollingOptions,
): ActionPollingResult {
  const actionRef = useRef(action);
  const onErrorRef = useRef(onError);
  const intervalMsRef = useRef(intervalMs);
  const maxBackoffMsRef = useRef(maxBackoffMs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<PollAttemptResult> | null>(null);
  const failureCountRef = useRef(0);
  const haltedRef = useRef(false);

  actionRef.current = action;
  onErrorRef.current = onError;
  intervalMsRef.current = intervalMs;
  maxBackoffMsRef.current = maxBackoffMs;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const executeAction = useCallback((): Promise<PollAttemptResult> => {
    if (haltedRef.current) {
      return Promise.resolve({ outcome: 'halted' });
    }

    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    const attempt = (async (): Promise<PollAttemptResult> => {
      try {
        await actionRef.current();
        failureCountRef.current = 0;
        return { outcome: 'success' };
      } catch (error) {
        if (isStaleServerActionError(error)) {
          haltedRef.current = true;
          clearTimer();
          markStaleActionState();
          return { outcome: 'halted' };
        }

        failureCountRef.current += 1;
        const backoffExponent = Math.min(failureCountRef.current - 1, 30);
        const retryDelayMs = Math.min(
          intervalMsRef.current * (2 ** backoffExponent),
          maxBackoffMsRef.current,
        );

        console.error(
          `[useActionPolling] Action failed; retrying in ${retryDelayMs}ms`,
          error,
        );
        onErrorRef.current?.(error, retryDelayMs);

        return { outcome: 'retry', retryDelayMs };
      }
    })();

    inFlightRef.current = attempt;
    void attempt.finally(() => {
      if (inFlightRef.current === attempt) {
        inFlightRef.current = null;
      }
    });

    return attempt;
  }, [clearTimer]);

  const runNow = useCallback(async () => {
    await executeAction();
  }, [executeAction]);

  useEffect(() => {
    clearTimer();

    if (!enabled || haltedRef.current) {
      return undefined;
    }

    let cancelled = false;
    // Set when a scheduled poll came due while the tab was hidden.
    let pausedWhileHidden = false;

    const isHidden = () =>
      pauseWhenHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const schedule = (delayMs: number) => {
      if (cancelled || haltedRef.current) {
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (isHidden()) {
          pausedWhileHidden = true;
          return;
        }
        void poll();
      }, delayMs);
    };

    const handleVisibilityChange = () => {
      if (!pausedWhileHidden || isHidden() || cancelled) {
        return;
      }
      pausedWhileHidden = false;
      void poll();
    };

    const poll = async () => {
      const result = await executeAction();
      if (cancelled || result.outcome === 'halted') {
        return;
      }

      schedule(
        result.outcome === 'retry'
          ? result.retryDelayMs
          : intervalMsRef.current,
      );
    };

    if (pauseWhenHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    if (runImmediately) {
      void poll();
    } else {
      schedule(intervalMs);
    }

    return () => {
      cancelled = true;
      clearTimer();
      if (pauseWhenHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [clearTimer, enabled, executeAction, intervalMs, maxBackoffMs, pauseWhenHidden, runImmediately]);

  return { runNow };
}
