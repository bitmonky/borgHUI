/**
 * borgHUIconduit.js
 *
 * borgHUI uses a BORG‑native mnemonic that deterministically encodes
 * the EC private key. The seed phrase restores the exact same keypair,
 * public key, and address — it is not a BIP‑39 wallet and does not
 * derive multiple keys.
 *
 * This is NOT a crypto wallet. The EC keypair represents user identity
 * and data ownership within the BorgIOS network.
 */

const EventEmitter = require('events');
const webCon  = require('http');
const fs      = require('fs');
const url     = require('url');
const multer  = require('multer');
const path    = require('path');
const EC      = require('elliptic').ec;
const ec      = new EC('secp256k1');
const bitcoin = require('bitcoinjs-lib');
const crypto  = require('crypto');
const mime    = require('mime-types');
const sodium  = require('libsodium-wrappers');
const ALGO    = "aes-256-cbc"
const port    = 80;
const wfile   = 'keys/myBMGPWallet.key';
const wconf   = 'keys/wallet.conf';

const {BorgHUIstreamMgr} = require('./borgHUIstreamMgr.js');
const {BorgHUIptreeAPI}  = require("./borgHUIptreeAPI.js");
const {BorgHUIFileMgrUI} = require("./borgHUIFileMgrUI.js");
const {BorgHUIBorgPay}   = require("./borgHUIBorgPay.js");
const borgMnemonic       = require("./borgHUIMnemonic.js");
const {SecureMnemonicStorage} = borgMnemonic;
const {BorgHUImemoryMgr} = require("./borgHUImemoryMgr.js");
const {BorgHUIWebSocket} = require("./borgHUIWebSocket.js");
const mailCrypto         = require("./borgHUImailCrypto.js");
const maxUpLoadSize = 100000000000; // 1Gig

const { generateKeyPairSync } = require('crypto')
const upload = multer({dest:'uploads/'});
const sanitize = require('sanitize-filename');

const baseDir = path.join(__dirname, 'uploads');
const allowedExtensions = ['.jpg', '.png', '.txt'];

// The conduit signs every request it forwards with the user's key, so anything
// able to reach it acts as the user. Only the BorgIOS UI this process served is
// allowed to drive it: a page on any other origin can still point a link, image,
// script or form at http://localhost, and the browser tells us so.
const LOCAL_ORIGINS = new Set([
  'http://localhost', `http://localhost:${port}`,
  'http://127.0.0.1', `http://127.0.0.1:${port}`
]);

function headerOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return origin === 'null' ? null : origin;

  const referer = req.headers.referer;
  if (!referer) return undefined;
  try {return new URL(referer).origin;}
  catch {return null;}
}

// Returns true when the request came from the served UI, false when it came from
// somewhere else. Sec-Fetch-Site is set by the browser itself and cannot be
// forged by page script, so it is the primary signal; Origin/Referer cover
// clients that omit it.
function isUIRequest(req, isIndexDoc) {
  const site = req.headers['sec-fetch-site'];
  const origin = headerOrigin(req);

  if (origin === null) return false;                    // opaque or unparsable
  if (origin !== undefined) return LOCAL_ORIGINS.has(origin);

  if (site === 'same-origin') return true;
  if (site && site !== 'none') return false;            // cross-site, same-site

  // 'none' is a typed URL or a bookmark, and a missing header is a non-browser
  // client. Only the index document is reachable either way.
  return isIndexDoc;
}

const WALLET_VERSION = 3;

// Reads a passphrase without echoing it. Synchronous so it can run from the
// wallet constructor. Returns null when there is no terminal to read from.
function readHiddenLine(prompt) {
  if (!process.stdin.isTTY) return null;

  process.stdout.write(prompt);

  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);

  const buf = Buffer.alloc(1);
  let line = '';
  try {
    for (;;) {
      let read = 0;
      try {read = fs.readSync(process.stdin.fd, buf, 0, 1, null);}
      catch (err) {
        if (err.code === 'EAGAIN') continue;
        throw err;
      }
      if (read === 0) break;

      const ch = buf.toString('utf8');
      if (ch === '\n' || ch === '\r' || ch === '\u0004') break;
      if (ch === '\u0003') {process.stdout.write('\n'); process.exit(130);}
      if (ch === '\u0008' || ch === '\u007f') {
        if (line.length) {line = line.slice(0, -1); process.stdout.write('\b \b');}
        continue;
      }
      line += ch;
      process.stdout.write('*');
    }
  }
  finally {
    process.stdin.setRawMode(wasRaw);
    process.stdout.write('\n');
  }
  return line;
}

// Passphrase precedence: environment, then terminal prompt.
function envPassphrase() {
  const p = process.env.BORGHUI_WALLET_PASSPHRASE;
  return (typeof p === 'string' && p.length > 0) ? p : null;
}

function plaintextWalletWarning() {
  console.log('');
  console.log('!! WALLET IS NOT ENCRYPTED ON DISK !!');
  console.log(`!! ${wfile} holds your private key in clear text.`);
  console.log('!! Set BORGHUI_WALLET_PASSPHRASE, or start borgHUI from a terminal to set a passphrase.');
  console.log('');
}

function deriveFileKey(masterKey) {
  return crypto.hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'hex'),
    Buffer.alloc(0),                 // no salt
    Buffer.from("borg-file-key"),    // info
    32
  );
}
function sanitizeFilename(filename) {
  const safeFilename = sanitize(filename);

  /* Validate the file extension
  const ext = path.extname(safeFilename).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error('Invalid file extension');
  }*/
  return safeFilename;
}
function isImageMime(mime) {
  return typeof mime === "string" && mime.startsWith("image/");
}
function isSafePath(userPath) {
  const safePath = path.normalize(userPath);

  // Restrict to the base directory
  const resolvedPath = path.resolve(baseDir, safePath);
  if (!resolvedPath.startsWith(baseDir)) {
    console.log('Unauthorized file path');
    return false;
  }

  return resolvedPath;
}
const https = require('https');
/*
********************
Override Date class so that all nodes use one unifide time dictated By the root node.
Capture the real Date constructor and real Date.now
********************
*/

const RealDate = Date;
const realNow = RealDate.now;

let peerTCorrection = 0;

// Override the Date constructor
function CorrectedDate(...args) {
  if (args.length === 0) {
    return new RealDate(realNow() + peerTCorrection);
  }
  return new RealDate(...args);
}

// Copy static methods
CorrectedDate.now = () => realNow() + peerTCorrection;
CorrectedDate.UTC = RealDate.UTC;
CorrectedDate.parse = RealDate.parse;

// Preserve prototype so instanceof still works
CorrectedDate.prototype = RealDate.prototype;

// Install the override
Date = CorrectedDate;//console.error('running::',process.title);

function parseChronyOffset(output) {
  // Find the line containing "Last offset"
  const match = output.match(/Last offset\s*:\s*([+-]?\d+\.?\d*)\s*seconds/i);
  if (!match) {
    throw new Error("Could not parse chronyc tracking output");
  }

  const seconds = parseFloat(match[1]);
  const milliseconds = Math.round(seconds * 1000);

  return milliseconds;
}


/*
 ::End Time Overide code
*/
class BorgPortal {
  constructor() {
    this.pfile = 'keys/borgPortalsList.dat';
    this.portals = [];
    this.loadPortals();
  }

  loadPortals() {
    try {
      const data = fs.readFileSync(this.pfile, 'utf8');
      this.portals = JSON.parse(data);
    } catch (error) {
      console.log("borgPortalsList Update.. file doesn't exist. Initializing empty portals list.");
      this.portals = [];
    }
  }
  testConnect(url) {
     url = `https://${url}`;
     console.log('trying url',url);
     return new Promise((resolve) => {
      const options = {
        method: 'HEAD',
        agent: new https.Agent({ rejectUnauthorized: false }) 
      };

      const req = https.request(url, options, (res) => {
        resolve(res.statusCode === 200);
      });

      req.on('error', () => resolve(false));
      req.end();
    });
  }
  getPortalsAll(netName){
    console.log(`getPortalsAll():: service name `,netName);
    const index = this.portals.findIndex(portal => portal.netName === netName);
    console.log(`applyCronoTreeTime():: index is `,index);
    if (index === -1) {
      return null;
    }

    return {port: this.portals[index].recpPort,wsSoc:this.portals[index].wsPort, nodes:[...this.portals[index].activeNodes]};
  }
  async selectPortal(netName) {
    //console.log(`selectPortal():: `,this.portals);
    const index = this.portals.findIndex(portal => portal.netName === netName);

    if (index === -1) {
      return { host: 'localhost', port: 80 };
    }

    let activeNodes = [...this.portals[index].activeNodes]; // Copy active nodes

    while (activeNodes.length > 0) {
      // Randomly select an index
      const rnodeIndex = Math.floor(Math.random() * activeNodes.length);
      const node = activeNodes[rnodeIndex];

      const host = node.ip;
      const port = this.portals[index].recpPort || 443;

      const target = `${host}:${port}`;

      const isConnected = await this.testConnect(target);

      if (isConnected) {
        //console.log(`Successful HTTPS connection: ${target}`);
        return { host, port };
      }

      console.log(`Failed HTTPS check: ${target}, removing and retrying...`);
      activeNodes.splice(rnodeIndex, 1);
    }

    // If no nodes worked, fall back
    return { host: 'web.bitmonky.com', port: 443 };
  }

}
class mkyRSAMail {
  constructor(pPhrase,keys=null){
    this.passPhrase = pPhrase;
    if (keys){
      this.publicKey = keys.publicKey;
      this.privateKey = keys.privateKey;
    }
  } 
  encryptString(toEncrypt,toPubKey=null) {
    if (!toPubKey) toPubKey =  this.publicKey;
    var buffer = Buffer.from(toEncrypt);
    var encrypted = crypto.publicEncrypt({
      key      : toPubKey,
      padding  : crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash : 'sha256'
    }, buffer);
    return encrypted.toString("base64");
  };

  decryptString(toDecrypt) {
    var buffer = Buffer.from(toDecrypt, "base64");
    const decrypted = crypto.privateDecrypt(
      {
        key: this.privateKey, 
        passphrase: this.passPhrase,
        padding  : crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash : 'sha256'
      },
      buffer,
    )
    return decrypted.toString("utf8");
  };
  generateKeys() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', 
    {
      modulusLength: 4096,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'     
      },     
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: this.passPhrase
      } 
    });
    this.publicKey  = publicKey;
    this.privateKey = privateKey;
    return { publicKey : publicKey, privateKey}
  }
};

function urldecode(msg) {
  // If it's not a string, return it unchanged
  if (typeof msg !== 'string') {
    return msg;
  }

  msg = msg.replace(/\+/g, ' ');
  msg = decodeURI(msg);
  msg = msg.replace(/%3A/gi, ':');
  msg = msg.replace(/%2C/gi, ',');
  msg = msg.replace(/%2F/gi, '/');
  msg = msg.replace(/\\%2F/gi, '/');

  return msg;
}

class bitMonkyWSrv extends  EventEmitter {
  constructor(){
    super();
    this.portal     = new BorgPortal();
    this.DStream    = new BorgHUIstreamMgr(this);
    this.MStream    = new BorgHUImemoryMgr(this);
    this.sseClients = [];
    this.portal     = new BorgPortal();
    this.PTree      = new BorgHUIptreeAPI(this);
    this.UI         = new BorgHUIFileMgrUI(this);
    this.BPay       = new BorgHUIBorgPay(this);
    this.wsSoc      = new BorgHUIWebSocket(this);
    this.wallet     = new bitMonkyWallet(this);
    this.wcj        = null; // wallet conf json data; 
    this.uiToken    = crypto.randomBytes(32).toString('hex');
    this.borgMasterID = this.getBorgMasterID();
    this.clockPulse = 60*1000;
    this.init();
    //setInterval(() => { this.pushEvent('borg-event',{hello:"hello"});},8000);
  }
  async init() {
    //console.log(this.wallet);
    this.allow = ["127.0.0.1"];
    this.recPort = 1385;
 
    const wp  = await this.portal.selectPortal('borgApacheCell');
    this.webPortal = `${wp.host}:${wp.port}`;

    await this.applyCronoTreeTime();

    this.readConfigFile();
    if (!this.wcj.openBal)   this.wallet.doCreateOpeningBalance();
    if (!this.wcj.userRoot)  this.wallet.doCreateNewUserRootRepo();
    if (!this.wcj.borgReg)   this.wallet.doUpdateBorgRegistry();

    console.log('USINGING WEB PORTAL',this.webPortal);
   
    this.srv = webCon.createServer( async (req, res) => {
     var pathname = url.parse(req.url).pathname;

     const isIndexDoc = req.method === 'GET' && (pathname === '/' || pathname === '/index.html');
     if (!isUIRequest(req, isIndexDoc)) {
       console.log('blocked foreign-origin request:', req.method, pathname,
                   'origin:', req.headers.origin || req.headers.referer || 'none',
                   'sec-fetch-site:', req.headers['sec-fetch-site'] || 'none');
       res.writeHead(403, {'Content-Type':'text/plain'});
       res.end('BorgHUI conduit accepts requests from the BorgIOS UI only.\n');
       return;
     }
     
     if (req.method === 'GET' && pathname === '/html/borgHUI.css') {
       res.setHeader('Content-Type', 'text/css');
       fs.createReadStream('html/borgHUI.css').pipe(res);
       return;
     }
     if (req.method === 'GET' && pathname === '/favicon.ico') {
       res.setHeader('Content-Type', 'image/x-icon');
       fs.createReadStream('favicon.ico').pipe(res);
       return;
     }
     if (req.method === 'GET' && pathname === '/borgUIToken') {
       return this.sendJSON(res, 200, {uiToken: this.uiToken});
     }
     if (req.method === 'POST' && pathname === '/api/wallet/restore') {
       return this.handleRestoreWallet(req, res);
     }

     if (req.method === 'GET' && pathname === '/api/wallet/mnemonic') {
       return this.handleExportMnemonic(req, res);
     }

     if (req.method === 'POST' && pathname === '/api/wallet/verify-mnemonic') {
       return this.handleVerifyMnemonic(req, res);
     }
     
       if (req.url === "/borgEvents") {
         return this.handleSSE(req, res);
       }
       else if (req.method === 'POST' && req.url.indexOf('/storeRepoFileOnTree') === 0) {
         console.log('Got repoUploadFile !',req.url);
 

         const urlObj = new URL(req.url, `http://${req.headers.host}`);

         const meta = {
           ownerMUID : urlObj.searchParams.get('ownerMUID'),
           path      : urlObj.searchParams.get('path'),
           folderID  : urlObj.searchParams.get('folderID'),
           rname     : urlObj.searchParams.get('rname'),
           encrypt   : urlObj.searchParams.get('encrypt') 
         } 
         if (meta.ownerMUID === 'localMUID')  meta.ownerMUID = this.wallet.ownMUID;
         console.log(`upload meta data`,meta);

         upload.single('photo')(req, res, (err) => {
           if (err) {
             res.writeHead(500, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ result: false, data: 'File Upload Failed' }));
             return;
           }

           const { originalname, mimetype, path: tmpname, size, error } = req.file;
           console.log(req.file);
           meta.filename = originalname;

           if (size > 0 && size < maxUpLoadSize && !error) {

             // --- STREAMING HASH FUNCTION ---
             const hashFileStream = (filePath) => {
               return new Promise((resolve, reject) => {
                 const hash = crypto.createHash('sha256');
                 const stream = fs.createReadStream(filePath);

                 stream.on('data', chunk => hash.update(chunk));
                 stream.on('end', () => resolve(hash.digest('hex')));
                 stream.on('error', reject);
               });
             };

             // --- USE STREAMING HASH ---
             hashFileStream(tmpname)
             .then(hash => {
               const fholder = `${hash}.tmp`;
               const targetDir = 'uploads/';
               const targetFile = path.join(targetDir, fholder);

               fs.rename(tmpname, targetFile, (err) => {
                 if (err) {
                   res.writeHead(500, { 'Content-Type': 'application/json' });
                   res.end(JSON.stringify({ result: false, data: 'File Move Failed' }));
                 } else {
                   const j = {
                     req: 'uploadUserFile',
                     fileName : originalname,
                     filePath : targetFile,
                     mimeType : mimetype,
                     repoInfo : meta
                   };
                   this.wallet.doUploadFile(j, res);
                 }
               });
             })
             .catch(err => {
               console.error('Hashing failed:', err);
               res.writeHead(500, { 'Content-Type': 'application/json' });
               res.end(JSON.stringify({ result: false, data: 'Hashing Failed' }));
             });
           }
           else {
             console.error('File Upload Max Size Exceeded: size is:', size);
             res.writeHead(500, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ result: false, data: 'Max Upload Size Exceeded' }));
           } 
         });
     }
     else {

       if (req.url.indexOf('/netREQ/file=') == 0){
         var file = req.url.replace('/netREQ/file=','');
         file = urldecode(file);
         this.doGetFileById(file,res);
         return;
       }
       if (req.url.indexOf('/netREQ/msg=') == 0){
          var msg = req.url.replace('/netREQ/msg=','');
          msg = urldecode(msg);
          this.handleRequest(msg,res,req);
        }
        else {

          if (req.url.indexOf('/netREQ') == 0){
            if (req.method == 'POST') {
              var body = '';
              req.on('data', (data)=>{
                body += data;
                // Too much POST data, kill the connection!
                //console.log('body.length',body.length);
                if (body.length > 300000000){
                  console.log('max datazize exceeded');
                  req.connection.destroy();
                }
              });
              req.on('end', ()=>{
                handleRequest(body,res,req);
              });
            }	
          }
          else { 
            res.setHeader("Set-Cookie", "SameSite=None; Secure");
            res.setHeader("Content-Type", "text/html");
            res.writeHead(200);
            const indexFile = 'html/index.html';
            const readStream = fs.createReadStream(indexFile, 'utf8');

            let fileContent = '';

            readStream.on('data', (chunk) => {
              fileContent += chunk;
            });

            readStream.on('end', () => {
              fileContent = fileContent.replace(/<BORG_PORTAL>/g, this.webPortal); 
              fileContent = fileContent.replace(/<head>/i, `<head>\n<script>window.BORG_UI_TOKEN=${JSON.stringify(this.uiToken)};</script>`);
              res.end(fileContent);
            });

            readStream.on('error', (err) => {
              console.error("Error reading file:", err);
              res.end("Error loading index file."+indexFile);
            });
            return;
          }
        }
      }
    });
    this.srv.on('connection', (sock)=> {
      console.log(sock.remoteAddress,this.allow);
      if (this.allow.indexOf(sock.remoteAddress) < 0){
        sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } 
    });

    this.srv.listen(port,'localhost');
    console.log('bitMonky Wallet Server running at http://localhost:'+port);
  }
  getBorgMasterID(){
    return '1B1xrS6Xi6uhCoXcH8UzSETk81S2pmpWjQ';
  }
  handleSSE(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    res.write("\n");

    this.sseClients.push(res);

    req.on("close", () => {
      const i = this.sseClients.indexOf(res);
      if (i !== -1) this.sseClients.splice(i, 1);
    });
  }
  pushEvent(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    this.sseClients.forEach( (c) =>{
      c.write(payload);
      console.log(payload);
    });
  }
  async applyCronoTreeTime() {
    console.log(`applyCronoTreeTime():: checking BorgTime`);
    try {
      const ps = this.portal.getPortalsAll('cronoTreeCell');
      const portals = ps.nodes;

      if (!portals || portals.length === 0) {
        setTimeout(() => this.applyCronoTreeTime(), this.clockPulse);
        return;
      }

      // Fire all requests in parallel
      const promises = portals.map(p =>
        this.requestCronoTime(p.ip, ps.port)
          .then(j => j?.cronoTreeSystemClock?.rootTime)
          .catch(() => null)
      );

      const results = await Promise.all(promises);

      const times = results.filter(rt =>
        rt !== null &&
        rt !== 'unavailable' &&
        typeof rt === 'number'
      );

      // Debug
      for (let i = 0; i < portals.length; i++) {
        console.log(`applyCronoTreeTime():: ${portals[i].ip} says`, results[i]);
      }
      console.log(`Times:: `,times);

      if (times.length > 0) {
        // Sort
        times.sort((a, b) => a - b);

        // Median
        const median = times[Math.floor(times.length / 2)];

        // Filter out extreme offsets
        const filtered = times.filter(t => Math.abs(t - median) < 200);

        // Average the remaining cluster
        const avg = filtered.reduce((a, b) => a + b, 0) / filtered.length;

        // Apply drift correction
        peerTCorrection = avg - realNow();
        console.log(`applyCronoTreeTime():: avg ${avg} peerTCorrection `, peerTCorrection, Date.now(), realNow());
      }

    } catch (_) {}

    setTimeout(() => this.applyCronoTreeTime(), this.clockPulse);
  }
  async requestCronoTime(ip,port) {
     const msg = {msg:{req:'sendCronoTime'}};
     const body = JSON.stringify(msg);

     const options = {
       hostname: ip,
       port: port,
       path: '/netReq',
       method: 'POST',
       rejectUnauthorized: false,   // allow self‑signed cert
       headers: {
         'Connection': 'close',
         'Content-Type': 'application/json',
         'Content-Length': Buffer.byteLength(body, 'utf8')
       },
       timeout: 3500   // 1.5s timeout — adjust as needed
     };
     return new Promise((resolve, reject) => {
       const req = https.request(options, (res) => {
         let data = '';

         res.on('data', chunk => data += chunk);
         res.on('end', () => {
           try {
             resolve(JSON.parse(data));
           } catch (err) {
             reject(new Error(`Invalid JSON response: ${data}`));
           }
         });
       });

       req.on('timeout', () => {
         req.destroy();
         reject(new Error('Request timed out'));
       });

       req.on('error', reject);

       req.write(body);
       req.end();
     });
   }
   async handleRequest(msg,res,req){
     var j = null;
          
     try {
       j = JSON.parse(msg);
       console.log(`handleRequest():: values:`,j);

       if (j.req){
         if (j.req == 'useNewWallet'){
           this.wallet.changeWallet(j,res);
           return;
         }
         //if (j.req == 'uploadUserFile'){
         //  this.wallet.doUploadFile(j, res);
         //  return;
         //}
        if (j.req  == 'signToken'){
           j.signedToken = this.wallet.signMsg(j.sigTokenData);
           res.end(JSON.stringify(j));
           return;
         }
         if (j.req  == 'sendRSV'){
            this.wallet.doRSVExecuteCmd(j,res);
            return;
         }
         if (j.req  == 'getRsaPubKey'){
            j.rsaPubKey = this.wallet.rsaKeys?.publicKey || null;
            res.end(JSON.stringify(j));
            return;
         }
         if (j.req  === 'sendBorgMail'){
            await this.wallet.doSendBorgMail(j,res);
            return;
         }
         if (j.req  === 'getMyBorgMail'){
            await this.wallet.doGetMyBorgMail(j,res);
            return;
         }
         if (j.req  === 'deleteBorgMail'){
            await this.wallet.doDeleteBorgMail(j,res);
            return;
         }
         if (j.req  == 'rsaDecodeMsg'){
            this.wallet.doRsaDecodeMsg(j,res);
            return;
         }
         if (j.req === 'createBorgChannel'){
           this.wallet.doCreateBorgChannel(j,res);
           return;
         }
         if (j.req === 'sendChanChat'){
           this.wallet.doSendChanChat(j,res);
           return;
         }
         if (j.req === 'createBorgMemory'){
           this.wallet.doCreateBorgMemory(j,res);
           return;
         }
         if (j.req === 'deleteBorgMemory'){
           this.wallet.doDeleteBorgMemory(j,res);
           return;
         }
         if (j.req  === 'displayBorgMemory'){
           await this.wallet.doDisplayBorgMemory(j,res);
           return;
         }
         if (j.req  === 'sendBorgChatMsg'){
           this.wallet.doSendBorgChatMsg(j,res);
           return;
         }
         if (j.req  === 'sendPeerQryResults'){
           await this.wallet.doSendPeerQryResults(j,res);
           return;
         }
         if (j.req  === 'doSendShells'){
           this.wallet.doSendShells(j,res);
           return;
         }
         if (j.req  === 'qryMemberSendTo'){
           this.wallet.doQryMemberSendTo(j,res);
           return;
         }
         if (j.req  == 'startBorgBrowser'){
            this.startBorgBrowser(res);
            return;
         }  
         if (j.req === 'getUserByMUID'){
           await this.wallet.doGetUserByMUID(j,res);
           return;
         }
         if (j.req === 'getSendShellsToMbr'){
           await this.wallet.doGetSendShellsToMbr(j,res);
           return;
         }
         if (j.req === 'updateMyIcon'){
           await this.wallet.doUpdateMyIcon(j,res);
           return;
         }
         if (j.req === 'updateMyNicname'){
           await this.wallet.doUpdateMyNicname(j,res);
           return;
         }
         if (j.req === 'updateBorgProfile'){
           await this.wallet.doUpdateBorgProfile(j,res);
           return;
         }
         if (j.req === 'createAccount'){
           await this.wallet.doCreateAccount(j,res);
           return;
         }
         if (j.req === 'sendWalletOptions'){
           await this.wallet.doSendWalletOptions(j,res);
           return;
         }
         if (j.req === 'sendAccountInfo'){
           await this.wallet.doSendAccountInfo(j,res);
           return;
         }
         if (j.req === 'sendBorgTime'){
           await this.wallet.doSendBorgTime(j,res);
           return;
         }
         if (j.req === 'sendBorgFileSys' || j.req === 'borgUpdateResByUrl'){
           await this.wallet.doHandleBorgFileSys(j,res);
           return;
         }

         if (j.req  === 'getFileFromRepo'){
            this.getFileFromRepo(req,j, res);
            return;
         }
         this.wallet.doMakeReq(j.req,res,j.parms,j.service);
         return;
       } 
       res.end("No Handler Found For:\n\n "+JSON.stringify(j));
     }
     catch(err) {
       console.log("json parse error:",err);
       console.log(`handleRequest():: values:`,msg);
       res.end("JSON PARSE Errors: \n\n"+msg+"\n\n"+err);
     }
  }
  sendJSON(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)});
    res.end(payload);
  }
  readJSONBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) {req.destroy(); reject(new Error('Request body too large'));}
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {resolve(JSON.parse(body));}
        catch {reject(new Error('Invalid JSON body'));}
      });
      req.on('error', reject);
    });
  }
  // The mnemonic reconstructs the identity, so exporting or replacing it
  // requires the wallet passphrase. An unencrypted wallet has no passphrase to
  // check, so those routes stay closed unless the operator opts in.
  verifyAuth(req) {
    if (!this.verifyUIToken(req)) return false;
    if (!this.wallet.passphrase) return process.env.BORGHUI_ALLOW_UNPROTECTED_EXPORT === '1';
    return this.wallet.passphraseMatches(req.headers['x-borg-wallet-pass']);
  }
  // Second gate for the wallet routes: a token minted per run and handed only to
  // the page this process served, so another local process cannot reach them
  // even though it can bind the same loopback origin headers.
  verifyUIToken(req) {
    const sent = req.headers['x-borg-ui-token'];
    if (typeof sent !== 'string') return false;
    const a = Buffer.from(sent);
    const b = Buffer.from(this.uiToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  async handleRestoreWallet(req, res) {
    try {
        if (!this.verifyAuth(req)) {
            return this.sendJSON(res, 401, {success:false, error:'Wallet passphrase required'});
        }

        const { mnemonic } = await this.readJSONBody(req);

        if (!mnemonic) {
            throw new Error('Mnemonic phrase required');
        }

        const result = this.wallet.restoreFromMnemonic(mnemonic);

        if (result.success) {
            this.sendJSON(res, 200, {
                success: true,
                muid: result.muid,
                publicKey: result.publicKey,
                message: 'Wallet restored successfully'
            });
        } else {
            this.sendJSON(res, 400, {
                success: false,
                error: result.error
            });
        }
    } catch (error) {
        this.sendJSON(res, 400, {
            success: false,
            error: error.message
        });
    }
  }

  // Handle mnemonic export
  async handleExportMnemonic(req, res) {
    try {
        if (!this.verifyAuth(req)) {
            return this.sendJSON(res, 401, {success:false, error:'Wallet passphrase required'});
        }

        const mnemonic = this.wallet.getMnemonic();
        this.sendJSON(res, 200, {
            success: true,
            mnemonic,
            warning: 'Store this mnemonic securely! It can restore your entire identity.'
        });
    } catch (error) {
        this.sendJSON(res, 500, {
            success: false,
            error: error.message
        });
    }
  }
  // Handle mnemonic verification
  async handleVerifyMnemonic(req, res) {
    try {
        const { mnemonic } = await this.readJSONBody(req);
        const isValid = this.wallet.verifyMnemonic(mnemonic);

        this.sendJSON(res, 200, {
            success: true,
            isValid,
            message: isValid ? 'Mnemonic matches wallet' : 'Mnemonic does not match wallet'
        });
    } catch (error) {
        this.sendJSON(res, 400, {
            success: false,
            error: error.message
        });
    }
  }
  async doCheckSumLookup(msg, service,checksum) {
  try {
    // Build new service object without shadowing the argument
    const lookupService = {
      endPoint: service.endPoint + (service.endPoint.includes("?") ? "&" : "?") + "checksumOnly=true&checksum=" + checksum,
      host: service.host,
      port: service.port,
      raw: true
    };

    console.log("doCheckSumLookup():: lookupService =", lookupService);

    // Perform checksum-only request
    let j = await this.wallet.sendPostRequest(msg, null, lookupService);
    return JSON.parse(j);
  }
  catch (err) {
    console.log("doCheckSumLookup():: failed:", msg, service, err);
    return null;
  }
}
async doGetFileById(file,res){
  const rawUrl = `/getFile?fileId=${file}`;
  const u = new URL(rawUrl, 'http://localhost');
  const fileId = u.searchParams.get('fileId');
  const mode   = u.searchParams.get('fmode');

  console.log('getFileFromRepo():: fileId ',  fileId);
  console.log('getFileFromRepo():: mode ',  mode);

  let doTry = await this.PTree.ftreeGetFileFromRepoById(this.wallet.ownMUID,fileId);
  console.log(`doTry`,doTry);
  if (doTry.status === 200){
    console.log(`getFileFromRepo():: doTry is `,doTry.json);
  }
  if (doTry?.json?.result === false){
    console.log(`doTry error: `,doTry.error);
    res.end(`Get File Failed... details: ${JSON.stringify(doTry)}\n`);
    return;
  }
  if (doTry?.json?.file.fileInfo.fileSize > 0) {
    const p = await this.portal.selectPortal('shardTreeCell');

    const service = {
      endPoint : '/netREQ/',
      filename : `./downloads/${doTry.json.file.fileInfo.checkSum}.tmp`,
      mode     : mode,
      host     : p.host,
      port     : p.port,
      raw      : true
    };

    doTry = await this.DStream.streamRepoFileFrom(service,doTry.json,res);
    //console.log('getFileFromRepo():: ',doTry);
    return;
  }
  console.log(`doTry error: `,doTry.error);
  res.end(`Get File Failed To Stream... details: ${JSON.stringify(doTry)}\n`);
  return;

}
async getFileFromRepo(req, msg, res) {
  const rawUrl = msg.url;
  const ftype  = msg.ftype;
  console.log(msg);
  // Node requires a base for relative URLs
  console.log(`getFileFromRepo():: headers`,req.headers);
  console.log(`rawUrl`,rawUrl);
  const range = req.headers.range;
  
  const u = new URL(rawUrl, 'http://localhost');
  console.log(`u`,u);
  // Path
  const path = u.pathname;

  // Query fields
  const wzID      = u.searchParams.get('wzID');
  const fname     = u.searchParams.get('fname');
  const rname     = u.searchParams.get('rname');
  const repoPath  = u.searchParams.get('path');
  const ownerMUID = u.searchParams.get('ownerMUID');
  const folderID  = u.searchParams.get('folderID');
  const encrypt   = u.searchParams.get('encrypt');
 
  console.log('getFileFromRepo():: msg: ',  msg);

  res.req = req;
  const stream = await this.DStream.keepStreaming(msg.checkSum,res,fname,msg.ftype);
  if (stream) return;

  let doTry = await this.PTree.ftreeGetFileFromRepo(ownerMUID, rname, fname, repoPath, folderID);
  console.log(`doTry`,doTry);
  if (doTry.status === 200){ 
    console.log(`getFileFromRepo():: doTry is `,doTry.json);
    //console.log(`getFileFromRepo():: doTry is `,doTry.json.file.shards);
    //console.log(`getFileFromRepo():: doTry is `,doTry.json.file.fileInfo);     
  }
  if (doTry?.json?.result === false){
    console.log(`doTry error: `,doTry.error);
    res.end(`Get File Failed... details: ${JSON.stringify(doTry)}\n`);
    return;
  }  

  if (doTry?.json?.file.fileInfo.fileSize > 0) {
    const p = await this.portal.selectPortal('shardTreeCell');

    const service = {
      endPoint : '/netREQ/',
      filename : `./downloads/${doTry.json.file.fileInfo.checkSum}.tmp`,
      host     : p.host,
      port     : p.port,
      raw      : true
    };
    res.req = req;
    doTry = await this.DStream.streamRepoFileFrom(service,doTry.json,res);
    //console.log('getFileFromRepo():: ',doTry);
    return;
  }

  return;

  try {
      const wp = await this.portal.selectPortal('borgApacheCell');

      const service = {
        endPoint: msg.url,
        host: wp.host,
        port: wp.port,
        raw: true
      };

      console.log('getFileFromRepo():: ', service, msg);

    // -----------------------------------
    // MIME TYPE DETECTION
    //-------------------------------------
    let mimeType = msg.mime;

    var fileName = null;
    if (!mimeType) {
      const parsed = url.parse(msg.url, true);
      fileName = parsed.query.fname;
      mimeType = mime.lookup(fileName) || "application/octet-stream";
    }
    console.log(`getFileFromRepo():: mimeType is;`,mimeType);
    // Do Checksum Check To See If File has changed
    // -----------------------------------
    // CHECKSUM LOOKUP
    // -----------------------------------
    const clientETag = req.headers['if-none-match'];
    const cleanETag = clientETag ? clientETag.replace(/"/g, "") : null;


    let remCheckSumOK = await this.doCheckSumLookup(msg,service,cleanETag);

    // Hard failure: network error, invalid JSON, PHP crash
    if (!remCheckSumOK) {
      console.log(`getFileFromRepo():: remCheckSumLookup failed`, remCheckSumOK);
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`Checksum Lookup Failed\n`);
    }

    // Soft failure: checksum mismatch (file changed)
    if (remCheckSumOK.result === false) {
      console.log(`getFileFromRepo():: checksum mismatch, fetching new file`, remCheckSumOK);
      // DO NOT RETURN — continue to fetch file
    }
    
    // -----------------------------------
    // BROWSER CACHE VALIDATION (ETag)
    //-------------------------------------

    if (cleanETag  && cleanETag === remCheckSumOK.checkSum) {
      // Browser already has this exact version
      res.writeHead(304);
      return res.end();
    }

    // Cache Not Useable Fetch file bytes from repo
    const result = await this.wallet.sendPostRequest(msg, null, service);
   
    if (result === null) {
      console.log(`getFileFromRepo():: failed `);
      if (isImageMime(mimeType)){
        res.writeHead(500, { "Content-Type": mimeType });
        res.end('');
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("Get File Failed... No File Found At url.\n");
    }
    // Try to parse JSON only if result is text-like
    let j = null;
    try {
      const text = Buffer.isBuffer(result) ? result.toString() : result;
      j = JSON.parse(text);
    } 
    catch (e) {
      // Not JSON — expected for binary files
    }

    if (j && j.result === false) {
      console.log(`getFileFromRepo():: failed on: `, j);

      if (isImageMime(mimeType)) {
        res.writeHead(500, { "Content-Type": mimeType });
        res.end('');
        return;
      }

      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(`Get File Failed... details: ${JSON.stringify(j)}\n`);
    }
    
    console.log("CLIENT FIRST 20 BYTES:", new Uint8Array(result).slice(0, 20));
    console.log("CLIENT LAST 20 BYTES:", new Uint8Array(result).slice(-20));
    console.log("getFileFromRepo():: First 20 bytes:", result.slice(0, 20));
    console.log("LAST 20 BYTES:", result.slice(result.length - 20));


    // -----------------------------------
    // FILE INFO
    //-------------------------------------
    const fcheckSum = msg.checkSum || msg.fcheckSum || null;
    const fname     = fileName || null;
    const fileSize  = Buffer.isBuffer(result)
      ? result.length
      : Buffer.byteLength(result);

    console.log(`getFileFromRepo():: FILE INFO:`,fcheckSum,fname,fileSize);
    // -----------------------------------
    // BUILD RESPONSE HEADERS
    //-------------------------------------
    const headers = {
      "Content-Type": mimeType,
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes"
    };

    if (fcheckSum) {
      headers["ETag"] = `"${fcheckSum}"`;
    }

    if (fname) {
      headers["Content-Disposition"] = `inline; filename="${fname}"`;
    }
    
    //console.log(`getFileFromRepo():: Headers:`,headers);

    // -----------------------------------
    // SEND FILE
    //-------------------------------------
    res.writeHead(200, headers);

    if (Buffer.isBuffer(result)) {
      console.log(`getFileFromRepo():: response is buffer:`);
      res.end(result);
    } else {
      console.log(`getFileFromRepo():: response is NOT buffer: converting`);
      res.end(Buffer.from(result));
    }

  } catch (err) {
    console.log("getFileFromRepo error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Error Loading Borg Browser");
  }
}
  async startBorgBrowser(res, msg) {
    try {

      let jsCode = fs.readFileSync('./borgHUIboot.js', 'utf8');

      // Inject server-side values into the JS code
      jsCode =
        `// Injected by BorgHUI\n` +
        `var MODE        = "PC";        // or "Mobile"\n` +
        `var ROOT_DOMAIN = "localhost";\n` +
        `var SERVICE_HOST = "localhost";\n` +
        `var NET_PORT     = "" //80;\n` +
        `var PIN          = "TEST_PIN_2x49fg16";\n` +
        `\n` + jsCode; 

      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(jsCode);
/*
      const wp = await this.portal.selectPortal('borgApacheCell');

      const service = {
        endPoint : '/bitMDis/pWalletJSMPC.php?dbug=on&sport=80&dm=PC',
        host     : wp.host,
        port     : wp.port,
        raw      : true
      };

      const stok    = `${this.wallet.ownMUID}${reqTime}`    \\ old session token.

      var msg = {
        Address : this.wallet.ownMUID,
        sesTok  : stok,
        pubKey  : this.wallet.publicKey,
        sesSig  : this.wallet.signMsg(stok),
        action  : 'na',
        parms   : null
      }

      const result = await this.wallet.sendPostRequest(msg, null, service);

      if (result && result !== '') {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(result);
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("No Code For Borg Humane Interface Found.\n");
      }
*/
    }
    catch (err) {
      console.log("startBorgBrowser error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Error Loading Borg Browser");
    }
  }
  readConfigFile(){
     var conf = null;
     try {conf =  fs.readFileSync(wconf);}
     catch {console.log('no config file found');}
     if (conf){
       try {
         conf     = conf.toString();
         const j  = JSON.parse(conf);
         this.wcj = j;

         this.recPort       = j.receptor.port;
         this.allow         = j.receptor.allow;
         this.nicName       = j.nicName;
         this.icon          = j.icon || null;
         this.openBal       = j.openBal || false;
         console.log(`readConfigFile():: this.wcj`, this.wcj);
       }
       catch(err) {
         console.log('conf file not valid', err);
         this.recPort = 1385;
         this.allow = ["127.0.0.1"];
       }
     }
  }
};

class bitMonkyWallet{
   constructor(net){
      this.net = net;
      this.publicKey   = null;
      this.privateKey  = null;
      this.signingKey  = null;
      this.rsaKeys     = null;
      this.newWallet   = null;
      this.mnemonic    = null;
      this.passphrase  = null;   // in memory only, never written to disk
      this.openWallet();
            
   }
   calculateHash(txt) {
      const crypto = require('crypto');
      return crypto.createHash('sha256').update(txt).digest('hex');
   }
   signToken(token) {
      const sig = this.signingKey.sign(this.calculateHash(token), 'base64');
      const hexSig = sig.toDER('hex');
      return hexSig;
   }
   changeWallet(j,res){
     console.log('changeWallet',j.wallet.ownMUID); 
     if (j.wallet.ownMUID == 'useDefault'){
        this.openWallet();
        j.result = true;
        console.log('result',JSON.stringify(j));
        res.end(JSON.stringify(j));
        return;
      }
      
      this.publicKey     = j.wallet.publicKey;
      this.privateKey    = j.wallet.privateKey;
      this.ownMUID       = j.wallet.ownMUID;
      this.walletCipher  = j.wallet.walletCipher;
      this.signingKey    = ec.keyFromPrivate(this.privateKey);
      j.result = true;
      res.end(JSON.stringify(j));
   }
   openWallet(){
      var keypair = null;
      try {keypair =  fs.readFileSync(wfile);}
      catch {console.log('no wallet file found');}
      this.publicKey = null;
      if (keypair){
        let record = null;
        try {record = JSON.parse(keypair.toString());}
        catch(err) {console.log('wallet file not valid', err);process.exit();}

        if (record.encrypted) {
          record = this.unlockWalletFile(record);
        }
        else {
          this.passphrase = this.resolvePassphrase({confirm:true, migrate:true});
        }

        try {this.loadWalletRecord(record);}
        catch(err) {console.log('wallet file not valid', err);process.exit();}

        // Rewrite when the on-disk form is out of date: legacy plaintext file
        // that now has a passphrase, or a record missing its RSA mail keys.
        if (record.version !== WALLET_VERSION || !record.rsaKeys) this.writeWallet();
        if (!this.passphrase) plaintextWalletWarning();
      }
      else {
        this.passphrase = this.resolvePassphrase({confirm:true, create:true});
        this.generateNewWallet();
      }
   }
   // Rebuilds the in-memory wallet from a decrypted (or legacy plaintext) record.
   loadWalletRecord(j){
      if (!j.privateKey) throw new Error('wallet record has no private key');

      this.publicKey    = j.publicKey;
      this.privateKey   = j.privateKey;
      this.ownMUID      = j.ownMUID;
      this.walletCipher = j.walletCipher;
      this.signingKey   = ec.keyFromPrivate(this.privateKey);

      const cipherSeed = this.calculateHash(this.privateKey);
      this.pmCipherKey = ec.keyFromPrivate(cipherSeed).getPublic('hex');
      this.fileKey     = deriveFileKey(this.privateKey);

      if (j.rsaKeys) this.rsaKeys = j.rsaKeys;
      else {
        const rsaMail = new mkyRSAMail(this.walletCipher);
        this.rsaKeys = rsaMail.generateKeys();
      }
      console.log(`Wallet loaded: ${this.ownMUID}`);
   }
   // Asks for the passphrase that protects the wallet file. Returns null when
   // no passphrase is available, in which case the wallet stays in clear text.
   resolvePassphrase(opts = {}){
      const fromEnv = envPassphrase();
      if (fromEnv) return fromEnv;
      if (!process.stdin.isTTY) return null;

      if (opts.create)  console.log('Set a passphrase to encrypt your wallet on disk (blank to skip).');
      if (opts.migrate) console.log(`${wfile} is stored in clear text. Set a passphrase to encrypt it (blank to skip).`);

      const pass = readHiddenLine('Wallet passphrase: ');
      if (!pass) return null;

      if (opts.confirm) {
        const again = readHiddenLine('Confirm passphrase: ');
        if (again !== pass) {
          console.log('Passphrases do not match.');
          return this.resolvePassphrase(opts);
        }
      }
      return pass;
   }
   // Decrypts a v3 wallet file, asking for the passphrase until it opens.
   unlockWalletFile(record){
      const store = new SecureMnemonicStorage(this);
      let pass = envPassphrase();

      for (let attempt = 0; attempt < 3; attempt++) {
        if (!pass) pass = readHiddenLine('Wallet passphrase: ');
        if (!pass) break;
        try {
          const secrets = JSON.parse(store.decryptMnemonic(record, pass));
          this.passphrase = pass;
          return Object.assign({}, record, secrets);
        }
        catch {
          console.log('Wrong passphrase for ' + wfile);
          pass = null;
        }
      }
      console.log('Unable to unlock wallet.');
      process.exit(1);
   }
   // New method: Generate new wallet with mnemonic
   generateNewWallet() {
        const key = ec.genKeyPair();
        this.privateKey = key.getPrivate('hex');
        this.signingKey = ec.keyFromPrivate(this.privateKey);
        this.publicKey = key.getPublic('hex');

        // Generate BORG address
        let mkybc = bitcoin.payments.p2pkh({
            pubkey: Buffer.from(this.publicKey, 'hex')
        });
        this.ownMUID = mkybc.address;

        // Derive cipher key
        const cipherSeed = this.calculateHash(this.privateKey);
        const pmc = ec.keyFromPrivate(cipherSeed);
        this.pmCipherKey = pmc.getPublic('hex');

        mkybc = bitcoin.payments.p2pkh({
            pubkey: Buffer.from(this.pmCipherKey, 'hex')
        });
        this.walletCipher = mkybc.address;
        this.fileKey = deriveFileKey(this.privateKey);

        // Generate RSA keys
        const rsaMail = new mkyRSAMail(this.walletCipher);
        this.rsaKeys = rsaMail.generateKeys();

        // Generate mnemonic from private key
        const privateKeyBuffer = Buffer.from(this.privateKey, 'hex');
        this.mnemonic = borgMnemonic.privateKeyToMnemonic(privateKeyBuffer);

        // Save wallet
        this.writeWallet();
        this.newWallet = true;

        console.log(`🆕 New wallet generated: ${this.ownMUID}`);
        console.log('🔑 IMPORTANT: Save your mnemonic phrase:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(this.mnemonic);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('⚠️  Store this mnemonic securely!');
        console.log('⚠️  It can restore your entire identity!');
   }
   restoreFromMnemonic(mnemonic) {
      try {
            // Convert mnemonic back to private key
            const privateKeyBuffer = borgMnemonic.mnemonicToPrivateKey(mnemonic);
            this.privateKey = privateKeyBuffer.toString('hex');

            // Generate public key from private key
            this.signingKey = ec.keyFromPrivate(this.privateKey);
            this.publicKey = this.signingKey.getPublic('hex');

            // Generate BORG address
            let mkybc = bitcoin.payments.p2pkh({
                pubkey: Buffer.from(this.publicKey, 'hex')
            });
            this.ownMUID = mkybc.address;

            // Derive cipher key
            const cipherSeed = this.calculateHash(this.privateKey);
            const pmc = ec.keyFromPrivate(cipherSeed);
            this.pmCipherKey = pmc.getPublic('hex');

            mkybc = bitcoin.payments.p2pkh({
                pubkey: Buffer.from(this.pmCipherKey, 'hex')
            });
            this.walletCipher = mkybc.address;
            this.fileKey = deriveFileKey(this.privateKey);

            // Generate RSA keys
            const rsaMail = new mkyRSAMail(this.walletCipher);
            this.rsaKeys = rsaMail.generateKeys();

            // Store mnemonic
            this.mnemonic = mnemonic;

            // Save wallet
            this.writeWallet();
            this.newWallet = false;

            return {
                success: true,
                muid: this.ownMUID,
                publicKey: this.publicKey,
                message: 'Wallet restored from mnemonic'
            };
        } catch (error) {
            console.error('Failed to restore wallet from mnemonic:', error);
            return {
                success: false,
                error: error.message
            };
        }
   }
   // New method: Export mnemonic
   getMnemonic() {
        if (!this.mnemonic) {
            // The mnemonic is a reversible encoding of the private key, so it is
            // derived on demand rather than stored.
            const privateKeyBuffer = Buffer.from(this.privateKey, 'hex');
            this.mnemonic = borgMnemonic.privateKeyToMnemonic(privateKeyBuffer);
        }
        return this.mnemonic;
   }

   // New method: Verify mnemonic matches current wallet
   verifyMnemonic(mnemonic) {
        try {
            const privateKeyBuffer = borgMnemonic.mnemonicToPrivateKey(mnemonic);
            const recoveredPrivateKey = privateKeyBuffer.toString('hex');
            return recoveredPrivateKey === this.privateKey;
        } catch (error) {
            return false;
        }
   }
   async doUpdateBorgRegistry(){
     const regInfo   = this.net.wcj.imeta || {};
     regInfo.nicName = this.net.wcj.nicname;

     const msg = {
       req   : 'registerInBox',
       reqId : crypto.randomUUID(),
       icon  : regInfo,
       nic   : regInfo.nicName,
       // The registry doubles as the mail key directory: senders wrap message
       // keys to this, never to the EC signing key.
       mailPubKey : this.rsaKeys?.publicKey || null
     }
     console.log(`doUpdateBorgRegistry():: `,msg);
     let doTry = await this.net.PTree.mailTreeRegisterBorgUser(msg);
     
     console.log(`doUpdateBorgRegistry():: doTry`,doTry);
     if (doTry?.error === false && doTry?.status === 200 && doTry?.json?.result === true){
       this.net.wcj.borgReg = true;
       console.log(`doUpdateBorgRegistry():: `,this.net.wcj.borgReg);
       // Persist to disk
       await this.updateWConf(wconf,JSON.stringify(this.net.wcj));
       return true;
     }
     return false;
   }
   async updateWConf(data) {
     const tempFile = `${wconf}.tmp`;
     const newContent = JSON.stringify(this.net.wcj);
  
     try {
       // Step 1: Write to temp file
       await fs.promises.writeFile(tempFile, newContent, { flag: 'w' });
    
       // Step 2: Rename temp to target (atomic operation)
       await fs.promises.rename(tempFile, wconf);
    
       console.log(`updateWConf():: file updated successfully`);
       return true;
    
     } catch (err) {
       console.log(`updateWConf():: update failed:: `, err);
    
       // Clean up temp file if it exists
       try {
         await fs.promises.unlink(tempFile);
       } catch (cleanErr) {
         // Ignore cleanup errors
       }
       return false;
     }
   }
   async doSendBorgChatMsg(j,res){
     console.log(`doSendBorgChatMsg():: `,j);
     let doTry = await this.net.PTree.askTheBorg(this.ownMUID,j.parms.prompt);
     let htm = 'Service Not Available';
     if (doTry?.status === 404){
       htm = '<div class="infoCardClear" style="width:100%">Borg is currently offline... try again later</div>';
     }
     else if (doTry.status === 200){
       if (doTry?.json.result){
         htm = `<div class="infoCardClear" style="width:100%">${doTry.json.reply}</div>`;
       }
       else {
         htm = `<div class="infoCardClear" style="width:100%">${doTry.json.error}</div>`;
       }
     }
     console.log(`doSendBorgChatMsg():: doTry`,doTry);

     j.html   = `<h3>Borg Response.</h3>`;
     j.html  += htm;
     j.result = true;
     j.action = j.req;
     console.log(`doSendPeerQryResults():: `,j);
     res.end(JSON.stringify(j));
   }
   async doDisplayBorgMemory(j,res){
     console.log(`doDisplayBorgMemory():: `,j);

     j.html   = `memory created`;
     j.result = true;
     j.action = j.req;
     console.log(`doDisplayBorgMemory():: `,j);
     res.end(JSON.stringify(j));

     const p = await this.net.portal.selectPortal('shardTreeCell');

     const service = {
       endPoint : '/netREQ/',
       host     : p.host,
       port     : p.port,
       raw      : true
     };
     const memories = [];
     const m = j.parms;
     const qry = 'displayFullMemory.mem';

     memories.push({hash: m.memoryHash,ownMUID: m.ownMUID, shardHID: m.memoryID});

     this.net.MStream.doOpenMemStream(memories, service, qry,'dispFull');

   }
   async doDeleteBorgMemory(j,res){
     let memoryID = j.parms.memoryID;
     console.log(`doDeleteBorgMemory():: memory `,memoryID);
     let doTry = await this.net.PTree.deleteMemory(this.ownMUID,memoryID);
     console.log(`doDeleteBorgMemory():: doTry`,doTry);

     j.html   = `memory removed`;
     j.result = true;
     j.action = j.req;
     console.log(`doDeleteBorgMemory():: `,j);
     res.end(JSON.stringify(j));
   }
   async doSendChanChat(j,res){
     j.action = j.req;
     j.html   = 'Sending Message To BorgChat Network...';
     j.result = true;
     console.log(`doSendChanChat():: `,j);
     this.net.wsSoc.sendChatMessage(j.msg.chanID, j.msg.txt);
     res.end(JSON.stringify(j));
   }
   async doCreateBorgChannel(j,res){
     j.action = j.req;
     j.html   = 'Create Borg Channel request is processing... The Borg will notify you when complete';
     j.result = true;

     res.end(JSON.stringify(j));

     let memPrompt = await this.net.wsSoc.doCreateChannel(j);
     console.log(`doCreateBorgMemory():: prompt is `,memPrompt);

     if( memPrompt === null){
       j.html = 'Channel not created';
       j.result = false;
     }
     else if (memPrompt === true){
       j.html = 'Channel created and stored';
       j.result = true;
     }
     else {
       j.html = 'Channel not stored';
       j.result = true;
     }
   }
   async doCreateBorgMemory(j,res){
     j.action = j.req;
     j.html   = 'Memory request is processing... The borg will notify you when complete';
     j.result = true;

     res.end(JSON.stringify(j));

     let memPrompt = await this.net.MStream.doStoreMemory(j.memory);
     console.log(`doCreateBorgMemory():: prompt is `,memPrompt);

     if( memPrompt === null){
       j.html = 'memory not created';
       j.result = false;
     }
     else if (memPrompt === true){
       j.html = 'memory created and stored';
       j.result = true;
     }
     else {
       j.html = 'memory not stored';
       j.result = true;
     }
     this.net.pushEvent('borg-event',{req:"createBorgMemory",error:j.result,msg:j.html});
   }    
   async doSendPeerQryResults(j,res){
     console.log(j);
     const mbrMUID = 'publicAll';
     const qry = j.parms.qry.substring(0, 500);
     const type = null; //'BorgAgentMem';

     let response = await this.net.PTree.ptreeSearchMem(mbrMUID, qry,type,null,null);
     console.log(`response:`,response);
     if (typeof response === "string") {
       response = response.replace(/"{/g, "{")
                        .replace(/}"/g, "}")
                        .replace(/\\"/g, "\"")
                        .replace(/NULL/g, "");
     }
     let html = '';
     const memories = [];
     try {
       const out = JSON.parse(response.json);
       out.data.forEach( (r)=>{
         if (r.pmcMemObjID && r.pmcMemObjID != 'null'){
           html += `<div class="infoCardClear" style="width:100%" ID="mem-${r.pmcMemObjID}">memory - ${r.pmcMemObjID}</div>`;
           memories.push({hash: r.pmcMemObjID,ownMUID: r.pmcMownerID, shardHID: this.calculateHash(`${r.pmcMemObjID}-${r.pmcMownerID}`)});
         }
       }); 
     } catch(e) {
       console.log(e);
     } 

     j.html   = `<div class="infoCardClear"><h2>Search Results .:</h2></div>`;
     j.html  += html;
     j.result = true;
     j.action = j.req;
     console.log(`doSendPeerQryResults():: `,j);
     res.end(JSON.stringify(j));
     const p = await this.net.portal.selectPortal('shardTreeCell');

     const service = {
       endPoint : '/netREQ/',
       host     : p.host,
       port     : p.port,
       raw      : true
     };
     this.net.MStream.doOpenMemStream(memories, service, qry);
   }
   async doGetSendShellsToMbr(j,res){
     const p = j.parms
     j.html   = await this.net.BPay.getSendBorgForm(p.muid, p.nic, 0, p.icon);
     j.result = true;
     j.action = j.req;
     console.log(`doGetSendShellsToMbr():: `,j);
     res.end(JSON.stringify(j));
   }
   async doSendShells(j,res){
     let p = j.parms;
     let doTry = await this.net.PTree.peerPaysMakeUserTrans(this.ownMUID, p.mbrMUID, p.amt);
     console.log(`doSendShells():: send result`,doTry);
     if (doTry.error === false && doTry.status === 200 && doTry?.json?.result === 'tranOK'){
       j.info      = doTry.json;
       j.result    = true;
       j.actionRes = true;
     }
     else {
       j.result    = false;
       j.actionRes = false;
       j.msg       = 'Transaction Failed... Try Later';
     }
     j.action = j.req;
     res.end(JSON.stringify(j));
   }
   async doQryMemberSendTo(j,res){
     console.log(`doQryMemberSendTo():: `,j);

     const msg = {
       req     : 'findUsers',
       qry     : j.parms.qry,
       maxRows : j.parms.maxRows,
       reqId : crypto.randomUUID()
     }
     console.log(`doUpdateBorgRegistry():: `,msg);
     let doTry = await this.net.PTree.mailTreeRegisterBorgUser(msg);

     console.log(`doUpdateBorgRegistry():: doTry`,doTry);
     const html = this.buildUserRows(doTry.json.tRec);
     console.log(`doUpdateBorgRegistry():: html`,html);
     j.html   = html;
     j.result = true;
     j.action = j.req;

     res.end(JSON.stringify(j));
   }
   buildUserRows(tRec) {
     let html = "";

     tRec.forEach(rec => {

      // Build the raw repo file URL from record fields
      const rawURL =
        `/whzon/bitMiner/getFileFromRepo.php` +
        `?wzID=DESKTOP` +
        `&fname=${rec.msubIconFName}` +
        `&rname=${rec.msubIconRName}` +
        `&path=${rec.msubIconPath}` +
        `&ownerMUID=${rec.msubMUID}` +
        `&folderID=${rec.msubIconFolder}` +
        `&encrypt=0`;

      // Build the Borg file-fetch JSON payload
      const fileReq = {
        req: "getFileFromRepo",
        url: rawURL,  
        checkSum : rec.msubIconFCSum,
        ftype    : rec.msubIconFType
      };

      // Encode it for the netREQ/msg= format
      const iconURL = `http://localhost/netREQ/msg=${JSON.stringify(fileReq)}`;

      html += `
        <a href="javascript:getSendShellsToMbr('${rec.msubMUID}','${rec.msubBorgNic}','${encodeURIComponent(iconURL)}');">
        <div class="borgUserRow" style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid #333;">
        <img src='${iconURL}' style="width:32px;height:32px;border-radius:50%;margin-right:10px;object-fit:cover;">
        <div style="display:flex;flex-direction:column;">
        <span style="font-weight:bold;color:#fff;">${rec.msubBorgNic}</span>
        <span style="font-size:0.85em;color:#aaa;">${rec.msubMUID}</span>
        </div>
        </div>
      `;
     });

     return html;
   }

   async doUpdateMyIcon(j,res){
     const newIcon = decodeURIComponent(j.iconFile);
     this.net.wcj.icon = newIcon;
     this.net.wcj.imeta = j.icon;

     this.net.wcj.hasAccIcon = true;
     j.result = true;
     j.msg    = 'Account Icon Updated';

     // Do Update BorgMail User Registry with j.icon data
     let doTry = await this.doUpdateBorgRegistry();
     if (doTry ) this.net.wcj.borgReg = true;
       
     // Persist to disk
     if (await this.updateWConf(wconf,JSON.stringify(this.net.wcj)) === false){
       j.result = false;
       j.msg    = `Failed To Save... Try Again Please`;
     } else {
       this.net.icon = newIcon;
     }

     j.response = j.msg;
     console.log(`doUpdateMyIcon():: final`,j);

     res.end(JSON.stringify(j));
   }
   async doUpdateBorgProfile(j,res){
     console.log(`doUpdateBorgProfile():: `,j);
     this.net.wcj.nicName = j.nicname;
     this.net.wcj.nicname = j.nicname;
     this.net.wcj.icon = `/netREQ/file=${j.fuid}`;
     this.net.wcj.imeta = j.icon;

     this.net.wcj.hasAccIcon = true;

     //this.net.wcj.age     = ac.age;
     //this.net.wcj.sex     = ac.sex;

     // Do Update BorgMail User Registry with j.icon data
     let doTry = await this.doUpdateBorgRegistry();
     if (doTry ) this.net.wcj.borgReg = true;

     this.net.wcj.hasAccInfo      = true;

     j.result = true;
     j.msg    = 'Account Updated';


     // Persist to disk
     if (await this.updateWConf(wconf,JSON.stringify(this.net.wcj)) === false){
       j.result = false;
       j.msg    = `Failed To Save... Try Again Please`;
       return;
     }
     this.net.readConfigFile();

     j.response = j.msg;
     j.action   = 'updateAccount';

     console.log(`doUpdateBorgProfile():: final`,j);
     res.end(JSON.stringify(j));
   }
   async doCreateAccount(j,res){
     const ac = j.parms;
     this.net.wcj.nicName = ac.firstname;
     this.net.wcj.age     = ac.age;
     this.net.wcj.sex     = ac.sex;

     this.net.wcj.hasAccInfo      = true;
     j.result = true;
     j.msg    = 'Account Updated';

     // Persist to disk
     if (await this.updateWConf(wconf,JSON.stringify(this.net.wcj)) === false){
       j.result = false;
       j.msg    = `Failed To Save... Try Again Please`;
     }

     j.response = j.msg;

     console.log(`doCreateAccount():: final`,j);

     res.end(JSON.stringify(j)); 
   }
   async doCreateOpeningBalance(){
     let doTry = await this.net.PTree.peerPaysCreateOpeningBalance(this.ownMUID);
     console.log(`doCreateOpeningBalance():: doTry`,doTry);

     if (doTry.error === false){
       try {
         const j = JSON.parse(doTry?.raw);
         if (j.result === "tranOK"){
           this.net.wcj.openBal = true;
           // Persist to disk
           await this.updateWConf(wconf,JSON.stringify(this.net.wcj));
         }
       } catch(e){
         console.log(`doCreateOpeningBalance():: JSON er`,e);
       } 
     }       
   }
   async doCreateNewUserRootRepo(){

     const newRepo = await this.net.PTree.ftreeCreateRepo(this.ownMUID,'MyFiles',3);
     
     console.log(`doCreateNewUserRootRepo():: newRepo`,newRepo);   
     if (newRepo && newRepo?.error === false && newRepo?.json?.result === 'repoOK'){
       this.net.wcj.userRoot = true;
       await this.updateWConf(wconf,JSON.stringify(this.net.wcj));
       console.log(`doCreateNewUserRootRepo():: MyFiles repo created`);
       return;
     }     
     console.error(`doCreateNewUserRootRepo():: failed`,newRepo);
     return;
   }
   async doUploadFile(j, res) {
     console.log('doUploadFile::',j);
  
     const r = j.repoInfo;
     if (r.ownerMUID !== this.ownMUID){
       j.result     = true;
       j.data       = `Error`;
       j.response   = `This Repo Is Read Only... Access Denied.`;
       res.end(JSON.stringify(j));
       return;
     }

     const https    = require('https');
     const FormData = require('form-data');

     const filePath = j.filePath;  

     const p = await this.net.portal.selectPortal('shardTreeCell');

     const service = {
       endPoint : '/storeShard/',
       filename : filePath,
       host     : p.host,
       port     : p.port,
       raw      : true
     };

     // Try streaming file to the shardTreeCell network.
     let doTry = await this.net.DStream.streamTo(service);
     console.log(`doUploadFile():: doTry`,doTry);
     console.log(`doUploadFile():: hashes`,doTry.stream.shardHashes);

     if (doTry.result === 'xhrFail' || doTry?.res?.result !== 'STREAM_META_ACK'){
        let errorMsg = `doUploadFile():: stream to shard network failed Try later...`;
        console.log(errorMsg);
        j.result = true;
        j.data = `Error - ${errorMsg}`;
        j.response = `Error - ${errorMsg}`;
        res.end(JSON.stringify(j));
        return;
     }
     
     let ostream = await this.net.DStream.uploadResult(doTry.stream.streamId);
     console.log(`ftreeInsertFileToRepo():: ostream`,ostream,ostream.shardHashes);

     // File stored OK so send meta data to the ftreeFileMgrCell
     doTry = await this.ftreeInsertFileToRepo(ostream, r.ownerMUID, r.rname, r.filename,j.mimeType, r.path, r.folderID, 3,r.encrypt);
     console.log(`ftreeInsertFileToRepo():: doTry is `, doTry);
     if (!doTry){
        let errorMsg = `doUploadFile():: stream to shard network failed Try later...`;
        j.result     = true;
        j.data       = `Error - ${errorMsg}`;
        j.response   = `Error - ${errorMsg}`;
        res.end(JSON.stringify(j));
        return;
     }
     if (doTry.result === false){
        let errorMsg = doTry.msg;
        j.result     = true;
        j.data       = `Error - ${errorMsg}`;
        j.response   = errorMsg;
        console.log(`doTry:: false`,j);       
        res.end(JSON.stringify(j));
        return;
     }

     j.result = true;
     j.msg = 'File uploaded successfully.';
     j.response = j.msg;
     j.fuid = doTry.fuid;

     console.log(`doUploadFile():: final`,j);

     res.end(JSON.stringify(j));

  }
  buildShardMap(stream) {
    const shards = [];
    const fname = stream.filename;
    const chunkSize = stream.shardSize;

    for (let shardIndex = 0; shardIndex < stream.count; shardIndex++) {
      const shardHash = stream.shardHashes[shardIndex];

      const smap = {
        Result   : false,
        shardID  : shardHash.hash,         // already SHA-256 hex
        shardHID : shardHash.hashHID,      // Shard Idenity Pointer.
        startPos : shardIndex * chunkSize,
        nStored  : 0,
        index    : shardIndex,
        hosts    : [],
      };

      shards.push(smap);
    }

    return shards;
  }
  async doHandleBorgFileSys(m, res) {
    console.log(`doHandleBorgFileSys():: `, m);

    if (m.req === 'sendBorgFileSys') {
      m.url = m.service.endPoint;
      await this.doRenderFileSys(m,res);
      return;
    }
    if (m.req === 'borgUpdateResByUrl'){
      m.url = m.parms.url;
      if (m.url.startsWith('/whzon/bitMiner/sendBorgFileSys')){
        await this.doRenderFileSys(m,res);
        return;
      }
      if (m.url.startsWith(`/whzon/bitMiner/borgDelFileFromRepo`)){
        await this.doDeleteFile(m,res);
        return;
      }
      if (m.url.startsWith(`/whzon/bitMiner/createRepo.`)){
        await this.doCreateRepo(m,res);
        return;
      }
      if (m.url.startsWith(`/whzon/bitMiner/createRepoFolder.`)){
        await this.doCreateRepoFolder(m,res);
        return;
      }
    }
    res.end('doHandleBorgFileSys():: Failed.. no endpoint found');
  }
  async doCreateRepoFolder(m,res){
    console.log(`doCreateRepoFolder():: m.url`,m.url);
    let result = 'OK'
    let doTry = await this.net.UI.createRepoFolderGET(m.url);
    let html  = JSON.stringify(doTry);
    if  (doTry.status === null){
      html = JSON.stringify(doTry);
      result = 'FAIL'
    }
    console.log(`doCreateRepoFolder():: doTry`,doTry);
    const j = {
      action : m.req,
      result : true,
      res : {
        result  : result,
        url     : m.url,
        folder  : doTry.folder,
        name    : doTry.name,
        parent  : doTry.parent,
        newRepo : doTry.newRepo.json.result,
        owner   : this.ownMUID
      }, 
      html   : html,
      js     : "",
      jsID   : this.calculateHash(JSON.stringify(doTry)),
      pMUID  : this.ownMUID
    }
    console.log(`doCreateRepoFolder():: sending j`,j);
    res.end(JSON.stringify(j));
    return;
  }
  async doSendBorgTime(m,res){
    const j = {
      action   : m.req,
      borgTime : peerTCorrection,
    }
    res.end(JSON.stringify(j));
    return;
  }
  async doSendWalletOptions(m,res){
    let doTry  = 'Fill this in later';
    const html = `
      <div class='infoCardClear'>
      <div ID='menuBar' align='right' style='background:none;padding:0.5em 0em 0.5em 1em;'>
      <input type='button' value=' Close ' onclick='doCloseWalletOpt();'>
      </div>
      <div ID='walletBody' style='background:#151617;padding:0.5em;'>
      <div ID='autoSelSpot'></div>
      </div>
    `;

    const j = {
      action : m.req,
      result : true,
      html   : html,
      js     : "",
      jsID   : this.calculateHash(JSON.stringify(doTry)),
      pMUID  : this.ownMUID
    }
    res.end(JSON.stringify(j));
    return;
  }
  async doCreateRepo(m,res){
    console.log(`doCreateRepo():: m.url`,m.url);

    let doTry = await this.net.UI.createRepoGET(m.url);
    let html  = JSON.stringify(doTry);
    if  (doTry.status === null){
      html = JSON.stringify(doTry);
    }
    console.log(`doCreateRepo():: doTry`,doTry);
    const j = {
      action : m.req,
      result : true,
      html   : html,
      js     : "",
      jsID   : this.calculateHash(JSON.stringify(doTry)),
      pMUID  : this.ownMUID
    }
    res.end(JSON.stringify(j));
    return;
  }
  async doDeleteFile(m,res){
    console.log(`doDeleteFile():: m.url`,m.url);
    let doTry = await this.net.UI.deleteFileFromRepoGET(m.url);
    console.log(`doDeleteFile():: doTry`,doTry);

    // 5. Build response object
    const j = {
      action : m.req,
      result : true,
      html   : doTry,
      js     : "",
      jsID   : this.calculateHash(doTry),
      pMUID  : this.ownMUID
    };

    console.log(`this.UI.dodeletFile():: `, j);
    res.end(JSON.stringify(j));
    return;
  }
  async doRenderFileSys(m,res){
    // 1. Build repo context from GET string
    console.log(`doRenderFileSys():: m.url`,m.url);

    const urlObj = new URL(m.url, "http://localhost"); // base required
    const queryString = urlObj.search.replace(/^\?/, "");

    const ctx = await this.net.UI.initRepoContextFromGET(queryString);

    // 2. Build HTML
    const htm = await this.net.UI.getBorgFileSys(queryString);

    // 3. Load JS template
    let jsCode = fs.readFileSync('./borgHUIFileSysJS.js', 'utf8');

    // 4. Inject server-side values into the JS code
    jsCode =
      `// Injected by BorgHUI\n` +
      `var sKey      = "${ctx.sessISMOBILE ? 'MOBILE' : 'DESKTOP'}";\n` +
      `var mbrMUID   = "${ctx.mbrMUID}";\n` +
      `var rname     = "${ctx.rname}";\n` +
      `var path      = "${ctx.path}";\n` +
      `var folderID  = "${ctx.folderID}";\n` +
      `var foldName  = "${ctx.fname}";\n` +
      `var queryString = "${m.url.replace(/"/g, '\\"')}";\n\n` +
      jsCode;

    // 5. Build response object
    const j = {
      action : m.req,
      result : true,
      html   : htm,
      js     : jsCode,
      jsID   : this.calculateHash(jsCode),
      pMUID  : this.ownMUID
    };

    res.end(JSON.stringify(j));
    return;
  }
  async doSendAccountInfo(m,res){
    let j = await this.net.BPay.doSendBorgPayRecentTrans(m);
    if (this.net.wcj?.hasFarm === true){
      j.myFarms = this.net.PTree.mailTreeGetFarms(this.ownMUID);
    }
    j.hasAccount = this.net.wcj.hasAccInfo; 
    res.end(JSON.stringify(j));
    return;    
  }
  async ftreeInsertFileToRepo(stream,muid, name, file,mimeType, path, folderID, nCopys,encrypt) {
    const j = {
      from     : muid,
      name     : name,
      file     : {
        owner     : muid,
        filename  : file,
        ftype     : mimeType,
        encrypt   : encrypt,
        shards    : this.buildShardMap(stream),
        checksum  : stream.streamId,
        fileSize  : stream.totalSize,
        shardSize : stream.shardSize 
      }, 
      path     : path,
      folderID : folderID,
      nCopys   : Number(nCopys),
    };

    // Remove leading slash if path is not root
    if (j.path !== '/') {
      j.path = j.path.replace('/', '');
    }

     const p = await this.net.portal.selectPortal('ftreeFileMgrCell');

     const service = {
       endPoint : '/netREQ/',
       host     : p.host,
       port     : p.port,
       raw      : true
     };

    const msg = {
      req   : "insertRSfile",
      reqId : crypto.randomUUID(), 
      repo  : j
    }
    console.log(`ftreeInsertFileToRepo():: `,service,msg);
    this.net.DStream.sendMsgCX(service,msg);

    const bcRes = await this.responseToRepoInsert(msg.reqId);
    return bcRes;
  }
  responseToRepoInsert(reqId){
    return new Promise( (resolve) => {
      let lsFail,lsOK;
    
      const finish = (result) => {
        this.net.removeListener('xhrFail', lsFail);
        this.net.removeListener('xhrPostOK', lsOK);
        resolve(result);
      }

      this.net.on('xhrFail', lsFail = (msg) => {
        if (msg.reqId === reqId) {
          finish(false);
        }    
      });

      this.net.on('xhrPostOK',lsOK = (msg) =>{
        if (msg.reqId === reqId) {
          finish(msg.res);
        }
      });
    });
  }
  writeWallet(){
     const secrets = {
       privateKey   : this.privateKey,
       walletCipher : this.walletCipher,
       rsaKeys      : this.rsaKeys
     };
     const record = {
       version   : WALLET_VERSION,
       ownMUID   : this.ownMUID,
       publicKey : this.publicKey,
       created   : Date.now()
     };

     if (this.passphrase) {
       const store = new SecureMnemonicStorage(this);
       Object.assign(record, store.encryptMnemonic(JSON.stringify(secrets), this.passphrase));
     }
     else {
       Object.assign(record, secrets);
     }

     fs.writeFileSync(wfile, JSON.stringify(record, null, 2), {mode:0o600});
     console.log(this.passphrase ? 'Wallet saved (encrypted).' : 'Wallet saved (NOT encrypted).');
   }
   // Constant-time check of a passphrase supplied by the local UI.
   passphraseMatches(candidate){
     if (!this.passphrase || typeof candidate !== 'string') return false;
     const a = Buffer.from(this.passphrase, 'utf8');
     const b = Buffer.from(candidate, 'utf8');
     if (a.length !== b.length) return false;
     return crypto.timingSafeEqual(a, b);
   }
   getRsaMailObj(){
     if (!this.rsaMail){
       this.rsaMail = new mkyRSAMail(this.walletCipher,this.rsaKeys);
     }
     return this.rsaMail;
   }
   doRsaDecodeMsg(j,res){
     this.getRsaMailObj();
     const msgTok = this.rsaMail.decryptString(j.parms.msg.rsaToken);
     const msgIV  = this.rsaMail.decryptString(j.parms.msg.rsaIV);
     j.msgClear   = this.deCypher(j.parms.msg.body,msgTok,msgIV);
     res.end(JSON.stringify(j));
   }
   doRsaEncodeMsg(j,res){
     this.getRsaMailObj();
     const randTok = crypto.randomBytes(32).toString('base64');
     const randIV  = crypto.randomBytes(16).toString('base64');
     j.msgEncoded  = this.enCrypt(j.parms.msg.body,randTok,randIV);
     j.msgRsaToken = this.rsaMail.encryptString(randTok,j.parms.msg.toPubKey);
     j.msgRsaIV    = this.rsaMail.encryptString(randIV,j.parms.msg.toPubKey);
     res.end(JSON.stringify(j));
   }
   /***************************************************************
   mailTree mail
   ==============================================================
   The registry hands out the recipient's mail public key, the body is
   sealed here with a one-time message key wrapped to that public key,
   and only the sealed envelope is posted. Cells store an opaque blob.
   */
   async doSendBorgMail(j,res){
     const parms  = j.parms || {};
     const toMUID = parms.to;
     if (!toMUID){
       res.end(JSON.stringify({result:false,error:'no recipient MUID'}));
       return;
     }
     const lookUp = await this.net.PTree.mailTreeGetInBoxKey(toMUID);
     const toKey  = lookUp?.json?.mailPubKey;
     if (lookUp?.json?.result !== true || !toKey){
       // No registered mail key means nothing can be sealed for this user:
       // refuse rather than fall back to something the cell could read.
       res.end(JSON.stringify({result:false,error:'recipient has no registered mail key'}));
       return;
     }

     let envelope = null;
     try {
       envelope = mailCrypto.sealMail(toKey,{
         from : this.ownMUID,
         to   : toMUID,
         msg  : {subject : parms.subject || '', body : parms.body || '', attach : parms.attach || null}
       });
     }
     catch(err) {
       console.log('doSendBorgMail():: seal failed',err);
       res.end(JSON.stringify({result:false,error:err.message}));
       return;
     }

     const nCopys = parms.nCopys || 3;
     const post   = await this.net.PTree.mailTreeSendMail(envelope,nCopys);
     const stored = post?.json?.nStored || 0;
     res.end(JSON.stringify({
       result  : stored > 0,
       hash    : envelope.hash,
       nStored : stored,
       error   : stored > 0 ? null : (post?.json?.mail || 'mail was not stored')
     }));
   }
   // Broadcast retrieval: cells holding mail for this MUID reply with the
   // envelopes, which are opened here with the local private key.
   async doGetMyBorgMail(j,res){
     const got  = await this.net.PTree.mailTreeGetMyMail();
     const rows = got?.json?.mail || [];
     const mail = [];

     for (const row of rows){
       const item = {
         hash : row.hash,
         from : row.envelope?.from,
         date : row.envelope?.date,
         hosts: row.hosts || []
       };
       try {
         item.msg = this.openBorgMail(row.envelope);
       }
       catch(err) {
         // A mail we cannot open is still reported: the user should see that
         // something arrived that their key does not fit.
         item.error = err.message;
       }
       mail.push(item);
     }
     res.end(JSON.stringify({result:true,nRecs:mail.length,mail:mail}));
   }
   openBorgMail(envelope){
     if (!this.rsaKeys?.privateKey) throw new Error('wallet has no mail private key');
     return mailCrypto.openMail({
       privateKey : this.rsaKeys.privateKey,
       passphrase : this.walletCipher
     },envelope);
   }
   async doDeleteBorgMail(j,res){
     const hash = j.parms?.hash;
     if (!hash){
       res.end(JSON.stringify({result:false,error:'no mail hash'}));
       return;
     }
     const gone = await this.net.PTree.mailTreeDeleteMail(hash);
     res.end(JSON.stringify({result: gone?.json?.result === true}));
   }
   async encryptXChaCha20(msg, key) {
     await sodium.ready;

     // Convert message to Uint8Array
     const messageBytes = Buffer.isBuffer(msg)
      ? new Uint8Array(msg)
      : sodium.from_string(msg);

     // 24-byte XChaCha20 nonce
     const nonce = sodium.randombytes_buf(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
     );

     // AEAD encrypt
     const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
       messageBytes,
       null,   // no additional authenticated data
       null,   // no secret nonce
       nonce,
       key
     );

     return {
       nonce: Buffer.from(nonce),
       ciphertext: Buffer.from(ciphertext)
     };
   }
   async decryptXChaCha20(ciphertext, nonce, key) {
     await sodium.ready;

     const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
       null,   // no secret nonce
       new Uint8Array(ciphertext),
       null,   // no AAD
       new Uint8Array(nonce),
       key
     );

     return Buffer.from(plaintext).toString("utf8");
   }
   enCrypt(msg,msgToken,msgIV){
     let cipher = crypto.createCipheriv(ALGO, msgToken, msgIV);
     let encrypted = cipher.update(msg, 'utf8', 'base64');
     encrypted += cipher.final('base64');
     return encrypted;
   }
   deCypher(msg,msgKey,msgIV){
     let decipher = crypto.createDecipheriv(ALGO, msgKey, msgIV);
     let decrypted = decipher.update(msg, 'base64', 'utf8');
     return (decrypted + decipher.final('utf8'));
   }
   signMsg(stok) {
     const sig = this.signingKey.sign(this.calculateHash(stok), 'base64');
     const hexSig = sig.toDER('hex');
     return hexSig;
   }
   doMakeReq(action,res,parms,service){
     const stok = this.ownMUID+Date.now(); 	   
     var msg = {
       Address : this.ownMUID,
       sesTok  : stok,
       pubKey  : this.publicKey,
       sesSig  : this.signMsg(stok),
       action  : action,
       parms   : parms
     }
     this.sendPostRequest(msg,res,service);
   }

   handleResponse(data,res){
     data.pMUID = this.ownMUID;
     console.log('API-Response:\n\n',data);
     if (data.callBack){
       this.handleCallBack(data,res);
     }
     else if (res){
       res.end(JSON.stringify(data));
     }
   }
   handleCallBack(j,wres){
      if(j.action == 'cbkSignToken'){
        j.orig.parms.tokenSig = this.signMsg(j.token);
        console.log('callback is now:',j.orig);
        this.sendPostRequest(j.orig,wres);
      }          
   }
   async doRSVExecuteCmd(j,res){
     let service = await this.net.portal.selectPortal(svcName);
     if (service.endPoint === '' || service.endPoint === null){
       service.endPoint === '/netREQ';
     }
     var conf = confirm("run service https://"+service.host+':'+service.port+'/'+service.endPoint+" Now?");
     if (conf){
       this.sendPostRequest(msg,div,service);
     }
   }
   getBorgToken(){
     const reqId   = crypto.randomUUID();
     const reqTime = Date.now();
     const btok    = `${this.ownMUID}-${reqTime}-${reqId}`;

     const borgToken = {
       reqId   : reqId,
       reqTime : reqTime,
       Address : this.ownMUID,
       sesTok  : btok,
       pubKey  : this.publicKey,
       sesSig  : this.signMsg(btok),
     }
     return borgToken;
   }
   sendPostRequest(msg,wres=null,service=null,redirectCount=0){
     return new Promise((resolve) => { 
       const MAX_REDIRECTS = 5; // Limit the number of redirects

       msg.borgToken = this.getBorgToken();

       if (redirectCount > 0 ) {
         console.log('REDIRECT::',redirectCount,service);
       }
       if (redirectCount > MAX_REDIRECTS) {
         console.log("Maximum redirects reached. Aborting request.");
         resolve(null);
         return;
       }


       if (service === null){
         service = {
           endPoint : '/whzon/gold/netWalletAPI.php',
           host     : 'web.bitmonky.com',
           port     : ''
         }
       }
       console.log('sendPostRequest():: sending msg :',msg,service);
       const https = require('https');

       const data = JSON.stringify(msg);
       const agent = new https.Agent({
         rejectUnauthorized: false 
       });
       //console.log('Service::: ',service);
       const headers = {};

       if (service.raw === true) {
         // Do NOT set JSON headers
         headers['Content-Type'] = 'text/plain';
         headers['Content-Length'] = Buffer.byteLength(data);
       } else {
         // JSON mode
         headers['Content-Type'] = 'application/json';
         headers['Content-Length'] = Buffer.byteLength(data);
       }


       const options = {
         hostname : urldecode(service.host),
         port     : urldecode(service.port),
         path     : encodeURI(service.endPoint),
         method   :'POST',
         agent    : agent,
         headers  : headers,
       }
       const req = https.request(options, res => {
         let chunks = [];
         res.on('data', (chunk)=>{
            chunks.push(chunk);
         });

         res.on('end',async ()=>{
           const body = Buffer.concat(chunks);
           if (res.statusCode === 302) {
             const redirectUrl = res.headers.location;
             if (redirectUrl) {
               const parsedUrl = new URL(redirectUrl);
               const newService = {
                 endPoint: parsedUrl.pathname + parsedUrl.search, 
                 host: parsedUrl.hostname,
                 port: parsedUrl.port || '' 
               };

               console.log(`Redirecting to: ${redirectUrl}`);
               await this.sendPostRequest(msg, wres, newService, redirectCount + 1);
             } 
             else {
               console.log('Redirect response received, but no location header provided.');
               resolve(null);
               return;
             }
           }
           else if (res.statusCode != 200) {
             console.log("Api call failed with response code " + res.statusCode);
             resolve(null);
             return;
           } 
	   else {
             //console.log('API Response:->',body);
             // Only treat raw mode as true if explicitly set to true
             if (service.raw === true) {
               resolve(body);
               return;
             }
             try {
               this.handleResponse(JSON.parse(body),wres);
               resolve(true);
             }
             catch(err) {
               resolve(null);
               console.log(err);
             }
           }
         });
       });
       req.on('error', error => {
          console.log(error);
       });

       req.write(data);
       req.end();
     });
   } 
};

const myWallet = new bitMonkyWSrv();

module.exports.bitMonkyWSrv = bitMonkyWSrv;
