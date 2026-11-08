import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AgentAvatar, ThinkingOrb } from "./avatar.tsx";
import { STATE_LABELS } from "../src/shared/avatar.ts";

export interface AgentInfo { id: string; name: string; status: string; ticketId?: string | null; ticketKey?: string | null; ticketTitle?: string | null; shape?: string; color?: string; lead?: boolean; avatarState?: string }
interface TicketOpt { id: string; key: string; title: string; column: string }

const wsUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const LIVE = (s: string) => s === "working" || s === "waiting" || s === "blocked";

/** Terminal for one agent: replays stored output, then streams live; keystrokes go back over the socket. */
function TerminalDrawer({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(agent.status);
  const [sendLine, setSendLine] = useState("");
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    const term = new Terminal({ convertEol: false, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 13, theme: { background: "#0A0A0A" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    const ws = new WebSocket(wsUrl());
    socket.current = ws;
    let last = 0;
    const pending: any[] = [];
    let replayed = false;
    const apply = (eventId: number, event: any) => {
      if (eventId <= last) return;
      last = eventId;
      if (event.type === "output") term.write(event.data);
      if (event.type === "status") setStatus(event.status);
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(String(m.data));
        if (msg.type !== "agent-event" || msg.agentId !== agent.id) return;
        if (replayed) apply(msg.eventId, msg.event); else pending.push(msg);
      } catch { /* ignore */ }
    };
    const sendResize = () => {
      try { fit.fit(); } catch { return; }
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", agentId: agent.id, cols: term.cols, rows: term.rows }));
    };
    ws.onopen = sendResize;
    fetch(`/api/agents/${agent.id}/events`).then((r) => r.json()).then((rows: { id: number; event: any }[]) => {
      for (const r of rows) apply(r.id, r.event);
      replayed = true;
      for (const m of pending) apply(m.eventId, m.event);
    }).catch(() => { replayed = true; });
    const data = term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", agentId: agent.id, data: d })); });
    const ro = new ResizeObserver(sendResize);
    ro.observe(host.current!);
    return () => { ro.disconnect(); data.dispose(); ws.close(); term.dispose(); };
  }, [agent.id]);

  const stop = () => { fetch(`/api/agents/${agent.id}/stop`, { method: "POST", body: "{}" }).catch(() => {}); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sendLine) return;
    socket.current?.send(JSON.stringify({ type: "input", agentId: agent.id, data: sendLine + "\r" }));
    setSendLine("");
  };
  return (
    <aside aria-label={`Terminal for ${agent.name}`} className="fixed inset-y-0 right-0 z-10 flex w-[min(760px,100%)] flex-col border-l border-line bg-bg">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{agent.name}</span>
          <span className="truncate text-xs text-fg-3">{agent.ticketKey ? `${agent.ticketKey} · ${agent.ticketTitle ?? ""}` : "No ticket"} · {status}</span>
        </div>
        <button type="button" onClick={stop} disabled={!LIVE(status) && status !== "idle"} className="h-8 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-40">Stop</button>
        <button type="button" onClick={onClose} aria-label="Close terminal" className="h-8 rounded-lg border border-line px-3 text-[13px] text-fg-2 hover:bg-surface">Close</button>
      </header>
      <div ref={host} className="min-h-0 flex-1 p-2" />
      <form onSubmit={submit} className="flex gap-2 border-t border-line p-3">
        <input aria-label="Send input to agent" value={sendLine} onChange={(e) => setSendLine(e.target.value)} placeholder="Type a reply and press Enter"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-[13px]" />
        <button type="submit" className="h-9 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-surface-2">Send</button>
      </form>
    </aside>
  );
}

export function AgentsScreen({ projectId, agents }: { projectId?: string; agents: AgentInfo[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<TicketOpt[]>([]);
  const [pick, setPick] = useState("");
  useEffect(() => {
    if (!projectId) return setTickets([]);
    fetch(`/api/projects/${projectId}/tickets`).then((r) => r.json()).then((ts: TicketOpt[]) => setTickets(ts.filter((t) => t.column !== "done"))).catch(() => {});
  }, [projectId]);

  const start = async () => {
    const t = tickets.find((x) => x.id === pick);
    if (!projectId || !t) return;
    const r = await fetch("/api/agents", { method: "POST", body: JSON.stringify({ projectId, name: `Agent ${t.key}`, ticket: t.id }) });
    if (r.ok) setOpenId(((await r.json()) as AgentInfo).id);
  };
  const open = agents.find((a) => a.id === openId);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Ticket to start an agent on" value={pick} onChange={(e) => setPick(e.target.value)} className="h-9 min-w-0 max-w-full rounded-lg border border-line bg-surface px-2 text-[13px]">
          <option value="">Choose a ticket</option>
          {tickets.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}
        </select>
        <button type="button" onClick={start} disabled={!pick} className="h-9 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-40">Start agent</button>
      </div>
      {agents.length === 0 ? (
        <div className="grid h-40 place-items-center rounded-xl border border-dashed border-line text-fg-3">No agents yet. Pick a ticket and start one.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setOpenId(a.id)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left hover:bg-surface-2">
                <AgentAvatar shape={a.shape ?? "circle"} color={a.color ?? "#0A84FF"} state={a.avatarState ?? "idle"} size={40} lead={a.lead} name={a.name} />
                <span className="font-semibold">{a.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-2">{a.ticketKey ? `${a.ticketKey} · ${a.ticketTitle ?? ""}` : "no ticket"}</span>
                <ThinkingOrb state={a.avatarState ?? "idle"} color={a.color ?? "#0A84FF"} size={32} />
                <span className="w-28 text-right text-xs text-fg-2">{STATE_LABELS[(a.avatarState ?? "idle") as keyof typeof STATE_LABELS] ?? a.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <TerminalDrawer key={open.id} agent={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}
