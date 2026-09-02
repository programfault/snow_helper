// Playbook engine: YAML loading, schema validation, variable interpolation,
// and step execution coordination on the panel side.
//
// MAIN-world APIs (Table API fetch / g_form read / etc.) live in the content
// script; this module is pure TypeScript that runs inside the side panel
// (and settings editor) to parse/validate/interpolate before sending any
// PANEL_PLAYBOOK_RUN_STEP messages over to the content script.
//
// Design goals:
//   - Fail loudly at validation time (before run) with actionable error
//     messages so bad YAML never reaches the execute path.
//   - Keep interpolation pure (no side effects) so it can be unit tested.
//   - Dictionary resolution order: inline_dict (playbook-local) first,
//     then the global chrome.storage dict_entries (user-maintained).

import { parse as parseYaml } from 'yaml';
import type {
  AssertStep,
  DictCategory,
  DictEntry,
  FieldGroup,
  InputDef,
  InputDictOptionSource,
  InputSelectOption,
  PatchStep,
  Playbook,
  PlaybookInlineDict,
  PlaybookStep,
  StorageShape,
  WaitStep,
} from './types';
import { uuid } from './storage-helpers';

// ---------------------------------------------------------------------------
// Builtin YAML loader. Vite's glob is resolved at build time.
// ---------------------------------------------------------------------------

const BUILTIN_YAML_MODULES = import.meta.glob('../playbooks/*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface BuiltinPlaybookRaw {
  slug: string;
  yaml_src: string;
}

/** Returns raw source text of every *.yml shipped under src/playbooks/. */
export function listBuiltinPlaybooks(): BuiltinPlaybookRaw[] {
  return Object.entries(BUILTIN_YAML_MODULES).map(([path, yaml_src]) => {
    const base = path.split('/').pop() ?? path;
    const slug = base.replace(/\.ya?ml$/i, '');
    return { slug, yaml_src };
  });
}

// ---------------------------------------------------------------------------
// Schema types for raw YAML -> typed Playbook conversion. We accept loose
// shapes in YAML (unknowns dropped, optionals coerced) for ergonomics.
// ---------------------------------------------------------------------------

export interface PlaybookValidationIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

type RawStep = Record<string, unknown>;
type RawInput = Record<string, unknown>;

/** Parse YAML text into an unvalidated plain record. Throws on syntax error. */
export function parseYamlToObject(yamlSrc: string): Record<string, unknown> {
  const raw = parseYaml(yamlSrc);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Playbook YAML root must be a mapping, got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`,
    );
  }
  return raw as Record<string, unknown>;
}

/**
 * Validate a raw parsed YAML object + convert into a typed Playbook
 * structure. Returns {playbook, issues}. Issues with level=error mean the
 * playbook should not be run.
 *
 * When `existingId` is provided (editing a user playbook) the output id is
 * preserved; otherwise a new uuid is generated. `builtin=true` marks the
 * result as read-only / shipped-with-extension.
 */
export function validateAndBuildPlaybook(
  raw: Record<string, unknown>,
  opts: { existingId?: string; builtin?: boolean; yamlSrc?: string } = {},
): { playbook: Playbook; issues: PlaybookValidationIssue[] } {
  const issues: PlaybookValidationIssue[] = [];
  const pushErr = (path: string, m: string) =>
    issues.push({ level: 'error', path, message: m });
  const pushWarn = (path: string, m: string) =>
    issues.push({ level: 'warning', path, message: m });

  const now = Date.now();
  const version = typeof raw.version === 'number' ? raw.version : 1;
  const name = typeof raw.name === 'string' && raw.name.trim() !== ''
    ? raw.name.trim()
    : null;
  if (!name) pushErr('name', 'Required string field "name" is missing or empty.');

  const stepsArr = Array.isArray(raw.steps) ? (raw.steps as RawStep[]) : null;
  if (!stepsArr) pushErr('steps', 'Required array field "steps" is missing.');

  const trigger = coerceTrigger(raw.trigger, 'trigger', pushWarn);
  const inputs = coerceInputs(raw.inputs, 'inputs', pushErr);
  const inlineDict = coerceInlineDict(raw.inline_dict, 'inline_dict', pushWarn);

  const steps = stepsArr ? coerceSteps(stepsArr, 'steps', pushErr) : [];

  const slug = typeof raw.slug === 'string' && raw.slug.trim() !== ''
    ? raw.slug.trim()
    : undefined;

  const playbook: Playbook = {
    id: opts.existingId ?? uuid(),
    version,
    slug,
    name: name ?? '(unnamed playbook)',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    author: typeof raw.author === 'string' ? raw.author : undefined,
    updated_at: now,
    builtin: opts.builtin ?? false,
    yaml_src: opts.yamlSrc,
    trigger,
    inputs,
    inline_dict: inlineDict,
    steps,
  };

  return { playbook, issues };
}

function coerceTrigger(
  raw: unknown,
  path: string,
  warn: (p: string, m: string) => void,
): Playbook['trigger'] {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') { warn(path, 'trigger must be an object; ignoring'); return undefined; }
  const o = raw as Record<string, unknown>;
  const table = typeof o.table === 'string' && o.table !== '' ? o.table : undefined;
  let requireStateIn: string[] | undefined;
  if (Array.isArray(o.require_state_in)) {
    requireStateIn = o.require_state_in
      .map((x) => String(x))
      .filter((x) => x !== '');
    if (requireStateIn.length === 0) requireStateIn = undefined;
  } else if (o.require_state_in !== undefined) {
    warn(`${path}.require_state_in`, 'Must be an array of strings; ignoring');
  }
  return { table, require_state_in: requireStateIn };
}

function coerceInputs(
  raw: unknown,
  path: string,
  err: (p: string, m: string) => void,
): InputDef[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) { err(path, 'inputs must be an array; ignoring'); return undefined; }
  const out: InputDef[] = [];
  raw.forEach((item, idx) => {
    const p = `${path}[${idx}]`;
    if (typeof item !== 'object' || item === null) { err(p, 'Must be an object'); return; }
    const o = item as RawInput;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!key) { err(`${p}.key`, 'Required field missing'); return; }
    if (!label) { err(`${p}.label`, 'Required field missing'); return; }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      err(`${p}.key`, 'Key must be [A-Za-z_][A-Za-z0-9_]* (no spaces/dots)');
    }
    const allowedTypes = new Set(['text', 'textarea', 'number', 'date', 'select']);
    const t = typeof o.type === 'string' ? o.type : 'text';
    if (!allowedTypes.has(t)) err(`${p}.type`, `Unknown type "${t}", using "text".`);
    const type = allowedTypes.has(t) ? (t as InputDef['type']) : 'text';
    const def: InputDef = { key, label, type };
    if (typeof o.placeholder === 'string') def.placeholder = o.placeholder;
    if (o.default !== undefined) def.default = String(o.default);
    if (typeof o.required === 'boolean') def.required = o.required;
    if (typeof o.rows === 'number') def.rows = Math.max(1, o.rows | 0);
    if (Array.isArray(o.options)) {
      const opts: InputSelectOption[] = [];
      o.options.forEach((op, i) => {
        if (typeof op !== 'object' || op === null) {
          err(`${p}.options[${i}]`, 'Must be {label,value}');
          return;
        }
        const lop = op as Record<string, unknown>;
        const lbl = typeof lop.label === 'string' ? lop.label : String(lop.value ?? '');
        const val = typeof lop.value === 'string' ? lop.value : String(lop.value ?? '');
        if (!val) err(`${p}.options[${i}]`, 'value is empty');
        opts.push({ label: lbl, value: val });
      });
      def.options = opts;
    }
    if (typeof o.options_from_dict === 'object' && o.options_from_dict !== null) {
      const src = o.options_from_dict as Record<string, unknown>;
      const cat = typeof src.category === 'string' ? src.category : undefined;
      const allowedCats = new Set(['group', 'user', 'choice', 'state', 'table', 'custom']);
      if (!cat || !allowedCats.has(cat)) {
        err(`${p}.options_from_dict.category`, `Required, must be one of ${[...allowedCats].join(', ')}`);
      } else {
        const ofd: InputDictOptionSource = { category: cat as DictCategory };
        if (typeof src.table === 'string') ofd.table = src.table;
        def.options_from_dict = ofd;
      }
    }
    out.push(def);
  });
  return out.length > 0 ? out : undefined;
}

function coerceInlineDict(
  raw: unknown,
  path: string,
  err: (p: string, m: string) => void,
): PlaybookInlineDict | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    err(path, 'inline_dict must be a { category: { key: entry } } mapping; ignoring');
    return undefined;
  }
  const o = raw as Record<string, Record<string, unknown>>;
  const out: PlaybookInlineDict = {};
  for (const [category, inner] of Object.entries(o)) {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
      err(`${path}.${category}`, 'Must be a mapping key -> {value, label?}');
      continue;
    }
    const record: Record<string, { value: string; label?: string } | string> = {};
    for (const [key, val] of Object.entries(inner as Record<string, unknown>)) {
      if (typeof val === 'string') {
        record[key] = val;
      } else if (val !== null && typeof val === 'object') {
        const v = val as Record<string, unknown>;
        const value = typeof v.value === 'string' ? v.value : String(v.value ?? '');
        const label = typeof v.label === 'string' ? v.label : undefined;
        record[key] = { value, label };
      } else {
        err(`${path}.${category}.${key}`, 'Must be a string or {value,label}');
      }
    }
    out[category] = record;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceSteps(
  arr: RawStep[],
  path: string,
  err: (p: string, m: string) => void,
): PlaybookStep[] {
  const out: PlaybookStep[] = [];
  arr.forEach((s, i) => {
    const p = `${path}[${i}]`;
    if (typeof s !== 'object' || s === null) { err(p, 'Must be an object'); return; }
    const type = typeof s.type === 'string' ? s.type : '(missing)';
    const base = <T extends object, TypeLit extends 'patch' | 'wait' | 'assert'>(t: TypeLit, extra: T) => {
      const merged: T & {
        id?: string; name?: string; type: TypeLit; delay_before_ms?: number;
        delay_after_ms?: number; on_error?: 'stop' | 'skip' | 'retry_and_skip';
        retry?: { times: number; interval_ms: number };
      } = { ...extra, type: t };
      if (typeof s.id === 'string' && s.id.trim() !== '') merged.id = s.id.trim();
      if (typeof s.name === 'string') merged.name = s.name;
      if (typeof s.delay_before_ms === 'number') merged.delay_before_ms = s.delay_before_ms | 0;
      if (typeof s.delay_after_ms === 'number') merged.delay_after_ms = s.delay_after_ms | 0;
      if (typeof s.on_error === 'string') {
        const allowed = new Set(['stop', 'skip', 'retry_and_skip']);
        if (allowed.has(s.on_error)) merged.on_error = s.on_error as 'stop' | 'skip' | 'retry_and_skip';
        else err(`${p}.on_error`, `Allowed values: stop, skip, retry_and_skip`);
      }
      if (typeof s.retry === 'object' && s.retry !== null) {
        const r = s.retry as Record<string, unknown>;
        const times = typeof r.times === 'number' ? Math.max(0, r.times | 0) : 0;
        const interval_ms = typeof r.interval_ms === 'number' ? Math.max(0, r.interval_ms | 0) : 250;
        if (times > 0) merged.retry = { times, interval_ms };
      }
      return merged;
    };

    switch (type) {
      case 'patch': {
        const payloadRaw = s.payload;
        let payload: Record<string, string> | undefined;
        if (payloadRaw !== undefined) {
          if (typeof payloadRaw !== 'object' || Array.isArray(payloadRaw) || payloadRaw === null) {
            err(`${p}.payload`, 'Must be a string-keyed mapping');
          } else {
            const rec: Record<string, string> = {};
            for (const [k, v] of Object.entries(payloadRaw as Record<string, unknown>)) {
              if (v === null || v === undefined) rec[k] = '';
              else rec[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
            }
            payload = rec;
          }
        }
        const fromGroup = typeof s.from_group === 'string' && s.from_group.trim() !== '' ? s.from_group : undefined;
        if (!payload && !fromGroup) pushErrOr(p, err, 'patch needs payload or from_group');
        const patch: PatchStep = base('patch', {
          payload,
          from_group: fromGroup,
        });
        out.push(patch);
        break;
      }
      case 'wait': {
        const field = typeof s.field === 'string' ? s.field : '';
        if (!field) err(`${p}.field`, 'Required for wait');
        const timeout = typeof s.timeout_ms === 'number' ? Math.max(1, s.timeout_ms | 0) : 5000;
        const w: WaitStep = base('wait', {
          field,
          timeout_ms: timeout,
        });
        if (typeof s.poll_interval_ms === 'number') w.poll_interval_ms = Math.max(50, s.poll_interval_ms | 0);
        if (typeof s.equals === 'string') w.equals = s.equals;
        if (typeof s.not_equals === 'string') w.not_equals = s.not_equals;
        if (Array.isArray(s.one_of)) w.one_of = s.one_of.map(String);
        if (typeof s.match === 'string') w.match = s.match;
        if (w.equals === undefined && w.not_equals === undefined && w.one_of === undefined && w.match === undefined) {
          err(`${p}`, 'wait needs one of equals/not_equals/one_of/match');
        }
        if (typeof s.on_timeout === 'string') {
          if (s.on_timeout === 'stop' || s.on_timeout === 'skip') w.on_timeout = s.on_timeout;
          else err(`${p}.on_timeout`, 'Allowed: stop, skip');
        }
        out.push(w);
        break;
      }
      case 'assert': {
        const field = typeof s.field === 'string' ? s.field : '';
        if (!field) err(`${p}.field`, 'Required for assert');
        const a: AssertStep = base('assert', { field });
        if (typeof s.equals === 'string') a.equals = s.equals;
        if (typeof s.equals_ref_sys_id === 'string') a.equals_ref_sys_id = s.equals_ref_sys_id;
        if (typeof s.not_equals === 'string') a.not_equals = s.not_equals;
        if (typeof s.match === 'string') a.match = s.match;
        if (a.equals === undefined && a.equals_ref_sys_id === undefined && a.not_equals === undefined && a.match === undefined) {
          err(`${p}`, 'assert needs equals, equals_ref_sys_id, not_equals, or match');
        }
        if (typeof s.on_fail === 'string') {
          if (s.on_fail === 'stop' || s.on_fail === 'skip') a.on_fail = s.on_fail;
          else err(`${p}.on_fail`, 'Allowed: stop, skip');
        }
        out.push(a);
        break;
      }
      default:
        err(p, `Unknown step.type "${type}". Allowed: patch, wait, assert.`);
    }
  });
  return out;
}

function pushErrOr(p: string, err: (p: string, m: string) => void, m: string) { err(p, m); }

// ---------------------------------------------------------------------------
// Dictionary resolution: inline_dict first, then global dict_entries.
// Supports two-component refs: ${dict.<category>.<key_suffix>}.
// ---------------------------------------------------------------------------

export interface DictRef {
  category: DictCategory;
  keySuffix: string; // everything after category in key, e.g. "incident.progress"
  wantLabel: boolean;
}

export function parseDictRef(ref: string): DictRef | null {
  // "states.incident.progress.label" or "groups.network_team"
  const parts = ref.split('.');
  if (parts.length < 2) return null;
  const categories = new Set(['group', 'user', 'choice', 'state', 'table', 'custom']);
  const catRaw = parts[0];
  let category: DictCategory | undefined;
  // support plurals: groups -> group, users -> user, choices -> choice, states -> state, tables -> table
  if (categories.has(catRaw)) category = catRaw as DictCategory;
  else if (catRaw === 'groups') category = 'group';
  else if (catRaw === 'users') category = 'user';
  else if (catRaw === 'choices') category = 'choice';
  else if (catRaw === 'states') category = 'state';
  else if (catRaw === 'tables') category = 'table';
  else if (catRaw === 'customs') category = 'custom';
  if (!category) return null;
  const last = parts[parts.length - 1];
  const wantLabel = last === 'label';
  const suffixParts = wantLabel ? parts.slice(1, -1) : parts.slice(1);
  if (suffixParts.length === 0) return null;
  return { category, keySuffix: suffixParts.join('.'), wantLabel };
}

/**
 * Try to find a dictionary entry by two-part suffix plus optional
 * `scopeTable` (playbook trigger table). When multiple candidates share the
 * suffix we prefer:
 *   1) entries with matching table (exact match)
 *   2) entries without any table (universal)
 *   3) any other table (last-resort fallback + warning via resolveLog)
 */
export interface ResolveDictOptions {
  playbookInlineDict?: PlaybookInlineDict;
  globalDict?: Record<string, DictEntry>;
  scopeTable?: string;
  onWarning?: (msg: string) => void;
}

export interface DictResolved { value: string; label?: string; }

export function resolveDictReference(
  ref: string,
  opts: ResolveDictOptions,
): DictResolved | undefined {
  const parsed = parseDictRef(ref);
  if (!parsed) {
    opts.onWarning?.(`Bad dict reference syntax: "${ref}"`);
    return undefined;
  }
  const suffix = parsed.keySuffix;

  // --- 1. inline_dict first ---
  if (opts.playbookInlineDict) {
    const inner = opts.playbookInlineDict[pluraliseCategory(parsed.category)]
      ?? opts.playbookInlineDict[parsed.category];
    if (inner) {
      const direct = inner[suffix];
      if (typeof direct === 'string') {
        return parsed.wantLabel ? { value: direct, label: direct } : { value: direct };
      }
      if (direct && typeof direct === 'object' && typeof direct.value === 'string') {
        return parsed.wantLabel
          ? { value: direct.label ?? direct.value, label: direct.label ?? direct.value }
          : { value: direct.value, label: direct.label };
      }
    }
  }

  // --- 2. global dict ---
  if (opts.globalDict) {
    const candidates = Object.values(opts.globalDict).filter((d) => {
      if (d.category !== parsed.category) return false;
      if (d.key === suffix) return true;
      // Also match: category suffixes are stored as key in two styles:
      //   a) "choices.priority.p1"  (full path, exactly as ref)
      //   b) "priority.p1"            (category is implicit via field)
      //    -> Both are already covered by `d.key === suffix`.
      return false;
    });
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) {
      const c = candidates[0];
      return parsed.wantLabel
        ? { value: c.label ?? c.value, label: c.label ?? c.value }
        : { value: c.value, label: c.label };
    }
    // Multiple: prefer scopeTable exact, then no table, then any.
    const exact = candidates.find((c) => c.table && opts.scopeTable && c.table.toLowerCase() === opts.scopeTable.toLowerCase());
    if (exact) {
      return parsed.wantLabel
        ? { value: exact.label ?? exact.value, label: exact.label ?? exact.value }
        : { value: exact.value, label: exact.label };
    }
    const uni = candidates.find((c) => !c.table);
    if (uni) {
      return parsed.wantLabel
        ? { value: uni.label ?? uni.value, label: uni.label ?? uni.value }
        : { value: uni.value, label: uni.label };
    }
    opts.onWarning?.(`Ambiguous dict reference "${ref}" across ${candidates.length} different tables.`);
    const c = candidates[0];
    return parsed.wantLabel
      ? { value: c.label ?? c.value, label: c.label ?? c.value }
      : { value: c.value, label: c.label };
  }
  return undefined;
}

function pluraliseCategory(c: DictCategory): string {
  switch (c) {
    case 'group': return 'groups';
    case 'user': return 'users';
    case 'choice': return 'choices';
    case 'state': return 'states';
    case 'table': return 'tables';
    case 'custom': return 'customs';
  }
}

// ---------------------------------------------------------------------------
// Variable interpolation. Walks through a string and replaces every
// occurrence of ${expression} with resolved values. Supports modifier
// ?skip_empty which signals callers when the final value is "" (for payload
// key stripping use-case).
// ---------------------------------------------------------------------------

export interface InterpolateContext {
  inputs?: Record<string, { value: string; label?: string }>;
  inputDefs?: InputDef[];
  playbookInlineDict?: PlaybookInlineDict;
  globalDict?: Record<string, DictEntry>;
  scopeTable?: string;
  currentValues?: Record<string, string>;
  currentDisplays?: Record<string, string>;
  userName?: string;
  userDisplay?: string;
  userEmail?: string;
  nowIso?: string;
  todayIso?: string;
  nowLocal?: string;
  onWarning?: (msg: string) => void;
  /** For from_group payload expansion (supplied by caller). */
  fields?: StorageShape['fields'];
  groups?: StorageShape['groups'];
}

/** Matches ${...} with single-line body; modifier is ?word just before close. */
const TOKEN_RE = /\$\{([^}]*?)\}/g;

export interface InterpolatedString {
  value: string;
  /** true when expression used ?skip_empty and value resolved to "" */
  skip_empty: boolean;
  /** human-readable label for ${inputs.xxx.label} / dict label style resolution */
  label?: string;
}

export function interpolateString(
  template: string,
  ctx: InterpolateContext,
): InterpolatedString {
  if (template === null || template === undefined) return { value: '', skip_empty: false };
  let skipEmpty = false;
  let labelOut: string | undefined;

  const result = template.replace(TOKEN_RE, (_match, expr: string) => {
    const trimmed = expr.trim();
    const m = trimmed.match(/^(.+?)\?(\w+)\s*$/);
    let core = trimmed;
    let modifier: string | undefined;
    if (m) { core = m[1].trim(); modifier = m[2]; }

    // Track label explicitly only for the single-token case where the entire
    // template equals "${...}" — this powers ".label" semantics cleanly.
    let resolvedLabel: string | undefined;
    const resolved = resolveOneExpression(core, ctx, (l) => { resolvedLabel = l; });

    if (modifier === 'skip_empty' && resolved === '') {
      skipEmpty = true;
    }
    // Surface the label when the user requested ".label" suffix via
    // resolvedLabel, OR for inputs the second arg of inputs entry records.
    if (labelOut === undefined && resolvedLabel !== undefined) labelOut = resolvedLabel;
    return resolved;
  });

  return { value: result, skip_empty: skipEmpty, label: labelOut };
}

function resolveOneExpression(
  expr: string,
  ctx: InterpolateContext,
  setLabel: (l: string) => void,
): string {
  if (expr === '') return '';

  // --- Built-in time/user ---
  if (expr === 'now') return ctx.nowIso ?? new Date().toISOString();
  if (expr === 'today') return (ctx.todayIso ?? new Date().toISOString()).slice(0, 10);
  if (expr === 'now_local') return ctx.nowLocal ?? formatLocalNow();
  if (expr === 'user_name') return ctx.userName ?? '';
  if (expr === 'user_display') return ctx.userDisplay ?? ctx.userName ?? '';
  if (expr === 'user_email') return ctx.userEmail ?? '';
  if (expr === 'uuid') return crypto.randomUUID();
  if (expr === 'uuid()') return crypto.randomUUID();

  // Fallback defaults: ${foo:-bar} expands to "bar" if foo resolved to "" / undefined
  const withDefault = expr.match(/^(.+?):-(.*)$/s);
  let defaultVal: string | undefined;
  let effective = expr;
  if (withDefault) { effective = withDefault[1].trim(); defaultVal = withDefault[2]; }

  // --- inputs.$key ---
  const inputM = effective.match(/^inputs\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.(label))?$/);
  if (inputM) {
    const key = inputM[1];
    const wantLabel = inputM[2] === 'label';
    const rec = ctx.inputs?.[key];
    if (rec) {
      if (wantLabel) {
        const lbl = rec.label ?? rec.value;
        setLabel(lbl);
        return lbl;
      }
      if (rec.value !== undefined && rec.value !== '') return rec.value;
    }
    return defaultVal ?? '';
  }

  // --- current.$field(.label)? ---
  const curM = effective.match(/^current\.([a-zA-Z_][a-zA-Z0-9_]+)(?:\.(display|label))?$/);
  if (curM) {
    const field = curM[1];
    const wantDisplay = !!curM[2];
    const values = ctx.currentValues ?? {};
    const displays = ctx.currentDisplays ?? {};
    if (wantDisplay) {
      const d = displays[field];
      if (d !== undefined) { setLabel(d); return d; }
      return values[field] ?? defaultVal ?? '';
    }
    const v = values[field];
    if (v !== undefined && v !== '') return v;
    return defaultVal ?? '';
  }

  // --- dict.$path (.label)? ---
  if (effective.startsWith('dict.')) {
    const ref = effective.slice('dict.'.length);
    const wantLabelSuffix = ref.endsWith('.label');
    const cleanedRef = wantLabelSuffix ? ref.slice(0, -'.label'.length) : ref;
    const resolved = resolveDictReference(cleanedRef, {
      playbookInlineDict: ctx.playbookInlineDict,
      globalDict: ctx.globalDict,
      scopeTable: ctx.scopeTable,
      onWarning: ctx.onWarning,
    });
    if (!resolved) return defaultVal ?? '';
    if (wantLabelSuffix) {
      setLabel(resolved.label ?? resolved.value);
      return resolved.label ?? resolved.value ?? defaultVal ?? '';
    }
    if (resolved.value !== undefined && resolved.value !== '') return resolved.value;
    return defaultVal ?? '';
  }

  ctx.onWarning?.(`Unknown expression "${expr}" in template (kept literal).`);
  return defaultVal ?? `\${${expr}}`;
}

function formatLocalNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`;
}

// ---------------------------------------------------------------------------
// Payload preparation: apply interpolation + merge from_group + strip any
// keys that ended up with ?skip_empty + empty value.
// ---------------------------------------------------------------------------

export interface PreparedPatchPayload {
  payload: Record<string, string>;
  /** Interpolation warnings surfaced to the toast/run log. */
  warnings: string[];
}

export function preparePatchPayload(
  step: PatchStep,
  ctx: InterpolateContext,
): PreparedPatchPayload {
  const warnings: string[] = [];
  const localCtx: InterpolateContext = {
    ...ctx,
    onWarning: (m) => warnings.push(m),
  };
  const merged: Record<string, string> = {};

  // 1. from_group (FieldGroup base values)
  if (step.from_group && ctx.groups) {
    const group = Object.values(ctx.groups).find((g) => g.name === step.from_group || g.id === step.from_group);
    if (group && ctx.fields) {
      for (const item of group.items) {
        const entry: import('./types').FieldEntry | undefined = ctx.fields[item.entry_ref];
        if (!entry) continue;
        let v: string;
        if (item.override_value !== undefined && item.override_value !== null) {
          v = item.override_value;
        } else if (entry.field_type === 'reference') {
          v = entry.ref_sys_id ?? '';
        } else {
          v = entry.value ?? '';
        }
        const field = entry.field_name;
        const { value, skip_empty } = interpolateString(v, localCtx);
        if (skip_empty && value === '') continue;
        if (value !== '' || item.override_value !== undefined) merged[field] = value;
      }
    } else {
      warnings.push(`from_group "${step.from_group}" not found (skipped, no group values merged).`);
    }
  }

  // 2. explicit payload (takes precedence)
  if (step.payload) {
    for (const [k, templ] of Object.entries(step.payload)) {
      const { value, skip_empty } = interpolateString(templ, localCtx);
      if (skip_empty && value === '') {
        delete merged[k];
        continue;
      }
      merged[k] = value;
    }
  }
  return { payload: merged, warnings };
}

// ---------------------------------------------------------------------------
// Builtin playbook bootstrapping: called on install/startup to seed storage.
// Returns user-visible warnings (if any builtin failed validation).
// ---------------------------------------------------------------------------

export function seedBuiltinPlaybooks(existing: StorageShape): StorageShape {
  const nextPlaybooks: StorageShape['playbooks'] = { ...existing.playbooks };
  const raws = listBuiltinPlaybooks();
  for (const raw of raws) {
    try {
      const obj = parseYamlToObject(raw.yaml_src);
      // Slug-based de-dupe: if a playbook with the same builtin-id already
      // exists we refresh it (yaml_src + re-validate) but preserve the id.
      const sameSlug = Object.values(nextPlaybooks).find((p) => p.slug === raw.slug && p.builtin);
      const { playbook } = validateAndBuildPlaybook(obj, {
        existingId: sameSlug?.id,
        builtin: true,
        yamlSrc: raw.yaml_src,
      });
      nextPlaybooks[playbook.id] = playbook;
    } catch {
      // ignore corrupted builtin YAMLs (user's own copies in storage remain).
    }
  }
  return { ...existing, playbooks: nextPlaybooks };
}

// ---------------------------------------------------------------------------
// Merge FieldGroup values into patch payload (exposed helper for tests
// & future callers that don't go through the full interpolation path).
// Also re-exported by storage-utils/engine index via the shared barrel.
// ---------------------------------------------------------------------------

export function expandFromGroupForStep(
  step: PatchStep,
  groups: Record<string, FieldGroup>,
  fields: StorageShape['fields'],
): Record<string, string> | undefined {
  if (!step.from_group) return undefined;
  const group = Object.values(groups).find((g) => g.name === step.from_group || g.id === step.from_group);
  if (!group) return undefined;
  const out: Record<string, string> = {};
  for (const item of group.items) {
    const entry: import('./types').FieldEntry | undefined = fields[item.entry_ref];
    if (!entry) continue;
    const v = item.override_value !== undefined && item.override_value !== null
      ? item.override_value
      : (entry.field_type === 'reference' ? entry.ref_sys_id ?? '' : entry.value ?? '');
    out[entry.field_name] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
