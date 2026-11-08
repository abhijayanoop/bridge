import { useState } from "react";

export interface PullInfo {
  id: string; agentId: string; projectId: string; ticketKey: string; title: string; branch: string;
  url: string; number: number; state: "open" | "merged" | "closed"; createdAt: number;
  /** No GitHub remote: the branch is merged locally on approval. */
  local?: boolean;
}

/** Only ever link to GitHub over https, whatever the server sent. */
export const safeUrl = (url: string) => (/^https:\/\/[^\s]+$/.test(url) ? url : undefined);

export interface FindingInfo { axis: "standards" | "spec"; severity: "high" | "medium" | "low"; summary: string; file?: string; line?: number }
export interface ReviewInfo {
  id: string; agentId: string; projectId: string; ticketKey: string; ticketTitle: string; branch: string; round: number;
  status: "running" | "passed" | "changes-requested" | "unresolved" | "failed";
  findings: FindingInfo[]; reason?: string; createdAt: number;
}

const STATUS_TEXT: Record<ReviewInfo["status"], string> = {
  running: "Reviewing…", passed: "Passed", "changes-requested": "Sent back to the author",
  unresolved: "Still open: needs your judgement", failed: "Review could not run",
};
const SEVERITY_CLASS: Record<FindingInfo["severity"], string> = {
  high: "border-[#b91c1c] text-[#fca5a5]", medium: "border-[#b45309] text-[#fbbf24]", low: "border-line text-fg-2",
};

function FindingColumn({ title, findings }: { title: string; findings: FindingInfo[] }) {
  return (
    <section aria-label={`${title} findings, ${findings.length}`} className="flex min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-[13px] font-semibold">{title} <span className="font-normal text-fg-3">{findings.length}</span></h3>
      {findings.length === 0 && <p className="text-xs text-fg-3">No findings.</p>}
      {findings.map((f, i) => (
        <div key={i} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2">
          <span className={`mt-0.5 flex-none rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${SEVERITY_CLASS[f.severity]}`}>{f.severity}</span>
          <span className="min-w-0 text-[13px]">
            {f.summary}
            {f.file && <span className="block truncate text-xs text-fg-3">{f.file}{f.line ? `:${f.line}` : ""}</span>}
          </span>
        </div>
      ))}
    </section>
  );
}

/** The latest review of each ticket: findings split into Standards and Spec, most severe first. Older rounds are one line each. */
function ReviewCard({ review, earlier }: { review: ReviewInfo; earlier: ReviewInfo[] }) {
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-semibold">{review.ticketKey}: {review.ticketTitle}</span>
        <span className="text-xs text-fg-2">Round {review.round}</span>
        <span className="flex-none rounded-full border border-line px-2.5 py-0.5 text-xs text-fg-2">{STATUS_TEXT[review.status]}</span>
      </div>
      {review.reason && <p role="alert" className="text-xs text-[#fbbf24]">{review.reason}</p>}
      {review.status !== "running" && review.status !== "failed" && (
        <div className="flex flex-col gap-3 md:flex-row">
          <FindingColumn title="Standards" findings={review.findings.filter((f) => f.axis === "standards")} />
          <FindingColumn title="Spec" findings={review.findings.filter((f) => f.axis === "spec")} />
        </div>
      )}
      {earlier.map((e) => <p key={e.id} className="text-xs text-fg-3">Round {e.round}: {STATUS_TEXT[e.status].toLowerCase()}, {e.findings.length} findings</p>)}
    </li>
  );
}

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
      const r = await fetch(`/api/pulls/${pull.id}/merge`, { method: "POST", headers: { "x-bridge-ui": "1" }, body: "{}" });
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
export function ReviewScreen({ pulls, reviews = [], projectId }: { pulls: PullInfo[]; reviews?: ReviewInfo[]; projectId?: string }) {
  const mine = pulls.filter((p) => !projectId || p.projectId === projectId);
  const mineReviews = reviews.filter((r) => !projectId || r.projectId === projectId);
  // Newest first: the first review seen for an agent is its latest round.
  const latest = mineReviews.filter((r, i) => mineReviews.findIndex((x) => x.agentId === r.agentId) === i);
  if (mine.length === 0 && latest.length === 0) {
    return <div className="grid h-40 place-items-center rounded-xl border border-dashed border-line text-fg-3">No pull requests yet. One opens when an agent finishes its ticket.</div>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {latest.map((r) => <ReviewCard key={r.id} review={r} earlier={mineReviews.filter((x) => x.agentId === r.agentId && x.id !== r.id)} />)}
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
