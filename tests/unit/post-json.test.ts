import { describe, expect, it } from 'vitest';
import { createPostJson, POST_RULE_ID } from '../../src/background/post-json';
import { FrameSnapError } from '../../src/core/errors';

type Opts = chrome.declarativeNetRequest.UpdateRuleOptions;

function harness(reply: () => Response) {
  const calls: { op: 'add' | 'remove' | 'fetch'; arg: unknown }[] = [];
  const dnr = {
    updateSessionRules: async (o: Opts) => {
      calls.push({ op: o.addRules ? 'add' : 'remove', arg: o });
    },
  };
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ op: 'fetch', arg: { url, init } });
    return reply();
  };
  return { calls, post: createPostJson({ fetch, dnr }) };
}

describe('postJson', () => {
  it('sets headers with a rule scoped to the URL and to no tab, sends no cookies, then drops the rule', async () => {
    const h = harness(() => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const out = await h.post(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      { a: 1 },
      { 'User-Agent': 'UA' },
    );
    expect(out).toEqual({ ok: 1 });
    expect(h.calls.map((c) => c.op)).toEqual(['add', 'fetch', 'remove']);
    const rule = (h.calls[0]!.arg as Opts).addRules![0]!;
    expect(rule.id).toBe(POST_RULE_ID);
    expect(rule.condition).toMatchObject({
      urlFilter: '|https://www.youtube.com/youtubei/v1/player',
      tabIds: [-1],
    });
    expect(rule.action.requestHeaders).toEqual([
      { header: 'User-Agent', operation: 'set', value: 'UA' },
    ]);
    expect((h.calls[1]!.arg as { init: RequestInit }).init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      body: '{"a":1}',
    });
  });

  it('removes the rule and throws a typed error on an HTTP failure', async () => {
    const h = harness(() => new Response('no', { status: 403 }));
    await expect(h.post('https://www.youtube.com/x', {}, { Origin: 'o' })).rejects.toBeInstanceOf(
      FrameSnapError,
    );
    expect(h.calls.at(-1)!.op).toBe('remove');
  });

  it('adds no rule when there are no extra headers', async () => {
    const h = harness(() => new Response('{}', { status: 200 }));
    await h.post('https://www.youtube.com/x', {});
    expect(h.calls.map((c) => c.op)).toEqual(['fetch']);
  });
});
