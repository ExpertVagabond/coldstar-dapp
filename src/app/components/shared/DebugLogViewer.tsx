import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Trash2, Copy, ChevronDown } from 'lucide-react';
import { dlog } from '../../../services/debug-log';
import type { LogLevel, LogEntry } from '../../../services/debug-log';

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-white/40',
  info:  'text-blue-400',
  warn:  'text-amber-400',
  error: 'text-red-400',
};

const LEVEL_BG: Record<LogLevel, string> = {
  debug: '',
  info:  '',
  warn:  'bg-amber-500/5',
  error: 'bg-red-500/10',
};

/** 
 * Hidden debug log viewer.
 * Activated by triple-tapping the trigger area.
 */
export function DebugLogViewer({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [filter, setFilter] = useState<LogLevel | 'all'>('all');
  const [copied, setCopied] = useState(false);
  const tapRef = useRef<number[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Subscribe to log changes
  useEffect(() => {
    setEntries(dlog.getAll());
    return dlog.subscribe(() => setEntries([...dlog.getAll()]));
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  // Triple-tap detection (3 taps within 800ms)
  const handleTriggerTap = useCallback(() => {
    const now = Date.now();
    tapRef.current.push(now);
    // Keep only taps within last 800ms
    tapRef.current = tapRef.current.filter(t => now - t < 800);
    if (tapRef.current.length >= 3) {
      tapRef.current = [];
      setOpen(true);
      dlog.info('DebugLog', 'Log viewer opened');
    }
  }, []);

  const handleCopy = async () => {
    const text = dlog.export();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for Android WebView
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleClear = () => {
    dlog.clear();
  };

  const filtered = filter === 'all' ? entries : entries.filter(e => e.level === filter);

  return (
    <>
      {/* Trigger area — wraps children, invisible tap target */}
      <div onClick={handleTriggerTap} className="contents">
        {children}
      </div>

      {/* Log viewer overlay */}
      {open && (
        <div className="fixed inset-0 z-[9999] bg-black/95 flex flex-col" style={{ touchAction: 'none' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-white/80">Debug Log</span>
              <span className="text-xs text-white/30 font-mono">{filtered.length} entries</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleCopy} className="p-2 rounded-lg bg-white/5 active:bg-white/10">
                {copied
                  ? <span className="text-xs text-emerald-400">Copied!</span>
                  : <Copy className="w-4 h-4 text-white/50" />}
              </button>
              <button onClick={handleClear} className="p-2 rounded-lg bg-white/5 active:bg-white/10">
                <Trash2 className="w-4 h-4 text-white/50" />
              </button>
              <button onClick={() => setOpen(false)} className="p-2 rounded-lg bg-white/5 active:bg-white/10">
                <X className="w-4 h-4 text-white/50" />
              </button>
            </div>
          </div>

          {/* Filter bar */}
          <div className="flex gap-1 px-4 py-2 border-b border-white/5 flex-shrink-0 overflow-x-auto">
            {(['all', 'debug', 'info', 'warn', 'error'] as const).map(level => (
              <button
                key={level}
                onClick={() => setFilter(level)}
                className={`px-3 py-1 rounded-full text-xs font-mono transition-colors ${
                  filter === level
                    ? 'bg-white/15 text-white'
                    : 'bg-white/5 text-white/40'
                }`}
              >
                {level.toUpperCase()}
                {level !== 'all' && (
                  <span className="ml-1 opacity-60">
                    {entries.filter(e => e.level === level).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Log entries */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              setAutoScroll(atBottom);
            }}
          >
            {filtered.length === 0 && (
              <div className="text-center text-white/20 mt-12">No log entries yet</div>
            )}
            {filtered.map(entry => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </div>

          {/* Scroll-to-bottom fab */}
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
              }}
              className="absolute bottom-6 right-6 w-10 h-10 rounded-full bg-white/10 border border-white/20 flex items-center justify-center"
            >
              <ChevronDown className="w-5 h-5 text-white/60" />
            </button>
          )}
        </div>
      )}
    </>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`py-1 px-1 border-b border-white/5 ${LEVEL_BG[entry.level]}`}
      onClick={() => entry.data && setExpanded(!expanded)}
    >
      <div className="flex gap-2">
        <span className="text-white/20 flex-shrink-0">{new Date(entry.timestamp).toISOString().slice(11, 23)}</span>
        <span className={`flex-shrink-0 w-10 ${LEVEL_COLORS[entry.level]}`}>
          {entry.level === 'debug' ? 'DBG' : entry.level === 'info' ? 'INF' : entry.level === 'warn' ? 'WRN' : 'ERR'}
        </span>
        <span className="text-purple-400/70 flex-shrink-0">[{entry.tag}]</span>
        <span className="text-white/70 break-all">{entry.message}</span>
      </div>
      {expanded && entry.data && (
        <pre className="mt-1 ml-24 text-white/30 whitespace-pre-wrap break-all text-[10px]">
          {entry.data}
        </pre>
      )}
    </div>
  );
}
