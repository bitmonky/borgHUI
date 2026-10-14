// -------------------------------------------------------
// BorgIOS GJEX Trade Sys - client side
// Injected by doRenderGjex() in borgHUIconduit.js
// Renders the DOGE/SHELLS (or any base/quote) trading page
// into the #serviceMenu div.
//
// Injected before serving: ownMUID, pairBase, pairQuote,
//   dogeBalance, shellBalance, queryString, fiatPerQuote
// -------------------------------------------------------

// -------------------------------------------------------
// Local state (mirrors the mail module's module-level vars)
// -------------------------------------------------------
var gjexBuys        = [];      // [{price, amt, sum}]
var gjexSells       = [];      // [{price, amt, sum}]
var gjexTrades      = [];      // [{type, price, amt, total, ts}]
var gjexLastPrice   = "0.000000000";
var gjexChange24    = "0%";
var gjexChange30    = "0%";
var gjexVol24Base   = "0";
var gjexVol24Quote  = "0";
var gjexVol30Base   = "0";
var gjexVol30Quote  = "0";
var gjexBuyDepth    = "0";
var gjexMyBuys      = [];      // open orders for me
var gjexMySells     = [];      // open orders for me
var gjexFillsHist   = [];      // recent trades

// -------------------------------------------------------
// Small utilities
// -------------------------------------------------------
function gjexNoEnter() {
  return !(window.event && window.event.keyCode == 13);
}

function gjexEscape(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Deterministic 9-decimal fixed point, matching the matching engine's
// 1e9 scaling in btraderOrganObj.js. All display strings come out of
// the engine already in this form; format only for cosmetics.
function gjexFmt(n, places) {
  places = (places === undefined) ? 9 : places;
  var v = Number(n);
  if (!isFinite(v)) return "0";
  return v.toFixed(places);
}

// Trim trailing zeros for a cleaner display, but never drop below
// the configured significant digits.
function gjexFmtShort(n, places) {
  places = (places === undefined) ? 9 : places;
  var s = gjexFmt(n, places);
  if (s.indexOf('.') !== -1) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s === '' ? '0' : s;
}

function gjexFmtTime(ts) {
  if (!ts) return '';
  var d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  var mm = d.getMinutes(); if (mm < 10) mm = '0' + mm;
  var hh = d.getHours();   if (hh < 10) hh = '0' + hh;
  var day = d.getDate();
  var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return hh + ':' + mm + ' ' + day + ' ' + mon;
}

function gjexFiat(price, qty) {
  if (!fiatPerQuote) return '';
  var v = Number(price) * Number(qty) * Number(fiatPerQuote);
  if (!isFinite(v) || v === 0) return '';
  return "$" + v.toFixed(2);
}

function gjexShow(spotId) {
  var el = document.getElementById(spotId);
  if (el) el.style.display = 'block';
}

function gjexHide(spotId) {
  var el = document.getElementById(spotId);
  if (el) el.style.display = 'none';
}

// -------------------------------------------------------
// Re-render / refresh helpers
// -------------------------------------------------------
function gjexUpdateResByUrl(url, res, callbck) {
  sendRequest({
    req: 'borgUpdateResByUrl',
    parms: { mode: MODE, url: url, res: res },
    callbck: callbck || null
  });
}

function refreshGjexPage() {
  gjexUpdateResByUrl('/whzon/bitMiner/sendBorgGjex.php?' + queryString, 'serviceMenu');
}

function refreshOrderBook() {
  sendRequest({ req: 'gjexQryBook', parms: { base: pairBase, quote: pairQuote } });
}

function refreshTrades() {
  sendRequest({ req: 'gjexQryTrades', parms: { base: pairBase, quote: pairQuote, max: 50 } });
}

function refreshMyOrders() {
  sendRequest({ req: 'gjexQryMyOrders', parms: { base: pairBase, quote: pairQuote } });
}

function refreshBalances() {
  sendRequest({ req: 'gjexQryBalances', parms: { base: pairBase, quote: pairQuote } });
}

function refreshEverything() {
  refreshOrderBook();
  refreshTrades();
  refreshMyOrders();
  refreshBalances();
}

// -------------------------------------------------------
// Pair header
// -------------------------------------------------------
function renderPairHeader() {
  var spot = document.getElementById('gjexPairHeader');
  if (!spot) return;

  var h = "<div class='gjexPairHeaderRow'>";
  h += "<span class='gjexPairTitle'>" + gjexEscape(pairBase) + " / " + gjexEscape(pairQuote) + "</span>";
  h += "<span class='gjexPairSub'>trading, exchange</span>";
  h += "</div>";

  h += "<div class='gjexPairStats'>";
  h += "<div class='gjexStat'><label>Last Price</label><span>" + gjexEscape(gjexLastPrice) + " " + gjexEscape(pairQuote) + "</span></div>";
  h += "<div class='gjexStat'><label>24h / 30d Change</label><span>" + gjexEscape(gjexChange24) + " / " + gjexEscape(gjexChange30) + "</span></div>";
  h += "<div class='gjexStat'><label>24h Volume</label><span>" + gjexEscape(gjexVol24Base) + " " + gjexEscape(pairBase) + " / " + gjexEscape(gjexVol24Quote) + " " + gjexEscape(pairQuote) + "</span></div>";
  h += "<div class='gjexStat'><label>30d Volume</label><span>" + gjexEscape(gjexVol30Base) + " " + gjexEscape(pairBase) + " / " + gjexEscape(gjexVol30Quote) + " " + gjexEscape(pairQuote) + "</span></div>";
  h += "<div class='gjexStat'><label>Buy Depth</label><span>" + gjexEscape(gjexBuyDepth) + " " + gjexEscape(pairQuote) + "</span></div>";
  h += "</div>";

  spot.innerHTML = h;
}

// -------------------------------------------------------
// Order entry (Buy + Sell)
// -------------------------------------------------------
// -------------------------------------------------------
// Order entry (Buy + Sell) — mirrors the MINTME two-card
// layout: header, "Your" balance line, Price w/ fiat hint,
// Amount, percentage slider, Total Price, submit button.
// -------------------------------------------------------
function renderOrderEntry() {
  var spot = document.getElementById('gjexOrderEntry');
  if (!spot) return;

  // ---- BUY CARD ----
  var h  = "<div class='gjexCard gjexBuyCard'>";
  h +=   "<div class='gjexCardHeader'>Buy <span>Order</span></div>";
  h +=   "<div class='gjexCardBody'>";

  h +=     "<div class='gjexYourLine'>";
  h +=       "Your <span class='gjexCoinTag'>" + gjexEscape(pairQuote) + ":</span>";
  h +=       " <span class='gjexBalanceVal' id='gjexBuyBalance'>" + gjexEscape(shellBalance) + "</span>";
  h +=     "</div>";

  h +=     "<label class='gjexFieldLabel' for='gjexBuyPrice'>Price:</label>";
  h +=     "<div class='gjexInputWrap'>";
  h +=       "<input type='text' id='gjexBuyPrice' autocomplete='off' placeholder='0' oninput='gjexOnBuyInput();'>";
  h +=       "<span class='gjexFiatHint' id='gjexBuyPriceFiat'></span>";
  h +=       "<span class='gjexCoinIcon'>" + gjexEscape(pairQuote) + "</span>";
  h +=     "</div>";

  h +=     "<label class='gjexFieldLabel' for='gjexBuyAmt'>Amount:</label>";
  h +=     "<div class='gjexInputWrap'>";
  h +=       "<input type='text' id='gjexBuyAmt' autocomplete='off' placeholder='0' oninput='gjexOnBuyInput();'>";
  h +=       "<span class='gjexCoinIcon'>" + gjexEscape(pairBase) + "</span>";
  h +=     "</div>";

  h +=     gjexSliderHTML('gjexBuySlider', 'gjexBuyPct');

  h +=     "<label class='gjexFieldLabel' for='gjexBuyTotal'>Total Price:</label>";
  h +=     "<div class='gjexInputWrap'>";
  h +=       "<input type='text' id='gjexBuyTotal' readonly placeholder='0'>";
  h +=       "<span class='gjexFiatHint' id='gjexBuyTotalFiat'></span>";
  h +=       "<span class='gjexCoinIcon'>" + gjexEscape(pairQuote) + "</span>";
  h +=     "</div>";

  h +=     "<input type='button' class='gjexSubmitBut' id='gjexBuyBut' value=' Create Buy Order ' onclick='gjexPlaceBuy();'>";
  h +=   "</div>";
  h += "</div>";

  // ---- SELL CARD ----
  h += "<div class='gjexCard gjexSellCard'>";
  h +=   "<div class='gjexCardHeader'>Sell <span>Order</span></div>";
  h +=   "<div class='gjexCardBody'>";

  h +=     "<div class='gjexYourLine'>";
  h +=       "Your <span class='gjexCoinTag'>" + gjexEscape(pairBase) + ":</span>";
  h +=       " <span class='gjexBalanceVal' id='gjexSellBalance'>" + gjexEscape(dogeBalance) + "</span>";
  h +=     "</div>";

  h +=     "<label class='gjexFieldLabel' for='gjexSellPrice'>Price:</label>";
  h +=     "<div class='gjexInputWrap'>";
  h +=       "<input type='text' id='gjexSellPrice' autocomplete='off' placeholder='0' oninput='gjexOnSellInput();'>";
  h +=       "<span class='gjexFiatHint' id='gjexSellPriceFiat'></span>";
  h +=       "<span class='gjexCoinIcon'>" + gjexEscape(pairQuote) + "</span>";
  h +=     "</div>";

  h +=     "<label class='gjexFieldLabel' for='gjexSellAmt'>Amount:</label>";
  h +=     "<div class='gjexInputWrap'>";
  h +=       "<input type='text' id='gjexSellAmt' autocomplete='off' placeholder='0' oninput='gjexOnSellInput();'>";
  h +=       "<span class='gjexCoinIcon'>" + gjexEscape(pairBase) + "</span>";
  h +=     "</div>";

  h +=     gjexSliderHTML('gjexSellSlider', 'gjexSellPct');

  h +=     "<label class='gjexFieldLabel' for='gjexSellTotal'>Total Price:</label>";
  h +=     "<div class='gjexInputWrap'>";
  h +=       "<input type='text' id='gjexSellTotal' readonly placeholder='0'>";
  h +=       "<span class='gjexFiatHint' id='gjexSellTotalFiat'></span>";
  h +=       "<span class='gjexCoinIcon'>" + gjexEscape(pairQuote) + "</span>";
  h +=     "</div>";

  h +=     "<input type='button' class='gjexSubmitBut' id='gjexSellBut' value=' Create Sell Order ' onclick='gjexPlaceSell();'>";
  h +=   "</div>";
  h += "</div>";

  spot.innerHTML = h;
}

// -------------------------------------------------------
// Percentage slider (0/25/50/75/100). Kept framework-free:
// a range input plus 5 tick labels. Clicking a tick drives
// the range input and re-computes the amount.
// -------------------------------------------------------
function gjexSliderHTML(sliderId, pctId) {
  var h = "<div class='gjexSliderWrap'>";
  h +=   "<input type='range' class='gjexSlider' id='" + sliderId + "'";
  h +=     " min='0' max='100' step='1' value='0'";
  h +=     " oninput='gjexOnSlider(\"" + sliderId + "\",\"" + pctId + "\");'>";
  h +=   "<div class='gjexSliderMarks'>";
  h +=     "<span onclick='gjexSetSlider(\"" + sliderId + "\",0);'>0%</span>";
  h +=     "<span onclick='gjexSetSlider(\"" + sliderId + "\",25);'>25%</span>";
  h +=     "<span onclick='gjexSetSlider(\"" + sliderId + "\",50);'>50%</span>";
  h +=     "<span onclick='gjexSetSlider(\"" + sliderId + "\",75);'>75%</span>";
  h +=     "<span onclick='gjexSetSlider(\"" + sliderId + "\",100);'>100%</span>";
  h +=   "</div>";
  h +=   "<div class='gjexSliderPct' id='" + pctId + "'>0%</div>";
  h += "</div>";
  return h;
}

function gjexSetSlider(sliderId, pct) {
  var s = document.getElementById(sliderId);
  if (!s) return;
  s.value = pct;
  if (sliderId === 'gjexBuySlider') gjexOnSlider(sliderId, 'gjexBuyPct');
  else                              gjexOnSlider(sliderId, 'gjexSellPct');
}

function gjexOnSlider(sliderId, pctId) {
  var s = document.getElementById(sliderId);
  if (!s) return;
  var pct = Number(s.value) || 0;

  var pctSpot = document.getElementById(pctId);
  if (pctSpot) pctSpot.innerHTML = pct + '%';

  if (sliderId === 'gjexBuySlider') {
    // Buy: slider controls how much of the quote balance to spend.
    var bal = Number(shellBalance) || 0;
    var price = Number(document.getElementById('gjexBuyPrice').value) || 0;
    if (price > 0) {
      var spend = bal * (pct / 100);
      var amt   = spend / price;
      document.getElementById('gjexBuyAmt').value = gjexFmtShort(amt);
      gjexOnBuyInput();
    }
  } else {
    // Sell: slider controls how much of the base balance to sell.
    var balB = Number(dogeBalance) || 0;
    var amtB = balB * (pct / 100);
    document.getElementById('gjexSellAmt').value = gjexFmtShort(amtB);
    gjexOnSellInput();
  }
}
function gjexOnBuyInput() {
  var p = parseFloat(document.getElementById('gjexBuyPrice').value) || 0;
  var a = parseFloat(document.getElementById('gjexBuyAmt').value)   || 0;
  var t = p * a;

  document.getElementById('gjexBuyTotal').value  = gjexFmtShort(t);
  document.getElementById('gjexBuyPriceFiat').innerHTML = gjexFiat(p, 1);
  document.getElementById('gjexBuyTotalFiat').innerHTML = gjexFiat(p, a);
}

function gjexOnSellInput() {
  var p = parseFloat(document.getElementById('gjexSellPrice').value) || 0;
  var a = parseFloat(document.getElementById('gjexSellAmt').value)   || 0;
  var t = p * a;

  document.getElementById('gjexSellTotal').value  = gjexFmtShort(t);
  document.getElementById('gjexSellPriceFiat').innerHTML = gjexFiat(p, 1);
  document.getElementById('gjexSellTotalFiat').innerHTML = gjexFiat(p, a);
}
function gjexPlaceBuy() {
  var price = (document.getElementById('gjexBuyPrice').value || '').trim();
  var amt   = (document.getElementById('gjexBuyAmt').value   || '').trim();
  if (!price || !amt) { alert('Price And Amount Are Required'); return; }

  var total = Number(price) * Number(amt);
  if (total > Number(shellBalance)) {
    alert('Not Enough ' + pairQuote + ' To Cover This Buy Order');
    return;
  }

  var spot = document.getElementById('gjexOrderResult');
  if (spot) spot.innerHTML = "<div class='mkyloader'></div>Placing Buy Order On The PeerTree...";

  sendRequest({
    req: 'gjexPlaceBuy',
    parms: {
      base  : pairBase,
      quote : pairQuote,
      maxPrice : price,
      quoteAmt : gjexFmt(total),
      token : pairBase
    }
  });
}

function gjexPlaceSell() {
  var price = (document.getElementById('gjexSellPrice').value || '').trim();
  var amt   = (document.getElementById('gjexSellAmt').value   || '').trim();
  if (!price || !amt) { alert('Price And Amount Are Required'); return; }

  if (Number(amt) > Number(dogeBalance)) {
    alert('Not Enough ' + pairBase + ' To Cover This Sell Order');
    return;
  }

  var spot = document.getElementById('gjexOrderResult');
  if (spot) spot.innerHTML = "<div class='mkyloader'></div>Placing Sell Order On The PeerTree...";

  sendRequest({
    req: 'gjexPlaceSell',
    parms: {
      base     : pairBase,
      quote    : pairQuote,
      minPrice : price,
      baseQty  : gjexFmt(amt),
      token    : pairBase
    }
  });
}

// -------------------------------------------------------
// Order book (buys + sells) with running sums
// -------------------------------------------------------
function gjexBuildSum(rows) {
  var sum = 0;
  rows.forEach(function(r) {
    sum += Number(r.price) * Number(r.amt);
    r.sum = sum;
  });
  return rows;
}

function gjexBookRowHTML(side, r, maxSum) {
  var depthPct = maxSum > 0 ? Math.min(100, (r.sum / maxSum) * 100) : 0;
  var color    = side === 'buy' ? 'gjexBid' : 'gjexAsk';
  var h = "<div class='gjexBookRow " + color + "'>";
  h += "<div class='gjexDepthBar' style='width:" + depthPct.toFixed(2) + "%;'></div>";
  h += "<span class='gjexColPrice'>" + gjexEscape(r.price) + "</span>";
  h += "<span class='gjexColAmt'>"   + gjexEscape(r.amt)   + "</span>";
  h += "<span class='gjexColSum'>"   + gjexFmtShort(r.sum) + "</span>";
  h += "</div>";
  return h;
}

function renderOrderBook() {
  var buys  = document.getElementById('gjexBuyBook');
  var sells = document.getElementById('gjexSellBook');
  if (!buys || !sells) return;

  // Sells come in cheapest-first from the matching engine; the display
  // loop below walks them in reverse so the cheapest sits closest to
  // the spread, with bids meeting it from underneath.
  var sRows = gjexBuildSum(gjexSells.slice());
  var bRows = gjexBuildSum(gjexBuys.slice());

  var maxS = sRows.reduce(function(m, r) { return Math.max(m, r.sum); }, 0);
  var maxB = bRows.reduce(function(m, r) { return Math.max(m, r.sum); }, 0);

  var sh = "<div class='gjexBookTitle'>Sell Orders</div>";
  sh += "<div class='gjexBookHead'><span>Price</span><span>Amount</span><span>Sum</span></div>";
  if (sRows.length === 0) {
    sh += "<div class='gjexBookEmpty'>No sell orders.</div>";
  } else {
    for (var i = sRows.length - 1; i >= 0; i--) sh += gjexBookRowHTML('sell', sRows[i], maxS);
  }
  sh += "<div class='gjexBookTotal'>Total: " + gjexFmtShort(maxS) + " " + gjexEscape(pairBase) + "</div>";
  sells.innerHTML = sh;

  var bh = "<div class='gjexBookTitle'>Buy Orders</div>";
  bh += "<div class='gjexBookHead'><span>Price</span><span>Amount</span><span>Sum</span></div>";
  if (bRows.length === 0) {
    bh += "<div class='gjexBookEmpty'>No buy orders.</div>";
  } else {
    for (var j = 0; j < bRows.length; j++) bh += gjexBookRowHTML('buy', bRows[j], maxB);
  }
  bh += "<div class='gjexBookTotal'>Total: " + gjexFmtShort(maxB) + " " + gjexEscape(pairQuote) + "</div>";
  buys.innerHTML = bh;
}
// -------------------------------------------------------
// Trade history
// -------------------------------------------------------
function renderTrades() {
  var spot = document.getElementById('gjexTrades');
  if (!spot) return;

  var h = "<div class='gjexBookTitle'>Trade History</div>";
  h += "<div class='gjexBookHead'><span>Type</span><span>Price</span><span>Amount</span><span>Total</span><span>Time</span></div>";
  if (!gjexTrades || gjexTrades.length === 0) {
    h += "<div class='gjexBookEmpty'>No trades yet.</div>";
  } else {
    gjexTrades.forEach(function(t) {
      var cls = (t.type === 'Buy') ? 'gjexBid' : 'gjexAsk';
      h += "<div class='gjexTradeRow " + cls + "'>";
      h += "<span>" + gjexEscape(t.type) + "</span>";
      h += "<span>" + gjexEscape(t.price) + "</span>";
      h += "<span>" + gjexEscape(t.amt) + "</span>";
      h += "<span>" + gjexEscape(t.total) + "</span>";
      h += "<span>" + gjexFmtTime(t.ts) + "</span>";
      h += "</div>";
    });
  }
  spot.innerHTML = h;
}

// -------------------------------------------------------
// My open orders
// -------------------------------------------------------
function renderMyOrders() {
  var spot = document.getElementById('gjexMyOrders');
  if (!spot) return;

  var h = "<div class='gjexBookTitle'>My Open Orders</div>";

  h += "<div class='gjexBookHead'><span>Side</span><span>Price</span><span>Amount</span><span>Filled</span><span></span></div>";
  if ((!gjexMyBuys || gjexMyBuys.length === 0) && (!gjexMySells || gjexMySells.length === 0)) {
    h += "<div class='gjexBookEmpty'>No open orders.</div>";
  } else {
    (gjexMyBuys || []).forEach(function(o) {
      h += "<div class='gjexTradeRow gjexBid'>";
      h += "<span>Buy</span>";
      h += "<span>" + gjexEscape(o.price) + "</span>";
      h += "<span>" + gjexEscape(o.amt) + "</span>";
      h += "<span>" + gjexEscape(o.filled || '0') + "</span>";
      h += "<span><a href='javascript:gjexCancelOrder(\"" + gjexEscape(o.id) + "\");'>cancel</a></span>";
      h += "</div>";
    });
    (gjexMySells || []).forEach(function(o) {
      h += "<div class='gjexTradeRow gjexAsk'>";
      h += "<span>Sell</span>";
      h += "<span>" + gjexEscape(o.price) + "</span>";
      h += "<span>" + gjexEscape(o.amt) + "</span>";
      h += "<span>" + gjexEscape(o.filled || '0') + "</span>";
      h += "<span><a href='javascript:gjexCancelOrder(\"" + gjexEscape(o.id) + "\");'>cancel</a></span>";
      h += "</div>";
    });
  }
  spot.innerHTML = h;
}

function gjexCancelOrder(orderId) {
  if (!confirm('Cancel This Order?')) return;
  sendRequest({ req: 'gjexCancelOrder', parms: { orderId: orderId } });
}

// -------------------------------------------------------
// Result handlers, one per action (called from handleResponse
// in borgHUIboot.js — see wiring notes at the bottom of the file)
// -------------------------------------------------------
function gjexHandlerPlaceBuy(j) {
  var spot = document.getElementById('gjexOrderResult');
  if (!spot) return;
  if (j.result) {
    spot.innerHTML = "<span style='color:#8ec634;'>Buy Order Placed (id " + gjexEscape(j.orderId || '?') + ")</span>";
    refreshEverything();
  } else {
    spot.innerHTML = "<span style='color:#cc6666;'>Buy Failed: " + gjexEscape(j.error || 'unknown') + "</span>";
  }
}

function gjexHandlerPlaceSell(j) {
  var spot = document.getElementById('gjexOrderResult');
  if (!spot) return;
  if (j.result) {
    spot.innerHTML = "<span style='color:#8ec634;'>Sell Order Placed (id " + gjexEscape(j.orderId || '?') + ")</span>";
    refreshEverything();
  } else {
    spot.innerHTML = "<span style='color:#cc6666;'>Sell Failed: " + gjexEscape(j.error || 'unknown') + "</span>";
  }
}

function gjexHandlerCancel(j) {
  if (j.result) refreshEverything();
  else alert('Cancel Failed: ' + (j.error || 'unknown'));
}

function gjexHandlerBook(j) {
  gjexBuys  = (j.buys  || []).map(function(r) { return { price: r.price, amt: r.amt, sum: 0 }; });
  gjexSells = (j.sells || []).map(function(r) { return { price: r.price, amt: r.amt, sum: 0 }; });
  if (j.lastPrice) gjexLastPrice = j.lastPrice;
  if (j.buyDepth)  gjexBuyDepth  = j.buyDepth;
  renderOrderBook();
  renderPairHeader();
}

function gjexHandlerTrades(j) {
  gjexTrades = j.trades || [];
  renderTrades();
}

function gjexHandlerMyOrders(j) {
  gjexMyBuys  = j.buys  || [];
  gjexMySells = j.sells || [];
  renderMyOrders();
}

function gjexHandlerBalances(j) {
  if (typeof j.dogeBalance  !== 'undefined') dogeBalance  = j.dogeBalance;
  if (typeof j.shellBalance !== 'undefined') shellBalance = j.shellBalance;

  var bq = document.getElementById('gjexBuyBalance');
  if (bq) bq.innerHTML = gjexEscape(shellBalance);
  var sb = document.getElementById('gjexSellBalance');
  if (sb) sb.innerHTML = gjexEscape(dogeBalance);

  gjexOnBuyInput();
  gjexOnSellInput();
}

// -------------------------------------------------------
// SSE hook: the conduit pushes 'borg-event' with a req tag.
// borgHUIboot.js already parses those; the trade events
// land here through handleBorgMsg().
// -------------------------------------------------------
function gjexHandleBorgEvent(msg) {
  if (!msg || !msg.req) return;
  if (msg.req === 'gjexTrade')  { refreshTrades(); return; }
  if (msg.req === 'gjexBook')   { refreshOrderBook(); return; }
  if (msg.req === 'gjexFill')   { refreshEverything(); return; }
  if (msg.req === 'gjexOrder')  { refreshMyOrders(); return; }
}

// -------------------------------------------------------
// Boot
// -------------------------------------------------------
function gjexBoot() {
  renderPairHeader();
  renderOrderEntry();
  renderOrderBook();
  renderTrades();
  renderMyOrders();
  refreshEverything();
}

window.addEventListener('load', function() {
  setTimeout(gjexBoot, 50);
});

// -------------------------------------------------------
// WIRING NOTES (for borgHUIboot.js handleResponse)
// -------------------------------------------------------
// Add the following cases to handleResponse(j):
//
//   if (j.action === 'gjexPlaceBuy')        gjexHandlerPlaceBuy(j);
//   if (j.action === 'gjexPlaceSell')       gjexHandlerPlaceSell(j);
//   if (j.action === 'gjexCancelOrder')     gjexHandlerCancel(j);
//   if (j.action === 'gjexQryBook')         gjexHandlerBook(j);
//   if (j.action === 'gjexQryTrades')       gjexHandlerTrades(j);
//   if (j.action === 'gjexQryMyOrders')     gjexHandlerMyOrders(j);
//   if (j.action === 'gjexQryBalances')     gjexHandlerBalances(j);
//
// And in handleBorgMsg(msg):
//
//   if (msg.req && msg.req.indexOf('gjex') === 0) {
//     gjexHandleBorgEvent(msg);
//     return;
//   }
//
// The conduit side needs a doRenderGjex(m, res) that emits the
// div skeleton (#gjexPairHeader, #gjexOrderEntry, #gjexBuyBook,
// #gjexSellBook, #gjexTrades, #gjexMyOrders, #gjexOrderResult)
// and injects this file the same way doRenderMailSys does.