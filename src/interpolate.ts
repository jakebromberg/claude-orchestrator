/**
 * Replace `{{variable}}` placeholders in a template string.
 *
 * Only exact matches are replaced — unmatched placeholders are left intact.
 * The replacement is case-sensitive and does not trim whitespace inside braces.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? vars[key] : match,
  );
}
