/*******************************************************************
End to end mail test
==================================================================
Walks the whole mailTree mail path without a network:

  registry lookup -> seal -> post 3 copies -> broadcast retrieval
  -> recipient opens

The "cell" here does exactly what mailTreeObj does with a sealed
envelope: verify the content hash, store the blob verbatim, hand it
back on request. It holds no key, so anything it can read is a bug.

  node test/mailCrypto.test.js
*/
const crypto = require('crypto');
const assert = require('assert');
const mailCrypto = require('../borgHUImailCrypto.js');

let failures = 0;
function test(name, fn){
  try {fn(); console.log(`ok   - ${name}`);}
  catch(err) {failures++; console.log(`FAIL - ${name}\n       ${err.message}`);}
}

// --- clients ---------------------------------------------------------------
// 2048 bits keeps the test quick; the conduit generates 4096.
function newClient(muid){
  const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa',{
    modulusLength: 2048,
    publicKeyEncoding : {type:'spki', format:'pem'},
    privateKeyEncoding: {type:'pkcs8', format:'pem', cipher:'aes-256-cbc', passphrase: muid}
  });
  return {muid, publicKey, privateKey, passphrase: muid};
}
const alice = newClient('BORG-alice');
const bob   = newClient('BORG-bob');
const eve   = newClient('BORG-eve');

// --- mailTree stand-in -----------------------------------------------------
// mailSubscriber: the registry mailTree serves getInBoxKey from.
const registry = new Map([
  [alice.muid, alice.publicKey],
  [bob.muid,   bob.publicKey],
  [eve.muid,   eve.publicKey]
]);
function getInBoxKey(muid){
  const mailPubKey = registry.get(muid);
  return mailPubKey ? {result:true, mailPubKey} : {result:false};
}

// mailTreeObj.sealedMailHash - must agree with the client, or copies of one
// mail would land under different hashes on different cells.
function cellSealedMailHash(env){
  return crypto.createHash('sha256')
    .update(`${env.wrappedKey}${env.ct}${env.tag}`,'utf8')
    .digest('hex');
}

class MailCell {
  constructor(name){this.name = name; this.rows = new Map();}
  // storeSealedMail(): checks the hash, stores the envelope as an opaque blob
  storeSealedMail(mail){
    if (cellSealedMailHash(mail.envelope) !== mail.hash) return {mailStoreRes:false, error:'envelope hash does not match its contents'};
    const key = `${mail.envelope.to}|${mail.hash}`;
    if (!this.rows.has(key)){
      this.rows.set(key,{
        mbxToMUID   : mail.envelope.to,
        mbxFromMUID : mail.envelope.from,
        mbxHash     : mail.hash,
        mbxEnvelope : JSON.stringify(mail.envelope)   // what actually hits disk
      });
    }
    return {mailStoreRes:true, mailStorHash:mail.hash};
  }
  // doSendMyMail(): answers a retrieval broadcast for one MUID
  sendMyMail(MUID){
    const out = [];
    for (const row of this.rows.values()){
      if (row.mbxToMUID === MUID) out.push({hash:row.mbxHash, envelope:JSON.parse(row.mbxEnvelope)});
    }
    return out;
  }
}
const cells = [new MailCell('cell-1'), new MailCell('cell-2'), new MailCell('cell-3')];

// --- client side of the flow ----------------------------------------------
function sendMail(from, toMUID, msg, nCopys = 3){
  const look = getInBoxKey(toMUID);
  if (look.result !== true || !look.mailPubKey) throw new Error('recipient has no registered mail key');

  const envelope = mailCrypto.sealMail(look.mailPubKey,{from: from.muid, to: toMUID, msg});
  const stored = [];
  for (const cell of cells.slice(0,nCopys)){
    const r = cell.storeSealedMail({to:toMUID, from:from.muid, hash:envelope.hash, envelope});
    if (r.mailStoreRes) stored.push(cell.name);
  }
  return {envelope, stored};
}
function getMyMail(client){
  const found = new Map();
  for (const cell of cells){
    for (const m of cell.sendMyMail(client.muid)){
      const held = found.get(m.hash) || {...m, hosts:[]};
      held.hosts.push(cell.name);
      found.set(m.hash, held);
    }
  }
  return [...found.values()];
}
function openMail(client, envelope){
  return mailCrypto.openMail({privateKey: client.privateKey, passphrase: client.passphrase}, envelope);
}

// --- tests ----------------------------------------------------------------
const secret = {subject:'shell invoice 41', body:'AMOUNT DUE 0.0004 BTC - do not disclose'};
const sent = sendMail(alice, bob.muid, secret);

test('mail is stored on 3 cells under one content hash', ()=>{
  assert.strictEqual(sent.stored.length, 3);
  for (const cell of cells){
    const held = cell.sendMyMail(bob.muid);
    assert.strictEqual(held.length, 1);
    assert.strictEqual(held[0].hash, sent.envelope.hash);
  }
});

test('client hash matches the hash the cell computes', ()=>{
  assert.strictEqual(sent.envelope.hash, cellSealedMailHash(sent.envelope));
});

test('nothing a cell holds contains the plaintext', ()=>{
  for (const cell of cells){
    for (const row of cell.rows.values()){
      const blob = JSON.stringify(row);
      assert.ok(blob.indexOf(secret.body) < 0, `${cell.name} stored the body in clear text`);
      assert.ok(blob.indexOf(secret.subject) < 0, `${cell.name} stored the subject in clear text`);
    }
  }
});

test('retrieval broadcast returns the mail once, naming every holder', ()=>{
  const inbox = getMyMail(bob);
  assert.strictEqual(inbox.length, 1);
  assert.deepStrictEqual(inbox[0].hosts, ['cell-1','cell-2','cell-3']);
});

test('recipient decrypts every copy', ()=>{
  for (const cell of cells){
    const [held] = cell.sendMyMail(bob.muid);
    assert.deepStrictEqual(openMail(bob, held.envelope), secret);
  }
});

test('a copy that survived a cell restart still opens (JSON round trip)', ()=>{
  const onDisk = JSON.parse([...cells[0].rows.values()][0].mbxEnvelope);
  assert.deepStrictEqual(openMail(bob, onDisk), secret);
});

test('another subscriber cannot open it', ()=>{
  assert.throws(()=> openMail(eve, sent.envelope));
});

test('sender cannot open what it sent', ()=>{
  // proof the message key really only exists wrapped to the recipient
  assert.throws(()=> openMail(alice, sent.envelope));
});

test('tampered ciphertext is rejected', ()=>{
  const bad = {...sent.envelope};
  const ct = Buffer.from(bad.ct,'base64');
  ct[0] = ct[0] ^ 0xff;
  bad.ct = ct.toString('base64');
  assert.throws(()=> openMail(bob, bad));
});

test('re-addressed envelope is rejected', ()=>{
  // a cell rewriting the routing headers breaks the AAD binding
  const bad = {...sent.envelope, from: eve.muid, hash: undefined};
  assert.throws(()=> openMail(bob, bad), /Unsupported state|unable to authenticate|bad decrypt/i);
});

test('envelope hash is checked before decryption', ()=>{
  const bad = {...sent.envelope, hash: 'f'.repeat(64)};
  assert.throws(()=> openMail(bob, bad), /hash mismatch/);
});

test('unknown recipient fails closed instead of posting readable mail', ()=>{
  assert.throws(()=> sendMail(alice,'BORG-nobody',secret), /no registered mail key/);
  for (const cell of cells) assert.strictEqual(cell.sendMyMail('BORG-nobody').length, 0);
});

test('a cell that lies about the hash is refused by the next cell', ()=>{
  const forged = {to:bob.muid, from:alice.muid, hash:'0'.repeat(64), envelope:sent.envelope};
  assert.strictEqual(new MailCell('cell-x').storeSealedMail(forged).mailStoreRes, false);
});

test('resending the same mail does not duplicate the copy', ()=>{
  cells[0].storeSealedMail({to:bob.muid, from:alice.muid, hash:sent.envelope.hash, envelope:sent.envelope});
  assert.strictEqual(cells[0].sendMyMail(bob.muid).length, 1);
});

test('bodies larger than the RSA key still seal', ()=>{
  const big = {subject:'attachment', body:'x'.repeat(500000)};
  const r = sendMail(bob, alice.muid, big);
  assert.strictEqual(r.stored.length, 3);
  assert.deepStrictEqual(openMail(alice, r.envelope), big);
});

console.log(failures === 0 ? '\nOK: 0 failure(s)' : `\nFAILED: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
