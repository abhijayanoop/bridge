import { useEffect, useState } from "react";
import { AgentAvatar } from "./avatar.tsx";

type GateState = "waiting" | "pending" | "approved";
interface PlanTicket {
  id: string; key: string; title: string; column: string; blocked: boolean; agent: string | null;
  blockers: { id: string; key: string; done: boolean }[];
  shape: string | null; color: string | null;
}
export interface FeatureInfo {
  id: string; projectId: string; description: string; slug: string; stage: string;
  suggestedWorkers: number | null; spec: string | null;
  gates: { spec: GateState; tickets: GateState; merge: GateState };
  tickets: PlanTicket[];
}

const GATES: { id: keyof FeatureInfo["gates"]; name: string; hint: Record<GateState, string> }[] = [
  { id: "spec", name: "Spec", hint: { waiting: "The lead is grilling you and writing the spec", pending: "Waiting for you in the Inbox", approved: "Approved" } },
  { id: "tickets", name: "Tickets", hint: { waiting: "After the spec is approved", pending: "Waiting for you in the Inbox", approved: "Approved" } },
  { id: "merge", name: "Merge", hint: { waiting: "After the tickets are approved", pending: "You merge each pull request", approved: "Every ticket is merged" } },
];
const GATE_CLASS: Record<GateState, string> = {
  waiting: "border-dashed border-line text-fg-3", pending: "border-[#b45309] text-[#fbbf24]", approved: "border-line text-fg",
};

function Gates({ gates }: { gates: FeatureInfo["gates"] }) {
  return (
    <ol aria-label="Gates" className="flex flex-wrap gap-2">
      {GATES.map((g, i) => (
        <li key={g.id} aria-label={`${g.name} gate: ${gates[g.id]}`} className={`flex min-w-[180px] flex-1 flex-col gap-0.5 rounded-xl border px-3 py-2 ${GATE_CLASS[gates[g.id]]}`}>
          <span className="text-[13px] font-semibold">{i + 1}. {g.name}</span>
          <span className="text-xs">{g.hint[gates[g.id]]}</span>
        </li>
      ))}
    </ol>
  );
}

function TicketRow({ t }: { t: PlanTicket }) {
  return (
    <li className={`flex items-center gap-3 rounded-lg border border-line px-3 py-2 ${t.column === "done" ? "opacity-60" : ""}`}>
      {t.shape && t.color
        ? <AgentAvatar shape={t.shape} color={t.color} state="idle" size={24} name={`Worker for ${t.key}`} />
        : <span aria-hidden="true" className="size-6 flex-none rounded-full border-[1.5px] border-dashed border-white/25" />}
      <span className="font-mono text-xs text-fg-3">{t.key}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.title}</span>
      {t.blockers.length > 0
        ? <span className="text-xs text-fg-2">after {t.blockers.map((b) => `${b.key}${b.done ? " (done)" : ""}`).join(", ")}</span>
        : <span className="text-xs text-fg-3">no blockers</span>}
      <span className="flex-none rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-2">{t.column}</span>
    </li>
  );
}

/** Tickets in waves: wave 1 has no blockers, each later wave waits on the one before, so the dependencies read top to bottom. */
function waves(tickets: PlanTicket[]): PlanTicket[][] {
  const level = new Map<string, number>();
  const depth = (t: PlanTicket, seen: Set<string>): number => {
    if (level.has(t.id)) return level.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const parents = t.blockers.map((b) => tickets.find((x) => x.id === b.id)).filter((x): x is PlanTicket => !!x);
    const n = parents.length ? 1 + Math.max(...parents.map((p) => depth(p, seen))) : 0;
    level.set(t.id, n);
    return n;
  };
  const out: PlanTicket[][] = [];
  for (const t of tickets) (out[depth(t, new Set())] ??= []).push(t);
  return out.filter(Boolean);
}

function FeaturePlan({ f }: { f: FeatureInfo }) {
  return (
    <article aria-label={`Plan: ${f.description}`} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-base font-semibold">{f.description}</h2>
        <span className="font-mono text-xs text-fg-3">.scratch/{f.slug}</span>
        {f.suggestedWorkers && <span className="ml-auto text-xs text-fg-2">Lead suggests {f.suggestedWorkers} worker{f.suggestedWorkers === 1 ? "" : "s"}</span>}
      </header>
      <Gates gates={f.gates} />
      <section aria-label="Spec" className="flex flex-col gap-1.5">
        <h3 className="text-[13px] font-semibold">Spec</h3>
        {f.spec
          ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 text-xs text-fg-2">{f.spec}</pre>
          : <p className="text-xs text-fg-3">Not written yet. Answer the lead's questions in the Inbox.</p>}
      </section>
      <section aria-label="Tickets" className="flex flex-col gap-1.5">
        <h3 className="text-[13px] font-semibold">Tickets <span className="font-normal text-fg-3">{f.tickets.length}</span></h3>
        {f.tickets.length === 0 && <p className="text-xs text-fg-3">None yet. The lead slices the spec once you approve it.</p>}
        {waves(f.tickets).map((w, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-fg-3">{i === 0 ? "Start here" : `Then (wave ${i + 1})`}</span>
            <ul className="flex flex-col gap-1.5">{w.map((t) => <TicketRow key={t.id} t={t} />)}</ul>
          </div>
        ))}
      </section>
    </article>
  );
}

/** The Plan screen: describe a feature to start the lead, then follow its spec, tickets and gates. */
export function PlanScreen({ projectId }: { projectId?: string }) {
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    if (!projectId) return setFeatures([]);
    fetch(`/api/projects/${projectId}/features`).then((r) => r.json()).then(setFeatures).catch(() => {});
  };
  useEffect(() => {
    load();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (m) => { try { const d = JSON.parse(String(m.data)); if (d.type === "feature" || d.type === "tickets") load(); } catch { /* ignore */ } };
    return () => ws.close();
  }, [projectId]);
  if (!projectId) return <div className="grid h-full place-items-center rounded-xl border border-dashed border-line text-fg-3">Run bridge in a repo to plan a feature.</div>;
  const start = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    fetch(`/api/projects/${projectId}/features`, { method: "POST", body: JSON.stringify({ description: text }) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? "could not start"); setText(""); load(); })
      .catch((err: Error) => setError(err.message));
  };
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={start} className="flex flex-wrap items-center gap-2">
        <label htmlFor="feature-text" className="sr-only">Describe a feature</label>
        <input id="feature-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe a feature for the lead to plan"
          className="h-9 min-w-[260px] flex-1 rounded-lg border border-line bg-surface px-3 text-[13px] text-fg placeholder:text-fg-3" />
        <button type="submit" disabled={!text.trim()} className="h-9 rounded-lg bg-fg px-3 text-[13px] font-semibold text-bg disabled:opacity-40">Start planning</button>
        {error && <span role="alert" className="text-xs text-[#fca5a5]">{error}</span>}
      </form>
      {features.length === 0 && <div className="grid place-items-center rounded-xl border border-dashed border-line py-16 text-fg-3">No feature planned yet. Describe one above and the lead will grill you.</div>}
      {[...features].reverse().map((f) => <FeaturePlan key={f.id} f={f} />)}
    </div>
  );
}
