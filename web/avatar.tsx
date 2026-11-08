import { useEffect, useRef } from "react";
import { createOrbEngine } from "../third-party/thinking-orbs/engine.ts";
import { SHAPES, STATE_LABELS, eyes, orbSpec, type AvatarState, type ShapeKey } from "../src/shared/avatar.ts";

export interface AgentAvatarProps {
  shape: ShapeKey | string;
  color: string;
  state: AvatarState | string;
  /** 20, 40 and 96 are the design sizes. */
  size?: number;
  /** The lead is drawn with a ring. */
  lead?: boolean;
  name?: string;
}

const known = (s: string): AvatarState => (s in STATE_LABELS ? (s as AvatarState) : "idle");

/** Coloured agent avatar: one of eight shapes, two slanted tick eyes, nine animated states. */
export function AgentAvatar({ shape, color, state, size = 40, lead = false, name }: AgentAvatarProps) {
  const st = known(state);
  const sh = SHAPES[shape as ShapeKey] ?? SHAPES.circle;
  const ey = eyes(st);
  const ring = Math.max(3, Math.round(size * 0.13));
  const label = `${name ? name + ", " : ""}${shape} avatar, ${STATE_LABELS[st]}`;
  const eyeStyle = { fill: "none", stroke: "#121212", strokeWidth: 6.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <div className={`bav s-${st}`} style={{ position: "relative", display: "inline-flex", flex: "none", width: size, height: size, color: "#EDEDED" }}>
      {lead && <div aria-hidden="true" style={{ position: "absolute", inset: -ring, borderRadius: 9999, border: `${size >= 64 ? 2 : 1.5}px solid ${color}`, opacity: 0.55 }} />}
      <svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-label={label} style={{ overflow: "visible", display: "block" }}>
        <circle className="bav-halo" cx="50" cy="50" r="46" style={{ fill: color }} />
        <g className="bav-fig">
          <path className="bav-body" d={sh.d} style={{ fill: color, stroke: color, strokeWidth: sh.stroke ?? 0, strokeLinejoin: "round" }} />
          <g transform={`translate(${sh.eye[0]} ${sh.eye[1] + ey.dy}) scale(${sh.eye[2]})`}>
            <g className="bav-eyes-in">
              <path d={ey.left} style={eyeStyle} />
              <path d={ey.right} style={eyeStyle} />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}

const engine = createOrbEngine();
const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

/** Small canvas dot orb in the agent's colour; the animation follows the avatar state. */
export function ThinkingOrb({ state, color, size = 64 }: { state: AvatarState | string; color: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = known(state);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const spec = orbSpec(st);
    const rgb = hexRgb(color);
    // Like the reference, the engine only ever draws at its two tuned sizes (20 and 64).
    // Other sizes scale the drawing, so dot counts and proportions match the original.
    const logical = size < 48 ? 20 : 64;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    c.width = px; c.height = px;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const p = engine.resolve(spec.mode, logical);
    const k = px / logical;
    const draw = (t: number) => {
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.clearRect(0, 0, logical, logical);
      (engine.draw as Record<string, (...a: any[]) => void>)[spec.mode]!(ctx, logical, spec.still ?? t * p.speed, rgb, p.opts, spec.dim);
    };
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || spec.still != null) { draw(spec.still ?? 0.6); return; }
    let raf = 0;
    const loop = () => { draw(performance.now() / 1000); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [st, color, size]);
  return <canvas ref={ref} role="img" aria-label={`Thinking orb: ${STATE_LABELS[st]}`} style={{ display: "block", flex: "none", width: size, height: size }} />;
}
