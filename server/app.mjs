import express from 'express';
import { createHash, randomBytes } from 'node:crypto';

const openingMinor = 100000;
const root = 'cashzilla_portal/v1/';
const ifscPattern = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const openStatuses = ['PENDING', 'ON_HOLD'];
const defaultLimits = { perTransferMinor: 500000, dailyMinor: 700000 };
const statuses = ['APPROVED', 'ON_HOLD', 'REJECTED'];
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function check(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}

function field(value, label, min, max) {
  const clean = typeof value === 'string' ? value.trim() : '';
  check(clean.length >= min && clean.length <= max, label + ' must have ' + min + '–' + max + ' characters.');
  return clean;
}

function minor(value, label, minimum = 1) {
  check(Number.isSafeInteger(value) && value >= minimum && value <= 100_000_000, 'Enter a valid ' + label + '.');
  return value;
}

function identityDocument(upload) {
  const types = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
  check(Object.hasOwn(types, upload?.type ?? '') && typeof upload?.data === 'string' &&
    upload.data.length <= 700_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(upload.data),
  'Upload a PDF, PNG or JPG up to 500 KB.');
  const bytes = Buffer.from(upload.data, 'base64');
  const signature = upload.type === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' :
    upload.type === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' :
      bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  check(bytes.length <= 500_000 && signature, 'The document format could not be verified.');
  return { type: upload.type, extension: types[upload.type], bytes };
}

const rows = snapshot => snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
const recent = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
const safeAccount = ({ id, accountNumber, label, customerUid, status }) => ({ id, accountNumber, label, customerUid, status });

export function createApp({ db, auth, adminUid, allowedOrigins, register, dispatch, mailConfigured = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'This portal origin is unavailable.' });
    if (origin) res.set('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Disposition',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', express.json({ limit: '750kb' }));
  app.get('/api/health', (_req, res) => res.json({ project: 'cashzilla-bank' }));
  app.post('/api/register', async (req, res) => {
    const email = field(req.body?.email, 'Email', 5, 254);
    const password = req.body?.password;
    check(typeof password === 'string' && password.length >= 8 && password.length <= 128,
      'Use a password with 8–128 characters.');
    try { await register(email, password); }
    catch (error) {
      if (error.publicStatus) throw new HttpError(error.publicStatus, error.message);
      throw error;
    }
    res.sendStatus(204);
  });

  app.use('/api', async (req, _res, next) => {
    const token = req.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    check(token && token.length <= 8192, 'Sign in to continue.', 401);
    try {
      req.identity = await auth.verifyIdToken(token, true);
    } catch {
      throw new HttpError(401, 'Your session is invalid or expired. Sign in again.');
    }
    req.isAdmin = req.identity.uid === adminUid;
    next();
  });

  const applications = db.collection(root + 'applications');
  const serviceRequests = db.collection(root + 'service_requests');
  const requestLocks = db.collection(root + 'service_request_locks');
  const beneficiaries = req => db.collection(root + 'customers').doc(req.identity.uid).collection('beneficiaries');
  const loans = db.collection(root + 'loans');
  const banks = db.collection(root + 'bank_details');
  const account = id => db.doc('accounts/' + id);
  const limit = id => db.doc('transfer_limits/' + id);
  const application = req => applications.doc(req.identity.uid);
  const portfolio = req => db.collection(root + 'customers/' + req.identity.uid + '/portfolio');
  const outbox = db.collection(root + 'mail');
  const requireAdmin = (req, _res, next) => {
    check(req.isAdmin, 'Admin access is required.', 403);
    next();
  };
  const requireCustomer = (req, _res, next) => {
    check(!req.isAdmin, 'Use a customer account for this action.', 403);
    next();
  };
  const requireId = (req, _res, next) => {
    check(idPattern.test(req.params.id), 'Invalid record ID.');
    next();
  };

  app.get('/api/me', (req, res) => res.json({ role: req.isAdmin ? 'admin' : 'customer' }));
  app.get('/api/banks', async (_req, res) => res.json(rows(await banks.get())));
  app.use('/api/customer', requireCustomer);
  app.get('/api/customer', async (req, res) => {
    const [request, positions, borrowing] = await Promise.all([
      application(req).get(), portfolio(req).get(), loans.where('uid', '==', req.identity.uid).get(),
    ]);
    res.json({ application: request.data() ?? null, portfolio: rows(positions).sort(recent), loans: rows(borrowing).sort(recent) });
  });
  app.post('/api/customer/application', async (req, res) => {
    const body = req.body ?? {};
    const record = {
      uid: req.identity.uid, email: req.identity.email,
      reference: randomBytes(16).toString('hex'),
      name: field(body.name, 'Full name', 2, 100), phone: field(body.phone, 'Phone', 7, 24),
      address: field(body.address, 'Address', 6, 300), status: 'PENDING', openingMinor, updatedAt: now(),
    };
    check(/^[+\d ()-]+$/.test(record.phone) && record.phone.replace(/\D/g, '').length >= 7, 'Enter a valid phone number.');
    check(record.email && body.openingMinor === openingMinor, 'Confirm the ₹1,000 synthetic opening balance.');
    const document = identityDocument(body.document);
    const ref = application(req);
    await db.runTransaction(async tx => {
      const previous = (await tx.get(ref)).data();
      check(!previous || previous.status === 'REJECTED', 'You already have an application on file.', 409);
      tx.set(ref, record);
      tx.set(ref.collection('private').doc('identity'), document);
    });
    res.status(201).json(record);
  });

  app.patch('/api/customer/accounts/:id', requireId, async (req, res) => {
    const label = field(req.body?.label, 'Account nickname', 1, 50);
    await changeOwnedAccount(req, { label });
    res.sendStatus(204);
  });
  async function changeOwnedAccount(req, changes) {
    const ref = account(req.params.id);
    await db.runTransaction(async tx => {
      ownedActiveAccount((await tx.get(ref)).data(), req.identity.uid);
      tx.update(ref, { ...changes, updatedAt: new Date() });
    });
  }

  function ownedActiveAccount(current, uid) {
    check(current?.customerUid === uid && current.isSynthetic === true, 'Account unavailable.', 404);
    check(current.status === 'ACTIVE', 'The account is already inactive.', 409);
  }

  function checkZeroBalance(current) {
    check(current.postedBalanceMinor === 0 && current.heldMinor === 0,
      'The account balance and any pending holds must be zero before closure.', 409);
  }

  function checkIncrease(proposed, current) {
    check(proposed.perTransferMinor >= current.perTransferMinor && proposed.dailyMinor >= current.dailyMinor &&
      (proposed.perTransferMinor > current.perTransferMinor || proposed.dailyMinor > current.dailyMinor),
      'Request a higher limit without reducing either current limit.', 409);
  }

  app.get('/api/customer/services', async (req, res) => {
    const uid = req.identity.uid;
    const [requests, accounts, onboarding] = await Promise.all([
      serviceRequests.where('uid', '==', uid).get(),
      db.collection('accounts').where('customerUid', '==', uid).get(),
      application(req).get(),
    ]);
    const active = rows(accounts).filter(item => item.isSynthetic === true && item.status === 'ACTIVE');
    const limits = await Promise.all(active.map(item => limit(item.id).get()));
    res.json({ requests: rows(requests).sort(recent), onboardingVerified: onboarding.data()?.status === 'APPROVED',
      accounts: active.map((item, index) => ({
        id: item.id, accountNumber: item.accountNumber, label: item.label,
        limits: limits[index].data() ?? defaultLimits,
      })),
    });
  });

  app.post('/api/customer/services', async (req, res) => {
    const body = req.body ?? {};
    const { kind } = body;
    check(['KYC', 'LIMIT', 'CLOSURE'].includes(kind), 'Choose a valid request type.');
    const uid = req.identity.uid;
    const accountId = kind === 'KYC' ? null : body.accountId;
    check(kind === 'KYC' || (typeof accountId === 'string' && idPattern.test(accountId)), 'Choose an account.');
    const record = { uid, email: req.identity.email ?? '', kind, accountId, status: 'PENDING', updatedAt: now(),
      customerNote: field(body.note ?? '', 'Request note', 0, 300) };
    let document;
    if (kind === 'KYC') {
      record.name = field(body.name, 'Full name', 2, 100);
      document = identityDocument(body.document);
    }
    if (kind === 'LIMIT') {
      record.perTransferMinor = minor(body.perTransferMinor, 'per-transfer limit', 0);
      record.dailyMinor = minor(body.dailyMinor, 'daily limit', 0);
      check(record.perTransferMinor <= record.dailyMinor, 'The daily limit must cover the per-transfer limit.');
    }
    const lockId = createHash('sha256').update(JSON.stringify([uid, kind, accountId])).digest('hex');
    const lock = requestLocks.doc(lockId);
    const ref = serviceRequests.doc();
    await db.runTransaction(async tx => {
      const currentLock = (await tx.get(lock)).data();
      if (currentLock) {
        const previous = (await tx.get(serviceRequests.doc(currentLock.requestId))).data();
        check(!openStatuses.includes(previous?.status), 'You already have an open request of this type.', 409);
      }
      if (accountId) {
        const current = (await tx.get(account(accountId))).data();
        ownedActiveAccount(current, uid);
        record.accountNumber = current.accountNumber;
        if (kind === 'CLOSURE') checkZeroBalance(current);
        if (kind === 'LIMIT') checkIncrease(record, (await tx.get(limit(accountId))).data() ?? defaultLimits);
      }
      tx.create(ref, record);
      if (document) tx.create(ref.collection('private').doc('identity'), document);
      tx.set(lock, { requestId: ref.id });
    });
    res.sendStatus(201);
  });

  app.delete('/api/customer/services/:id', requireId, async (req, res) => {
    const ref = serviceRequests.doc(req.params.id);
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      check(current?.uid === req.identity.uid, 'Request unavailable.', 404);
      check(openStatuses.includes(current.status), 'Only an open request can be withdrawn.', 409);
      tx.update(ref, { status: 'WITHDRAWN', updatedAt: now() });
    });
    res.sendStatus(204);
  });

  app.get('/api/customer/beneficiaries', async (req, res) => {
    res.json(rows(await beneficiaries(req).get()).sort(recent));
  });

  app.post('/api/customer/beneficiaries', async (req, res) => {
    const body = req.body ?? {};
    const name = field(body.name, 'Beneficiary name', 2, 80);
    const ifsc = field(body.ifsc, 'IFSC', 11, 11).toUpperCase();
    const accountNumber = field(body.accountNumber, 'Account number', 4, 40);
    check(ifscPattern.test(ifsc), 'Enter a valid 11-character IFSC.');
    check(/^[A-Za-z0-9-]+$/.test(accountNumber), 'Account numbers use letters, digits and hyphens.');
    const id = createHash('sha256').update(JSON.stringify([ifsc, accountNumber])).digest('hex');
    await beneficiaries(req).doc(id).set({ name, ifsc, accountNumber, updatedAt: now() });
    res.sendStatus(201);
  });

  app.delete('/api/customer/beneficiaries/:id', requireId, async (req, res) => {
    await beneficiaries(req).doc(req.params.id).delete();
    res.sendStatus(204);
  });

  function position(body) {
    return { name: field(body?.name, 'Asset name', 2, 80), category: field(body?.category, 'Category', 2, 50),
      valueMinor: minor(body?.valueMinor, 'position value', 0), updatedAt: now() };
  }
  app.post('/api/customer/portfolio', async (req, res) => {
    await portfolio(req).add(position(req.body));
    res.sendStatus(201);
  });
  app.patch('/api/customer/portfolio/:id', requireId, async (req, res) => {
    await portfolio(req).doc(req.params.id).update(position(req.body));
    res.sendStatus(204);
  });
  app.delete('/api/customer/portfolio/:id', requireId, async (req, res) => {
    await portfolio(req).doc(req.params.id).delete();
    res.sendStatus(204);
  });
  app.post('/api/customer/loans', async (req, res) => {
    const active = await db.collection('accounts').where('customerUid', '==', req.identity.uid).get();
    check(rows(active).some(row => row.status === 'ACTIVE' && row.isSynthetic === true),
      'An active Cashzilla account is required to apply for a loan.', 409);
    const months = req.body?.months;
    check(Number.isInteger(months) && months >= 1 && months <= 120, 'Enter a loan term between 1 and 120 months.');
    await loans.add({ uid: req.identity.uid, email: req.identity.email, amountMinor: minor(req.body?.amountMinor, 'loan amount'),
      purpose: field(req.body?.purpose, 'Loan purpose', 3, 300), months, status: 'PENDING', updatedAt: now() });
    res.sendStatus(201);
  });
  app.patch('/api/customer/loans/:id', requireId, async (req, res) => {
    const ref = loans.doc(req.params.id);
    await db.runTransaction(async tx => {
      const loan = (await tx.get(ref)).data();
      check(loan?.uid === req.identity.uid, 'Loan unavailable.', 404);
      if (req.body?.withdraw === true) {
        check(['PENDING', 'ON_HOLD'].includes(loan.status), 'Only pending or held requests can be withdrawn.', 409);
        tx.update(ref, { status: 'WITHDRAWN', updatedAt: now() });
      } else {
        check(loan.status !== 'WITHDRAWN', 'This loan has been withdrawn.', 409);
        tx.update(ref, { note: field(req.body?.note, 'Loan note', 0, 300), updatedAt: now() });
      }
    });
    res.sendStatus(204);
  });

  app.use('/api/admin', requireAdmin);
  app.get('/api/admin/services', async (_req, res) => {
    res.json(rows(await serviceRequests.get()).sort(recent));
  });

  app.get('/api/admin/services/:id/document', requireId, async (req, res) => {
    await sendIdentityDocument(serviceRequests.doc(req.params.id), res);
  });

  app.patch('/api/admin/services/:id', requireId, async (req, res) => {
    const status = req.body?.status;
    check(statuses.includes(status), 'Choose Approve, Hold or Reject.');
    const reason = field(req.body?.reason ?? '', 'Decision reason', 0, 300);
    const ref = serviceRequests.doc(req.params.id);
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      check(current, 'Request unavailable.', 404);
      if (current.status === status) return;
      check(openStatuses.includes(current.status), 'This request already has a final decision.', 409);
      if (status === 'APPROVED' && current.accountId) {
        const refAccount = account(current.accountId);
        const target = (await tx.get(refAccount)).data();
        ownedActiveAccount(target, current.uid);
        if (current.kind === 'LIMIT') {
          const refLimit = limit(current.accountId);
          checkIncrease(current, (await tx.get(refLimit)).data() ?? defaultLimits);
          const { accountId, dailyMinor, perTransferMinor } = current;
          tx.set(refLimit, { accountId, dailyMinor, perTransferMinor, updatedAt: new Date() }, { merge: true });
        } else if (current.kind === 'CLOSURE') {
          checkZeroBalance(target);
          tx.update(refAccount, { status: 'CLOSED', closedAt: now(), updatedAt: new Date() });
        }
      }
      tx.update(ref, { status, reason, reviewedBy: req.identity.uid, updatedAt: now() });
    });
    res.sendStatus(204);
  });

  app.get('/api/admin', async (_req, res) => {
    const [requests, borrowing, accounts, limits, messages] = await Promise.all([
      applications.get(), loans.get(), db.collection('accounts').where('isSynthetic', '==', true).get(),
      db.collection('transfer_limits').get(), outbox.orderBy('createdAt', 'desc').limit(30).get(),
    ]);
    const byAccount = new Map(rows(limits).map(item => [item.id, { perTransferMinor: item.perTransferMinor, dailyMinor: item.dailyMinor }]));
    res.json({ mailConfigured, applications: rows(requests).sort(recent), loans: rows(borrowing).sort(recent),
      accounts: rows(accounts).map(item => ({ ...safeAccount(item), limits: byAccount.get(item.id) ?? null })),
      mail: rows(messages).map(({ id, to, status, decision, createdAt }) => ({ id, to, status, decision, createdAt })),
    });
  });
  app.get('/api/admin/applications/:id/document', requireId, async (req, res) => {
    await sendIdentityDocument(applications.doc(req.params.id), res);
  });
  async function sendIdentityDocument(ref, res) {
    const document = (await ref.collection('private').doc('identity').get()).data();
    check(document, 'Document unavailable.', 404);
    res.attachment('identity.' + document.extension).type(document.type).send(Buffer.from(document.bytes));
  }
  app.patch('/api/admin/applications/:id', requireId, async (req, res) => {
    const status = req.body?.status;
    check(statuses.includes(status), 'Choose Approve, Hold or Reject.');
    const reason = field(req.body?.reason ?? '', 'Decision reason', 0, 300);
    const ref = applications.doc(req.params.id);
    const accountId = 'P643-' + randomBytes(12).toString('hex');
    const message = outbox.doc();
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      check(current, 'Application unavailable.', 404);
      check(current.reference === req.body?.reference, 'The application changed. Reload before reviewing.', 409);
      if (current.status === status) return;
      check(['PENDING', 'ON_HOLD'].includes(current.status), 'This application already has a final decision.', 409);
      if (status === 'APPROVED') {
        // A transaction provides a single opening credit even if a decision is retried.
        const opened = new Date();
        tx.create(account(accountId), { accountId, accountNumber: accountId, customerUid: current.uid, label: 'Savings account',
          isSynthetic: true, currency: 'INR', postedBalanceMinor: openingMinor, heldMinor: 0,
          status: 'ACTIVE', createdAt: opened, updatedAt: opened });
        tx.create(db.doc('ledger_entries/' + accountId + '-opening'), { entryId: accountId + '-opening',
          accountId, transferId: accountId + '-opening', direction: 'CREDIT', amountMinor: openingMinor, currency: 'INR', entryType: 'OPENING', postedAt: opened });
      }
      tx.update(ref, { status, reason, reviewedBy: req.identity.uid, updatedAt: now(),
        ...(status === 'APPROVED' && { accountId }) });
      tx.create(message, { to: current.email, name: current.name, decision: status, reason, status: 'PENDING',
        createdAt: now(), attempts: 0, dueAt: now() });
    });
    void dispatch();
    res.sendStatus(204);
  });
  app.patch('/api/admin/loans/:id', requireId, async (req, res) => {
    const status = req.body?.status;
    check(statuses.includes(status), 'Choose Approve, Hold or Reject.');
    const ref = loans.doc(req.params.id);
    const reason = field(req.body?.reason ?? '', 'Decision reason', 0, 300);
    await db.runTransaction(async tx => {
      const loan = (await tx.get(ref)).data();
      check(loan, 'Loan unavailable.', 404);
      if (loan.status === status) return;
      check(['PENDING', 'ON_HOLD'].includes(loan.status), 'This loan already has a final decision.', 409);
      tx.update(ref, { status, reason, reviewedBy: req.identity.uid, updatedAt: now() });
    });
    res.sendStatus(204);
  });
  app.patch('/api/admin/limits/:id', requireId, async (req, res) => {
    const perTransferMinor = minor(req.body?.perTransferMinor, 'per-transfer limit', 0);
    const dailyMinor = minor(req.body?.dailyMinor, 'daily limit', 0);
    check(perTransferMinor <= dailyMinor, 'The daily limit must cover the per-transfer limit.');
    const id = req.params.id;
    await db.runTransaction(async tx => {
      const current = (await tx.get(account(id))).data();
      check(current?.isSynthetic === true && current.status === 'ACTIVE', 'Active account unavailable.', 404);
      tx.set(limit(id), { accountId: id, dailyMinor, perTransferMinor, updatedAt: new Date() }, { merge: true });
    });
    res.sendStatus(204);
  });
  app.post('/api/admin/banks', async (req, res) => {
    const ifsc = field(req.body?.ifsc, 'IFSC', 11, 11).toUpperCase();
    check(ifscPattern.test(ifsc), 'Enter an 11-character IFSC with 0 as the fifth character.');
    await banks.doc(ifsc).set({ ifsc, name: field(req.body?.name, 'Bank name', 2, 100),
      address: field(req.body?.address, 'Bank address', 3, 250), updatedAt: now() });
    res.sendStatus(204);
  });
  app.delete('/api/admin/banks/:id', requireId, async (req, res) => {
    await banks.doc(req.params.id).delete();
    res.sendStatus(204);
  });
  app.post('/api/admin/mail/:id/retry', requireId, async (req, res) => {
    const ref = outbox.doc(req.params.id);
    await db.runTransaction(async tx => {
      check((await tx.get(ref)).data()?.status === 'FAILED', 'Only failed emails can be retried.', 409);
      tx.update(ref, { attempts: 0, status: 'PENDING', dueAt: now() });
    });
    void dispatch();
    res.sendStatus(204);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint unavailable.' }));
  app.use((error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status :
      error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 :
      error.code === 5 ? 404 : 500;
    if (status === 500) console.error('Cashzilla API failure', error.code || error.name);
    const message = error instanceof HttpError ? error.message :
      ({ 413: 'The document is too large.', 400: 'The request is invalid.', 404: 'Record unavailable.' })[status] ??
      'The service is temporarily unavailable.';
    res.status(status).json({ error: message });
  });

  return app;
}
