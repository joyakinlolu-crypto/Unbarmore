import type { Metadata } from 'next';
import { H, LegalPage, P, UL } from '@/components/LegalPage';
import { LEGAL, PROCESSORS, REG_ID } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: `How ${LEGAL.product} collects, uses, shares and protects personal data under the Nigeria Data Protection Act 2023, and how to delete your data.`,
};

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={`${LEGAL.product} is a WhatsApp assistant and app that helps small businesses record sales and expenses, make product videos and understand their money. This policy explains what personal data we handle, why, who we share it with, how long we keep it, and the rights you have under the Nigeria Data Protection Act 2023 (NDPA).`}
    >
      <section>
        <H n={1}>Who is responsible for your data</H>
        <P>
          {LEGAL.product} is a product owned and operated by {LEGAL.company}{REG_ID ? ` (${REG_ID})` : ''}{LEGAL.address ? `, ${LEGAL.address}` : ''} (“we”, “us”). We are the data controller for the personal data of
          the business owners and staff who use {LEGAL.product}. For the names and phone numbers of <i>your own customers</i> that you give us, you are the controller and we act as your processor:
          we only use that data to provide the service to you.
        </P>
        <P>Questions or requests about personal data: <a className="font-semibold text-royal underline" href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>. Where the NDPA requires us to appoint a Data Protection Officer or register with the Nigeria Data Protection Commission (NDPC), we do so.</P>
      </section>

      <section>
        <H n={2}>What we collect</H>
        <UL>
          <li><b>Account details:</b> your WhatsApp phone number, WhatsApp profile name, business name, business category, optional RC number and logo, and the phone numbers of staff you add.</li>
          <li><b>What you send the bot:</b> text messages, voice notes, photos, screenshots of bank alerts and supplier receipts, and captions.</li>
          <li><b>Your business records:</b> sales, expenses, stock, cost prices, debts, and the names and phone numbers of customers you ask us to remember.</li>
          <li><b>What we create for you:</b> receipts, statements (PDF), product videos, cleaned photos, voiceovers, reports and reminders.</li>
          <li><b>Payments:</b> subscription status, payment references and, if you ask for a referral payout, the bank account details you give us. We never see or store card numbers: Paystack handles those.</li>
          <li><b>Technical data:</b> time of messages, login events, browser or phone type, IP address, and, if you turn on alerts, a push-notification address for your device.</li>
          <li><b>Cookies:</b> one essential sign-in cookie so you stay logged in. We do not use advertising or tracking cookies.</li>
        </UL>
        <P>We do not ask for, and you should not send us, sensitive personal data such as health, religion, political views or biometric data. Bank-alert screenshots may show a sender’s name and bank; we only extract what is needed to check the payment.</P>
      </section>

      <section>
        <H n={3}>Why we use it, and our lawful basis</H>
        <UL>
          <li><b>To provide the service you asked for</b> (record entries, make receipts and videos, show your dashboard, send your morning and evening notes): performance of our contract with you.</li>
          <li><b>To take payment and run referral credits:</b> performance of our contract, and legal obligations (tax and accounting).</li>
          <li><b>To keep the service safe and working</b> (fraud checks on payment screenshots, spotting failures, preventing abuse, backups): our legitimate interests, which do not override your rights.</li>
          <li><b>Reminders and notes by WhatsApp or push notification:</b> your consent. You can stop at any time by sending <b>REMINDERS OFF</b> or <b>STOP</b> to the bot, or by turning off notifications on your device.</li>
          <li><b>To improve the product</b> using counts and patterns (for example how many videos are made): our legitimate interests, using aggregated data wherever we can.</li>
        </UL>
        <P>We do not sell your personal data, and we do not use it for third-party advertising.</P>
      </section>

      <section>
        <H n={4}>How AI is used on your data</H>
        <P>
          To understand your messages, voice notes and photos, write video scripts, clean product photos and speak voiceovers, we send the relevant content to Google’s Gemini API. We use Google’s paid API service, under
          whose published terms your prompts and responses are not used to train Google’s models. AI can make mistakes. Entries it reads from your messages are shown to you for confirmation, and you can undo them.
          We do not make decisions about you that have legal or similarly significant effects solely by automated means.
        </P>
      </section>

      <section>
        <H n={5}>Who we share data with</H>
        <P>We share personal data only with the service providers below, who process it on our instructions, and where the law requires it (for example a court order).</P>
        <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-100">
          <table className="w-full text-left text-sm">
            <thead className="bg-mist text-xs uppercase text-slate-500"><tr><th className="p-3">Provider</th><th className="p-3">Why</th><th className="p-3">Where</th></tr></thead>
            <tbody>
              {PROCESSORS.map((p) => (
                <tr key={p.name} className="border-t border-slate-100 align-top"><td className="p-3 font-semibold">{p.name}</td><td className="p-3">{p.why}</td><td className="p-3 whitespace-nowrap">{p.where}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>Messages you send on WhatsApp also pass through WhatsApp/Meta under <a className="underline" href="https://www.whatsapp.com/legal/privacy-policy" rel="noopener">WhatsApp’s own privacy policy</a>. We do not message your customers. Anything you forward to them, you send yourself.</P>
      </section>

      <section>
        <H n={6}>Transfers outside Nigeria</H>
        <P>
          Our providers run servers outside Nigeria, so your data is transferred abroad. We only use providers that give appropriate protection, through contracts and security commitments, as the NDPA requires for cross-border transfers.
          By using {LEGAL.product} you understand your data is processed in these countries.
        </P>
      </section>

      <section>
        <H n={7}>How long we keep it</H>
        <UL>
          <li>Your account and business records: while your account is active.</li>
          <li>Photos, videos, receipts and other files: while your account is active, unless you ask us to delete them sooner.</li>
          <li>After you close your account or ask us to delete your data: we delete or anonymise it within 30 days, except records we must keep by law (for example payment and tax records, normally up to 6 years).</li>
          <li>Backups: removed on the normal backup cycle after deletion.</li>
        </UL>
      </section>

      <section>
        <H n={8}>How we protect it</H>
        <P>
          Data is encrypted in transit (HTTPS), stored in access-controlled databases that only our servers can read, and file links are short-lived and signed. Sign-in links for the app expire quickly and work once.
          Access is limited to the people who need it. No system is perfectly secure. If a personal data breach is likely to put your rights at risk, we will notify the NDPC within 72 hours of becoming aware of it, and tell affected people without undue delay when the risk to them is high.
        </P>
      </section>

      <section>
        <H n={9}>Your rights</H>
        <P>Under the NDPA you have the right to:</P>
        <UL>
          <li>know what data we hold about you and get a copy (access and portability);</li>
          <li>have wrong data corrected, and have data deleted or restricted;</li>
          <li>object to processing based on our legitimate interests or used for direct marketing;</li>
          <li>withdraw consent at any time (this does not affect what we did before);</li>
          <li>not be subject to a decision based solely on automated processing that significantly affects you; and</li>
          <li>complain to the Nigeria Data Protection Commission (<a className="underline" href="https://ndpc.gov.ng" rel="noopener">ndpc.gov.ng</a>).</li>
        </UL>
        <P>We answer requests within 30 days. We may need to confirm it is really you, usually by replying to the WhatsApp number on the account.</P>
      </section>

      <section id="delete">
        <H n={10}>How to delete your data</H>
        <P>You can ask us to delete your account and the data in it at any time:</P>
        <UL>
          <li><b>On WhatsApp:</b> message the bot {LEGAL.whatsapp ? `on ${LEGAL.whatsapp} ` : ''}with the words <b>DELETE MY DATA</b>. We reply to confirm and then delete.</li>
          <li><b>By email:</b> write to <a className="underline" href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a> from any address, stating the WhatsApp number on the account. We confirm it is you through that number.</li>
          {LEGAL.phone && <li><b>By phone:</b> call {LEGAL.company} on {LEGAL.phone}.</li>}
        </UL>
        <P>Deleting removes your business records, customers, files and videos, apart from records we must keep by law (section 7). If you only want to stop messages, send <b>STOP</b>.</P>
      </section>

      <section>
        <H n={11}>Children</H>
        <P>{LEGAL.product} is for business use by adults (18 and over). We do not knowingly collect data from children.</P>
      </section>

      <section>
        <H n={12}>Changes to this policy</H>
        <P>If we change this policy in a way that matters, we will tell you on WhatsApp or in the app before it applies, and update the date at the top. See also our <a className="underline" href="/terms">Terms of Service</a>.</P>
      </section>
    </LegalPage>
  );
}
