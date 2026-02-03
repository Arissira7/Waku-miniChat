# Waku 迷你加密聊天

## 目录
- 环境准备
- 本地节点
- Demo 演示
- 自动化测试
- 交付清单

## 环境准备
- Node.js 20+
- Docker Desktop（`@waku/run` 通过 Docker 启动本地节点）

```bash
npm install
```

## 快速启动

本项目支持两种运行模式：

### 模式 A：本地开发模式（推荐，速度快）
需要安装并启动 Docker Desktop。

1. **启动本地节点**：
   ```bash
   npm run dev:node
   ```
2. **运行 Demo**（在另一个窗口）：
   ```bash
   # SDK 会自动检测并连接本地节点
   npm run demo:scenario
   ```

### 模式 B：公共网络模式（无需 Docker）
直接连接 Waku 公共测试网。

1. **运行 Demo**：
   ```bash
   npm run demo:scenario
   ```
   *注意：连接公共网络可能需要 10-20 秒来初始化，请耐心等待。*

---

## 进阶配置
### 手动指定节点地址
如果你想显式连接特定节点，可以设置环境变量：

```bash
WAKU_BOOTSTRAP="/ip4/127.0.0.1/tcp/8000/ws/p2p/..." npm run demo:scenario
```

如果有多个本地 peer，可用逗号分隔传入：

```bash
WAKU_BOOTSTRAP="/ip4/127.0.0.1/tcp/60000/ws/p2p/...,/ip4/127.0.0.1/tcp/60001/ws/p2p/..." npm run demo:scenario
```

不设置 `WAKU_BOOTSTRAP` 时，默认使用 Waku 网络的引导节点。
也可以执行 `npx @waku/run info` 获取本地节点连接地址。

输入
```bash
npm run demo:scenario
```
之后，Demo 会模拟 2 人单聊与 3 人群聊，包含撤回与删除逻辑。

## 自动化测试
先启动本地节点，再运行：

```bash
npm test
```

## 交付清单
- Chat SDK：`src/sdk`
- Demo：`src/demo/scenario.ts`
- 设计文档：`docs/design.md`
- 单元测试：`tests/chatClient.test.ts`
- 演示视频：`video/video.mov`
