import { randomUUID } from "node:crypto";
import type { Approval, ApprovalScope, InboxItem } from "./db.ts";

export const SCOPES: readonly ApprovalScope[] = ["once", "ticket", "project"];

/** The sandbox's network allow-list. `add` returns true only when the rule was not already there. */
export interface NetworkRules { add(domain: string): boolean; remove(domain: string): void }

interface Persistence {
  addApproval(a: Approval): void;
  approval(id: string): Approval | undefined;
  approvals(): Approval[];
  updateApproval(a: Approval): void;
}

/** Plain JavaScript so the same check can be written into the agent's hook script. */
export const MERGE_CHECK_SOURCE = `(command) => command.split(/&&|\\|\\||[;&|\\n]/).some((part) => /^\\s*(?:git(?:\\s+-C\\s+\\S+)?\\s+merge|gh\\s+pr\\s+merge)\\b/.test(part))`;
/** True for commands that merge: agents may never do this, the user merges. */
export const isMergeCommand: (command: string) => boolean = new Function(`return (${MERGE_CHECK_SOURCE})`)();

/**
 * Remembers what the user allowed. Once approvals are only recorded; ticket and project approvals are
 * reused for the same request until undone. Network rules are added for reused domain grants and
 * removed again only if Bridge was the one that added them.
 */
export function createApprovals(store: Persistence, rules: NetworkRules) {
  const active = (domain: string) => store.approvals().filter((a) => !a.revokedAt && a.access === "domain" && a.detail === domain && a.scope !== "once");
  return {
    list: () => store.approvals(),
    /** An active ticket or project approval that already covers this request. */
    covering(projectId: string, ticketKey: string | null, access: string, detail: string): Approval | undefined {
      return store.approvals().find((a) => !a.revokedAt && a.projectId === projectId && a.access === access && a.detail === detail
        && (a.scope === "project" || (a.scope === "ticket" && a.ticketKey === ticketKey)));
    },
    /** Records the approval of an access request. Returns null when the scope cannot apply. */
    grant(item: InboxItem, scope: ApprovalScope): Approval | null {
      if (scope === "ticket" && !item.ticketKey) return null;
      const reused = scope !== "once";
      const domain = item.access === "domain" && reused;
      const owner = domain && active(item.detail ?? "").some((a) => a.ownsRule);
      const a: Approval = {
        id: randomUUID(), projectId: item.projectId, ticketKey: scope === "ticket" ? item.ticketKey ?? null : null,
        access: item.access ?? "", detail: item.detail ?? "", scope, createdAt: Date.now(), revokedAt: null,
        ownsRule: domain && !owner && rules.add(item.detail ?? ""),
      };
      store.addApproval(a);
      return a;
    },
    /** Undoes an approval. Null if unknown or already undone. */
    revoke(id: string): Approval | null {
      const a = store.approval(id);
      if (!a || a.revokedAt) return null;
      const revoked = { ...a, revokedAt: Date.now() };
      store.updateApproval(revoked);
      if (a.ownsRule) {
        const rest = active(a.detail);
        const heir = rest[0];
        if (heir) store.updateApproval({ ...heir, ownsRule: true });
        else rules.remove(a.detail);
      }
      return revoked;
    },
  };
}
