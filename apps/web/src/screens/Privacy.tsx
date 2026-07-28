import { useNavigate } from "react-router-dom";
import { PillButton } from "../components/PillButton.js";

/**
 * The privacy promise, in plain language (docs/09 M6, docs/01 §12, docs/03 §7).
 *
 * Every statement here is a behaviour implemented somewhere in this repository,
 * and the section headings say where. If one of these ever stops being true,
 * this page is the thing that has to change first.
 */
const PROMISES = [
  {
    title: "Your photos are used for your room, and nothing else",
    body: "Photos and scans you upload are used only to build your own room. They are never used to train models, never shared, and never shown to anyone else.",
  },
  {
    title: "Nothing leaves your device until you build a room",
    body: "Photos you take or choose stay on this device while you're capturing. They're uploaded only when you start building, and only for that build.",
  },
  {
    title: "Deleting a room really deletes it",
    body: "Deleting a project removes its photos from this device immediately, and its uploads and generated files from our storage within 24 hours. Completion is recorded, so the promise is auditable rather than aspirational.",
  },
  {
    title: "Your rooms work offline, because they live here",
    body: "The whole project — the plan, the room, every saved version — is stored on this device first. The cloud is a backup and a way to run reconstruction, not the only copy.",
  },
  {
    title: "The accuracy badge is not marketing",
    body: "Sketch means the walls are exactly as you drew them and nothing was measured. Photo-calibrated and LiDAR-verified mean measurements were actually taken, from what you provided. We would rather tell you a room is a sketch than imply a precision we didn't earn.",
  },
];

export function Privacy() {
  const navigate = useNavigate();
  return (
    <main className="policy" data-testid="privacy">
      <header className="capture-head">
        <button className="back" onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <h1 className="type-title">Your photos, your room</h1>
      </header>

      <p className="type-body">
        Five promises about what happens to what you give us. No defined terms, no cross-references.
      </p>

      <ol className="policy-list">
        {PROMISES.map((promise) => (
          <li key={promise.title}>
            <h2 className="type-label">{promise.title}</h2>
            <p className="type-body">{promise.body}</p>
          </li>
        ))}
      </ol>

      <p className="type-caption">
        You can delete any room, and everything in it, from the menu on its card on the home screen.
      </p>

      <footer className="capture-foot">
        <PillButton variant="primary" onClick={() => navigate("/")}>
          Back to my rooms
        </PillButton>
      </footer>
    </main>
  );
}
