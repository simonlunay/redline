/** Model ids as people say them: "claude-sonnet-5-5" becomes "Claude Sonnet 5.5". */
export function modelName(id: string | undefined): string {
  if (!id) return '';
  return id
    .split(/,\s*/)
    .map((m) => {
      const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m.replace(/^anthropic:/, ''));
      if (!match) return m;
      const [, family, major, minor] = match;
      return `Claude ${family!.charAt(0).toUpperCase()}${family!.slice(1)} ${major}.${minor}`;
    })
    .join(', ');
}
