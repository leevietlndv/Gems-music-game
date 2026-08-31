const express = require('express');
const { Telegraf } = require('telegraf');
const path = require('path');

// 1. Khởi tạo Express App trước
const app = express();

// 2. Cấu hình Middleware và Static Files
const publicPath = path.join(__dirname, 'public');
app.use(express.json());
app.use(express.static(publicPath));

// Route trang chủ bắt lỗi hiển thị file index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err) {
      console.error("Lỗi tìm file:", err);
      res.status(404).send("Lỗi: Không tìm thấy file index.html trong thư mục public!");
    }
  });
});

// 3. Cấu hình Telegram Bot
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;

if (!BOT_TOKEN) {
  console.error("❌ LỖI: Chưa cấu hình BOT_TOKEN trong Environment Variables!");
}

const bot = new Telegraf(BOT_TOKEN);

let gameState = {
  isLocked: false,
  songs: []
};

// 1. Log tất cả tin nhắn gửi tới Bot để debug trên Render
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    console.log(`📩 Nhận tin nhắn từ [${ctx.chat.type}] (ID: ${ctx.chat.id}): ${ctx.message.text}`);
  }
  return next();
});

// 2. Bắt tất cả các câu lệnh liên quan đến musicgame / music (kể cả có @username phía sau)
bot.hears(/\/musicgame|\/music/i, (ctx) => {
  console.log('✅ Đã kích hoạt lệnh Mở Game Nhạc!');
  
  ctx.reply('🎪 Nhấn vào nút dưới đây để tham gia gửi link nhạc hoặc mở Vòng Quay!', {
    reply_markup: {
      inline_keyboard: [[
        { text: "🎵 Mở Game Nhạc", web_app: { url: process.env.WEB_APP_URL || WEB_APP_URL } }
      ]]
    }
  }).catch(err => console.error('❌ Lỗi gửi tin nhắn:', err));
});

// 4. Các API xử lý Game
app.get('/api/game', (req, res) => {
  res.json(gameState);
});

app.post('/api/submit', (req, res) => {
  if (gameState.isLocked) {
    return res.status(400).json({ error: 'Form đã đóng, không thể gửi thêm bài!' });
  }
  const { user, links } = req.body;
  if (Array.isArray(links)) {
    links.forEach(url => {
      if (url && url.trim() !== '') {
        gameState.songs.push({
          id: Date.now() + Math.random().toString(36).substr(2, 4),
          user: user || 'Ẩn danh',
          url: url.trim()
        });
      }
    });
  }
  res.json({ success: true, total: gameState.songs.length });
});

app.post('/api/lock', (req, res) => {
  gameState.isLocked = true;
  res.json({ success: true, isLocked: true });
});

app.post('/api/remove', (req, res) => {
  const { id } = req.body;
  gameState.songs = gameState.songs.filter(song => song.id !== id);
  res.json({ success: true, remaining: gameState.songs });
});

app.post('/api/reset', (req, res) => {
  gameState = { isLocked: false, songs: [] };
  res.json({ success: true });
});

// API Mở lại Form cho phép gửi bài tiếp
app.post('/api/unlock', (req, res) => {
  gameState.isLocked = false;
  res.json({ success: true, isLocked: false });
});

// Middleware ghi log mọi tin nhắn gửi tới Bot
bot.use(async (ctx, next) => {
  console.log(`📩 [LOG NHÓM] Nhận tin nhắn: "${ctx.message?.text}" từ ID: ${ctx.chat?.id}`);
  return next();
});

// --- KHỞI CHẠY BOT VÀ XÓA WEBHOOK CŨ ---
async function startTelegramBot() {
  try {
    console.log("🔍 Đang kiểm tra và kết nối Bot...");

    // 1. Xóa sạch Webhook cũ kẹt trên Telegram Server
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log("🧹 Đã xóa Webhook cũ thành công!");

    // 2. Xác thực Token và lấy thông tin Bot
    const botInfo = await bot.telegram.getMe();
    console.log(`🤖 Xác thực thành công Bot: @${botInfo.username}`);

    // 3. Khởi chạy Long Polling
    bot.launch();
    console.log("✅ Telegram Bot đã chính thức lắng nghe tin nhắn!");
  } catch (err) {
    console.error("❌ Lỗi khởi chạy Telegram Bot:", err.message || err);
  }
}

startTelegramBot();

// Đóng bot an toàn khi server restart
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server đang chạy trên cổng ${PORT}`));
