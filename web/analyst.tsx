import { useEffect, useState } from "react";
import { AgentAvatar } from "./avatar.tsx";

const field = "h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg";
const primary = "h-9 rounded-lg bg-fg px-3 text-[13px] font-semibold text-bg disabled:opacity-50";
const secondary = "h-9 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 hover:bg-surface";

interface Connection { id: string; kind: "postgres" | "mongodb"; label: string; enabled: boolean; maskingOn: boolean }
interface Step { title: string; where: string; run: string }

const json = (r: Response) => r.json().catch(() => ({}));
const send = (method: string, url: string, body?: unknown) =>
  fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, json: await json(r) }));

/** The one-time guided setup of a read-only role, then saving the connection. Bridge runs none of the steps itself. */
function AddConnection({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<"postgres" | "mongodb">("postgres");
  const [database, setDatabase] = useState("");
  const [role, setRole] = useState("bridge_analyst");
  const [tables, setTables] = useState("");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [label, setLabel] = useState("");
  const [connectionString, setConnectionString] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSteps(null); }, [kind, database, role, tables]);

  const preview = async () => {
    setError("");
    const list = tables.split(",").map((t) => t.trim()).filter(Boolean);
    const r = await send("POST", `/api/projects/${projectId}/connections/role-setup`, { kind, database, role, tables: kind === "postgres" && list.length ? list : undefined });
    if (r.ok) setSteps(r.json.steps); else setError(r.json.error ?? "Could not prepare the steps.");
  };
  const save = async () => {
    setBusy(true); setError("");
    const r = await send("POST", `/api/projects/${projectId}/connections`, { kind, label, connectionString });
    setBusy(false);
    if (r.ok) { setConnectionString(""); onSaved(); onClose(); } else setError(r.json.error ?? "Could not save the connection.");
  };
  return (
    <div role="dialog" aria-label="Add a database connection" className="fixed inset-0 z-20 grid place-items-center overflow-auto bg-black/40 p-4">
      <div className="flex w-[34rem] max-w-full flex-col gap-3 rounded-xl border border-line bg-bg p-5">
        <h2 className="text-base font-semibold">Connect a database, read-only</h2>
        <p className="text-fg-2">Step 1. Create a role that can only read. You run the steps yourself with your own admin access; Bridge never sees an admin password.</p>
        <div className="flex gap-2">
          <label className="flex flex-col gap-1">Database type
            <select aria-label="Database type" className={field} value={kind} onChange={(e) => setKind(e.target.value as "postgres" | "mongodb")}>
              <option value="postgres">Postgres or Supabase</option><option value="mongodb">MongoDB</option>
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1">Database name<input aria-label="Database name" className={field} value={database} onChange={(e) => setDatabase(e.target.value)} /></label>
          <label className="flex flex-1 flex-col gap-1">Role name<input aria-label="Role name" className={field} value={role} onChange={(e) => setRole(e.target.value)} /></label>
        </div>
        {kind === "postgres" && <label className="flex flex-col gap-1">Tables it may read (comma separated; empty means the public schema)<input aria-label="Tables" className={field} value={tables} onChange={(e) => setTables(e.target.value)} /></label>}
        {steps ? (
          <ol className="flex flex-col gap-2">
            {steps.map((s, i) => (
              <li key={s.title} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3">
                <span className="text-[13px] font-semibold">{i + 1}. {s.title}</span>
                <span className="text-xs text-fg-3">In {s.where}</span>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{s.run}</pre>
              </li>
            ))}
          </ol>
        ) : (
          <button type="button" className={primary} disabled={!database || !role} onClick={preview}>Show me the steps</button>
        )}
        {steps && (
          <>
            <p className="text-fg-2">Step 2. Paste the read-only connection string. It is kept in a file on this computer, never in the sandbox.</p>
            <label className="flex flex-col gap-1">Name for this connection<input aria-label="Connection name" className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="shop" /></label>
            <label className="flex flex-col gap-1">Connection string<input aria-label="Connection string" type="password" autoComplete="off" className={field} value={connectionString} onChange={(e) => setConnectionString(e.target.value)} /></label>
            <button type="button" className={primary} disabled={busy || !label || !connectionString} onClick={save}>Test and save</button>
          </>
        )}
        {error && <p role="alert" className="text-[13px] text-red-500">{error}</p>}
        <button type="button" className={secondary} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** Connections, the per-connection switches, and starting the Analyst. The Analyst stays off until a connection is enabled. */
export function AnalystScreen({ projectId }: { projectId?: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [ready, setReady] = useState(false);
  const [adding, setAdding] = useState(false);
  const [question, setQuestion] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    if (!projectId) return;
    fetch(`/api/projects/${projectId}/connections`).then(json).then((d) => { setConnections(d.connections ?? []); setReady(d.analystReady === true); }).catch(() => {});
  };
  useEffect(() => {
    load();
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (m) => { try { if (JSON.parse(String(m.data)).type === "connections") load(); } catch { /* ignore */ } };
    return () => ws.close();
  }, [projectId]);

  if (!projectId) return <div className="grid h-full place-items-center rounded-xl border border-dashed border-line text-fg-3">Open a project first.</div>;
  const patch = (c: Connection, change: Partial<Connection>) => send("POST", `/api/connections/${c.id}`, change).then(load);
  const remove = (c: Connection) => { if (confirm(`Remove ${c.label} and its stored credential?`)) void send("DELETE", `/api/connections/${c.id}`).then(load); };
  const start = async () => {
    setError(""); setMessage("");
    const r = await send("POST", `/api/projects/${projectId}/analyst`, { question });
    if (r.ok) { setMessage(r.json.warning ?? "The Analyst has started. Approve its dataset requests in the Inbox."); setQuestion(""); } else setError(r.json.error ?? "Could not start the Analyst.");
  };

  return (
    <section aria-label="Analyst" className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
        <AgentAvatar shape="cloud" color="#FF9500" state="idle" size={48} name="Analyst" />
        <div className="flex flex-1 flex-col gap-0.5">
          <h2 className="text-base font-semibold">Analyst</h2>
          <p className="text-fg-2">Reads your real data to answer questions. It can never write, and it never sees who a person is.</p>
        </div>
        <span className="rounded-full border border-line px-2.5 py-1 text-xs text-fg-2">Read-only · Names masked</span>
      </div>

      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-[13px] font-semibold">Database connections</h3>
        <button type="button" className={secondary} onClick={() => setAdding(true)}>Add a connection</button>
      </div>
      {connections.length === 0 ? (
        <div className="grid place-items-center rounded-xl border border-dashed border-line p-8 text-center text-fg-3">
          The Analyst is off. Add a read-only database connection and switch it on to enable it.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <li key={c.id} aria-label={`${c.label}, ${c.kind}, ${c.enabled ? "enabled" : "off"}`} className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface p-3">
              <span className="flex min-w-0 flex-1 flex-col"><span className="font-semibold">{c.label}</span><span className="text-xs text-fg-3">{c.kind === "postgres" ? "Postgres or Supabase" : "MongoDB"}</span></span>
              <label className="flex items-center gap-2"><input type="checkbox" checked={c.enabled} onChange={(e) => patch(c, { enabled: e.target.checked })} /> Enabled</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={c.maskingOn} onChange={(e) => patch(c, { maskingOn: e.target.checked })} /> Mask names and identifiers</label>
              <button type="button" className={secondary} onClick={() => remove(c)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {connections.some((c) => c.enabled && !c.maskingOn) && <p role="status" className="text-[13px] text-[#fbbf24]">Masking is off for an enabled connection: the Analyst will see real names and identifiers.</p>}

      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <label className="flex flex-col gap-1 text-[13px] font-semibold">What do you want to know?
          <textarea aria-label="Question for the Analyst" className="min-h-16 rounded-lg border border-line bg-bg p-2.5 font-normal text-fg" value={question} onChange={(e) => setQuestion(e.target.value)} disabled={!ready} />
        </label>
        <div className="flex items-center gap-3">
          <button type="button" className={primary} disabled={!ready} onClick={start}>Start the Analyst</button>
          {!ready && <span className="text-fg-3">Enable a connection first.</span>}
        </div>
        <p className="text-xs text-fg-3">Each table it wants to read appears in the Inbox for your approval, once or for the whole project.</p>
        {message && <p role="status" className="text-[13px] text-fg-2">{message}</p>}
        {error && <p role="alert" className="text-[13px] text-red-500">{error}</p>}
      </div>
      {adding && <AddConnection projectId={projectId} onClose={() => setAdding(false)} onSaved={load} />}
    </section>
  );
}
