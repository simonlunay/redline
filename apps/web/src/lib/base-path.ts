/** The site's base path: '/redline' on GitHub Pages, '' locally and on a custom domain. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** URL of a file in public/, e.g. asset('gallery/index.json'). */
export function asset(path: string): string {
  return `${BASE_PATH}/${path.replace(/^\//, '')}`;
}
