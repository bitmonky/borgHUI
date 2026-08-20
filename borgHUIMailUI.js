// BorgIOS Unified Server-Side HTML Builder - Mail
// Produces one giant HTML string to send to the browser.
// Mirrors BorgHUIFileMgrUI (Collective File System) for the mailTree.

class BorgHUIMailUI {
  constructor(net){
    this.net = net;
  }
  //
  // ---------------------------------------------------------
  // INIT CONTEXT (mirrors initRepoContextFromGET)
  // ---------------------------------------------------------
  //
  async initMailContextFromGET(queryString) {
    const params = Object.fromEntries(
      new URLSearchParams(queryString.replace(/^\?/, ""))
    );

    const ownMUID      = this.net.wallet.ownMUID;
    const borgReg      = !!this.net.wcj?.borgReg;
    const mailPubKey   = this.net.wallet.rsaKeys?.publicKey || null;
    const folder       = params.folder || "all";
    const sessISMOBILE = params.sessISMOBILE === "1" || params.sessISMOBILE === "true";

    return {
      ownMUID,
      borgReg,
      mailPubKey,
      folder,
      sessISMOBILE
    };
  }
  //
  // ---------------------------------------------------------
  // MAIL BOX PAGE (mirrors getBorgFileSys)
  // ---------------------------------------------------------
  //
  async getMailBox(queryString) {
    const ctx = await this.initMailContextFromGET(queryString);

    let html = "";
    html += `
      <style>
      .unicode-button {
        display: inline-block;
        white-space: nowrap;
        width: auto;
        margin: 0.5em 0;
        font-size: 1em;
        color: white;
        padding:1px 7px 1px 3px;
        background-color:#74a02a;
        border-radius: .25em;
        -webkit-border-radius: .25em;
        -moz-border-radius: .25em;
        transition: all 300ms ease;
        border:0;
        box-shadow:none;
        text-shadow:none;
      }

      button.unicode-button {
        cursor: pointer;
        overflow: visible;
      }

      .unicode-button:before {
        content: "\\27A3";
        padding-right: 10px;
      }

      .unicode-button:focus {
        outline: 0;
      }
      </style>
    `;
    //
    // ---------------------------------------------------------
    // HEADER
    // ---------------------------------------------------------
    //
    html += `
      <h1>BorgIOS .: Collective Mail System</h1>
      <div align='right' style='margin-bottom:.5em;'></div>
    `;

    //
    // ---------------------------------------------------------
    // LAYOUT WRAPPER
    // ---------------------------------------------------------
    //
    if (!ctx.sessISMOBILE) {
      html += `
        <table style='width:calc(100%);'>
        <tr valign='top'>
        <td style="width:25%;min-width:25em;">
      `;
    } else {
      html += `<p/>`;
    }

    //
    // ---------------------------------------------------------
    // SIDEBAR
    // ---------------------------------------------------------
    //
    const sidebarHTML = await this.buildMailSidebarHTML(ctx);

    html += `
      <div id='sideBar' style='overflow:auto;'>
        ${sidebarHTML}
      </div>
    `;

    //
    // ---------------------------------------------------------
    // RIGHT SIDE (desktop only)
    // ---------------------------------------------------------
    //
    if (!ctx.sessISMOBILE) {
      html += `
        </td>
        <td style='overflow:auto;padding-left:2em;'>
      `;
    } else {
      html += `<p/>`;
    }

    //
    // ---------------------------------------------------------
    // MAIL READER AREA
    // ---------------------------------------------------------
    //
    html += `
      <div id='mailReaderSpot' style='display:none;padding:.5em;height:28px;color:#777777;'>
        <div class='mkyloader'></div>Fetching Mail From PeerTree...
      </div>

      <div class='infoCardClear' style='background:#151515;' id='mailDisplaySpot'>
        <div id='mailActionSpot' align='right' style='display:none;padding:.5em;color:#777777;'>
          <input type='button' value=' Reply '    id='mailReplyBut' onclick='composeReply();'/>
          <input type='button' value=' Delete '   id='mailDeleteBut' onclick='deleteMailMsg(curMailHash);'/>
        </div>

        <div id='mailViewSpot'></div>
      </div>
    `;

    //
    // ---------------------------------------------------------
    // COMPOSE PANEL
    // ---------------------------------------------------------
    //
    html += `
      <div class='infoCardClear' style='background:#151515;' id='composeSpot'>
        ${this.drawComposeFormHTML(ctx)}
      </div>
    `;

    //
    // ---------------------------------------------------------
    // CLOSE DESKTOP TABLE
    // ---------------------------------------------------------
    //
    if (!ctx.sessISMOBILE) {
      html += `
        </td>
        </tr>
        </table>
      `;
    }

    return html;
  }
  //
  // ---------------------------------------------------------
  // SIDEBAR BUILDER (HTML STRING)
  // ---------------------------------------------------------
  //
  async buildMailSidebarHTML(ctx) {
    const { ownMUID, borgReg, folder } = ctx;

    let html = "";

    // ACCOUNT + REGISTRATION CARD
    html += `
      <div class='infoCardClear' style='background:#151515;color:white;'>
        <div align='right'>
          <input type='button' value=' Refresh ' onclick='refreshMailBox();'/>
        </div>

        <div class='infoCardClear' style='background:#333333;color:darkKhaki;margin-top:.5em;'>
          <b>My Mail Inbox</b><br/>
          <span style='color:gray;'>MUID:</span> <span style='color:white;'>${esc(ownMUID)}</span><br/>
          ${borgReg
            ? `<span style='color:#8ec634;'>Inbox Registered</span>`
            : `<span style='color:#cc6666;'>Inbox Not Registered</span>
               <input type='button' value=' Register Inbox ' onclick='registerMyInBox();'/>`
          }
        </div>
      </div>
    `;

    // FOLDER NAV
    html += `
      <div class='infoCardClear' style='background:#333333;color:darkKhaki;margin-top:.5em;'>
        <h3 style='color:white;'>Folders</h3>
        <div id='mailFolderSpot'>
          <a href="javascript:selectFolder('all');">
            <div style='width:100%;padding:.0em .5em .5em 1.5em;'>All Mail${folder === 'all' ? ' <span style="color:#8ec634;">*</span>' : ''}</div>
          </a>
          <a href="javascript:selectFolder('inbox');">
            <div style='width:100%;padding:.0em .5em .5em 1.5em;'>Inbox${folder === 'inbox' ? ' <span style="color:#8ec634;">*</span>' : ''}</div>
          </a>
          <a href="javascript:selectFolder('sent');">
            <div style='width:100%;padding:.0em .5em .5em 1.5em;'>Sent${folder === 'sent' ? ' <span style="color:#8ec634;">*</span>' : ''}</div>
          </a>
        </div>
      </div>
    `;

    // MAIL LIST
    html += `
      <div class='infoCardClear' style='background:#333333;color:darkKhaki;margin-top:.5em;'>
        <h3 style='color:white;'>Mail - ${folder}</h3>
        <div id="mailListSpot">
    `;

    const got  = await this.net.PTree.mailTreeGetMyMail();
    console.log(`GOT:: `,got);
    const rows = got?.json?.mail || [];
    const items = [];

    for (const row of rows) {
      const item = {
        hash  : row.hash,
        from  : row.envelope?.from || '',
        to    : row.envelope?.to   || '',
        date  : row.envelope?.date || 0,
        hosts : row.hosts || [],
        error : null
      };
      try {
        const msg = this.net.wallet.openBorgMail(row.envelope);
        item.subject = (msg && msg.subject) ? String(msg.subject) : '(no subject)';
        item.body    = (msg && msg.body)    ? String(msg.body)    : '';
      }
      catch(err) {
        item.subject = '[Cannot decrypt]';
        item.body    = '';
        item.error   = err.message;
      }
      items.push(item);
    }

    const shown = items.filter(item => this.mailInFolder(item, folder, ownMUID));

    if (shown.length === 0) {
      html += `<div style='padding:.5em 0 .5em 1.5em;color:#999999;'>No mail in this folder.</div>`;
    } else {
      for (const item of shown) {
        html += this.mailRowHTML(item, ownMUID);
      }
    }

    html += `
        </div>
      </div>
    `;

    // CACHE THE FULL LIST FOR THE CLIENT (mirrors the cfileData global pattern)
    this.net.pushEvent('borg-event',{req:"updateMailCache",mailCache: items});

    return html;
  }
  //
  // ---------------------------------------------------------
  // FOLDER FILTER (shared with the client-side renderMailList)
  // ---------------------------------------------------------
  //
  mailInFolder(item, f, ownMUID) {
    f = f || 'all';
    if (f === 'inbox') {
      // Prefer the clear-text recipient header; degrade to "not from me".
      return (item.to && item.to === ownMUID) || (!item.to && item.from !== ownMUID);
    }
    if (f === 'sent') return item.from === ownMUID;
    return true;
  }
  //
  // ---------------------------------------------------------
  // MAIL ROW (HTML STRING)
  // ---------------------------------------------------------
  //
  mailRowHTML(item, ownMUID) {
    const fromLabel = item.from === ownMUID
      ? `To: ${esc(item.to || '?')}`
      : `From: ${esc(item.from || '?')}`;

    return `
      <div id="mail:${esc(item.hash)}" class="mailRow" onclick="openMailMsg('${esc(item.hash)}');">
        <span>${mailDateStr(item.date)} - ${esc(item.subject || '')}</span>
        <span style="float:right;color:#cc6666;cursor:pointer;" onclick="event.stopPropagation();deleteMailMsg('${esc(item.hash)}');">[x]</span>
        <div class="mailMeta">${fromLabel}${item.error ? ` <span style="color:#cc6666;">(${esc(item.error)})</span>` : ''}</div>
      </div>
    `;
  }
  //
  // ---------------------------------------------------------
  // COMPOSE FORM (HTML STRING) - mirrors drawFolderFormHTML
  // ---------------------------------------------------------
  //
  drawComposeFormHTML(ctx) {
    return `
      <div class='infoCardClear' style='background:#333333;color:darkKhaki;margin-top:.5em;'>
        <h2 style='color:white;'>Compose Mail</h2>
        <form style='margin-top:1.5em;' onsubmit="return false" enctype="multipart/form-data">
          <b>To (MUID):</b><br/>
          <input type='text' style='width:80%' id='mailTo' placeholder='Recipient MUID'>
          <input id="mailToSearch" value=" Search " onclick="findBorgUser();" type="button"
                 style="border-radius:.45em;border:0px solid #efefef;">
          <div id="userSearchResults" style='margin-top:.5em;color:white;'></div>
          <b>Subject:</b><br/>
          <input type='text' style='width:80%' id='mailSubject' placeholder='Subject'><br/>
          <b>Body:</b><br/>
          <textarea id='mailBody' style='width:90%;height:8em;' placeholder='Message Body'></textarea><br/>
          <input id="mailSendIt" value=" Send Mail " onclick="sendMailMsg();" type="button"
                 style="border-radius:.45em;border:0px solid #efefef;">
          <div id="mailSendSpot"></div>
        </form>
      </div>
    `;
  }
  //
  // ---------------------------------------------------------
  // USER SEARCH ROWS (HTML STRING) - mirrors buildUserRows
  // ---------------------------------------------------------
  //
  buildMailUserRows(tRec) {
    let html = "";
    (tRec || []).forEach(rec => {
      html += `
        <div class="borgUserRow" style="cursor:pointer;" onclick="pickBorgUser('${esc(rec.msubMUID)}','${esc(rec.msubBorgNic)}');">
          <div style="display:flex;flex-direction:column;">
            <span style="font-weight:bold;color:#fff;">${esc(rec.msubBorgNic)}</span>
            <span style="font-size:0.85em;color:#aaa;">${esc(rec.msubMUID)}</span>
          </div>
        </div>
      `;
    });
    if (html === "") {
      html = `<div style='color:#999999;'>No users found.</div>`;
    }
    return html;
  }
};

// ---------------------------------------------------------
// HTML ESCAPE + DATE HELPERS (module scope, mirrors left())
// ---------------------------------------------------------
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mailDateStr(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

module.exports.BorgHUIMailUI = BorgHUIMailUI;
