// JSON-RPC 2.0 types, per https://www.jsonrpc.org/specification.
// Kept intentionally structural — MCP layers method/params on top.

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface BridgeConfig {
  endpoint: string;
  eventsEndpoint: string;
  bearer?: string;
  timeoutMs: number;
  debug: boolean;
  enableSse: boolean;
}

// JSON-RPC error codes we synthesise locally.
export const ERR_INTERNAL = -32603;
export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
// Server-defined range: -32000 to -32099. We reserve -32000 for auth failure.
export const ERR_AUTH = -32000;
