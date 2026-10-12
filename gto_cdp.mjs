/**
 * Preflop GTO Advisor — CDP版
 *
 * 使い方:
 *   1. Chromeを以下コマンドで起動（既存Chromeを終了してから）
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp
 *
 *   2. 対象サイトを開く
 *
 *   3. このスクリプトを実行
 *      node gto_cdp.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// RANGE DATA
// ============================================================
const RANGES = require('./gto_ranges_bundle.json');

// ============================================================
// CONSTANTS
// ============================================================
const RANK_ORDER = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const ACTION_LABEL = { fold: 'フォールド', call: 'コール', raise: 'レイズ/3bet', raise_large: 'レイズ(3bb)' };
const ACTION_COLOR = { fold: '#64748b', call: '#22c55e', raise: '#ef4444', raise_large: '#ef4444' };
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const TARGET_URL = 'tenfour';
const POLL_MS = 1500;

// ============================================================
// HAND UTILITIES
// ============================================================
function normSuit(s) {
  if (s.includes('♠')) return 's';
  if (s.includes('♥')) return 'h';
  if (s.includes('♦')) return 'd';
  if (s.includes('♣')) return 'c';
  return null;
}

function normRank(r) { return r === '10' ? 'T' : r; }

function toHandKey(r1, s1, r2, s2) {
  const i1 = RANK_ORDER.indexOf(r1), i2 = RANK_ORDER.indexOf(r2);
  if (i1 === i2) return r1 + r2;
  const [hi, lo, hiS, loS] = i1 > i2 ? [r1,r2,s1,s2] : [r2,r1,s2,s1];
  return hi + lo + (hiS === loS ? 's' : 'o');
}

function posKey(pos, ctx) {
  const p = pos.toUpperCase();
  if ((p === 'HJ' || p === 'MP') && (ctx === '3bet' || ctx === '4bet')) return 'mp';
  return p.toLowerCase();
}

function getRangeKey(myPos, raises) {
  const me = myPos.toUpperCase();
  const PF_ORDER = ['UTG','HJ','MP','CO','BTN','SB','BB'];
  const myIdx = PF_ORDER.indexOf(me);

  if (raises.length === 0) {
    if (me === 'BB') return null;
    return '100bb_rfi_' + posKey(me, 'rfi');
  }
  if (raises.length === 1) {
    const raiserIdx = PF_ORDER.indexOf(raises[0].pos);
    if (raiserIdx > myIdx) {
      // 自分が先にオープン済み → 後ろから3bet
      const k = 'vs3bet_' + posKey(me, '3bet') + '_vs_' + posKey(raises[0].pos, '3bet');
      return (k in RANGES) ? k : null;
    } else {
      // 自分より前がオープン → vs open
      if (raises[0].pos === me) return null;
      const k = 'vs_' + posKey(raises[0].pos, 'open') + '_' + posKey(me, 'open');
      return (k in RANGES) ? k : null;
    }
  }
  if (raises.length === 2) {
    const [open, threebet] = raises;
    // 両方他プレイヤーのバッジが見えている場合: 自分が3bet済みで4betを受けた
    if (open.pos !== me && threebet.pos !== me) {
      const k = 'vs4bet_' + posKey(me, '4bet') + '_vs_' + posKey(open.pos, '4bet');
      return (k in RANGES) ? k : null;
    }
    if (open.pos === me) {
      const k = 'vs3bet_' + posKey(me, '3bet') + '_vs_' + posKey(threebet.pos, '3bet');
      return (k in RANGES) ? k : null;
    }
    return null;
  }
  if (raises.length >= 3) {
    const [, threebet, fourbet] = raises;
    if (threebet.pos === me) {
      const k = 'vs4bet_' + posKey(me, '4bet') + '_vs_' + posKey(fourbet.pos, '4bet');
      return (k in RANGES) ? k : null;
    }
    return null;
  }
  return null;
}

function lookupGTO(hand, rangeKey) {
  const range = RANGES[rangeKey];
  if (!range) return null;
  const hd = range.h[hand];
  if (!hd) return null;
  let best = null, maxF = 0;
  for (const [act, f] of Object.entries(hd)) {
    if (f > maxF) { maxF = f; best = act; }
  }
  return { best, freqs: hd, scenario: range.sc };
}

// ============================================================
// CDP CLIENT (Node.js 24 built-in WebSocket)
// ============================================================
async function getTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  return res.json();
}

function createSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); }
    }));

    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });

    ws.addEventListener('error', reject);
  });
}

// ============================================================
// DOM読み取り（CDP経由でページ内JSを実行）
// ============================================================
const READ_STATE_JS = `
(function() {
  const anchor = document.querySelector('.seat-anchor--bottom-center');
  if (!anchor) return { error: 'no anchor' };

  const posEl = anchor.querySelector('.bg-emerald-500');
  const pos = posEl ? posEl.textContent.trim() : null;

  const stack = anchor.querySelector('.seat-card-stack');
  const cards = [];
  if (stack) {
    stack.querySelectorAll('.animate-card-deal').forEach(wrap => {
      const inner = wrap.querySelector('span[style*="background-color"]');
      if (!inner) return;
      const spans = inner.querySelectorAll('span');
      let suitTxt = '', rankTxt = '';
      spans.forEach(sp => {
        const t = sp.textContent.trim();
        if (/[♠♥♦♣]/.test(t)) suitTxt = t;
        else if (/^([2-9TJQKA]|10)$/.test(t)) rankTxt = t;
      });
      if (suitTxt && rankTxt) cards.push({ suit: suitTxt, rank: rankTxt });
    });
  }

  const badges = [];
  document.querySelectorAll('.seat-anchor:not(.seat-anchor--bottom-center)').forEach(seat => {
    const badge = seat.querySelector('.seat-floating-layer .animate-action-pop');
    const p2 = seat.querySelector('.bg-emerald-500');
    if (badge && p2) {
      badges.push({ pos: p2.textContent.trim().toUpperCase(), text: badge.textContent.trim() });
    }
  });

  // コミュニティカードが3枚以上出ていたらフロップ以降（誤検知防止で>=3）
  const boardCards = document.querySelectorAll('.table-center span[style*="background-color"]');
  const isPostflop = boardCards.length >= 3;

  return { pos, cards, badges, isPostflop };
})()
`;

// ============================================================
// ステータスパネル（待機中など）
// ============================================================
function injectStatusPanel(msg) {
  return `(function() {
  let el = document.getElementById('gto-cdp-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gto-cdp-panel';
    el.style.cssText = [
      'position:fixed','bottom:12px','right:12px',
      'z-index:2147483647',
      'background:rgba(3,7,18,0.93)',
      'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:16px','padding:20px 24px',
      'color:#e2e8f0','font-family:system-ui,sans-serif',
      'font-size:18px','min-width:450px','max-width:570px',
      'backdrop-filter:blur(6px)',
      'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
      'user-select:none','pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  }
  el.innerHTML = '<div style="font-size:20px;color:#64748b">' + ${JSON.stringify(msg)} + '</div>';
})()`;
}

// ============================================================
// レンジチャート（13×13グリッド）
// ============================================================
function buildRangeChart(rangeKey, currentHand) {
  if (!rangeKey) return '';
  const range = RANGES[rangeKey];
  if (!range) return '';
  const CHART_RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
  const lbl = r => `<div style="width:26px;height:16px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#64748b;flex-shrink:0">${r}</div>`;
  const topRow = `<div style="display:flex;gap:1px;margin-left:21px">${CHART_RANKS.map(lbl).join('')}</div>`;
  const rows = CHART_RANKS.map((r1, i) => {
    const cells = CHART_RANKS.map((r2, j) => {
      const hand = i === j ? r1 + r1 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
      const hd = range.h?.[hand];
      const isCur = hand === currentHand;
      let bg;
      if (!hd || (hd.fold || 0) >= 0.999) {
        bg = '#1e293b';
      } else {
        const rf = Math.round(((hd.raise || 0) + (hd.raise_large || 0)) * 100);
        const cf = Math.round((hd.call || 0) * 100);
        bg = `linear-gradient(to bottom,#ef4444 ${rf}%,#22c55e ${rf}% ${rf+cf}%,#1e293b ${rf+cf}% 100%)`;
      }
      const ex = isCur ? 'outline:2px solid #fff;outline-offset:-2px;position:relative;z-index:1;' : '';
      return `<div style="width:26px;height:26px;flex-shrink:0;background:${bg};${ex}"></div>`;
    }).join('');
    return `<div style="display:flex;gap:1px;align-items:center">${lbl(r1)}${cells}</div>`;
  }).join('');
  return `<div style="display:flex;flex-direction:column;gap:1px;margin-bottom:14px">${topRow}${rows}</div>`;
}

// ============================================================
// オーバーレイ注入（CDP経由）
// ============================================================
function buildInjectJS(hand, myPos, gto, rangeKey, vsLabel, isBBOption, alreadyActed = false) {
  const chartHtml = buildRangeChart(rangeKey, hand);
  const subline = `<div style="font-size:16px;color:#64748b;margin-bottom:6px">${myPos}${vsLabel ? ' · ' + vsLabel : ''}</div>`;
  const defaultAction = isBBOption
    ? `<div style="font-size:36px;font-weight:800;color:#94a3b8">▶ 待機中</div>`
    : `<div style="font-size:36px;font-weight:800;color:#64748b">▶ フォールド</div>`;
  const content = gto
    ? chartHtml + buildContent(hand, myPos, gto, vsLabel)
    : `${chartHtml}${subline}
       <div style="font-size:30px;font-weight:800;margin-bottom:8px">${hand || '??'}</div>
       ${defaultAction}`;

  // 両方Q以上は手動（QQ, KK, AA, AK, AQ, KQ系）
  const HIGH = new Set(['Q','K','A']);
  const bothHigh = hand.length >= 2 && HIGH.has(hand[0]) && HIGH.has(hand[1]);
  // fold 90%以上の時だけ自動フォールド（混合戦略・両方Q以上は手動）
  const shouldFold = !isBBOption && !bothHigh && (!gto || (gto.best === 'fold' && (gto.freqs.fold ?? 0) >= 0.9));
  // RFIで raise 90%以上 → 1秒後に 3→Enter（一手に一度だけ）
  const isRFI = !!rangeKey?.startsWith('100bb_rfi_');
  const raiseFreq = (gto?.freqs.raise ?? 0) + (gto?.freqs.raise_large ?? 0);
  const shouldOpen = !alreadyActed && isRFI && !!gto && /^raise/.test(gto.best) && raiseFreq >= 0.9;
  const shouldFoldOnce = !alreadyActed && shouldFold;

  return `
(function() {
  let el = document.getElementById('gto-cdp-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gto-cdp-panel';
    el.style.cssText = [
      'position:fixed','bottom:12px','right:12px',
      'z-index:2147483647',
      'background:rgba(3,7,18,0.93)',
      'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:16px','padding:20px 24px',
      'color:#e2e8f0','font-family:system-ui,sans-serif',
      'font-size:18px','min-width:450px','max-width:570px',
      'backdrop-filter:blur(6px)',
      'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
      'user-select:none','pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  }
  el.innerHTML = ${JSON.stringify(content)};

  const fireKey = (key, code) => {
    ['keydown','keypress','keyup'].forEach(type => {
      document.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
    });
  };

  if (${shouldFoldOnce}) {
    fireKey('f', 'KeyF');
  }

  // autoKey をパネルに記録し、同一 hand+rangeKey では絶対に1回だけ発火
  const autoKey = ${JSON.stringify(hand + '|' + (rangeKey || ''))};

  // シナリオが変わった時だけ waitTurn をキャンセル（同一シナリオ中は生かし続ける）
  if (el._waitTurnId && el.dataset.waitTurnKey !== autoKey) {
    clearInterval(el._waitTurnId); el._waitTurnId = null;
  }

  if (${shouldOpen} && el.dataset.autoFired !== autoKey && !el._waitTurnId) {
    el.dataset.autoFired = autoKey;
    el.dataset.waitTurnKey = autoKey;
    // 自分のターン（Fold/Call/Raise ボタン出現）を待ってから 3 を押す
    const t0 = Date.now();
    el._waitTurnId = setInterval(() => {
      if (Date.now() - t0 > 30000) { clearInterval(el._waitTurnId); el._waitTurnId = null; return; }
      // 他プレイヤーのレイズバッジが出ていたら RFI シナリオでなくなった → 中止
      const hasRaise = Array.from(document.querySelectorAll('.seat-anchor:not(.seat-anchor--bottom-center)'))
        .some(seat => {
          const badge = seat.querySelector('.seat-floating-layer .animate-action-pop');
          return badge && /raise|all.?in/i.test(badge.textContent);
        });
      if (hasRaise) { clearInterval(el._waitTurnId); el._waitTurnId = null; return; }
      const actionBtn = Array.from(document.querySelectorAll('button'))
        .find(btn => !btn.closest('.seat-anchor') && /^(Fold|Call|Raise|Bet|Check)$/.test(btn.textContent.trim()));
      if (!actionBtn) return;
      clearInterval(el._waitTurnId); el._waitTurnId = null;
      fireKey('3', 'Digit3');
      // 2.5bb/3bb 表示を検知してから 1 秒待って Enter
      const t1 = Date.now();
      const waitFor25 = setInterval(() => {
        if (Date.now() - t1 > 6000) { clearInterval(waitFor25); return; }
        const has25 = Array.from(document.querySelectorAll('*'))
          .some(el => el.childElementCount === 0 && /^(2\.5|3)(bb)?$/i.test(el.textContent.trim()));
        if (has25) {
          clearInterval(waitFor25);
          setTimeout(() => fireKey('Enter', 'Enter'), 1000);
        }
      }, 100);
    }, 100);
  }
})()`;
}

function buildContent(hand, myPos, gto, vsLabel) {
  const col = ACTION_COLOR[gto.best] || '#fff';
  const label = ACTION_LABEL[gto.best] || gto.best;

  const bars = Object.entries(gto.freqs)
    .sort((a, b) => b[1] - a[1])
    .map(([act, freq]) => {
      const pct = Math.round(freq * 100);
      const c = ACTION_COLOR[act] || '#94a3b8';
      const bold = act === gto.best ? 'font-weight:700;' : 'opacity:0.7;';
      return `<div style="display:flex;align-items:center;gap:10px;font-size:18px;${bold}">
  <span style="color:${c};min-width:100px">${ACTION_LABEL[act] || act}</span>
  <div style="flex:1;height:6px;background:rgba(255,255,255,0.1);border-radius:3px">
    <div style="width:${pct}%;height:100%;background:${c};border-radius:3px"></div>
  </div>
  <span style="color:#94a3b8;font-size:17px;min-width:40px;text-align:right">${pct}%</span>
</div>`;
    }).join('');

  return `<div style="font-size:16px;color:#64748b;margin-bottom:6px">${myPos} · ${vsLabel || gto.scenario}</div>
<div style="font-size:30px;font-weight:800;margin-bottom:8px">${hand}</div>
<div style="font-size:36px;font-weight:800;color:${col};margin-bottom:14px">▶ ${label}</div>
<div style="display:flex;flex-direction:column;gap:10px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px">${bars}</div>`;
}

// ============================================================
// MAIN
// ============================================================
let lastHand = null;
let lastAutoKey = null; // 自動アクション発火済みキー（hand+rangeKey）

async function poll(session) {
  try {
    const result = await session.send('Runtime.evaluate', {
      expression: READ_STATE_JS,
      returnByValue: true,
      awaitPromise: false,
    });

    const state = result?.result?.value;
    if (!state || state.error) {
      process.stdout.write(`\r⏳ テーブル待機中... (${state?.error || 'no state'})   `);
      await session.send('Runtime.evaluate', { expression: injectStatusPanel('⏳ テーブル待機中'), returnByValue: false });
      return;
    }

    // フロップ以降は処理停止（パネルはそのまま）
    if (state.isPostflop) {
      process.stdout.write(`\r🂠 フロップ以降 - 停止中   `);
      return;
    }

    const { pos, cards, badges } = state;
    if (!pos || cards.length < 2) {
      process.stdout.write(`\r⏳ カード待機中... pos=${pos} cards=${cards?.length}   `);
      await session.send('Runtime.evaluate', { expression: injectStatusPanel('⏳ カード待機中'), returnByValue: false });
      return;
    }

    const [c1, c2] = cards;
    const s1 = normSuit(c1.suit), s2 = normSuit(c2.suit);
    const r1 = normRank(c1.rank), r2 = normRank(c2.rank);
    if (!s1 || !s2) { process.stdout.write(`\rスート読み取り失敗: ${JSON.stringify(cards)}   `); return; }

    const hand = toHandKey(r1, s1, r2, s2);
    const PF_ORDER = ['UTG','HJ','MP','CO','BTN','SB','BB'];
    const raises = badges
      .filter(b => /raise|all.?in/i.test(b.text))
      .map(b => ({ pos: b.pos }))
      .sort((a, b) => PF_ORDER.indexOf(a.pos) - PF_ORDER.indexOf(b.pos));

    const rangeKey = getRangeKey(pos.toUpperCase(), raises);
    const gto = rangeKey ? lookupGTO(hand, rangeKey) : null;

    // vs表示ラベル
    const isBBOption = pos.toUpperCase() === 'BB' && raises.length === 0;
    const vsLabel = isBBOption ? 'BB オプション'
      : raises.length === 0 ? 'RFI'
      : raises.length === 1 ? `vs ${raises[0].pos}`
      : raises.length === 2 ? `vs ${raises[0].pos} open / ${raises[1].pos} 3bet`
      : `vs ${raises[1].pos} 3bet / ${raises[2].pos} 4bet`;

    // ハンドが変わったら自動アクション済みフラグをリセット
    const autoKey = `${hand}|${rangeKey}`;
    if (hand !== lastHand) {
      lastHand = hand;
      lastAutoKey = null;
      const rec = gto ? `${ACTION_LABEL[gto.best]} (${Math.round((gto.freqs[gto.best] || 0) * 100)}%)` : 'フォールド';
      console.log(`\n[${pos}] ${hand} ${vsLabel} → ${rec}`);
      if (gto) {
        for (const [act, freq] of Object.entries(gto.freqs).sort((a,b)=>b[1]-a[1])) {
          console.log(`  ${(ACTION_LABEL[act]||act).padEnd(12)} ${Math.round(freq*100)}%`);
        }
      }
    }

    // 自動アクションは同一hand+rangeKeyで一度だけ
    const alreadyActed = lastAutoKey === autoKey;
    if (!alreadyActed) lastAutoKey = autoKey;

    // ページにオーバーレイ注入
    await session.send('Runtime.evaluate', {
      expression: buildInjectJS(hand, pos.toUpperCase(), gto, rangeKey, vsLabel, isBBOption, alreadyActed),
      returnByValue: false,
    });

  } catch (e) {
    process.stdout.write(`\rエラー: ${e.message}   `);
  }
}

async function main() {
  console.log('🃏 Preflop GTO Advisor (CDP mode)');
  console.log(`📡 Chrome CDP: http://${CDP_HOST}:${CDP_PORT}`);
  console.log('');

  let session = null;
  let timer = null;

  async function connect() {
    try {
      const targets = await getTargets();
      const target = targets.find(t => t.type === 'page' && t.url.includes(TARGET_URL));

      if (!target) {
        process.stdout.write(`\r⏳ ${TARGET_URL} のタブを待機中...   `);
        return;
      }

      if (session) { try { session.close(); } catch {} }
      session = await createSession(target.webSocketDebuggerUrl);
      console.log(`\n✅ 接続: ${target.url}`);

      if (timer) clearInterval(timer);
      timer = setInterval(() => poll(session), POLL_MS);

    } catch (e) {
      process.stdout.write(`\rChrome未起動 or ポートが違います (${e.message})   `);
      session = null;
      if (timer) { clearInterval(timer); timer = null; }
    }
  }

  // タブ探索は5秒ごと（接続後はpollが動く）
  setInterval(connect, 5000);
  await connect();
}

main().catch(console.error);
