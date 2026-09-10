const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// پوشه public برای فایل‌های ظاهر سایت
app.use(express.static('public'));

let players = [];
let choices = {};

io.on('connection', (socket) => {
    console.log('یک کاربر وصل شد:', socket.id);

    // محدود کردن اتاق به دو نفر
    if (players.length < 2) {
        players.push(socket.id);
        socket.emit('player-assigned', players.length); // بازیکن اول یا دوم
    } else {
        socket.emit('full', 'ظرفیت اتاق تکمیل است!');
        return;
    }

    // دریافت انتخاب بازیکن
    socket.on('make-choice', (data) => {
        choices[socket.id] = data.choice;

        // اگر هر دو بازیکن انتخاب کردن، نتیجه رو اعلام کن
        if (Object.keys(choices).length === 2) {
            const p1 = players[0];
            const p2 = players[1];
            
            const choice1 = choices[p1];
            const choice2 = choices[p2];

            let result1 = '';
            let result2 = '';

            if (choice1 === choice2) {
                result1 = result2 = 'مساوی!';
            } else if (
                (choice1 === 'سنگ' && choice2 === 'قیچی') ||
                (choice1 === 'کاغذ' && choice2 === 'سنگ') ||
                (choice1 === 'قیچی' && choice2 === 'کاغذ')
            ) {
                result1 = 'برنده شدید! 🎉';
                result2 = 'باختید! 😢';
            } else {
                result1 = 'باختید! 😢';
                result2 = 'برنده شدید! 🎉';
            }

            // ارسال نتیجه به هر دو بازیکن
            io.to(p1).emit('game-result', { yourChoice: choice1, opponentChoice: choice2, result: result1 });
            io.to(p2).emit('game-result', { yourChoice: choice2, opponentChoice: choice1, result: result2 });

            // پاک کردن انتخاب‌ها برای دور بعدی
            choices = {};
        }
    });

    // قطع ارتباط بازیکن
    socket.on('disconnect', () => {
        console.log('کاربر خارج شد:', socket.id);
        players = players.filter(id => id !== socket.id);
        choices = {};
        io.emit('opponent-left', 'حریف از بازی خارج شد.');
    });
});

server.listen(3000, () => {
    console.log('سرور روی پورت 3000 روشن شد: http://localhost:3000');
});