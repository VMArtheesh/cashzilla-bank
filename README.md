# Cashzilla Bank

Cashzilla’s customer and administrator use the same sign-in. The SharedBank Worker authenticates Firebase email/password users and handles synthetic transfers. The Cashzilla API verifies the Firebase ID token against the `cashzilla-bank` project and selects the workspace by the configured administrator UID. The browser never chooses its own role.

## Requirements

- Node.js 22.12 or newer.
- The existing Firebase project `cashzilla-bank`, with Email/Password Auth enabled and its default Firestore database. Keep Cashzilla’s existing SharedBank registration for P643.
- Exactly one Firebase Authentication user for the application administrator. Create or select this user in the Cashzilla Firebase Console and copy its **UID**. Use the admin’s own sign-in email and password.
- Server-side Google Application Default Credentials (ADC) scoped to Cashzilla. The server must be able to access Firestore and read Firebase Auth users for ID token revocation checks. For example, grant its service identity `roles/datastore.user` and `roles/firebaseauth.viewer` on **cashzilla-bank** only. Use platform-provided ADC when hosted. For a local credential file, use an absolute path outside the repo. Keep credentials out of web builds.
- An SMTP sender for decision email delivery. The Email delivery page shows when SMTP is absent. Decisions still persist and emails remain queued until SMTP is configured and the server is running.

## Start locally with PowerShell

Copy the backend environment template:

```powershell
Copy-Item .env.server.example .env.server
```

Set `CASHZILLA_ADMIN_UID` and `FIREBASE_WEB_API_KEY` using your Cashzilla Firebase project. The web key is used for server-side customer registration. Set `GOOGLE_APPLICATION_CREDENTIALS` only if supplying a local credential file. With external ADC already configured, omit the line. Set the SMTP fields for a TLS-capable provider and restart the API when changing settings. Leave the local API port at 8788 for the Vite proxy.

Install the dependencies and start the server:

```powershell
npm.cmd ci
npm.cmd run server
```

Run the portal in a second PowerShell window:

```powershell
npm.cmd run dev -- --host localhost --port 5173 --strictPort
```

Open http://localhost:5173. Sign in as `artheesh@user.com` for the existing customer or use the configured administrator’s login. The same page resolves which workspace to show. For a new customer, use **Apply for a Cashzilla account**.

## Test the assignment

1. Register a test customer, then open **Accounts → Apply**. Enter synthetic contact details, upload a synthetic ID example as a PDF, PNG or JPG (up to 500 KB), and confirm the synthetic ₹1,000 opening balance.
2. In another browser session sign in as admin. Open **Applications**. Download the evidence and place the application on hold. Check the decision as the customer and review its email delivery entry as admin. Approve it and verify one new account and one opening credit. Test rejection using a separate synthetic customer.
3. Rename the new account as the customer. In **Account services**, submit an account closure request. Closure retains ledger history and requires a zero posted balance and zero holds at submission and at admin approval. An account is created through approval, never through a customer balance edit.
4. In **Transfer limits**, choose the account and set its per-transfer and daily rupee limits. SharedBank applies these records when funding a transfer.
5. Open **Transfers** from a customer account, type JD Bank’s IFSC `JOTH0F9K5AM`, enter an active recipient account supplied by its owner, and send ₹1 in test funds. Check **Completed**, a ₹1 debit, and the recipient’s matching transfer ID and ₹1 credit. Cashzilla’s test recipient is IFSC `ARTH0C2V7DK`, account `P64300000001`. Same-bank transfers require a second distinct active Cashzilla account.
6. Create, edit and remove a portfolio holding. Apply for a loan, review the loan as an admin, and update the customer’s note. Approval records the decision. Loan disbursement and repayment are outside the supplied SharedBank transfer contract.
7. Add or edit a bank and address from the admin directory. Customers can read matching addresses with the SharedBank directory. The central operator manages routing, IFSC registration and activation. Cashzilla’s bank records are local and can be deleted without affecting routing.

8. As a customer, use **Account services** to submit KYC evidence or request a transfer-limit increase. Use **Service requests** as admin to review the document and approve, hold, or reject requests. Customers can check the decision and withdraw pending or held requests. Opening an account still uses the separate **Applications** review.
9. Save an IFSC and account number under **Beneficiaries**. Select it in **Transfers** to fill the recipient fields. Use **Download CSV** to export the transfer activity currently shown in the portal.

## Publish

Deploy the Cashzilla Node API to a persistent HTTPS host with the server environment and `BIND_HOST=0.0.0.0` as appropriate for the host. The process runs the Nodemailer queue every 30 seconds, so use an always-running process if you need prompt delivery. SMTP delivery is retried and can be retriggered from the admin view after failure. SMTP acknowledgement and Firestore updates are separate operations, so a crash in between may occasionally cause an email retry.

Set GitHub Actions repository variable `VITE_CASHZILLA_API_URL` to the API’s HTTPS base URL without `/api`. Use **GitHub Actions** as the Pages source in `vmartheesh/cashzilla-bank`. The workflow deploys the main branch. The default Worker endpoint is built in. Leave `VITE_X42_API_URL` unset unless the SharedBank operator provides a replacement.

Verify that Firestore Security Rules deny all direct browser access to the `cashzilla_portal` private data and the shared ledger collections. Review broad or overlapping allow rules, since a matching allow overrides a denial. `firestore.server-only.rules` is a reference baseline for an exclusively API-backed bank project. Review existing rules before any deployment. The server and Worker use IAM, and updates are scoped to the Cashzilla project. Neither the Cashzilla API nor the bank management screens write to the central SharedBank database.

## Build and test

```powershell
npm.cmd run build
```

The optional API regression test uses a dedicated Firestore emulator and mock Firebase ID tokens. Set `FIRESTORE_EMULATOR_HOST` (for example `127.0.0.1:8185`), then run `npm.cmd test`. It creates disposable records in the emulator only.
