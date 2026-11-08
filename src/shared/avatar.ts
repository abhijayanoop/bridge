/** Pure avatar/orb logic shared by the daemon and the UI. */

export type HookStatus = "idle" | "working" | "blocked" | "waiting" | "done";
export type Activity = "planning" | "exploring" | "implementing" | "debugging" | "composing";
export type AvatarState = "idle" | "planning" | "exploring" | "implementing" | "debugging" | "composing" | "listening" | "blocked" | "done";
export type OrbMode = "working" | "searching" | "solving" | "listening" | "composing" | "shaping";

export const HOOK_STATUSES: readonly HookStatus[] = ["idle", "working", "blocked", "waiting", "done"];
export const ACTIVITIES: readonly Activity[] = ["planning", "exploring", "implementing", "debugging", "composing"];

export const SHAPE_KEYS = ["circle", "egg", "squircle", "pill", "triangle", "hexagon", "cloud", "teardrop"] as const;
export type ShapeKey = (typeof SHAPE_KEYS)[number];
export const PALETTE = ["#0A84FF", "#FF6A00", "#00B8A5", "#FF2D44", "#FF2D9B", "#8F5BFF", "#FF9500", "#8F5E3B"] as const;

/** Shape outline plus eye anchor [x, y, scale] and optional stroke width, from the design. */
export const SHAPES: Record<ShapeKey, { d: string; eye: [number, number, number]; stroke?: number }> = {
  circle: { d: "M50 6A44 44 0 1 1 50 94A44 44 0 1 1 50 6Z", eye: [45, 47, 1] },
  egg: { d: "M52 9C76 9 93 28 92 53C91 77 72 92 50 91C27 90 9 78 8 57C7 35 27 9 52 9Z", eye: [44, 50, 1] },
  squircle: { d: "M50 8C82 8 92 18 92 50C92 82 82 92 50 92C18 92 8 82 8 50C8 18 18 8 50 8Z", eye: [56, 40, 1] },
  pill: { d: "M30 26H70A24 24 0 0 1 70 74H30A24 24 0 0 1 30 26Z", eye: [47, 51, 0.85] },
  triangle: { d: "M42 18Q50 4 58 18L88 72Q96 88 78 88H22Q4 88 12 72Z", eye: [52, 63, 0.75] },
  hexagon: { d: "M50 12L82.9 31L82.9 69L50 88L17.1 69L17.1 31Z", eye: [52, 45, 1], stroke: 12 },
  cloud: { d: "M30 86A16 16 0 0 1 20 57A18 18 0 0 1 40 30A20 20 0 0 1 74 34A16 16 0 0 1 84 64A15 15 0 0 1 66 86A14 14 0 0 1 46 88A14 14 0 0 1 30 86Z", eye: [47, 62, 0.9] },
  teardrop: { d: "M50 7C58 19 82 40 82 62A32 32 0 0 1 18 62C18 40 42 19 50 7Z", eye: [46, 66, 0.9] },
};

export const STATE_LABELS: Record<AvatarState, string> = {
  idle: "Idle", planning: "Planning", exploring: "Exploring", implementing: "Implementing", debugging: "Debugging",
  composing: "Writing PR", listening: "Waiting for you", blocked: "Blocked", done: "Done",
};

/** Maps the hook-reported status plus the coarser activity onto one of the nine avatar states. */
export function avatarState(status: string, activity?: string | null): AvatarState {
  switch (status) {
    case "waiting": return "listening";
    case "blocked": return "blocked";
    case "done": return "done";
    case "working": return (ACTIVITIES as readonly string[]).includes(activity ?? "") ? (activity as Activity) : "implementing";
    default: return "idle";
  }
}

/** Avatar state to orb animation, per the spec: planning to shaping, exploring to searching, and so on. */
export function orbMode(state: AvatarState): OrbMode | "still" {
  switch (state) {
    case "planning": return "shaping";
    case "exploring": return "searching";
    case "implementing": return "working";
    case "debugging": return "solving";
    case "composing": return "composing";
    case "listening": return "listening";
    default: return "still";
  }
}

/** Engine drawing mode and still-frame settings for each orb state (idle, blocked, done hold a frame). */
export function orbSpec(state: AvatarState | OrbMode | "searching" | "solving" | "shaping"): { mode: string; still: number | null; dim: number } {
  const M: Record<string, [string, number?, number?]> = {
    working: ["orbits"], implementing: ["orbits"], searching: ["globe"], exploring: ["globe"],
    solving: ["rubik"], debugging: ["rubik"], listening: ["wave"], composing: ["ribbon"],
    shaping: ["morph"], planning: ["morph"],
    idle: ["globe", 0.6, 0.45], blocked: ["globe", 0.6, 0.22], done: ["morph", 0, 1],
  };
  const m = M[state] ?? M.working!;
  return { mode: m[0], still: m[1] ?? null, dim: m[2] ?? 1 };
}

/** Eye paths and vertical offset for a state (design: listening upright, blocked drooping). */
export function eyes(state: AvatarState): { left: string; right: string; dy: number } {
  if (state === "listening") return { left: "M-9 -9L-9 8", right: "M8 -9L8 8", dy: 0 };
  if (state === "blocked") return { left: "M-14 0L-7 6", right: "M5 6L12 0", dy: 6 };
  return { left: "M-13 7L-6 -6", right: "M5 -6L9 8", dy: 0 };
}

/** Coarse activity implied by the tool an agent is using (from its PreToolUse hook). */
export function activityForTool(tool?: string, command?: string): Activity | undefined {
  if (!tool) return undefined;
  if (/^(Read|Grep|Glob|LS|WebSearch|WebFetch)$/.test(tool)) return "exploring";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return "implementing";
  if (/^(TodoWrite|ExitPlanMode|EnterPlanMode|Task|Agent)$/.test(tool)) return "planning";
  if (tool === "Bash") {
    if (/\bgh\s+pr\b|\bgit\s+push\b/.test(command ?? "")) return "composing";
    return "implementing";
  }
  return undefined;
}

export interface Identity { shape: ShapeKey; color: string }

/** Picks a shape and colour not yet used in the project where possible; cycles once all are taken. */
export function pickIdentity(used: Identity[]): Identity {
  const free = (i: number) => !used.some((u) => u.shape === SHAPE_KEYS[i] || u.color === PALETTE[i]);
  for (let i = 0; i < 8; i++) if (free(i)) return { shape: SHAPE_KEYS[i]!, color: PALETTE[i]! };
  const shape = SHAPE_KEYS.find((s) => !used.some((u) => u.shape === s));
  const color = PALETTE.find((c) => !used.some((u) => u.color === c));
  if (shape || color) return { shape: shape ?? SHAPE_KEYS[used.length % 8]!, color: color ?? PALETTE[used.length % 8]! };
  return { shape: SHAPE_KEYS[used.length % 8]!, color: PALETTE[used.length % 8]! };
}
