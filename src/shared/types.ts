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
   * Display text for choice / dropdown / select fields.
   *   - e.g. state field: value="1", display_value="New"
   *   - For reference fields use ref_display_value; for simple string fields
   *     that are just free text this is usually undefined.
   * Set by capture (from g_form getDisplayValue or selected option text).
   * Used in UIs so users see readable labels instead of numeric indices.
   * When filling the form back, we STILL write `value` to the input, since
   * that's what ServiceNow needs on submit.
   */
  display_value?: string;
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

// ==========================================================================
// Dictionary — stable reference data store (sys_ids, choice values, labels).
// Core fields are key/value/label. The table + field_name attrs are required
// for choice/state entries because ServiceNow choice values are strongly
// scoped to their parent table + field combination.
// ==========================================================================

export type DictCategory =
  | 'group'    // sys_user_group sys_id
  | 'user'     // sys_user sys_id
  | 'choice'   // <table>.<field_name> choice value
  | 'state'    // <table>.state choice value (separated for workflow author ergonomics)
  | 'table'    // Table metadata
  | 'custom';  // Free-form constant

export interface DictEntry {
  id: string;
  category: DictCategory;
  /** Friendly alias used in YAML interpolation: ${dict.<cat>.<key>} */
  key: string;
  /** Actual value written to payloads: sys_id / "2" / etc. */
  value: string;
  /** Human-readable label, surfaced via `.label` suffix in templates. */
  label?: string;
  description?: string;
  /** Required for choice / state; optional for group/user/custom (used for filtering). */
  table?: string;
  /** Required for `choice` category; pins the entry to a specific field. */
  field_name?: string;
  created_at: number;
  updated_at: number;
}

// ==========================================================================
// Playbook — multi-step workflow authored as YAML. A single playbook run
// executes steps sequentially; each step can be a Table API PATCH, a wait
// on a form field value, or an assertion.
// ==========================================================================

export type InputType = 'text' | 'textarea' | 'number' | 'date' | 'select';

export interface InputSelectOption {
  /** Label shown in the select; also available via ${inputs.<key>.label}. */
  label: string;
  /** Actual value used in payload interpolation. Supports ${dict.*} refs. */
  value: string;
}

/** Expand select options directly from the dictionary. */
export interface InputDictOptionSource {
  category: DictCategory;
  /** When set, only entries with this table are included. */
  table?: string;
}

export interface InputDef {
  key: string;
  label: string;
  type: InputType;
  placeholder?: string;
  /** Default value; supports variable interpolation. */
  default?: string;
  required?: boolean;
  /** Textarea height hint. */
  rows?: number;
  /** Static options for select-type inputs. */
  options?: InputSelectOption[];
  /** Dynamic options pulled from the dictionary at runtime. */
  options_from_dict?: InputDictOptionSource;
}

export type StepType = 'patch' | 'wait' | 'assert';

export interface BaseStep {
  id?: string;
  name?: string;
  type: StepType;
  delay_before_ms?: number;
  delay_after_ms?: number;
  on_error?: 'stop' | 'skip' | 'retry_and_skip';
  retry?: { times: number; interval_ms: number };
}

export interface PatchStep extends BaseStep {
  type: 'patch';
  /** When set, values from the referenced FieldGroup are merged first. */
  from_group?: string;
  /** Explicit payload (supports variable interpolation). */
  payload?: Record<string, string>;
}

export type WaitMatchMode = 'equals' | 'not_equals' | 'one_of' | 'match';

export interface WaitStep extends BaseStep {
  type: 'wait';
  field: string;
  equals?: string;
  not_equals?: string;
  one_of?: string[];
  match?: string;
  timeout_ms: number;
  poll_interval_ms?: number;
  on_timeout?: 'stop' | 'skip';
}

export interface AssertStep extends BaseStep {
  type: 'assert';
  field: string;
  equals?: string;
  equals_ref_sys_id?: string;
  not_equals?: string;
  match?: string;
  on_fail?: 'stop' | 'skip';
}

export type PlaybookStep = PatchStep | WaitStep | AssertStep;

export interface PlaybookTrigger {
  table?: string;
  require_state_in?: string[];
}

export interface PlaybookInlineDict {
  [category: string]:
    | Record<string, { value: string; label?: string } | string>
    | undefined;
}

export interface Playbook {
  id: string;
  /** Schema version; reserved for future YAML DSL evolution. */
  version: number;
  slug?: string;
  name: string;
  description?: string;
  author?: string;
  updated_at: number;
  /** true for playbooks bundled in src/playbooks/*.yml. These can't be edited. */
  builtin?: boolean;
  /** Raw YAML source text (used by editor + round-trip export/download). */
  yaml_src?: string;
  trigger?: PlaybookTrigger;
  inputs?: InputDef[];
  inline_dict?: PlaybookInlineDict;
  steps: PlaybookStep[];
}

/** Top-level shape persisted in chrome.storage.local. */
export interface StorageShape {
  schema_version: number;
  fields: Record<string, FieldEntry>;
  groups: Record<string, FieldGroup>;
  services: Record<string, RemoteService>;
  tokens: Record<string, TokenConfig>;
  token_cache: Record<string, TokenCacheEntry>;
  dict_entries: Record<string, DictEntry>;
  playbooks: Record<string, Playbook>;
}

/** Default storage shape used on first install. */
export function emptyStorage(): StorageShape {
  return {
    schema_version: 2,
    fields: {},
    groups: {},
    services: {},
    tokens: {},
    token_cache: {},
    dict_entries: {},
    playbooks: {},
  };
}
