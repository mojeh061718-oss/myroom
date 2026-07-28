import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { PillButton } from "../components/PillButton.js";
import { useSettings } from "../stores/settingsStore.js";

type Probe = { state: "idle" | "testing" | "ok" | "fail" | "saved"; detail?: string };

/**
 * Settings, and the one thing that genuinely has to live here: where photo
 * reconstruction runs (docs/03 §8).
 *
 * On a phone, a build-time environment variable is the wrong place for this.
 * The person installing the app is the person who knows their endpoint, and
 * they cannot rebuild a PWA to tell it. So it is a field.
 */
export function Settings() {
  const navigate = useNavigate();
  const settings = useSettings();
  const [url, setUrl] = useState(settings.serviceUrl);
  const [token, setToken] = useState(settings.serviceToken);
  const [probe, setProbe] = useState<Probe>({ state: "idle" });

  const dirty = url.trim().replace(/\/$/, "") !== settings.serviceUrl || token.trim() !== settings.serviceToken;

  const save = async () => {
    await settings.setService(url, token);
    setProbe({ state: "saved", detail: "Saved on this device." });
  };

  /**
   * Ask the endpoint whether it is there. A reachable service that answers
   * anything at all is the useful signal; a typo or a dead host is the failure
   * worth catching before someone shoots twelve photos of their living room.
   */
  const test = async () => {
    const base = url.trim().replace(/\/$/, "");
    if (!base) {
      setProbe({ state: "fail", detail: "Enter an address first." });
      return;
    }
    setProbe({ state: "testing" });
    try {
      const res = await fetch(`${base}/health`, {
        headers: token.trim() ? { authorization: `Bearer ${token.trim()}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      setProbe(
        res.ok
          ? { state: "ok", detail: `Answered ${res.status}.` }
          : { state: "fail", detail: `Answered ${res.status}. Reachable, but not happy.` },
      );
    } catch (error) {
      setProbe({
        state: "fail",
        detail:
          error instanceof DOMException && error.name === "TimeoutError"
            ? "No answer within 8 seconds."
            : "Couldn't reach it. Check the address, and that it allows requests from this app.",
      });
    }
  };

  return (
    <main className="screen settings-screen" data-testid="settings">
      <header className="settings-header">
        <button
          className="icon-button glass"
          style={{ borderRadius: "var(--radius-pill)" }}
          aria-label="Back"
          onClick={() => navigate("/")}
        >
          <ChevronLeft size={22} />
        </button>
        <h1 className="type-title">Photo reconstruction</h1>
      </header>

      <section className="settings-group">
        <p className="type-body settings-help">
          Turning photographs into furniture needs a service to run the vision model. Without one, everything
          else still works — drawing, 3D rooms, furnishing, scans — and rooms built from photos say they were
          laid out from the plan rather than measured.
        </p>

        <label className="settings-field">
          <span className="type-label">Service address</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://your-service.example.com"
            value={url}
            data-testid="service-url"
            onChange={(e) => {
              setUrl(e.target.value);
              setProbe({ state: "idle" });
            }}
          />
        </label>

        <label className="settings-field">
          <span className="type-label">Access token (optional)</span>
          <input
            type="password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Leave empty if the service is open"
            value={token}
            data-testid="service-token"
            onChange={(e) => {
              setToken(e.target.value);
              setProbe({ state: "idle" });
            }}
          />
        </label>

        <div className="settings-actions">
          <PillButton variant="secondary" onClick={test} data-testid="service-test">
            {probe.state === "testing" ? "Testing…" : "Test connection"}
          </PillButton>
          <PillButton variant="primary" disabled={!dirty} onClick={() => void save()} data-testid="service-save">
            Save
          </PillButton>
        </div>

        {probe.state === "saved" && (
          <p className="settings-probe ok" role="status" data-testid="service-probe-saved">
            {probe.detail}
          </p>
        )}

        {(probe.state === "ok" || probe.state === "fail") && (
          <p
            className={`settings-probe ${probe.state}`}
            role="status"
            data-testid={`service-probe-${probe.state}`}
          >
            {probe.state === "ok" ? "Reached it. " : "Didn't reach it. "}
            {probe.detail}
          </p>
        )}

        <p className="type-caption settings-help">
          The address and token are stored on this device only, and are sent to that service and nowhere
          else. Don't paste a cloud provider's root access key here — anything a browser holds can be read
          off it. Point this at your own small endpoint that holds the key server-side instead.
        </p>
      </section>

    </main>
  );
}
