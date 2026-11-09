import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PALETTE, SHAPE_KEYS, type Identity } from "../shared/avatar.ts";
import type { Ticket } from "./tickets.ts";

/**
 * grill: the lead questions the user and writes the spec. spec-gate: waiting for the user to approve it.
 * tickets: spec approved, the lead slices it. tickets-gate: waiting for the user to approve the breakdown.
 * build: both gates approved, workers may run.
 */
export const STAGES = ["grill", "spec-gate", "tickets", "tickets-gate", "build"] as const;
export type Stage = (typeof STAGES)[number];

/** A lead-chosen look for the worker that will build one ticket. */
export type Look = Identity;

export interface Feature {
  id: string; projectId: string; description: string;
  /** Folder name under .scratch: the spec is `.scratch/<slug>/spec.md`, tickets are in `.scratch/<slug>/issues`. */
  slug: string;
  stage: Stage; leadAgentId: string | null;
  /** The Inbox item that is currently deciding a gate. */
  gateItemId: string | null;
  suggestedWorkers: number | null;
  /** Ticket key (the NN prefix) to the shape and colour the lead picked. */
  looks: Record<string, Look>;
  createdAt: number;
}

export type GateState = "waiting" | "pending" | "approved";
export interface Gates { spec: GateState; tickets: GateState; merge: GateState }

interface Persistence {
  features(): Feature[];
  addFeature(f: Feature): void;
  updateFeature(f: Feature): void;
}

export const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "feature";

/** The first prompt for the lead. One line, because it travels as a command-line argument. */
export function leadTask(f: Pick<Feature, "description" | "slug">): string {
  return [
    `You are the lead engineer for this feature: ${f.description}.`,
    `Step 1: grill the user about it with the grilling skill (mattpocock-skills:grilling), asking each question with the Bridge tool ask_user.`,
    `Step 2: write the spec to .scratch/${f.slug}/spec.md, then call the Bridge tool submit_spec. It blocks until the user approves; if they reply or deny, revise the spec and submit again.`,
    `Step 3: after approval, slice the spec into one ticket file per vertical slice in .scratch/${f.slug}/issues/ (NN-slug.md, with a Status line and a Blocked by line) using the to-tickets skill.`,
    `Step 4: call submit_tickets with the number of workers you suggest (1 to 3) and, for each ticket, a distinct shape (${SHAPE_KEYS.join(", ")}) and a hex colour for the worker that will build it. It blocks until the user approves.`,
    `Do not write code, and do not start workers: Bridge starts them after both approvals. Never merge: the user merges.`,
  ].join(" ");
}

/** Null if the look is valid, otherwise what is wrong with it. */
export function checkLook(shape: unknown, color: unknown): string | null {
  if (typeof shape !== "string" || !(SHAPE_KEYS as readonly string[]).includes(shape)) return `shape must be one of: ${SHAPE_KEYS.join(", ")}`;
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return `colour must be a hex colour like ${PALETTE[0]}`;
  return null;
}

/** Features and the pipeline gates between planning and building. The ticket files stay the only record of tickets. */
export function createFeatures(store: Persistence) {
  const find = (id: string) => store.features().find((f) => f.id === id);
  const save = (f: Feature) => { store.updateFeature(f); return f; };
  return {
    list: (projectId: string) => store.features().filter((f) => f.projectId === projectId),
    get: find,
    create(input: { id: string; projectId: string; description: string; leadAgentId: string | null }): Feature {
      const taken = new Set(store.features().filter((f) => f.projectId === input.projectId).map((f) => f.slug));
      const base = slugify(input.description);
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      const f: Feature = { ...input, slug, stage: "grill", gateItemId: null, suggestedWorkers: null, looks: {}, createdAt: Date.now() };
      store.addFeature(f);
      return f;
    },
    update: save,
    /** The feature, if any, whose planning this ticket is still waiting on. Tickets outside any feature are never held. */
    holding(projectId: string, ticket: Pick<Ticket, "feature">): Feature | undefined {
      return store.features().find((f) => f.projectId === projectId && f.slug === ticket.feature && f.stage !== "build");
    },
    /** Why a held ticket cannot start yet. */
    holdReason(f: Feature): string {
      return f.stage === "tickets" || f.stage === "tickets-gate" ? "the ticket breakdown is not approved yet" : "the spec is not approved yet";
    },
    gates(f: Feature, tickets: Ticket[]): Gates {
      const spec: GateState = f.stage === "grill" ? "waiting" : f.stage === "spec-gate" ? "pending" : "approved";
      const built = f.stage === "build";
      const tickets_: GateState = f.stage === "tickets-gate" ? "pending" : built ? "approved" : "waiting";
      const mine = tickets.filter((t) => t.feature === f.slug);
      const merge: GateState = !built ? "waiting" : mine.length > 0 && mine.every((t) => t.column === "done") ? "approved" : "pending";
      return { spec, tickets: tickets_, merge };
    },
    specText(repoPath: string, f: Feature): string | null {
      const file = join(repoPath, ".scratch", f.slug, "spec.md");
      try { return existsSync(file) ? readFileSync(file, "utf8") : null; } catch { return null; }
    },
  };
}
