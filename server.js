require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songs (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      user_name TEXT NOT NULL,
      telegram_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('🗄️ PostgreSQL: Database ready');
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://gems-music-game.onrender.com';

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

function isAdmin(telegramId) {
  if (telegramId === null || telegramId === undefined) {
    return false;
  }

  return ADMIN_IDS.has(String(telegramId));
}

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    return {
      valid: false,
      message: 'Thiếu Telegram initData hoặc BOT_TOKEN'
    };
  }

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');

    if (!receivedHash) {
      return {
        valid: false,
        message: 'Không có hash'
      };
    }

    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const calculated = Buffer.from(calculatedHash, 'hex');
    const received = Buffer.from(receivedHash, 'hex');

    if (calculated.length !== received.length || !crypto.timingSafeEqual(calculated, received)) {
      return {
        valid: false,
        message: 'Chữ ký Telegram không hợp lệ'
      };
    }

    const authDate = Number(params.get('auth_date'));

    if (!authDate) {
      return {
        valid: false,
        message: 'Thiếu auth_date'
      };
    }

    const maxAge = 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);

    if (now - authDate > maxAge) {
      return {
        valid: false,
        message: 'Telegram initData đã hết hạn'
      };
    }

    const userRaw = params.get('user');

    if (!userRaw) {
      return {
        valid: false,
        message: 'Không có thông tin user'
      };
    }

    const user = JSON.parse(userRaw);

    if (!user.id) {
      return {
        valid: false,
        message: 'Không xác định được Telegram user ID'
      };
    }

    return {
      valid: true,
      user
    };

  } catch (error) {
    console.error('Lỗi xác thực Telegram initData:', error);

    return {
      valid: false,
      message: 'initData không hợp lệ'
    };
  }
}

let isFormOpen = true;
let songs = [];
let lastWinner = null;

async function loadSongsFromDatabase() {
  const result = await pool.query(`
    SELECT
      id,
      url,
      user_name AS user,
      telegram_id AS "telegramId",
      created_at
    FROM songs
    ORDER BY id ASC
  `);

  songs = result.rows;

  console.log(`🗄️ Đã tải ${songs.length} bài hát từ PostgreSQL`);
}

function broadcastState() {
  io.emit('stateUpdate', { isFormOpen, songs, lastWinner });
}

async function performSpin() {
  if (lastWinner) {
  await pool.query(
      'DELETE FROM songs WHERE id = $1',
      [lastWinner.id]
    );

    songs = songs.filter(song => song.id !== lastWinner.id);

    lastWinner = null;
  }

  if (songs.length === 0) {
    broadcastState();
    return { success: false, message: 'Danh sách bài hát đã hết!' };
  }

  const selectedIndex = Math.floor(Math.random() * songs.length);
  const winner = songs[selectedIndex];
  lastWinner = winner;

  broadcastState();
  io.emit('triggerSpin', { selectedIndex, winner });
  return { success: true, winner };
}

  // --- CÁC LỆNH BOT TELEGRAM ---
  if (bot) {
  const sendWebAppButton = (ctx) => {
    const miniAppUrl = 'https://gems-music-game.onrender.com';

    ctx.reply(
      '🎵 Bấm vào đây để gửi nhạc',
      Markup.inlineKeyboard([
        [
          Markup.button.webApp(
            '🎡 Mở Vòng Quay Nhạc',
            miniAppUrl
          )
        ]
      ])
    );
  };

  // Nhận lệnh /start và /musicgems
  bot.command(['start', 'musicgems'], sendWebAppButton);

  bot.command('spin', async (ctx) => {
    const result = await performSpin();
    if (!result.success) {
      ctx.reply(`⚠️ ${result.message}`);
    } else {
      ctx.reply(`🎡 Đã quay! Bài trúng thưởng: ${result.winner.user} - ${result.winner.url}`);
    }
  });

  bot.command('toggle', (ctx) => {
    isFormOpen = !isFormOpen;
    broadcastState();
    ctx.reply(`📢 Trạng thái form: ${isFormOpen ? '🟢 Đang MỞ' : '🔴 Đã ĐÓNG'}`);
  });

  bot.command('reset', async (ctx) => {
  await pool.query('DELETE FROM songs');

  songs = [];
  lastWinner = null;

  broadcastState();

  ctx.reply('🧹 Đã xóa sạch danh sách bài hát!');
});

  bot.command('list', (ctx) => {
    if (songs.length === 0) {
      return ctx.reply('📋 Danh sách bài hát hiện đang trống.');
    }
    const listStr = songs.map((s, i) => `${i + 1}. ${s.user}: ${s.url}`).join('\n');
    ctx.reply(`📋 **Danh sách bài hát (${songs.length}):**\n\n${listStr}`);
  });

  // Tự động đăng ký Menu lệnh
  bot.telegram.setMyCommands([
    { command: 'musicgems', description: 'Mở Vòng Quay Nhạc' },
    { command: 'spin', description: 'Quay ngẫu nhiên bài hát' },
    { command: 'toggle', description: 'Bật/Tắt form gửi bài' },
    { command: 'list', description: 'Xem danh sách bài hát' },
    { command: 'reset', description: 'Xóa toàn bộ danh sách' }
  ]).catch(err => console.error('Lỗi thiết lập menu lệnh:', err));

  bot.telegram.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: '🎵 Mở Game Nhạc',
      web_app: { url: WEBAPP_URL }
    }
  }).then(() => console.log('📱 Menu Telegram đã trỏ tới Mini App:', WEBAPP_URL))
    .catch(err => console.error('Lỗi thiết lập Menu Mini App:', err));

  bot.launch()
    .then(() => console.log('🤖 Bot Telegram đã khởi chạy thành công!'))
    .catch(err => console.error('Lỗi khởi chạy Bot:', err));
  }
// --- API HTTP & SOCKET.IO ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  socket.emit('stateUpdate', {
    isFormOpen,
    songs,
    lastWinner
  });

  socket.on('authenticate', (payload = {}) => {
    const initData = payload.initData || '';
    console.log(`🔑 Authenticate received: socket=${socket.id}, initDataLength=${initData.length}`);

    const auth = validateTelegramInitData(initData);

    if (!auth.valid) {
      console.log('❌ Telegram authentication failed:', auth.message);

      socket.emit('adminStatus', {
        isAdmin: false,
        authenticated: false,
        message: auth.message
      });

      return;
    }

    const telegramId = String(auth.user.id);
    const admin = isAdmin(telegramId);

    console.log(`🔐 Telegram ID: ${telegramId} | Admin: ${admin}`);

    socket.emit('adminStatus', {
      isAdmin: admin,
      authenticated: true,
      telegramId
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Socket disconnected: ${socket.id} | ${reason}`);
  });
});

function requireTelegramAdmin(req, res) {
  const initData = req.body?.initData || '';
  const auth = validateTelegramInitData(initData);

  if (!auth.valid) {
    return {
      ok: false,
      response: res.status(401).json({
        success: false,
        message: `Xác thực Telegram thất bại: ${auth.message}`
      })
    };
  }

  const telegramId = String(auth.user.id);
  if (!isAdmin(telegramId)) {
    return {
      ok: false,
      response: res.status(403).json({
        success: false,
        message: 'Bạn không có quyền Admin.'
      })
    };
  }

  return { ok: true, user: auth.user };
}

app.post('/api/submit', async (req, res) => {
  if (!isFormOpen) {
    return res.json({
      success: false,
      message: 'Form đã đóng, không thể gửi bài!'
    });
  }
  

  const { url, initData } = req.body;

  if (!url) {
    return res.json({
      success: false,
      message: 'Vui lòng nhập link bài hát!'
    });
  }

  // Xác thực người dùng bằng dữ liệu có chữ ký của Telegram
  const auth = validateTelegramInitData(initData);

  if (!auth.valid) {
    return res.status(401).json({
      success: false,
      message: 'Xác thực Telegram thất bại!'
    });
  }

  const telegramUser = auth.user;

  // Tạo tên hiển thị từ dữ liệu Telegram đã xác thực
  const userName =
    telegramUser.username
      ? `@${telegramUser.username}`
      : [telegramUser.first_name, telegramUser.last_name]
          .filter(Boolean)
          .join(' ') || 'Người dùng';

  const result = await pool.query(
  `
    INSERT INTO songs (url, user_name, telegram_id)
    VALUES ($1, $2, $3)
    RETURNING
      id,
      url,
      user_name AS user,
      telegram_id AS "telegramId",
      created_at
  `,
  [
    url,
    userName,
    String(telegramUser.id)
  ]
);

songs.push(result.rows[0]);

broadcastState();

res.json({ success: true });

});

app.post('/api/spin', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const result = await performSpin();
  res.json(result);
});

app.post('/api/toggle-form', (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  isFormOpen = !isFormOpen;
  broadcastState();
  res.json({ success: true, isFormOpen });
});

app.post('/api/reset', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

await pool.query('DELETE FROM songs');

songs = [];
lastWinner = null;

broadcastState();

res.json({ success: true });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDatabase();
    await loadSongsFromDatabase();

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🎵 Songs loaded: ${songs.length}`);
    });
  } catch (error) {
    console.error('❌ Không thể khởi động server:', error);
    process.exit(1);
  }
}

startServer();