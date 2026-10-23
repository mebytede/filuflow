// Oracle for M40 (test/oracle/gmail-mime.json): what n8n 1.123.0 (n8n-nodes-base 1.121.0, Gmail GenericFunctions
// parseRawEmail and encodeEmail) gets from mailparser 3.6.7 and nodemailer 7.0.10. Run with a folder that contains
// both packages, e.g.:
//   mkdir /tmp/mo && cd /tmp/mo && npm install mailparser@3.6.7 nodemailer@7.0.10
//   node scripts/gmail-mime-oracle.mjs /tmp/mo > test/oracle/gmail-mime.json
// "parse": raw messages and the JSON parseRawEmail builds from them (without binary data; attachments as name, type
// and base64). "compose": encodeEmail options and the parsed result of the message nodemailer builds from them.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/gmail-mime-oracle.mjs <folder with node_modules/mailparser and nodemailer>');
  process.exit(1);
}
const require = createRequire(join(base, 'noop.js'));
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');

const CRLF = (s) => s.replace(/\r?\n/g, '\r\n');

const parseCases = [
  {
    name: 'plain ascii',
    raw: CRLF(`From: Alice <alice@example.com>\nTo: bob@example.com\nSubject: Hello\nDate: Tue, 01 Sep 2026 10:00:00 +0200\nMessage-ID: <abc@example.com>\n\nHello Bob,\nsee you.\n`),
  },
  {
    name: 'alternative quoted-printable latin1',
    raw: CRLF(
      `From: =?ISO-8859-1?Q?J=F6rg_M=FCller?= <joerg@example.de>\nTo: "Doe, John" <john@example.com>, Group: a@b.de, c@d.de;\nCc: x@example.com\nCc: y@example.com\nSubject: =?UTF-8?B?R3LDvMOfZQ==?= =?UTF-8?B?IGF1cyBCZXJsaW4=?=\nDate: Wed, 02 Sep 2026 08:30:00 +0000\nReferences: <r1@x> <r2@x>\nIn-Reply-To: r2@x\nMIME-Version: 1.0\nContent-Type: multipart/alternative; boundary="b1"\n\npreamble\n--b1\nContent-Type: text/plain; charset=ISO-8859-1\nContent-Transfer-Encoding: quoted-printable\n\nSch=F6ne Gr=FC=DFe =\naus Berlin   \nhttps://example.com/a?b=3Dc und www.example.org.\n--b1\nContent-Type: text/html; charset=utf-8\n\n<p>Sch&ouml;ne Gr&uuml;&szlig;e</p>\n--b1--\nepilogue\n`,
    ),
  },
  {
    name: 'mixed with attachments and related image',
    raw: CRLF(
      `From: sender@example.com\nTo: r@example.com\nSubject: Report\nDate: Thu, 03 Sep 2026 12:00:00 +0000\nContent-Type: multipart/mixed; boundary="outer"\n\n--outer\nContent-Type: multipart/related; boundary="rel"\n\n--rel\nContent-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: base64\n\nPHA+SW1hZ2U6IDxpbWcgc3JjPSJjaWQ6bG9nbzEiPjwvcD4=\n--rel\nContent-Type: image/png\nContent-ID: <logo1>\nContent-Transfer-Encoding: base64\n\niVBORw0KGgo=\n--rel--\n--outer\nContent-Type: application/octet-stream\nContent-Disposition: attachment;\n filename*0*=utf-8''Bericht%20f%C3%BCr;\n filename*1*=%20M%C3%A4rz.pdf\nContent-Transfer-Encoding: base64\n\nJVBERi0xLjQ=\n--outer\nContent-Type: text/plain; name="=?UTF-8?Q?notiz_=C3=A4.txt?="\nContent-Disposition: attachment\n\nplain attachment\n--outer--\n`,
    ),
  },
  {
    name: 'html only',
    raw: CRLF(`From: news@example.com\nTo: me@example.com\nSubject: News\nDate: Fri, 04 Sep 2026 06:00:00 +0000\nContent-Type: text/html; charset=utf-8\n\n<h1>Title</h1><p>First &amp; second</p><ul><li>one</li><li>two</li></ul>\n`),
  },
  {
    name: 'mixed text and html without alternative',
    raw: CRLF(
      `From: a@example.com\nTo: b@example.com\nSubject: Two parts\nDate: Sat, 05 Sep 2026 06:00:00 +0000\nContent-Type: multipart/mixed; boundary="m"\n\n--m\nContent-Type: text/plain\n\nFirst <part> & more\n\nmail me: me@example.com\n--m\nContent-Type: text/html\n\n<b>Second</b>\n--m--\n`,
    ),
  },
  {
    name: 'flowed and embedded message',
    raw: CRLF(
      `From: a@example.com\nTo: b@example.com\nSubject: Fwd: Hi\nDate: Sun, 06 Sep 2026 06:00:00 +0000\nContent-Type: multipart/mixed; boundary="f"\n\n--f\nContent-Type: text/plain; charset=utf-8; format=flowed; delsp=yes\n\nThis is a long line that  \nwas wrapped by the client.\n Stuffed line\n--f\nContent-Type: message/rfc822\nContent-Disposition: inline\n\nFrom: c@example.com\nTo: a@example.com\nSubject: Hi\nDate: Mon, 31 Aug 2026 06:00:00 +0000\n\nInner text\n--f--\n`,
    ),
  },
  {
    name: 'raw utf-8 header and folded subject',
    raw: CRLF(`From: Zoë <zoe@example.com>\nTo: undisclosed-recipients:;\nSubject: A very long subject line that has been folded\n by the sending client\nDate: Mon, 07 Sep 2026 06:00:00 +0000\nX-Custom: one\nX-Custom: two\n\nBody äöü\n`),
  },
];

const composeCases = [
  { name: 'text with cc and bcc', options: { from: '', to: '<a@example.com>, <b@example.com>, ', cc: '<c@example.com>, ', bcc: '<d@example.com>, ', replyTo: '', subject: 'Plain', text: 'Hello\nWorld', html: '' } },
  { name: 'html with sender name', options: { from: 'Nathan <me@example.com>', to: '<a@example.com>, ', cc: '', bcc: '', replyTo: '<reply@example.com>, ', subject: 'Grüße aus München', text: '', html: '<p>Hallo <b>Welt</b> äöü</p>' } },
  {
    name: 'reply with attachments',
    options: {
      from: '',
      to: 'Bob <bob@example.com>, <carol@example.com>',
      cc: '',
      bcc: '',
      subject: 'Re: Report',
      inReplyTo: '<orig@example.com>',
      references: '<orig@example.com>',
      text: 'Thanks, attached.\n' + 'x'.repeat(100),
      html: '',
      attachments: [
        { name: 'data.csv', content: Buffer.from('a,b\n1,2\n'), type: 'text/csv' },
        { name: 'Übersicht März.pdf', content: Buffer.from('%PDF-1.4 fake'), type: 'application/pdf' },
      ],
    },
  },
  { name: 'only one attachment', options: { from: '', to: '<a@example.com>, ', cc: '', bcc: '', subject: 'File', text: '', html: '', attachments: [{ name: 'unknown', content: Buffer.from([0, 1, 2, 3]), type: undefined }] } },
  { name: 'empty message', options: { from: '', to: '<a@example.com>, ', cc: '', bcc: '', subject: '', text: '', html: '' } },
];

/** parseRawEmail of n8n-nodes-base 1.121.0 GenericFunctions.js, without binary data */
async function parseRawEmail(raw) {
  const parsed = await simpleParser(raw);
  const headers = {};
  for (const header of parsed.headerLines) headers[header.key] = header.line;
  const json = { ...parsed, headers, headerLines: undefined, attachments: undefined, date: parsed.date ? parsed.date.toISOString() : parsed.date };
  const attachments = parsed.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content.toString('base64') }));
  return { json: JSON.parse(JSON.stringify(json)), attachments };
}

async function encodeEmail(email) {
  const mailOptions = {
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo,
    inReplyTo: email.inReplyTo,
    references: email.references,
    subject: email.subject,
    text: email.text,
    keepBcc: true,
  };
  if (email.html) mailOptions.html = email.html;
  if (email.attachments?.length) {
    mailOptions.attachments = email.attachments.map((a) => ({ filename: a.name, content: a.content, contentType: a.type, encoding: 'base64' }));
  }
  const mail = new MailComposer(mailOptions).compile();
  mail.keepBcc = true;
  return (await mail.build()).toString();
}

const out = { parse: [], compose: [] };
for (const c of parseCases) out.parse.push({ name: c.name, raw: c.raw, expected: await parseRawEmail(c.raw) });
for (const c of composeCases) {
  const raw = await encodeEmail(c.options);
  const expected = await parseRawEmail(raw);
  delete expected.json.messageId;
  delete expected.json.date;
  delete expected.json.headers;
  const options = { ...c.options, attachments: c.options.attachments?.map((a) => ({ ...a, content: a.content.toString('base64') })) };
  out.compose.push({ name: c.name, options, expected });
}
console.log(JSON.stringify(out, null, 1));
