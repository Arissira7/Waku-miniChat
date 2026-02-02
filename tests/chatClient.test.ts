import { beforeEach, describe, expect, test, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const subscriptions = new Map<string, Set<(message: { payload?: Uint8Array }) => void>>();
  return {
    subscriptions,
    reset: () => subscriptions.clear()
  };
});

vi.mock("@waku/sdk", () => {
  const createLightNode = async () => {
    let started = false;
    return {
      start: async () => {
        started = true;
      },
      stop: async () => {
        started = false;
      },
      isStarted: () => started,
      waitForPeers: async () => undefined,
      createEncoder: ({ contentTopic }: { contentTopic: string }) => ({ contentTopic }),
      createDecoder: ({ contentTopic }: { contentTopic: string }) => ({ contentTopic }),
      lightPush: {
        send: async (
          encoder: { contentTopic: string },
          message: { payload?: Uint8Array }
        ) => {
          const handlers = mockState.subscriptions.get(encoder.contentTopic);
          if (handlers) {
            for (const handler of handlers) {
              handler({ payload: message.payload });
            }
          }
          return { successes: [{}] };
        }
      },
      filter: {
        subscribe: async (
          decoders: Array<{ contentTopic: string }>,
          callback: (message: { payload?: Uint8Array }) => void
        ) => {
          for (const decoder of decoders) {
            const set = mockState.subscriptions.get(decoder.contentTopic) ?? new Set();
            set.add(callback);
            mockState.subscriptions.set(decoder.contentTopic, set);
          }
          return true;
        }
      }
    };
  };
  return {
    Protocols: { LightPush: "LightPush", Filter: "Filter" },
    createLightNode
  };
});

import { ChatClient, createIdentity } from "../src/sdk/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getConfig = () => {
  const bootstrapPeers = process.env.WAKU_BOOTSTRAP ? [process.env.WAKU_BOOTSTRAP] : [];
  return {
    defaultBootstrap: bootstrapPeers.length === 0,
    bootstrapPeers,
    peerWaitTimeoutMs: 12000,
    sendTimeoutMs: 15000
  };
};

const waitForEvent = <T>(callback: (resolve: (value: T) => void) => void, timeoutMs: number) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    callback((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });

describe("ChatClient", () => {
  beforeEach(() => {
    mockState.reset();
  });
  test(
    "direct chat roundtrip",
    async () => {
      const alice = new ChatClient(createIdentity(), getConfig());
      const bob = new ChatClient(createIdentity(), getConfig());
      await Promise.all([alice.init(), bob.init()]);

      const conversationId = `direct-${Date.now()}`;
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
        }
      ];

      alice.joinConversation({ id: conversationId, type: "direct", participants });
      bob.joinConversation({ id: conversationId, type: "direct", participants });

      const bobReceived = waitForEvent<string>(
        (resolve) => {
          bob.subscribe(conversationId, (event) => {
            if (event.type === "message") {
              resolve(event.message.text);
            }
          });
        },
        20000
      );

      await Promise.all([alice.waitForSubscription(conversationId), bob.waitForSubscription(conversationId)]);
      await sleep(500);
      await alice.sendMessage(conversationId, "hello bob");
      const text = await bobReceived;
      expect(text).toBe("hello bob");

      await Promise.all([alice.stop(), bob.stop()]);
    },
    30000
  );

  test(
    "group broadcast",
    async () => {
      const alice = new ChatClient(createIdentity(), getConfig());
      const bob = new ChatClient(createIdentity(), getConfig());
      const carol = new ChatClient(createIdentity(), getConfig());
      await Promise.all([alice.init(), bob.init(), carol.init()]);

      const conversationId = `group-${Date.now()}`;
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

      const groupConfig = {
        id: conversationId,
        type: "group" as const,
        participants,
        sharedKeyBase64: groupKeyBase64,
        adminIds: [alice.identity.id]
      };
      alice.joinConversation(groupConfig);
      bob.joinConversation(groupConfig);
      carol.joinConversation(groupConfig);

      const bobReceived = waitForEvent<string>(
        (resolve) => {
          bob.subscribe(conversationId, (event) => {
            if (event.type === "message") {
              resolve(event.message.text);
            }
          });
        },
        20000
      );
      const carolReceived = waitForEvent<string>(
        (resolve) => {
          carol.subscribe(conversationId, (event) => {
            if (event.type === "message") {
              resolve(event.message.text);
            }
          });
        },
        20000
      );

      await Promise.all([
        alice.waitForSubscription(conversationId),
        bob.waitForSubscription(conversationId),
        carol.waitForSubscription(conversationId)
      ]);
      await sleep(500);
      await alice.sendMessage(conversationId, "hello group");
      const [bobText, carolText] = await Promise.all([bobReceived, carolReceived]);
      expect(bobText).toBe("hello group");
      expect(carolText).toBe("hello group");

      await Promise.all([alice.stop(), bob.stop(), carol.stop()]);
    },
    35000
  );

  test(
    "revoke message",
    async () => {
      const alice = new ChatClient(createIdentity(), getConfig());
      const bob = new ChatClient(createIdentity(), getConfig());
      await Promise.all([alice.init(), bob.init()]);

      const conversationId = `direct-revoke-${Date.now()}`;
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
        }
      ];

      alice.joinConversation({ id: conversationId, type: "direct", participants });
      bob.joinConversation({ id: conversationId, type: "direct", participants });

      let receivedMessageId = "";
      const revoked = waitForEvent<string>(
        (resolve) => {
          bob.subscribe(conversationId, (event) => {
            if (event.type === "message") {
              receivedMessageId = event.message.id;
            }
            if (event.type === "tombstone") {
              resolve(event.tombstone.targetMessageId);
            }
          });
        },
        20000
      );

      await Promise.all([alice.waitForSubscription(conversationId), bob.waitForSubscription(conversationId)]);
      await sleep(500);
      const messageId = await alice.sendMessage(conversationId, "to be revoked");
      await sleep(1000);
      await alice.revokeMessage(conversationId, messageId);
      const revokedId = await revoked;
      expect(revokedId).toBe(messageId);

      const message = bob.getMessage(receivedMessageId);
      expect(message?.revoked).toBe(true);

      await Promise.all([alice.stop(), bob.stop()]);
    },
    35000
  );
});
