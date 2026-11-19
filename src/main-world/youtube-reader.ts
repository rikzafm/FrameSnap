/** Reads the current player response in the page's main world. */
export function readPlayerResponse(
  win: unknown,
  doc: { querySelector(s: string): unknown },
): unknown {
  // After an SPA navigation the global is stale; the live player knows the current video.
  const player = doc.querySelector('#movie_player') as { getPlayerResponse?: () => unknown } | null;
  try {
    const live = player?.getPlayerResponse?.();
    if (live) return live;
  } catch {
    /* fall through to the global */
  }
  return (win as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
}
