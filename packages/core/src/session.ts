export type SessionId = string;
export type MessageId = string;

export interface Session {
  id: SessionId;
  createdAt: string;
}

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface UserMessage {
  id: MessageId;
  sessionId: SessionId;
  sequence: number;
  role: "user";
  content: [TextContentPart];
  createdAt: string;
}

export interface SessionHistory {
  session: Session;
  messages: UserMessage[];
}
