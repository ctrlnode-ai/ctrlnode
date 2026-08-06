/**
 * Collects Claude SDK assistant snapshots without forwarding them as task
 * activity. The SDK sends growing snapshots for a message, so each snapshot
 * replaces the previous value for the same assistant UUID.
 */
export class ClaudePlannerTextCollector {
  private currentMessageId: string | undefined;
  private currentText = '';
  private completedText = '';

  add(message: any): void {
    if (message?.type !== 'assistant') return;

    const messageId = message.uuid ?? message.message?.id;
    const content = message.message?.content ?? message.content ?? [];
    const text = (Array.isArray(content) ? content : [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text ?? '')
      .join('');
    if (!text) return;

    if (messageId && messageId !== this.currentMessageId) {
      this.completedText += this.currentText;
      this.currentMessageId = messageId;
      this.currentText = text;
      return;
    }

    this.currentText = text;
  }

  get text(): string {
    return this.completedText + this.currentText;
  }
}
