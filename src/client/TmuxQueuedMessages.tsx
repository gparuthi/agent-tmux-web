import { X } from "lucide-react";

import type { TmuxQueuedMessageDto } from "../shared/api.js";

type TmuxQueuedMessagesProps = {
  messages: TmuxQueuedMessageDto[];
  onCancel: (id: string) => void;
};

// Messages atw is holding until the pane's agent finishes its turn, oldest (next to send) first.
export function TmuxQueuedMessages({ messages, onCancel }: TmuxQueuedMessagesProps) {
  if (messages.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Queued messages" className="tmux-queued">
      {messages.map((message) => (
        <li key={message.id}>
          <span className="tmux-queued-text" title={message.text}>{message.text}</span>
          <span className="tmux-queued-note">Queued for {message.agent} · will send when it finishes</span>
          <button aria-label="Cancel queued message" title="Cancel queued message" type="button" onClick={() => onCancel(message.id)}>
            <X size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
