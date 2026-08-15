# 🃏 联网德州扑克 (Texas Hold'em Online)

网页版实时对战的德州扑克游戏。浏览器即点即玩，无需安装，支持真人对战与 AI 机器人陪练。

> 服务端权威游戏（Node.js + Socket.IO），防作弊，所有人看到同一副牌。

## ✨ 功能亮点

- **长牌 / 短牌(6+)双规则**：创建房间时可选，短牌自动切换牌型排名（同花>葫芦、三条>顺子）
- **AI 机器人陪练**：开局可添加机器人，输光自动借钱续玩，策略智能（含虚张声势）
- **实时牌力分析**：起手胜率（vs 1-9 人）、6 档手牌分级（SSS~D）、13×13 起手牌热力图、牌型大小排名
- **完整德州规则**：盲注/加注/全下/边池结算、筹码与欠款记账、断线自动弃牌
- **沉浸式体验**：自己座位固定中下方、操作历史可展开查看、结算面板完整展示 7 张牌
- **移动端适配**：横竖屏自适应、安全区适配、触控友好

## 🚀 快速开始（本地）

```bash
# 1. 安装依赖 (需要 Node.js >= 16)
npm install

# 2. 启动服务器
npm start          # 或 node server.js, 端口默认 3000

# 3. 浏览器打开
#    http://localhost:3000
```

- **局域网联机**：同一 WiFi 下访问 `http://本机IP:3000`（手机/电脑均可）
- **自定义端口**：`PORT=8080 npm start` 或 Windows 下 `set PORT=8080 && npm start`

## 🌍 公网部署（三选一）

### 方案 A：云服务器 / VPS（最自由）

```bash
# 上传代码后
npm install
npm start                    # 监听 3000 端口
# 配合 Nginx 反代 + 域名/HTTPS，或直接放行端口
```

### 方案 B：Render（免费，推荐新手）

1. 推送代码到 GitHub
2. Render → New → Web Service → 连接仓库
3. 配置：Runtime `Node`，Build `npm install`，Start `node server.js`，Instance `Free`
4. 2~3 分钟后获得公网地址 `https://xxx.onrender.com`

> 仓库已内置 `render.yaml`，在 Render 选择 **Blueprint** 部署可直接读取配置。

### 方案 C：Railway

1. New Project → Deploy from GitHub Repo → 选择本项目
2. 自动识别 `package.json`，无需额外配置
3. Settings → Networking → Generate Domain 获取公网地址

### 一键打包部署包

```bash
npm run deploy:package
# 生成 deploy/texas-holdem-deploy-日期.zip (不含 node_modules/开发文件)
# 上传 zip 到服务器 → 解压 → npm install → npm start
```

## 🧪 测试

```bash
# 全部单元/规则测试 (无需启动服务器)
npm test

# 端到端联调测试 (需先启动服务器)
npm run test:e2e
```

## 📁 项目结构

```
├── server.js              # 入口: Express + Socket.IO 服务
├── src/
│   ├── poker.js           # 牌型评估引擎 (长/短牌) + 胜率表
│   ├── game.js            # 房间/状态机/行动校验/边池结算/AI
│   ├── accounts.js        # 玩家账号与积分
│   └── auth.js            # 简易鉴权
├── public/                # 前端 (原生 JS, 无框架)
│   ├── index.html
│   ├── game.js
│   ├── style.css
│   ├── audio-engine.js    # 背景音乐/音效
│   └── music/             # 背景音乐 mp3
├── test/                  # 单元 + 联调测试 (20+ 个, npm test / npm run test:e2e)
├── docs/                  # 设计/优化文档
│   └── 游戏逻辑梳理与优化.md
└── scripts/               # 部署/运维脚本
    ├── package.js         # 部署打包 (npm run deploy:package)
    ├── daemon.js          # 崩溃自重启守护
    └── make-full-room.js  # 快速填满房间(测试用)
```

## ⚙️ 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口 |
| `ROOM_IDLE_TIMEOUT_MS` | 5 分钟 | 房间自动清理时限（代码内常量）|

游戏内：盲注 5/10 起、初始筹码 1000、最多 9 人/桌，均可按房间调整。

## 📄 文档

- [游戏逻辑梳理与优化](docs/游戏逻辑梳理与优化.md) - 牌型评估、状态机与结算逻辑的设计与优化笔记

## 📝 技术栈

Node.js · Express · Socket.IO · 原生前端 (HTML/CSS/JS) · 无数据库（内存存储，重启即清零，适合朋友间对战）

---

MIT License · 仅供学习交流与朋友娱乐使用
