import { loadConfig } from '../src/config/load.js';
import { makeLogger } from '../src/observability/logger.js';
import { FeishuTransport } from '../src/adapters/feishu/client.js';

const config = loadConfig();
const transport = new FeishuTransport(config, makeLogger(config.appSecret));
const initial = { title: 'Connector stream API test', text: 'Testing', streaming: true,
  buttons: [{ label: 'Test', token: 'diagnostic-unused-token' }] };
const cardId = await transport.createStream(initial);
const running = { ...initial, text: 'Testing native streaming' };
await transport.updateStream(cardId, running, 2, 'smoke', initial);
const approval = { ...initial, text: 'Approval UI test', streamPaused: true,
  buttons: [{ label: 'Allow once', token: 'unused-allow' }, { label: 'Deny', token: 'unused-deny' }],
  details: [{ title: 'Approval details', text: 'Command: echo test' }, { title: 'Execution records', text: 'Test command completed' }] };
await transport.updateStream(cardId, approval, 3, 'smoke', running);
await transport.updateStream(cardId, running, 4, 'smoke', approval);
await transport.updateStream(cardId, { ...running, text: 'Resumed streaming' }, 5, 'smoke', running);
await transport.updateStream(cardId, { ...initial, text: 'API test completed', streamDone: true, buttons: [], details: approval.details }, 6, 'smoke', running);
console.log(JSON.stringify({ create: true, streamUpdate: true, inlineApproval: true, collapsedDetails: true, resume: true, finalize: true, sentChatMessages: 0 }));
