import { useEscape } from "./a11y.ts";
import { useEffect, useState } from "react";

const ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"];
const field = "h-9 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg";
const primary = "h-9 rounded-lg bg-fg px-3 text-[13px] font-semibold text-bg disabled:opacity-50";
const secondary = "h-9 rounded-lg border border-line px-3 text-[13px] font-medium text-fg-2 hover:bg-surface";

/** Guided setup shown the first time a repo is opened; skipped once done. */
export function FirstRunSetup({ projectId, projectName, onDone }: { projectId: string; projectName: string; onDone: () => void }) {
  const [tracker, setTracker] = useState<"local" | "github">("local");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError("");
    const r = await fetch(`/api/projects/${projectId}/setup`, { method: "POST", body: JSON.stringify({ tracker, labels }) }).catch(() => null);
    setBusy(false);
    if (r?.ok) onDone(); else setError("Setup failed. Check that the repo folder is writable.");
  };
  return (
    <section aria-label="First-run setup" className="mx-auto flex max-w-xl flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-base font-semibold">Set up {projectName}</h2>
      <p className="text-fg-2">Bridge configures the skills' tracker, labels and docs layout once. It adds docs/agents/ and a pointer in CLAUDE.md, and never overwrites files that exist.</p>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[13px] font-semibold">Where do issues live?</legend>
        <label className="flex items-center gap-2"><input type="radio" name="tracker" checked={tracker === "local"} onChange={() => setTracker("local")} /> Local markdown files in .scratch/</label>
        <label className="flex items-center gap-2"><input type="radio" name="tracker" checked={tracker === "github"} onChange={() => setTracker("github")} /> GitHub issues</label>
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[13px] font-semibold">Triage labels</legend>
        {ROLES.map((r) => (
          <label key={r} className="flex items-center gap-2"><span className="w-36 font-mono text-xs text-fg-3">{r}</span>
            <input aria-label={`Label for ${r}`} className={field} placeholder={r} value={labels[r] ?? ""} onChange={(e) => setLabels({ ...labels, [r]: e.target.value })} />
          </label>
        ))}
      </fieldset>
      {error && <p role="alert" className="text-[13px] text-red-500">{error}</p>}
      <div className="flex gap-2"><button type="button" className={primary} disabled={busy} onClick={submit}>Set up repo</button></div>
    </section>
  );
}

/** Open the current folder, open a path, or create a new repo after approving the plan. */
export function NewProjectDialog({ onClose, onOpened }: { onClose: () => void; onOpened: () => void }) {
  useEscape(onClose);
  const [mode, setMode] = useState<"path" | "create">("path");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [github, setGithub] = useState(false);
  const [plan, setPlan] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { setPlan(null); }, [name, parent, github, mode]);

  const post = (url: string, body: unknown) => fetch(url, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ ok: r.ok, json: await r.json().catch(() => ({})) }));
  const open = async (target: string) => {
    setError("");
    const r = await post("/api/projects/open", { path: target });
    if (r.ok) { onOpened(); onClose(); } else setError(r.json.error ?? "Could not open that folder.");
  };
  const review = async () => {
    setError("");
    const r = await post("/api/projects/new", { name, parent, github });
    if (r.ok) setPlan(r.json.steps); else setError(r.json.error ?? "Could not plan the project.");
  };
  const create = async () => {
    const r = await post("/api/projects/new", { name, parent, github, approved: true });
    if (!r.ok) return setError(r.json.error ?? "Could not create the project.");
    if (r.json.github && !r.json.github.ok) { setNote(`Created locally. GitHub repo not created: ${r.json.github.reason}`); onOpened(); return; }
    onOpened(); onClose();
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="New project" className="fixed inset-0 z-20 grid place-items-center bg-black/40">
      <div className="flex w-[28rem] flex-col gap-3 rounded-xl border border-line bg-bg p-5">
        <h2 className="text-base font-semibold">Add a project</h2>
        <div role="tablist" className="flex gap-1">
          <button type="button" role="tab" aria-selected={mode === "path"} className={secondary} onClick={() => setMode("path")}>Open a folder</button>
          <button type="button" role="tab" aria-selected={mode === "create"} className={secondary} onClick={() => setMode("create")}>Create new</button>
        </div>
        {mode === "path" ? (
          <>
            <label className="flex flex-col gap-1">Repo path (use . for where Bridge was started)<input aria-label="Repo path" className={field} value={path} onChange={(e) => setPath(e.target.value)} /></label>
            <div className="flex gap-2"><button type="button" className={primary} disabled={!path} onClick={() => open(path)}>Open</button><button type="button" className={secondary} onClick={() => open(".")}>Use current folder</button></div>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">Project name<input aria-label="Project name" className={field} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="flex flex-col gap-1">Parent folder<input aria-label="Parent folder" className={field} value={parent} onChange={(e) => setParent(e.target.value)} /></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} /> Also create a private GitHub repo</label>
            {plan ? (
              <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
                <span className="text-[13px] font-semibold">Bridge will:</span>
                <ul className="list-disc pl-5">{plan.map((s) => <li key={s}>{s}</li>)}</ul>
                <button type="button" className={primary} onClick={create}>Approve and create</button>
              </div>
            ) : (
              <button type="button" className={primary} disabled={!name || !parent} onClick={review}>Review plan</button>
            )}
          </>
        )}
        {error && <p role="alert" className="text-[13px] text-red-500">{error}</p>}
        {note && <p role="status" className="text-[13px] text-fg-2">{note}</p>}
        <button type="button" className={secondary} onClick={onClose}>{note ? "Close" : "Cancel"}</button>
      </div>
    </div>
  );
}
