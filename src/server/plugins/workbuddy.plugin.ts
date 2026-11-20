import path from 'node:path';
import os from 'node:os';
import { WorkBuddyBridge, workBuddySendBlocked } from '../workbuddy-bridge.js';
import { firstExisting, readAppIcon } from '../services/app-assets.js';
import type { PluginAbout, PluginSetup } from '../../shared/contract.js';

const home = path.join(os.homedir(), '.workbuddy');
const appIcon = '/Applications/WorkBuddy.app/Contents/Resources/icon.icns';
const identity = { id: 'workbuddy', label: 'WorkBuddy', description: 'Tencent WorkBuddy desktop', priority: 45, accent: '#20A98D' };

export const about: PluginAbout = {
  ...identity,
  appIcon: () => appIcon,
  detect: config => firstExisting([path.join(config.workbuddyHome || home, 'workbuddy.db')]),
};

export const setup: PluginSetup = ({ config, registerEngine, registerAsset }) => {
  const bridge = new WorkBuddyBridge(config.workbuddyHome || home);
  const avatar = readAppIcon(appIcon);
  if (avatar) registerAsset?.('workbuddy-icon', () => avatar);
  registerEngine({
    ...identity,
    prefix: 'WB',
    iconUrl: '/api/agents/workbuddy/icon',
    character: avatar ? { kind: 'image', url: '/api/characters/workbuddy-icon' } : undefined,
    capabilities: { send: false, sendBlocked: workBuddySendBlocked, showInDesktop: true, models: false, reasoning: false, permissions: false },
    coordinator: { catalog: cwd => bridge.catalog(cwd), read: id => bridge.read(id) },
    status: () => ({ connected: bridge.available }),
    list: () => bridge.list(),
    projects: () => bridge.projects(),
    read: id => bridge.read(id),
    models: () => [],
    show: id => bridge.show(id),
    create: input => bridge.create(input),
    send: (id, input) => bridge.send(id, input),
  });
};
