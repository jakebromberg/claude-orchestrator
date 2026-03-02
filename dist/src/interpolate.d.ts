/**
 * Replace `{{variable}}` placeholders in a template string.
 *
 * Only exact matches are replaced — unmatched placeholders are left intact.
 * The replacement is case-sensitive and does not trim whitespace inside braces.
 */
export declare function interpolate(template: string, vars: Record<string, string>): string;
