import type { Metadata } from 'next';
import { H, LegalPage, P, UL } from '@/components/LegalPage';
import { LEGAL, REG_ID } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: `The terms for using ${LEGAL.product}: what the service is, plans and billing, your responsibilities and ours.`,
};

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={`${LEGAL.product} is a product owned and operated by ${LEGAL.company}${REG_ID ? ` (${REG_ID})` : ''}. These terms are the agreement between you and ${LEGAL.company} for using ${LEGAL.product} on WhatsApp and on the web. By using ${LEGAL.product} you accept them. If you do not accept them, please do not use the service.`}
    >
      <section>
        <H n={1}>Who can use {LEGAL.product}</H>
        <P>You must be 18 or older and use {LEGAL.product} for a business you own or are authorised to run. If you add staff, you are responsible for what they do on your account.</P>
      </section>

      <section>
        <H n={2}>What the service is</H>
        <P>
          {LEGAL.product} helps you record sales, expenses, stock and debts by text, voice note or photo; make receipts; create short product videos; and see your numbers in an app. It uses AI to read your messages and
          to write and create content. It is a business tool, not an accountant, tax adviser, lawyer or financial adviser.
        </P>
      </section>

      <section>
        <H n={3}>AI can be wrong: check what matters</H>
        <UL>
          <li>AI can mishear, misread or misunderstand. Entries are shown to you to confirm, and you can undo them. Please check them.</li>
          <li>Profit and cash figures depend on the prices and costs you give us. If a cost price is missing, profit is shown as “up to” a figure. Use the numbers to guide you, and check them before big decisions, tax filings or loans.</li>
          <li>Generated videos, scripts and voiceovers are drafts for you to review before you post them.</li>
        </UL>
      </section>

      <section>
        <H n={4}>Your responsibilities</H>
        <UL>
          <li>Give accurate information and keep your WhatsApp number secure.</li>
          <li>Only upload photos and content you have the right to use, and only give us customer names and numbers you are allowed to share.</li>
          <li>You are responsible for what your videos and messages say: prices, descriptions, delivery promises and the goods you sell. Follow Nigerian advertising and consumer-protection law.</li>
          <li>Do not use {LEGAL.product} to sell illegal or prohibited goods, to scam or mislead people, to send spam, or to harass anyone. WhatsApp’s <a className="underline" href="https://www.whatsapp.com/legal/business-policy" rel="noopener">Business Policy</a> and <a className="underline" href="https://www.whatsapp.com/legal/commerce-policy" rel="noopener">Commerce Policy</a> also apply to you.</li>
          <li>Do not try to break, overload, copy or reverse-engineer the service.</li>
        </UL>
      </section>

      <section>
        <H n={5}>WhatsApp messages and reminders</H>
        <P>
          {LEGAL.product} replies to you on WhatsApp, and sends morning and evening notes and reminders where the WhatsApp rules allow. You can stop them any time by sending <b>REMINDERS OFF</b> or <b>STOP</b>.
          {LEGAL.product} does not send messages to your customers. WhatsApp is provided by Meta, and its availability and rules are outside our control.
        </P>
      </section>

      <section>
        <H n={6}>Plans, trial and payment</H>
        <UL>
          <li><b>Free trial.</b> New accounts start with a free trial with limits on videos and other features. We may change the trial.</li>
          <li><b>Paid plans.</b> Paid plans are priced in naira and billed monthly or yearly through Paystack. The current plans, prices and limits are shown in the app and on WhatsApp. Plan limits (for example videos per month) are fair-use limits and reset monthly.</li>
          <li><b>Renewal and cancelling.</b> You can stop renewing at any time; the plan then runs to the end of the period you paid for. We do not refund the part-used period, except where the law requires.</li>
          <li><b>Price changes.</b> We will give at least 30 days’ notice before a price change applies to you.</li>
          <li><b>Taxes.</b> Prices include or exclude taxes such as VAT as shown at checkout.</li>
          <li><b>Failed payment.</b> If a payment fails, your account moves to the free plan limits. We do not delete your records because of non-payment.</li>
        </UL>
      </section>

      <section>
        <H n={7}>Referral credits</H>
        <P>
          If you refer a new business and it makes its first paid subscription, you and the new business may each receive a credit, currently ₦1,000, in a referral wallet. Credits reduce your renewal price, and a cash payout becomes
          available once the wallet reaches the minimum shown in the app (currently ₦5,000). Credits have no cash value outside this scheme, and cannot be earned by referring yourself or by misleading people. We may withhold
          or reverse credits earned unfairly and may change or end the scheme.
        </P>
      </section>

      <section>
        <H n={8}>Your data and our content</H>
        <P>
          You own your business records and the content you upload. You give us permission to process them, and to send them to our service providers, to run the service for you (see the <a className="underline" href="/privacy">Privacy Policy</a>).
          Videos, receipts and other outputs we create for you are yours to use, subject to the rights of anyone whose content appears in them. We own the {LEGAL.product} software, design and brand.
        </P>
      </section>

      <section>
        <H n={9}>Availability and changes</H>
        <P>
          We work to keep {LEGAL.product} running, but we do not promise it will always be available or error-free. It depends on providers such as WhatsApp, Google and our hosts. We may add, change or remove features, and we will try
          to warn you first about changes that affect you.
        </P>
      </section>

      <section>
        <H n={10}>Ending the agreement</H>
        <P>
          You can stop using {LEGAL.product} and ask us to delete your data at any time (see the Privacy Policy, section 10). We may suspend or end your access if you break these terms, misuse the service, or put the service or other people at risk.
        </P>
      </section>

      <section>
        <H n={11}>Our responsibility</H>
        <P>
          To the fullest extent the law allows, the service is provided “as is”, and we are not liable for indirect or consequential losses, lost profit or lost business, or for decisions you make from AI-generated information.
          Our total liability to you for any claim is limited to the fees you paid us in the 3 months before the claim. Nothing in these terms limits liability that cannot be limited by law, or your rights as a consumer.
        </P>
      </section>

      <section>
        <H n={12}>Law and disputes</H>
        <P>These terms are governed by the laws of the Federal Republic of Nigeria. Please contact us first so we can try to solve any problem informally; if we cannot, the courts of competent jurisdiction in Nigeria will decide.</P>
      </section>

      <section>
        <H n={13}>Changes to these terms</H>
        <P>If we change these terms in a way that matters, we will tell you on WhatsApp or in the app before it applies. Continuing to use {LEGAL.product} after that means you accept the new terms.</P>
      </section>

      <section>
        <H n={14}>Contact</H>
        <P>{LEGAL.company}{REG_ID ? ` (${REG_ID})` : ''}{LEGAL.address ? `, ${LEGAL.address}` : ''}. Email <a className="underline" href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>{LEGAL.phone ? `, phone ${LEGAL.phone}` : ''}.</P>
      </section>
    </LegalPage>
  );
}
