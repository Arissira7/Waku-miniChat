import { createLightNode, Protocols } from "@waku/sdk";
import type { CreateNodeOptions } from "@waku/interfaces";
import type {
  IDecodedMessage,
  IDecoder,
  IEncoder,
  LightNode
} from "@waku/sdk";
import {
  canonicalId,
  createIdentity,
  decryptPayload,
  deriveDirectKey,
  deriveGroupKey,
  encryptPayload,
  fromBase64,
  signPayload,
  textEncoder,
  toBase64,
  verifyPayload
} from "./crypto.js";
import type { ChatEvent, ChatMessage, ConversationConfig, Identity, Tombstone } from "./types.js";

type WireMessage = {
  v: 1;
  type: "chat" | "tombstone";
  conversationId: string;
  messageId: string;
  senderId: string;
  senderEd25519: string;
  senderX25519: string;
  timestamp: number;
  nonce?: string;
  ciphertext?: string;
  targetMessageId?: string;
  signature: string;
};

type SubscriptionHandler = (event: ChatEvent) => void;

export type ChatClientConfig = {
  contentTopicPrefix?: string;
  bootstrapPeers?: string[];
  defaultBootstrap?: boolean;
  peerWaitTimeoutMs?: number;
  sendTimeoutMs?: number;
  sendMaxAttempts?: number;
  nodeOptions?: Partial<CreateNodeOptions>;
};

export class ChatClient {
  readonly identity: Identity;
  private waku?: LightNode;
  private config: Required<ChatClientConfig>;
  private conversations = new Map<string, ConversationConfig>();
  private handlers = new Map<string, Set<SubscriptionHandler>>();
  private decoderCache = new Map<string, IDecoder<IDecodedMessage>>();
  private encoderCache = new Map<string, IEncoder>();
  private messages = new Map<string, ChatMessage>();
  private subscribed = new Set<string>();
  private subscriptionPromises = new Map<string, Promise<void>>();
  private pendingTombstones = new Map<string, Tombstone>();

  constructor(identity?: Identity, config: ChatClientConfig = {}) {
    this.identity = identity ?? createIdentity();
    this.config = {
      contentTopicPrefix: config.contentTopicPrefix ?? "/waku-chat/1",
      bootstrapPeers: config.bootstrapPeers ?? [],
      defaultBootstrap: config.defaultBootstrap ?? true,
      peerWaitTimeoutMs: config.peerWaitTimeoutMs ?? 8000,
      sendTimeoutMs: config.sendTimeoutMs ?? 12000,
      sendMaxAttempts: config.sendMaxAttempts ?? 3,
      nodeOptions: config.nodeOptions ?? {}
    };
  }

  async init() {
    const nodeOptions: CreateNodeOptions = {
      ...this.config.nodeOptions,
      defaultBootstrap: this.config.defaultBootstrap,
      bootstrapPeers: this.config.bootstrapPeers
    };
    const node = await createLightNode({
      ...nodeOptions
    });
    await node.start();
    try {
      await this.withTimeout(
        node.waitForPeers([Protocols.LightPush, Protocols.Filter], this.config.peerWaitTimeoutMs),
        this.config.peerWaitTimeoutMs
      );
      this.waku = node;
    } catch (error) {
      await node.stop();
      throw new Error(
        `Failed to connect to Waku peers within ${this.config.peerWaitTimeoutMs}ms. ` +
          "Ensure the local node is running or WAKU_BOOTSTRAP is set.",
        { cause: error }
      );
    }
  }

  async stop() {
    if (this.waku?.isStarted()) {
      await this.waku.stop();
    }
  }

  joinConversation(config: ConversationConfig) {
    this.conversations.set(config.id, config);
  }

  leaveConversation(conversationId: string) {
    this.conversations.delete(conversationId);
    this.handlers.delete(conversationId);
    this.subscribed.delete(conversationId);
    this.subscriptionPromises.delete(conversationId);
  }

  subscribe(conversationId: string, handler: SubscriptionHandler) {
    const handlers = this.handlers.get(conversationId) ?? new Set<SubscriptionHandler>();
    handlers.add(handler);
    this.handlers.set(conversationId, handlers);
    void this.ensureSubscribed(conversationId);
    return () => {
      const set = this.handlers.get(conversationId);
      if (set) {
        set.delete(handler);
      }
    };
  }

  async waitForSubscription(conversationId: string) {
    await this.ensureSubscribed(conversationId);
  }

  getMessage(messageId: string) {
    return this.messages.get(messageId);
  }

  listMessages(conversationId: string) {
    return Array.from(this.messages.values()).filter(
      (message) => message.conversationId === conversationId && !message.deleted
    );
  }

  deleteMessage(messageId: string) {
    const message = this.messages.get(messageId);
    if (message) {
      message.deleted = true;
    }
  }

  async sendMessage(conversationId: string, plaintext: string) {
    const conversation = this.getConversation(conversationId);
    const key = this.deriveConversationKey(conversation);
    const { nonce, ciphertext } = encryptPayload(plaintext, key);
    const timestamp = Date.now();
    const messageId = canonicalId([conversationId, this.identity.id, nonce, ciphertext, `${timestamp}`]);
    const envelopeBase = {
      v: 1 as const,
      type: "chat" as const,
      conversationId,
      messageId,
      senderId: this.identity.id,
      senderEd25519: toBase64(this.identity.ed25519PublicKey),
      senderX25519: toBase64(this.identity.x25519PublicKey),
      timestamp,
      nonce,
      ciphertext
    };
    const signature = signPayload(envelopeBase, this.identity.ed25519PrivateKey);
    const envelope: WireMessage = { ...envelopeBase, signature };
    const message: ChatMessage = {
      id: messageId,
      conversationId,
      senderId: this.identity.id,
      text: plaintext,
      timestamp,
      revoked: false,
      deleted: false
    };
    this.messages.set(messageId, message);
    this.emit(conversationId, { type: "message", message });
    await this.publish(conversationId, envelope);
    return messageId;
  }

  async revokeMessage(conversationId: string, targetMessageId: string) {
    const conversation = this.getConversation(conversationId);
    const message = this.messages.get(targetMessageId);
    const issuerId = this.identity.id;
    if (!message) {
      throw new Error("Message not found");
    }
    if (!this.canRevoke(conversation, issuerId, message.senderId)) {
      throw new Error("Not authorized to revoke");
    }
    const timestamp = Date.now();
    const envelopeBase = {
      v: 1 as const,
      type: "tombstone" as const,
      conversationId,
      messageId: canonicalId([conversationId, targetMessageId, issuerId, `${timestamp}`]),
      senderId: issuerId,
      senderEd25519: toBase64(this.identity.ed25519PublicKey),
      senderX25519: toBase64(this.identity.x25519PublicKey),
      timestamp,
      targetMessageId
    };
    const signature = signPayload(envelopeBase, this.identity.ed25519PrivateKey);
    const envelope: WireMessage = { ...envelopeBase, signature };
    this.applyTombstone(conversationId, {
      targetMessageId,
      issuerId,
      timestamp
    });
    await this.publish(conversationId, envelope);
  }

  private getConversation(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    return conversation;
  }

  private canRevoke(conversation: ConversationConfig, issuerId: string, originalSenderId: string) {
    if (issuerId === originalSenderId) {
      return true;
    }
    const admins = conversation.adminIds ?? [];
    return admins.includes(issuerId);
  }

  private deriveConversationKey(conversation: ConversationConfig) {
    if (conversation.type === "group") {
      if (!conversation.sharedKeyBase64) {
        throw new Error("Group conversation requires shared key");
      }
      const sharedKey = fromBase64(conversation.sharedKeyBase64);
      return deriveGroupKey(conversation.id, sharedKey);
    }
    const remote = conversation.participants.find((p) => p.id !== this.identity.id);
    if (!remote) {
      throw new Error("Direct conversation requires remote participant");
    }
    return deriveDirectKey(conversation.id, this.identity.x25519PrivateKey, remote.x25519PublicKey);
  }

  private async publish(conversationId: string, envelope: WireMessage) {
    const node = this.requireNode();
    const encoder = this.getEncoder(conversationId);
    const payload = textEncoder.encode(JSON.stringify(envelope));
    const sendPromise = node.lightPush.send(
      encoder,
      { payload, timestamp: new Date(envelope.timestamp) },
      { autoRetry: true, maxAttempts: this.config.sendMaxAttempts }
    );
    const result = await this.withTimeout(sendPromise, this.config.sendTimeoutMs);
    if (result.successes.length === 0) {
      throw new Error("LightPush send failed");
    }
  }

  private getEncoder(conversationId: string) {
    const cached = this.encoderCache.get(conversationId);
    if (cached) {
      return cached;
    }
    const node = this.requireNode();
    const contentTopic = this.contentTopicFor(conversationId);
    const encoder = node.createEncoder({ contentTopic });
    this.encoderCache.set(conversationId, encoder);
    return encoder;
  }

  private async ensureSubscribed(conversationId: string) {
    if (this.subscribed.has(conversationId)) {
      return;
    }
    const existing = this.subscriptionPromises.get(conversationId);
    if (existing) {
      await existing;
      return;
    }
    const promise = this.subscribeInternal(conversationId).catch((error) => {
      this.subscriptionPromises.delete(conversationId);
      throw error;
    });
    this.subscriptionPromises.set(conversationId, promise);
    await promise;
  }

  private async subscribeInternal(conversationId: string) {
    const node = this.requireNode();
    const decoder = this.getDecoder(conversationId);
    const success = await node.filter.subscribe([decoder], (message: IDecodedMessage) => {
      void this.handleDecodedMessage(conversationId, message);
    });
    if (!success) {
      throw new Error("Subscribe failed");
    }
    this.subscribed.add(conversationId);
  }

  private getDecoder(conversationId: string) {
    const cached = this.decoderCache.get(conversationId);
    if (cached) {
      return cached;
    }
    const node = this.requireNode();
    const contentTopic = this.contentTopicFor(conversationId);
    const decoder = node.createDecoder({ contentTopic });
    this.decoderCache.set(conversationId, decoder);
    return decoder;
  }

  private async handleDecodedMessage(conversationId: string, message: IDecodedMessage) {
    if (!message.payload) {
      return;
    }
    const payload = new Uint8Array(message.payload);
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as WireMessage;
    if (parsed.conversationId !== conversationId) {
      return;
    }
    const senderPublicKey = fromBase64(parsed.senderEd25519);
    const signaturePayload = this.signaturePayload(parsed);
    const signatureValid = verifyPayload(signaturePayload, parsed.signature, senderPublicKey);
    if (!signatureValid) {
      return;
    }
    if (parsed.type === "tombstone") {
      if (!parsed.targetMessageId) {
        return;
      }
      const tombstone: Tombstone = {
        targetMessageId: parsed.targetMessageId,
        issuerId: parsed.senderId,
        timestamp: parsed.timestamp
      };
      const conversation = this.getConversation(conversationId);
      if (this.canRevoke(conversation, tombstone.issuerId, this.messages.get(tombstone.targetMessageId)?.senderId ?? "")) {
        this.applyTombstone(conversationId, tombstone);
      }
      return;
    }
    if (!parsed.ciphertext || !parsed.nonce) {
      return;
    }
    const conversation = this.getConversation(conversationId);
    const key = this.deriveConversationKey(conversation);
    try {
      const text = decryptPayload(parsed.ciphertext, parsed.nonce, key);
      const chatMessage: ChatMessage = {
        id: parsed.messageId,
        conversationId,
        senderId: parsed.senderId,
        text,
        timestamp: parsed.timestamp,
        revoked: false,
        deleted: false
      };
      if (!this.messages.has(chatMessage.id)) {
        const tombstone = this.pendingTombstones.get(chatMessage.id);
        if (tombstone) {
          chatMessage.revoked = true;
        }
        this.messages.set(chatMessage.id, chatMessage);
        this.emit(conversationId, { type: "message", message: chatMessage });
      }
    } catch (error) {
      console.error(`[${this.identity.id.slice(0, 8)}] Decryption failed for message ${parsed.messageId} from ${parsed.senderId.slice(0, 8)} in ${conversationId}:`, error);
    }
  }

  private applyTombstone(conversationId: string, tombstone: Tombstone) {
    const message = this.messages.get(tombstone.targetMessageId);
    if (message) {
      message.revoked = true;
    } else {
      this.pendingTombstones.set(tombstone.targetMessageId, tombstone);
    }
    this.emit(conversationId, { type: "tombstone", tombstone });
  }

  private emit(conversationId: string, event: ChatEvent) {
    const handlers = this.handlers.get(conversationId);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(event);
    }
  }

  private contentTopicFor(conversationId: string) {
    return `${this.config.contentTopicPrefix}/${conversationId}/json`;
  }

  private signaturePayload(message: WireMessage) {
    if (message.type === "tombstone") {
      return {
        v: message.v,
        type: message.type,
        conversationId: message.conversationId,
        messageId: message.messageId,
        senderId: message.senderId,
        senderEd25519: message.senderEd25519,
        senderX25519: message.senderX25519,
        timestamp: message.timestamp,
        targetMessageId: message.targetMessageId
      };
    }
    return {
      v: message.v,
      type: message.type,
      conversationId: message.conversationId,
      messageId: message.messageId,
      senderId: message.senderId,
      senderEd25519: message.senderEd25519,
      senderX25519: message.senderX25519,
      timestamp: message.timestamp,
      nonce: message.nonce,
      ciphertext: message.ciphertext
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private requireNode() {
    if (!this.waku) {
      throw new Error("Client not initialized");
    }
    return this.waku;
  }
}
