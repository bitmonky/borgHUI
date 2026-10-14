// BorgIOS Unified Server-Side HTML Builder - GJEX
// Produces one giant HTML string to send to the browser.
// Mirrors BorgHUIMailUI for the btrader order-book organ.

class BorgHUIGjexUI {
  constructor(net){
    this.net = net;
  }
  //
  // ---------------------------------------------------------
  // INIT CONTEXT (mirrors initMailContextFromGET)
  // ---------------------------------------------------------
  //
  async initGjexContextFromGET(queryString) {
  console.log(`initGjexContextFromGET():: queryString`,queryString);  
  const params = Object.fromEntries(
      new URLSearchParams(queryString.replace(/^\?/, ""))
    );
    console.log(`initGjexContextFromGET():: `,params);
    const ownMUID      = this.net.wallet.ownMUID;
    const pairBase     = params.base  || "SHELLS";
    const pairQuote    = params.quote || "DOGE";
    const sessISMOBILE = params.sessISMOBILE === "1" || params.sessISMOBILE === "true";

    console.log(`initGjexContextFromGET():: pairBase,pairQuote`,pairBase,pairQuote);


    // Balances are pulled live so the header and the two order-entry
    // panels show something real on first paint; the client module
    // refreshes them again on load and after every fill.
    let dogeBalance  = "0.000000000";
    let shellBalance = "0.000000000";
    try {
      const b = {base: dogeBalance, quote: shellBalance}; //await this.net.wallet.getGjexBalances(pairBase, pairQuote);
      if (b) {
        dogeBalance  = b.base  || dogeBalance;
        shellBalance = b.quote || shellBalance;
      }
    }
    catch (err) {
      console.log("initGjexContextFromGET():: balance lookup failed", err);
    }

    // Optional: a fiat hint for the "($x.xx)" lines next to prices.
    // Left as 0 when unknown; the client drops the hint when it is 0.
    const fiatPerQuote = Number(params.fiatPerQuote) || 0;

    return {
      ownMUID,
      pairBase,
      pairQuote,
      dogeBalance,
      shellBalance,
      fiatPerQuote,
      sessISMOBILE
    };
  }
  //
  // ---------------------------------------------------------
  // TRADING PAGE (mirrors getMailBox)
  // ---------------------------------------------------------
  //
  async getGjexPage(queryString) {
    const ctx = await this.initGjexContextFromGET(queryString);

    let html = "";
    html += `
      <style>
      .gjexPairHeaderRow {
        display: flex;
        align-items: baseline;
        gap: 1em;
        margin-bottom: .25em;
      }
      .gjexPairTitle {
        color: #8ec634;
        font-size: 1.6em;
        font-weight: bold;
      }
      .gjexPairSub {
        color: #888888;
        font-size: .9em;
      }

.gjexPairStats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: .5em 1.5em;
  margin-bottom: 1em;
  color: white;
}
.gjexStat label {
  display: block;
  color: #888888;
  font-size: .8em;
  white-space: nowrap;
}
.gjexStat span {
  display: block;
  color: white;
  white-space: nowrap;
}

.gjexOrderEntry {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1em;
  margin-bottom: 1.5em;
}
@media (max-width: 900px) {
  .gjexOrderEntry { grid-template-columns: 1fr; }
}

.gjexCard {
  background: #151515;
  border-radius: .5em;
  color: white;
  overflow: hidden;
}
.gjexBuyCard  { border-top: 3px solid #4caf50; }
.gjexSellCard { border-top: 3px solid #cc4444; }

.gjexCardHeader {
  padding: .75em 1em .25em 1em;
  font-size: 1.2em;
  font-weight: bold;
  color: #8ec634;
}
.gjexCardHeader span { color: white; font-weight: normal; }

.gjexCardBody { padding: .25em 1em 1em 1em; }

.gjexYourLine {
  color: #888888;
  font-size: .9em;
  margin-bottom: .75em;
}
.gjexCoinTag {
  color: #aaaaaa;
  font-weight: bold;
}
.gjexBalanceVal {
  color: #8ec634;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}

.gjexFieldLabel {
  display: block;
  color: #888888;
  font-size: .8em;
  text-transform: uppercase;
  margin-top: .75em;
}

.gjexInputWrap {
  position: relative;
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid #333;
  border-radius: .25em;
  padding-right: .5em;
}
.gjexInputWrap input[type="text"] {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: 0;
  color: white;
  padding: .6em .75em;
  font-size: 1em;
  outline: none;
}
.gjexInputWrap input[readonly] {
  color: #cccccc;
}
.gjexInputWrap .gjexFiatHint {
  color: #888888;
  font-size: .85em;
  white-space: nowrap;
  padding-right: .5em;
}
.gjexInputWrap .gjexCoinIcon {
  color: #8ec634;
  font-size: .75em;
  font-weight: bold;
  white-space: nowrap;
  padding-left: .5em;
  border-left: 1px solid #333;
}

.gjexSliderWrap {
  margin-top: 1em;
  margin-bottom: .25em;
}
.gjexSlider {
  width: 100%;
  accent-color: #74a02a;
  background: transparent;
}
.gjexSliderMarks {
  display: flex;
  justify-content: space-between;
  color: #777777;
  font-size: .75em;
  margin-top: .15em;
}
.gjexSliderMarks span { cursor: pointer; }
.gjexSliderMarks span:hover { color: #8ec634; }
.gjexSliderPct {
  text-align: right;
  color: #8ec634;
  font-size: .8em;
  margin-top: .15em;
}

.gjexSubmitBut {
  margin-top: 1em;
  width: 100%;
  padding: .7em 1em;
  background: #74a02a;
  color: white;
  border: 0;
  border-radius: .25em;
  font-weight: bold;
  text-transform: uppercase;
  cursor: pointer;
  font-size: 1em;
}
.gjexSubmitBut:hover { background: #8ec634; }
.gjexBuyCard  .gjexSubmitBut { background: #4caf50; }
.gjexBuyCard  .gjexSubmitBut:hover { background: #5ecf63; }
.gjexSellCard .gjexSubmitBut { background: #cc4444; }
.gjexSellCard .gjexSubmitBut:hover { background: #dd5555; }

      .gjexOrderCol {
        flex: 1 1 0;
        min-width: 0;
        background: #151515;
        border-radius: .5em;
        padding: .75em 1em;
        color: white;
      }
      .gjexOrderCol.gjexBuyCol  { border-left: 3px solid #4caf50; }
      .gjexOrderCol.gjexSellCol { border-left: 3px solid #cc4444; }
      .gjexOrderTitle {
        font-size: 1.2em;
        font-weight: bold;
        margin-bottom: .25em;
      }
      .gjexOrderBalance {
        color: #888888;
        font-size: .85em;
        margin-bottom: .75em;
      }
      .gjexOrderCol label {
        display: block;
        color: #888888;
        font-size: .8em;
        margin-top: .5em;
      }
      .gjexOrderCol input[type="text"] {
        width: calc(100% - 1em);
        padding: .35em .5em;
        background: rgba(0, 0, 0, 0.35);
        color: white;
        border: 1px solid #333;
        border-radius: .25em;
      }
      .gjexOrderCol input[type="button"] {
        margin-top: .75em;
        padding: .4em 1em;
        background: #74a02a;
        color: white;
        border: 0;
        border-radius: .25em;
        cursor: pointer;
      }
      .gjexFiatHint {
        color: #777777;
        font-size: .8em;
        min-height: 1em;
        margin-top: .25em;
      }

      .gjexBookWrap {
        display: flex;
        gap: 1.5em;
        margin-bottom: 1.5em;
      }
      .gjexBookCol {
        flex: 1 1 0;
        min-width: 0;
        background: #151515;
        border-radius: .5em;
        padding: .5em .75em;
        color: white;
      }
      .gjexBookTitle {
        color: #8ec634;
        font-weight: bold;
        margin-bottom: .35em;
      }
      .gjexBookHead,
      .gjexBookRow,
      .gjexTradeRow {
        display: flex;
        gap: .5em;
        font-size: .9em;
        padding: 1px 0;
      }
      .gjexBookHead {
        color: #888888;
        font-size: .8em;
        border-bottom: 1px solid #333;
        margin-bottom: .25em;
      }
      .gjexBookHead span,
      .gjexBookRow span,
      .gjexTradeRow span {
        flex: 1 1 0;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .gjexBookRow {
        position: relative;
      }
      .gjexBookRow .gjexDepthBar {
        position: absolute;
        top: 0;
        bottom: 0;
        right: 0;
        opacity: .12;
        pointer-events: none;
      }
      .gjexBookRow.gjexBid .gjexDepthBar { background: #4caf50; }
      .gjexBookRow.gjexAsk .gjexDepthBar { background: #cc4444; }
      .gjexBookRow.gjexBid span.gjexColPrice { color: #8ec634; }
      .gjexBookRow.gjexAsk span.gjexColPrice { color: #cc6666; }
      .gjexBookRow span,
      .gjexTradeRow span {
        position: relative;
        z-index: 1;
      }
      .gjexBookEmpty {
        color: #888888;
        padding: .5em 0;
      }
      .gjexBookTotal {
        color: #888888;
        font-size: .8em;
        text-align: right;
        margin-top: .25em;
        border-top: 1px solid #333;
        padding-top: .25em;
      }
      .gjexTradeRow.gjexBid span:first-child { color: #8ec634; }
      .gjexTradeRow.gjexAsk span:first-child { color: #cc6666; }

      .gjexResultSpot {
        min-height: 1.5em;
        color: white;
        padding: .25em 0;
      }
      </style>
    `;

    // ---------------------------------------------------------
    // HEADER
    // ---------------------------------------------------------
    html += `
      <!--Trading: ${esc(ctx.pairBase)} | ${esc(ctx.pairQuote)}
      -->
      <div align='right' style='margin-bottom:.5em;'>
        <input type='button' value=' Refresh ' onclick='refreshEverything();'/>
      </div>
       <h2>BorgIOS GJEX .: Exchange</h2>
   `;

    // ---------------------------------------------------------
    // PAIR HEADER (filled by borgHUIgjexJS.js on load)
    // ---------------------------------------------------------
    html += `<div id='gjexPairHeader' style='color:white;'></div>`;

    // ---------------------------------------------------------
    // ORDER ENTRY (Buy + Sell)
    // ---------------------------------------------------------
    html += `<div id='gjexOrderEntry' class='gjexOrderEntry'></div>`;
    html += `<div id='gjexOrderResult' class='gjexResultSpot'></div>`;

    // ---------------------------------------------------------
    // ORDER BOOK (buys + sells side by side on desktop, stacked
    // on mobile — the module fills both spots regardless)
    // ---------------------------------------------------------
    if (!ctx.sessISMOBILE) {
      html += `
        <div class='gjexBookWrap'>
          <div class='gjexBookCol' id='gjexBuyBook'>Buys</div>
          <div class='gjexBookCol' id='gjexSellBook'>Sells</div>
        </div>
      `;
    } else {
      html += `<div class='gjexBookCol' id='gjexSellBook' style='margin-bottom:1em;'>Sells</div>`;
      html += `<div class='gjexBookCol' id='gjexBuyBook'>Buys</div>`;
    }

    // ---------------------------------------------------------
    // MY OPEN ORDERS
    // ---------------------------------------------------------
    html += `<div class='gjexBookCol' id='gjexMyOrders' style='margin-bottom:1.5em;'>My Open Orders</div>`;

    // ---------------------------------------------------------
    // TRADE HISTORY
    // ---------------------------------------------------------
    html += `<div class='gjexBookCol' id='gjexTrades'>Trade History:</div>`;

    return html;
  }
};

// ---------------------------------------------------------
// HTML ESCAPE (mirrors esc() in borgHUIMailUI.js)
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

module.exports.BorgHUIGjexUI = BorgHUIGjexUI;