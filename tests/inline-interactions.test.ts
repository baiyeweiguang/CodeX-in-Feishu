import { afterEach, describe, expect, it } from 'vitest';
import { harness } from './helpers.js';
import { card, cardLayout, streamingCard } from '../src/adapters/feishu/client.js';

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('inline task interactions', () => {
  it.each(['允许本次', '拒绝'])('handles %s in the same card without sending an acknowledgement', async label => {
    h = await harness(); await h.send('/project a'); await h.app.delivery.tick();
    const before = h.transport.sent.length;
    await h.send('APPROVE');
    await h.pump(() => h!.transport.sent.at(-1)?.message.interactionId !== undefined);
    const main = h.transport.sent.at(-1)!;
    expect(main.message.streamPaused).toBe(true);
    expect(main.message.details?.[0]?.text).toContain('echo test');
    expect(h.app.store.list('outbox').some(d => d.logicalKey.startsWith('interaction:'))).toBe(false);
    const button = main.message.buttons!.find(b => b.label === label)!;
    await h.send('', { kind: 'action', actionToken: button.token });
    await h.pump(() => h!.app.store.list('tasks')[0]?.finalized === true);
    expect(h.transport.sent).toHaveLength(before + 1);
    expect(h.transport.sent.at(-1)?.id).toBe(main.id);
    expect(h.transport.sent.at(-1)?.message.text).toContain(label === '允许本次' ? 'accept' : 'decline');
    expect(h.transport.sent.at(-1)?.message.interactionId).toBeUndefined();
    expect(h.transport.sent.at(-1)?.message.buttons).toEqual([]);
  });
  it('queues simultaneous approvals without overwriting the first one', async () => {
    h = await harness(); await h.send('/project a'); await h.app.delivery.tick();
    const before = h.transport.sent.length; await h.send('APPROVE2');
    await h.pump(() => h!.app.store.list('interactions').length === 2 && Boolean(h!.transport.sent.at(-1)?.message.interactionId));
    const [first, second] = h.app.store.list('interactions');
    expect(h.transport.sent.at(-1)?.message.interactionId).toBe(first!.id);
    await h.send(`/approve ${first!.id}`);
    await h.pump(() => h!.transport.sent.at(-1)?.message.interactionId === second!.id);
    await h.send(`/deny ${second!.id}`);
    await h.pump(() => h!.app.store.list('tasks')[0]?.finalized === true);
    expect(h.transport.sent).toHaveLength(before + 1);
    expect(h.app.store.list('interactions').every(i => i.state === 'resolved')).toBe(true);
  });
  it('accepts an answer replying to the updated main card', async () => {
    h = await harness(); await h.send('/project a'); await h.app.delivery.tick();
    const before = h.transport.sent.length; await h.send('ASK');
    await h.pump(() => Boolean(h!.transport.sent.at(-1)?.message.interactionId));
    const main = h.transport.sent.at(-1)!;
    await h.send('A', { parentMessageId: main.id });
    await h.pump(() => h!.app.store.list('tasks')[0]?.finalized === true);
    expect(h.transport.sent).toHaveLength(before + 1);
    expect(h.app.store.list('tasks')[0]?.result).toContain('"answers":["A"]');
  });
  it('collapses bounded command and file history and keeps the answer short', async () => {
    h = await harness(); await h.send('/project a'); await h.app.delivery.tick();
    const before = h.transport.sent.length; await h.send('TOOLLOG');
    await h.pump(() => h!.app.store.list('tasks')[0]?.finalized === true);
    const message = h.transport.sent.at(-1)!.message;
    expect(h.transport.sent).toHaveLength(before + 1);
    expect(message.text).not.toContain('echo execution-');
    expect(h.app.store.list('task_events')).toHaveLength(12);
    expect(message.details?.[0]?.text).toContain('file-11.txt');
    expect(message.details?.[0]?.text).not.toContain('execution-0');
    const json = streamingCard(message) as any;
    const panel = json.body.elements.find((e: any) => e.tag === 'collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toContain('12 项');
  });
  it('updates structure only for buttons, panels or pause changes', () => {
    expect(cardLayout({ text: 'a' })).toBe(cardLayout({ text: 'ab' }));
    expect(cardLayout({ text: 'a' })).not.toBe(cardLayout({ text: 'a', streamPaused: true }));
    expect(cardLayout({ text: 'a' })).not.toBe(cardLayout({ text: 'a', buttons: [{ label: 'Allow', token: 'one' }] }));
    const fallback = card({ text: 'approval', streaming: true, streamPaused: true,
      details: [{ title: 'Details', text: 'command' }] }) as any;
    expect(fallback.config.streaming_mode).toBe(false);
    expect(fallback.body.elements[1].expanded).toBe(false);
  });
});
