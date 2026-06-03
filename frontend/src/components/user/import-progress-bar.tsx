import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertCircle, Upload, Loader2, X } from 'lucide-react';
import type { ImportProgress } from '@/hooks/api/use-import-progress';

interface ImportProgressToastProps {
  progress: ImportProgress | null;
  uploadPercent: number | null;
  isUploading: boolean;
}

interface PhaseConfig {
  icon: typeof Upload;
  label: string;
  colorClass: string;
  glowClass: string;
  iconBgClass: string;
  barClass: string;
}

const phases: Record<string, PhaseConfig> = {
  uploading: {
    icon: Upload,
    label: 'Uploading to storage',
    colorClass: 'text-cyan-400',
    glowClass: 'shadow-[0_0_24px_rgba(0,229,255,0.08),0_8px_32px_rgba(0,0,0,0.5)]',
    iconBgClass: 'bg-cyan-400/10 border-cyan-400/25',
    barClass: 'bg-cyan-400 shadow-[0_0_8px_rgba(0,229,255,0.25)]',
  },
  downloading: {
    icon: Loader2,
    label: 'Preparing file',
    colorClass: 'text-cyan-400',
    glowClass: 'shadow-[0_0_24px_rgba(0,229,255,0.08),0_8px_32px_rgba(0,0,0,0.5)]',
    iconBgClass: 'bg-cyan-400/10 border-cyan-400/25',
    barClass: 'bg-cyan-400 shadow-[0_0_8px_rgba(0,229,255,0.25)]',
  },
  processing: {
    icon: Loader2,
    label: 'Processing health data',
    colorClass: 'text-purple-400',
    glowClass: 'shadow-[0_0_24px_rgba(168,85,247,0.08),0_8px_32px_rgba(0,0,0,0.5)]',
    iconBgClass: 'bg-purple-400/10 border-purple-400/30',
    barClass: 'bg-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.3)]',
  },
  complete: {
    icon: CheckCircle2,
    label: 'Import complete',
    colorClass: 'text-emerald-400',
    glowClass: 'shadow-[0_0_24px_rgba(0,255,127,0.08),0_8px_32px_rgba(0,0,0,0.5)]',
    iconBgClass: 'bg-emerald-400/10 border-emerald-400/25',
    barClass: 'bg-emerald-400 shadow-[0_0_8px_rgba(0,255,127,0.3)]',
  },
  error: {
    icon: AlertCircle,
    label: 'Import failed',
    colorClass: 'text-rose-400',
    glowClass: 'shadow-[0_0_24px_rgba(255,26,83,0.08),0_8px_32px_rgba(0,0,0,0.5)]',
    iconBgClass: 'bg-rose-400/10 border-rose-400/30',
    barClass: 'bg-rose-400 shadow-[0_0_8px_rgba(255,26,83,0.3)]',
  },
};

export function ImportProgressBar({
  progress,
  uploadPercent,
  isUploading,
}: ImportProgressToastProps) {
  const [dismissed, setDismissed] = useState(false);

  const phase = progress?.phase ?? (isUploading ? 'uploading' : null);
  const percent =
    phase === 'uploading' ? (uploadPercent ?? 0) : (progress?.percent ?? 0);

  useEffect(() => {
    if (phase && phase !== 'complete' && phase !== 'error') {
      setDismissed(false);
    }
  }, [phase]);

  useEffect(() => {
    if (phase === 'complete' || phase === 'error') {
      const timer = setTimeout(() => setDismissed(true), 5000);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  const visible = !!phase && !dismissed;
  const cfg = phase ? (phases[phase] ?? phases.processing) : phases.processing;
  const Icon = cfg.icon;
  const isTerminal = phase === 'complete' || phase === 'error';
  const shouldSpin = !isTerminal && Icon === Loader2;

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          key={phase}
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className={`fixed bottom-6 left-6 z-[9999] w-[356px] rounded-[14px] overflow-hidden border border-zinc-700/60 bg-zinc-800/97 backdrop-blur-xl ${cfg.glowClass} font-sans`}
        >
          <div className="p-4">
            <div className="flex items-center gap-3">
              <div
                className={`w-[34px] h-[34px] shrink-0 flex items-center justify-center rounded-[9px] border ${cfg.iconBgClass}`}
              >
                <Icon
                  className={`w-4 h-4 ${cfg.colorClass} ${shouldSpin ? 'animate-spin' : ''}`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-zinc-50 truncate">
                    {cfg.label}
                  </span>
                  <span
                    className={`shrink-0 text-xs font-semibold tabular-nums ${cfg.colorClass}`}
                  >
                    {percent}%
                  </span>
                </div>

                {progress?.records_processed ? (
                  <p className="mt-0.5 text-[11px] text-zinc-500 truncate">
                    {progress.records_processed.toLocaleString()} records
                    processed
                  </p>
                ) : progress?.message && phase === 'error' ? (
                  <p className={`mt-0.5 text-[11px] truncate ${cfg.colorClass}`}>
                    {progress.message}
                  </p>
                ) : null}
              </div>

              <button
                onClick={() => setDismissed(true)}
                className="shrink-0 p-1.5 rounded-[7px] border-none bg-transparent text-zinc-500/50 hover:text-zinc-50 cursor-pointer flex items-center justify-center transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="mt-3.5 h-1 w-full rounded-full bg-zinc-800/80 overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${cfg.barClass}`}
                initial={false}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
