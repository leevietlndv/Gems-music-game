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
let songs = [];
let lastWinner = null;

function broadcastState() {
  io.emit('stateUpdate', { isFormOpen, songs, lastWinner });
}

function performSpin() {
  if (lastWinner) {
    const index = songs.findIndex(s => s.url === lastWinner.url && s.user === lastWinner.user);
    if (index !== -1) {
      songs.splice(index, 1);
    }
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

// --- CÁC LỆNH BOT TELEGRAM (ĐÃ TỐI ƯU CHO NHÓM CHAT) ---
if (bot) {
  const sendWebAppButton = async (ctx) => {
    const webAppUrl = process.env.WEB_APP_URL || 'https://gems-music-game.onrender.com/';
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const botUsername = ctx.botInfo?.username || '';

    // Trường hợp 1: Nhắn tin trong Nhóm Chat
    if (isGroup) {
      return ctx.reply(
        '🎵 Vòng Quay Nhạc',
        Markup.inlineKeyboard([
          [Markup.button.url('💬 Mở trong Chat riêng với Bot', `https://t.me/${botUsername}?start=musicgame`)],
          [Markup.button.url('🌐 Mở trực tiếp bằng Trình duyệt', webAppUrl)]
        ])
      );
    }

    // Trường hợp 2: Chat riêng trực tiếp với Bot
    ctx.reply(
      '🎵 Bấm nút bên dưới để gửi bài hát của bạn',
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎡 Mở Vòng Quay Nhạc', webAppUrl)]
      ])
    );
  };

  // Nhận lệnh /start và /musicgame (kể cả dạng /musicgame@bot_username trong nhóm)
  bot.command(['start', 'musicgame'], sendWebAppButton);

  bot.command('spin', (ctx) => {
    const result = performSpin();
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

  // Tự động đăng ký Menu lệnh
  bot.telegram.setMyCommands([
    { command: 'musicgame', description: 'Mở Vòng Quay Nhạc' },
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
app.use(express.static(path.join(__dirname, 'public')));

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
  const result = performSpin();
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
