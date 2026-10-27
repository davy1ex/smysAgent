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

export interface AssistantMessage {
  id: MessageId;
  sessionId: SessionId;
  sequence: number;
  role: "assistant";
  content: [TextContentPart];
  createdAt: string;
}

export type Message = UserMessage | AssistantMessage;

export interface SessionHistory {
  session: Session;
  messages: Message[];
}
