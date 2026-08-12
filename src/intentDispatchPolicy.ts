export const INTENT_TO_PROVIDER_METHOD: Record<string, string> = {
  dispatch_task: 'sessions.send',
  agent_command: 'sessions.send',
  generate_graph_blueprint: 'graph.generate',
  init_ping: 'sessions.send',
};

export function getIntentProviderMethod(intentType: string): string | undefined {
  return INTENT_TO_PROVIDER_METHOD[intentType];
}
