const { Telegraf } = require('telegraf');
const axios = require('axios');
const CryptoJS = require('crypto-js');
const { Base64 } = require('js-base64');
const io = require('socket.io-client');
const fs = require('fs');

// ==========================================
// LOGGING
// ==========================================
const logger = {
  debug: m => console.log(`[DEBUG] ${new Date().toLocaleString('vi-VN')} → ${m}`),
  info:  m => console.log(`[INFO ] ${new Date().toLocaleString('vi-VN')} → ${m}`),
  warn:  m => console.log(`[WARN ] ${new Date().toLocaleString('vi-VN')} → ${m}`),
  error: m => console.log(`[ERROR] ${new Date().toLocaleString('vi-VN')} → ${m}`),
};

// ==========================================
// CẤU HÌNH BOT
// ==========================================
const BOT_TOKEN = '8574423779:AAECp-4sMKuj6VKWtF56XKUw6TpGl7Qice0';
const ADMIN_ID = 8226483750;
const ADMIN_USERNAME = "@ChAnTaoDz";

const bot = new Telegraf(BOT_TOKEN);

bot.telegram.setMyCommands([
  { command: "start", description: "🏠 Mở menu chính hệ thống" },
  { command: "huongdan", description: "📖 Bảng hướng dẫn sử dụng" },
  { command: "nhapkey", description: "🔑 Nhập key kích hoạt bản quyền" },
  { command: "thongtin", description: "💎 Xem thông tin tài khoản & hạn dùng" },
  { command: "login", description: "🔐 Đăng nhập tài khoản game" },
  { command: "autobet", description: "⚡ Bật / tắt tự động đặt cược" },
  { command: "martingale", description: "📈 Bật / tắt gấp thếp (x2 khi thua)" },
  { command: "lichsucau", description: "📊 Xem lịch sử cầu gần nhất" },
  { command: "stop", description: "⏹️ Ngắt kết nối an toàn" },
  { command: "taokey", description: "👑 [ADMIN] Tạo key bản quyền" },
  { command: "danhsachkey", description: "📋 [ADMIN] Xem danh sách key còn lại" },
]);

// ==========================================
// CẤU HÌNH API
// ==========================================
const HISTORY_API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions";
const MAX_HISTORY_STORE = 100;
const MIN_CONFIDENCE_AUTO_BET = 30;
const AUTO_BET_RUN_UNTIL_STOP = true;

let dynamic_weights = {
  cau_rong: 10, cau_dut: 9, cau_11: 8, cau_22: 8,
  cau_33: 7, cau_44: 7, cau_55: 7, thongke: 5,
  markov1: 4, markov2: 5, markov3: 6, diem_xucxac: 4
};

const active_sockets = {};
const user_states = {};
let valid_keys = {};
let authorized_users = {};

const SAVE_FILE = './bot_save.json';
const saveData = () => fs.writeFileSync(SAVE_FILE, JSON.stringify({ valid_keys, authorized_users }, null, 2));
try {
  const raw = fs.readFileSync(SAVE_FILE, 'utf8');
  const d = JSON.parse(raw);
  valid_keys = d.valid_keys || {};
  authorized_users = d.authorized_users || {};
} catch(e){ logger.info('Chưa có dữ liệu lưu, tạo mới'); }

function init_user_state(chat_id) {
  if (!user_states[chat_id]) {
    user_states[chat_id] = {
      history: [], points_history: [],
      auto_bet_enabled: false,
      bet_amount: 10000,
      base_bet: 10000,
      martingale_active: false,
      consecutive_losses: 0,
      current_prediction: null,
      waiting_for_result: false,
      has_bet_this_session: false,
      session_id: null,
      balance: 0,
      win_streak: 0,
      lose_streak: 0,
      total_win: 0,
      total_lose: 0,
      lastPingAt: 0,
      betLock: false,
      pingTimer: null
    };
  }
}

// ==========================================
// HÀM LẤY LỊCH SỬ
// ==========================================
async function fetch_history_from_api(limit = 50) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0",
      "Origin": "https://lc79b.bet",
      "Referer": "https://lc79b.bet/",
      "Accept": "application/json"
    };
    const r = await axios.get(HISTORY_API_URL, { headers, timeout: 15000 });
    let lst = r.data?.list || [];
    if (!lst.length) return [[], []];
    lst = lst.slice().reverse().slice(-limit);
    const ketqua = [], diem = [];
    for (const p of lst) {
      const res = p.resultTruyenThong;
      const tong = p.point || (p.dices||[0,0,0]).reduce((a,b)=>a+b,0);
      if (res === 'TAI' || res === 'XIU') { ketqua.push(res); diem.push(tong); }
    }
    return [ketqua, diem];
  } catch (e) {
    logger.error('LỖI TẢI LỊCH SỬ API: ' + e.message);
    return [[], []];
  }
}

// ==========================================
// BẢO MẬT & KIỂM TRA BẢN QUYỀN
// ==========================================
function check_auth(chat_id) {
  if (chat_id === ADMIN_ID) return true;
  if (authorized_users[chat_id]) {
    if (Date.now() / 1000 <= authorized_users[chat_id]) return true;
    else delete authorized_users[chat_id];
  }
  return false;
}

function locked_msg() {
  return `<pre>╔═══════════════════════════════╗
║   🔒 HỆ THỐNG ĐÃ BỊ KHOÁ 🔒    ║
╠═══════════════════════════════╣
║ ⚠️ BẠN CHƯA CÓ BẢN QUYỀN VIP   ║
║ ❌ KHÔNG THỂ SỬ DỤNG CHỨC NĂNG ║
╠═══════════════════════════════╣
║ 🔑 MỞ KHÓA → LIÊN HỆ ${ADMIN_USERNAME}
║ 💡 CÚ PHÁP: /nhapkey MÃ_KEY
╚═══════════════════════════════╝</pre>`;
}

function format_expire_time(ts) {
  const remain = ts - Date.now()/1000;
  if (remain <= 0) return "❌ ĐÃ HẾT HẠN";
  const d = Math.floor(remain / 86400);
  const h = Math.floor((remain % 86400) / 3600);
  const m = Math.floor((remain % 3600) / 60);
  if (d > 0) return `✅ CÒN ${d} NGÀY ${h} GIỜ ${m} PHÚT`;
  if (h > 0) return `✅ CÒN ${h} GIỜ ${m} PHÚT`;
  return `✅ CÒN ${m} PHÚT`;
}

// ==========================================
// THUẬT TOÁN DỰ ĐOÁN
// ==========================================
function make_prediction_vip(history, points = []) {
  if (history.length < 3) return Math.random() < 0.5 ? 'TAI' : 'XIU';
  const hist_str = history.slice(-30).map(x => x==='TAI'?'T':'X').join('');
  const last = hist_str.slice(-1);
  let score_tai = 0, score_xiu = 0;
  let ket_qua_chinh = null;
  let do_tin_cay = 0;

  if (/TTTTTTT$|XXXXXXX$/.test(hist_str)) { ket_qua_chinh = last==='T'?'TAI':'XIU'; do_tin_cay=95; }
  else if (/TTTTTT$|XXXXXX$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=90; }
  else if (/TTTTT$|XXXXX$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=85; }
  else if (/TTTT$|XXXX$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=80; }
  else if (/TTT$|XXX$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=72; }

  if (/TTTTTTTT$|XXXXXXXX$/.test(hist_str)) { ket_qua_chinh=last==='T'?'XIU':'TAI'; do_tin_cay=88; }
  if (history.length >= 15) {
    const cnt_t = history.slice(-15).filter(x=>x==='TAI').length;
    const cnt_x = 15 - cnt_t;
    if (/TTTTT$/.test(hist_str) && cnt_t > 11) { ket_qua_chinh='XIU'; do_tin_cay = Math.max(do_tin_cay,80); }
    if (/XXXXX$/.test(hist_str) && cnt_x > 11) { ket_qua_chinh='TAI'; do_tin_cay = Math.max(do_tin_cay,80); }
  }

  if (/TXTXTX$|XTXTXT$/.test(hist_str)) { ket_qua_chinh=last==='X'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,87); }
  else if (/TXTX$|XTXT$/.test(hist_str)) { ket_qua_chinh=last==='X'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,78); }
  if (/TTXXTTXX$|XXTTXXTT$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,86); }
  else if (/TTXX$|XXTT$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,76); }
  if (/TTTXXXTTT$|XXXTTTXXX$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,84); }
  else if (/TTTXXX$|XXXTTT$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,75); }
  if (/TTTTXXXX$|XXXXTTTT$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,82); }
  if (/TTTTTXXXXX$|XXXXXTTTTT$/.test(hist_str)) { ket_qua_chinh=last==='T'?'TAI':'XIU'; do_tin_cay=Math.max(do_tin_cay,83); }

  if (/TXT$/.test(hist_str)) { ket_qua_chinh='TAI'; do_tin_cay=Math.max(do_tin_cay,68); }
  if (/XTX$/.test(hist_str)) { ket_qua_chinh='XIU'; do_tin_cay=Math.max(do_tin_cay,68); }

  const r10 = history.slice(-10), r5 = history.slice(-5);
  const t10=r10.filter(x=>x==='TAI').length, x10=10-t10;
  const t5=r5.filter(x=>x==='TAI').length, x5=5-t5;
  if (t5>=4) score_tai += dynamic_weights.thongke;
  else if (x5>=4) score_xiu += dynamic_weights.thongke;
  if (t10 > x10+2) score_tai += dynamic_weights.thongke-1;
  else if (x10 > t10+2) score_xiu += dynamic_weights.thongke-1;
  else if (t10>x10) score_tai += 1;
  else if (x10>t10) score_xiu += 1;

  if (points.length >= 10) {
    const p = points.slice(-10);
    const avg = p.reduce((a,b)=>a+b,0)/10;
    if (avg > 11.2) score_tai += dynamic_weights.diem_xucxac;
    else if (avg < 9.8) score_xiu += dynamic_weights.diem_xucxac;
    const v = p.reduce((s,x)=>s+(x-avg)**2,0)/10;
    if (v < 2.5) { avg>10.5 ? score_tai+=2 : score_xiu+=2; }
  }

  const m1 = { TAI:{TAI:0,XIU:0}, XIU:{TAI:0,XIU:0} };
  const m2 = {}, m3 = {};
  for (let i=0;i<history.length-1;i++) m1[history[i]][history[i+1]]++;
  for (let i=0;i<history.length-2;i++){ const k=history[i]+history[i+1]; (m2[k]??={TAI:0,XIU:0})[history[i+2]]++; }
  for (let i=0;i<history.length-3;i++){ const k=history[i]+history[i+1]+history[i+2]; (m3[k]??={TAI:0,XIU:0})[history[i+3]]++; }

  const cur = last==='T'?'TAI':'XIU';
  const t1 = m1[cur];
  if (t1.TAI > t1.XIU*1.2) score_tai += dynamic_weights.markov1;
  else if (t1.XIU > t1.TAI*1.2) score_xiu += dynamic_weights.markov1;
  else { if(cur==='TAI') score_tai++; else score_xiu++; }

  if (hist_str.length>=2) {
    const prev = hist_str.at(-2)==='T'?'TAI':'XIU';
    const k2 = prev+cur;
    if (m2[k2]) {
      if (m2[k2].TAI > m2[k2].XIU*1.3) score_tai += dynamic_weights.markov2;
      else if (m2[k2].XIU > m2[k2].TAI*1.3) score_xiu += dynamic_weights.markov2;
    }
  }
  if (hist_str.length>=3) {
    const p3 = hist_str.at(-3)==='T'?'TAI':'XIU';
    const p2 = hist_str.at(-2)==='T'?'TAI':'XIU';
    const k3 = p3+p2+cur;
    if (m3[k3]) {
      if (m3[k3].TAI > m3[k3].XIU*1.3) score_tai += dynamic_weights.markov3;
      else if (m3[k3].XIU > m3[k3].TAI*1.3) score_xiu += dynamic_weights.markov3;
    }
  }

  if (ket_qua_chinh) {
    const b = Math.floor(do_tin_cay/8);
    ket_qua_chinh==='TAI' ? score_tai+=b : score_xiu+=b;
  }
  return score_tai > score_xiu ? 'TAI' : (score_xiu>score_tai ? 'XIU' : history.at(-1));
}

function tinh_do_tin_cay(history, points=[]) {
  if (history.length < 5) return 50;
  const hs = history.slice(-20).map(x=>x==='TAI'?'T':'X').join('');
  let base = 62;
  if (/TTTTTT$|XXXXXX$/.test(hs)) base=92;
  else if (/TTTTT$|XXXXX$/.test(hs)) base=88;
  else if (/TXTXTX$|XTXTXT$/.test(hs)) base=85;
  else if (/TTTT$|XXXX$/.test(hs)) base=82;
  else if (/TTXXTTXX$|XXTTXXTT$/.test(hs)) base=80;
  else if (/TTTXXX$|XXXTTT$/.test(hs)) base=78;
  else if (/TXTX$|XTXT$/.test(hs)) base=75;
  else if (/TTXX$|XXTT$/.test(hs)) base=73;
  else if (/TTT$|XXX$/.test(hs)) base=70;
  if (history.length>=10) {
    const r10 = history.slice(-10);
    base += Math.min(Math.abs(r10.filter(x=>x==='TAI').length - r10.filter(x=>x==='XIU').length)*2, 8);
  }
  return Math.min(base, 98);
}

function ai_tu_hoc(chat_id, du_doan, thuc_te) {
  const st = user_states[chat_id]; if(!st) return;
  if (du_doan === thuc_te) {
    st.win_streak++; st.lose_streak=0; st.total_win++;
    st.consecutive_losses = 0;
    st.bet_amount = st.base_bet || 10000;
    for(const k in dynamic_weights) dynamic_weights[k] = Math.min(dynamic_weights[k]+0.05, 15);
  } else {
    st.lose_streak++; st.win_streak=0; st.total_lose++;
    st.consecutive_losses++;
    for(const k in dynamic_weights) dynamic_weights[k] = Math.max(dynamic_weights[k]-0.03, 2);
  }
}

// ==========================================
// ĐĂNG NHẬP VÀ SOCKET
// ==========================================
function md5(t){ return CryptoJS.MD5(t).toString(); }

async function login_and_get_token(u, p){
  try {
    const pw = md5(p);
    const url = `https://apifo88daigia.tele68.com/api?c=3&un=${encodeURIComponent(u)}&pw=${pw}&cp=R&cl=R&pf=web&at=`;
    logger.info(`[LOGIN] Gọi API: ${url}`);
    const r = await axios.get(url, { timeout: 12000 });
    const d = r.data;
    logger.info(`[LOGIN] Phản hồi API: ${JSON.stringify(d)}`);
    if (!d.success) {
      const errMsg = d.message || 'Sai tài khoản hoặc mật khẩu';
      logger.error(`[LOGIN] Lỗi từ game: ${errMsg}`);
      return { _error: `Lỗi Game: ${errMsg}` };
    }
    let sk = d.sessionKey;
    sk += '='.repeat((4 - sk.length%4)%4);
    const sd = JSON.parse(Base64.decode(sk));
    const nickname = sd.nickname || sd.nickName;
    logger.info(`[LOGIN] Nickname: ${nickname}`);
    const r2 = await axios.post(
      'https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web&at=',
      { nickName: nickname, accessToken: d.accessToken },
      { headers: { 'authority':'wlb.tele68.com','content-type':'application/json', 'origin':'https://lc79b.bet', 'referer':'https://lc79b.bet/' }, timeout:12000 }
    );
    const token = r2.data?.token;
    if(!token) {
      logger.error('[LOGIN] Không lấy được token từ lobby');
      return { _error: 'Lobby không trả token' };
    }
    logger.info(`[LOGIN] Đăng nhập thành công, token: ${token.substring(0,10)}...`);
    return { token, nickname, money: r2.data?.remoteLoginResp?.money || 0 };
  } catch(e) {
    logger.error('[LOGIN] Lỗi kết nối: ' + e.message);
    return { _error: 'Lỗi kết nối: ' + e.message };
  }
}

function startAntiSleep() {
  setInterval(async () => {
    try {
      await axios.get('https://lc79b.bet', { timeout: 8000 }).catch(()=>{});
      logger.info('🌐 PING RENDER OK — giữ kết nối 100%');
    } catch(e){}
  }, 40000);

  setInterval(() => {
    const now = Date.now();
    for (const cid in active_sockets) {
      const st = user_states[cid];
      if (st && now - st.lastPingAt > 90000) {
        logger.warn(`🐶 WATCHDOG: ${cid} đứng hình → ngắt & kết nối lại`);
        try { active_sockets[cid]?.disconnect?.(); } catch(e){}
      }
    }
  }, 30000);
}

// ==========================================
// KẾT NỐI SOCKET (ĐÃ SỬA LỖI HOÀN TOÀN)
// ==========================================
function start_websocket(chat_id, token) {
  init_user_state(chat_id);
  if (active_sockets[chat_id]) {
    try { active_sockets[chat_id].disconnect(); } catch(e) {}
    delete active_sockets[chat_id];
  }

  // Kết nối socket với namespace /txmd5
  const sio = io('https://wtxmd52.tele68.com/txmd5', {
    transports: ['websocket'],
    auth: { token },
    reconnection: true,
    reconnectionAttempts: 99999,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  active_sockets[chat_id] = sio;
  const st = user_states[chat_id];

  // Xóa timer cũ nếu có
  if (st.pingTimer) clearInterval(st.pingTimer);

  // Ping mỗi 25s giữ kết nối
  st.pingTimer = setInterval(() => {
    if (sio.connected) {
      sio.emit('ping', {});
      st.lastPingAt = Date.now();
    }
  }, 25000);

  // Sự kiện kết nối thành công
  sio.on('connect', async () => {
    logger.info(`[${chat_id}] ✅ SOCKET KẾT NỐI`);
    st.lastPingAt = Date.now();

    const [lk, ld] = await fetch_history_from_api(50);
    let tb = '';
    if (lk.length) {
      st.history = lk.slice(-MAX_HISTORY_STORE);
      st.points_history = ld.slice(-MAX_HISTORY_STORE);
      tb = `\n║ 📥 TẢI LỊCH SỬ API: <b>${lk.length}</b> PHIÊN ✅`;
    } else {
      tb = `\n║ ⚠️ Thu thập tự động`;
    }

    bot.telegram.sendMessage(chat_id,
      `<pre>╔═══════════════════════════════╗
║     🟢 KẾT NỐI THÀNH CÔNG 🟢    ║
╠═══════════════════════════════╣
║ ✅ ĐÃ KẾT NỐI MÁY CHỦ GAME${tb}
║ ⚡ AI VIP ELITE ĐANG SẴN SÀNG
║ 📡 PING TỰ ĐỘNG ĐÃ BẬT
╚═══════════════════════════════╝</pre>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  // Mất kết nối
  sio.on('disconnect', () => {
    logger.warn(`[${chat_id}] 🔴 NGẮT KẾT NỐI — TỰ KẾT NỐI LẠI`);
    bot.telegram.sendMessage(chat_id,
      `<pre>╔═══════════════════════════════╗
║     🔴 MẤT KẾT NỐI MÁY CHỦ     ║
╠═══════════════════════════════╣
║ ⚙️ TỰ ĐỘNG KẾT NỐI LẠI LIÊN TỤC
╚═══════════════════════════════╝</pre>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  // Phiên mới
  sio.on('new-session', (data) => {
    st.session_id = data?.id || 'N/A';
    st.has_bet_this_session = false;
    st.betLock = false;
    const n = st.history.length;
    const dt = tinh_do_tin_cay(st.history, st.points_history);

    let msg = `<pre>╔═══════════════════════════════╗
║    💎 AI VI LONG ELITE 💎      ║
║       ✨ PHIÊN MỚI MỞ ✨        ║
╠═══════════════════════════════╣
║ 🎯 MÃ PHIÊN: ${st.session_id}
║ 📊 ĐÃ THU THẬP: ${n}/20 KÊT QUẢ</pre>`;

    if (n >= 3) {
      const pred = make_prediction_vip(st.history, st.points_history);
      st.current_prediction = pred;
      const icon = pred === 'TAI' ? '🔵 TÀI' : '🔴 XỈU';
      msg += `\n<pre>╠═══════════════════════════════╣
║ 🤖 AI: ${icon} | 📈 ${dt}%</pre>`;
      if (st.auto_bet_enabled) {
        if (dt >= MIN_CONFIDENCE_AUTO_BET) {
          msg += `\n<pre>║ ⚡ AUTO ON — ${st.bet_amount.toLocaleString()} WIN</pre>`;
        } else {
          msg += `\n<pre>║ ⚠️ ĐỘ TIN <${MIN_CONFIDENCE_AUTO_BET}% → BỎ QUA</pre>`;
        }
      }
    } else {
      st.current_prediction = null;
      msg += `\n<pre>║ ⏳ ĐANG THU DỮ LIỆU</pre>`;
    }
    msg += `\n<pre>╚═══════════════════════════════╝</pre>`;

    bot.telegram.sendMessage(chat_id, msg, { parse_mode: 'HTML' }).catch(() => {});
  });

  // Cập nhật trạng thái và đặt cược
  sio.on('tick-update', (data) => {
    const gs = data?.state;
    const dt = tinh_do_tin_cay(st.history, st.points_history);

    if (gs === 'BETTING' && st.auto_bet_enabled && st.current_prediction && AUTO_BET_RUN_UNTIL_STOP) {
      let currentBet = st.bet_amount;
      if (st.martingale_active && st.consecutive_losses > 0) {
        const multiplier = Math.pow(2, Math.min(st.consecutive_losses, 5));
        currentBet = st.base_bet * multiplier;
        if (currentBet > st.balance) currentBet = st.balance;
      }

      if (currentBet > st.balance) {
        bot.telegram.sendMessage(chat_id,
          `⚠️ Số dư không đủ: ${currentBet.toLocaleString()} > ${st.balance.toLocaleString()}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }

      if (!st.has_bet_this_session && !st.betLock && dt >= MIN_CONFIDENCE_AUTO_BET) {
        st.betLock = true;
        const pay = { type: st.current_prediction, amount: Math.floor(currentBet) };
        try {
          sio.emit('bet', pay);
          st.has_bet_this_session = true;
          st.waiting_for_result = true;
          const icon = st.current_prediction === 'TAI' ? '🔵 TÀI' : '🔴 XỈU';
          bot.telegram.sendMessage(chat_id,
            `<pre>╔═══════════════════════════════╗
║      🚀 GỬI LỆNH TỰ ĐỘNG       ║
╠═══════════════════════════════╣
║ ✅ ĐẶT CƯỢC: ${icon}
║ 💰 ${Math.floor(currentBet).toLocaleString()} WIN
║ ${st.martingale_active ? `📈 GẤP THẾP (x${Math.pow(2, st.consecutive_losses).toFixed(0)})` : ''}
║ ⏳ CHỜ KẾT QUẢ
╚═══════════════════════════════╝</pre>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } catch (e) {
          st.betLock = false;
        }
      }
    }
  });
    // Xác nhận đặt cược
  sio.on('bet-result', (data) => {
    if (data?.postBalance != null) st.balance = data.postBalance;
    bot.telegram.sendMessage(chat_id,
      `<pre>╔═══════════════════════════════╗
║      ✅ XÁC NHẬN ĐẶT CƯỢC      ║
╠═══════════════════════════════╣
║ 💰 SỐ DƯ: ${st.balance.toLocaleString()} WIN
╚═══════════════════════════════╝</pre>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    try { sio.emit('get-current-my-info', {}); } catch(e) {}
  });

  // Kết quả phiên
  sio.on('session-result', (data) => {
    st.betLock = false;
    const d = data?.dices || [0,0,0];
    const tong = d.reduce((a,b) => a+b, 0);
    const kq = data?.resultTruyenThong || 'N/A';

    if (kq === 'TAI' || kq === 'XIU') {
      st.history.push(kq);
      st.points_history.push(tong);
      if (st.history.length > MAX_HISTORY_STORE) {
        st.history.shift();
        st.points_history.shift();
      }
      if (st.current_prediction) ai_tu_hoc(chat_id, st.current_prediction, kq);
    }

    const icon = kq === 'TAI' ? '🔵 TÀI' : (kq === 'XIU' ? '🔴 XỈU' : '⚪ LỖI');
    let row = `<pre>╔═══════════════════════════════╗
║ 🎲 ${d[0]}-${d[1]}-${d[2]} = ${tong} → ${icon}</pre>`;
    if (st.current_prediction) {
      const ok = st.current_prediction === kq;
      row += `\n<pre>║ 📊 AI: ${ok ? `🟢 ĐÚNG ✅ THẮNG LIÊN ${st.win_streak}` : `🔴 SAI ⚠️ HỌC LẠI | THUA LIÊN ${st.lose_streak}`}</pre>`;
      st.waiting_for_result = false;
    }
    const ls = st.history.slice(-12).map(x => x === 'TAI' ? '🔵' : '🔴').join('');
    row += `\n<pre>║ 📈 ${ls}</pre>\n<pre>╚═══════════════════════════════╝</pre>`;
    bot.telegram.sendMessage(chat_id, row, { parse_mode: 'HTML' }).catch(() => {});
  });

  sio.on('connect_error', (err) => {
    logger.error('SOCKET ERR: ' + err.message);
  });
}

// ==========================================
// CÁC LỆNH BOT
// ==========================================
bot.start(ctx => {
  const cid = ctx.chat.id; init_user_state(cid);
  if (check_auth(cid)) {
    const han = cid===ADMIN_ID ? '👑 VĨNH VIỄN - ADMIN' : format_expire_time(authorized_users[cid]);
    ctx.replyWithHTML(
`<pre>╔═══════════════════════════════╗
║    💎 CHÀO MỪNG VIP 💎     ║
║      ✨ VI LONG ELITE ✨        ║
╠═══════════════════════════════╣
║ ✅ ĐÃ KÍCH HOẠT
║ ⏳ ${han}
╠═══════════════════════════════╣
║ 📖 /huongdan | 🔐 /login
║ ⚡ /autobet | 📈 /martingale
║ 📊 /lichsucau | ⏹️ /stop
╚═══════════════════════════════╝</pre>`);
  } else {
    ctx.replyWithHTML(
`<pre>╔═══════════════════════════════╗
║   🏠 TRANG CHỦ 💎 VI LONG ║
╠═══════════════════════════════╣
║ 🔒 YÊU CẦU KEY VIP
║ 🔑 /nhapkey MÃ_KEY
║ 📩 MUA: ${ADMIN_USERNAME}
╚═══════════════════════════════╝</pre>`);
  }
});

bot.command('huongdan', ctx => ctx.replyWithHTML(
`<pre>╔═══════════════════════════════╗
║ 📖 HƯỚNG DẪN VIP | ✨ VI LONG ║
╠═══════════════════════════════╣
║ 🔑 /nhapkey KEY
║ 🔐 /login TK MK
║ ⚡ /autobet on 10000 | off
║ 📈 /martingale on | off
║ 📊 /lichsucau | 💎 /thongtin
║ ⏹️ /stop | 👑 /taokey 30
╠═══════════════════════════════╣
║ 🧠 AI: RỒNG · ĐỨT · 1-1→5-5
║ MARKOV 3 · THỐNG KÊ · XÚC XẮC
║ 📩 ${ADMIN_USERNAME}
╚═══════════════════════════════╝</pre>`));

bot.command('taokey', ctx => {
  if (ctx.chat.id !== ADMIN_ID) return ctx.reply('⛔ Chỉ admin');
  const n = parseInt(ctx.message.text.split(/\s+/)[1]) || 30;
  if (n<=0) return ctx.reply('✅ /taokey 7 / 30 / 90');
  const key = 'VIP-' + Math.random().toString(36).slice(2,12).toUpperCase();
  valid_keys[key] = n; saveData();
  const het = new Date(Date.now()+n*86400000).toLocaleString('vi-VN');
  ctx.replyWithHTML(`✅ KEY: <code>${key}</code>\n⏳ ${n} NGÀY\n📅 ${het}\n📊 CÒN: ${Object.keys(valid_keys).length}`);
});

bot.command('danhsachkey', ctx => {
  if (ctx.chat.id !== ADMIN_ID) return ctx.reply('⛔ Chỉ admin');
  const arr = Object.entries(valid_keys);
  if(!arr.length) return ctx.reply('📭 Trống');
  ctx.replyWithHTML(arr.map(([k,v])=>`<code>${k}</code> → ${v}N`).join('\n') + `\n📊 TỔNG: ${arr.length}`);
});

bot.command('nhapkey', ctx => {
  const w = ctx.message.text.split(/\s+/);
  if(w.length<2) return ctx.reply('✅ /nhapkey VIP-XXXX');
  const k = w[1].trim().toUpperCase();
  if(valid_keys[k]){
    const d = valid_keys[k];
    authorized_users[ctx.chat.id] = Date.now()/1000 + d*86400;
    delete valid_keys[k]; saveData();
    ctx.reply(`🎉 KÍCH HOẠT THÀNH CÔNG ${d} NGÀY ✅`);
  } else ctx.reply(`❌ KEY KHÔNG HỢP LỆ\n📩 MUA: ${ADMIN_USERNAME}`);
});

bot.command('thongtin', ctx => {
  const cid = ctx.chat.id; init_user_state(cid);
  if(!check_auth(cid)) return ctx.reply('🔒 CHƯA KÍCH HOẠT');
  const st = user_states[cid];
  const han = cid===ADMIN_ID?'👑 VĨNH VIỄN':format_expire_time(authorized_users[cid]);
  ctx.replyWithHTML(
`<pre>💎 TÀI KHOẢN
🆔 <code>${cid}</code>
⏳ ${han}
⚡ ${st.auto_bet_enabled?'🟢 BẬT':'🔴 TẮT'}
📈 ${st.martingale_active?'🟢 GẤP THẾP':'🔴 TẮT'} (thua liên: ${st.consecutive_losses})
💰 ${st.bet_amount.toLocaleString()} | DƯ: ${st.balance.toLocaleString()}
✅ THẮNG:${st.total_win} | ❌ THUA:${st.total_lose}
📊 ${st.history.length} PHIÊN</pre>`);
});

bot.command('lichsucau', ctx => {
  if(!check_auth(ctx.chat.id)) return ctx.replyWithHTML(locked_msg());
  const st = user_states[ctx.chat.id];
  if(!st.history.length) return ctx.reply('📭 Chưa dữ liệu');
  const ls = st.history.slice(-20);
  ctx.reply(`🔵 TÀI ${ls.filter(x=>x==='TAI').length} | 🔴 XỈU ${ls.filter(x=>x==='XIU').length}\n${ls.map(x=>x==='TAI'?'🔵':'🔴').join('')}`);
});

bot.command('login', async ctx => {
  if(!check_auth(ctx.chat.id)) return ctx.replyWithHTML(locked_msg());
  const w = ctx.message.text.split(/\s+/);
  if(w.length!==3) return ctx.reply('✅ /login TAIKHOAN MATKHAU');
  const m = await ctx.reply('🔄 Đang kết nối...');
  const r = await login_and_get_token(w[1], w[2]);
  if(r._error) {
    await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, null, '❌ ' + r._error);
    return;
  }
  init_user_state(ctx.chat.id);
  user_states[ctx.chat.id].balance = r.money;
  if (!user_states[ctx.chat.id].bet_amount) {
    user_states[ctx.chat.id].bet_amount = 10000;
    user_states[ctx.chat.id].base_bet = 10000;
  }
  await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, null, `✅ ${r.nickname} | ${r.money.toLocaleString()} WIN`);
  start_websocket(ctx.chat.id, r.token);
});

bot.command('autobet', ctx => {
  const cid = ctx.chat.id;
  if(!check_auth(cid)) return ctx.replyWithHTML(locked_msg());
  if(!active_sockets[cid]) return ctx.reply('⚠️ Phải /login trước');
  const w = ctx.message.text.split(/\s+/);
  if(w.length<2) return ctx.reply('✅ /autobet on 10000 | off');
  const st = user_states[cid];
  if(w[1].toLowerCase()==='on'){
    const amt = parseInt(w[2]) || 10000;
    st.auto_bet_enabled = true;
    st.bet_amount = amt;
    st.base_bet = amt;
    st.consecutive_losses = 0;
    ctx.reply(`🟢 AUTO BẬT | ${amt.toLocaleString()} WIN | CHẠY ĐẾN /autobet off`);
  } else {
    st.auto_bet_enabled = false;
    st.martingale_active = false;
    ctx.reply('🔴 AUTO ĐÃ DỪNG');
  }
});

bot.command('martingale', ctx => {
  const cid = ctx.chat.id;
  if(!check_auth(cid)) return ctx.replyWithHTML(locked_msg());
  const st = user_states[cid];
  if(!st || !active_sockets[cid]) return ctx.reply('⚠️ Phải /login trước');
  const w = ctx.message.text.split(/\s+/);
  if(w.length<2) return ctx.reply('✅ /martingale on | off');
  if(w[1].toLowerCase()==='on'){
    st.martingale_active = true;
    st.consecutive_losses = 0;
    st.bet_amount = st.base_bet || 10000;
    ctx.reply('🟢 ĐÃ BẬT GẤP THẾP (x2 khi thua)');
  } else {
    st.martingale_active = false;
    st.consecutive_losses = 0;
    st.bet_amount = st.base_bet || 10000;
    ctx.reply('🔴 ĐÃ TẮT GẤP THẾP');
  }
});

bot.command('stop', ctx => {
  const cid = ctx.chat.id;
  if(!check_auth(cid)) return ctx.replyWithHTML(locked_msg());
  if(active_sockets[cid]){
    const st = user_states[cid];
    if (st && st.pingTimer) {
      clearInterval(st.pingTimer);
      st.pingTimer = null;
    }
    try{ active_sockets[cid].disconnect(); }catch(e){}
    delete active_sockets[cid];
    if (st) {
      st.auto_bet_enabled = false;
      st.martingale_active = false;
    }
    ctx.reply('⏹️ ĐÃ NGẮT AN TOÀN');
  } else ctx.reply('⚠️ Không có kết nối');
});

// ==========================================
// KHỞI ĐỘNG BOT
// ==========================================
bot.catch(e => logger.error('BOT ERR: ' + e.message));
bot.launch({ dropPendingUpdates: true }).then(() => {
  logger.info('👑 VIP SYSTEM ONLINE — VI LONG ELITE ✨ JS + PING RENDER');
  startAntiSleep();
});

const http = require('http');
http.createServer((_, res)=>{ res.writeHead(200); res.end('BOT OK '+Date.now()); }).listen(process.env.PORT || 3000, ()=>logger.info('🌐 KEEP-ALIVE HTTP: ' + (process.env.PORT||3000)));

process.on('unhandledRejection', e => logger.error('REJECT: ' + e.message));
process.on('uncaughtException', e => logger.error('EXCEPT: ' + e.message + ' → TIẾP TỤC CHẠY'));
