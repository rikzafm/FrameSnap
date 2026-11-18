/** Sites named in the UI footer. YouTube exists only in the personal build. */
export function supportedSiteNames(): string[] {
  return ['Reddit', 'X', 'Discord', ...(__YOUTUBE__ ? ['YouTube'] : [])];
}
