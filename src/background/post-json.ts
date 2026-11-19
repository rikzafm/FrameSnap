/**
 * Cookie-less JSON POST from the service worker with headers fetch cannot set
 * (User-Agent, Origin). Those go through a declarativeNetRequest session rule
 * that lives only for the request, matches only that URL, and only requests
 * outside any tab, so no page the user has open is touched.
 */
import { httpError } from '../core/errors';

export interface SessionRulesApi {
  updateSessionRules(o: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void>;
}

export interface PostJsonDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  dnr: SessionRulesApi;
  /** Fixed id for the temporary rule; far above the per-job ids download.ts hands out. */
  ruleId?: number;
}

export const POST_RULE_ID = 1_000_000;

export function createPostJson(deps: PostJsonDeps) {
  const ruleId = deps.ruleId ?? POST_RULE_ID;
  // one rule id, so one request at a time
  let chain: Promise<unknown> = Promise.resolve();

  async function once(
    url: string,
    body: unknown,
    headers: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const u = new URL(url);
    const ruled = Object.keys(headers).length > 0;
    if (ruled) {
      const rule: chrome.declarativeNetRequest.Rule = {
        id: ruleId,
        priority: 2,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: Object.entries(headers).map(([header, value]) => ({
            header,
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value,
          })),
        },
        condition: {
          urlFilter: `|${u.origin}${u.pathname}`,
          resourceTypes: ['xmlhttprequest'] as chrome.declarativeNetRequest.ResourceType[],
          tabIds: [-1],
        },
      };
      await deps.dnr.updateSessionRules({ removeRuleIds: [ruleId], addRules: [rule] });
    }
    try {
      const res = await deps.fetch(url, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw httpError(res.status);
      return (await res.json()) as unknown;
    } finally {
      if (ruled)
        await deps.dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => undefined);
    }
  }

  return (
    url: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<unknown> => {
    const run = chain.then(() => once(url, body, headers));
    chain = run.catch(() => undefined);
    return run;
  };
}
