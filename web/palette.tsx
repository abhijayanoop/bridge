import { useEffect, useMemo, useRef, useState } from "react";

export interface QuickActionInfo { id: string; label: string; description: string }
interface Row { id: string; label: string; description: string; kind: "action" | "go" }

/** True for the key chord that opens the palette: Ctrl+K, or Cmd+K on a Mac. */
export const isPaletteKey = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">) =>
  typeof e.key === "string" && e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;

const kbd = "rounded border border-line px-1.5 font-mono text-[11px] leading-5 text-fg-2";

/**
 * Command palette. Quick actions start a normal agent with one skill; "Go to" jumps to a section.
 * Arrow keys move, Enter runs, Tab adds context for the highlighted action, Escape closes.
 */
export function CommandPalette({ sections, onGo, onRun, onClose }: {
  sections: string[]; onGo: (section: string) => void;
  onRun: (action: string, context: string) => Promise<string | null>; onClose: () => void;
}) {
  const [actions, setActions] = useState<QuickActionInfo[]>([]);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const [adding, setAdding] = useState<QuickActionInfo | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    fetch("/api/quick-actions").then((r) => r.json()).then(setActions).catch(() => setError("Could not load the quick actions."));
    input.current?.focus();
    const back = opener.current;
    return () => { if (back instanceof HTMLElement) back.focus(); };
  }, []);

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Row[] = [
      ...actions.map((a): Row => ({ id: a.id, label: a.label, description: a.description, kind: "action" })),
      ...sections.map((s): Row => ({ id: s, label: s, description: `Go to ${s}`, kind: "go" })),
    ];
    return adding ? [] : all.filter((r) => !q || r.label.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }, [actions, sections, query, adding]);
  const current = Math.min(at, Math.max(rows.length - 1, 0));

  const run = async (row: Row | undefined, context = "") => {
    if (!row) return;
    if (row.kind === "go") { onGo(row.id); return onClose(); }
    if (busy.current) return;
    busy.current = true;
    setError("");
    const failed = await onRun(row.id, context);
    busy.current = false;
    if (failed) setError(failed); else onClose();
  };
  const runAdding = () => { if (adding) void run({ id: adding.id, label: adding.label, description: adding.description, kind: "action" }, query); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); if (adding) { setAdding(null); setQuery(""); } else onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setAt((current + 1) % Math.max(rows.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((current - 1 + rows.length) % Math.max(rows.length, 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (adding) runAdding(); else void run(rows[current]); }
    else if (e.key === "Tab") {
      // The palette is a modal: Tab adds context to the highlighted action instead of leaving it.
      e.preventDefault();
      const row = rows[current];
      if (!adding && row?.kind === "action") { setAdding(actions.find((a) => a.id === row.id) ?? null); setQuery(""); }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-6 pt-24" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey} onMouseDown={(e) => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus(); } }}
        className="flex w-full max-w-[660px] flex-col overflow-hidden rounded-2xl border border-white/15 bg-surface shadow-2xl">
        <div className="flex h-14 items-center gap-3 border-b border-line px-4">
          <label htmlFor="palette-input" className="sr-only">{adding ? `Context for ${adding.label}` : "Command"}</label>
          {adding && <span className="rounded-md border border-line px-2 text-xs text-fg-2">{adding.label}</span>}
          <input id="palette-input" ref={input} value={query} onChange={(e) => { setQuery(e.target.value); setAt(0); }}
            role="combobox" aria-expanded={!adding} aria-controls="palette-list" aria-autocomplete="list"
            aria-activedescendant={!adding && rows[current] ? `palette-${rows[current]!.kind}-${rows[current]!.id}` : undefined}
            placeholder={adding ? "Add context for the agent, then press Enter" : "Run a quick action or go to a screen…"}
            className="h-10 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3" />
          <kbd className={kbd}>esc</kbd>
        </div>
        {adding ? (
          <p className="px-4 py-3 text-[13px] text-fg-2">{adding.description}</p>
        ) : (
          <ul id="palette-list" role="listbox" aria-label="Commands" className="flex max-h-[420px] flex-col gap-0.5 overflow-auto p-2">
            {rows.map((r, i) => (
              <li key={`${r.kind}-${r.id}`} id={`palette-${r.kind}-${r.id}`} role="option" aria-selected={i === current}
                onMouseEnter={() => setAt(i)} onClick={() => void run(r)}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2.5 py-1.5 ${i === current ? "bg-surface-2" : ""}`}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{r.label}</span>
                  <span className="truncate text-xs text-fg-2">{r.description}</span>
                </span>
                <span className="text-[11px] text-fg-3">{r.kind === "action" ? "Quick action" : "Go to"}</span>
              </li>
            ))}
            {rows.length === 0 && <li role="presentation" className="px-2.5 py-3 text-fg-3">Nothing matches.</li>}
          </ul>
        )}
        {error && <p role="alert" className="border-t border-line px-4 py-2 text-[13px] text-[#fbbf24]">{error}</p>}
        <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-2.5 text-xs text-fg-3">
          <span><kbd className={kbd}>↑↓</kbd> move</span>
          <span><kbd className={kbd}>↵</kbd> run</span>
          <span><kbd className={kbd}>tab</kbd> add context</span>
        </div>
      </div>
    </div>
  );
}
