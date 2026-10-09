const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');

const source = stripTypeScriptTypes(fs.readFileSync('supabase/functions/_shared/followup-batch-gmail.ts', 'utf8').replace(/^export /gm, ''));
let storedMessage;
const context = { Deno: { env: { get: () => 'fujiakihiro8@gmail.com' } }, TextEncoder, TextDecoder, Uint8Array, btoa, atob, encodeURIComponent, unescape, fetch: async () => ({ ok: true, json: async () => storedMessage }) };
vm.createContext(context);
vm.runInContext(source, context);

(async () => {
  for (const threading of [false, true]) {
    for (const body of ['Dear Coach,\n\nFollow-up #1.\n\nBest,\nAkihiro', '日本語の確認 ⚽\r\n\r\n' + 'Long body. '.repeat(100)]) {
      const raw = context.buildReplyRaw({ to: 'coach@example.com', subject: 'Follow-up 日本語', body, messageId: threading ? '<original@example.com>' : '', references: threading ? '<older@example.com>' : '' });
      const mime = Buffer.from(raw, 'base64url').toString('utf8');
      const separator = mime.indexOf('\r\n\r\n');
      assert(separator > 0, 'header/body separator is required');
      const headers = mime.slice(0, separator), encodedBody = mime.slice(separator + 4).trim();
      assert.match(headers, /Content-Transfer-Encoding: base64/);
      assert.equal(headers.includes('In-Reply-To:'), threading);
      assert(encodedBody.split('\r\n').every(line => line.length <= 76));
      assert.equal(Buffer.from(encodedBody, 'base64').toString('utf8'), body);
      storedMessage = { id: 'sent', payload: { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } } };
      await context.verifyGmailSentBody('sent', body, 'fixture');
      storedMessage = { id: 'sent', payload: { mimeType: 'text/plain', body: { size: 0 } } };
      await assert.rejects(() => context.verifyGmailSentBody('sent', body, 'fixture'), /body is missing/);
    }
  }
  assert.throws(() => context.buildReplyRaw({ to: 'coach@example.com', subject: 'Empty', body: ' \n', messageId: '', references: '' }), /must not be empty/);
  console.log('PASS: actual MIME builder preserves the separator, UTF-8 body and threading; empty Gmail bodies fail verification. No mail sent.');
})().catch(error => { console.error(error); process.exitCode = 1; });
