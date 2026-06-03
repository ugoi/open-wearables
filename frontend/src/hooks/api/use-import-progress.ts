import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/api/client';
import { API_ENDPOINTS } from '../../lib/api/config';

export interface ImportProgress {
  task_id: string;
  user_id: string;
  phase: 'uploading' | 'downloading' | 'processing' | 'complete' | 'error';
  percent: number;
  chunks_done: number;
  records_processed: number;
  message: string;
}

interface ActiveImportResponse {
  active: boolean;
  task_id?: string;
  user_id?: string;
  phase?: string;
  percent?: number;
  chunks_done?: number;
  records_processed?: number;
  message?: string;
}

interface SSEMessage {
  event?: string;
  data?: string;
}

const STORAGE_KEY = 'ow:import:active';

interface StoredImport {
  userId: string;
  taskId: string | null;
  phase: string;
  percent: number;
  ts: number;
}

function saveImportState(state: StoredImport) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota */ }
}

function loadImportState(userId: string): StoredImport | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as StoredImport;
    if (state.userId !== userId) return null;
    // Expire after 1 hour
    if (Date.now() - state.ts > 3600000) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function clearImportState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* */ }
}

function parseEvent(block: string): SSEMessage | null {
  const lines = block.split('\n');
  const msg: SSEMessage = {};
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).replace(/^\s/, '');
    if (field === 'event') msg.event = value;
    else if (field === 'data')
      msg.data = msg.data === undefined ? value : `${msg.data}\n${value}`;
  }
  return msg.data !== undefined ? msg : null;
}

export interface UseImportProgressResult {
  progress: ImportProgress | null;
  connected: boolean;
  error: string | null;
  setUploadProgress: (userId: string, percent: number) => void;
  setTaskId: (userId: string, taskId: string) => void;
}

export function useImportProgress(
  userId: string | null
): UseImportProgressResult {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskIdState] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // On mount: check localStorage then backend for active import
  useEffect(() => {
    if (!userId) return;

    const stored = loadImportState(userId);

    const checkBackend = async () => {
      try {
        const data = await apiClient.get<ActiveImportResponse>(
          API_ENDPOINTS.importProgress(userId)
        );
        if (data.active && data.task_id && data.phase !== 'complete' && data.phase !== 'error') {
          setTaskIdState(data.task_id);
          setProgress(data as unknown as ImportProgress);
          saveImportState({
            userId,
            taskId: data.task_id,
            phase: data.phase!,
            percent: data.percent ?? 0,
            ts: Date.now(),
          });
          return;
        }
      } catch { /* no active import */ }

      // If backend says nothing active but localStorage says uploading, show it
      if (stored && stored.phase === 'uploading') {
        setProgress({
          task_id: '',
          user_id: userId,
          phase: 'uploading',
          percent: stored.percent,
          chunks_done: 0,
          records_processed: 0,
          message: 'Upload in progress... (reconnecting)',
        });
      }
    };

    checkBackend();
  }, [userId]);

  // SSE stream when we have a taskId
  useEffect(() => {
    if (!userId || !taskId) return;

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    const run = async () => {
      try {
        const endpoint = `${API_ENDPOINTS.importProgressStream(userId)}?task_id=${encodeURIComponent(taskId)}`;
        const response = await apiClient.fetchRaw(endpoint, {
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          setError(`Stream error: ${response.status}`);
          setConnected(false);
          return;
        }
        setConnected(true);
        setError(null);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sepIdx: number;
          while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            const msg = parseEvent(block);
            if (!msg || !msg.data) continue;
            if (msg.event && msg.event !== 'import.progress') continue;
            try {
              const parsed = JSON.parse(msg.data) as ImportProgress;
              setProgress(parsed);
              saveImportState({
                userId,
                taskId,
                phase: parsed.phase,
                percent: parsed.percent,
                ts: Date.now(),
              });
              if (parsed.phase === 'complete' || parsed.phase === 'error') {
                setConnected(false);
                if (parsed.phase === 'complete') {
                  setTimeout(() => clearImportState(), 5000);
                }
                return;
              }
            } catch { /* ignore */ }
          }
        }
        setConnected(false);
      } catch (err) {
        if (cancelled || (err as Error).name === 'AbortError') return;
        setConnected(false);
        setError((err as Error).message ?? 'Stream error');
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
      setConnected(false);
    };
  }, [userId, taskId]);

  // Called by upload hook during XHR upload phase
  const setUploadProgress = (uid: string, percent: number) => {
    setProgress({
      task_id: '',
      user_id: uid,
      phase: 'uploading',
      percent,
      chunks_done: 0,
      records_processed: 0,
      message: 'Uploading to storage...',
    });
    saveImportState({
      userId: uid,
      taskId: null,
      phase: 'uploading',
      percent,
      ts: Date.now(),
    });
  };

  // Called when confirm returns task_id
  const setTaskId = (uid: string, tid: string) => {
    setTaskIdState(tid);
    saveImportState({
      userId: uid,
      taskId: tid,
      phase: 'processing',
      percent: 5,
      ts: Date.now(),
    });
  };

  return { progress, connected, error, setUploadProgress, setTaskId };
}
