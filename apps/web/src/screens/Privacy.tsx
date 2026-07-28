import { useNavigate } from "react-router-dom";
import { PillButton } from "../components/PillButton.js";
import { t } from "../i18n/index.js";
import type { MessageKey } from "../i18n/en.js";

/**
 * The privacy promise, in plain language (docs/09 M6, docs/01 §12, docs/03 §7).
 *
 * Every statement here is a behaviour implemented somewhere in this repository.
 * If one of these ever stops being true, this page is the thing that has to
 * change first. The copy lives in the string catalogue, like all new copy.
 */
const PROMISES = [1, 2, 3, 4, 5] as const;

export function Privacy() {
  const navigate = useNavigate();
  return (
    <main className="policy" data-testid="privacy">
      <header className="capture-head">
        <button className="back" onClick={() => navigate(-1)} aria-label="Back">
          ‹
        </button>
        <h1 className="type-title">{t("privacy.title")}</h1>
      </header>

      <p className="type-body">{t("privacy.intro")}</p>

      <ol className="policy-list">
        {PROMISES.map((n) => (
          <li key={n}>
            <h2 className="type-label">{t(`privacy.${n}.title` as MessageKey)}</h2>
            <p className="type-body">{t(`privacy.${n}.body` as MessageKey)}</p>
          </li>
        ))}
      </ol>

      <p className="type-caption">{t("privacy.deleteHint")}</p>

      <footer className="capture-foot">
        <PillButton variant="primary" onClick={() => navigate("/")}>
          {t("privacy.back")}
        </PillButton>
      </footer>
    </main>
  );
}
