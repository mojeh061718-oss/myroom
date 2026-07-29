import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PillButton } from "../components/PillButton.js";
import { t } from "../i18n/index.js";
import type { MessageKey } from "../i18n/en.js";
import { detectInferenceTier, privacySentence, type TierReport } from "../lib/inference/device.js";

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
  // Where reconstruction runs is a property of *this* device, so the honest
  // answer to "where do my photos go" cannot be static copy. Probed here and
  // stated in the user's own terms.
  const [tier, setTier] = useState<TierReport | null>(null);
  useEffect(() => {
    let live = true;
    void detectInferenceTier().then((report) => {
      if (live) setTier(report);
    });
    return () => {
      live = false;
    };
  }, []);

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

      <section className="policy-tier" data-testid="privacy-tier">
        <h2 className="type-label">{t("privacy.where.title")}</h2>
        <p className="type-body" data-testid="privacy-tier-sentence" data-tier={tier?.tier ?? "detecting"}>
          {tier ? privacySentence(tier) : t("privacy.where.detecting")}
        </p>
      </section>

      <p className="type-caption">{t("privacy.deleteHint")}</p>

      <footer className="capture-foot">
        <PillButton variant="primary" onClick={() => navigate("/")}>
          {t("privacy.back")}
        </PillButton>
      </footer>
    </main>
  );
}
