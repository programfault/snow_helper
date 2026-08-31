// Shared data structures used across content script, service worker,
// panel, and options page. Keep this file as the single source of truth;
// other modules import types from here.

export type FieldType =
  | 'reference'
  | 'string'
  | 'integer'
  | 'boolean'
  | 'journal'
  | 'datetime'
  | 'decimal';

/** A single captured field, stored in the field library. */
export interface FieldEntry {
  /** Library-unique id (uuid). */
  id: string;
  /** ServiceNow field name, e.g. `caller_id`. May repeat across entries. */
  field_name: string;
  /** Visible label from the form, e.g. `Caller`. Always retained for reference. */
  label: string;
  /**
   * Optional user-defined alias. When set, used as the PRIMARY display
   * name across the panel UI, group editors, and fill toasts. When null
   * / empty the UI falls back to `label` (and then `field_name` if the
   * label is missing too).
   * Editable exclusively on the options page's Field Library tab.
   */
  alias?: string;
  field_type: FieldType;
  /** Referenced record sys_id (reference fields only). */
  ref_sys_id?: string;
  /** Visible value of the referenced record, e.g. `Alice Zhang`. */
  ref_display_value?: string;
  /** Simple-typed value (string/integer/boolean/journal/datetime/decimal). */
  value?: string;
  /**
   * Record sys_id at capture time. (Original key `table_sys_id` is kept
   * for backwards compatibility with data captured prior to the rename;
   * the field represents the record this field was captured from.)
   */
  table_sys_id?: string;
  /** Epoch ms when captured. */
  captured_at: number;
}

/** One item inside a business group. */
export interface FieldGroupItem {
  /** References FieldEntry.id. */
  entry_ref: string;
  /**
   * Override the library value. Only meaningful for non-reference fields;
   * reference items reuse the library entry's sys_id + display_value as-is.
   */
  override_value?: string;
}

/** A business group: pick library entries and assign per-item values. */
export interface FieldGroup {
  id: string;
  name: string;
  /** Optional human-readable note explaining what this group is for. */
  description?: string;
  items: FieldGroupItem[];
  created_at: number;
  updated_at: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A remote service invocation target. */
export interface RemoteService {
  id: string;
  name: string;
  endpoint: string;
  method: HttpMethod;
  /** Template string with `{{sys_id}}`, `{{field:<name>}}` etc. */
  body_template?: string;
  /** References TokenConfig.id; optional. */
  token_ref?: string;
  /** Deferred past MVP: extract a sub-field from JSON response. */
  response_jsonpath?: string;
}

/** Configuration for capturing a token from a domain's localStorage. */
export interface TokenConfig {
  id: string;
  name: string;
  /** Domain match pattern, e.g. `*.service-now.com` or `localhost:3000`. */
  domain_pattern: string;
  /** localStorage key to read, e.g. `accessToken`. */
  localstorage_key: string;
  /** Request header name, e.g. `Authorization`. */
  header_name: string;
  /** Header value prefix, e.g. `Bearer `. */
  header_prefix: string;
}

/** Cached token value keyed by TokenConfig.id. */
export interface TokenCacheEntry {
  value: string;
  captured_at: number;
}

/** Top-level shape persisted in chrome.storage.local. */
export interface StorageShape {
  schema_version: number;
  fields: Record<string, FieldEntry>;
  groups: Record<string, FieldGroup>;
  services: Record<string, RemoteService>;
  tokens: Record<string, TokenConfig>;
  token_cache: Record<string, TokenCacheEntry>;
}

/** Default storage shape used on first install. */
export function emptyStorage(): StorageShape {
  return {
    schema_version: 1,
    fields: {},
    groups: {},
    services: {},
    tokens: {},
    token_cache: {},
  };
}
