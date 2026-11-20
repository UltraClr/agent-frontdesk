import type { WaitingFor } from './contract.js';

export interface NativePendingRequest {
  sessionId: string;
  kind: WaitingFor;
  requestId?: string;
  turnId?: string;
  sessionTitle?: string;
  title?: string;
  project?: string;
  since?: number;
  desktopOnly?: boolean;
}

export interface InboxSource { href: string; title: string }

export type InboxSignal = (NativePendingRequest | {
  kind: 'delivery';
  operationId: string;
  sessionId?: string;
  turnId?: string;
  title?: string;
  sessionTitle?: string;
  since?: number;
}) & { engine: string; source?: InboxSource };

export interface InboxItem {
  id: string;
  engine: string;
  kind: WaitingFor | 'delivery';
  sessionId?: string;
  requestId?: string;
  turnId?: string;
  title?: string;
  sessionTitle?: string;
  project?: string;
  since: number;
  desktopOnly?: boolean;
  sources: InboxSource[];
}

export interface InboxView {
  items: InboxItem[];
  coverage: { engine: string; mode: 'native' | 'tracked'; checkedAt: number | null; offline: boolean }[];
}
