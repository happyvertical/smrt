// Test stand-in for SvelteKit's `$app/state` (the DOM tests run without Kit).
export const page = {
  url: new URL('http://localhost/'),
  route: { id: '/' as string | null },
};
