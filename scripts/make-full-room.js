/* 创建满员房间: 房主 + N 个机器人, 供 headless 截图验证真实布局
   用法: node scripts/make-full-room.js [人数=9]
   输出: 房间号
   依赖: node_modules/socket.io-client */
const PORT = process.env.PORT || 3000;
const TARGET = Math.max(2, Math.min(10, +(process.argv[2] || 10)));

(async () => {
  let io;
  try { io = require('socket.io-client'); }
  catch (e) { console.error('缺少 socket.io-client，请先: npm i socket.io-client'); process.exit(1); }

  const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
  const names = ['阿尔法', '贝塔', '伽马', '德尔塔', '艾普西龙', '泽塔', '伊塔', '西塔', '欧米伽'];

  socket.on('connect', () => {
    socket.emit('room:create', { name: '房主测试员', sb: 5, bb: 10, shortDeck: false }, async res => {
      if (!res || !res.ok) { console.error('创建失败', res); process.exit(1); }
      const roomId = res.roomId;
      console.log('房间', roomId, '已创建');
      let added = 0;
      const addNext = () => {
        if (added >= TARGET - 1) { done(roomId); return; }
        socket.emit('room:addbot', { name: names[added] }, r2 => {
          added++;
          setTimeout(addNext, 120);   // 错开加入, 避免服务端并发问题
        });
      };
      addNext();
    });
  });
  const done = roomId => {
    console.log(`共 ${TARGET} 人 (房主 + ${TARGET - 1} 机器人): 房间 ${roomId}`);
    console.log(`访问: http://localhost:${PORT}/?room=${roomId}&name=观战测试`);
    setTimeout(() => { socket.close(); process.exit(0); }, 800);
  };
  setTimeout(() => { console.error('超时'); process.exit(1); }, 15000);
})();
