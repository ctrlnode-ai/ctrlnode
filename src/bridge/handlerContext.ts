/** Callback used by handlers to send a response back to the SaaS. */
export type SendFn = (payload: any) => void;

/** Additional context injected by the WebSocket layer into async handlers. */
export type HandlerContext = {
  sendToSaas: SendFn;
  syncAgents: () => void;
};
