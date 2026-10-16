// A fully static site: every route is prerendered at build time and the
// selection lives in the URL query, which is read in the browser only.
export const prerender = true;
// `dir/index.html` output works on any static host.
export const trailingSlash = 'always';
