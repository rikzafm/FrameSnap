/** One place that turns "GET this URL as text" into text or a typed HTTP error (manifests, adapter pages). */
import { httpError } from "../core/errors";

export interface TextFetcher {
  (url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Response>;
}

export async function fetchText(fetcher: TextFetcher, url: string, headers: Record<string, string> = {}, signal: AbortSignal = new AbortController().signal): Promise<string> {
  const res = await fetcher(url, { headers, signal });
  if (!res.ok) throw httpError(res.status);
  return res.text();
}
