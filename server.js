/**
 * Railway Coordinator Server
 * - Giao diện web để cập nhật JobID (có đăng nhập mật khẩu)
 * - Phân phối JobID tuần tự không trùng lặp cho nhiều client Lua
 */

const express = require("express");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY   = process.env.API_KEY || "admin123"; // Đặt biến môi trường API_KEY trên Railway
const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");

// Discord webhook giờ nằm ở SERVER, không còn nằm trong Lua client nữa.
// Đặt biến môi trường DISCORD_WEBHOOK_URL trên Railway.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// ─── Persistent storage ───────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return {
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        targets: Array.isArray(parsed.targets) ? parsed.targets : [],
      };
    }
  } catch (err) {
    console.error("❌ [LOAD] Lỗi đọc data.json:", err.message);
  }
  return { servers: [], targets: [] };
}

function saveData(servers, targets) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ servers, targets }, null, 2), "utf8");
    console.log(`💾 [SAVE] servers=${servers.length} targets=${targets.length}`);
  } catch (err) {
    console.error("❌ [SAVE] Lỗi ghi data.json:", err.message);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
const initialData = loadData();
let serverList    = initialData.servers;
let targetItems   = initialData.targets; // tên item đã lowercase + trim
let globalCounter = 0;
let skippedSet    = new Set();

// Log dữ liệu quét nhận về (chỉ lưu trong RAM, mất khi restart — dùng /data/clear để dọn tay)
const SCAN_LOG_MAX = 300;
let scanLog = [];

console.log(`📂 [LOAD] servers=${serverList.length} targets=${targetItems.length}`);

// ════════════════════════════════════════════════════════════════════════════
// 🕵️ LESTER HUB — Player/Gang Finder + Rift/Boss Timer
// Toàn bộ phần dưới đây là 1 hệ thống HOÀN TOÀN TÁCH BIỆT khỏi Merchant
// Scanner ở trên: state riêng, file lưu riêng (lester-data.json), route riêng
// (tiền tố /lester/...), dashboard riêng (/lester-dashboard). Không đụng tới
// biến, file data.json hay route nào của hệ thống cũ.
// ════════════════════════════════════════════════════════════════════════════
const LESTER_DATA_FILE = path.join(DATA_DIR, "lester-data.json");

function loadLesterData() {
  try {
    if (fs.existsSync(LESTER_DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LESTER_DATA_FILE, "utf8"));
      return {
        targetPlayers: Array.isArray(parsed.targetPlayers) ? parsed.targetPlayers : [],
      };
    }
  } catch (err) {
    console.error("❌ [LESTER LOAD] Lỗi đọc lester-data.json:", err.message);
  }
  return { targetPlayers: [] };
}

function saveLesterData() {
  try {
    fs.writeFileSync(LESTER_DATA_FILE, JSON.stringify({
      targetPlayers: lesterTargetPlayers,
    }, null, 2), "utf8");
    console.log(`💾 [LESTER SAVE] targetPlayers=${lesterTargetPlayers.length}`);
  } catch (err) {
    console.error("❌ [LESTER SAVE] Lỗi ghi lester-data.json:", err.message);
  }
}

const lesterInit = loadLesterData();
let lesterTargetPlayers = lesterInit.targetPlayers; // tên player cần theo dõi (lowercase, trimmed)
// Hàng đợi "ép nhảy tới JobID cụ thể" — dùng chung với vòng hop CỦA game.lua
// (executeHop() sẽ kiểm tra hàng đợi này TRƯỚC khi gọi /claim như bình thường).
// Không còn round-robin/full-set riêng cho Lester nữa vì hopping giờ dùng
// chung engine /claim + /skip đã có sẵn của Merchant Scanner.
let lesterJoinQueue     = [];
let lesterServers       = {};         // jobId -> { jobId, gang, ageMinutes, reportedAt, matchedPlayers[], matchedGang, bosses[], updatedAt } (RAM only, dùng nút Clear Data để dọn)
const lesterSseClients  = new Set();

console.log(`📂 [LESTER LOAD] targetPlayers=${lesterTargetPlayers.length}`);

function lesterBroadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of lesterSseClients) {
    try { client.write(payload); } catch (_) { lesterSseClients.delete(client); }
  }
}

// Thời gian hiện tại (phút) của 1 server, tính real-time dựa trên lần report gần nhất
// VD: report lúc ageMinutes=620 (10h20) lúc 10:00:00, bây giờ là 10:03:30 -> trả về 623.5
function lesterCurrentMinutes(server) {
  const base = Number(server.ageMinutes) || 0;
  const reportedAt = new Date(server.reportedAt).getTime();
  const elapsedMin = Math.max(0, (Date.now() - reportedAt) / 60000);
  return base + elapsedMin;
}

// Kiểm tra 1 mốc thời gian có đang nằm trong khoảng ±10 phút quanh chu kỳ spawn không
// (rift: chu kỳ 90 phút -> 1h30, 3h00, 4h30...; boss: chu kỳ 120 phút -> 2h00, 4h00...)
function lesterInWindow(currentMinutes, periodMinutes, windowMinutes) {
  const remainder = ((currentMinutes % periodMinutes) + periodMinutes) % periodMinutes;
  return remainder <= windowMinutes || remainder >= (periodMinutes - windowMinutes);
}

function lesterFmtMinutes(mins) {
  const total = Math.round(mins);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":00";
}

function getNextValidIndex() {
  if (serverList.length === 0) return null;
  const activeCount = serverList.filter((id) => !skippedSet.has(id)).length;
  if (activeCount === 0) {
    console.log("[RESET] Hết vòng, reset skip set.");
    skippedSet.clear();
  }
  const total = serverList.length;
  for (let i = 0; i < total; i++) {
    const idx = (globalCounter + i) % total;
    const id  = serverList[idx];
    if (!skippedSet.has(id)) {
      globalCounter = (idx + 1) % total;
      return { index: idx, jobId: id };
    }
  }
  return null;
}

// ─── Discord Notifier (hàng đợi, tôn trọng rate-limit của Discord) ───────────
// Trước đây MỖI client Lua tự bắn webhook -> nhiều instance cùng lúc dễ dính
// 429 từ Discord. Giờ chỉ SERVER là điểm duy nhất gọi Discord, xử lý tuần tự
// qua hàng đợi nên không bao giờ bắn quá nhanh nữa.
const discordQueue = [];
let discordBusy = false;

function queueDiscordMessage(payload) {
  discordQueue.push(payload);
  processDiscordQueue();
}

async function processDiscordQueue() {
  if (discordBusy) return;
  discordBusy = true;

  while (discordQueue.length > 0) {
    const payload = discordQueue.shift();

    if (!DISCORD_WEBHOOK_URL) {
      console.warn("⚠️ [DISCORD] Chưa cấu hình DISCORD_WEBHOOK_URL, bỏ qua gửi.");
      continue;
    }

    try {
      const res = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        console.warn(`⏳ [DISCORD] 429, đợi ${retryAfter}s rồi gửi lại...`);
        discordQueue.unshift(payload); // đưa lại đầu hàng đợi để không mất tin
        await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200));
        continue;
      }

      if (!res.ok) {
        console.error(`❌ [DISCORD] HTTP ${res.status}: ${await res.text()}`);
      } else {
        console.log("✅ [DISCORD] Đã gửi thông báo");
      }
    } catch (err) {
      console.error("❌ [DISCORD] Lỗi gửi:", err.message);
    }

    await new Promise((r) => setTimeout(r, 500)); // giãn cách an toàn giữa các lần gửi
  }

  discordBusy = false;
}

function buildFishstrapLink(placeId, jobId) {
  return `https://www.fishstrap.app/v1/joingame?placeId=${placeId || ""}&gameInstanceId=${jobId}`;
}

function buildJoinScript(jobId) {
  return `-- [[ JOIN SERVER BY JOBID ]] --
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local jobId = "${jobId}" -- Dán JobId bạn muốn vào đây
TeleportService:TeleportToPlaceInstance(game.PlaceId, jobId, Players.LocalPlayer)`;
}

function buildMerchantPayload(matched, jobId, placeId, position) {
  const fields = matched.map((it) => ({
    name: "🛒 " + it.name,
    value: `**Số lượng:** x${it.quantity}\n💴 **Yên:** ${it.yen}`,
    inline: true,
  }));

  const posText = position
    ? `X: ${Number(position.x).toFixed(1)}, Y: ${Number(position.y).toFixed(1)}, Z: ${Number(position.z).toFixed(1)}`
    : "N/A";

  return {
    content: `🛒 **TRAVELING MERCHANT ĐÃ XUẤT HIỆN!**\nItem bạn theo dõi: **${matched.map((m) => m.name).join(", ")}** đã có hàng!`,
    embeds: [
      {
        title: "📦 DANH SÁCH HÀNG HÓA (KHỚP TARGET)",
        color: 3066993,
        fields: [
          ...fields,
          { name: "📍 Vị trí NPC", value: posText, inline: false },
          { name: "🔑 Job ID", value: "```" + jobId + "```", inline: false },
          { name: "🔗 Join Link (Fishstrap)", value: buildFishstrapLink(placeId, jobId), inline: false },
          { name: "📋 Lua Script Join", value: "```lua\n" + buildJoinScript(jobId) + "\n```", inline: false },
        ],
        footer: { text: "Merchant Filter Bot" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ─── SSE (Server-Sent Events) — đẩy dữ liệu quét về dashboard real-time ──────
// Thay vì phải chờ Discord (giới hạn ~2s/tin), dashboard nhận trực tiếp qua
// đường ống HTTP mở sẵn này -> gần như tức thời, không giới hạn tốc độ.
const sseClients = new Set();

function broadcastSSE(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

// ─── Middleware xác thực API Key (cho Lua client) ─────────────────────────────
function apiAuth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Giao diện Web ───────────────────────────────────────────────────────────

// Trang login
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Merchant Coordinator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 40px;
      width: 360px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    h1 { font-size: 20px; margin-bottom: 8px; color: #fff; }
    p  { font-size: 13px; color: #888; margin-bottom: 28px; }
    label { font-size: 13px; color: #aaa; display: block; margin-bottom: 6px; }
    input[type=password] {
      width: 100%;
      padding: 10px 14px;
      background: #111;
      border: 1px solid #444;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: border 0.2s;
    }
    input[type=password]:focus { border-color: #4f8ef7; }
    button {
      width: 100%;
      margin-top: 18px;
      padding: 11px;
      background: #4f8ef7;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #3a7ae0; }
    .error {
      margin-top: 14px;
      padding: 10px 14px;
      background: #2a1010;
      border: 1px solid #c0392b;
      border-radius: 8px;
      color: #e74c3c;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Merchant Coordinator</h1>
    <p>Đăng nhập để quản lý danh sách JobID</p>
    <form method="POST" action="/login">
      <label>Mật khẩu</label>
      <input type="password" name="password" placeholder="Nhập mật khẩu..." autofocus>
      <button type="submit">Đăng nhập</button>
    </form>
    ${req.query.err ? '<div class="error">❌ Mật khẩu không đúng!</div>' : ""}
  </div>
</body>
</html>`);
});

// Xử lý login — dùng redirect đơn giản với key trên URL (stateless)
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password !== API_KEY) {
    return res.redirect("/?err=1");
  }
  res.redirect("/dashboard?key=" + encodeURIComponent(API_KEY));
});

// Trang dashboard quản lý JobID
app.get("/dashboard", (req, res) => {
  const key = req.query.key;
  if (key !== API_KEY) return res.redirect("/");

  const total      = serverList.length;
  const skipCount  = skippedSet.size;
  const activeCount = total - serverList.filter(id => skippedSet.has(id)).length;

  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - Merchant Coordinator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      padding: 32px 16px;
    }
    .container { max-width: 700px; margin: 0 auto; }
    h1 { font-size: 22px; color: #fff; margin-bottom: 6px; }
    .sub { color: #666; font-size: 13px; margin-bottom: 28px; }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 28px;
    }
    .stat {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 10px;
      padding: 16px;
      text-align: center;
    }
    .stat .num { font-size: 28px; font-weight: 700; color: #4f8ef7; }
    .stat .lbl { font-size: 12px; color: #666; margin-top: 4px; }

    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .card h2 { font-size: 15px; color: #fff; margin-bottom: 6px; }
    .card p  { font-size: 12px; color: #666; margin-bottom: 14px; }

    textarea {
      width: 100%;
      height: 220px;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 13px;
      font-family: monospace;
      padding: 12px;
      outline: none;
      resize: vertical;
      transition: border 0.2s;
    }
    textarea:focus { border-color: #4f8ef7; }

    .actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    button {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-primary { background: #4f8ef7; color: #fff; }
    .btn-primary:hover { background: #3a7ae0; }
    .btn-danger  { background: #c0392b; color: #fff; }
    .btn-danger:hover  { background: #a93226; }
    .btn-secondary { background: #2a2a2a; color: #aaa; border: 1px solid #444; }
    .btn-secondary:hover { background: #333; }

    .toast {
      display: none;
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #27ae60;
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      z-index: 999;
    }
    .toast.err { background: #c0392b; }

    .current-list {
      font-family: monospace;
      font-size: 12px;
      color: #888;
      background: #111;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 12px;
      max-height: 160px;
      overflow-y: auto;
      line-height: 1.8;
      word-break: break-all;
    }

    .alert-banner {
      display: none;
      position: sticky;
      top: 0;
      z-index: 1000;
      background: #c0392b;
      color: #fff;
      padding: 14px 20px;
      margin: -32px -16px 20px -16px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      animation: pulse 1s infinite;
    }
    .alert-banner .title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
    .alert-banner .body  { font-size: 13px; opacity: 0.95; margin-bottom: 10px; }
    .alert-banner .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .alert-banner button {
      padding: 8px 16px; border: none; border-radius: 6px;
      font-size: 12px; font-weight: 700; cursor: pointer;
    }
    .alert-banner .btn-view { background: #fff; color: #c0392b; }
    .alert-banner .btn-copy { background: rgba(255,255,255,0.2); color: #fff; }
    .alert-banner .btn-mute { background: rgba(255,255,255,0.2); color: #fff; }
    .alert-banner .btn-mute.active { background: #222; color: #ffd166; }
    @keyframes pulse {
      0%, 100% { background: #c0392b; }
      50%      { background: #e74c3c; }
    }

    .scan-item {
      background: #111;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .scan-item.matched { border-color: #27ae60; background: #0f1a12; }
    .scan-item .row1 { display: flex; justify-content: space-between; color: #666; margin-bottom: 6px; }
    .scan-item .row1 .time { font-family: monospace; }
    .scan-item .row1 .matched-tag { color: #27ae60; font-weight: 700; }
    .scan-item .items { color: #aaa; line-height: 1.6; }
    .scan-item .jobid { font-family: monospace; color: #4f8ef7; word-break: break-all; }
    .scan-item .mini-actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
    .scan-item .mini-actions button {
      padding: 4px 10px; font-size: 11px; border: 1px solid #333;
      background: #1a1a1a; color: #aaa; border-radius: 6px; cursor: pointer;
    }
    .scan-item .mini-actions button:hover { background: #2a2a2a; }
    .scan-log-wrap { max-height: 480px; overflow-y: auto; }
    .empty-hint { color: #555; font-size: 12px; text-align: center; padding: 20px; }
  </style>
</head>
<body>
  <div class="alert-banner" id="alertBanner">
    <div class="title" id="alertTitle">🚨 KHỚP TARGET!</div>
    <div class="body" id="alertBody"></div>
    <div class="actions">
      <button class="btn-view" onclick="dismissAlert()">👁️ Xem (tắt chuông)</button>
      <button class="btn-mute" id="muteBtn" onclick="toggleMute()">🔇 Tắt tiếng</button>
      <button class="btn-copy" onclick="copyText(currentAlert && currentAlert.jobId)">📋 Copy JobID</button>
      <button class="btn-copy" onclick="copyText(currentAlert && currentAlert.joinScript)">📋 Copy Script Join</button>
    </div>
  </div>
  <div class="container">
    <h1>📦 Merchant Coordinator</h1>
    <div class="sub">Quản lý danh sách JobID server</div>

    <div class="stats">
      <div class="stat">
        <div class="num" id="stat-total">${total}</div>
        <div class="lbl">Tổng JobID</div>
      </div>
      <div class="stat">
        <div class="num" id="stat-active" style="color:#27ae60">${activeCount}</div>
        <div class="lbl">Đang hoạt động</div>
      </div>
      <div class="stat">
        <div class="num" id="stat-skip" style="color:#e67e22">${skipCount}</div>
        <div class="lbl">Đã skip (có NPC)</div>
      </div>
    </div>

    <div class="card">
      <h2>📝 Cập nhật danh sách JobID</h2>
      <p>Mỗi dòng 1 JobID — khi lưu sẽ <strong style="color:#e74c3c">thay thế hoàn toàn</strong> danh sách cũ và reset counter</p>
      <textarea id="jobInput" placeholder="Dán JobID vào đây, mỗi dòng 1 ID&#10;Ví dụ:&#10;98a8a07d-d2a0-4b59-b048-36def963cbc6&#10;862eb531-8985-49d9-8dcd-9ffcc112fe56"></textarea>
      <div class="actions">
        <button class="btn-primary" onclick="updateServers()">💾 Lưu & thay thế</button>
        <button class="btn-secondary" onclick="loadCurrent()">📋 Xem list hiện tại</button>
        <button class="btn-danger" onclick="resetCounter()">🔄 Reset counter</button>
      </div>
    </div>

    <div class="card" id="currentCard" style="display:none">
      <h2>📋 Danh sách JobID hiện tại</h2>
      <p id="currentMeta"></p>
      <div class="current-list" id="currentList"></div>
    </div>

    <div class="card">
      <h2>🎯 Target mặt hàng cần theo dõi</h2>
      <p>Mỗi dòng 1 tên mặt hàng (không phân biệt hoa/thường). Chỉ mặt hàng bán bằng <strong style="color:#e74c3c">Yên</strong> mới được xét — AC Coin sẽ bị bỏ qua. Khi khớp, server sẽ tự gửi Discord.</p>
      <textarea id="targetInput" placeholder="Mỗi dòng 1 tên mặt hàng&#10;Ví dụ:&#10;Talent Reroll&#10;Marking Color Reroll"></textarea>
      <div class="actions">
        <button class="btn-primary" onclick="updateTargets()">💾 Lưu target</button>
        <button class="btn-secondary" onclick="loadTargets()">📋 Xem target hiện tại</button>
      </div>
    </div>

    <div class="card" id="targetCard" style="display:none">
      <h2>🎯 Target hiện tại</h2>
      <p id="targetMeta"></p>
      <div class="current-list" id="targetList"></div>
    </div>

    <div class="card">
      <h2>📡 Dữ liệu quét nhận về <span id="connStatus" style="font-size:11px;color:#666">(đang kết nối...)</span></h2>
      <p>Cập nhật real-time mỗi khi có client quét xong. Mục có viền xanh là khớp target — chuông sẽ tự kêu tới khi bạn bấm "Xem".</p>
      <div class="actions" style="margin-top:0; margin-bottom:14px;">
        <button class="btn-danger" onclick="clearData()">🧹 Xóa dữ liệu (/clear)</button>
        <button class="btn-secondary" onclick="loadDataLog()">🔄 Tải lại</button>
      </div>
      <div class="scan-log-wrap" id="scanLogWrap">
        <div class="empty-hint">Chưa có dữ liệu nào được quét...</div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const KEY = "${API_KEY}";

    function showToast(msg, isErr) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.className = "toast" + (isErr ? " err" : "");
      t.style.display = "block";
      setTimeout(() => t.style.display = "none", 3000);
    }

    async function updateServers() {
      const raw = document.getElementById("jobInput").value.trim();
      if (!raw) return showToast("❌ Chưa nhập JobID!", true);

        const servers = raw.split("\\n")
          .map(s => s.trim())
          .filter(s => s.length > 0);

      if (servers.length === 0) return showToast("❌ Không có JobID hợp lệ!", true);

      const res = await fetch("/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
        body: JSON.stringify({ servers })
      });
      const data = await res.json();

      if (res.ok) {
        showToast("✅ Đã cập nhật " + data.total + " JobID!");
        document.getElementById("stat-total").textContent  = data.total;
        document.getElementById("stat-active").textContent = data.total;
        document.getElementById("stat-skip").textContent   = 0;
        document.getElementById("jobInput").value = "";
        document.getElementById("currentCard").style.display = "none";
      } else {
        showToast("❌ " + (data.error || "Lỗi không xác định"), true);
      }
    }

    async function loadCurrent() {
      const res  = await fetch("/servers?key=" + KEY);
      const data = await res.json();
      const card = document.getElementById("currentCard");
      document.getElementById("currentMeta").textContent =
        "Tổng " + data.total + " JobID | Counter: " + data.counter;
      document.getElementById("currentList").innerHTML =
        data.servers.map((id, i) => \`<span style="color:#555">\${i+1}.</span> \${id}\`).join("<br>");
      card.style.display = "block";
    }

    async function updateTargets() {
      const raw = document.getElementById("targetInput").value.trim();
      if (!raw) return showToast("❌ Chưa nhập mặt hàng!", true);

      const targets = raw.split("\\n")
        .map(s => s.trim())
        .filter(s => s.length > 0);

      const res = await fetch("/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
        body: JSON.stringify({ targets })
      });
      const data = await res.json();

      if (res.ok) {
        showToast("✅ Đã lưu " + data.total + " target!");
        document.getElementById("targetInput").value = "";
        document.getElementById("targetCard").style.display = "none";
      } else {
        showToast("❌ " + (data.error || "Lỗi không xác định"), true);
      }
    }

    async function loadTargets() {
      const res  = await fetch("/targets?key=" + KEY);
      const data = await res.json();
      const card = document.getElementById("targetCard");
      document.getElementById("targetMeta").textContent = "Tổng " + data.total + " target";
      document.getElementById("targetList").innerHTML =
        data.targets.map((name, i) => \`<span style="color:#555">\${i+1}.</span> \${name}\`).join("<br>") || "<em>Chưa có target nào</em>";
      card.style.display = "block";
    }

    async function resetCounter() {
      if (!confirm("Reset counter và skip set?")) return;
      const res = await fetch("/reset?key=" + KEY, { method: "POST" });
      if (res.ok) {
        showToast("✅ Đã reset counter và skip set!");
        document.getElementById("stat-skip").textContent = 0;
      }
    }

    // ─────────────────────────────────────────────────────────────
    //  DỮ LIỆU QUÉT REAL-TIME (SSE) + CẢNH BÁO ÂM THANH
    // ─────────────────────────────────────────────────────────────
    let scanEvents     = [];   // danh sách hiển thị (mới nhất ở cuối)
    let scanEventsById = {};   // tra cứu nhanh theo id, tránh nhét chuỗi thô vào onclick
    let alertQueue     = [];
    let currentAlert   = null;
    let audioCtx       = null;
    let alarmTimer     = null;
    let isMuted        = false; // tắt tiếng chuông, không ảnh hưởng tới banner/queue

    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    function fmtTime(iso) {
      try { return new Date(iso).toLocaleTimeString("vi-VN"); } catch (e) { return iso; }
    }

    function addScanEvent(ev) {
      scanEvents.push(ev);
      scanEventsById[ev.id] = ev;
      if (scanEvents.length > 300) {
        const removed = scanEvents.shift();
        delete scanEventsById[removed.id];
      }
    }

    function renderScanLog() {
      const wrap = document.getElementById("scanLogWrap");
      if (scanEvents.length === 0) {
        wrap.innerHTML = '<div class="empty-hint">Chưa có dữ liệu nào được quét...</div>';
        return;
      }
      let html = "";
      for (let i = scanEvents.length - 1; i >= 0; i--) {
        const ev = scanEvents[i];
        const isMatched = ev.matched && ev.matched.length > 0;
        const matchedTag = isMatched ? '<span class="matched-tag">🎯 KHỚP ' + ev.matched.length + ' MÓN</span>' : '';
        const itemsText = (ev.items || []).map(function (it) {
          let line = escapeHtml(it.name) + " x" + escapeHtml(it.quantity);
          if (it.yen) line += " — 💴 " + escapeHtml(it.yen);
          if (it.ac_coin) line += " — 🪙 " + escapeHtml(it.ac_coin);
          return line;
        }).join("<br>");

        html += '<div class="scan-item' + (isMatched ? " matched" : "") + '">'
          + '<div class="row1"><span class="time">' + fmtTime(ev.receivedAt) + '</span>' + matchedTag + '</div>'
          + '<div class="items">' + itemsText + '</div>'
          + '<div class="jobid">JobID: ' + escapeHtml(ev.jobId) + '</div>'
          + '<div class="mini-actions">'
          +   '<button onclick="copyJobId(\\'' + ev.id + '\\')">📋 Copy JobID</button>'
          +   '<button onclick="copyScript(\\'' + ev.id + '\\')">📋 Copy Script Join</button>'
          + '</div>'
          + '</div>';
      }
      wrap.innerHTML = html;
    }

    function copyText(text, label) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        function () { showToast("✅ Đã copy " + (label || "") + "!"); },
        function () { showToast("❌ Copy thất bại", true); }
      );
    }
    function copyJobId(id) {
      const ev = scanEventsById[id];
      if (ev) copyText(ev.jobId, "JobID");
    }
    function copyScript(id) {
      const ev = scanEventsById[id];
      if (ev) copyText(ev.joinScript, "Script Join");
    }

    // ── Chuông cảnh báo (Web Audio, không cần file mp3) ──
    function startAlarm() {
      if (alarmTimer) return;
      if (isMuted) return; // đang tắt tiếng -> không phát, nhưng banner/queue vẫn giữ nguyên
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      alarmTimer = setInterval(function () {
        try {
          const osc  = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.frequency.value = 880;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.25);
        } catch (e) {}
      }, 700);
    }
    function stopAlarm() {
      if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    }
    function toggleMute() {
      isMuted = !isMuted;
      const btn = document.getElementById("muteBtn");
      if (isMuted) {
        stopAlarm();
        if (btn) { btn.textContent = "🔔 Bật tiếng"; btn.classList.add("active"); }
        showToast("🔇 Đã tắt tiếng chuông (banner vẫn hiện khi có khớp target)");
      } else {
        if (btn) { btn.textContent = "🔇 Tắt tiếng"; btn.classList.remove("active"); }
        // nếu vẫn còn cảnh báo chưa xem thì kêu lại ngay
        if (currentAlert || alertQueue.length > 0) startAlarm();
        showToast("🔔 Đã bật lại tiếng chuông");
      }
    }

    function showAlert(ev) {
      alertQueue.push(ev);
      if (!currentAlert) advanceAlert();
      startAlarm();
    }
    function advanceAlert() {
      currentAlert = alertQueue.shift() || null;
      const banner = document.getElementById("alertBanner");
      if (!currentAlert) {
        banner.style.display = "none";
        stopAlarm();
        return;
      }
      document.getElementById("alertTitle").textContent =
        "🚨 KHỚP TARGET: " + currentAlert.matched.map(function (m) { return m.name; }).join(", ");
      document.getElementById("alertBody").textContent =
        "JobID: " + currentAlert.jobId + (alertQueue.length > 0 ? " — còn " + alertQueue.length + " cảnh báo khác đang chờ" : "");
      banner.style.display = "block";
    }
    function dismissAlert() {
      advanceAlert(); // hiện cảnh báo tiếp theo nếu còn, không thì ẩn banner + tắt chuông
    }

    async function loadDataLog() {
      try {
        const res  = await fetch("/data?key=" + KEY);
        const data = await res.json();
        scanEvents = [];
        scanEventsById = {};
        (data.events || []).forEach(addScanEvent);
        renderScanLog();
      } catch (e) {
        showToast("❌ Lỗi tải dữ liệu quét", true);
      }
    }

    async function clearData() {
      if (!confirm("Xóa toàn bộ dữ liệu quét đã nhận về? (không ảnh hưởng danh sách JobID/target)")) return;
      const res = await fetch("/data/clear", { method: "POST", headers: { "X-Api-Key": KEY } });
      if (res.ok) {
        scanEvents = [];
        scanEventsById = {};
        renderScanLog();
        showToast("✅ Đã xóa dữ liệu quét!");
      } else {
        showToast("❌ Xóa thất bại", true);
      }
    }

    function connectEvents() {
      const status = document.getElementById("connStatus");
      const es = new EventSource("/events?key=" + KEY);
      es.onopen = function () {
        status.textContent = "(đã kết nối)";
        status.style.color = "#27ae60";
      };
      es.onerror = function () {
        status.textContent = "(mất kết nối, đang thử lại...)";
        status.style.color = "#e67e22";
      };
      es.onmessage = function (e) {
        let ev;
        try { ev = JSON.parse(e.data); } catch (err) { return; }
        addScanEvent(ev);
        renderScanLog();
        if (ev.matched && ev.matched.length > 0) showAlert(ev);
      };
    }

    loadDataLog();
    connectEvents();
  </script>
</body>
</html>`);
});

// ─── API cho Lua client ───────────────────────────────────────────────────────

app.get("/claim", apiAuth, (req, res) => {
  const result = getNextValidIndex();
  if (!result) return res.status(503).json({ error: "Danh sách server trống!" });
  console.log(`[CLAIM] [${result.index + 1}/${serverList.length}]: ${result.jobId}`);
  res.json({ jobId: result.jobId, index: result.index + 1, total: serverList.length });
});

app.get("/servers", apiAuth, (req, res) => {
  res.json({ servers: serverList, total: serverList.length, counter: globalCounter });
});

app.post("/servers", apiAuth, (req, res) => {
  const { servers } = req.body;
  if (!Array.isArray(servers) || servers.length === 0) {
    return res.status(400).json({ error: 'Body phải có dạng: { "servers": [...] }' });
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalid   = servers.filter((s) => !uuidRegex.test(s));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `${invalid.length} JobID không đúng UUID`, examples: invalid.slice(0, 3) });
  }
  serverList    = [...new Set(servers)];
  globalCounter = 0;
  skippedSet.clear();
  saveData(serverList, targetItems);
  res.json({ success: true, total: serverList.length });
});

// ─── Quản lý danh sách target (mặt hàng cần theo dõi) ─────────────────────────
app.get("/targets", apiAuth, (req, res) => {
  res.json({ targets: targetItems, total: targetItems.length });
});

app.post("/targets", apiAuth, (req, res) => {
  const { targets } = req.body;
  if (!Array.isArray(targets)) {
    return res.status(400).json({ error: 'Body phải có dạng: { "targets": [...] }' });
  }
  targetItems = [...new Set(targets.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  saveData(serverList, targetItems);
  res.json({ success: true, total: targetItems.length, targets: targetItems });
});

// ─── Nhận dữ liệu quét từ Lua client, filter theo target, gửi Discord + SSE ───
app.post("/scan", apiAuth, (req, res) => {
  const { jobId, placeId, position, items } = req.body;
  if (!jobId || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Body phải có dạng: { jobId, items: [...] }' });
  }

  // Chỉ xét mặt hàng có giá Yên (bỏ qua mặt hàng chỉ bán bằng AC Coin)
  const yenItems = items.filter((it) => it && it.yen && String(it.yen).trim() !== "");

  // Khớp với danh sách target (không phân biệt hoa/thường) — VÀ phải còn hàng
  // (quantity > 0), vì số lượng 0 nghĩa là đã hết hàng, không đáng báo động.
  const matched = targetItems.length === 0
    ? []
    : yenItems.filter((it) =>
        targetItems.includes(String(it.name || "").trim().toLowerCase()) &&
        Number(it.quantity) > 0
      );

  console.log(`[SCAN] jobId=${jobId} items=${items.length} yen=${yenItems.length} matched=${matched.length}`);

  // Lưu vào log (dashboard) + đẩy realtime qua SSE, dù có khớp target hay không —
  // để bên "Dữ liệu quét nhận về" thấy được toàn bộ hoạt động, còn chuông báo
  // chỉ kêu khi matched.length > 0 (xử lý ở phía client dashboard).
  const scanEvent = {
    id:         Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    receivedAt: new Date().toISOString(),
    jobId,
    placeId:    placeId || "",
    position:   position || null,
    items,
    matched,
    joinLink:   buildFishstrapLink(placeId, jobId),
    joinScript: buildJoinScript(jobId),
  };
  scanLog.push(scanEvent);
  if (scanLog.length > SCAN_LOG_MAX) scanLog.shift();
  broadcastSSE(scanEvent);

  if (matched.length > 0) {
    const payload = buildMerchantPayload(matched, jobId, placeId, position);
    queueDiscordMessage(payload);
  }

  res.json({ success: true, matched: matched.length, items: matched.map((m) => m.name) });
});

// ─── SSE stream cho dashboard (key truyền qua query vì EventSource không set header) ──
app.get("/events", apiAuth, (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ─── Dữ liệu quét đã nhận (cho dashboard load lại khi mở trang / F5) ─────────
app.get("/data", apiAuth, (req, res) => {
  res.json({ events: scanLog, total: scanLog.length });
});

app.post("/data/clear", apiAuth, (req, res) => {
  const count = scanLog.length;
  scanLog = [];
  console.log(`🧹 [CLEAR] Đã dọn ${count} bản ghi scan log`);
  res.json({ success: true, cleared: count });
});

app.post("/skip/:jobId", apiAuth, (req, res) => {
  skippedSet.add(req.params.jobId);
  res.json({ success: true, skipped: req.params.jobId, skipCount: skippedSet.size, total: serverList.length });
});

app.get("/status", apiAuth, (req, res) => {
  res.json({
    total:       serverList.length,
    counter:     globalCounter,
    skipCount:   skippedSet.size,
    activeCount: serverList.filter((id) => !skippedSet.has(id)).length,
  });
});

app.post("/reset", apiAuth, (req, res) => {
  globalCounter = 0;
  skippedSet.clear();
  res.json({ success: true });
});

function renderLesterDashboard(key) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lester Hub Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 32px 16px; }
  .container { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; color: #fff; margin-bottom: 6px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 24px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; padding: 14px; text-align: center; }
  .stat .num { font-size: 24px; font-weight: 700; color: #e91e8c; }
  .stat .lbl { font-size: 11px; color: #666; margin-top: 4px; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 22px; margin-bottom: 18px; }
  .card h2 { font-size: 15px; color: #fff; margin-bottom: 6px; }
  .card p { font-size: 12px; color: #666; margin-bottom: 14px; }
  textarea, input[type=text] {
    width: 100%; background: #111; border: 1px solid #333; border-radius: 8px;
    color: #e0e0e0; font-size: 13px; font-family: monospace; padding: 10px 12px; outline: none; resize: vertical;
  }
  textarea { height: 120px; }
  textarea:focus, input[type=text]:focus { border-color: #e91e8c; }
  .actions { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  button { padding: 9px 18px; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn-primary { background: #e91e8c; color: #fff; }
  .btn-primary:hover { background: #c8177a; }
  .btn-danger { background: #c0392b; color: #fff; }
  .btn-danger:hover { background: #a93226; }
  .btn-secondary { background: #2a2a2a; color: #aaa; border: 1px solid #444; }
  .btn-secondary:hover { background: #333; }
  .toast { display: none; position: fixed; bottom: 24px; right: 24px; background: #27ae60; color: #fff;
    padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 999; }
  .toast.err { background: #c0392b; }
  .current-list { font-family: monospace; font-size: 12px; color: #888; background: #111; border: 1px solid #222;
    border-radius: 8px; padding: 12px; max-height: 140px; overflow-y: auto; line-height: 1.8; word-break: break-all; }
  .alert-banner { display: none; position: sticky; top: 0; z-index: 1000; background: #c0392b; color: #fff;
    padding: 14px 20px; margin: -32px -16px 20px -16px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); animation: pulse 1s infinite; }
  .alert-banner .title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
  .alert-banner .body { font-size: 13px; opacity: 0.95; margin-bottom: 10px; }
  .alert-banner .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 0; }
  .alert-banner button { padding: 8px 16px; border: none; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .alert-banner .btn-view { background: #fff; color: #c0392b; }
  .alert-banner .btn-copy { background: rgba(255,255,255,0.2); color: #fff; }
  .alert-banner .btn-mute { background: rgba(255,255,255,0.2); color: #fff; }
  .alert-banner .btn-mute.active { background: #222; color: #ffd166; }
  @keyframes pulse { 0%, 100% { background: #c0392b; } 50% { background: #e74c3c; } }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #888; font-weight: 600; padding: 8px; border-bottom: 1px solid #2a2a2a; font-size: 11px; }
  td { padding: 8px; border-bottom: 1px solid #1e1e1e; vertical-align: top; }
  tr.matched td { background: #0f1a12; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 10px; font-weight: 700; }
  .tag-player { background: #c0392b; color: #fff; }
  .tag-gang { background: #8e44ad; color: #fff; }
  .tag-boss-super { background: #e74c3c; color: #fff; }
  .tag-boss-normal { background: #d35400; color: #fff; }
  .jobid-cell { font-family: monospace; color: #4f8ef7; word-break: break-all; max-width: 200px; }
  .mini-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .mini-actions button { padding: 4px 8px; font-size: 10px; border: 1px solid #333; background: #1a1a1a; color: #aaa; border-radius: 6px; }
  .mini-actions button:hover { background: #2a2a2a; }
  .empty-hint { color: #555; font-size: 12px; text-align: center; padding: 20px; }
  .search-hint { font-size: 11px; color: #e91e8c; margin-top: 6px; }
  .back-link { display: inline-block; margin-bottom: 16px; color: #666; font-size: 12px; text-decoration: none; }
  .back-link:hover { color: #aaa; }
</style>
</head>
<body>
  <div class="alert-banner" id="alertBanner">
    <div class="title" id="alertTitle">🚨 PHÁT HIỆN TARGET!</div>
    <div class="body" id="alertBody"></div>
    <div class="actions">
      <button class="btn-view" onclick="dismissAlert()">👁️ Xem (tắt chuông)</button>
      <button class="btn-mute" id="muteBtn" onclick="toggleMute()">🔇 Tắt tiếng</button>
      <button class="btn-copy" onclick="copyText(currentAlert && currentAlert.jobId)">📋 Copy JobID</button>
      <button class="btn-copy" onclick="copyText(currentAlert && currentAlert.joinScript)">📋 Copy Script Join</button>
      <button class="btn-copy" onclick="clearData()">🧹 Clear Data</button>
    </div>
  </div>
  <div class="container">
    <a class="back-link" href="/dashboard?key=${key}">← Về Dashboard Merchant (hệ thống cũ)</a>
    <h1>🕵️ Lester Hub Dashboard</h1>
    <div class="sub">Player/Gang Finder + Rift/Boss Timer — hệ thống độc lập, không ảnh hưởng Merchant Scanner</div>

    <div class="stats">
      <div class="stat"><div class="num" id="stat-servers">0</div><div class="lbl">Server đã ghi nhận</div></div>
      <div class="stat"><div class="num" id="stat-targets">0</div><div class="lbl">Target player</div></div>
      <div class="stat"><div class="num" id="stat-matched" style="color:#e74c3c">0</div><div class="lbl">Đang khớp target</div></div>
    </div>

    <div class="card">
      <h2>🎯 Target Player cần theo dõi</h2>
      <p>Mỗi dòng 1 username (không phân biệt hoa/thường). Khi quét thấy player này trong server, chuông sẽ kêu liên tục tới khi bấm "Xem" hoặc "Clear Data".</p>
      <textarea id="targetInput" placeholder="Mỗi dòng 1 username&#10;Ví dụ:&#10;Ro_Ghoul211&#10;BigTuum"></textarea>
      <div class="actions">
        <button class="btn-primary" onclick="saveTargets()">💾 Lưu target</button>
        <button class="btn-secondary" onclick="loadTargetsView()">📋 Xem hiện tại</button>
      </div>
      <div class="current-list" id="targetList" style="margin-top:12px;display:none"></div>
    </div>

    <div class="card">
      <h2>➡️ Ép bot nhảy tới JobID cụ thể</h2>
      <p>Bot merchant (game.lua) sẽ kiểm tra hàng đợi này TRƯỚC MỖI lần hop bình thường — có jobId ở đây thì nhảy thẳng tới đó thay vì tự claim ngẫu nhiên. Dùng khi thấy 1 server ngon trong bảng dưới (rift sắp ra, có target...) và muốn điều bot tới ngay.</p>
      <input type="text" id="joinInput" placeholder="Dán JobID cần join...">
      <div class="actions">
        <button class="btn-primary" onclick="queueJoin()">📤 Gửi lệnh</button>
      </div>
    </div>

    <div class="card">
      <h2>📡 Dữ liệu quét <span id="connStatus" style="font-size:11px;color:#666">(đang kết nối...)</span></h2>
      <p>Quét lại cùng JobID sẽ tự động cập nhật bản ghi cũ. Gõ <strong style="color:#e91e8c">/rift</strong> hoặc <strong style="color:#e91e8c">/boss</strong> vào ô tìm kiếm để lọc server sắp/vừa có Rift hoặc Boss theo chu kỳ thời gian (±10 phút quanh mốc spawn); gõ tên boss (VD: Zun, Yakuza Kyodai...) để lọc theo boss đã quét thấy thực tế.</p>
      <input type="text" id="searchInput" placeholder="Tìm theo JobID / Gang / tên Boss, hoặc gõ /rift, /boss..." oninput="onSearchInput()">
      <div class="search-hint" id="searchHint" style="display:none"></div>
      <div class="actions" style="margin-top:14px">
        <button class="btn-danger" onclick="clearData()">🧹 Clear Data</button>
        <button class="btn-secondary" onclick="loadDataLog()">🔄 Tải lại</button>
      </div>
      <div style="overflow-x:auto; margin-top:14px;">
        <table>
          <thead>
            <tr>
              <th>Trạng thái</th>
              <th>JobID</th>
              <th>Gang chiếm server</th>
              <th>Thời gian server (real-time)</th>
              <th>Cập nhật</th>
              <th>Hành động</th>
            </tr>
          </thead>
          <tbody id="dataBody"></tbody>
        </table>
        <div class="empty-hint" id="emptyHint">Chưa có dữ liệu nào được quét...</div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const KEY = "${key}";
    let servers = {};        // jobId -> server object (cache tại client)
    let searchMode = null;   // null | 'rift' | 'boss'
    let alertQueue = [];
    let currentAlert = null;
    let audioCtx = null;
    let alarmTimer = null;
    let isMuted = false;

    function showToast(msg, isErr) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.className = "toast" + (isErr ? " err" : "");
      t.style.display = "block";
      setTimeout(() => t.style.display = "none", 3000);
    }
    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    }
    function copyText(text, label) {
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        () => showToast("✅ Đã copy " + (label || "") + "!"),
        () => showToast("❌ Copy thất bại", true)
      );
    }

    // ── Target players ──
    async function saveTargets() {
      const raw = document.getElementById("targetInput").value.trim();
      const targets = raw.split("\\n").map(s => s.trim()).filter(Boolean);
      const res = await fetch("/lester/targets", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
        body: JSON.stringify({ targets })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("✅ Đã lưu " + data.total + " target player!");
        document.getElementById("stat-targets").textContent = data.total;
        document.getElementById("targetInput").value = "";
      } else showToast("❌ " + (data.error || "Lỗi"), true);
    }
    async function loadTargetsView() {
      const res = await fetch("/lester/targets?key=" + KEY);
      const data = await res.json();
      const el = document.getElementById("targetList");
      el.style.display = "block";
      el.innerHTML = data.targets.map((n,i) => \`<span style="color:#555">\${i+1}.</span> \${escapeHtml(n)}\`).join("<br>") || "<em>Chưa có target</em>";
      document.getElementById("stat-targets").textContent = data.total;
    }

    // ── Join thủ công ──
    async function queueJoin() {
      const jobId = document.getElementById("joinInput").value.trim();
      if (!jobId) return showToast("❌ Chưa nhập JobID!", true);
      const res = await fetch("/lester/join", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": KEY },
        body: JSON.stringify({ jobId })
      });
      if (res.ok) { showToast("✅ Đã gửi lệnh join!"); document.getElementById("joinInput").value = ""; }
      else showToast("❌ Gửi thất bại", true);
    }

    // ── Data log + realtime render ──
    function fmtRealtime(server) {
      const base = Number(server.ageMinutes) || 0;
      const reportedAt = new Date(server.reportedAt).getTime();
      const elapsedMin = Math.max(0, (Date.now() - reportedAt) / 60000);
      const total = Math.round(base + elapsedMin);
      const h = Math.floor(total / 60), m = total % 60;
      return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + ":00";
    }

    function renderTable(list) {
      const body = document.getElementById("dataBody");
      const emptyHint = document.getElementById("emptyHint");
      if (!list || list.length === 0) {
        body.innerHTML = "";
        emptyHint.style.display = "block";
        return;
      }
      emptyHint.style.display = "none";
      let matchedCount = 0;
      body.innerHTML = list.map(s => {
        const players = Array.isArray(s.matchedPlayers) ? s.matchedPlayers : [];
        const bosses  = Array.isArray(s.bosses) ? s.bosses : [];
        const isMatched = !!(players.length || s.matchedGang || bosses.length);
        if (isMatched) matchedCount++;
        let tags = "";
        if (players.length) tags += '<span class="tag tag-player">👤 ' + players.map(escapeHtml).join(", ") + '</span> ';
        if (s.matchedGang)   tags += '<span class="tag tag-gang">🏴 ' + escapeHtml(s.matchedGang) + '</span> ';
        if (bosses.length) {
          tags += bosses.map(b => {
            const isSuper = b.type === "super";
            return '<span class="tag ' + (isSuper ? "tag-boss-super" : "tag-boss-normal") + '">'
              + (isSuper ? "👹 " : "☠️ ") + escapeHtml(b.name) + '</span>';
          }).join(" ");
        }
        if (!tags) tags = '<span style="color:#555">—</span>';
        const timeDisplay = s.currentAgeStr ? s.currentAgeStr : fmtRealtime(s);
        return '<tr class="' + (isMatched ? "matched" : "") + '" data-jobid="' + escapeHtml(s.jobId) + '">'
          + '<td>' + tags + '</td>'
          + '<td class="jobid-cell">' + escapeHtml(s.jobId) + '</td>'
          + '<td>' + escapeHtml(s.gang || "—") + '</td>'
          + '<td class="realtime-cell" data-base="' + (Number(s.ageMinutes)||0) + '" data-reported="' + s.reportedAt + '">' + timeDisplay + '</td>'
          + '<td>' + new Date(s.updatedAt || s.reportedAt).toLocaleTimeString("vi-VN") + '</td>'
          + '<td class="mini-actions">'
          +   '<button onclick="copyText(\\'' + s.jobId + '\\',\\'JobID\\')">📋 JobID</button>'
          +   '<button onclick="copyText(' + JSON.stringify(s.joinScript || "") + ',\\'Script Join\\')">📋 Script</button>'
          + '</td></tr>';
      }).join("");
      document.getElementById("stat-matched").textContent = matchedCount;
    }

    // Tick realtime mỗi giây (không cần gọi lại server, chỉ tính lại từ base+reportedAt)
    setInterval(() => {
      if (searchMode) return; // đang ở chế độ search rift/boss thì để nguyên số liệu server trả
      document.querySelectorAll(".realtime-cell").forEach(cell => {
        const base = Number(cell.getAttribute("data-base")) || 0;
        const reportedAt = new Date(cell.getAttribute("data-reported")).getTime();
        const elapsedMin = Math.max(0, (Date.now() - reportedAt) / 60000);
        const total = Math.round(base + elapsedMin);
        const h = Math.floor(total/60), m = total % 60;
        cell.textContent = String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + ":00";
      });
    }, 1000);

    async function loadDataLog() {
      try {
        const res = await fetch("/lester/data?key=" + KEY);
        const data = await res.json();
        servers = {};
        (data.servers || []).forEach(s => servers[s.jobId] = s);
        document.getElementById("stat-servers").textContent = data.total;
        applyFilter();
      } catch (e) {
        showToast("❌ Lỗi tải dữ liệu", true);
      }
    }

    async function clearData() {
      if (!confirm("Xóa toàn bộ dữ liệu quét đã nhận về? (không ảnh hưởng target/hàng đợi join)")) return;
      const res = await fetch("/lester/data/clear", { method: "POST", headers: { "X-Api-Key": KEY } });
      if (res.ok) {
        servers = {};
        renderTable([]);
        document.getElementById("stat-servers").textContent = 0;
        document.getElementById("stat-matched").textContent = 0;
        alertQueue = [];
        advanceAlert();
        showToast("✅ Đã xóa dữ liệu quét!");
      } else showToast("❌ Xóa thất bại", true);
    }

    function applyFilter() {
      const list = Object.values(servers).sort((a,b) => new Date(b.updatedAt||b.reportedAt) - new Date(a.updatedAt||a.reportedAt));
      const q = document.getElementById("searchInput").value.trim().toLowerCase();
      if (!q) { renderTable(list); return; }
      const filtered = list.filter(s =>
        (s.jobId || "").toLowerCase().includes(q) ||
        (s.gang || "").toLowerCase().includes(q) ||
        (Array.isArray(s.bosses) && s.bosses.some(b => (b.name || "").toLowerCase().includes(q))) ||
        (Array.isArray(s.matchedPlayers) && s.matchedPlayers.some(p => (p || "").toLowerCase().includes(q)))
      );
      renderTable(filtered);
    }

    let searchDebounce = null;
    function onSearchInput() {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(async () => {
        const q = document.getElementById("searchInput").value.trim().toLowerCase();
        const hint = document.getElementById("searchHint");
        if (q === "/rift" || q === "/boss") {
          searchMode = q === "/rift" ? "rift" : "boss";
          const res = await fetch("/lester/search?type=" + searchMode + "&key=" + KEY);
          const data = await res.json();
          hint.style.display = "block";
          hint.textContent = "🔍 Đang lọc server có " + (searchMode === "rift" ? "Rift (chu kỳ 90 phút)" : "Boss (chu kỳ 120 phút)") + " sắp/vừa xuất hiện — tìm thấy " + data.total + " server.";
          renderTable(data.matches.map(s => ({ ...s, currentAgeStr: s.currentAgeStr })));
        } else {
          searchMode = null;
          hint.style.display = "none";
          applyFilter();
        }
      }, 150);
    }

    // ── Chuông cảnh báo ──
    function startAlarm() {
      if (alarmTimer || isMuted) return;
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      alarmTimer = setInterval(() => {
        try {
          const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
          osc.frequency.value = 1046;
          osc.connect(gain); gain.connect(audioCtx.destination);
          gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
          osc.start(); osc.stop(audioCtx.currentTime + 0.25);
        } catch (e) {}
      }, 700);
    }
    function stopAlarm() { if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; } }
    function toggleMute() {
      isMuted = !isMuted;
      const btn = document.getElementById("muteBtn");
      if (isMuted) { stopAlarm(); btn.textContent = "🔔 Bật tiếng"; btn.classList.add("active"); showToast("🔇 Đã tắt tiếng chuông"); }
      else { btn.textContent = "🔇 Tắt tiếng"; btn.classList.remove("active"); if (currentAlert || alertQueue.length) startAlarm(); showToast("🔔 Đã bật lại tiếng chuông"); }
    }
    function showAlert(server, findType, label) {
      alertQueue.push({ server, findType, label });
      if (!currentAlert) advanceAlert();
      startAlarm();
    }
    function advanceAlert() {
      const next = alertQueue.shift();
      currentAlert = next ? next.server : null;
      const banner = document.getElementById("alertBanner");
      if (!currentAlert) { banner.style.display = "none"; stopAlarm(); return; }
      // Nhãn đã được server gộp sẵn (VD nhiều player: "👤 A, B" — nhiều boss:
      // "☠️ Boss1, 👹 Boss2") -> chỉ 1 cảnh báo gọn dù khớp nhiều target cùng lúc.
      const label = next.label || "—";
      document.getElementById("alertTitle").textContent = "🚨 PHÁT HIỆN TARGET: " + label;
      document.getElementById("alertBody").textContent = "JobID: " + currentAlert.jobId + (alertQueue.length ? " — còn " + alertQueue.length + " cảnh báo khác đang chờ" : "");
      banner.style.display = "block";
    }
    function dismissAlert() { advanceAlert(); }

    function connectEvents() {
      const status = document.getElementById("connStatus");
      const es = new EventSource("/lester/events?key=" + KEY);
      es.onopen = () => { status.textContent = "(đã kết nối)"; status.style.color = "#27ae60"; };
      es.onerror = () => { status.textContent = "(mất kết nối, đang thử lại...)"; status.style.color = "#e67e22"; };
      es.onmessage = (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch (err) { return; }
        if (!ev.server) return;
        servers[ev.server.jobId] = ev.server;
        document.getElementById("stat-servers").textContent = Object.keys(servers).length;
        if (!searchMode) applyFilter();
        if (ev.type === "find") showAlert(ev.server, ev.findType, ev.label);
      };
    }

    loadTargetsView();
    loadDataLog();
    connectEvents();
  </script>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════════════════
// 🕵️ LESTER HUB — API routes (namespace /lester/... — tách biệt hoàn toàn)
// ════════════════════════════════════════════════════════════════════════════

// Dashboard riêng — dùng chung mật khẩu/API_KEY với hệ thống cũ nhưng là trang khác
app.get("/lester-dashboard", (req, res) => {
  const key = req.query.key;
  if (key !== API_KEY) return res.redirect("/?err=1");
  res.send(renderLesterDashboard(key));
});

// ─── Target player cần theo dõi ──────────────────────────────────────────────
app.get("/lester/targets", apiAuth, (req, res) => {
  res.json({ targets: lesterTargetPlayers, total: lesterTargetPlayers.length });
});

app.post("/lester/targets", apiAuth, (req, res) => {
  const { targets } = req.body;
  if (!Array.isArray(targets)) {
    return res.status(400).json({ error: 'Body phải có dạng: { "targets": [...] }' });
  }
  lesterTargetPlayers = [...new Set(targets.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  saveLesterData();
  res.json({ success: true, total: lesterTargetPlayers.length, targets: lesterTargetPlayers });
});

// ─── Hàng đợi "ép nhảy tới JobID cụ thể" ─────────────────────────────────────
// game.lua (bot merchant) sẽ kiểm tra hàng đợi này TRƯỚC MỖI lần hop bình
// thường (executeHop). Nếu có jobId trong hàng đợi -> nhảy thẳng tới đó thay
// vì gọi /claim như thường lệ. Dùng khi bạn thấy 1 server ngon (rift sắp ra,
// có target...) trong bảng dữ liệu và muốn điều bot merchant tới đó ngay.
app.get("/lester/join", apiAuth, (req, res) => {
  const jobId = lesterJoinQueue.shift();
  res.type("text/plain").send(jobId || "NONE");
});

app.post("/lester/join", apiAuth, (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: "Thiếu jobId" });
  lesterJoinQueue.push(String(jobId).trim());
  res.json({ success: true, queued: jobId, queueLength: lesterJoinQueue.length });
});

// ─── Báo cáo dữ liệu quét mỗi server (jobId, tuổi server, gang đang chiếm) ───
// Quét lại cùng 1 jobId sẽ CẬP NHẬT record cũ (upsert theo jobId) chứ không tạo bản ghi mới.
app.post("/lester/report", apiAuth, (req, res) => {
  const { jobId, ageMinutes, gang, bosses } = req.body;
  if (!jobId || typeof ageMinutes !== "number") {
    return res.status(400).json({ error: 'Body phải có dạng: { jobId, ageMinutes, gang?, bosses? }' });
  }
  const now = new Date().toISOString();
  const existing = lesterServers[jobId] || {};
  // bosses: [{ name, type }, ...] — có thể nhiều boss cùng lúc trong 1 jobId.
  const bossList = Array.isArray(bosses)
    ? bosses.filter((b) => b && b.name).map((b) => ({ name: String(b.name), type: b.type || null }))
    : (existing.bosses || []);
  lesterServers[jobId] = {
    ...existing,
    jobId,
    ageMinutes,
    reportedAt: now,
    updatedAt: now,
    gang: (gang !== undefined && gang !== null && gang !== "") ? gang : (existing.gang || null),
    matchedPlayers: existing.matchedPlayers || [],
    matchedGang: existing.matchedGang || null,
    bosses: bossList,
    joinScript: buildJoinScript(jobId),
  };
  console.log(`[LESTER REPORT] jobId=${jobId} age=${lesterFmtMinutes(ageMinutes)} gang=${gang || "-"} bosses=${bossList.map((b) => b.name).join(", ") || "-"}`);
  lesterBroadcast({ type: "report", server: lesterServers[jobId] });
  res.json({ success: true });
});

// ─── Báo cáo khớp target (player, gang, hoặc boss) -> dashboard rung chuông ──
// Gộp TOÀN BỘ player/boss khớp trong 1 jobId thành đúng 1 record + 1 dòng
// cảnh báo gọn (label), thay vì bắn lẻ từng cái khi có nhiều target cùng lúc.
//   type=player -> body: { jobId, players: ["a","b",...] }
//   type=gang   -> body: { jobId, name: "Tên gang" }
//   type=boss   -> body: { jobId, bosses: [{ name, type }, ...] }
app.post("/lester/report-find", apiAuth, (req, res) => {
  const { type, jobId, players, name, bosses } = req.body;
  if (!jobId || !type) {
    return res.status(400).json({ error: 'Body phải có dạng: { type: "player"|"gang"|"boss", jobId, players?|name?|bosses? }' });
  }
  const now = new Date().toISOString();
  const existing = lesterServers[jobId] || {
    jobId, ageMinutes: 0, reportedAt: now,
    matchedPlayers: [], matchedGang: null, bosses: [],
    joinScript: buildJoinScript(jobId),
  };

  let label = "";
  if (type === "player" && Array.isArray(players) && players.length) {
    existing.matchedPlayers = [...new Set(players.map(String))];
    label = "👤 " + existing.matchedPlayers.join(", ");
  } else if (type === "gang" && name) {
    existing.matchedGang = name;
    existing.gang = name;
    label = "🏴 " + name;
  } else if (type === "boss" && Array.isArray(bosses) && bosses.length) {
    existing.bosses = bosses.filter((b) => b && b.name).map((b) => ({ name: String(b.name), type: b.type || null }));
    label = existing.bosses.map((b) => (b.type === "super" ? "👹 " : "☠️ ") + b.name).join(", ");
  } else {
    return res.status(400).json({ error: "Thiếu dữ liệu khớp phù hợp với type" });
  }

  existing.updatedAt = now;
  lesterServers[jobId] = existing;
  console.log(`[LESTER FIND] ${type} @ ${jobId}: ${label}`);
  lesterBroadcast({ type: "find", findType: type, label, server: existing });
  res.json({ success: true });
});

// ─── SSE stream riêng cho Lester dashboard ───────────────────────────────────
app.get("/lester/events", apiAuth, (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  lesterSseClients.add(res);
  req.on("close", () => lesterSseClients.delete(res));
});

// ─── Toàn bộ dữ liệu hiện có (cho dashboard load lại khi mở trang / F5) ─────
app.get("/lester/data", apiAuth, (req, res) => {
  const list = Object.values(lesterServers).sort((a, b) =>
    new Date(b.updatedAt || b.reportedAt) - new Date(a.updatedAt || a.reportedAt)
  );
  res.json({ servers: list, total: list.length });
});

app.post("/lester/data/clear", apiAuth, (req, res) => {
  const count = Object.keys(lesterServers).length;
  lesterServers = {};
  console.log(`🧹 [LESTER CLEAR] Đã dọn ${count} bản ghi`);
  res.json({ success: true, cleared: count });
});

// ─── Tìm server có Rift/Boss sắp/vừa xuất hiện ──────────────────────────────
// type=rift  -> chu kỳ 90 phút  (1h30, 3h00, 4h30, 6h00...)
// type=boss  -> chu kỳ 120 phút (2h00, 4h00, 6h00...)
// Trả về các server đang trong khoảng ±10 phút quanh mốc spawn, tính real-time
// dựa trên lần report gần nhất (không cần Lua báo lại liên tục).
app.get("/lester/search", apiAuth, (req, res) => {
  const type = String(req.query.type || "").toLowerCase();
  const period = type === "rift" ? 90 : type === "boss" ? 120 : null;
  if (!period) return res.status(400).json({ error: "type phải là 'rift' hoặc 'boss'" });

  const matches = Object.values(lesterServers)
    .map((s) => {
      const cur = lesterCurrentMinutes(s);
      return { ...s, currentMinutes: cur, currentAgeStr: lesterFmtMinutes(cur) };
    })
    .filter((s) => lesterInWindow(s.currentMinutes, period, 10))
    .sort((a, b) => {
      const remA = Math.min(a.currentMinutes % period, period - (a.currentMinutes % period));
      const remB = Math.min(b.currentMinutes % period, period - (b.currentMinutes % period));
      return remA - remB;
    });

  res.json({ type, period, matches, total: matches.length });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server chạy trên port ${PORT}`);
  console.log(`📋 Tổng JobID: ${serverList.length}`);
  console.log(`🔑 API Key: ${API_KEY}`);
});
