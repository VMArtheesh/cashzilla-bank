import nodemailer from 'nodemailer';

export function createMailDispatcher(db, settings) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = settings;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM) return async () => {};
  const port = Number(SMTP_PORT);
  const smtp = nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
    ...(SMTP_USER && { auth: { user: SMTP_USER, pass: SMTP_PASSWORD } }),
    connectionTimeout: 10000, socketTimeout: 20000,
  });
  const queue = db.collection('cashzilla_portal/v1/mail');
  let running = false;
  return async function dispatch() {
    if (running) return;
    running = true;
    try {
      const due = await queue.where('dueAt', '>', '').where('dueAt', '<=', new Date().toISOString()).limit(10).get();
      for (const { ref } of due.docs) {
        const job = await db.runTransaction(async tx => {
          const current = (await tx.get(ref)).data();
          if (!current || !['PENDING', 'SENDING'].includes(current.status) ||
              !current.dueAt || Date.parse(current.dueAt) > Date.now()) return null;
          tx.update(ref, { status: 'SENDING', dueAt: new Date(Date.now() + 600000).toISOString() });
          return current;
        });
        if (!job) continue;
        const decision = { APPROVED: 'approved', ON_HOLD: 'placed on hold', REJECTED: 'rejected' }[job.decision];
        try {
          await smtp.sendMail({ from: SMTP_FROM, to: job.to, subject: 'Cashzilla account application',
            messageId: '<cashzilla-' + ref.id + '@cashzilla-bank>',
            text: 'Hello ' + job.name + ',\n\nYour Cashzilla account application was ' + decision + '.' +
              (job.reason ? '\n\nMessage from Cashzilla: ' + job.reason : '') + '\n\nCashzilla Bank' });
        } catch {
          const attempts = job.attempts + 1;
          await ref.update({ attempts, status: attempts < 5 ? 'PENDING' : 'FAILED',
            dueAt: attempts < 5 ? new Date(Date.now() + attempts * 60000).toISOString() : null });
          continue;
        }
        await ref.update({ status: 'SENT', dueAt: null, sentAt: new Date().toISOString() });
      }
    } catch (error) {
      console.error('Cashzilla email queue unavailable', error.code || error.name);
    } finally {
      running = false;
    }
  };
}
