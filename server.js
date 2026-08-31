const express = require('express');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 10000;

// 1. Phục vụ các file tĩnh trong thư mục public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Khởi tạo Telegram Bot
const botToken = process.env.BOT_TOKEN ? process.env.BOT_TOKEN.trim() : '';
const bot = new Telegraf(botToken);

// Middleware ghi log theo dõi tin nhắn
bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.text) {
    console.log(`📩 Nhận tin nhắn từ [${ctx.chat.type}] (ID: ${ctx.chat.id}): ${ctx.message.text}`);
  }
  return next();
});

// 3. Hàm xử lý gửi nút bấm Mở Mini App
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

// Nhận diện tất cả các kiểu gõ: /musicgame, /musicgame@GU3B_Radio_Bot, /music...
bot.hears(/^\/(musicgame|music)/i, handleMusicGameCommand);
bot.command('start', handleMusicGameCommand);

// 4. Khởi chạy Express Web Server
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});

// 5. Khởi chạy Telegram Bot an toàn
async function startTelegramBot() {
  try {
    console.log('🔍 Đang kiểm tra và kết nối Bot...');

    if (!botToken) {
      console.error('❌ LỖI: Chưa cấu hình BOT_TOKEN trên Render Environment!');
      return;
    }

    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('🧹 Đã xóa Webhook cũ thành công!');

    // Gán thông tin botInfo trực tiếp (chỉ khai báo 1 lần)
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
