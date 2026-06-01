const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION AT:', promise, 'REASON:', reason);
});

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8, // 100 MB limits for large map images
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const LOBBIES_FILE = path.join(__dirname, 'lobbies.json');
let lobbies = {};

function loadLobbies() {
    try {
        if (fs.existsSync(LOBBIES_FILE)) {
            const data = fs.readFileSync(LOBBIES_FILE, 'utf8');
            lobbies = JSON.parse(data);
            // Reset players array for all loaded lobbies since socket connections are gone
            for (let code in lobbies) {
                lobbies[code].players = [];
                if (!lobbies[code].fow) lobbies[code].fow = { enabled: false, reveals: [] };
            }
            console.log("Kalıcı odalar başarıyla yüklendi.");
        }
    } catch (err) {
        console.error("Odalar yüklenirken hata oluştu:", err);
    }
}

let saveTimeout = null;
function saveLobbies() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        fs.writeFile(LOBBIES_FILE, JSON.stringify(lobbies), (err) => {
            if (err) console.error("Kayıt hatası:", err);
            else console.log("Odalar başarıyla kaydedildi.");
        });
    }, 2000); // 2 saniye gecikmeli kayıt (Performans için)
}

loadLobbies();

io.on('connection', (socket) => {
  console.log('Kullanıcı bağlandı:', socket.id);

  // Lobiye Katılma
  socket.on('join_lobby', (lobbyCode, userId, playerData) => {
    socket.join(lobbyCode);
    socket.lobbyCode = lobbyCode;
    socket.userId = userId;
    
    if (!lobbies[lobbyCode]) {
      lobbies[lobbyCode] = { mapUrl: null, paths: [], icons: {}, players: [], fow: { enabled: false, reveals: [] } };
      saveLobbies();
    }
    
    // Aynı userId'ye sahip kopuk bağlantı varsa temizle, ama varsa avatarını koru
    const existingPlayer = lobbies[lobbyCode].players.find(p => p.userId === userId);
    const avatar = existingPlayer ? existingPlayer.avatar : null;
    lobbies[lobbyCode].players = lobbies[lobbyCode].players.filter(p => p.userId !== userId);
    
    // Yeni oyuncuyu ekle
    const newPlayer = { 
        userId: userId, 
        socketId: socket.id, 
        isSpeaking: false,
        avatar: avatar,
        character_sheet_id: playerData ? playerData.character_sheet_id : null,
        sheet_name: playerData ? playerData.sheet_name : null,
        hpCurrent: playerData ? playerData.hpCurrent : 0,
        hpMax: playerData ? playerData.hpMax : 10,
        username: playerData ? playerData.username : ('Oyuncu ' + userId)
    };
    lobbies[lobbyCode].players.push(newPlayer);
    
    console.log(`Kullanıcı ${userId} lobiye katıldı: ${lobbyCode}`, newPlayer);
    
    // 1. Yeni katılana mevcut odanın TÜM durumunu gönder (Init State)
    socket.emit('init_state', lobbies[lobbyCode]);
    
    // 2. Odadaki herkese GÜNCEL oyuncu listesini gönder
    io.to(lobbyCode).emit('player_list_update', lobbies[lobbyCode].players);
  });

  // Harita / Çizim güncellemeleri
  socket.on('canvas_update', (data) => {
    if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
    
    if (data.type === 'path') {
        lobbies[socket.lobbyCode].paths.push(data.data);
    } else if (data.type === 'map') {
        lobbies[socket.lobbyCode].mapUrl = data.url;
    }
    saveLobbies();
    
    // Herkes (kendisi DAHİL veya HARİÇ - duruma göre. Şu an HARİÇ yapıyoruz çünkü kendisi zaten çizdi)
    socket.to(socket.lobbyCode).emit('canvas_update', data);
  });

  // Harita gönderimini zorla tüm odaya yayınla (DM map yüklediğinde herkes görsün diye)
  socket.on('force_map_sync', (data) => {
      if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
      lobbies[socket.lobbyCode].mapUrl = data.url;
      saveLobbies();
  });

  // Haritayı temizle
  socket.on('clear_canvas', () => {
    if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
    
    // Sunucu tarafında her şeyi sıfırla
    lobbies[socket.lobbyCode].paths = [];
    lobbies[socket.lobbyCode].icons = {};
    lobbies[socket.lobbyCode].mapUrl = null;
    lobbies[socket.lobbyCode].fow = { enabled: false, reveals: [] };
    saveLobbies();
    
    socket.to(socket.lobbyCode).emit('clear_canvas');
  });

  // FOW Events
  socket.on('fow_toggle', (state) => {
    if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
    lobbies[socket.lobbyCode].fow.enabled = state;
    saveLobbies();
    socket.to(socket.lobbyCode).emit('fow_toggle', state);
  });

  socket.on('fow_sync_reveals', (newReveals) => {
    if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
    lobbies[socket.lobbyCode].fow.reveals = lobbies[socket.lobbyCode].fow.reveals.concat(newReveals);
    saveLobbies();
    socket.to(socket.lobbyCode).emit('fow_sync_reveals', newReveals);
  });

  socket.on('fow_clear', () => {
    if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
    lobbies[socket.lobbyCode].fow.reveals = [];
    saveLobbies();
    socket.to(socket.lobbyCode).emit('fow_clear');
  });

  // Obje silme (Eraser)
  socket.on('erase_object', (data) => {
      if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
      
      // Ikon ise server'dan sil
      if (data.id && lobbies[socket.lobbyCode].icons[data.id]) {
          delete lobbies[socket.lobbyCode].icons[data.id];
          saveLobbies();
      }
      
      // Çizim ise (path), silmek için array'den tam olarak o path'i bulmak zor olabilir. 
      // Basitlik için sadece client'lara silinmesini söylüyoruz. Client'lar koordinatlara göre silecek.
      socket.to(socket.lobbyCode).emit('erase_object', data);
  });

  // İkon Ekleme (Resimli Token)
  socket.on('add_icon', (data) => {
    if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
    lobbies[socket.lobbyCode].icons[data.id] = data; // data: { id, url, left, top }
    saveLobbies();
    socket.to(socket.lobbyCode).emit('add_icon', data);
  });

  // İkon sürükleme / Ekleme
  socket.on('icon_move', (data) => {
    if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
    
    lobbies[socket.lobbyCode].icons[data.id] = data;
    saveLobbies();
    socket.to(socket.lobbyCode).emit('icon_move', data);
  });
  
  // Zar Atma
  socket.on('roll_dice', (data) => {
    io.to(socket.lobbyCode).emit('dice_rolled', data);
  });

  // Ölçüm Aracı
  socket.on('ruler_update', (data) => {
    socket.to(socket.lobbyCode).emit('ruler_update', data);
  });

  // Karakter Kağıdı Güncellemesi
  socket.on('sheet_update', (data) => {
    socket.to(socket.lobbyCode).emit('sheet_update', data);
  });

  // Oyuncu Can Güncellemesi
  socket.on('player_hp_update', (data) => {
    console.log("player_hp_update received on server:", data);
    
    // Server hafızasındaki oyuncunun HP değerlerini güncelle
    if (socket.lobbyCode && lobbies[socket.lobbyCode]) {
        const player = lobbies[socket.lobbyCode].players.find(p => p.userId == data.userId);
        if (player) {
            player.hpCurrent = data.hpCurrent;
            player.hpMax = data.hpMax;
        }
    }
    
    socket.to(socket.lobbyCode).emit('player_hp_update', data);
  });

  // Ping Efekti
  socket.on('ping_map', (data) => {
    socket.to(socket.lobbyCode).emit('map_pinged', data);
  });

  // Konuşma durumu bildirimi
  socket.on('speaking_status', (isSpeaking) => {
      if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
      const player = lobbies[socket.lobbyCode].players.find(p => p.socketId === socket.id);
      if (player) {
          player.isSpeaking = isSpeaking;
          io.to(socket.lobbyCode).emit('player_list_update', lobbies[socket.lobbyCode].players);
      }
  });

  // WebRTC Sinyalleşme
  socket.on('webrtc_offer', (data) => {
    socket.to(data.targetSocket).emit('webrtc_offer', {
      offer: data.offer,
      senderSocket: socket.id,
      senderUserId: socket.userId
    });
  });

  socket.on('webrtc_answer', (data) => {
    socket.to(data.targetSocket).emit('webrtc_answer', {
      answer: data.answer,
      senderSocket: socket.id
    });
  });

  socket.on('webrtc_ice_candidate', (data) => {
    socket.to(data.targetSocket).emit('webrtc_ice_candidate', {
      candidate: data.candidate,
      senderSocket: socket.id
    });
  });

  // Avatar Güncelleme
  socket.on('update_avatar', (dataUrl) => {
      if (!socket.lobbyCode || !lobbies[socket.lobbyCode]) return;
      const player = lobbies[socket.lobbyCode].players.find(p => p.id === socket.id); // Wait, socket.userId or socket.id? Earlier it was socketId
      // Fix: the array uses socketId, so p.socketId === socket.id
      const p2 = lobbies[socket.lobbyCode].players.find(p => p.socketId === socket.id);
      if (p2) {
          p2.avatar = dataUrl;
          io.to(socket.lobbyCode).emit('player_list_update', lobbies[socket.lobbyCode].players);
      }
  });

  socket.on('disconnect', () => {
    console.log('Kullanıcı ayrıldı:', socket.id);
    if (socket.lobbyCode && lobbies[socket.lobbyCode]) {
      lobbies[socket.lobbyCode].players = lobbies[socket.lobbyCode].players.filter(p => p.socketId !== socket.id);
      io.to(socket.lobbyCode).emit('player_list_update', lobbies[socket.lobbyCode].players);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VTT WebSocket Sunucusu port ${PORT} üzerinde çalışıyor.`);
});
