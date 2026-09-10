const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ذخیره وضعیت اتاق‌ها
let rooms = {};

io.on('connection', (socket) => {
    console.log('کاربر متصل شد:', socket.id);

    // ساخت یا ورود به اتاق
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                scores: {},
                choices: {},
                gameType: 'rps' // پیش‌فرض سنگ کاغذ قیچی
            };
        }

        let room = rooms[roomId];

        if (room.players.length < 2) {
            room.players.push(socket.id);
            room.scores[socket.id] = { coins: 1000 }; // هر بازیکن ۱۰۰۰ سکه اولیه
            
            socket.emit('room-joined', { 
                playerNum: room.players.length, 
                coins: room.scores[socket.id].coins 
            });

            // اگر دو نفر کامل شدند، به هر دو اعلام کن بازی شروع بشه
            if (room.players.length === 2) {
                io.to(roomId).emit('start-game', { message: 'حریف متصل شد! بازی شروع شد.' });
            }
        } else {
            socket.emit('room-full', 'این اتاق پر است!');
        }
    });

    // تغییر نوع بازی (سنگ کاغذ قیچی یا تاس)
    socket.on('change-game', ({ roomId, gameType }) => {
        if (rooms[roomId]) {
            rooms[roomId].gameType = gameType;
            io.to(roomId).emit('game-type-changed', gameType);
        }
    });

    // دریافت انتخاب بازیکن (سنگ کاغذ قیچی یا تاس)
    socket.on('make-move', ({ roomId, move, betAmount }) => {
        let room = rooms[roomId];
        if (!room) return;

        room.choices[socket.id] = { move, betAmount };

        // اگر هر دو بازیکن حرکت خود را انجام دادند
        if (Object.keys(room.choices).length === 2) {
            const p1 = room.players[0];
            const p2 = room.players[1];

            const c1 = room.choices[p1];
            const c2 = room.choices[p2];

            let resultP1 = '';
            let resultP2 = '';
            let winnerId = null;

            if (room.gameType === 'rps') {
                // منطق سنگ کاغذ قیچی
                if (c1.move === c2.move) {
                    resultP1 = resultP2 = 'مساوی!';
                } else if (
                    (c1.move === 'سنگ' && c2.move === 'قیچی') ||
                    (c1.move === 'کاغذ' && c2.move === 'سنگ') ||
                    (c1.move === 'قیچی' && c2.move === 'کاغذ')
                ) {
                    resultP1 = 'برنده شدید! 🎉';
                    resultP2 = 'باختید! 😢';
                    winnerId = p1;
                } else {
                    resultP1 = 'باختید! 😢';
                    resultP2 = 'برنده شدید! 🎉';
                    winnerId = p2;
                }
            } else if (room.gameType === 'dice') {
                // منطق تاس انداختن (عدد بزرگتر برنده است)
                if (c1.move > c2.move) {
                    resultP1 = 'برنده شدید! 🎉';
                    resultP2 = 'باختید! 😢';
                    winnerId = p1;
                } else if (c2.move > c1.move) {
                    resultP1 = 'باختید! 😢';
                    resultP2 = 'برنده شدید! 🎉';
                    winnerId = p2;
                } else {
                    resultP1 = resultP2 = 'مساوی!';
                }
            }

            // محاسبه سکه‌ها بر اساس شرط
            let bet = parseInt(c1.betAmount) || 100;
            if (winnerId === p1) {
                room.scores[p1].coins += bet;
                room.scores[p2].coins -= bet;
            } else if (winnerId === p2) {
                room.scores[p2].coins += bet;
                room.scores[p1].coins -= bet;
            }

            // ارسال نتایج به هر دو بازیکن
            io.to(p1).emit('round-result', {
                myMove: c1.move,
                oppMove: c2.move,
                result: resultP1,
                myCoins: room.scores[p1].coins,
                oppCoins: room.scores[p2].coins
            });

            io.to(p2).emit('round-result', {
                myMove: c2.move,
                oppMove: c1.move,
                result: resultP2,
                myCoins: room.scores[p2].coins,
                oppCoins: room.scores[p1].coins
            });

            // پاک کردن انتخاب‌ها برای دور بعدی
            room.choices = {};
        }
    });

    socket.on('disconnect', () => {
        console.log('کاربر خارج شد:', socket.id);
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(id => id !== socket.id);
            if (rooms[roomId].players.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('opponent-left', 'حریف از بازی خارج شد.');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Professional Server running on port ${PORT}`);
});