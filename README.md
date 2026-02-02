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

## 本地节点
启动本地 nwaku 节点：

```bash
npm run dev:node
```

如需显式连接本地节点，可从上面命令输出的 `bootstrapPeers` 数组中找到地址（通常以 `/ws/p2p/` 结尾），并设置环境变量：

```bash
WAKU_BOOTSTRAP="/ip4/127.0.0.1/tcp/8000/ws/p2p/..." npm run demo:scenario
```

如果有多个本地 peer，可用逗号分隔传入：

```bash
WAKU_BOOTSTRAP="/ip4/127.0.0.1/tcp/60000/ws/p2p/...,/ip4/127.0.0.1/tcp/60001/ws/p2p/..." npm run demo:scenario
```

不设置 `WAKU_BOOTSTRAP` 时，默认使用 Waku 网络的引导节点。
也可以执行 `npx @waku/run info` 获取本地节点连接地址。

## Demo 演示
启动本地节点后，执行：

```bash
npm run demo:scenario
```

Demo 会模拟 2 人单聊与 3 人群聊，包含撤回与删除逻辑。

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
