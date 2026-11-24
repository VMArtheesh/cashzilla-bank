import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, TextField } from '@mui/material';
import { ArrowRight, ArrowLeftRight, Banknote, BriefcaseBusiness, Building2, ClipboardCheck,
  Landmark, LogOut, Mail, ShieldCheck, WalletCards, ContactRound } from 'lucide-react';
import LiveBank from './LiveBank';
import { configuredEndpoint, liveApi, readStorage, saveStorage } from './live-api';
import { portalApi } from './portal-api';
import { AdminWorkspace } from './Workspaces';

const customerTabs = [
  ['accounts', 'Accounts', WalletCards], ['payments', 'Transfers', ArrowLeftRight],
  ['services', 'Account services', ShieldCheck], ['beneficiaries', 'Beneficiaries', ContactRound],
  ['portfolio', 'Portfolio', BriefcaseBusiness], ['loans', 'Loans', Banknote], ['directory', 'Bank directory', Building2],
];
const adminTabs = [
  ['applications', 'Applications', ClipboardCheck], ['services', 'Service requests', ShieldCheck], ['limits', 'Transfer limits', WalletCards],
  ['directory', 'Bank directory', Building2], ['loans', 'Loan requests', Banknote], ['mail', 'Email delivery', Mail],
];

function Brand() {
  return <div className="brand"><span className="brand-mark"><Landmark size={24} strokeWidth={1.55} /></span>
    <span>Cashzilla<span className="brand-bank">BANK</span></span></div>;
}

function SignIn({ bank, onSignIn }) {
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    const { email, password } = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      if (registering) await portalApi('/register', { method: 'POST', body: { email: email.trim(), password } });
      const session = await liveApi(configuredEndpoint, '/banks/' + bank.id + '/sign-in',
        { data: { email: email.trim(), password } });
      const { role } = await portalApi('/me', { token: session.token });
      onSignIn({ ...session, role });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="access">
    <section className="access-cover">
      <Brand />
      <div className="vault-art" aria-hidden="true"><div /><div /><div /><div /></div>
      <div className="cover-copy"><h1>Private <br />banking.</h1><p>Accounts, payments and your portfolio in one place.</p></div>
      <div className="cover-footer"><span>SHAREDBANK TEST NETWORK</span><span>{bank.ifsc}</span></div>
    </section>
    <section className="access-main">
      <div className="access-form">
        <span className="access-emblem"><ShieldCheck size={23} /></span>
        <h2>{registering ? 'Open an account' : 'Sign in'}</h2>
        <p>{registering ? 'Create a login, then submit your account application.' : 'Access your Cashzilla account or admin workspace.'}</p>
        {error && <Alert severity="error">{error}</Alert>}
        <form key={String(registering)} onSubmit={submit} className="stack">
          <TextField name="email" label="Email address" required type="email" autoComplete="username" disabled={busy} />
          <TextField name="password" label="Password" required type="password"
            autoComplete={registering ? 'new-password' : 'current-password'} disabled={busy}
            slotProps={{ htmlInput: { minLength: registering ? 8 : undefined, maxLength: 128 } }} />
          <Button type="submit" variant="contained" size="large" disabled={busy} endIcon={<ArrowRight size={17} />}>
            {busy ? 'Please wait…' : registering ? 'Create login' : 'Sign in'}
          </Button>
        </form>
        <Button disabled={busy} onClick={() => { setRegistering(!registering); setError(''); }}>
          {registering ? 'Return to sign in' : 'Apply for a Cashzilla account'}
        </Button>
      </div>
    </section>
  </main>;
}

export default function Portal({ bank, switchUrl }) {
  const storageKey = 'cashzilla-portal-session:' + bank.id;
  const [savedSession, setSavedSession] = useState(() => {
    const saved = readStorage(sessionStorage, storageKey, null);
    return typeof saved?.token === 'string' && Number.isFinite(saved.expiresAt) &&
      saved.expiresAt > Date.now() ? saved : null;
  });
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('accounts');
  const [restoreError, setRestoreError] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const logout = useCallback(() => {
    saveStorage(sessionStorage, storageKey, null);
    setSavedSession(null);
    setSession(null);
    setRestoreError(false);
  }, [storageKey]);

  const startSession = useCallback(({ token, expiresAt, email, uid, role }) => {
    saveStorage(sessionStorage, storageKey, { token, expiresAt, email, uid });
    setTab(role === 'admin' ? 'applications' : 'accounts');
    setSession({ token, expiresAt, email, uid, role });
    setSavedSession(null);
  }, [storageKey]);

  useEffect(() => {
    if (!savedSession) return undefined;
    const controller = new AbortController();
    async function restore() {
      if (savedSession.expiresAt <= Date.now()) {
        logout();
        return;
      }
      try {
        const { role } = await portalApi('/me', { token: savedSession.token, signal: controller.signal });
        if (!controller.signal.aborted) startSession({ ...savedSession, role });
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 401 || failure.status === 403) logout();
        else setRestoreError(true);
      }
    }
    void restore();
    return () => controller.abort();
  }, [savedSession, restoreAttempt, logout, startSession]);

  const expiresAt = session?.expiresAt ?? savedSession?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setTimeout(logout, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, logout]);

  if (savedSession) return <main className="access-main">
    {restoreError ? <div className="stack">
      <Alert severity="warning">Could not reconnect to Cashzilla. Check that the account server is running.</Alert>
      <Button onClick={() => { setRestoreError(false); setRestoreAttempt(attempt => attempt + 1); }}>Retry</Button>
      <Button onClick={logout}>Sign out</Button>
    </div> : <p role="status">Restoring your session…</p>}
  </main>;
  if (!session) return <SignIn bank={bank} onSignIn={startSession} />;
  const admin = session.role === 'admin';
  const tabs = admin ? adminTabs : customerTabs;
  return <div className="portal">
    <aside className="portal-nav">
      <Brand />
      <nav aria-label={admin ? 'Administration' : 'Banking'}>
        {tabs.map(([id, label, Icon]) => <button type="button" key={id} aria-current={id === tab ? 'page' : undefined}
          onClick={() => setTab(id)}><Icon size={19} strokeWidth={1.7} />{label}</button>)}
      </nav>
      <div className="portal-nav-bottom"><a href={switchUrl}><Building2 size={17} />SharedBank network</a>
        <button type="button" onClick={logout}><LogOut size={17} />Sign out</button></div>
    </aside>
    <main className="portal-main">
      <header className="identity"><span>{admin ? 'Cashzilla administration' : 'Personal banking'}</span>
        <span className="identity-email">{session.email}</span></header>
      <div className="portal-content"><h1>{tabs.find(([id]) => id === tab)?.[1]}</h1>
        {admin ? <AdminWorkspace key={tab} tab={tab} token={session.token} /> :
          <LiveBank bank={bank} session={session} tab={tab} logout={logout} />}
      </div>
    </main>
  </div>;
}
