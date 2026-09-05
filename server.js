require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
// Logic parse YouTube DÙNG CHUNG với client (public/shared/youtube.js) — chỉ sửa ở đó.
const { getYouTubeVideoId } = require('./public/shared/youtube.js');

const app = express();
const server = http.createServer(app);

// Render nằm sau reverse proxy: bắt buộc để req.ip / express-rate-limit
// nhìn thấy IP thật của user thay vì IP của proxy.
app.set('trust proxy', 1);

// CORS: chỉ cho phép Mini App của bạn nối Socket.IO (trước đây: mọi origin).
// WEBAPP_URL phải trùng với domain load Mini App, ví dụ
// https://gems-music-game.onrender.com
// Socket.IO chạy cùng origin với Mini App nên không cần khóa cứng một URL
// duy nhất. Render/Telegram có thể gửi Origin khác nhau (đặc biệt khi đổi
// domain, preview hoặc thêm/bớt dấu /). Cho phép đúng các origin tin cậy.
const allowedOrigins = new Set([
  process.env.WEBAPP_URL || 'https://gems-music-game.onrender.com',
  'https://gems-music-game.onrender.com'
].filter(Boolean).map(url => String(url).replace(/\/$/, '')));

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(String(origin).replace(/\/$/, ''))) {
        return callback(null, true);
      }
      console.warn(`🚫 Socket.IO CORS blocked origin: ${origin}`);
      return callback(new Error('Socket.IO CORS origin not allowed'));
    },
    methods: ['GET', 'POST']
  }
});

// Cau hinh SSL cho PostgreSQL (cap nhat 2025):
// - Render BAT BUOC SSL cho ca DB noi bo (*.internal) lan ngoai (*.render.com).
// - Chung chi cua Render la self-signed, khong nam trong trust store cua Node,
//   nen phai rejectUnauthorized: false (van ma hoa TLS, chi bo buoc verify CA).
//   Neu khong se bi loi DEPTH_ZERO_SELF_SIGNED_CERT khi khoi dong.
// - Co the bat lai verify bang DATABASE_SSL_REJECT_UNAUTHORIZED=true.
function getSslConfig(connectionString) {
  if (!connectionString) return false;
  // Neu chuoi ket noi co sslmode=disable thi khong dung SSL
  if (/sslmode=disable/i.test(connectionString)) return false;
  return {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true'
  };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: getSslConfig(process.env.DATABASE_URL)
});
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songs (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    user_name TEXT NOT NULL,
    telegram_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
  `);

  await pool.query(`
  ALTER TABLE songs
  ADD COLUMN IF NOT EXISTS title TEXT
`);

  // Cột video_id (đã extract + validate) để chống race-condition khi
  // submit trùng bài: duy nhất ở mức DB thay vì check SELECT trước INSERT.
  await pool.query(`
    ALTER TABLE songs
    ADD COLUMN IF NOT EXISTS video_id TEXT
  `);

  // Backfill video_id cho các dòng cũ + xóa bài trùng (giữ bản cũ nhất).
  {
    const rows = await pool.query('SELECT id, url, video_id FROM songs');
    const seen = new Map();
    for (const row of rows.rows) {
      const videoId = row.video_id || getYouTubeVideoId(row.url);
      if (!videoId) continue;
      if (seen.has(videoId)) {
        await pool.query('DELETE FROM songs WHERE id = $1', [row.id]);
      } else {
        seen.set(videoId, row.id);
        if (!row.video_id) {
          await pool.query('UPDATE songs SET video_id = $1 WHERE id = $2', [videoId, row.id]);
        }
      }
    }
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_video_id
    ON songs (video_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS song_votes (
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      telegram_id TEXT NOT NULL,
      vote SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (song_id, telegram_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS song_votes_meta (
      key TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    )
  `);

  // Blacklist v1: lưu riêng các bài đã bị chặn để không làm thay đổi
  // cấu trúc/ý nghĩa của bảng songs hiện tại. video_id là định danh duy nhất
  // của bài YouTube, nên một bài chỉ xuất hiện một lần trong blacklist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_songs (
      id SERIAL PRIMARY KEY,
      video_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      user_name TEXT,
      telegram_id TEXT,
      blocked_reason TEXT NOT NULL CHECK (blocked_reason IN ('manual_delete', 'health_zero')),
      blocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_songs_video_id
    ON blocked_songs (video_id)
  `);

  // Phiên bản vote mới: LIKE = +1, DISLIKE = -1.
  // Bản health-v1 cũ dùng ngược dấu, nên chỉ đảo dấu đúng một lần.
  // Chạy trong transaction để không bao giờ đảo dấu 2 lần nếu server
  // crash giữa chừng (UPDATE xong nhưng chưa ghi meta).
  await pool.query('BEGIN');
  try {
    const voteVersion = await pool.query(
      `SELECT version FROM song_votes_meta WHERE key = 'vote_semantics' FOR UPDATE`
    );

    if (voteVersion.rowCount === 0) {
      await pool.query('UPDATE song_votes SET vote = -vote');
      await pool.query(`
        INSERT INTO song_votes_meta (key, version)
        VALUES ('vote_semantics', 2)
      `);
      console.log('🔄 Đã chuyển vote sang quy ước mới: Like +1 | Dislike -1');
    }

    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }

  console.log('🗄️ PostgreSQL: Database ready');
}

async function loadSongsFromDatabase() {
  const result = await pool.query(`
    SELECT
      id,
      url,
      title,
      user_name AS user,
      telegram_id AS "telegramId",
      created_at
    FROM songs
    ORDER BY id ASC
  `);

  songs = result.rows;

  console.log(`🎵 Đã tải ${songs.length} bài hát từ PostgreSQL`);
}

async function loadBlockedSongsFromDatabase() {
  const result = await pool.query(`
    SELECT
      id,
      video_id AS "videoId",
      url,
      title,
      user_name AS user,
      telegram_id AS "telegramId",
      blocked_reason AS "blockedReason",
      blocked_at AS "blockedAt"
    FROM blocked_songs
    ORDER BY id ASC
  `);

  blockedSongs = result.rows;

  console.log(`🚫 Đã tải ${blockedSongs.length} bài hát trong blacklist từ PostgreSQL`);
}

/**
 * Chuyển một bài hát từ danh sách songs sang blacklist trong cùng một transaction.
 * Phase 2 chỉ dùng cho Admin Delete; Health = 0 sẽ được nối vào helper này ở phase sau.
 */
async function blockSongAndRemove(songId, reason = 'manual_delete') {
  const normalizedId = Number.parseInt(songId, 10);

  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    const error = new Error('ID bài hát không hợp lệ');
    error.code = 'INVALID_SONG_ID';
    throw error;
  }

  if (!['manual_delete', 'health_zero'].includes(reason)) {
    const error = new Error('Lý do blacklist không hợp lệ');
    error.code = 'INVALID_BLOCK_REASON';
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Khóa đúng bài hát trong transaction để tránh hai thao tác xóa chạy đồng thời.
    const songResult = await client.query(`
      SELECT
        id,
        video_id AS "videoId",
        url,
        title,
        user_name AS "user",
        telegram_id AS "telegramId"
      FROM songs
      WHERE id = $1
      FOR UPDATE
    `, [normalizedId]);

    if (songResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const song = songResult.rows[0];

    // Ghi vào blacklist trước khi xóa khỏi songs.
    // ON CONFLICT giúp thao tác idempotent nếu video_id đã có trong blacklist.
    let blockedResult = await client.query(`
      INSERT INTO blocked_songs (
        video_id,
        url,
        title,
        user_name,
        telegram_id,
        blocked_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (video_id) DO NOTHING
      RETURNING
        id,
        video_id AS "videoId",
        url,
        title,
        user_name AS "user",
        telegram_id AS "telegramId",
        blocked_reason AS "blockedReason",
        blocked_at AS "blockedAt"
    `, [
      song.videoId,
      song.url,
      song.title,
      song.user,
      song.telegramId,
      reason
    ]);

    let blockedSong;

    if (blockedResult.rowCount > 0) {
      blockedSong = blockedResult.rows[0];
    } else {
      const existingResult = await client.query(`
        SELECT
          id,
          video_id AS "videoId",
          url,
          title,
          user_name AS "user",
          telegram_id AS "telegramId",
          blocked_reason AS "blockedReason",
          blocked_at AS "blockedAt"
        FROM blocked_songs
        WHERE video_id = $1
      `, [song.videoId]);

      blockedSong = existingResult.rows[0];
    }

    // Giữ nguyên hành vi hiện tại: vote của bài bị xóa cũng phải được dọn.
    await client.query('DELETE FROM song_votes WHERE song_id = $1', [normalizedId]);

    const deleteResult = await client.query(
      'DELETE FROM songs WHERE id = $1 RETURNING id',
      [normalizedId]
    );

    if (deleteResult.rowCount === 0) {
      throw new Error('Bài hát không còn tồn tại khi thực hiện xóa');
    }

    await client.query('COMMIT');

    // Chỉ cập nhật RAM sau khi transaction PostgreSQL đã commit thành công.
    songs = songs.filter(songItem => String(songItem.id) !== String(normalizedId));

    if (blockedSong) {
      const existingIndex = blockedSongs.findIndex(
        item => String(item.videoId) === String(blockedSong.videoId)
      );

      if (existingIndex >= 0) {
        blockedSongs[existingIndex] = blockedSong;
      } else {
        blockedSongs.push(blockedSong);
      }
    }

    return {
      song,
      blockedSong
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('❌ Lỗi ROLLBACK khi blacklist bài hát:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://gems-music-game.onrender.com';
const MAIN_MINI_APP_URL = 'https://t.me/GU3B_Radio_Bot/music3B';

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
// Danh sách blacklist được cache trong RAM sau khi tải từ PostgreSQL.
// Phase 2 bắt đầu sử dụng cache này cho thao tác Admin Delete.
let blockedSongs = [];
let lastWinner = null;
let lastAction = null;
let currentHealth = 5;
let currentLikeCount = 0;
let currentDislikeCount = 0;
let replacementCountdown = null;
let replacementTimer = null;
let replacementInProgress = false;

// ==================== ONLINE USERS / CONNECTIONS ====================
// Đếm user Telegram duy nhất, đồng thời theo dõi số socket đang kết nối.
// Một Telegram user mở nhiều thiết bị vẫn chỉ tính là 1 user online.
const onlineUsers = new Map();
const socketPresence = new Map();
const socketAuth = new Map();

function detectDeviceType(deviceInfo = {}) {
  const info = deviceInfo || {}; // null/0/false coalesce to empty info
  const platform = String(info.platform || '').toLowerCase();
  const userAgent = String(info.userAgent || '').toLowerCase();

  // Tablet: iPad hoặc Android không có chuỗi "mobile".
  if (
    userAgent.includes('ipad') ||
    platform === 'ipad' ||
    (userAgent.includes('android') && !userAgent.includes('mobile'))
  ) {
    return 'tablet';
  }

  // Máy tính: Telegram Desktop hoặc trình duyệt desktop.
  if (
    ['tdesktop', 'macos', 'windows', 'linux'].includes(platform) ||
    userAgent.includes('windows nt') ||
    userAgent.includes('macintosh') ||
    userAgent.includes('x11') ||
    (userAgent.includes('linux') && !userAgent.includes('android'))
  ) {
    return 'computer';
  }

  // Còn lại ưu tiên coi là điện thoại.
  return 'phone';
}

function addOnlineUser(socket, authUser, deviceInfo = {}) {
  const telegramId = String(authUser.id);
  const userName =
    [authUser.first_name, authUser.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    authUser.username ||
    'Người dùng';

  // Nếu socket này từng đăng nhập user khác, gỡ presence cũ trước.
  removeOnlineUser(socket.id, false);

  let entry = onlineUsers.get(telegramId);
  if (!entry) {
    entry = {
      telegramId,
      name: userName,
      connections: new Map()
    };
    onlineUsers.set(telegramId, entry);
  } else {
    entry.name = userName;
  }

  entry.connections.set(socket.id, {
    device: detectDeviceType(deviceInfo)
  });

  socketPresence.set(socket.id, telegramId);
  socketAuth.set(socket.id, {
    telegramId,
    isAdmin: isAdmin(telegramId)
  });
}

function removeOnlineUser(socketId, shouldBroadcast = true) {
  const telegramId = socketPresence.get(socketId);
  if (!telegramId) {
    socketAuth.delete(socketId);
    return;
  }

  const entry = onlineUsers.get(telegramId);
  if (entry) {
    entry.connections.delete(socketId);
    if (entry.connections.size === 0) {
      onlineUsers.delete(telegramId);
    }
  }

  socketPresence.delete(socketId);
  socketAuth.delete(socketId);

  if (shouldBroadcast) {
    broadcastOnlineSummary();
  }
}

function getOnlineSummary() {
  const devices = {
    phone: 0,
    computer: 0,
    tablet: 0
  };

  let connections = 0;

  for (const entry of onlineUsers.values()) {
    for (const connection of entry.connections.values()) {
      connections += 1;
      const type = connection.device;
      if (Object.prototype.hasOwnProperty.call(devices, type)) {
        devices[type] += 1;
      }
    }
  }

  return {
    users: onlineUsers.size,
    connections,
    devices
  };
}

function broadcastOnlineSummary() {
  io.emit('onlineUsers', getOnlineSummary());
}

function getOnlineDetails() {
  return Array.from(onlineUsers.values())
    .map(entry => {
      const devices = {
        phone: 0,
        computer: 0,
        tablet: 0
      };

      for (const connection of entry.connections.values()) {
        if (Object.prototype.hasOwnProperty.call(devices, connection.device)) {
          devices[connection.device] += 1;
        }
      }

      return {
        telegramId: entry.telegramId,
        name: entry.name,
        connections: entry.connections.size,
        devices
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

// Khóa xử lý vote để các lượt bấm đồng thời được xử lý tuần tự.
let voteQueue = Promise.resolve();

function clampHealth(value) {
  return Math.max(0, Math.min(5, Number(value) || 0));
}

async function getSongVoteStats(songId) {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE vote = 1) AS likes,
      COUNT(*) FILTER (WHERE vote = -1) AS dislikes,
      COALESCE(SUM(vote), 0) AS score
    FROM song_votes
    WHERE song_id = $1
  `, [songId]);

  const row = result.rows[0] || {};
  const likes = Number(row.likes) || 0;
  const dislikes = Number(row.dislikes) || 0;
  const score = Number(row.score) || 0;

  return {
    likes,
    dislikes,
    score,
    health: clampHealth(5 + score)
  };
}

async function refreshCurrentSongHealth() {
  if (!lastWinner) {
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    return { likes: 0, dislikes: 0, score: 0, health: 5 };
  }

  const stats = await getSongVoteStats(lastWinner.id);
  currentHealth = stats.health;
  currentLikeCount = stats.likes;
  currentDislikeCount = stats.dislikes;
  return stats;
}

async function getUserVote(songId, telegramId) {
  const result = await pool.query(`
    SELECT vote FROM song_votes
    WHERE song_id = $1 AND telegram_id = $2
  `, [songId, String(telegramId)]);
  return result.rowCount ? Number(result.rows[0].vote) : 0;
}

async function broadcastHealthOnly() {
  io.emit('songHealth', {
    songId: lastWinner?.id || null,
    health: currentHealth,
    likes: currentLikeCount,
    dislikes: currentDislikeCount,
    replacementCountdown
    // Lưu ý: KHÔNG gửi userVote ở đây — broadcast đến tất cả user,
    // mỗi user có vote riêng. Vote của người bấm được trả về qua HTTP
    // response của /api/song-vote; userVote riêng lẻ chỉ được emit
    // qua socket cá nhân trong handler 'authenticate'.
  });
}

function clearReplacementCountdown() {
  if (replacementTimer) {
    clearInterval(replacementTimer);
    replacementTimer = null;
  }
  replacementCountdown = null;
}

function broadcastReplacementCountdown() {
  io.emit('replacementCountdown', {
    songId: lastWinner?.id || null,
    countdown: replacementCountdown
  });
}

async function replaceCurrentSongDueToHealth() {
  if (replacementInProgress || !lastWinner || currentHealth !== 0) return false;

  replacementInProgress = true;
  try {
    const previousSong = lastWinner;
    const previousTitle = previousSong.title || previousSong.url || 'bài hát trước đó';
    const availableSongs = songs.filter(song => String(song.id) !== String(previousSong.id));

    clearReplacementCountdown();

    if (availableSongs.length === 0) {
      currentHealth = 0;
      await broadcastHealthOnly();
      return false;
    }

    const nextSong = availableSongs[Math.floor(Math.random() * availableSongs.length)];

    // Xóa vote cũ đọng từ lần phát trước để health của bài mới luôn bắt đầu
    // đúng từ 5 (không bị tính lại theo old votes ở lần vote tiếp theo).
    await pool.query('DELETE FROM song_votes WHERE song_id = $1', [nextSong.id]);
    await pool.query('DELETE FROM song_votes WHERE song_id = $1', [previousSong.id]);
    await pool.query('DELETE FROM songs WHERE id = $1', [previousSong.id]);
    songs = songs.filter(song => String(song.id) !== String(previousSong.id));

    lastWinner = nextSong;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    lastAction = { type: 'replace', title: previousTitle };

    io.emit('songPlayed', {
      song: nextSong,
      initiatorSocketId: null,
      action: lastAction,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null
    });
    broadcastState();

    console.log(`❤️ Máu về 0 quá 10 giây → thay #${previousSong.id} bằng #${nextSong.id}: ${nextSong.title || nextSong.url}`);
    return true;
  } catch (error) {
    console.error('❌ Lỗi tự động thay bài do máu:', error);
    return false;
  } finally {
    replacementInProgress = false;
  }
}

function startReplacementCountdown() {
  if (replacementTimer || !lastWinner || currentHealth !== 0) return;

  replacementCountdown = 10;
  broadcastReplacementCountdown();

  replacementTimer = setInterval(async () => {
    if (!lastWinner || currentHealth !== 0) {
      clearReplacementCountdown();
      broadcastReplacementCountdown();
      return;
    }

    replacementCountdown -= 1;

    if (replacementCountdown <= 0) {
      clearReplacementCountdown();
      const run = voteQueue.then(() => replaceCurrentSongDueToHealth(), () => replaceCurrentSongDueToHealth());
      voteQueue = run.catch(() => {});
      await run;
      return;
    }

    broadcastReplacementCountdown();
  }, 1000);
}

async function performSpin(initiatorSocketId = null, actionUser = null) {
  if (lastWinner) {
  await pool.query(
      'DELETE FROM songs WHERE id = $1',
      [lastWinner.id]
    );

    songs = songs.filter(song => String(song.id) !== String(lastWinner.id));

    lastWinner = null;
    lastAction = null;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    clearReplacementCountdown();
  }

  if (songs.length === 0) {
    broadcastState();
    return { success: false, message: 'Danh sách bài hát đã hết!' };
  }

  const selectedIndex = Math.floor(Math.random() * songs.length);
  const winner = songs[selectedIndex];
  lastWinner = winner;
  currentHealth = 5;
  currentLikeCount = 0;
  currentDislikeCount = 0;
  clearReplacementCountdown();
  lastAction = actionUser ? { type: 'spin', user: actionUser } : null;

  io.emit('triggerSpin', {
    selectedIndex,
    winner,
    initiatorSocketId,
    action: lastAction
  });
  broadcastState();
  return { success: true, winner };
}

  // --- CÁC LỆNH BOT TELEGRAM ---
  if (bot) {
  const sendWebAppButton = (ctx) => {
    const miniAppUrl = 'https://t.me/GU3B_Radio_Bot/music3B';

    ctx.reply(
      '🎧 Bấm vào bên dưới để gửi nhạc',
      Markup.inlineKeyboard([
        [
          Markup.button.url(
            '𝄞 Mở GEMS Radio',
            MAIN_MINI_APP_URL
          )
        ]
      ])
    );
  };

  // Nhận lệnh /start và /musicgems
  bot.command(['start', 'radio', 'music'], sendWebAppButton);

  // Inline Mode: @TênBot
  bot.on('inline_query', async (ctx) => {
    try {
      await ctx.answerInlineQuery([
        {
          type: 'article',
          id: 'gems_music_game',
          title: '𝄞 Mở GEMS Radio',
          description: 'Mở Mini App để gửi nhạc',
          input_message_content: {
            message_text: '🎧 Mở Mini App để gửi nhạc'
          },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '𝄞 Mở GEMS Radio',
                  web_app: {
                    url: WEBAPP_URL
                  }
                }
              ]
            ]
          }
        }
      ]);
    } catch (error) {
      console.error('❌ Lỗi Inline Mode:', error);
    }
  });

  // Mọi lệnh quản trị (spin/toggle/reset/list) chỉ dành cho Admin.
  const requireBotAdmin = (ctx) => isAdmin(ctx.from?.id);
  const denyNonAdmin = (ctx) => ctx.reply('⛔ Lệnh này chỉ dành cho Admin.');

  bot.command('spin', async (ctx) => {
    if (!requireBotAdmin(ctx)) return denyNonAdmin(ctx);
    const result = await performSpin();
    if (!result.success) {
      ctx.reply(`⚠️ ${result.message}`);
    } else {
      ctx.reply(`🎡 Đã quay! Bài trúng thưởng: ${result.winner.user} - ${result.winner.url}`);
    }
  });

  bot.command('toggle', (ctx) => {
    if (!requireBotAdmin(ctx)) return denyNonAdmin(ctx);
    isFormOpen = !isFormOpen;
    broadcastState();
    ctx.reply(`📢 Trạng thái form: ${isFormOpen ? '🟢 Đang MỞ' : '🔴 Đã ĐÓNG'}`);
  });

  bot.command('reset', async (ctx) => {
    if (!requireBotAdmin(ctx)) return denyNonAdmin(ctx);
    await pool.query('DELETE FROM songs');

    songs = [];
    lastWinner = null;

    setAutoPlayState(0);
    broadcastAutoPlayState();
    broadcastState();

    ctx.reply('🧹 Đã xóa sạch danh sách bài hát!');
  });

  bot.command('list', (ctx) => {
    if (!requireBotAdmin(ctx)) return denyNonAdmin(ctx);
    if (songs.length === 0) {
      return ctx.reply('📋 Danh sách bài hát hiện đang trống.');
    }
    const listStr = songs.map((s, i) => `${i + 1}. ${s.user}: ${s.url}`).join('\n');
    ctx.reply(`📋 **Danh sách bài hát (${songs.length}):**\n\n${listStr}`);
  });

  // Tự động đăng ký Menu lệnh
  bot.telegram.setMyCommands([
    { command: 'radio', description: 'Mở Vòng Quay Nhạc' },
    { command: 'music', description: 'Mở Vòng Quay Nhạc' },
    { command: 'spin', description: 'Quay ngẫu nhiên bài hát' },
    { command: 'toggle', description: 'Bật/Tắt form gửi bài' },
    { command: 'list', description: 'Xem danh sách bài hát' },
    { command: 'reset', description: 'Xóa toàn bộ danh sách' }
  ]).catch(err => console.error('Lỗi thiết lập menu lệnh:', err));

  bot.telegram.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: '𝄞 Mở GEMS Radio',
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

// Security headers (X-Frame-Options, nosniff, HSTS, ...)
// connectSrc cho phép Telegram Widget + YouTube iframe + Socket.IO;
// frameSrc cho phép nhúng YouTube player.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // index.html hiện chứa JavaScript inline. Nếu không cho phép inline script,
      // toàn bộ code Telegram + Socket.IO phía client sẽ không chạy và UI sẽ
      // đứng mãi ở "⏳ Đang kết nối...".
      scriptSrc: ["'self'", "'unsafe-inline'", "https://telegram.org", "https://www.youtube.com", "https://s.ytimg.com"],
      connectSrc: ["'self'", "https://telegram.org", "https://www.youtube.com", "wss:", "ws:"],
      frameSrc: ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
      imgSrc: ["'self'", "data:", "https://i.ytimg.com"],
      styleSrc: ["'self'", "'unsafe-inline'"] // CSS đang viết inline trong <style>
    }
  },
  crossOriginEmbedderPolicy: false // cần cho YouTube iframe embed
}));

// Chống spam API: 60 request/phút cho mỗi IP.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' }
});
app.use('/api/', apiLimiter);

// Rate-limit theo USER Telegram: nhiều người dùng chung 1 IP (NAT/VPN)
// sẽ không làm cạn quota của nhau, và attacker không thể đổi IP để bypass.
// initData được verify chữ ký trước khi dùng để định danh.
function getTelegramUserIdFromRequest(req) {
  const initData = req.body?.initData || '';
  const auth = validateTelegramInitData(initData);
  return auth.valid ? `tg:${auth.user.id}` : null;
}

const { ipKeyGenerator } = require('express-rate-limit');

const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    getTelegramUserIdFromRequest(req) || ipKeyGenerator(req.ip),
  message: { success: false, message: 'Bạn đã gửi quá nhiều yêu cầu, vui lòng thử lại sau.' }
});
app.use('/api/', userLimiter);
app.use(express.static(path.join(__dirname, 'public')));


// ==================== ADMIN AUTH HELPER ====================
function requireTelegramAdmin(req, res) {
  const initData = req.body?.initData || '';
  const auth = validateTelegramInitData(initData);

  if (!auth.valid) {
    res.status(401).json({
      success: false,
      message: `Xác thực Telegram thất bại: ${auth.message}`
    });
    return { ok: false };
  }

  const telegramId = String(auth.user.id);
  if (!isAdmin(telegramId)) {
    res.status(403).json({
      success: false,
      message: 'Bạn không có quyền Admin.'
    });
    return { ok: false };
  }

  return { ok: true, user: auth.user };
}

// ==================== YOUTUBE TITLE ====================
async function getYouTubeTitle(url) {
  // Timeout 5s: tránh request /api/submit treo vĩnh viễn nếu YouTube chậm.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const oembedUrl =
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;

    const response = await fetch(oembedUrl, { signal: controller.signal });

    if (!response.ok) {
      console.warn(`⚠️ Không lấy được YouTube title: HTTP ${response.status}`);
      return 'Bài hát YouTube';
    }

    const data = await response.json();
    return data.title || 'Bài hát YouTube';
  } catch (error) {
    console.error('❌ Lỗi lấy YouTube title:', error);
    return 'Bài hát YouTube';
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== YOUTUBE URL VALIDATION ====================
// (Đã chuyển sang public/shared/youtube.js — dùng chung với client)
// Lưu ý: static middleware (dòng dưới) sẽ phục vụ /shared/youtube.js cho client.

// ==================== AUTO PLAY STATE ====================
// 0 = Tắt | 1 = Tuần tự | 2 = Ngẫu nhiên
let autoPlayMode = 0;
let autoPlayControllerSocketId = null;

function setAutoPlayState(mode, controllerSocketId = null) {
  autoPlayMode = Number(mode) || 0;
  autoPlayControllerSocketId = autoPlayMode === 0
    ? null
    : (controllerSocketId || null);
}

function broadcastAutoPlayState() {
  io.emit('autoPlayMode', {
    mode: autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId
  });
}

function broadcastState() {
  io.emit('stateUpdate', {
    isFormOpen,
    songs,
    lastWinner,
    lastAction,
    health: currentHealth,
    likes: currentLikeCount,
    dislikes: currentDislikeCount,
    replacementCountdown,
    autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId,
    blockedSongs,
    online: getOnlineSummary()
  });
}


// ==================== API: SUBMIT SONG ====================
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

  const auth = validateTelegramInitData(initData);
  if (!auth.valid) {
    return res.status(401).json({
      success: false,
      message: 'Xác thực Telegram thất bại!'
    });
  }

  const telegramUser = auth.user;
  const userName =
    [telegramUser.first_name, telegramUser.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Người dùng';

  const cleanUrl = String(url).trim();

  if (cleanUrl.length > 500) {
    return res.json({
      success: false,
      message: 'Link quá dài!'
    });
  }

  const youtubeVideoId = getYouTubeVideoId(cleanUrl);

  if (!youtubeVideoId) {
    return res.json({
      success: false,
      message: 'Link YouTube không hợp lệ!'
    });
  }

  try {
    // Phase 4A: kiểm tra blacklist ngay trên PostgreSQL trước khi cho phép INSERT.
    // Không chỉ dựa vào mảng blockedSongs trong RAM để tránh trường hợp state cũ.
    const blockedResult = await pool.query(
      `
        SELECT
          id,
          title,
          url,
          blocked_reason AS "blockedReason"
        FROM blocked_songs
        WHERE video_id = $1
        LIMIT 1
      `,
      [youtubeVideoId]
    );

    if (blockedResult.rowCount > 0) {
      const blockedSong = blockedResult.rows[0];
      const reasonText = blockedSong.blockedReason === 'health_zero'
        ? 'Sức khỏe của bài hát đã về 0.'
        : 'Bài hát đã bị Admin chặn.';

      console.log(
        `🚫 Từ chối submit bài đã blacklist: video_id=${youtubeVideoId}`
      );

      return res.json({
        success: false,
        message: `🚫 Bài hát này đang nằm trong blacklist. ${reasonText} Bạn cần được Admin gỡ chặn trước khi gửi lại.`
      });
    }

    const title = await getYouTubeTitle(cleanUrl);

    // ON CONFLICT: chống race-condition — hai request submit cùng bài
    // đồng thời thì chỉ một dòng được ghi, request kia báo trùng.
    const result = await pool.query(
      `
        INSERT INTO songs (
          url,
          video_id,
          title,
          user_name,
          telegram_id
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (video_id) DO NOTHING
        RETURNING
          id,
          url,
          title,
          user_name AS user,
          telegram_id AS "telegramId",
          created_at
      `,
      [
        cleanUrl,
        youtubeVideoId,
        title,
        userName,
        String(telegramUser.id)
      ]
    );

    if (result.rowCount === 0) {
      return res.json({
        success: false,
        message: '⚠️ Bài hát này đã tồn tại trong danh sách!'
      });
    }

    songs.push(result.rows[0]);
    songs.sort((a, b) => Number(a.id) - Number(b.id));
    broadcastState();

    console.log(
      `🎵 Đã lưu bài hát #${result.rows[0].id} vào PostgreSQL: ${cleanUrl}`
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Lỗi lưu bài hát vào PostgreSQL:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể lưu bài hát vào cơ sở dữ liệu!'
    });
  }
});

// ==================== API: AUTO PLAY MODE ====================
app.post('/api/auto-play-mode', async (req, res) => {
  const { mode, socketId } = req.body;
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const newMode = Number(mode);

  if (![0, 1, 2].includes(newMode)) {
    return res.status(400).json({
      success: false,
      message: 'Chế độ Auto Play không hợp lệ!'
    });
  }

  if (newMode === 0) {
    setAutoPlayState(0);
    broadcastAutoPlayState();
    broadcastState();

    console.log('⏹ Admin đã tắt Auto Play');

    return res.json({
      success: true,
      mode: 0,
      controllerSocketId: null
    });
  }

  if (!socketId || typeof socketId !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Thiếu socketId của thiết bị điều khiển.'
    });
  }

  setAutoPlayState(newMode, socketId);
  broadcastAutoPlayState();
  broadcastState();

  console.log(
    autoPlayMode === 1
      ? `🔢 Admin bật Auto Play TUẦN TỰ | controller=${socketId}`
      : `🔀 Admin bật Auto Play NGẪU NHIÊN | controller=${socketId}`
  );

  res.json({
    success: true,
    mode: autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId,
    hasCurrentSong: !!lastWinner
  });
});

// ==================== API: AUTO PLAY NEXT ====================
app.post('/api/auto-play-next', async (req, res) => {
  const { socketId, expectedSongId } = req.body;
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  if (autoPlayMode === 0) {
    return res.json({
      success: false,
      stopAutoPlay: true,
      message: 'Auto Play đang tắt.'
    });
  }

  if (!socketId || socketId !== autoPlayControllerSocketId) {
    return res.status(403).json({
      success: false,
      message: 'Không phải thiết bị Admin đang điều khiển Auto Play.'
    });
  }

  try {
    const currentId = lastWinner?.id != null
      ? String(lastWinner.id)
      : null;

    // Bảo vệ khỏi race-condition: nếu một lệnh Auto Play cũ vừa gửi
    // sau khi Admin/user đã bấm Play hoặc Spin, không được phép ghi đè
    // bài mới. Client phải xác nhận đúng bài vừa kết thúc.
    if (expectedSongId != null && currentId !== String(expectedSongId)) {
      return res.json({
        success: false,
        stale: true,
        message: 'Bỏ qua Auto Play cũ vì bài đang phát đã thay đổi.'
      });
    }

    const availableSongs = songs.filter(song =>
      !currentId || String(song.id) !== currentId
    );

    if (availableSongs.length === 0) {
      setAutoPlayState(0);
      broadcastAutoPlayState();
      broadcastState();

      console.log('⏹ Auto Play dừng: không còn bài tiếp theo.');

      return res.json({
        success: false,
        stopAutoPlay: true,
        message: 'Không còn bài hát tiếp theo.'
      });
    }

    let nextSong;

    if (autoPlayMode === 1) {
      // Tuần tự: songs được giữ theo id ASC, nên lấy bài đầu tiên còn lại.
      nextSong = availableSongs[0];
    } else {
      const randomIndex = Math.floor(Math.random() * availableSongs.length);
      nextSong = availableSongs[randomIndex];
    }

    if (lastWinner && String(lastWinner.id) !== String(nextSong.id)) {
      await pool.query('DELETE FROM songs WHERE id = $1', [lastWinner.id]);
      songs = songs.filter(song => String(song.id) !== String(lastWinner.id));
      console.log(`🗑️ Auto Play xóa bài cũ #${lastWinner.id}`);
    }

    // Reset vote cũ đọng của bài kế tiếp để health luôn bắt đầu từ 5.
    await pool.query('DELETE FROM song_votes WHERE song_id = $1', [nextSong.id]);

    lastWinner = nextSong;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    lastAction = null;
    clearReplacementCountdown();

    io.emit('songPlayed', {
      song: nextSong,
      initiatorSocketId: autoPlayControllerSocketId,
      action: null,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null
    });

    broadcastState();

    console.log(
      autoPlayMode === 1
        ? `🔢 Auto tuần tự → #${nextSong.id}`
        : `🔀 Auto ngẫu nhiên → #${nextSong.id}`
    );

    res.json({
      success: true,
      song: nextSong,
      mode: autoPlayMode
    });
  } catch (error) {
    console.error('❌ Lỗi Auto Play Next:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể phát bài tiếp theo.'
    });
  }
});

// ==================== API: PLAY ONE SONG ====================
// Tất cả user đều được phép phát.
// Người bấm Play nghe tiếng; các client khác phát mute.
app.post('/api/play-song', async (req, res) => {
  const { id, initData, socketId } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'Thiếu ID bài hát!'
    });
  }

  const auth = validateTelegramInitData(initData);
  if (!auth.valid) {
    return res.status(401).json({
      success: false,
      message: `Xác thực Telegram thất bại: ${auth.message}`
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        id,
        url,
        title,
        user_name AS user,
        telegram_id AS "telegramId",
        created_at
      FROM songs
      WHERE id = $1
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy bài hát!'
      });
    }

    const song = result.rows[0];

    if (lastWinner && String(lastWinner.id) !== String(song.id)) {
      await pool.query('DELETE FROM songs WHERE id = $1', [lastWinner.id]);
      songs = songs.filter(s => String(s.id) !== String(lastWinner.id));
      console.log(`🗑️ Đã xóa bài đang phát #${lastWinner.id}`);
    }

    // Reset vote cũ đọng để health của bài này luôn bắt đầu từ 5.
    await pool.query('DELETE FROM song_votes WHERE song_id = $1', [song.id]);

    lastWinner = song;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    clearReplacementCountdown();

    const userName =
      [auth.user.first_name, auth.user.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || 'Người dùng';

    lastAction = { type: 'play', user: userName };

    // Nếu Admin đang bật Auto Play thì vẫn giữ mode,
    // nhưng bài Play thủ công thay thế bài đang phát hiện tại.
    io.emit('songPlayed', {
      song,
      initiatorSocketId: socketId || null,
      action: lastAction,
      health: 5,
      likes: 0,
      dislikes: 0,
      replacementCountdown: null
    });

    broadcastState();

    console.log(`▶️ Phát bài hát #${song.id}: ${song.title || song.url}`);

    res.json({
      success: true,
      song
    });
  } catch (error) {
    console.error('❌ Lỗi phát bài hát:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể phát bài hát!'
    });
  }
});

// ==================== API: SONG HEALTH / LIKE / DISLIKE ====================
app.post('/api/song-vote', async (req, res) => {
  const { vote } = req.body || {};
  const auth = validateTelegramInitData(req.body?.initData || '');

  if (!auth.valid) {
    return res.status(401).json({
      success: false,
      message: `Xác thực Telegram thất bại: ${auth.message}`
    });
  }

  const requestedVote = Number(vote);
  if (![1, -1].includes(requestedVote)) {
    return res.status(400).json({
      success: false,
      message: 'Loại vote không hợp lệ!'
    });
  }

  const runVote = async () => {
    if (!lastWinner) {
      return {
        success: false,
        status: 400,
        message: 'Hiện chưa có bài hát đang phát.'
      };
    }

    const songId = lastWinner.id;
    const telegramId = String(auth.user.id);
    const previousVote = await getUserVote(songId, telegramId);
    let newVote = requestedVote;

    // LIKE = +1 | DISLIKE = -1.
    // Mỗi Telegram user chỉ có một vote cho bài hiện tại.
    // Bấm lại cùng nút = bỏ vote; bấm nút đối diện = đổi vote.
    if (previousVote === requestedVote) {
      await pool.query(
        'DELETE FROM song_votes WHERE song_id = $1 AND telegram_id = $2',
        [songId, telegramId]
      );
      newVote = 0;
    } else {
      await pool.query(`
        INSERT INTO song_votes (song_id, telegram_id, vote)
        VALUES ($1, $2, $3)
        ON CONFLICT (song_id, telegram_id)
        DO UPDATE SET vote = EXCLUDED.vote
      `, [songId, telegramId, requestedVote]);
    }

    const stats = await refreshCurrentSongHealth();

    // Máu trở lại trên 0 → hủy đếm ngược thay bài.
    if (currentHealth > 0) {
      if (replacementTimer) {
        clearReplacementCountdown();
        broadcastReplacementCountdown();
      }
    }

    // Máu chạm 0 → bắt đầu đếm ngược 10 giây.
    if (currentHealth === 0) {
      startReplacementCountdown();
    }

    await broadcastHealthOnly();
    broadcastState();

    return {
      success: true,
      replaced: false,
      health: currentHealth,
      likes: currentLikeCount,
      dislikes: currentDislikeCount,
      replacementCountdown,
      userVote: newVote
    };
  };

  const run = voteQueue.then(runVote, runVote);
  voteQueue = run.catch(() => {});
  const result = await run;

  if (result.status) return res.status(result.status).json(result);
  return res.json(result);
});

// ==================== API: SPIN ====================
app.post('/api/spin', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const { socketId } = req.body || {};
  const userName =
    [auth.user.first_name, auth.user.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Người dùng';

  try {
    const result = await performSpin(socketId || null, userName);
    res.json(result);
  } catch (error) {
    console.error('❌ Lỗi Spin:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể quay vòng quay!'
    });
  }
});

// ==================== API: TOGGLE FORM ====================
app.post('/api/toggle-form', (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  isFormOpen = !isFormOpen;
  broadcastState();
  res.json({ success: true, isFormOpen });
});

// ==================== API: RESET ====================
app.post('/api/reset', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  try {
    await pool.query('DELETE FROM songs');

    songs = [];
    lastWinner = null;
    lastAction = null;
    currentHealth = 5;
    currentLikeCount = 0;
    currentDislikeCount = 0;
    clearReplacementCountdown();

    // Reset cũng tắt Auto Play để không tự phát lại sau khi reset.
    setAutoPlayState(0);
    broadcastAutoPlayState();
    broadcastState();

    console.log('🧹 Đã xóa toàn bộ bài hát khỏi PostgreSQL');

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Lỗi reset PostgreSQL:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể xóa danh sách bài hát!'
    });
  }
});

// ==================== API: DELETE ONE SONG ====================
app.post('/api/delete-song', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const { id } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'Thiếu ID bài hát!'
    });
  }

  try {
    const result = await blockSongAndRemove(id, 'manual_delete');

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy bài hát!'
      });
    }

    // Nếu xóa chính bài đang phát, xóa luôn trạng thái current winner.
    if (lastWinner && String(lastWinner.id) === String(id)) {
      lastWinner = null;
      lastAction = null;
      currentHealth = 5;
      currentLikeCount = 0;
      currentDislikeCount = 0;
      clearReplacementCountdown();
    }

    broadcastState();

    console.log(`🗑️ Admin đã xóa bài hát #${id} và đưa vào blacklist`);

    res.json({
      success: true,
      message: 'Đã xóa bài hát và đưa vào blacklist!'
    });
  } catch (error) {
    console.error('❌ Lỗi xóa bài hát:', error);
    res.status(500).json({
      success: false,
      message: 'Không thể xóa bài hát!'
    });
  }
});


// ==================== API: UNBLOCK ONE SONG ====================
app.post('/api/unblock-song', async (req, res) => {
  const auth = requireTelegramAdmin(req, res);
  if (!auth.ok) return;

  const { id } = req.body || {};
  const normalizedId = Number.parseInt(id, 10);

  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'ID blacklist không hợp lệ!'
    });
  }

  try {
    const result = await pool.query(`
      DELETE FROM blocked_songs
      WHERE id = $1
      RETURNING
        id,
        video_id AS "videoId",
        url,
        title,
        user_name AS user,
        telegram_id AS "telegramId",
        blocked_reason AS "blockedReason",
        blocked_at AS "blockedAt"
    `, [normalizedId]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy bài hát trong blacklist!'
      });
    }

    const unblockedSong = result.rows[0];

    blockedSongs = blockedSongs.filter(
      item => String(item.id) !== String(normalizedId)
    );

    // Gỡ chặn KHÔNG tự động đưa bài hát trở lại danh sách songs.
    broadcastState();

    console.log(
      `🔓 Admin đã gỡ chặn bài hát #${normalizedId}: ${unblockedSong.title || unblockedSong.url}`
    );

    return res.json({
      success: true,
      message: 'Đã gỡ chặn bài hát! Hãy gửi lại link nếu muốn thêm bài này.',
      song: unblockedSong
    });
  } catch (error) {
    console.error('❌ Lỗi gỡ chặn bài hát:', error);
    return res.status(500).json({
      success: false,
      message: 'Không thể gỡ chặn bài hát!'
    });
  }
});


// ==================== SOCKET.IO ====================
// Gửi state hiện tại cho 1 socket (dùng sau khi xác thực hoặc cho view-only).
function sendInitialState(socket) {
  socket.emit('stateUpdate', {
    isFormOpen,
    songs,
    lastWinner,
    lastAction,
    health: currentHealth,
    autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId,
    blockedSongs
  });

  socket.emit('autoPlayMode', {
    mode: autoPlayMode,
    controllerSocketId: autoPlayControllerSocketId
  });
}

io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // Không emit state cho socket CHƯA xác thực initData — chỉ sau khi
  // authenticate thành công mới gửi state hiện tại (chống rò rỉ dữ liệu
  // cho bất kỳ ai mở kết nối websocket thuần).

  socket.on('authenticate', (payload = {}) => {
    const initData = payload.initData || '';
    const deviceInfo = payload.deviceInfo || {};
    console.log(
      `🔑 Authenticate received: socket=${socket.id}, initDataLength=${initData.length}`
    );

    const auth = validateTelegramInitData(initData);

    if (!auth.valid) {
      console.log('❌ Telegram authentication failed:', auth.message);
      socket.emit('adminStatus', {
        isAdmin: false,
        authenticated: false,
        message: auth.message
      });

      // Khởi động Telegram initData (vd: mở ngoài Telegram bằng trình duyệt)
      // -> vẫn gửi state ở chế độ CHỈ XEM để app không treo ở "Đang kết nối".
      // Các thao tác ghi (submit/vote/play/spin) vẫn bị chặn ở HTTP API.
      // Luôn gửi state cho socket chưa xác thực để frontend không bị treo
      // ở trạng thái chờ nếu Telegram initData bị lỗi/đến trễ.
      // Các thao tác ghi vẫn phải qua HTTP API + validateTelegramInitData.
      console.log('👀 View-only socket:', socket.id);
      sendInitialState(socket);
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

    addOnlineUser(socket, auth.user, deviceInfo);
    broadcastOnlineSummary();

    // Gửi state hiện tại cho socket vừa xác thực.
    sendInitialState(socket);

    (async () => {
      if (!lastWinner) {
        socket.emit('songHealth', { songId: null, health: 5, likes: 0, dislikes: 0, replacementCountdown: null, userVote: 0 });
        return;
      }
      try {
        const userVote = await getUserVote(lastWinner.id, telegramId);
        socket.emit('songHealth', {
          songId: lastWinner.id,
          health: currentHealth,
          likes: currentLikeCount,
          dislikes: currentDislikeCount,
          replacementCountdown,
          userVote
        });
      } catch (error) {
        console.error('❌ Lỗi lấy vote hiện tại:', error);
      }
    })();
  });

  socket.on('requestOnlineDetails', () => {
    const authState = socketAuth.get(socket.id);

    if (!authState?.isAdmin) {
      return;
    }

    socket.emit('onlineDetails', {
      users: getOnlineDetails(),
      summary: getOnlineSummary()
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Socket disconnected: ${socket.id} | ${reason}`);

    removeOnlineUser(socket.id, true);

    if (socket.id === autoPlayControllerSocketId) {
      setAutoPlayState(0);
      broadcastAutoPlayState();
      broadcastState();

      console.log('⏹ Auto Play tự tắt vì Admin điều khiển đã thoát.');
    }
  });
});


const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDatabase();
    await loadSongsFromDatabase();
    await loadBlockedSongsFromDatabase();

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🎵 Songs loaded: ${songs.length}`);
      console.log(`🚫 Blacklist loaded: ${blockedSongs.length}`);
    });
  } catch (error) {
    console.error('❌ Không thể khởi động server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

// Tắt server an toàn khi Render/deploy gửi SIGTERM (Render deploy)
function shutdown(signal) {
  console.log(`🛑 Nhận ${signal}, đang tắt server...`);
  if (bot) {
    try { bot.stop(signal); } catch (_) {}
  }
  server.close(() => process.exit(0));
  // Không chờ quá 5 giây nếu còn socket treo
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.on('error', (error) => {
  console.error('❌ Lỗi HTTP server:', error);
  process.exit(1);
});

module.exports = {
  clampHealth,
  detectDeviceType,
  isAdmin,
  validateTelegramInitData,
  addOnlineUser,
  removeOnlineUser,
  getOnlineSummary,
  getOnlineDetails,
  onlineUsers,
  socketPresence,
  socketAuth
};
