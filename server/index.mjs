import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createApp } from './app.mjs';
import { createMailDispatcher } from './mail.mjs';

const env = process.env;
if (!env.CASHZILLA_ADMIN_UID?.trim() || !env.FIREBASE_WEB_API_KEY?.trim()) {
  throw new Error('Set CASHZILLA_ADMIN_UID and FIREBASE_WEB_API_KEY in the server environment.');
}
const projectId = 'cashzilla-bank';
const firebase = initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth(firebase);
const db = getFirestore(firebase);
const dispatch = createMailDispatcher(db, env);
const mailConfigured = Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM);
const origins = (env.PORTAL_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,https://vmartheesh.github.io')
  .split(',').map(value => value.trim()).filter(Boolean);
const app = createApp({
  db, auth, adminUid: env.CASHZILLA_ADMIN_UID, allowedOrigins: new Set(origins), dispatch, mailConfigured,
  async register(email, password) {
    const endpoint = new URL('https://identitytoolkit.googleapis.com/v1/accounts:signUp');
    endpoint.searchParams.set('key', env.FIREBASE_WEB_API_KEY);
    const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false }), signal: AbortSignal.timeout(12000) });
    if (result.ok) return;
    const data = await result.json();
    const code = data.error?.message?.split(' : ')[0];
    if (code === 'EMAIL_EXISTS') return;
    const messages = { INVALID_EMAIL: 'Enter a valid email.', WEAK_PASSWORD: 'Choose a stronger password.',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many requests. Try again shortly.' };
    if (!Object.hasOwn(messages, code)) throw new Error('Firebase registration unavailable', { cause: code });
    const error = new Error(messages[code]);
    error.publicStatus = code === 'TOO_MANY_ATTEMPTS_TRY_LATER' ? 429 : 400;
    throw error;
  },
});
app.listen(Number(env.PORT || 8788), env.BIND_HOST || '127.0.0.1', () => {
  console.log('Cashzilla bank API listening on port ' + (env.PORT || 8788));
  void dispatch();
  setInterval(dispatch, 30000).unref();
});
