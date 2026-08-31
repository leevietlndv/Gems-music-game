const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Trạng thái phòng phòng hát / trò chơi
let gameState = {
  users: [],           // Danh sách người chơi: [{ id, name, score }]
  playlist: [],        // Danh sách bài hát: [{ id, title, url, addedBy }]
  currentSong: null,   // Bài hát đang phát
  currentTurn: null,   // ID người chơi đang tới lượt quay/hát
  isPlaying: false
};

// Hàm lấy người chơi tiếp theo theo vòng tròn
function getNextUser(currentUserId) {
  if (gameState.users.length === 0) return null;
  const currentIndex = gameState.users.findIndex(u => u.id === currentUserId);
  const nextIndex = (currentIndex + 1) % gameState.users.length;
  return gameState.users[nextIndex].id;
}

// Hàm xử lý khi bài hát kết thúc hoặc khi chuyển lượt
function handleSongEnd() {
  if (gameState.playlist.length > 0) {
    // Lấy bài hát tiếp theo khỏi danh sách
    gameState.currentSong = gameState.playlist.shift();
    gameState.isPlaying = true;

    // Chuyển lượt sang người chơi tiếp theo (nếu có người trong phòng)
    if (gameState.users.length > 0) {
      gameState.currentTurn = getNextUser(gameState.currentTurn);
    }
  } else {
    // Hết bài hát trong hàng chờ
    gameState.currentSong = null;
    gameState.isPlaying = false;
  }

  // Phát trạng thái mới tới toàn bộ người dùng
  io.emit('game-state-update', gameState);
  io.emit('auto-spin-next', {
    currentSong: gameState.currentSong,
    currentTurn: gameState.currentTurn
  });
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Gửi trạng thái hiện tại cho người mới vào
  socket.emit('game-state-update', gameState);

  // 1. Thêm người dùng vào phòng
  socket.on('join-room', (userData) => {
    const newUser = {
      id: socket.id,
      name: userData.name || `User_${socket.id.slice(0, 4)}`,
      score: 0
    };
    gameState.users.push(newUser);

    // Nếu chưa có ai tới lượt, gán lượt cho người mới vào
    if (!gameState.currentTurn) {
      gameState.currentTurn = newUser.id;
    }

    io.emit('game-state-update', gameState);
  });

  // 2. Thêm bài hát vào playlist
  socket.on('add-song', (song) => {
    const newSong = {
      id: Date.now().toString(),
      title: song.title,
      url: song.url,
      addedBy: socket.id
    };
    gameState.playlist.push(newSong);

    // Nếu phòng đang rảnh và chưa phát bài nào, tự động phát bài vừa thêm
    if (!gameState.isPlaying && !gameState.currentSong) {
      handleSongEnd();
    } else {
      io.emit('game-state-update', gameState);
    }
  });

  // 3. Sự kiện kích hoạt quay (Spin) thủ công
  socket.on('spin-wheel', () => {
    // Chỉ cho phép người tới lượt thực hiện quay
    if (socket.id !== gameState.currentTurn) return;

    const randomIndex = Math.floor(Math.random() * gameState.users.length);
    const selectedUser = gameState.users[randomIndex];

    io.emit('spin-result', {
      selectedUser,
      spunBy: socket.id
    });
  });

  // 4. TÍCH HỢP MỚI: Nhận tín hiệu khi Client phát xong bài hát
  socket.on('song-ended', () => {
    console.log(`Song ended. Triggering auto-spin / next song.`);
    handleSongEnd();
  });

  // 5. Bỏ qua bài hát (Skip)
  socket.on('skip-song', () => {
    handleSongEnd();
  });

  // 6. Xử lý khi ngắt kết nối
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    gameState.users = gameState.users.filter(u => u.id !== socket.id);

    if (gameState.currentTurn === socket.id) {
      gameState.currentTurn = gameState.users.length > 0 ? gameState.users[0].id : null;
    }

    io.emit('game-state-update', gameState);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
