import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Chip, Dialog, MenuItem, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import { ArrowUpRight, FileDown, PencilLine } from 'lucide-react';
import { toPaise } from './amount';
import { configuredEndpoint, liveApi } from './live-api';
import { portalApi } from './portal-api';

const format = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const money = minor => format.format(minor / 100);
const statusLabels = { PENDING: 'Pending', APPROVED: 'Approved', ON_HOLD: 'On hold', REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn', ACTIVE: 'Active', INACTIVE: 'Inactive', CLOSED: 'Closed', SENT: 'Sent',
  FAILED: 'Failed', SENDING: 'Sending' };
const rupees = minor => (minor / 100).toFixed(2);
function amount(value) {
  if (/^0+(\.0{1,2})?$/.test(value.trim())) return 0;
  const minor = toPaise(value);
  if (minor === null) throw new Error('Enter an amount with at most two decimal places.');
  return minor;
}

function Status({ value }) {
  return <Chip size="small" className={'status status-' + String(value).toLowerCase()} label={statusLabels[value] || value} />;
}
function Panel({ title, detail, action, children }) {
  return <section className="panel"><header className="panel-head">
    <div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{action}
  </header>{children}</section>;
}
function Input({ name, label, value, multiline = false, numeric = false, required = true, maxLength = 100, ...props }) {
  return <TextField name={name} label={label} defaultValue={value} multiline={multiline}
    minRows={multiline ? 2 : undefined} required={required} fullWidth
    slotProps={{ htmlInput: { maxLength, inputMode: numeric ? 'decimal' : undefined } }} {...props} />;
}
function loadDocument(file) {
  if (!file || file.size > 500000) throw new Error('Choose a PDF, PNG or JPG up to 500 KB.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the document.'));
    reader.onload = () => resolve({ type: file.type, data: reader.result.split(',')[1] });
    reader.readAsDataURL(file);
  });
}

function useApiResource(path, token) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    portalApi(path, { token, signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [path, token, revision]);
  return { data, error, reload };
}

function ResourceState({ resource }) {
  if (resource.error) return <Alert severity="error" action={<Button onClick={resource.reload}>Retry</Button>}>{resource.error}</Alert>;
  if (!resource.data) return <p role="status">Loading…</p>;
  return null;
}

function ActionDialog({ title, actionLabel = 'Save', close, save, children }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try { await save(fields); close(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Dialog fullWidth maxWidth="sm" open onClose={busy ? undefined : close} aria-labelledby="action-title">
    <form onSubmit={submit}>
      <DialogTitle id="action-title">{title}</DialogTitle>
      <DialogContent className="dialog-fields">
        {error && <Alert severity="error">{error}</Alert>}
        <fieldset disabled={busy} className="stack form-fields">{children}</fieldset>
      </DialogContent>
      <DialogActions><Button onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={busy}>{busy ? 'Saving…' : actionLabel}</Button></DialogActions>
    </form>
  </Dialog>;
}

export function AccountActions({ account, token, onChange }) {
  const [mode, setMode] = useState('');
  if (account.status !== 'ACTIVE') return null;
  return <>
    <div className="card-actions">
      <button type="button" onClick={() => setMode('rename')}><PencilLine size={14} /> Rename</button>
    </div>
    {mode && <ActionDialog title="Rename account" close={() => setMode('')} save={async fields => {
      await portalApi('/customer/accounts/' + account.accountId, { token, method: 'PATCH', body: fields });
      onChange();
    }}>
      <Input name="label" label="Account nickname" value={account.label} maxLength={50} />
    </ActionDialog>}
  </>;
}

function Applications({ request, token, reload, active }) {
  const [applying, setApplying] = useState(false);
  if (!request && active) return null;
  return <Panel title="Account application" detail="Apply for a savings account with a ₹1,000 synthetic opening balance."
    action={(!request || request.status === 'REJECTED') &&
      <Button variant="contained" onClick={() => setApplying(true)}>Apply</Button>}>
    {request && ['PENDING', 'ON_HOLD'].includes(request.status) && <Button onClick={reload}>Refresh status</Button>}
    {request && <div className="record"><div><strong>{request.name}</strong><small>{request.reason || 'Savings account application'}</small></div>
      <Status value={request.status} /></div>}
    {applying && <ActionDialog title="Savings account application" actionLabel="Submit application" close={() => setApplying(false)}
      save={async fields => {
        const document = await loadDocument(fields.identity);
        await portalApi('/customer/application', { token, method: 'POST', body: {
          name: fields.name, address: fields.address, phone: fields.phone, openingMinor: 100000, document,
        } });
        reload();
      }}>
      <Input name="name" label="Full name" value={request?.name} />
      <Input name="phone" label="Phone" value={request?.phone} type="tel" maxLength={24} />
      <Input name="address" label="Address" value={request?.address} multiline maxLength={300} />
      <label className="file-field">Test identity document (PDF, JPG or PNG, 500 KB max)
        <input name="identity" type="file" accept="application/pdf,image/jpeg,image/png" required />
      </label>
      <label className="check-field"><input type="checkbox" required /> Confirm opening balance of ₹1,000 in test funds</label>
    </ActionDialog>}
  </Panel>;
}

function Portfolio({ rows, token, reload }) {
  const [draft, setDraft] = useState(null);
  const total = rows.reduce((sum, row) => sum + row.valueMinor, 0);
  const removing = draft?.remove;
  return <Panel title="Portfolio holdings" detail={'Total recorded value · ' + money(total)}
    action={<Button variant="contained" onClick={() => setDraft({})}>Add holding</Button>}>
    {!rows.length && <p className="empty-copy">You haven’t recorded any holdings.</p>}
    {rows.map(row => <div className="record" key={row.id}>
      <div><strong>{row.name}</strong><small>{row.category}</small></div>
      <div className="row-actions"><strong>{money(row.valueMinor)}</strong>
        <Button onClick={() => setDraft(row)}>Edit</Button><Button onClick={() => setDraft({ ...row, remove: true })}>Remove</Button></div>
    </div>)}
    {draft && <ActionDialog title={removing ? 'Remove holding' : draft.id ? 'Edit holding' : 'Add holding'}
      close={() => setDraft(null)} actionLabel={removing ? 'Remove' : 'Save'} save={async fields => {
        await portalApi('/customer/portfolio' + (draft.id ? '/' + draft.id : ''), { token,
          method: removing ? 'DELETE' : draft.id ? 'PATCH' : 'POST',
          body: removing ? undefined : { name: fields.name, category: fields.category, valueMinor: amount(fields.value) } });
        reload();
      }}>
      {removing ? <p>Remove {draft.name} from your portfolio?</p> : <>
        <Input name="name" label="Asset name" value={draft.name} maxLength={80} />
        <Input name="category" label="Category" value={draft.category} maxLength={50} />
        <Input name="value" label="Recorded value in INR" numeric value={draft.id ? rupees(draft.valueMinor) : ''} />
      </>}
    </ActionDialog>}
  </Panel>;
}

function LoanRequests({ rows, token, reload, active }) {
  const [draft, setDraft] = useState(null);
  return <Panel title="Your loan applications" detail={active ? undefined : 'An active account is needed to apply.'}
    action={<Button variant="contained" disabled={!active} onClick={() => setDraft({})}>Apply for a loan</Button>}>
    {!rows.length && <p className="empty-copy">You haven’t applied for a loan.</p>}
    {rows.map(row => <div className="record" key={row.id}>
      <div><strong>{money(row.amountMinor)} · {row.months} months</strong><small>{row.purpose}</small>
        {row.reason && <small>Admin decision: {row.reason}</small>}{row.note && <small>Your note: {row.note}</small>}</div>
      <div className="row-actions"><Status value={row.status} />
        {row.status !== 'WITHDRAWN' && <Button onClick={() => setDraft(row)}>Edit note</Button>}
        {['PENDING', 'ON_HOLD'].includes(row.status) &&
          <Button onClick={() => setDraft({ ...row, withdraw: true })}>Withdraw</Button>}</div>
    </div>)}
    {draft && <ActionDialog close={() => setDraft(null)} title={draft.withdraw ? 'Withdraw loan request' : draft.id ? 'Edit loan note' : 'Loan application'}
      actionLabel={draft.withdraw ? 'Withdraw' : draft.id ? 'Save' : 'Submit application'} save={async fields => {
        let body = { withdraw: true };
        if (!draft.id) body = { amountMinor: amount(fields.value), purpose: fields.purpose, months: Number(fields.months) };
        else if (!draft.withdraw) body = { note: fields.note };
        await portalApi('/customer/loans' + (draft.id ? '/' + draft.id : ''), { token, method: draft.id ? 'PATCH' : 'POST', body });
        reload();
      }}>
      {draft.withdraw ? <p>Withdraw your request for {money(draft.amountMinor)}?</p> : draft.id ?
        <Input name="note" label="Personal note" value={draft.note} multiline required={false} maxLength={300} /> : <>
          <Input name="value" label="Requested amount in INR" numeric />
          <Input name="months" label="Term in months" numeric />
          <Input name="purpose" label="Purpose" multiline maxLength={300} />
        </>}
    </ActionDialog>}
  </Panel>;
}

export function CustomerWorkspace({ tab, token, active }) {
  const resource = useApiResource('/customer', token);
  return <><ResourceState resource={resource} />
    {resource.data && (tab === 'accounts' ? <Applications request={resource.data.application} token={token} active={active} reload={resource.reload} /> :
      tab === 'portfolio' ? <Portfolio rows={resource.data.portfolio} token={token} reload={resource.reload} /> :
        <LoanRequests rows={resource.data.loans} token={token} active={active} reload={resource.reload} />)}
  </>;
}

export function Directory({ token, admin = false, directory, directoryState, reloadDirectory }) {
  const local = useApiResource('/banks', token);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState(null);
  const matches = value => value.toLowerCase().includes(search.trim().toLowerCase());
  const addresses = new Map((local.data ?? []).map(bank => [bank.ifsc, bank.address]));
  return <>
    <ResourceState resource={local} />
    <Panel title="SharedBank directory" detail="Routing availability comes from the SharedBank network.">
      <TextField label="Search bank name or IFSC" value={search} fullWidth onChange={event => setSearch(event.target.value)} />
      {directoryState === 'loading' && <p role="status">Loading bank directory…</p>}
      {directoryState === 'error' && <Alert severity="warning" action={<Button onClick={reloadDirectory}>Retry</Button>}>The SharedBank directory could not load.</Alert>}
      <div className="table-scroll"><table><thead><tr><th>Bank</th><th>IFSC</th><th>Status</th><th>Address</th></tr></thead>
        <tbody>{directory.filter(bank => matches(bank.bankName + ' ' + bank.ifsc)).map(bank => <tr key={bank.bankId}>
          <td>{bank.portalUrl?.startsWith('https://') ? <a href={bank.portalUrl} target="_blank" rel="noreferrer">{bank.bankName} <ArrowUpRight size={13} /></a> :
            bank.bankName}</td><td className="mono">{bank.ifsc}</td><td><Status value={bank.status} /></td>
          <td>{addresses.get(bank.ifsc) || '—'}</td></tr>)}</tbody>
      </table></div>
      {directoryState === 'ready' && !directory.some(bank => matches(bank.bankName + ' ' + bank.ifsc)) &&
        <p className="empty-copy">No matching SharedBank records.</p>}
    </Panel>
    {admin && <Panel title="Cashzilla bank records" detail="Edit local bank details and addresses."
      action={<Button variant="contained" onClick={() => setDraft({})}>Add bank record</Button>}>
      {(local.data ?? []).map(bank => <div className="record" key={bank.id}>
        <div><strong>{bank.name}</strong><small>{bank.ifsc} · {bank.address}</small></div>
        <div className="row-actions"><Button onClick={() => setDraft(bank)}>Edit</Button>
          <Button onClick={() => setDraft({ ...bank, remove: true })}>Remove</Button></div>
      </div>)}
    </Panel>}
    {admin && draft && <ActionDialog close={() => setDraft(null)} title={draft.remove ? 'Remove bank record' : 'Bank record'}
      actionLabel={draft.remove ? 'Remove' : 'Save'} save={async fields => {
        await portalApi(draft.remove ? '/admin/banks/' + draft.id : '/admin/banks',
          { token, method: draft.remove ? 'DELETE' : 'POST', body: draft.remove ? undefined : fields });
        local.reload();
      }}>
      {draft.remove ? <p>Remove the local record for {draft.name}?</p> : <>
        <Input name="ifsc" label="IFSC" value={draft.ifsc} maxLength={11} slotProps={{ htmlInput: { maxLength: 11, readOnly: Boolean(draft.id) } }} />
        <Input name="name" label="Bank name" value={draft.name} />
        <Input name="address" label="Bank address" value={draft.address} multiline maxLength={250} />
      </>}
    </ActionDialog>}
  </>;
}

function AdminDirectory({ token }) {
  const [directory, setDirectory] = useState([]);
  const [state, setState] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    liveApi(configuredEndpoint, '/directory/banks', { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) { setDirectory(result.banks || []); setState('ready'); }
      }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [attempt]);
  return <Directory token={token} admin directory={directory} directoryState={state} reloadDirectory={() => setAttempt(value => value + 1)} />;
}

function Reviews({ rows, token, reload, accountRequests }) {
  const [decision, setDecision] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  async function download(id) {
    setDownloadError('');
    try {
      const { blob, filename } = await portalApi('/admin/applications/' + id + '/document', { token, download: true });
      downloadFile(blob, filename || 'identity');
    } catch (failure) { setDownloadError(failure.message); }
  }
  return <Panel title={accountRequests ? 'Customer account requests' : 'Customer loan requests'}>
    {downloadError && <Alert severity="error">{downloadError}</Alert>}
    {!rows.length && <p className="empty-copy">There are no requests to review.</p>}
    {rows.map(row => <article className="review" key={row.id}>
      <header><div><h3>{accountRequests ? row.name : money(row.amountMinor) + ' · ' + row.months + ' months'}</h3>
        <small>{row.email}</small></div><Status value={row.status} /></header>
      <p>{accountRequests ? row.phone + ' · ' + row.address : row.purpose}</p>
      {row.reason && <p className="muted">{row.reason}</p>}
      <div className="row-actions">
        {accountRequests && <Button startIcon={<FileDown size={16} />} onClick={() => download(row.id)}>Identity document</Button>}
        {['PENDING', 'ON_HOLD'].includes(row.status) && <>
          <Button variant="contained" onClick={() => setDecision({ row, status: 'APPROVED', label: 'Approve' })}>Approve</Button>
          {row.status === 'PENDING' && <Button onClick={() => setDecision({ row, status: 'ON_HOLD', label: 'Hold' })}>Hold</Button>}
          <Button color="error" onClick={() => setDecision({ row, status: 'REJECTED', label: 'Reject' })}>Reject</Button>
        </>}
      </div>
    </article>)}
    {decision && <ActionDialog close={() => setDecision(null)} title={decision.label + ' ' + (accountRequests ? 'account application' : 'loan request')}
      actionLabel={decision.label} save={async fields => {
        await portalApi('/admin/' + (accountRequests ? 'applications' : 'loans') + '/' + decision.row.id,
          { token, method: 'PATCH', body: { status: decision.status, reason: fields.reason, reference: decision.row.reference } });
        reload();
      }}>
      {decision.status === 'APPROVED' && accountRequests && <p>Approval opens a savings account and posts a ₹1,000 synthetic balance.</p>}
      <Input name="reason" label={accountRequests ? 'Message to customer' : 'Decision note'} multiline maxLength={300} required={false} />
    </ActionDialog>}
  </Panel>;
}

function Limits({ accounts, token, reload }) {
  const [draft, setDraft] = useState(null);
  return <Panel title="Account transfer limits" detail="Daily limits follow India Standard Time.">
    {!accounts.length && <p className="empty-copy">There are no accounts to manage.</p>}
    {accounts.map(row => <div className="record" key={row.id}>
      <div><strong>{row.accountNumber}</strong><small>{row.label} · {row.customerUid}</small>
        <small>{money(row.limits?.perTransferMinor ?? 500000)} per transfer · {money(row.limits?.dailyMinor ?? 700000)} per day</small></div>
      <div className="row-actions"><Status value={row.status} />
        <Button disabled={row.status !== 'ACTIVE'} onClick={() => setDraft(row)}>Edit limits</Button></div>
    </div>)}
    {draft && <ActionDialog close={() => setDraft(null)} title="Transfer limits" save={async fields => {
      await portalApi('/admin/limits/' + draft.id, { token, method: 'PATCH', body: {
        perTransferMinor: amount(fields.single), dailyMinor: amount(fields.daily),
      } });
      reload();
    }}>
      <Input name="single" label="Per transfer in INR" numeric value={rupees(draft.limits?.perTransferMinor ?? 500000)} />
      <Input name="daily" label="Per day in INR" numeric value={rupees(draft.limits?.dailyMinor ?? 700000)} />
    </ActionDialog>}
  </Panel>;
}

function MailQueue({ rows, token, reload, configured }) {
  const [draft, setDraft] = useState(null);
  return <Panel title="Account decision emails" detail="Latest 30 notifications."
    action={<Button onClick={reload}>Refresh</Button>}>
    {!configured && <Alert severity="warning">Put SMTP settings in the Cashzilla server environment to send queued notifications.</Alert>}
    {!rows.length && <p className="empty-copy">There are no decision emails yet.</p>}
    {rows.map(row => <div className="record" key={row.id}>
      <div><strong>{row.to}</strong><small>{statusLabels[row.decision]} · {new Date(row.createdAt).toLocaleString('en-IN')}</small></div>
      <div className="row-actions"><Status value={row.status} />
        {row.status === 'FAILED' && <Button onClick={() => setDraft(row)}>Retry</Button>}</div>
    </div>)}
    {draft && <ActionDialog close={() => setDraft(null)} title="Retry notification" actionLabel="Retry" save={async () => {
      await portalApi('/admin/mail/' + draft.id + '/retry', { token, method: 'POST' });
      reload();
    }}><p>Queue the decision email for {draft.to} again?</p></ActionDialog>}
  </Panel>;
}

function AdminData({ tab, token }) {
  const resource = useApiResource('/admin', token);
  const { data, reload } = resource;
  return <><ResourceState resource={resource} />
    {data && (tab === 'applications' ? <Reviews rows={data.applications} accountRequests token={token} reload={reload} /> :
      tab === 'loans' ? <Reviews rows={data.loans} token={token} reload={reload} /> :
        tab === 'limits' ? <Limits accounts={data.accounts} token={token} reload={reload} /> :
          <MailQueue rows={data.mail} token={token} reload={reload} configured={data.mailConfigured} />)}
  </>;
}

export function AdminWorkspace({ tab, token }) {
  if (tab === 'services') return <AdminServices token={token} />;
  return tab === 'directory' ? <AdminDirectory token={token} /> : <AdminData tab={tab} token={token} />;
}

const serviceLabels = { KYC: 'KYC verification', LIMIT: 'Limit upgrade', CLOSURE: 'Account closure' };
const isOpen = row => ['PENDING', 'ON_HOLD'].includes(row.status);

export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ServiceDetails({ row }) {
  return <>
    {row.accountNumber && <small>Account {row.accountNumber}</small>}
    {row.kind === 'LIMIT' && <small>{money(row.perTransferMinor)} per transfer · {money(row.dailyMinor)} per day requested</small>}
    {row.customerNote && <small>Customer note: {row.customerNote}</small>}
    {row.reason && <small>Admin decision: {row.reason}</small>}
  </>;
}

export function CustomerServices({ token }) {
  const resource = useApiResource('/customer/services', token);
  const { data, reload } = resource;
  const [draft, setDraft] = useState(null);
  if (!data) return <ResourceState resource={resource} />;
  const latestKyc = data.requests.find(row => row.kind === 'KYC');
  return <>
    <ResourceState resource={resource} />
    <Panel title="Identity verification" action={<Button variant="contained" disabled={Boolean(latestKyc && isOpen(latestKyc))}
      onClick={() => setDraft({ kind: 'KYC' })}>Submit KYC</Button>}>
      {latestKyc ? <p>Latest KYC submission: <Status value={latestKyc.status} /></p> :
        <p>{data.onboardingVerified ? 'Identity reviewed during account opening.' : 'You have no KYC review on file.'}</p>}
    </Panel>
    <Panel title="Manage transfer limits and account closure" detail="Account requests are reviewed by an administrator.">
      {!data.accounts.length && <p>No active accounts.</p>}
      {data.accounts.map(account => <div className="record" key={account.id}>
        <div><strong>{account.label || 'Account'} · {account.accountNumber}</strong>
          <small>{money(account.limits.perTransferMinor)} per transfer · {money(account.limits.dailyMinor)} per day</small></div>
        <div className="row-actions">
          {['LIMIT', 'CLOSURE'].map(kind => <Button key={kind}
            disabled={data.requests.some(row => row.kind === kind && row.accountId === account.id && isOpen(row))}
            onClick={() => setDraft({ kind, account })}>{kind === 'LIMIT' ? 'Request limit upgrade' : 'Request closure'}</Button>)}
        </div>
      </div>)}
    </Panel>
    <Panel title="Request history" action={<Button onClick={reload}>Refresh status</Button>}>
      {!data.requests.length && <p className="empty-copy">No service requests yet.</p>}
      {data.requests.map(row => <div className="record" key={row.id}>
        <div><strong>{serviceLabels[row.kind]}</strong><ServiceDetails row={row} /></div>
        <div className="row-actions"><Status value={row.status} />
          {isOpen(row) && <Button onClick={() => setDraft({ kind: row.kind, withdraw: row.id })}>Withdraw</Button>}</div>
      </div>)}
    </Panel>
    {draft && <ActionDialog title={draft.withdraw ? 'Withdraw request' : serviceLabels[draft.kind]}
      actionLabel={draft.withdraw ? 'Withdraw' : 'Submit request'} close={() => setDraft(null)} save={async fields => {
        if (draft.withdraw) {
          await portalApi('/customer/services/' + draft.withdraw, { token, method: 'DELETE' });
        } else {
          const body = { kind: draft.kind, accountId: draft.account?.id, note: fields.note };
          if (draft.kind === 'KYC') {
            body.name = fields.name;
            body.document = await loadDocument(fields.identity);
          }
          if (draft.kind === 'LIMIT') {
            body.perTransferMinor = amount(fields.single);
            body.dailyMinor = amount(fields.daily);
          }
          await portalApi('/customer/services', { token, method: 'POST', body });
        }
        reload();
      }}>
      {draft.withdraw ? <p>Withdraw this {serviceLabels[draft.kind].toLowerCase()} request?</p> : <>
        {draft.kind === 'KYC' && <>
          <Input name="name" label="Full name" />
          <label className="file-field">Test identity document (PDF, JPG or PNG, 500 KB max)
            <input name="identity" type="file" accept="application/pdf,image/jpeg,image/png" required />
          </label>
        </>}
        {draft.kind === 'LIMIT' && <>
          <Input name="single" label="New per-transfer limit in INR" numeric value={rupees(draft.account.limits.perTransferMinor)} />
          <Input name="daily" label="New daily limit in INR" numeric value={rupees(draft.account.limits.dailyMinor)} />
        </>}
        {draft.kind === 'CLOSURE' && <p>Account {draft.account.accountNumber} must have a zero balance and no pending holds. Closure preserves transfer history.</p>}
        <Input name="note" label="Note to admin" multiline required={false} maxLength={300} />
      </>}
    </ActionDialog>}
  </>;
}

function AdminServices({ token }) {
  const resource = useApiResource('/admin/services', token);
  const [decision, setDecision] = useState(null);
  const [filter, setFilter] = useState('OPEN');
  const [error, setError] = useState('');
  const visible = (resource.data ?? []).filter(row => filter === 'ALL' || (filter === 'OPEN' ? isOpen(row) : row.kind === filter));
  async function download(id) {
    setError('');
    try {
      const { blob, filename } = await portalApi('/admin/services/' + id + '/document', { token, download: true });
      downloadFile(blob, filename || 'identity');
    } catch (failure) { setError(failure.message); }
  }
  return <>
    <ResourceState resource={resource} />
    {resource.data && <Panel title="Review customer requests" action={<Button onClick={resource.reload}>Refresh</Button>}>
      <TextField select label="Filter requests" size="small" value={filter} onChange={event => setFilter(event.target.value)}>
        {Object.entries({ OPEN: 'Open requests', ALL: 'All requests', ...serviceLabels }).map(([value, label]) =>
          <MenuItem key={value} value={value}>{label}</MenuItem>)}
      </TextField>
      {error && <Alert severity="error">{error}</Alert>}
      {!visible.length && <p>No matching requests.</p>}
      {visible.map(row => <article className="review" key={row.id}>
        <header><div><h3>{serviceLabels[row.kind]}</h3><small>{row.name ? row.name + ' · ' : ''}{row.email}</small></div>
          <Status value={row.status} /></header>
        <ServiceDetails row={row} />
        <div className="row-actions">
          {row.kind === 'KYC' && <Button startIcon={<FileDown size={16} />} onClick={() => download(row.id)}>Identity document</Button>}
          {isOpen(row) && [['APPROVED', 'Approve'], ['ON_HOLD', 'Hold'], ['REJECTED', 'Reject']]
            .filter(([status]) => status !== row.status).map(([status, label]) =>
              <Button key={status} variant={status === 'APPROVED' ? 'contained' : 'text'}
                onClick={() => setDecision({ row, status, label })}>{label}</Button>)}
        </div>
      </article>)}
    </Panel>}
    {decision && <ActionDialog title={decision.label + ' · ' + serviceLabels[decision.row.kind]}
      actionLabel={decision.label} close={() => setDecision(null)} save={async fields => {
        await portalApi('/admin/services/' + decision.row.id, { token, method: 'PATCH',
          body: { status: decision.status, reason: fields.reason } });
        resource.reload();
      }}>
      {decision.status === 'APPROVED' && decision.row.kind === 'CLOSURE' &&
        <p>Close account {decision.row.accountNumber} after verifying its balance and holds are zero.</p>}
      <Input name="reason" label="Decision note" multiline required={false} maxLength={300} />
    </ActionDialog>}
  </>;
}

export function useBeneficiaries(token) {
  return useApiResource('/customer/beneficiaries', token);
}

export function Beneficiaries({ token, resource }) {
  const [draft, setDraft] = useState(null);
  return <>
    <ResourceState resource={resource} />
    {resource.data && <Panel title="Saved beneficiaries" detail="Choose any saved beneficiary from the transfer form."
      action={<Button variant="contained" onClick={() => setDraft({})}>Add beneficiary</Button>}>
      {!resource.data.length && <p className="empty-copy">You haven’t saved any beneficiaries.</p>}
      {resource.data.map(row => <div className="record" key={row.id}>
        <div><strong>{row.name}</strong><small>{row.ifsc} · {row.accountNumber}</small></div>
        <Button onClick={() => setDraft(row)}>Remove</Button>
      </div>)}
    </Panel>}
    {draft && <ActionDialog title={draft.id ? 'Remove beneficiary' : 'Save beneficiary'} close={() => setDraft(null)}
      actionLabel={draft.id ? 'Remove' : 'Save'} save={async fields => {
        await portalApi('/customer/beneficiaries' + (draft.id ? '/' + draft.id : ''),
          { token, method: draft.id ? 'DELETE' : 'POST', body: draft.id ? undefined : fields });
        resource.reload();
      }}>
      {draft.id ? <p>Remove {draft.name} from your saved beneficiaries?</p> : <>
        <Input name="name" label="Beneficiary name" maxLength={80} />
        <Input name="ifsc" label="Bank IFSC" maxLength={11} />
        <Input name="accountNumber" label="Account number" maxLength={40} />
      </>}
    </ActionDialog>}
  </>;
}
