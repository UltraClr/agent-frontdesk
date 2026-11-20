import type { Approval, Model, Project } from './contract.js';

export interface GroupMemberSetup {
  /** Omitted inherits the group workspace. Null uses the engine's discussion location. */
  workspace?: string | null;
  /** Omitted uses the native new-chat setting. */
  model?: string;
}

export interface GroupMemberOptions {
  projects: Pick<Project, 'name' | 'cwd'>[];
  models: Pick<Model, 'id' | 'name'>[];
  registeredProject: boolean;
  discussionFolder: boolean;
}

export interface GroupMember {
  engine: string;
  id: string;
  title: string;
  alias: string;
  /** A new enrollment gets a new ID even when it uses the same native chat. */
  enrollmentId?: string;
  cwd?: string;
  groups?: string[];
  /** A dedicated member keeps its group identity even before a native chat exists. */
  dedicated?: boolean;
  sessionId?: string;
  setup?: GroupMemberSetup;
  nativeSettings?: { cwd: string; model?: string };
  canEditSetup?: boolean;
}

export interface GroupEngine { id: string; label: string; canCreate: boolean; canHost: boolean }

export type GroupState = 'queued' | 'project' | 'confirming' | 'blocked' | 'ready';
export interface GroupSummary {
  id: string;
  href: string;
  name: string;
  topic: string;
  engine: string;
  sessionId: string | null;
  hostTitle?: string;
  canOpenHostDraft?: boolean;
  state: GroupState;
  directory: string;
  workspace?: string;
  members: GroupMember[];
  updated: number;
  latest: number;
  pending: number;
  paused: boolean;
  pinned?: boolean;
  issue?: string;
}

export interface GroupMessage {
  seq: number;
  id: string;
  kind: 'user' | 'host' | 'member' | 'notice';
  text: string;
  author: string;
  replyTo?: string;
  native?: { engine: string; id: string; turn: string };
  replaces?: string;
  sources?: string[];
  decision?: boolean;
}

export interface GroupDelivery {
  id: string;
  groupId: string;
  engine: string;
  target: string;
  question: string;
  kind: 'member' | 'host' | 'report';
  state: 'queued' | 'sent' | 'waiting' | 'blocked' | 'done';
  nativeTurn: string | null;
  dispatched: number | null;
  note: string;
  memberId?: string;
  creatingMember?: boolean;
  removedMember?: string;
  attention?: Pick<Approval, 'id' | 'title' | 'kind'>;
}

export interface GroupView extends GroupSummary {
  messages: GroupMessage[];
  deliveries: GroupDelivery[];
  before: number | null;
}
