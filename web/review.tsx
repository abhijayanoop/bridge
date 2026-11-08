import { useState } from "react";

export interface PullInfo {
  id: string; agentId: string; projectId: string; ticketKey: string; title: string; branch: string;
  url: string; number: number; state: "open" | "merged" | "closed"; createdAt: number;
  /** No GitHub remote: the branch is merged locally on approval. */
  local?: boolean;
}

/** Only ever link to GitHub over https, whatever the server sent. */
export const safeUrl = (url: string) => (/^https:\/\/[^\s]+$/.test(url) ? url : undefined);

const linkClass = "inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px] font-medium text-fg hover:bg-surface-2";

/** Compact link shown on an agent's row once its pull request is open. */
export function PullChip({ pull }: { pull: PullInfo }) {
  const href = safeUrl(pull.url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={`Open pull request ${pull.number} on GitHub`} className={`${linkClass} my-2 flex-none self-center`}>
      PR #{pull.number}
    </a>
  );
}

const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

/**
 * The Merge control. It takes two deliberate presses, and is the only way Bridge ever merges: agents have no
 * tool for it, and their own merge commands are refused.
 */
function MergeButton({ pull }: { pull: PullInfo }) {
  const [step, setStep] = useState<"idle" | "confirm" | "merging">("idle");
  const [error, setError] = useState("");
  const merge = async () => {
    setStep("merging"); setError("");
    try {
      const r = await fetch(`/api/pulls/${pull.id}/merge`, { method: "POST", body: "{}" });
      if (!r.ok) setError(String(((await r.json()) as { error?: string }).error ?? "Merge failed"));
    } catch { setError("Could not reach Bridge"); }
    setStep("idle");
  };
  const what = pull.local ? "Merge locally" : "Merge";
  return (
    <span className="flex flex-none flex-col items-end gap-1">
      {step === "idle" && <button type="button" onClick={() => setStep("confirm")} className={linkClass}>{what}</button>}
      {step === "confirm" && (
        <span className="flex items-center gap-2">
          <span className="text-xs text-fg-2">{pull.local ? `Merge ${pull.branch} into your checked-out branch?` : `Merge pull request #${pull.number}?`}</span>
          <button type="button" onClick={merge} className="inline-flex h-8 items-center rounded-lg bg-fg px-3 text-[13px] font-semibold text-bg">Confirm merge</button>
          <button type="button" onClick={() => setStep("idle")} className={linkClass}>Cancel</button>
        </span>
      )}
      {step === "merging" && <span className="text-xs text-fg-2">Merging…</span>}
      {error && <span role="alert" className="max-w-sm text-right text-xs text-[#fbbf24]">{error}</span>}
    </span>
  );
}

/** Pull requests Bridge opened, and branches of repos with no GitHub remote. Merging is your button alone. */
export function ReviewScreen({ pulls, projectId }: { pulls: PullInfo[]; projectId?: string }) {
  const mine = pulls.filter((p) => !projectId || p.projectId === projectId);
  if (mine.length === 0) {
    return <div className="grid h-40 place-items-center rounded-xl border border-dashed border-line text-fg-3">No pull requests yet. One opens when an agent finishes its ticket.</div>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {mine.map((p) => {
        const href = safeUrl(p.url);
        return (
          <li key={p.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-semibold">{p.title}</span>
              <span className="truncate text-xs text-fg-2">{p.local ? "local branch" : `#${p.number}`} · {p.branch} · {ago(p.createdAt)}</span>
            </span>
            <span className="flex-none rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-2">{p.state}</span>
            {href && <a href={href} target="_blank" rel="noreferrer" className={linkClass}>Open on GitHub</a>}
            {p.state === "open" && <MergeButton pull={p} />}
          </li>
        );
      })}
    </ul>
  );
}
