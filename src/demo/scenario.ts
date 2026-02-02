import { ChatClient, createIdentity } from "../sdk/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bootstrapPeers = process.env.WAKU_BOOTSTRAP
  ? process.env.WAKU_BOOTSTRAP.split(",").map((value) => value.trim()).filter(Boolean)
  : [];

const config = {
  defaultBootstrap: bootstrapPeers.length === 0,
  bootstrapPeers,
  peerWaitTimeoutMs: 20000,
  sendTimeoutMs: 20000,
  nodeOptions: bootstrapPeers.length
    ? {
        defaultBootstrap: false,
        bootstrapPeers,
        numPeersToUse: 2,
        libp2p: {
          filterMultiaddrs: false
        },
        networkConfig: {
          clusterId: 0,
          numShardsInCluster: 8
        }
      }
    : undefined
};

const run = async () => {
  const alice = new ChatClient(createIdentity(), config);
  const bob = new ChatClient(createIdentity(), config);
  const carol = new ChatClient(createIdentity(), config);

  await Promise.all([alice.init(), bob.init(), carol.init()]);

  const directId = "direct-alice-bob";
  const groupId = "group-abc";
  const groupKey = createIdentity().ed25519PrivateKey.slice(0, 32);
  const groupKeyBase64 = Buffer.from(groupKey).toString("base64");

  const participants = [
    {
      id: alice.identity.id,
      ed25519PublicKey: alice.identity.ed25519PublicKey,
      x25519PublicKey: alice.identity.x25519PublicKey
    },
    {
      id: bob.identity.id,
      ed25519PublicKey: bob.identity.ed25519PublicKey,
      x25519PublicKey: bob.identity.x25519PublicKey
    },
    {
      id: carol.identity.id,
      ed25519PublicKey: carol.identity.ed25519PublicKey,
      x25519PublicKey: carol.identity.x25519PublicKey
    }
  ];

  alice.joinConversation({
    id: directId,
    type: "direct",
    participants: participants.filter((p) => p.id !== carol.identity.id)
  });
  bob.joinConversation({
    id: directId,
    type: "direct",
    participants: participants.filter((p) => p.id !== carol.identity.id)
  });

  const groupConfig = {
    id: groupId,
    type: "group" as const,
    participants,
    sharedKeyBase64: groupKeyBase64,
    adminIds: [alice.identity.id]
  };
  alice.joinConversation(groupConfig);
  bob.joinConversation(groupConfig);
  carol.joinConversation(groupConfig);

  const logEvent = (label: string) => (event: { type: string; message?: { id: string; text: string } }) => {
    if (event.type === "message" && event.message) {
      console.log(`[${label}] msg ${event.message.id}: ${event.message.text}`);
    } else if (event.type === "tombstone") {
      console.log(`[${label}] tombstone`);
    }
  };

  alice.subscribe(directId, logEvent("alice-direct"));
  bob.subscribe(directId, logEvent("bob-direct"));
  alice.subscribe(groupId, logEvent("alice-group"));
  bob.subscribe(groupId, logEvent("bob-group"));
  carol.subscribe(groupId, logEvent("carol-group"));
  await Promise.all([
    alice.waitForSubscription(directId),
    bob.waitForSubscription(directId),
    alice.waitForSubscription(groupId),
    bob.waitForSubscription(groupId),
    carol.waitForSubscription(groupId)
  ]);

  console.log("Waiting for network mesh to stabilize...");
  await sleep(3000); // Give more time for GossipSub mesh to stabilize

  const msgId = await alice.sendMessage(directId, "hello bob");
  await sleep(1000);
  await bob.sendMessage(directId, "hi alice");
  await sleep(1000);
  await alice.revokeMessage(directId, msgId);
  await sleep(1000);
  bob.deleteMessage(msgId);

  await alice.sendMessage(groupId, "hello group");
  await sleep(1000);
  await bob.sendMessage(groupId, "bob here");
  await sleep(1000);
  await carol.sendMessage(groupId, "carol joined");
  await sleep(2000);

  await Promise.all([alice.stop(), bob.stop(), carol.stop()]);
};

run()
  .then(() => {
    console.log("\n✅ Demo scenario completed successfully.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
