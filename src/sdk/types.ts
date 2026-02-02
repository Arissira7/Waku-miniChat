export type ConversationType = "direct" | "group";

export type Identity = {
  id: string;
  ed25519PrivateKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  x25519PrivateKey: Uint8Array;
  x25519PublicKey: Uint8Array;
};

export type Participant = {
  id: string;
  ed25519PublicKey: Uint8Array;
  x25519PublicKey: Uint8Array;
};

export type ConversationConfig = {
  id: string;
  type: ConversationType;
  participants: Participant[];
  sharedKeyBase64?: string;
  adminIds?: string[];
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  timestamp: number;
  revoked: boolean;
  deleted: boolean;
};

export type Tombstone = {
  targetMessageId: string;
  issuerId: string;
  timestamp: number;
};

export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "tombstone"; tombstone: Tombstone };
