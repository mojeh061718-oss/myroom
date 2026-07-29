import { useNavigate } from "react-router-dom";
import { PillButton } from "../components/PillButton.js";

/** Post-M1 routes render an honest placeholder until their milestone lands. */
export function StubScreen({ title, body }: { title: string; body: string }) {
  const navigate = useNavigate();
  return (
    <div className="stub-screen">
      <h1 className="type-title" style={{ margin: 0 }}>
        {title}
      </h1>
      <p style={{ color: "var(--text-dim)", maxWidth: 420, margin: 0 }}>{body}</p>
      <PillButton variant="secondary" onClick={() => navigate(-1)}>
        ← Back
      </PillButton>
    </div>
  );
}
