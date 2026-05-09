export const INTENT_TO_PROVIDER_METHOD: Record<string, string> = {
  dispatch_task: 'sessions.send',
  agent_command: 'sessions.send',
  init_ping: 'sessions.send',
};

export function getIntentProviderMethod(intentType: string): string | undefined {
  return INTENT_TO_PROVIDER_METHOD[intentType];
}
