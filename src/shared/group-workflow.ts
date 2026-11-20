import type { GroupDelivery, GroupDispatchStep, GroupMessage } from './groups.js';

export type GroupTemplate = 'proposals' | 'evidence';

export interface GroupTemplateInput {
  template: GroupTemplate;
  members: [string, string];
  roles: [string, string];
  material: string;
  criteria: string;
  sources: string[];
  summarize: boolean;
  language: 'zh' | 'en';
}

export interface GroupTemplatePreview {
  version: number;
  steps: { enrollment: string; member: string; engine: string; prompt: string; followsPrevious: boolean }[];
  sources: { id: string; text: string; author: string; truncated?: boolean }[];
}

export interface GroupResults {
  taskId: string;
  revision: number;
  entries: {
    id: string;
    label: string;
    engine?: string;
    message?: GroupMessage;
    delivery?: GroupDelivery;
    pending?: Exclude<GroupDispatchStep, { deliveryId: string }>['state'];
    adopted: boolean;
  }[];
}

export interface GroupMessagePage {
  messages: GroupMessage[];
  before: number | null;
}

export function templatePrompt(template: GroupTemplate, index: number, role: string, material: string, criteria: string, en: boolean) {
  const instructions = template === 'proposals'
    ? en ? ['Develop an independent proposal.', 'Develop an independent alternative proposal.']
      : ['独立给出一份完整提案。', '独立给出另一份完整提案。']
    : en ? ['State the claims and supporting evidence.', 'Verify the preceding member’s actual claims against the cited material and identify unresolved gaps.']
      : ['提出主张并列出支持证据。', '对照材料核查上一位成员实际提出的主张，指出仍待核实的部分。'];
  return [instructions[index], role, (en ? 'Material\n' : '材料\n') + material,
    (en ? 'Acceptance criteria\n' : '验收条件\n') + criteria].filter(Boolean).join('\n\n');
}
