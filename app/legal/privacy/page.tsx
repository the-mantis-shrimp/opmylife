import { LEGAL } from "../../../lib/legal";
import { POLICY_VERSION } from "../../../lib/consent";

export const metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <p className="small">
        <a href="/">← Home</a>
      </p>
      <h1>Privacy Policy</h1>
      <p className="muted small">
        Effective {LEGAL.effectiveDate} · version {POLICY_VERSION}
      </p>

      <p>
        This policy explains what {LEGAL.appName} ({LEGAL.domain}), operated by {LEGAL.legalEntity}, collects and how we
        use it. It is part of our <a href="/legal/terms">Terms of Service</a>.
      </p>

      <h2>1. What we collect</h2>
      <ul>
        <li><strong>Account info</strong> — email and authentication identifiers, handled by our auth provider (Clerk).</li>
        <li><strong>Uploaded content</strong> — the photos and any music you upload, plus generated audio/video.</li>
        <li><strong>Biometric data</strong> — face-geometry data used to group photos by person, processed{" "}
          <strong>only</strong> if you grant separate, explicit consent. If you decline, we do not perform face
          processing and you tag people manually.</li>
        <li><strong>Payment info</strong> — processed by Stripe. We do <strong>not</strong> store your card details.</li>
        <li><strong>Usage/technical data</strong> — logs and basic diagnostics needed to run and secure the Service.</li>
      </ul>

      <h2>2. How we use it</h2>
      <p>
        We use your content solely to provide the Service: generating your video. To do that, your photos, music, and
        prompts are <strong>sent to third-party AI providers for processing</strong>. We do not sell your content or use
        it to train our own models.
      </p>

      <h2>3. Security</h2>
      <p>
        Your content is <strong>encrypted at rest</strong> and sent over encrypted connections, and we restrict access
        to it. Please note the Service is <strong>not end-to-end encrypted</strong>: to generate your video, your
        content is decrypted and processed by the AI systems that power the Service. Don’t upload anything you wouldn’t
        want processed by automated systems.
      </p>

      <h2>4. Retention and deletion</h2>
      <p>
        Inputs and outputs are <strong>automatically deleted</strong> from our systems a short time after a render
        completes (approximately 72 hours), on a server-side schedule that is not tied to your browser session. You can
        also delete a project and its media at any time. <strong>Deletion is permanent — download anything you want to
        keep.</strong>
      </p>

      <h2>5. Biometric data specifics</h2>
      <p>
        Face-grouping data is used only to organize your photos by person for this render, is governed by the separate,
        versioned consent you provide, is deleted along with the project on the retention schedule above, and is never
        sold. If you do not consent, no biometric processing occurs and the manual-tagging path produces the same
        result.
      </p>

      <h2>6. Your rights</h2>
      <p>
        Depending on where you live (e.g. GDPR/CCPA), you may have rights to access, correct, delete, or export your
        personal data, and to withdraw consent. To exercise them, contact{" "}
        <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>. You can withdraw biometric consent at any time;
        future renders will use manual tagging.
      </p>

      <h2>7. Children</h2>
      <p>
        The Service is intended for users aged 13 and older and is not directed to children under 13. If you are under
        18, you need a parent or guardian’s permission to use it. Do not upload images of minors except your own
        children or with verifiable parental consent, and never in a sexualized context (see the Terms).
      </p>

      <h2>8. International transfers</h2>
      <p>Our providers may process data in other countries; we rely on their safeguards for such transfers.</p>

      <h2>9. Changes</h2>
      <p>We may update this policy; material changes will carry a new effective date/version.</p>

      <h2>10. Contact</h2>
      <p>
        Privacy questions or requests: <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a>. Report abuse:{" "}
        <a href={`mailto:${LEGAL.abuseEmail}`}>{LEGAL.abuseEmail}</a>.
      </p>
    </div>
  );
}
