const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 10000;

// 1. Middleware bắt buộc để nhận dữ liệu JSON & Form từ Web App gửi lên
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Phục vụ các file tĩnh trong thư mục public
app.use(express.static(path.join(__dirname, 'public')));

// --- BỘ NHỚ LƯU TRỮ TRẠNG THÁI GAME ---
let gameState = {
  isFormOpen: true,
  songs: [] // Danh sách bài hát gửi lên
};

// --- CÁC ROUTE API DÀNH CHO WEB APP (FRONTEND) ---

// API 1: Lấy trạng thái Game & Danh sách bài hát
const getGameState = (req, res) => {
  res.json({
    success: true,
    status: 'online',
    isFormOpen: gameState.isFormOpen,
    songs: gameState.songs,
    count: gameState.songs.length
  });
};

app.get('/api/state', getGameState);
app.get('/api/status', getGameState);
app.get('/api/songs', getGameState);

// API 2: Nhận link nhạc gửi từ Web App
const submitSong = (req, res) => {
  try {
    if (!gameState.isFormOpen) {
      return res.status(400).json({ success: false, message: 'Form gửi nhạc hiện đang đóng!' });
    }

    const songUrl = req.body.url || req.body.songUrl || req.body.link;
    const userName = req.body.user || req.body.userName || req.body.sender || 'Người dùng';

    if (!songUrl || typeof songUrl !== 'string' || !songUrl.trim()) {
      return res.status(400).json({ success: false, message: 'Vui lòng cung cấp URL bài hát hợp lệ!' });
    }

    const newSong = {
      id: Date.now().toString(),
      url: songUrl.trim(),
      user: userName,
      createdAt: new Date().toISOString()
    };

    gameState.songs.push(newSong);
    console.log(`🎵 Bài hát mới: ${newSong.url} (gửi bởi: ${newSong.user})`);

    return res.json({
      success: true,
      message: 'Gửi bài hát thành công!',
      song: newSong,
      songs: gameState.songs,
      isFormOpen: gameState.isFormOpen
    });
  } catch (err) {
    console.error('❌ Lỗi xử lý gửi bài hát:', err);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ nội bộ!' });
  }
};

app.post('/api/submit', submitSong);
app.post('/api/songs', submitSong);
app.post('/api/add-song', submitSong);

// API 3: Quay Vòng Quay
app.post('/api/spin', (req, res) => {
  if (gameState.songs.length === 0) {
    return res.status(400).json({ success: false, message: 'Danh sách bài hát đang trống!' });
  }
  const selectedIndex = Math.floor(Math.random() * gameState.songs.length);
  const winner = gameState.songs[selectedIndex];
  res.json({
    success: true,
    selectedIndex,
    winner,
    songs: gameState.songs
  });
});

// API 4: Đóng / Mở Form
const toggleForm = (req, res) => {
  if (req.body.isOpen !== undefined) {
    gameState.isFormOpen = Boolean(req.body.isOpen);
  } else {
    gameState.isFormOpen = !gameState.isFormOpen;
  }
  res.json({
    success: true,
    isFormOpen: gameState.isFormOpen,
    message: gameState.isFormOpen ? 'Đã mở form gửi nhạc!' : 'Đã đóng form gửi nhạc!'
  });
};

app.post('/api/toggle-form', toggleForm);
app.post('/api/toggle', toggleForm);

// API 5: Reset Game
app.post('/api/reset', (req, res) => {
  gameState.songs = [];
  gameState.isFormOpen = true;
  console.log('🧹 Đã reset lại game!');
  res.json({
    success: true,
    message: 'Đã xóa toàn bộ bài hát!',
    isFormOpen: gameState.isFormOpen,
    songs: []
  });
});

// Trang chủ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- TELEGRAM BOT CONFIGURATION ---
const botToken = process.env.BOT_TOKEN ? process.env.BOT_TOKEN.trim() : '';
const bot = new Telegraf(botToken);

bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.text) {
    console.log(`📩 Nhận tin nhắn từ [${ctx.chat.type}] (ID: ${ctx.chat.id}): ${ctx.message.text}`);
  }
  return next();
});

const handleMusicGameCommand = async (ctx) => {
  try {
    console.log('✅ Đã kích hoạt lệnh Mở Game Nhạc!');
    const rawUrl = process.env.WEB_APP_URL || 'https://gems-music-game.onrender.com';
    const webAppUrl = rawUrl.trim();

    await ctx.reply(
      '🎶 Nhấn vào nút dưới đây để tham gia gửi link nhạc hoặc mở Vòng Quay!',
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Mở Game Nhạc', webAppUrl)]
      ])
    );
  } catch (err) {
    console.error('❌ Lỗi gửi tin nhắn:', err);
  }
};

bot.command('start', handleMusicGameCommand);
bot.hears(/^\/(musicgame|music)/i, handleMusicGameCommand);

// 4. Khởi chạy Server Express
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});

// 5. Khởi chạy Telegram Bot
async function startTelegramBot() {
  try {
    console.log('🔍 Đang kiểm tra và kết nối Bot...');

    if (!botToken) {
      console.error('❌ LỖI: Chưa cấu hình BOT_TOKEN trên Render Environment!');
      return;
    }

    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('🧹 Đã xóa Webhook cũ thành công!');

    bot.botInfo = await bot.telegram.getMe();
    console.log(`🤖 Xác thực thành công Bot: @${bot.botInfo.username}`);

    bot.launch();
    console.log('✅ Telegram Bot đã chính thức lắng nghe tin nhắn!');
  } catch (err) {
    console.error('❌ Lỗi khởi chạy Telegram Bot:', err.message || err);
  }
}

startTelegramBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
