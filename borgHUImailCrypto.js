/*******************************************************************
BorgHUI - mail crypto
===================================================================
End to end encryption for mailTree mail. The cell that stores the
mail never sees the plaintext or the message key:

  sender  : random message key -> AES-256-GCM over the body
            recipient RSA public key -> wraps the message key
  mailTree: stores the envelope as an opaque blob
  reader  : own RSA private key -> unwraps the key -> decrypts

The recipient's RSA public key comes from the mailTree registry
(mailSubscriber.msubMailPubKey), keyed by client MUID.
*/
const crypto = require('crypto');

const ENVELOPE_VERSION = 1;
const BODY_ALGO  = 'aes-256-gcm';
const WRAP_ALGO  = 'rsa-oaep-sha256';
const KEY_BYTES  = 32;
const IV_BYTES   = 12;   // GCM standard nonce

// Headers are travelling in clear text so the cell can route and index the
// mail. Binding them as additional authenticated data means a cell cannot
// re-address a stored envelope without the reader noticing.
function envelopeAAD(env){
  return Buffer.from(`${env.v}|${env.alg}|${env.from}|${env.to}|${env.date}`,'utf8');
}

// Content address of an envelope: covers ciphertext, tag and wrapped key, so
// every copy of the same mail lands under the same hash on every cell.
function mailHash(env){
  return crypto.createHash('sha256')
    .update(`${env.wrappedKey}${env.ct}${env.tag}`,'utf8')
    .digest('hex');
}

function requirePubKey(toPubKey){
  if (typeof toPubKey !== 'string' || toPubKey.indexOf('PUBLIC KEY') < 0){
    throw new Error('recipient has no usable mail public key');
  }
  return toPubKey;
}

/*
  Seals mail for one recipient.
    msg     : {subject, body, ...} - anything JSON serialisable
    returns : envelope + hash, safe to hand to a mailTree cell
*/
function sealMail(toPubKey, {from, to, msg, date = Date.now()}){
  requirePubKey(toPubKey);
  if (!from || !to) throw new Error('mail needs both from and to MUIDs');

  const key = crypto.randomBytes(KEY_BYTES);
  const iv  = crypto.randomBytes(IV_BYTES);

  const env = {
    v     : ENVELOPE_VERSION,
    alg   : BODY_ALGO,
    kwrap : WRAP_ALGO,
    from  : from,
    to    : to,
    date  : date
  };

  const cipher = crypto.createCipheriv(BODY_ALGO, key, iv);
  cipher.setAAD(envelopeAAD(env));
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(msg),'utf8')),
    cipher.final()
  ]);

  env.ct  = ct.toString('base64');
  env.tag = cipher.getAuthTag().toString('base64');

  // The message key and its nonce are the only thing the recipient's RSA key
  // has to carry; the body itself stays symmetric so size is unbounded.
  env.wrappedKey = crypto.publicEncrypt({
    key           : toPubKey,
    padding       : crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash      : 'sha256'
  }, Buffer.concat([key, iv])).toString('base64');

  env.hash = mailHash(env);
  return env;
}

/*
  Opens an envelope with the reader's RSA private key. Throws when the mail
  was addressed to somebody else, was truncated, or was tampered with.
*/
function openMail({privateKey, passphrase = null}, env){
  if (!env || !env.wrappedKey || !env.ct || !env.tag) throw new Error('envelope is incomplete');
  if (env.v !== ENVELOPE_VERSION)   throw new Error(`unsupported envelope version ${env.v}`);
  if (env.alg !== BODY_ALGO)        throw new Error(`unsupported body cipher ${env.alg}`);
  if (env.kwrap !== WRAP_ALGO)      throw new Error(`unsupported key wrap ${env.kwrap}`);
  if (env.hash && env.hash !== mailHash(env)) throw new Error('envelope hash mismatch');

  const wrapped = crypto.privateDecrypt({
    key       : privateKey,
    passphrase: passphrase || undefined,
    padding   : crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash  : 'sha256'
  }, Buffer.from(env.wrappedKey,'base64'));

  if (wrapped.length !== KEY_BYTES + IV_BYTES) throw new Error('wrapped message key is malformed');

  const key = wrapped.subarray(0, KEY_BYTES);
  const iv  = wrapped.subarray(KEY_BYTES);

  const decipher = crypto.createDecipheriv(BODY_ALGO, key, iv);
  decipher.setAAD(envelopeAAD(env));
  decipher.setAuthTag(Buffer.from(env.tag,'base64'));

  const clear = Buffer.concat([
    decipher.update(Buffer.from(env.ct,'base64')),
    decipher.final()
  ]);
  return JSON.parse(clear.toString('utf8'));
}

module.exports = {
  ENVELOPE_VERSION,
  BODY_ALGO,
  WRAP_ALGO,
  sealMail,
  openMail,
  mailHash
};
