const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CẤU HÌNH BOT TELEGRAM ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

let isFormOpen = true;
let songs = []; // [{ url, user, telegramId }]
let lastWinner = null;
let lastSpinner = null; // Lưu người bấm quay gần nhất

function broadcastState() {
  io.emit('stateUpdate', { isFormOpen, songs, lastWinner });
}

function performSpin(spinnerName = 'Hệ thống') {
  // 1. Tự động xóa bài vừa phát xong/vừa trúng thưởng ở lượt trước
  if (lastWinner) {
    const index = songs.findIndex(s => s.url === lastWinner.url && s.user === lastWinner.user);
    if (index !== -1) {
      songs.splice(index, 1);
    }
    lastWinner = null;
  }

  // 2. Kiểm tra nếu hết bài
  if (songs.length === 0) {
    broadcastState();
    return { success: false, message: 'Danh sách bài hát đã hết!' };
  }

  // 3. Quay bài hát mới
  const selectedIndex = Math.floor(Math.random() * songs.length);
  const winner = songs[selectedIndex];
  lastWinner = winner;
  lastSpinner = spinnerName;

  broadcastState();
  io.emit('triggerSpin', { selectedIndex, winner, spinner: lastSpinner });
  return { success: true, winner, spinner: lastSpinner };
}

// --- CÁC LỆNH BOT TELEGRAM ---
if (bot) {
  const sendWebAppButton = (ctx) => {
    const directMiniAppUrl = 'https://t.me/GU3B_Radio_Bot/music3B';
    ctx.reply(
      '🎵 **VÒNG QUAY NHẠC GEMS**\nBấm nút bên dưới để tham gia quay bài hát ngay:',
      Markup.inlineKeyboard([
        [Markup.button.url('🎡 Mở Vòng Quay Nhạc', directMiniAppUrl)]
      ])
    );
  };

  bot.command(['start', 'musicgems', 'musicgame'], sendWebAppButton);

  bot.command('spin', (ctx) => {
    const userName = ctx.from.first_name || 'Người dùng';
    const result = performSpin(userName);
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

  bot.command('reset', (ctx) => {
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

  bot.telegram.setMyCommands([
    { command: 'musicgems', description: 'Mở Vòng Quay Nhạc' },
    { command: 'spin', description: 'Quay ngẫu nhiên bài hát' },
    { command: 'toggle', description: 'Bật/Tắt form gửi bài' },
    { command: 'list', description: 'Xem danh sách bài hát' },
    { command: 'reset', description: 'Xóa toàn bộ danh sách' }
  ]).catch(err => console.error('Lỗi thiết lập menu lệnh:', err));

  bot.launch()
    .then(() => console.log('🤖 Bot Telegram đã khởi chạy thành công!'))
    .catch(err => console.error('Lỗi khởi chạy Bot:', err));
}

// --- API HTTP & SOCKET.IO ---
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Trả về trang chủ index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
  socket.emit('stateUpdate', { isFormOpen, songs, lastWinner });
});

app.post('/api/submit', (req, res) => {
  if (!isFormOpen) {
    return res.json({ success: false, message: 'Form đã đóng, không thể gửi bài!' });
  }
  const { url, user } = req.body;
  if (!url) {
    return res.json({ success: false, message: 'Vui lòng nhập link bài hát!' });
  }

  songs.push({ url, user: user || 'Người dùng' });
  broadcastState();
  res.json({ success: true });
});

app.post('/api/spin', (req, res) => {
  const { user } = req.body;
  const result = performSpin(user || 'Người dùng');
  res.json(result);
});

// API TỰ ĐỘNG QUAY KHI HẾT BÀI HÁT (GỌI TỪ FRONTEND)
app.post('/api/song-ended', (req, res) => {
  const result = performSpin(lastSpinner || 'Tự động');
  res.json(result);
});

app.post('/api/toggle-form', (req, res) => {
  isFormOpen = !isFormOpen;
  broadcastState();
  res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
  songs = [];
  lastWinner = null;
  broadcastState();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
