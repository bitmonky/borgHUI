// -------------------------------------------------------
// BorgIOS Mail Sys - client side (injected by doRenderMailSys)
// Mirrors borgHUIFileSysJS.js for the mailTree.
// Injected before serving: ownMUID, borgReg, folder, queryString
// -------------------------------------------------------

var mailCache    = [];
var curMailHash  = null;

// -------------------------------------------------------
// Utility functions
// -------------------------------------------------------
function noenter() {
  return !(window.event && window.event.keyCode == 13);
}

function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMailDate(ts) {
  if (!ts) return "";
  var d = new Date(Number(ts));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function showMailSearching() {
  var spot = document.getElementById('mailReaderSpot');
  if (spot) spot.style.display = 'block';
}

function hideMailSearching() {
  var spot = document.getElementById('mailReaderSpot');
  if (spot) spot.style.display = 'none';
}

// -------------------------------------------------------
// Re-render helpers
// -------------------------------------------------------
function borgMailUpdateResByUrl(url, res, callbck = null) {
  sendRequest({
    req: 'borgMailUpdateResByUrl',
    parms: { mode: MODE, url, res },
    callbck
  });
}

function refreshMailBox() {
  borgMailUpdateResByUrl('/whzon/bitMiner/sendBorgMailSys.php?' + queryString, 'serviceMenu');
}

function mailFolderFilter(item, f) {
  f = f || 'all';
  if (f === 'inbox') {
    // Prefer the clear-text recipient header; degrade to "not from me".
    return (item.to && item.to === ownMUID) || (!item.to && item.from !== ownMUID);
  }
  if (f === 'sent') return item.from === ownMUID;
  return true;
}

function mailFromLabel(item) {
  if (item.from === ownMUID) return 'To: ' + escapeHTML(item.to || '?');
  return 'From: ' + escapeHTML(item.from || '?');
}

function mailRowHTML(item) {
  var h = "<div id='mail:" + escapeHTML(item.hash) + "' class='mailRow' onclick=\"openMailMsg('" + escapeHTML(item.hash) + "');\">";
  h += "<span>" + formatMailDate(item.date) + " - " + escapeHTML(item.subject || '') + "</span>";
  h += "<span style='float:right;color:#cc6666;cursor:pointer;' onclick=\"event.stopPropagation();deleteMailMsg('" + escapeHTML(item.hash) + "');\">[x]</span>";
  h += "<div class='mailMeta'>" + mailFromLabel(item);
  if (item.error) h += " <span style='color:#cc6666;'>(" + escapeHTML(item.error) + ")</span>";
  h += "</div></div>";
  return h;
}

function renderMailList(f) {
  f = f || folder || 'all';
  folder = f;
  var spot = document.getElementById('mailListSpot');
  if (!spot) return;
  var rows = (window.mailCache || []).filter(function(item) {
    return mailFolderFilter(item, f);
  });
  var html = "";
  if (rows.length === 0) {
    html = "<div style='padding:.5em 0 .5em 1.5em;color:#999999;'>No mail in this folder.</div>";
  } else {
    rows.forEach(function(item) { html += mailRowHTML(item); });
  }
  spot.innerHTML = html;

  // Mark the active folder in the nav
  var links = document.querySelectorAll('#mailFolderSpot a');
  for (var i = 0; i < links.length; i++) {
    var active = links[i].getAttribute('href').indexOf("selectFolder('" + f + "')") !== -1;
    links[i].style.color = active ? '#8ec634' : '';
    links[i].style.fontWeight = active ? 'bold' : '';
  }
}

function selectFolder(f) {
  renderMailList(f);
}

// -------------------------------------------------------
// Read a message
// -------------------------------------------------------
function openMailMsg(hash) {
  var item = null;
  for (var i = 0; i < mailCache.length; i++) {
    if (mailCache[i].hash === hash) { item = mailCache[i]; break; }
  }
  if (!item) {
    // Fallback: fetch the one envelope from the mail tree
    showMailSearching();
    sendRequest({ req: 'getMyBorgMail', parms: { hash: hash } });
    return;
  }
  renderMailMsg(item);
}

function renderMailMsg(item) {
  curMailHash = item.hash;

  var act = document.getElementById('mailActionSpot');
  if (act) act.style.display = 'block';

  var spot = document.getElementById('mailViewSpot');
  if (!spot) return;

  var h = "<div style='padding:.5em 1em;'>";
  h += "<h2 style='color:white;word-wrap:break-word;'>" + escapeHTML(item.subject || '') + "</h2>";
  h += "<div class='mailMeta'>" + mailFromLabel(item) + " | " + formatMailDate(item.date) + "</div>";
  if (item.hosts && item.hosts.length) {
    h += "<div class='mailMeta'>Held On: " + item.hosts.join(', ') + "</div>";
  }
  if (item.error) {
    h += "<div style='color:#cc6666;'>Cannot Decrypt This Message: " + escapeHTML(item.error) + "</div>";
  } else {
    h += "<pre class='mailBody'>" + escapeHTML(item.body || '') + "</pre>";
  }
  h += "</div>";
  spot.innerHTML = h;
  hideMailSearching();
}

function handlerMailList(j) {
  // Response from getMyBorgMail (fallback path for a single hash)
  if (!j.mail || j.mail.length === 0) {
    alert('Mail Not Found');
    hideMailSearching();
    return;
  }
  var row = j.mail[0];
  var item = {
    hash    : row.hash,
    from    : row.from,
    to      : row.to,
    date    : row.date,
    hosts   : row.hosts || [],
    subject : row.msg ? row.msg.subject : '[Cannot decrypt]',
    body    : row.msg ? row.msg.body : '',
    error   : row.error || null
  };
  // Cache it so later clicks do not re-fetch
  mailCache = mailCache.concat([item]);
  renderMailMsg(item);
}

// -------------------------------------------------------
// Compose
// -------------------------------------------------------
function composeMail() {
  var spot = document.getElementById('composeSpot');
  if (spot) spot.style.display = 'block';

  var to = document.getElementById('mailTo');
  if (to) { to.value = ''; }
  var subj = document.getElementById('mailSubject');
  if (subj) subj.value = '';
  var body = document.getElementById('mailBody');
  if (body) body.value = '';
  var res = document.getElementById('userSearchResults');
  if (res) res.innerHTML = '';
  var sendSpot = document.getElementById('mailSendSpot');
  if (sendSpot) sendSpot.innerHTML = '';
}

function composeReply() {
  var item = null;
  for (var i = 0; i < mailCache.length; i++) {
    if (mailCache[i].hash === curMailHash) { item = mailCache[i]; break; }
  }

  var spot = document.getElementById('composeSpot');
  if (spot) spot.style.display = 'block';

  var to = document.getElementById('mailTo');
  if (to && item) to.value = item.from || '';

  var subj = document.getElementById('mailSubject');
  if (subj && item) {
    var s = item.subject || '';
    subj.value = (s.toLowerCase().indexOf('re:') === 0) ? s : 'Re: ' + s;
  }

  var body = document.getElementById('mailBody');
  if (body) body.value = '';

  var sendSpot = document.getElementById('mailSendSpot');
  if (sendSpot) sendSpot.innerHTML = '';
}

function sendMailMsg() {
  var toEl   = document.getElementById('mailTo');
  var subjEl = document.getElementById('mailSubject');
  var bodyEl = document.getElementById('mailBody');

  var to   = toEl ? toEl.value.trim() : '';
  var subj = subjEl ? subjEl.value.trim() : '';
  var body = bodyEl ? bodyEl.value : '';

  if (!to) { alert('Enter A Recipient MUID'); return; }
  if (!subj && !body) { alert('Mail Needs A Subject Or Body'); return; }

  var sendSpot = document.getElementById('mailSendSpot');
  if (sendSpot) {
    sendSpot.innerHTML = "<div class='mkyloader'></div>Sealing Mail For The PeerTree...";
  }

  sendRequest({ req: 'sendBorgMail', parms: { to: to, subject: subj, body: body, nCopys: 3 } });
}

function doShowSendMailResult(j) {
  var sendSpot = document.getElementById('mailSendSpot');
  if (!sendSpot) return;

  if (j.result) {
    sendSpot.innerHTML =
      "<span style='color:#8ec634;'>Mail Sealed And Stored On " + j.nStored +
      " PeerTree Cells. (hash " + j.hash + ")</span>";
    setTimeout(function() { refreshMailBox(); }, 1500);
  } else {
    sendSpot.innerHTML =
      "<span style='color:#cc6666;'>Send Failed: " + escapeHTML(j.error || 'unknown error') + "</span>";
  }
}

// -------------------------------------------------------
// Delete
// -------------------------------------------------------
function deleteMailMsg(hash) {
  if (!confirm('Delete This Mail From All PeerTree Cells?')) return;
  sendRequest({ req: 'deleteBorgMail', parms: { hash: hash } });
}

function handlerDeleteMail(j) {
  if (j.result === true) {
    mailCache = mailCache.filter(function(item) { return item.hash !== curMailHash; });
    refreshMailBox();
  } else {
    alert('Delete Failed');
  }
}

// -------------------------------------------------------
// Recipient search (findUsers via qryMailUsers)
// -------------------------------------------------------
function findBorgUser() {
  var qryEl = document.getElementById('mailTo');
  var qry   = qryEl ? qryEl.value.trim() : '';
  if (!qry) { alert('Type A Name Or MUID To Search'); return; }

  var res = document.getElementById('userSearchResults');
  if (res) res.innerHTML = "<div class='mkyloader'></div>Searching The Borg...";

  sendRequest({ req: 'qryMailUsers', parms: { qry: qry, maxRows: 10 } });
}

function handlerUserSearch(j) {
  var res = document.getElementById('userSearchResults');
  if (!res) return;
  res.innerHTML = j.html || "<div style='color:#999999;'>No users found.</div>";
}

function pickBorgUser(muid, nic) {
  var to = document.getElementById('mailTo');
  if (to) to.value = muid;

  var res = document.getElementById('userSearchResults');
  if (res) res.innerHTML = "<div style='color:#999999;'>Selected: " + escapeHTML(nic) + "</div>";
}

// -------------------------------------------------------
// Registration
// -------------------------------------------------------
function registerMyInBox() {
  sendRequest({ req: 'registerInBox', parms: {} });
}

function handlerRegInBox(j) {
  if (j.result === true) {
    alert('Inbox Registered On The PeerTree');
  } else {
    alert('Inbox Registration Failed');
  }
  refreshMailBox();
}

// -------------------------------------------------------
// Boot: render the initial folder on load
// -------------------------------------------------------
window.addEventListener('load', function() {
  setTimeout(function() {
    renderMailList(folder || 'all');
  }, 50);
});
