const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isFormOpen = true;
let songs = [];
let lastWinner = null; // Lưu vết bài hát đang phát hiện tại

function broadcastState() {
  io.emit('stateUpdate', { isFormOpen, songs });
}

io.on('connection', (socket) => {
  socket.emit('stateUpdate', { isFormOpen, songs });
});

// API Nhận bài hát gửi lên
app.post('/api/submit', (req, res) => {
  if (!isFormOpen) {
    return res.json({ success: false, message: 'Form đã đóng, không thể gửi thêm!' });
  }
  const { url, user } = req.body;
  if (!url) {
    return res.json({ success: false, message: 'Vui lòng nhập link bài hát!' });
  }

  songs.push({ url, user: user || 'Người dùng' });
  broadcastState();
  res.json({ success: true });
});

// API Quay vòng quay
app.post('/api/spin', (req, res) => {
  // 1. Tự động xóa bài hát đang phát từ lượt quay trước khỏi danh sách
  if (lastWinner) {
    const index = songs.findIndex(s => s.url === lastWinner.url && s.user === lastWinner.user);
    if (index !== -1) {
      songs.splice(index, 1);
    }
    lastWinner = null; // Xóa xong thì reset vết
  }

  // 2. Kiểm tra nếu danh sách bài hát đã hết
  if (songs.length === 0) {
    broadcastState();
    return res.json({ success: false, message: 'Danh sách bài hát đã hết!' });
  }

  // 3. Chọn ngẫu nhiên bài hát mới từ các bài còn lại
  const selectedIndex = Math.floor(Math.random() * songs.length);
  const winner = songs[selectedIndex];
  
  // Ghi nhận bài hát mới trúng thưởng để phát
  lastWinner = winner;

  // Cập nhật lại vòng quay mới cho tất cả người dùng trước khi xoay
  broadcastState();

  // Kích hoạt hiệu ứng quay
  io.emit('triggerSpin', { selectedIndex, winner });
  res.json({ success: true });
});

// API Đóng/Mở Form
app.post('/api/toggle-form', (req, res) => {
  isFormOpen = !isFormOpen;
  broadcastState();
  res.json({ success: true });
});

// API Reset Game
app.post('/api/reset', (req, res) => {
  songs = [];
  lastWinner = null;
  broadcastState();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại port ${PORT}`);
});
