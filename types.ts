export interface ClaudeMessage {
  role: string;
  content: string | Array<Record<string, any>>;
}

export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
}

export interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: ClaudeTool[];
  stream?: boolean;
  system?: string | Array<Record<string, any>>;
}

export interface AccountCreate {
  label?: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
  other?: Record<string, any>;
  enabled?: boolean;
}

export interface AccountUpdate {
  label?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  other?: Record<string, any>;
  enabled?: boolean;
}

export interface Account {
  id: string;
  label?: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
  other?: string; // JSON string in DB
  last_refresh_time?: string;
  last_refresh_status?: string;
  created_at: string;
  updated_at: string;
  enabled: boolean;
  error_count: number;
  success_count: number;
}

export interface ChatMessage {
  role: string;
  content: any;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
}
