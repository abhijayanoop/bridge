import { useEffect, useState } from "react";
import { AgentAvatar } from "./avatar.tsx";
import type { AgentInfo } from "./agents.tsx";

export interface InboxItemInfo {
  id: string; agentId: string; kind: "question" | "access" | "plan" | "merge"; access?: string | null;
  what: string; why: string; facts: { k: string; v: string }[]; ticketKey?: string | null; createdAt: number;
  status: "open" | "resolved"; decision?: "approve" | "deny" | "reply" | null; reply?: string | null;
}

const ACCESS_CHIP: Record<string, string> = { domain: "Network domain", secret: "Secret", push: "Git push", database: "Database" };
const chip = (i: InboxItemInfo) =>
  i.kind === "access" ? ACCESS_CHIP[i.access ?? ""] ?? "Access" : i.kind === "question" ? "Question" : i.kind === "plan" ? "Plan approval" : "Ready to merge";
const FILTERS: { label: string; match: (i: InboxItemInfo) => boolean }[] = [
  { label: "All", match: () => true },
  { label: "Access", match: (i) => i.kind === "access" },
  { label: "Questions", match: (i) => i.kind === "question" },
  { label: "Merges", match: (i) => i.kind === "merge" },
  { label: "Plans", match: (i) => i.kind === "plan" },
];
const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };
const outcome = (i: InboxItemInfo) => i.decision === "approve" ? "Approved" : i.decision === "deny" ? "Denied" : `Replied: ${i.reply ?? ""}`;
const btn = "inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-surface-2";

function Item({ item, agent, onResolve }: { item: InboxItemInfo; agent?: AgentInfo; onResolve: (id: string, decision: string, text?: string) => void }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const open = item.status === "open";
  const askable = item.kind === "question";
  return (
    <article aria-label={`${chip(item)} from ${agent?.name ?? "agent"}: ${item.what}`} className={`flex gap-3 rounded-xl border border-line bg-surface p-4 ${open ? "" : "opacity-70"}`}>
      <AgentAvatar shape={agent?.shape ?? "circle"} color={agent?.color ?? "#0A84FF"} state={open ? "listening" : agent?.avatarState ?? "idle"} size={40} name={agent?.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[13px] font-semibold">{agent?.name ?? "Agent"}</span>
          <span className="inline-flex h-5 items-center rounded-md border border-line px-1.5 text-fg-2">{chip(item)}</span>
          {item.ticketKey && <span className="font-mono text-fg-3">{item.ticketKey}</span>}
          <span className="flex-1" />
          <span className="text-fg-3">{ago(item.createdAt)}</span>
        </div>
        <h3 className="text-sm font-medium leading-5">{item.what}</h3>
        {item.why && <p className="text-[13px] leading-5 text-fg-2">{item.why}</p>}
        {item.facts.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {item.facts.map((f) => <div key={f.k} className="contents"><dt className="text-fg-3">{f.k}</dt><dd className="min-w-0 truncate font-mono">{f.v}</dd></div>)}
          </dl>
        )}
        {open && replying && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onResolve(item.id, "reply", text); }}>
            <input autoFocus aria-label="Reply" value={text} onChange={(e) => setText(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 text-[13px]" />
            <button type="submit" className={btn}>Send</button>
          </form>
        )}
        {open ? (
          <div className="flex gap-2 pt-1">
            {!askable && <button type="button" className={`${btn} bg-fg text-bg hover:bg-fg`} onClick={() => onResolve(item.id, "approve")}>Approve</button>}
            {!askable && <button type="button" className={btn} onClick={() => onResolve(item.id, "deny")}>Deny</button>}
            <button type="button" className={btn} onClick={() => setReplying(!replying)}>Reply</button>
          </div>
        ) : <p className="pt-1 text-xs font-medium text-fg-2">{outcome(item)}</p>}
      </div>
    </article>
  );
}

/** The Inbox screen: everything that needs the user, newest first, with resolved items kept below. */
export function InboxScreen({ agents, items, reload }: { agents: AgentInfo[]; items: InboxItemInfo[]; reload: () => void }) {
  const [filter, setFilter] = useState(0);
  const shown = items.filter(FILTERS[filter]!.match);
  const resolve = (id: string, decision: string, text?: string) => {
    fetch(`/api/inbox/${id}/resolve`, { method: "POST", body: JSON.stringify({ decision, text }) }).then(reload).catch(reload);
  };
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div role="tablist" aria-label="Filter" className="flex gap-1">
        {FILTERS.map((f, n) => {
          const count = items.filter((i) => i.status === "open" && f.match(i)).length;
          return (
            <button key={f.label} type="button" role="tab" aria-selected={n === filter} onClick={() => setFilter(n)}
              className={`h-8 rounded-lg px-3 text-[13px] font-medium ${n === filter ? "bg-surface-2 text-fg" : "text-fg-2 hover:bg-surface"}`}>
              {f.label} <span className="text-fg-3">{count}</span>
            </button>
          );
        })}
      </div>
      {shown.length === 0 && <div className="grid h-40 place-items-center rounded-xl border border-dashed border-line text-fg-3">Nothing needs you right now.</div>}
      {shown.map((i) => <Item key={i.id} item={i} agent={agents.find((a) => a.id === i.agentId)} onResolve={resolve} />)}
    </div>
  );
}

/** Live Inbox state: the list and the open count, refreshed on every Inbox WebSocket message. */
export function useInbox() {
  const [items, setItems] = useState<InboxItemInfo[]>([]);
  const [open, setOpen] = useState(0);
  const load = () => { fetch("/api/inbox").then((r) => r.json()).then((d) => { setItems(d.items); setOpen(d.open); }).catch(() => {}); };
  useEffect(() => {
    load();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (m) => { try { const d = JSON.parse(String(m.data)); if (d.type === "inbox") { setOpen(d.open); load(); } } catch { /* ignore */ } };
    return () => ws.close();
  }, []);
  return { items, open, reload: load };
}

export function CountBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span aria-label={`${n} in Inbox`} className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-fg px-1 text-[11px] font-semibold text-bg">{n}</span>;
}
