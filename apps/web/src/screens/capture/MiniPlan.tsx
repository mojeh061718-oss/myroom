import { planLoop, type RoomPlan } from "@myroom/schema";

/**
 * The mini-plan that anchors guided capture (docs/01 §6): the room from above,
 * with the wall being photographed highlighted, and every wall tappable so a
 * photo from the library can be tagged in one tap.
 */
export function MiniPlan({
  plan,
  activeWallId,
  doneWallLabels = [],
  onPickWall,
  size = 180,
}: {
  plan: RoomPlan;
  activeWallId?: string | null;
  doneWallLabels?: string[];
  onPickWall?: (wallId: string) => void;
  size?: number;
}) {
  const loop = planLoop(plan);
  if (!loop || loop.length < 3) return null;

  const xs = loop.map((p) => p.x);
  const ys = loop.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(maxX - minX, 0.1);
  const height = Math.max(maxY - minY, 0.1);
  const scale = 100 / Math.max(width, height);
  // Plan y grows north, SVG y grows down.
  const px = (p: { x: number; y: number }) => [(p.x - minX) * scale, (maxY - p.y) * scale] as const;

  const path = loop.map((p, i) => `${i === 0 ? "M" : "L"}${px(p)[0].toFixed(1)},${px(p)[1].toFixed(1)}`).join(" ");
  const done = new Set(doneWallLabels);

  return (
    <svg
      className="mini-plan"
      viewBox={`-14 -14 ${width * scale + 28} ${height * scale + 28}`}
      width={size}
      height={size}
      role="img"
      aria-label="Floor plan with the wall being photographed highlighted"
      data-testid="mini-plan"
    >
      <path d={`${path} Z`} fill="rgba(76,141,255,0.10)" stroke="rgba(255,255,255,0.25)" strokeWidth={2} />
      {plan.walls.map((wall, i) => {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if (!a || !b) return null;
        const [ax, ay] = px(a);
        const [bx, by] = px(b);
        const active = wall.id === activeWallId;
        const complete = done.has(wall.label);
        return (
          <g key={wall.id}>
            <line
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={active ? "#4C8DFF" : complete ? "#5FBF8C" : "rgba(255,255,255,0.45)"}
              strokeWidth={active ? 7 : 5}
              strokeLinecap="round"
            />
            {onPickWall && (
              // A generous invisible hit target over a 5 px line: the visible
              // stroke is a drawing, not a button.
              <line
                x1={ax}
                y1={ay}
                x2={bx}
                y2={by}
                stroke="transparent"
                strokeWidth={22}
                strokeLinecap="round"
                style={{ cursor: "pointer" }}
                data-testid={`mini-plan-wall-${wall.label}`}
                onClick={() => onPickWall(wall.id)}
              />
            )}
            <text
              x={(ax + bx) / 2}
              y={(ay + by) / 2}
              dy={4}
              textAnchor="middle"
              fontSize={11}
              fill={active ? "#FFFFFF" : "rgba(255,255,255,0.7)"}
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {wall.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
