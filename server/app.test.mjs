import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createApp } from './app.mjs';

test('Cashzilla approvals, permissions and customer workflows', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST && 'Set FIRESTORE_EMULATOR_HOST to run against a local emulator',
}, async t => {
  const projectId = 'demo-cz-' + randomBytes(6).toString('hex');
  const firebase = initializeApp({ projectId }, projectId);
  const db = getFirestore(firebase);
  const admin = 'admin-uid';
  const customer = 'customer-uid';
  const other = 'other-uid';
  let notifications = 0;
  const app = createApp({ db, adminUid: admin, allowedOrigins: new Set(['http://localhost:5173']),
    auth: { async verifyIdToken(token) {
      if (![admin, customer, other].includes(token)) throw new Error('Invalid token');
      return { uid: token, email: token + '@example.test' };
    } },
    async register() {},
    async dispatch() { notifications++; },
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.terminate();
    await deleteApp(firebase);
  });
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = (path, token, method = 'GET', body) => fetch(origin + '/api' + path, {
    method, headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const get = async (path, token) => {
    const res = await request(path, token);
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  const expect = async (status, ...args) => {
    const res = await request(...args);
    assert.equal(res.status, status, await res.clone().text());
    return res;
  };

  await expect(401, '/me');
  assert.equal((await get('/me', customer)).role, 'customer');
  assert.equal((await get('/me', admin)).role, 'admin');
  await expect(403, '/admin', customer);
  await expect(403, '/customer', admin);
  const document = { type: 'application/pdf', data: Buffer.from('%PDF-1.7 synthetic example').toString('base64') };
  const fields = { name: 'Synthetic Customer', phone: '+91 90000 00000', address: 'Test address', openingMinor: 100000, document };
  await expect(400, '/customer/application', customer, 'POST', { ...fields, openingMinor: 999 });
  const submitted = await (await expect(201, '/customer/application', customer, 'POST', fields)).json();
  await expect(409, '/customer/application', customer, 'POST', fields);
  await expect(403, '/admin/applications/' + customer + '/document', other);
  const attachment = await expect(200, '/admin/applications/' + customer + '/document', admin);
  assert.match(attachment.headers.get('content-disposition'), /attachment/);
  assert.equal(await attachment.text(), '%PDF-1.7 synthetic example');

  const reviewPath = '/admin/applications/' + customer;
  await expect(409, reviewPath, admin, 'PATCH', { status: 'APPROVED', reference: 'stale' });
  await expect(204, reviewPath, admin, 'PATCH', { status: 'ON_HOLD', reference: submitted.reference, reason: 'Review pending' });
  assert.equal((await get('/customer', customer)).application.status, 'ON_HOLD');
  const approve = { status: 'APPROVED', reference: submitted.reference };
  await Promise.all([expect(204, reviewPath, admin, 'PATCH', approve), expect(204, reviewPath, admin, 'PATCH', approve)]);
  const overview = await get('/admin', admin);
  assert.equal(overview.accounts.length, 1);
  assert.equal(overview.mail.length, 2);
  assert.ok(notifications > 0);
  const { id } = overview.accounts[0];
  const ledger = (await db.doc('accounts/' + id).get()).data();
  assert.equal(ledger.isSynthetic, true);
  assert.equal(ledger.currency, 'INR');
  assert.equal(ledger.postedBalanceMinor, 100000);
  assert.equal(ledger.heldMinor, 0);
  assert.equal((await db.collection('ledger_entries').get()).size, 1);

  await expect(404, '/customer/accounts/' + id, other, 'PATCH', { label: 'Unauthorized' });
  await expect(204, '/customer/accounts/' + id, customer, 'PATCH', { label: 'Travel savings' });
  await expect(404, '/customer/accounts/' + id, customer, 'DELETE');
  const limits = { dailyMinor: 20000, perTransferMinor: 10000 };
  await expect(403, '/admin/limits/' + id, customer, 'PATCH', limits);
  await expect(204, '/admin/limits/' + id, admin, 'PATCH', limits);
  assert.deepEqual((await get('/admin', admin)).accounts[0].limits, limits);

  const position = { name: 'Index fund', category: 'Investments', valueMinor: 25000 };
  await expect(201, '/customer/portfolio', customer, 'POST', position);
  const [holding] = (await get('/customer', customer)).portfolio;
  await expect(404, '/customer/portfolio/' + holding.id, other, 'PATCH', position);
  await expect(204, '/customer/portfolio/' + holding.id, customer, 'PATCH', { ...position, valueMinor: 30000 });
  assert.equal((await get('/customer', customer)).portfolio[0].valueMinor, 30000);
  await expect(204, '/customer/portfolio/' + holding.id, customer, 'DELETE');
  assert.equal((await get('/customer', customer)).portfolio.length, 0);

  const loan = { amountMinor: 500000, months: 12, purpose: 'Synthetic test request' };
  await expect(409, '/customer/loans', other, 'POST', loan);
  await expect(201, '/customer/loans', customer, 'POST', loan);
  const [loanRow] = (await get('/customer', customer)).loans;
  await expect(204, '/admin/loans/' + loanRow.id, admin, 'PATCH', { status: 'APPROVED' });
  await expect(204, '/customer/loans/' + loanRow.id, customer, 'PATCH', { note: 'Reviewed' });
  assert.equal((await get('/customer', customer)).loans[0].status, 'APPROVED');

  const bank = { ifsc: 'JOTH0F9K5AM', name: 'JD Bank', address: 'Synthetic address' };
  await expect(204, '/admin/banks', admin, 'POST', bank);
  assert.equal((await get('/banks', customer))[0].address, bank.address);
  await expect(204, '/admin/banks/' + bank.ifsc, admin, 'DELETE');
  assert.equal((await get('/banks', customer)).length, 0);

  const customerServices = '/customer/services';
  const adminServices = '/admin/services';
  const approveService = { status: 'APPROVED' };
  const findRequest = async kind => (await get(customerServices, customer)).requests.find(row => row.kind === kind);
  assert.equal((await get(customerServices, customer)).onboardingVerified, true);

  const kyc = { kind: 'KYC', name: 'Synthetic Customer', document };
  const submissions = await Promise.all([
    request(customerServices, customer, 'POST', kyc),
    request(customerServices, customer, 'POST', kyc),
  ]);
  assert.deepEqual(submissions.map(res => res.status).sort(), [201, 409]);
  const kycId = (await findRequest('KYC')).id;
  await expect(403, adminServices + '/' + kycId + '/document', customer);
  await expect(200, adminServices + '/' + kycId + '/document', admin);
  await expect(204, adminServices + '/' + kycId, admin, 'PATCH', { status: 'ON_HOLD' });
  await expect(204, adminServices + '/' + kycId, admin, 'PATCH', approveService);
  assert.equal((await findRequest('KYC')).status, 'APPROVED');
  await expect(403, adminServices, customer);
  assert.equal((await get(customerServices, other)).requests.length, 0);

  const upgrade = { kind: 'LIMIT', accountId: id, dailyMinor: 40000, perTransferMinor: 20000 };
  await expect(404, customerServices, other, 'POST', upgrade);
  await expect(409, customerServices, customer, 'POST', { ...upgrade, perTransferMinor: 5000 });
  await expect(201, customerServices, customer, 'POST', upgrade);
  const limitId = (await findRequest('LIMIT')).id;
  await expect(404, customerServices + '/' + limitId, other, 'DELETE');
  assert.deepEqual((await get('/admin', admin)).accounts[0].limits, limits);
  await expect(204, adminServices + '/' + limitId, admin, 'PATCH', approveService);
  assert.deepEqual((await get('/admin', admin)).accounts[0].limits,
    { dailyMinor: upgrade.dailyMinor, perTransferMinor: upgrade.perTransferMinor });
  await expect(201, customerServices, customer, 'POST', { ...upgrade, dailyMinor: 45000 });
  const outdated = (await get(adminServices, admin)).find(row => row.kind === 'LIMIT' && row.status === 'PENDING');
  await expect(204, '/admin/limits/' + id, admin, 'PATCH', { dailyMinor: 50000, perTransferMinor: 25000 });
  await expect(409, adminServices + '/' + outdated.id, admin, 'PATCH', approveService);
  await expect(204, customerServices + '/' + outdated.id, customer, 'DELETE');
  await expect(409, adminServices + '/' + outdated.id, admin, 'PATCH', approveService);

  const beneficiary = { name: 'Test payee', ifsc: 'joth0f9k5am', accountNumber: 'P63300000001' };
  await expect(201, '/customer/beneficiaries', customer, 'POST', beneficiary);
  const [saved] = await get('/customer/beneficiaries', customer);
  assert.equal(saved.ifsc, 'JOTH0F9K5AM');
  assert.deepEqual(await get('/customer/beneficiaries', other), []);
  await expect(204, '/customer/beneficiaries/' + saved.id, other, 'DELETE');
  assert.equal((await get('/customer/beneficiaries', customer)).length, 1);
  await expect(204, '/customer/beneficiaries/' + saved.id, customer, 'DELETE');
  assert.deepEqual(await get('/customer/beneficiaries', customer), []);

  const closure = { kind: 'CLOSURE', accountId: id };
  await expect(409, customerServices, customer, 'POST', closure);
  await db.doc('accounts/' + id).update({ postedBalanceMinor: 0 });
  await expect(201, customerServices, customer, 'POST', closure);
  const closureId = (await findRequest('CLOSURE')).id;
  assert.equal((await db.doc('accounts/' + id).get()).data().status, 'ACTIVE');
  await db.doc('accounts/' + id).update({ postedBalanceMinor: 100, heldMinor: 100 });
  await expect(409, adminServices + '/' + closureId, admin, 'PATCH', approveService);
  await db.doc('accounts/' + id).update({ postedBalanceMinor: 0, heldMinor: 0 });
  await expect(204, adminServices + '/' + closureId, admin, 'PATCH', approveService);
  assert.equal((await db.doc('accounts/' + id).get()).data().status, 'CLOSED');
  assert.equal((await db.collection('ledger_entries').get()).size, 1);
});
