'use strict';
const { createTransport } = require('nodemailer');

/** SMTP through Nodemailer. Without SMTP settings it only logs (JSON transport), so development never sends real email. */
function createMailer(cfg) {
  const transport = cfg.smtp
    ? createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.port === 465,
        auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
      })
    : createTransport({ jsonTransport: true });
  /** Messages handed to the transport (kept for tests and the dev log). */
  const outbox = [];
  return {
    outbox,
    async send(to, subject, text) {
      await transport.sendMail({ from: cfg.mailFrom, to, subject, text });
      outbox.push({ to, subject, text });
      if (!cfg.smtp && !cfg.production) console.log(`[mail] to=${to} subject="${subject}"`);
    },
  };
}

const rs = (paise) => 'Rs ' + (paise / 100).toLocaleString('en-IN');
const tpl = {
  otp: (code) => ({
    subject: `Your login code: ${code}`,
    text: `Your VanDesk code is ${code}. It is valid for 5 minutes. Do not share it.`,
  }),
  receipt: (g, child, amount, date, balance) => ({
    subject: `Payment received for ${child}`,
    text: `Hello ${g}, received ${rs(amount)} for ${child} on ${date}. Balance: ${rs(balance)}. Thank you. - VanDesk`,
  }),
  reminder: (g, child, balance) => ({
    subject: `Reminder: van fee pending for ${child}`,
    text: `Hello ${g}, ${rs(balance)} is pending for ${child}'s van fee. Please pay your driver when convenient. - VanDesk`,
  }),
  invite: (g, child) => ({
    subject: `You are invited to follow ${child}'s van`,
    text: `Hello ${g}, ${child} has been added to the school van. Sign in with this email address to see fees and trip updates. - VanDesk`,
  }),
};

module.exports = { createMailer, tpl };
