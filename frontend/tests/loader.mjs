/* loader.mjs — node module resolver that maps the app's browser-absolute
 * imports (/static/js/…) to the real files under frontend/, so the page
 * modules can be imported and executed directly in tests.
 */
const FRONTEND = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

export function resolve(specifier, context, next) {
  if (specifier.startsWith('/static/')) {
    return next(new URL('file://' + FRONTEND + specifier).href, context);
  }
  return next(specifier, context);
}
