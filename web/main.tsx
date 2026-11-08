import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Project { id: string; name: string; path: string }
interface Agent { id: string; name: string; status: string }

const NAV = ["Board", "Agents", "Inbox", "Plan", "Review"];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" className="flex-none fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Sidebar({ project, projects, section, onSelect, onSwitch }: { project?: Project; projects: Project[]; section: string; onSelect: (s: string) => void; onSwitch: (id: string) => void }) {
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
        </ul>
      )}
      <span className="mt-5 px-2.5 pb-1 text-[11px] font-medium text-fg-3">Workspace</span>
      {NAV.map((n) => (
        <button key={n} type="button" aria-current={n === section ? "page" : undefined} onClick={() => onSelect(n)}
          className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left font-medium ${n === section ? "bg-surface-2 text-fg" : "text-fg-2 hover:bg-surface"}`}>
          <Icon d="M4 6h16M4 12h16M4 18h16" />
          <span className="flex-1">{n}</span>
        </button>
      ))}
    </nav>
  );
}

function TopBar({ project, section, workers }: { project?: Project; section: string; workers: number }) {
  return (
    <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-line bg-bg px-5 py-2 text-[13px]">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
        <span className="text-fg-2">{project?.name ?? "Bridge"}</span>
        <span aria-hidden="true" className="text-[#5a5a5a]">/</span>
        <span aria-current="page" className="font-semibold">{section}</span>
      </nav>
      <span className="flex-1" />
      <span className="inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5">
        <span className="font-semibold">{workers}</span><span className="text-fg-3">/ 2 workers</span>
      </span>
    </header>
  );
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [section, setSection] = useState("Board");

  useEffect(() => {
    const load = () => {
      fetch("/api/projects").then((r) => r.json()).then(setProjects).catch(() => {});
      fetch("/api/active-project").then((r) => r.json()).then((p) => setActiveId(p.id)).catch(() => {});
      fetch("/api/agents").then((r) => r.json()).then(setAgents).catch(() => {});
    };
    load();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = load;
    return () => ws.close();
  }, []);

  const project = projects.find((p) => p.id === activeId) ?? projects[0];
  const switchTo = (id: string) => { setActiveId(id); fetch(`/api/projects/${id}/select`, { method: "POST", body: "{}" }).catch(() => {}); };
  const working = agents.filter((a) => a.status === "working").length;
  return (
    <div className="flex h-full">
      <Sidebar project={project} projects={projects} onSwitch={switchTo} section={section} onSelect={setSection} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar project={project} section={section} workers={working} />
        <main className="flex-1 overflow-auto p-5">
          {agents.length === 0 ? (
            <div className="grid h-full place-items-center rounded-xl border border-dashed border-line text-fg-3">Nothing here yet. Agents will appear as they start.</div>
          ) : (
            <ul className="flex flex-col gap-2">
              {agents.map((a) => (
                <li key={a.id} className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
                  <span className="font-semibold">{a.name}</span>
                  <span className="font-mono text-xs text-fg-2">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
