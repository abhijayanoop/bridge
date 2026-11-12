import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AgentsScreen, type AgentInfo } from "./agents.tsx";
import { CountBadge, InboxScreen, useInbox } from "./inbox.tsx";
import { PlanScreen } from "./plan.tsx";
import { AnalystScreen } from "./analyst.tsx";
import { ReviewScreen, type PullInfo, type ReviewInfo } from "./review.tsx";
import { AgentAvatar, ThinkingOrb } from "./avatar.tsx";
import { CommandPalette, isPaletteKey } from "./palette.tsx";
import { useEscape } from "./a11y.ts";
import { FirstRunSetup, NewProjectDialog } from "./setup.tsx";
import { STATE_LABELS } from "../src/shared/avatar.ts";

interface Project { id: string; name: string; path: string }

const NAV = ["Board", "Agents", "Inbox", "Plan", "Review", "Analyst"];

// Icon paths from the design canvas (Sidebar.dc.html); Analyst reuses its sliders glyph.
const NAV_ICONS: Record<string, string> = {
  Board: "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9.5 4v16M14.5 4v16",
  Agents: "M9 5h6a5 5 0 0 1 5 5v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5zM9.5 10.5l-1 2.4M14 10.5l.6 2.4",
  Inbox: "M3 13l2.4-7.2A2.5 2.5 0 0 1 7.8 4h8.4a2.5 2.5 0 0 1 2.4 1.8L21 13v4.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM3 13h5l1.5 2.5h5L16 13h5",
  Plan: "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5M9 13h6M9 17h4",
  Review: "M6 3.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM6 15.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM18 15.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4zM6 8.2v7.6M18 15.8V10a3 3 0 0 0-3-3h-4M13 5l-2 2 2 2",
  Analyst: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5a2 2 0 1 1 0 4a2 2 0 1 1 0-4zM9 15a2 2 0 1 1 0 4a2 2 0 1 1 0-4z",
};

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" className="flex-none fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function LeadCard({ agent }: { agent?: AgentInfo }) {
  if (!agent) return null;
  const state = agent.avatarState ?? "idle";
  return (
    <div aria-label={`Lead agent ${agent.name}, ${STATE_LABELS[state as keyof typeof STATE_LABELS] ?? state}`} className="mt-auto flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
      <span className="p-1"><AgentAvatar shape={agent.shape ?? "circle"} color={agent.color ?? "#0A84FF"} state={state} size={40} lead name={agent.name} /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-semibold">{agent.name}</span>
        <span className="text-xs text-fg-2">{STATE_LABELS[state as keyof typeof STATE_LABELS] ?? state}</span>
      </span>
      <ThinkingOrb state={state} color={agent.color ?? "#0A84FF"} size={32} />
    </div>
  );
}

function Sidebar({ project, projects, section, onSelect, onSwitch, onAdd, lead, inbox }: { onAdd: () => void; inbox: number; project?: Project; projects: Project[]; section: string; onSelect: (s: string) => void; onSwitch: (id: string) => void; lead?: AgentInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <nav aria-label="Primary" className="flex w-60 flex-none flex-col gap-1 bg-bg p-3">
      <button type="button" aria-label={`Switch project, current ${project?.name ?? "none"}`} aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-12 items-center gap-2.5 rounded-xl border border-line bg-surface px-2.5 text-left text-fg">
        <span className="grid size-[26px] flex-none place-items-center rounded-lg border border-line bg-surface-2 text-xs font-semibold">{(project?.name ?? "B")[0]!.toUpperCase()}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold">{project?.name ?? "No project"}</span>
          <span className="truncate font-mono text-[11px] text-fg-3">{project?.path ?? "none selected"}</span>
        </span>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="flex-none fill-none stroke-fg-3" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 9l4-4 4 4M8 15l4 4 4-4" /></svg>
      </button>
      {open && (
        <ul role="listbox" aria-label="Projects" className="flex flex-col gap-0.5 rounded-xl border border-line bg-surface p-1">
          {projects.map((p) => (
            <li key={p.id} role="option" aria-selected={p.id === project?.id}>
              <button type="button" onClick={() => { onSwitch(p.id); setOpen(false); }}
                className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${p.id === project?.id ? "bg-surface-2" : ""}`}>
                <span className="text-[13px] font-semibold">{p.name}</span>
                <span className="truncate font-mono text-[11px] text-fg-3">{p.path}</span>
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="px-2.5 py-1.5 text-fg-3">Run bridge in a repo to add it.</li>}
          <li><button type="button" onClick={() => { onAdd(); setOpen(false); }} className="w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium text-fg-2 hover:bg-surface-2">+ Add or create project</button></li>
        </ul>
      )}
      <span className="mt-5 px-2.5 pb-1 text-[11px] font-medium text-fg-3">Workspace</span>
      {NAV.map((n) => (
        <button key={n} type="button" aria-current={n === section ? "page" : undefined} onClick={() => onSelect(n)}
          className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left font-medium ${n === section ? "bg-surface-2 text-fg" : "text-fg-2 hover:bg-surface"}`}>
          <Icon d={NAV_ICONS[n]!} />
          <span className="flex-1">{n}</span>
          {n === "Inbox" && <CountBadge n={inbox} />}
        </button>
      ))}
      <LeadCard agent={lead} />
    </nav>
  );
}

interface Limits { cap: number; max: number; running: number; rateLimited: { since: number; agentId: string } | null; queued: { id: string; ticketKey: string; blocked: boolean; error?: string }[] }

/** Asks the daemon whether agents are running, warns, and quits only when the user agrees. */
function QuitButton() {
  const [state, setState] = useState<"idle" | "confirm" | "stopped">("idle");
  const [warning, setWarning] = useState("");
  const ui = { "x-bridge-ui": "1" };
  const ask = async () => {
    const r = await fetch("/api/quit-check").then((x) => x.json()).catch(() => ({ warning: null }));
    if (r.warning) { setWarning(r.warning); setState("confirm"); } else void quit(false);
  };
  useEscape(() => setState("idle"), state === "confirm");
  const quit = async (confirmed: boolean) => {
    const r = await fetch("/api/quit", { method: "POST", headers: ui, body: JSON.stringify({ confirmed }) }).catch(() => undefined);
    if (r?.ok) setState("stopped");
  };
  if (state === "stopped") return <div role="alert" className="fixed inset-0 z-50 grid place-items-center bg-bg text-fg-2">Bridge has stopped. Run bridge again to continue.</div>;
  return (
    <>
      <button type="button" onClick={ask} className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-fg-2 hover:bg-surface">Quit</button>
      {state === "confirm" && (
        <div role="alertdialog" aria-modal="true" aria-label="Quit Bridge" className="fixed inset-0 z-40 grid place-items-center bg-black/60">
          <div className="flex max-w-sm flex-col gap-3 rounded-xl border border-line bg-surface p-4">
            <p className="text-[13px] font-semibold">Quit Bridge?</p>
            <p className="text-fg-2">{warning}</p>
            <div className="flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => setState("idle")} className="rounded-md border border-line px-3 py-1 hover:bg-surface-2">Keep running</button>
              <button type="button" onClick={() => quit(true)} className="rounded-md border border-[#b45309] px-3 py-1 text-[#fbbf24] hover:bg-surface-2">Stop agents and quit</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TopBar({ project, section, limits, inbox, onCap, onResume, onPalette }: { onPalette: () => void; inbox: number; project?: Project; section: string; limits: Limits; onCap: (cap: number) => void; onResume: () => void }) {
  return (
    <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-line bg-bg px-5 py-2 text-[13px]">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
        <span className="text-fg-2">{project?.name ?? "Bridge"}</span>
        <span aria-hidden="true" className="text-[#5a5a5a]">/</span>
        <span aria-current="page" className="font-semibold">{section}</span>
      </nav>
      <span className="flex-1" />
      {inbox > 0 && <span className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5"><span className="font-semibold">{inbox}</span><span className="text-fg-3">in Inbox</span></span>}
      {!limits.rateLimited && limits.queued.some((q) => q.error) && (
        <span role="alert" className="inline-flex h-8 items-center gap-2 rounded-lg border border-[#b45309] px-2.5 text-[#fbbf24]">
          <span className="font-semibold">Could not start {limits.queued.filter((q) => q.error).map((q) => q.ticketKey).join(", ")}</span>
          <button type="button" onClick={onResume} className="rounded-md border border-line px-2 py-0.5 text-fg hover:bg-surface">Retry</button>
        </span>
      )}
      {limits.rateLimited && (
        <span role="alert" className="inline-flex h-8 items-center gap-2 rounded-lg border border-[#b45309] px-2.5 text-[#fbbf24]">
          <span className="font-semibold">Rate limit hit</span><span className="text-fg-3">queue paused</span>
          <button type="button" onClick={onResume} className="rounded-md border border-line px-2 py-0.5 text-fg hover:bg-surface">Resume</button>
        </span>
      )}
      {limits.queued.length > 0 && <span className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5"><span className="font-semibold">{limits.queued.length}</span><span className="text-fg-3">queued</span></span>}
      <span className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5">
        <span className="font-semibold">{limits.running}</span><span className="text-fg-3">/</span>
        <select aria-label="Worker cap" value={limits.cap} onChange={(e) => onCap(Number(e.target.value))} className="rounded bg-transparent font-semibold text-fg">
          {Array.from({ length: limits.max }, (_, i) => i + 1).map((n) => <option key={n} value={n} className="bg-bg">{n}</option>)}
        </select>
        <span className="text-fg-3">workers</span>
      </span>
      <button type="button" onClick={onPalette} aria-keyshortcuts="Control+K Meta+K" className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5 text-fg-2 hover:bg-surface">Quick actions<kbd className="font-mono text-[11px] text-fg-3">Ctrl K</kbd></button>
      <QuitButton />
    </header>
  );
}

type Column = "backlog" | "in-progress" | "review" | "done";
interface Blocker { id: string; key: string; column: Column | null; done: boolean }
interface Ticket { id: string; key: string; title: string; status: string; column: Column; agent: string | null; blockers: Blocker[]; blocked: boolean }

const COLUMNS: { id: Column; name: string }[] = [
  { id: "backlog", name: "Backlog" }, { id: "in-progress", name: "In progress" },
  { id: "review", name: "Review" }, { id: "done", name: "Done" },
];
const COLUMN_NAME = Object.fromEntries(COLUMNS.map((c) => [c.id, c.name.toLowerCase()]));

function TicketCard({ t, onMove, agent }: { t: Ticket; onMove: (id: string, c: Column) => void; agent?: AgentInfo }) {
  const open = t.blockers.filter((b) => !b.done);
  const state = t.blocked ? `Blocked by ${open.map((b) => b.key).join(", ")}` : t.status || "no status";
  return (
    <article aria-label={`${t.key}, ${t.title}, ${t.agent ?? "unassigned"}, ${state}`}
      className={`flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3 ${t.blocked ? "opacity-80" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-fg-3">{t.key}</span>
        <span className="flex-1" />
        <select aria-label={`Move ${t.key}`} value={t.column} onChange={(e) => onMove(t.id, e.target.value as Column)}
          className="h-6 rounded-md border border-line bg-surface-2 px-1 text-[11px] text-fg-2">
          {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <h3 className={`text-sm font-medium leading-5 ${t.column === "done" ? "text-fg-2" : "text-fg"}`}>{t.title}</h3>
      {t.blockers.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Blockers">
          {t.blockers.map((b) => (
            <li key={b.id} className={`inline-flex h-[22px] items-center gap-1.5 rounded-md border px-[7px] text-[11px] ${b.done ? "border-dashed border-line text-fg-3" : "border-white/20 text-fg"}`}>
              <span className="font-mono">{b.key}</span>
              <span>{b.done ? "done" : b.column ? COLUMN_NAME[b.column] : "missing"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 pt-0.5 text-xs">
        {t.agent
          ? <>{agent
              ? <AgentAvatar shape={agent.shape ?? "circle"} color={agent.color ?? "#0A84FF"} state={agent.avatarState ?? "idle"} size={20} lead={agent.lead} name={agent.name} />
              : <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-track text-[10px] font-semibold">{t.agent[0]!.toUpperCase()}</span>}<span className="font-semibold">{t.agent}</span></>
          : <><span aria-hidden="true" className="size-5 rounded-full border-[1.5px] border-dashed border-white/25" /><span className="font-semibold text-fg-2">Unassigned</span></>}
        <span className={`min-w-0 truncate ${t.blocked ? "font-medium text-fg" : "text-fg-2"}`}>{state}</span>
      </div>
    </article>
  );
}

function Board({ project, agents }: { project?: Project; agents: AgentInfo[] }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const id = project?.id;
  const load = () => {
    if (!id) return setTickets([]);
    fetch(`/api/projects/${id}/tickets`).then((r) => r.json()).then(setTickets).catch(() => {});
  };
  useEffect(() => {
    load();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (m) => { try { if (JSON.parse(String(m.data)).type === "tickets") load(); } catch { /* ignore */ } };
    return () => ws.close();
  }, [id]);
  const move = (ticket: string, column: Column) => {
    setTickets((ts) => ts.map((t) => (t.id === ticket ? { ...t, column } : t)));
    fetch(`/api/projects/${id}/tickets/status`, { method: "POST", body: JSON.stringify({ ticket, column }) }).then(load).catch(load);
  };
  if (!project) return <div className="grid h-full place-items-center rounded-xl border border-dashed border-line text-fg-3">Run bridge in a repo to see its tickets.</div>;
  if (tickets.length === 0) return <div className="grid h-full place-items-center rounded-xl border border-dashed border-line text-fg-3">No ticket files in .scratch/*/issues yet.</div>;
  return (
    <div className="grid grid-cols-[repeat(4,minmax(220px,1fr))] items-start gap-3 overflow-x-auto pb-1">
      {COLUMNS.map((c) => {
        const cards = tickets.filter((t) => t.column === c.id);
        return (
          <section key={c.id} aria-label={`${c.name}, ${cards.length} tickets`} className="flex min-w-0 flex-col gap-2">
            <header className="flex h-8 items-center gap-2 px-1">
              <h2 className="text-[13px] font-semibold">{c.name}</h2>
              <span className="text-xs text-fg-3">{cards.length}</span>
            </header>
            {cards.map((t) => <TicketCard key={t.id} t={t} onMove={move} agent={agents.find((a) => a.ticketId === t.id || (t.agent != null && a.name === t.agent))} />)}
          </section>
        );
      })}
    </div>
  );
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [pulls, setPulls] = useState<PullInfo[]>([]);
  const [reviews, setReviews] = useState<ReviewInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [section, setSection] = useState("Board");
  const [limits, setLimits] = useState<Limits>({ cap: 2, max: 3, running: 0, rateLimited: null, queued: [] });
  const inbox = useInbox();
  const [adding, setAdding] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [setupTick, setSetupTick] = useState(0);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (isPaletteKey(e)) { e.preventDefault(); setPalette((open) => !open); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const load = () => {
      fetch("/api/projects").then((r) => r.json()).then(setProjects).catch(() => {});
      fetch("/api/active-project").then((r) => r.json()).then((p) => setActiveId(p.id)).catch(() => {});
      fetch("/api/agents").then((r) => r.json()).then(setAgents).catch(() => {});
      fetch("/api/pulls").then((r) => r.json()).then(setPulls).catch(() => {});
      fetch("/api/reviews").then((r) => r.json()).then(setReviews).catch(() => {});
      fetch("/api/limits").then((r) => r.json()).then(setLimits).catch(() => {});
    };
    load();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (m) => { try { const d = JSON.parse(String(m.data)); if (d.type === "agent-event" && d.event?.type === "output") return; } catch { /* reload */ } load(); };
    return () => ws.close();
  }, []);

  const project = projects.find((p) => p.id === activeId) ?? projects[0];
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) { setSetupNeeded(false); return; }
    fetch(`/api/projects/${projectId}/setup`).then((r) => r.json()).then((s) => setSetupNeeded(s.needed === true)).catch(() => {});
  }, [projectId, setupTick]);
  const switchTo = (id: string) => { setActiveId(id); fetch(`/api/projects/${id}/select`, { method: "POST", body: "{}" }).catch(() => {}); };
  const post = (path: string, body: unknown) => fetch(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json()).then(setLimits).catch(() => {});
  const runAction = async (action: string, context: string): Promise<string | null> => {
    if (!project) return "Open a project first.";
    const r = await fetch(`/api/projects/${project.id}/quick-actions`, { method: "POST", body: JSON.stringify({ action, context }) }).catch(() => undefined);
    if (r?.ok) { setSection("Agents"); return null; }
    return (await r?.json().catch(() => undefined))?.error ?? "Could not start the agent.";
  };
  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-fg focus:px-3 focus:py-2 focus:text-bg">Skip to content</a>
      {palette && <CommandPalette sections={NAV} onGo={setSection} onRun={runAction} onClose={() => setPalette(false)} />}
      <Sidebar inbox={inbox.open} lead={agents.find((a) => a.lead) ?? agents[0]} project={project} projects={projects} onSwitch={switchTo} onAdd={() => setAdding(true)} section={section} onSelect={setSection} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar inbox={inbox.open} project={project} section={section} limits={limits} onCap={(cap) => post("/api/limits", { cap })} onResume={() => post("/api/limits/resume", {})} onPalette={() => setPalette(true)} />
        <main id="main" tabIndex={-1} aria-label={section} className="flex-1 overflow-auto p-5 outline-none">
          {adding && <NewProjectDialog onClose={() => setAdding(false)} onOpened={() => setSetupTick((n) => n + 1)} />}
          {project && setupNeeded ? <FirstRunSetup projectId={project.id} projectName={project.name} onDone={() => setSetupTick((n) => n + 1)} /> : section === "Board" ? <Board project={project} agents={agents} /> : section === "Agents" ? <AgentsScreen projectId={project?.id} agents={agents} pulls={pulls} /> : section === "Inbox" ? <InboxScreen agents={agents} items={inbox.items} reload={inbox.reload} /> : section === "Review" ? <ReviewScreen pulls={pulls} reviews={reviews} projectId={project?.id} /> : section === "Plan" ? <PlanScreen projectId={project?.id} /> : section === "Analyst" ? <AnalystScreen projectId={project?.id} /> : (
            <div className="grid h-full place-items-center rounded-xl border border-dashed border-line text-fg-3">Nothing here yet.</div>
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
