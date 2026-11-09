import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AgentStatus } from "./agent-runner.ts";
import type { Answer, NewInboxItem } from "./inbox.ts";

/** What the tools need from the daemon. Every call is already scoped to one authenticated agent. */
export interface AgentToolContext {
  ticket(): Promise<unknown> | unknown;
  setStatus(status: AgentStatus): void;
  /** Creates an Inbox item and resolves when the user answers. */
  raise(item: Omit<NewInboxItem, "agentId" | "projectId">): Promise<Answer>;
  /** Raises an access request, or approves it at once when an earlier Ticket or Project approval covers it. */
  requestAccess(kind: string, detail: string, item: Omit<NewInboxItem, "agentId" | "projectId">): Promise<Answer>;
  /** Present only for a lead agent working on a feature: the planning tools. */
  lead?: LeadTools;
}

/** The lead's two gate tools. Each returns text for the lead: an error to fix, or the user's verdict. */
export interface LeadTools {
  submitSpec(summary: string): Promise<string>;
  submitTickets(input: { workers?: number; agents?: { ticket: string; shape: string; color: string }[] }): Promise<string>;
}

const STATUSES = ["idle", "working", "blocked", "waiting", "done"] as const;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const verdict = (a: Answer, what: string) =>
  a.decision === "approve" ? text(`Approved: ${what}`)
    : a.decision === "deny" ? text(`Denied: ${what}${a.reply ? `. Reason: ${a.reply}` : ""}`)
    : text(`The user replied: ${a.reply ?? ""}`);

function buildServer(ctx: AgentToolContext): McpServer {
  const server = new McpServer({ name: "bridge", version: "0.1.0" });
  server.registerTool("get_my_ticket", { description: "Returns the ticket assigned to you: key, title, status and the full ticket file." },
    async () => text(JSON.stringify((await ctx.ticket()) ?? { error: "no ticket assigned" }, null, 2)));
  server.registerTool("set_my_status", {
    description: "Tells the user what you are doing: idle, working, blocked, waiting or done.",
    inputSchema: { status: z.enum(STATUSES) },
  }, async ({ status }) => { ctx.setStatus(status); return text(`Status set to ${status}`); });
  server.registerTool("ask_user", {
    description: "Ask the user a question. Blocks until they answer in the Bridge Inbox.",
    inputSchema: { question: z.string(), why: z.string().optional() },
  }, async ({ question, why }) => {
    const a = await ctx.raise({ kind: "question", what: question, why: why ?? "" });
    return a.decision === "reply" ? text(a.reply ?? "") : verdict(a, question);
  });
  server.registerTool("request_access", {
    description: "Request access you do not have: a network domain, a secret, a git push or a database. Blocks until the user decides in the Bridge Inbox. Merging is never allowed: the user merges.",
    inputSchema: {
      kind: z.enum(["domain", "secret", "push", "database", "merge"]),
      detail: z.string().describe("The domain, secret name, branch or database"),
      why: z.string().optional(),
    },
  }, async ({ kind, detail, why }) => {
    if (kind === "merge") return text("Refused: agents may never merge. Push your branch and open a pull request; the user merges.");
    const label = { domain: "Domain", secret: "Secret", push: "Branch", database: "Database" }[kind];
    const what = { domain: `Reach ${detail}`, secret: `Use ${detail}`, push: `Push ${detail}`, database: `Access ${detail}` }[kind];
    const a = await ctx.requestAccess(kind, detail, { kind: "access", access: kind, detail, what, why: why ?? "", facts: [{ k: label, v: detail }] });
    return verdict(a, what);
  });
  const lead = ctx.lead;
  if (lead) {
    server.registerTool("submit_spec", {
      description: "Submit the spec you wrote at .scratch/<feature>/spec.md for the user's approval. Blocks until they approve, deny or reply. If they do not approve, revise the spec and call this again.",
      inputSchema: { summary: z.string().describe("A few sentences on what the spec says") },
    }, async ({ summary }) => text(await lead.submitSpec(summary)));
    server.registerTool("submit_tickets", {
      description: "Submit the ticket breakdown you wrote under .scratch/<feature>/issues for the user's approval. Say how many workers to run and the shape and colour of each ticket's worker. Blocks until the user decides.",
      inputSchema: {
        workers: z.number().int().min(1).max(3).optional().describe("How many workers to run in parallel, 1 to 3"),
        agents: z.array(z.object({ ticket: z.string().describe("Ticket number, e.g. 01"), shape: z.string(), color: z.string().describe("Hex colour, e.g. #0A84FF") })).optional(),
      },
    }, async (input) => text(await lead.submitTickets(input)));
  }
  return server;
}

/** Serves one MCP request (stateless streamable HTTP) for an authenticated agent. */
export async function handleAgentTools(ctx: AgentToolContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  let body: unknown;
  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { /* transport reports it */ }
  }
  await transport.handleRequest(req, res, body);
}
