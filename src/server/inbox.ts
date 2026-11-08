import { randomUUID } from "node:crypto";
import type { InboxItem } from "./db.ts";

export type Decision = "approve" | "deny" | "reply";
export interface Answer { decision: Decision; reply?: string }

export type NewInboxItem = Pick<InboxItem, "agentId" | "projectId" | "kind" | "what"> &
  Partial<Pick<InboxItem, "access" | "detail" | "why" | "facts" | "ticketKey">>;

interface Persistence {
  addInbox(item: InboxItem): void;
  inboxItem(id: string): InboxItem | undefined;
  inboxItems(): InboxItem[];
  updateInbox(item: InboxItem): void;
}

/**
 * Things that need the user. `raise` stores an item and returns a promise that settles when the user
 * approves, denies or replies, so a tool call can simply await it. One-off decisions only.
 */
export function createInbox(store: Persistence, onChange: (item: InboxItem, open: number) => void) {
  const waiting = new Map<string, (a: Answer) => void>();
  const open = () => store.inboxItems().filter((i) => i.status === "open").length;
  return {
    list: () => store.inboxItems(),
    open,
    raise(input: NewInboxItem): { item: InboxItem; answer: Promise<Answer> } {
      const item: InboxItem = {
        why: "", facts: [], access: null, ticketKey: null, ...input,
        id: randomUUID(), createdAt: Date.now(), status: "open", decision: null, reply: null, resolvedAt: null,
      };
      store.addInbox(item);
      const answer = new Promise<Answer>((resolve) => waiting.set(item.id, resolve));
      onChange(item, open());
      return { item, answer };
    },
    /** Records the user's answer and wakes the waiting agent. Null if unknown or already resolved. */
    resolve(id: string, answer: Answer): InboxItem | null {
      const item = store.inboxItem(id);
      if (!item || item.status !== "open") return null;
      const done: InboxItem = { ...item, status: "resolved", decision: answer.decision, reply: answer.reply ?? null, resolvedAt: Date.now() };
      store.updateInbox(done);
      waiting.get(id)?.(answer);
      waiting.delete(id);
      onChange(done, open());
      return done;
    },
  };
}
