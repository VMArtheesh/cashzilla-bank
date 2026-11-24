import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Chip, MenuItem, TextField } from '@mui/material';
import { ArrowLeftRight, Landmark, List, Send } from 'lucide-react';
import { toPaise } from './amount';
import { configuredEndpoint, liveApi, readStorage, saveStorage } from './live-api';
import { CustomerWorkspace, AccountActions, Directory, CustomerServices, Beneficiaries, useBeneficiaries, downloadFile } from './Workspaces';

const money = minor => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
const time = value => value ? new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
}).format(new Date(value)) : '—';

const statusNames = {
  PENDING: 'Pending', PROCESSING: 'Processing', COMPLETED: 'Completed', REJECTED: 'Rejected', MANUAL_REVIEW: 'Manual review',
};
const rejectionNames = {
  INSUFFICIENT_FUNDS: 'Insufficient available balance',
  LIMIT_EXCEEDED: 'Transfer limit exceeded',
  DESTINATION_ACCOUNT_UNAVAILABLE: 'The destination is unavailable',
};
const ifscPattern = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const accountNumberPattern = /^[A-Za-z0-9-]{4,40}$/;
const byId = (directory, id) => directory.find(bank => bank.bankId === id)?.bankName || id;

function TransferForm({ bank, accounts, directory, directoryState, reloadDirectory, send, beneficiaries }) {
  const [type, setType] = useState('interbank');
  const [from, setFrom] = useState('');
  const [destination, setDestination] = useState('');
  const [number, setNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sources = accounts.filter(account => account.status === 'ACTIVE');
  const fromId = sources.some(item => item.accountId === from) ? from : (sources[0]?.accountId || '');
  const routes = directory.filter(item => item.bankId !== bank.id && item.status === 'ACTIVE');
  const ifsc = destination.trim().toUpperCase();
  const validIfsc = ifscPattern.test(ifsc);
  const recipientBank = directory.find(item => item.ifsc === ifsc);
  const target = type === 'internal' ? bank.ifsc : validIfsc ? ifsc : '';
  const amountMinor = toPaise(amount);
  const accountNumber = number.trim();
  const unavailable = type === 'interbank' && (ifsc === bank.ifsc ||
    (directoryState === 'ready' && validIfsc && recipientBank?.status !== 'ACTIVE'));
  let destinationHelp = 'Enter the receiving bank’s 11-character IFSC.';
  if (ifsc === bank.ifsc) destinationHelp = 'Select Same bank for this IFSC.';
  else if (recipientBank?.status === 'ACTIVE') destinationHelp = recipientBank.bankName;
  else if (validIfsc && directoryState === 'ready') destinationHelp = recipientBank
    ? 'This bank is inactive in SharedBank.' : 'This IFSC is missing from the SharedBank directory.';
  const canSubmit = fromId && target && !unavailable && accountNumberPattern.test(accountNumber) && amountMinor !== null;

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (busy || !canSubmit) return;
    setBusy(true);
    try {
      await send({ fromAccountId: fromId, destinationIfsc: target,
        destinationAccountNumber: accountNumber, amountMinor, currency: 'INR' });
      setNumber('');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <section className="panel live-transfer"><header className="panel-head"><div>
    <h2>Send a test transfer</h2><p>Transfers use synthetic balances stored in Firestore.</p>
  </div><Send size={19} /></header>
    <form className="transfer-form" onSubmit={submit}>
      <div className="type-switch">
        {[['interbank', 'Interbank'], ['internal', 'Same bank']].map(([value, label]) => <Button key={value}
          type="button" aria-pressed={type === value} variant={type === value ? 'contained' : 'outlined'}
          disabled={busy} onClick={() => setType(value)}>{label}</Button>)}
      </div>
      <TextField select label="From account" required value={fromId} onChange={e => setFrom(e.target.value)} disabled={busy || !sources.length}>
        {sources.map(account => <MenuItem key={account.accountId} value={account.accountId}>
          {account.accountNumber} · {money(account.availableMinor)} available
        </MenuItem>)}
      </TextField>
      {beneficiaries.length > 0 && <TextField select label="Saved beneficiary" value=""
        disabled={busy} onChange={event => {
          const recipient = beneficiaries.find(item => item.id === event.target.value);
          if (!recipient) return;
          setType(recipient.ifsc === bank.ifsc ? 'internal' : 'interbank');
          setDestination(recipient.ifsc);
          setNumber(recipient.accountNumber);
        }}>
        <MenuItem value="">Choose a saved beneficiary</MenuItem>
        {beneficiaries.map(item => <MenuItem key={item.id} value={item.id}>{item.name} · {item.ifsc}</MenuItem>)}
      </TextField>}
      {type === 'interbank' && <>
        <TextField label="Destination IFSC" required value={destination}
          onChange={e => setDestination(e.target.value.toUpperCase())} disabled={busy}
          error={unavailable} helperText={destinationHelp} />
        {routes.length > 0 && <TextField select label="Choose from active banks" value={routes.some(item => item.ifsc === ifsc) ? ifsc : ''}
          onChange={e => setDestination(e.target.value)} disabled={busy}>
          <MenuItem value="">Choose a bank</MenuItem>
          {routes.map(item => <MenuItem key={item.ifsc} value={item.ifsc}>{item.bankName} · {item.ifsc}</MenuItem>)}
        </TextField>}
        {directoryState === 'error' && <Alert severity="warning" action={<Button onClick={reloadDirectory}>Retry</Button>}>
          The bank list could not load. SharedBank can still check an IFSC when you submit.
        </Alert>}
      </>}
      <TextField label="Destination account number" required value={number} onChange={e => setNumber(e.target.value)} disabled={busy} />
      <TextField label="Amount in INR" required value={amount} onChange={e => setAmount(e.target.value)} disabled={busy}
        slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
      {error && <Alert severity="error">{error}</Alert>}
      <div><Button type="submit" variant="contained" disabled={busy || !canSubmit} startIcon={<Send size={16} />}>
        {busy ? 'Submitting…' : 'Submit transfer'}
      </Button></div>
    </form>
  </section>;
}

function Activity({ rows, directory }) {
  function exportTransfers() {
    const csvCell = value => {
      const text = String(value ?? '');
      const safe = /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    const header = ['Transfer ID', 'Date (IST)', 'Source bank', 'Destination bank', 'Direction', 'Amount (INR)', 'Status'];
    const data = rows.map(row => [row.transferId, time(row.createdAt), byId(directory, row.sourceBankId),
      byId(directory, row.destinationBankId), row.direction, (row.amountMinor / 100).toFixed(2), row.status]);
    const csv = [header, ...data].map(row => row.map(csvCell).join(',')).join('\r\n');
    downloadFile(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }), 'cashzilla-transfers.csv');
  }
  return <section className="panel"><header className="panel-head"><div><h2>Transfer activity</h2><p>Latest 50 transfers for this user</p></div>{rows.length ? <Button onClick={exportTransfers}>Download CSV</Button> : <List size={19} />}</header>
    {rows.length ? <div className="table-scroll"><table>
      <thead><tr><th>Transfer</th><th>Route</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.transferId}>
        <td><strong>{row.transferId}</strong><small>{time(row.createdAt)}</small></td>
        <td><strong>{byId(directory, row.sourceBankId)} → {byId(directory, row.destinationBankId)}</strong><small>
          {row.type === 'INTERNAL' ? 'Same bank' : row.direction === 'CREDIT' ? 'Incoming' : 'Outgoing'}
        </small></td>
        <td className={row.direction === 'CREDIT' ? 'incoming amount' : 'amount'}>{money(row.amountMinor)}</td>
        <td><Chip size="small" label={statusNames[row.status] || row.status}
          className={row.status === 'COMPLETED' ? 'completed' : 'live-' + row.status?.toLowerCase()} />
          {row.code && <small>{rejectionNames[row.code] || row.code.toLowerCase().replaceAll('_', ' ')}</small>}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><ArrowLeftRight size={23} /><strong>No transfers yet</strong><p>Your transfers appear here when the Worker accepts them.</p></div>}
  </section>;
}

export default function LiveBank({ bank, session, tab, logout }) {
  const beneficiaryResource = useBeneficiaries(session.token);
  const base = configuredEndpoint;
  const prefix = '/banks/' + bank.id;
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [data, setData] = useState({ accounts: [], transfers: [] });
  const [directory, setDirectory] = useState([]);
  const [directoryState, setDirectoryState] = useState('loading');
  const [directoryAttempt, setDirectoryAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const activeToken = useRef(null);
  activeToken.current = session?.token;
  const pending = useRef(new Map());
  const refresh = useCallback(async signal => {
    if (!session) return;
    try {
      const value = await liveApi(base, prefix + '/dashboard', { token: session.token, signal });
      if (signal?.aborted || activeToken.current !== session.token) return;
      setData(value);
      setLoaded(true);
      setError('');
    } catch (failure) {
      if (signal?.aborted || activeToken.current !== session.token) return;
      if (failure.status === 401) {
        logout();
      }
      setError(failure.message);
    }
  }, [base, prefix, session, logout]);

  useEffect(() => {
    if (!session) return undefined;
    const controller = new AbortController();
    const update = () => { if (document.visibilityState === 'visible') refresh(controller.signal); };
    refresh(controller.signal);
    const timer = setInterval(update, 12_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', update);
    };
  }, [session, refresh]);

  useEffect(() => {
    if (!session) return undefined;
    const controller = new AbortController();
    setDirectoryState('loading');
    liveApi(base, '/directory/banks', { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        setDirectory(value.banks || []);
        setDirectoryState('ready');
      })
      .catch(() => { if (!controller.signal.aborted) setDirectoryState('error'); });
    return () => controller.abort();
  }, [base, session, directoryAttempt]);

  async function send(transfer) {
    const raw = JSON.stringify([bank.id, base, session.uid, transfer]);
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
    const hash = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const keyName = 'x42-pending-' + hash;
    const key = pending.current.get(keyName) || readStorage(sessionStorage, keyName, null) || crypto.randomUUID();
    pending.current.set(keyName, key);
    saveStorage(sessionStorage, keyName, key);
    const row = await liveApi(base, prefix + '/transfers', { token: session.token, data: transfer, key });
    pending.current.delete(keyName);
    saveStorage(sessionStorage, keyName, null);
    const verb = row.status === 'COMPLETED' ? 'Completed' : row.status === 'REJECTED' ? 'Rejected' :
      row.status === 'MANUAL_REVIEW' ? 'Manual review' : 'Accepted';
    setNote(verb + ' · ' + row.transferId);
    await refresh();
  }

  return <>
    {error && <Alert severity="error">{error}</Alert>}
    {note && <Alert severity="info" onClose={() => setNote('')}>{note}</Alert>}
    {tab === 'accounts' && <>
      {!loaded && !error && <Alert severity="info">Loading your accounts…</Alert>}
      <div className="accounts">{data.accounts.map(account =>
        <article key={account.accountId} className={'account-card ' + (account.status === 'ACTIVE' ? '' : 'inactive-card')}>
          <div className="account-head"><span>{account.label}</span><Landmark size={24} /></div>
          <span className="balance-label">Available balance</span>
          <div className="account-value">{money(account.availableMinor)}</div>
          <div className="account-foot"><span>{account.accountNumber}</span><span>{account.status === 'ACTIVE' ? 'Held ' + money(account.heldMinor) : 'Closed'}</span></div>
          <AccountActions account={account} token={session.token} onChange={() => refresh()} />
        </article>)}</div>
    </>}
    {tab === 'payments' && <>
      {data.accounts.some(account => account.status === 'ACTIVE')
        ? <TransferForm bank={bank} accounts={data.accounts} directory={directory} directoryState={directoryState}
          reloadDirectory={() => setDirectoryAttempt(value => value + 1)} send={send}
          beneficiaries={beneficiaryResource.data ?? []} />
        : <Alert severity="info">An active account is needed to send transfers.</Alert>}
      <Activity rows={data.transfers} directory={directory} />
    </>}
    {tab === 'services' && <CustomerServices token={session.token} />}
    {tab === 'beneficiaries' && <Beneficiaries token={session.token} resource={beneficiaryResource} />}
    {tab === 'directory' && <Directory token={session.token} directory={directory} directoryState={directoryState}
      reloadDirectory={() => setDirectoryAttempt(value => value + 1)} />}
    {['accounts', 'portfolio', 'loans'].includes(tab) &&
      <CustomerWorkspace key={tab} tab={tab} token={session.token} active={data.accounts.some(account => account.status === 'ACTIVE')} />}
  </>;
}
