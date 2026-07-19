const contactEmail = "cagandemircioglu2010@gmail.com";

export const servicePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WhatsApp Company Assistant</title>
  </head>
  <body>
    <main>
      <h1>WhatsApp Company Assistant</h1>
      <p>This service powers a company reporting assistant on WhatsApp.</p>
      <p><a href="/privacy">Privacy policy</a></p>
      <p><a href="/data-deletion">Data deletion instructions</a></p>
    </main>
  </body>
</html>`;

export const privacyPolicyPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Privacy Policy - WhatsApp Company Assistant</title>
  </head>
  <body>
    <main>
      <h1>Privacy Policy</h1>
      <p>Last updated: July 19, 2026</p>
      <p>This policy explains how the WhatsApp Company Assistant processes information when an authorized user communicates with the service.</p>

      <h2>Information we process</h2>
      <ul>
        <li>WhatsApp identifiers, phone numbers, profile names, and message timestamps.</li>
        <li>Messages sent to the assistant and the replies generated for the user.</li>
        <li>Delivery status, authorization, rate-limit, security, and audit records.</li>
        <li>Company reporting information needed to answer an authorized request.</li>
      </ul>

      <h2>How we use information</h2>
      <p>We use information only to authenticate authorized users, answer company reporting requests, deliver WhatsApp replies, prevent abuse, troubleshoot failures, maintain security, and meet audit obligations. We do not sell personal information or use it for advertising.</p>

      <h2>Service providers</h2>
      <p>Information may be processed by Meta through the WhatsApp Cloud API, Render for application hosting, Google Gemini for response generation, and the database providers used by the service. These providers process information only as needed to operate the assistant.</p>

      <h2>Retention and security</h2>
      <p>Message content is normally retained for up to 30 days, message records for up to 90 days, and security or audit records for up to 365 days. Records may be retained longer when required for security, legal compliance, or an active legal hold. The service uses access controls, encryption, redacted logs, signed webhook verification, and read-only reporting access.</p>

      <h2>Your choices</h2>
      <p>You may request access, correction, or deletion of your information. See the <a href="/data-deletion">data deletion instructions</a>.</p>

      <h2>Contact</h2>
      <p>Email <a href="mailto:${contactEmail}">${contactEmail}</a> with privacy questions.</p>
    </main>
  </body>
</html>`;

export const dataDeletionPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Data Deletion - WhatsApp Company Assistant</title>
  </head>
  <body>
    <main>
      <h1>Data Deletion Instructions</h1>
      <p>To request deletion of information associated with your WhatsApp use of this assistant:</p>
      <ol>
        <li>Email <a href="mailto:${contactEmail}?subject=WhatsApp%20Assistant%20Data%20Deletion%20Request">${contactEmail}</a> with the subject “WhatsApp Assistant Data Deletion Request”.</li>
        <li>Send the request from an address where you can receive a verification reply.</li>
        <li>Include the WhatsApp phone number associated with the request in international format. Do not include passwords, API keys, or access tokens.</li>
      </ol>
      <p>We will verify that the requester controls the relevant account, then delete or de-identify eligible message content, account mappings, and operational records. Information required for security, legal compliance, fraud prevention, or an active legal hold may be retained until that requirement ends.</p>
      <p>We will confirm when the request has been completed or explain any information that must be retained.</p>
      <p><a href="/privacy">Return to the privacy policy</a>.</p>
    </main>
  </body>
</html>`;
