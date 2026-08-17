import { LEGAL } from "../../../lib/legal";
import { POLICY_VERSION } from "../../../lib/consent";

export const metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <p className="small">
        <a href="/">← Home</a>
      </p>
      <h1>Terms of Service</h1>
      <p className="muted small">
        Effective {LEGAL.effectiveDate} · version {POLICY_VERSION}
      </p>

      <h2>1. Acceptance</h2>
      <p>
        These Terms govern your use of {LEGAL.appName} ({LEGAL.domain}) (the “Service”), operated by {LEGAL.legalEntity}
        (“we”, “us”). By creating an account or using the Service you agree to these Terms and to our{" "}
        <a href="/legal/privacy">Privacy Policy</a>. If you do not agree, do not use the Service.
      </p>

      <h2>2. The Service</h2>
      <p>
        The Service turns photos and music you provide into a short, AI-generated, beat-synced video. Output is produced
        by third-party AI models and is inherently variable — we do not guarantee any particular quality, accuracy,
        likeness, or result, and generated media may contain artifacts or unexpected content.
      </p>

      <h2>3. Eligibility</h2>
      <p>
        You must be at least 13 years old to use the Service. If you are under 18 (or the age of majority where you
        live), you may use the Service only with the involvement and permission of a parent or legal guardian, who
        agrees to these Terms on your behalf. The Service is not directed to children under 13. You must not upload
        images of minors except your own children or with the verifiable consent of a parent/guardian, and never in a
        sexualized context.
      </p>

      <h2>4. Your content and rights</h2>
      <p>
        You retain ownership of the photos, music, and other materials you upload (“Your Content”). You grant us a
        limited license to store, process, and transmit Your Content solely to operate the Service — including sending it
        to our third-party AI and infrastructure providers to generate your video (see the Privacy Policy). You
        represent and warrant that you have all rights necessary to upload and use Your Content, including rights to any
        music and the consent of any identifiable people depicted. <strong>You are solely responsible for, and assume all
        liability for, Your Content</strong> and its use.
      </p>

      <h2>5. Acceptable use</h2>
      <p>You will not use the Service to upload, generate, or distribute content that:</p>
      <ul>
        <li>is illegal, or that sexually exploits or endangers minors (CSAM) — strictly prohibited;</li>
        <li>depicts a real person without their consent, including non-consensual intimate or sexual imagery, or that
          impersonates someone;</li>
        <li>infringes intellectual-property rights (including music you do not have the rights to use);</li>
        <li>is harassing, hateful, threatening, defamatory, or promotes violence; or</li>
        <li>contains malware or attempts to disrupt, scrape, or reverse-engineer the Service.</li>
      </ul>
      <p>
        <strong>Zero tolerance for child sexual abuse material.</strong> We remove it, terminate the account, preserve
        relevant data, and report to the National Center for Missing &amp; Exploited Children (NCMEC) and/or law
        enforcement as required by law. Report suspected violations to{" "}
        <a href={`mailto:${LEGAL.abuseEmail}`}>{LEGAL.abuseEmail}</a>.
      </p>

      <h2>6. Biometric data</h2>
      <p>
        Grouping photos by face uses biometric processing and runs <strong>only</strong> if you give separate, explicit
        consent at the consent step. If you decline, you tag people manually and no face processing occurs. See the{" "}
        <a href="/legal/privacy">Privacy Policy</a> for details on how biometric data is handled and deleted.
      </p>

      <h2>7. Tokens, billing, and refunds</h2>
      <p>
        Previews are free and watermarked. Generating a final (clean) render costs tokens, which you purchase via our
        payment processor (Stripe). Token costs vary with the options you select (e.g. a premium video model costs
        more). <strong>All sales are final: purchases and tokens are non-refundable</strong>, except where a refund is
        required by applicable law. Tokens have no cash value and are not transferable. We may change pricing
        prospectively.
      </p>

      <h2>8. Content retention and deletion</h2>
      <p>
        Inputs and outputs are automatically deleted from our systems a short time after a render completes
        (approximately {"72"} hours). <strong>Download anything you want to keep before then.</strong> We are not liable
        for content lost to this automatic deletion, and you may delete a project (and its media) at any time.
      </p>

      <h2>9. Disclaimers</h2>
      <p>
        The Service is provided “as is” and “as available”, without warranties of any kind, express or implied,
        including merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that output
        will meet your expectations or be error-free.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, we are not liable for indirect, incidental, special, consequential, or
        punitive damages, or for lost data or content. Our total liability for any claim relating to the Service will not
        exceed the greater of the amount you paid us in the 3 months before the claim or USD $50.
      </p>

      <h2>11. Indemnification</h2>
      <p>
        You will indemnify and hold us harmless from claims, damages, and expenses arising out of Your Content or your
        violation of these Terms or the rights of any third party (including music rights and the rights of people
        depicted).
      </p>

      <h2>12. Copyright / DMCA</h2>
      <p>
        If you believe content on the Service infringes your copyright, contact our designated agent at{" "}
        <a href={`mailto:${LEGAL.dmcaEmail}`}>{LEGAL.dmcaEmail}</a> with the information required by the DMCA. We remove
        infringing content and terminate repeat infringers.
      </p>

      <h2>13. Termination</h2>
      <p>We may suspend or terminate access for violation of these Terms or to comply with law. You may stop using the Service and delete your projects at any time.</p>

      <h2>14. Changes</h2>
      <p>We may update these Terms; material changes will be reflected by a new effective date/version, and continued use constitutes acceptance.</p>

      <h2>15. Governing law</h2>
      <p>These Terms are governed by the laws of {LEGAL.jurisdiction}, without regard to conflict-of-laws rules.</p>

      <h2>16. Contact</h2>
      <p>
        Questions: <a href={`mailto:${LEGAL.supportEmail}`}>{LEGAL.supportEmail}</a>.
      </p>
    </div>
  );
}
