import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appPlaces, firstExisting } from '../services/app-assets.js';
import { DshBridge } from '../dsh-bridge.js';
import type { Character, PluginAbout, PluginSetup } from '../../shared/contract.js';

// The installed desktop app's own bits, read at run time and never copied into the project.
const DEFAULT_APP = '/Applications/DeepSeek Harness.app';
const APP_ICON = path.join(DEFAULT_APP, 'Contents/Resources/icon.png');
const APP_ICNS = path.join(DEFAULT_APP, 'Contents/Resources/icon.icns');
const DATA_HOME = path.join(os.homedir(), '.dsh');

// Who this is, the same whether the agent is on or off (the engine below is registered with it).
const IDENTITY = { id: 'dsh', label: 'DeepSeek Harness', description: 'DeepSeek Harness desktop', priority: 40, accent: '#4D6BFE' } as const;

/** The agent as the console lists it before it is set up: found when this desktop app, or the data it keeps, is on this machine. */
export const about: PluginAbout = {
  ...IDENTITY,
  // The app's own icon, served by the host; nothing is copied into the project.
  appIcon: config => config.dshAppIcon || APP_ICNS,
  character: { kind: 'image', url: '/assets/characters/dsh.svg', standIn: true },
  detect: config => firstExisting([...appPlaces(config.dshAppAsar || path.join(DEFAULT_APP, 'Contents/Resources/app.asar')), config.dshHome || DATA_HOME]),
};

export const setup: PluginSetup = ({ config, registerEngine, registerAsset }) => {
  const bridge = new DshBridge({ home: config.dshHome || DATA_HOME, bridgeFile: config.dshBridgeFile });
  // The app's own icon as the character: its picture, read from the installed bundle when it is there.
  registerAsset?.('dsh-icon', () => {
    try {
      const file = config.dshAppIcon || APP_ICON;
      return fs.existsSync(file) ? { type: 'image/png', data: fs.readFileSync(file) } : null;
    } catch { return null; }
  });
  registerEngine({
    ...IDENTITY,
    prefix: 'DS',
    // The app's own whale, read from the installed bundle; the stand-in only appears without it.
    character: (): Character => (fs.existsSync(config.dshAppIcon || APP_ICON) ? { kind: 'image', url: '/api/characters/dsh-icon' } : { kind: 'image', url: '/assets/characters/dsh.svg', standIn: true }),
    skin: { stylesheet: '/skins/dsh/skin.css' },
    // How this desktop app writes a turn: the work folds under "Worked for …", commands are named
    // by kind, a turn's edits end in a diff card, and no times are shown under messages.
    look: { worked: 'fold', workingLive: true, toolCaption: 'kinds', diffCard: true, userTime: false, replyTime: 'none' },
    // The permission presets this desktop app offers (its own /permission command), with the app's
    // own values: a mode picked here is set in the app before the message goes out.
    permissionModes: [
      { id: 'read-only', label: '只读', description: '只能读文件和搜索，不能改动任何东西' },
      { id: 'workspace-write', label: '可写工作区', description: '可以在工作目录里改文件，越界前先问你' },
      { id: 'danger-full-access', label: '完全访问', description: '不再询问，直接执行所有操作' },
      { id: 'auto', label: '自动', description: '由桌面版自己判断哪些操作需要确认' },
    ],
    capabilities: {
      attachments: false, cwd: true, models: true, reasoning: true, interrupt: true, steer: true,
      approvals: true, send: true, openFile: false,
    },
    coordinator: { groupMember: { root: config.dshHome || DATA_HOME, catalog: cwd => bridge.catalog(cwd, true),
      prepareModel: (id, model) => bridge.prepareGroupModel(id, model) },
      catalog: cwd => bridge.catalog(cwd), read: id => bridge.read(id) },
    status: () => bridge.status(),
    models: () => bridge.getModels(),
    usage: () => bridge.getUsage(),
    list: () => bridge.list(),
    listWaiting: () => bridge.listWaiting(),
    projects: () => bridge.projects(),
    read: id => bridge.read(id),
    // A new chat is created in the desktop app (its own Session API) with the folder the person picked.
    create: input => bridge.create(input),
    send: (id, input) => bridge.send(id, input),
    observe: id => bridge.observe(id),
    steer: (id, input) => bridge.steer(id, input),
    interrupt: id => bridge.interrupt(id),
    // The agent's own question card: answered through the desktop app's question interface.
    decideNative: (sessionId, id, decision) => bridge.decide(sessionId, id, decision),
    blocked: id => bridge.sendBlockedReason(id),
  });
  return () => bridge.dispose();
};
