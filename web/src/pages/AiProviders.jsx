import React, { useEffect, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, Chip, FormControlLabel, IconButton, Link, MenuItem, Stack, Switch, TextField,
  ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { Pencil, Plus, RotateCcw, Trash2, Zap } from 'lucide-react';
import { api } from '../api.js';
import { Panel } from '../components.jsx';

const EMPTY = { id: null, kind: 'openrouter', name: '', base_url: '', keys: '', models: [], model: '', vision: false };
const keyList = (text) => [...new Set(String(text).split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean))];

function ProviderForm({ presets, initial, onSaved, onCancel }) {
  const [f, setF] = useState(initial);
  const [options, setOptions] = useState([]); // [{ id, free }]
  const [freeOnly, setFreeOnly] = useState(initial.kind === 'openrouter');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const preset = presets.find((p) => p.kind === f.kind);
  const editing = Boolean(f.id);
  const keys = keyList(f.keys);
  const shown = options.filter((o) => !freeOnly || o.free).map((o) => o.id);
  const count = editing ? 1 : f.models.length * Math.max(1, keys.length);

  function pickKind(kind) {
    const p = presets.find((x) => x.kind === kind);
    setF((cur) => ({ ...cur, kind, name: p.name, base_url: p.base_url }));
    setOptions([]);
    setFreeOnly(kind === 'openrouter');
  }
  useEffect(() => { if (!editing && !f.base_url) pickKind(f.kind); }, []); // eslint-disable-line

  const probe = () => ({ id: f.id || undefined, base_url: f.base_url, api_key: keys[0] || '', model: editing ? f.model : f.models[0] || f.model });

  async function fetchModels() {
    setBusy('models'); setMsg(null);
    try {
      const r = await api.providerModels(probe());
      setOptions(r.models);
      const free = r.models.filter((m) => m.free).length;
      setMsg(r.error ? { severity: 'error', text: r.error }
        : { severity: 'success', text: `${r.models.length} models found${free ? `, ${free} of them free` : ''}. Pick some below.` });
    } finally { setBusy(''); }
  }
  async function test() {
    setBusy('test'); setMsg(null);
    try {
      const r = await api.testProvider(probe());
      setMsg(r.ok ? { severity: 'success', text: `Works (${(r.ms / 1000).toFixed(1)}s). The model said: ${r.reply}` } : { severity: 'error', text: r.error });
    } finally { setBusy(''); }
  }
  async function save() {
    setBusy('save'); setMsg(null);
    try {
      if (editing) {
        onSaved(await api.updateProvider(f.id, { kind: f.kind, name: f.name, base_url: f.base_url, model: f.model, vision: f.vision,
          ...(keys.length ? { api_key: keys[0] } : {}) }));
      } else {
        onSaved(await api.addProvider({ kind: f.kind, name: f.name, base_url: f.base_url, vision: f.vision,
          models: f.models, api_keys: keys.length ? keys : [''] }));
      }
    } catch (e) { setMsg({ severity: 'error', text: e.message }); } finally { setBusy(''); }
  }

  return (
    <Stack spacing={2} sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
        <TextField select label="Provider" value={f.kind} onChange={(e) => pickKind(e.target.value)} disabled={editing}>
          {presets.map((p) => <MenuItem key={p.kind} value={p.kind}>{p.name}</MenuItem>)}
        </TextField>
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Box>
      <TextField label="API URL" value={f.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })}
        helperText="Any OpenAI-compatible endpoint (the part before /chat/completions)." />
      <TextField label={editing ? 'API key' : 'API keys (one per line)'} type={editing ? 'password' : 'text'} autoComplete="off"
        multiline={!editing} minRows={editing ? 1 : 2} value={f.keys} onChange={(e) => setF({ ...f, keys: e.target.value })}
        placeholder={editing && f.api_key_set ? `Saved ${f.api_key_hint}. Leave empty to keep it` : preset?.needs_key ? '' : 'Not needed'}
        helperText={<>
          {preset?.key_url ? <>Get one at <Link href={preset.key_url} target="_blank" rel="noreferrer">{preset.key_url.replace('https://', '')}</Link>. </> : null}
          {editing ? 'It stays on this computer.' : 'Paste several keys (for example from different accounts) and every key is used with every model. Keys stay on this computer.'}
        </>} />
      {editing
        ? <Autocomplete freeSolo options={shown} inputValue={f.model} onInputChange={(_, v) => setF({ ...f, model: v })}
            renderInput={(params) => <TextField {...params} label="Model" helperText={preset?.model_hint || ''} />} />
        : <Autocomplete multiple freeSolo filterSelectedOptions options={shown} value={f.models}
            onChange={(_, v) => setF({ ...f, models: v.map((x) => String(x).trim()).filter(Boolean) })}
            renderTags={(v, getProps) => v.map((o, i) => { const { key, ...p } = getProps({ index: i }); return <Chip key={key} size="small" label={o} {...p} />; })}
            renderInput={(params) => <TextField {...params} label="Models (pick several)" helperText={preset?.model_hint || 'Type a name and press Enter, or Fetch models'} />} />}
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <FormControlLabel control={<Checkbox checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />} label="Show free models only" />
        {!editing && (
          <Button size="small" disabled={!options.some((o) => o.free)}
            onClick={() => setF({ ...f, models: [...new Set([...f.models, ...options.filter((o) => o.free).map((o) => o.id)])].slice(0, 40) })}>
            Select all free models (max 40)
          </Button>
        )}
        <FormControlLabel control={<Checkbox checked={f.vision} onChange={(e) => setF({ ...f, vision: e.target.checked })} />}
          label="They can look at screenshots (leave off if unsure)" />
      </Stack>
      {msg && <Alert severity={msg.severity}>{msg.text}</Alert>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant="contained" onClick={save} disabled={Boolean(busy) || (!editing && !f.models.length)}>
          {editing ? 'Save' : `Add ${count} ${count === 1 ? 'entry' : 'entries'}`}
        </Button>
        <Button onClick={test} disabled={Boolean(busy) || !probe().model} startIcon={<Zap size={15} />}>{busy === 'test' ? 'Testing…' : 'Test first'}</Button>
        <Button onClick={fetchModels} disabled={Boolean(busy)}>{busy === 'models' ? 'Loading…' : 'Fetch models'}</Button>
        <Button color="inherit" onClick={onCancel}>Cancel</Button>
      </Stack>
    </Stack>
  );
}

function resting(p) {
  if (!p.cooldown_until) return '';
  const m = Math.max(1, Math.ceil((p.cooldown_until - Date.now()) / 60_000));
  return m >= 90 ? `resting ${Math.round(m / 60)} h` : `resting ${m} min`;
}

export default function AiProviders({ engine, onEngine, onChange }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.providers().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  const done = (next) => { setData(next); setForm(null); onChange?.(); };
  const on = data.providers.filter((p) => p.enabled);
  const ready = on.filter((p) => !p.cooldown_until).length;

  return (
    <Panel title="AI engine">
      <ToggleButtonGroup exclusive size="small" value={engine} onChange={(_, v) => v && onEngine(v)} sx={{ mb: 2 }}>
        <ToggleButton value="api">Any AI provider (free options)</ToggleButton>
        <ToggleButton value="claude">Claude Code (Pro or Max)</ToggleButton>
      </ToggleButtonGroup>
      {engine === 'api' ? (
        <Stack spacing={1.5}>
          <Typography fontSize={14} color="text.secondary">
            An AI model reads each page and clicks and types in your own Chrome, one saved login per account. Add as many models and keys as you
            like (OpenRouter and Google Gemini have free ones, Ollama runs on this computer). When one hits its limit PostVane rests it and
            carries on with the next, even in the middle of a post.
          </Typography>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField select size="small" label="When there are several" value={data.strategy} sx={{ minWidth: 300 }}
              onChange={async (e) => { await api.saveSettings({ ai_strategy: e.target.value }); load(); onChange?.(); }}>
              <MenuItem value="rotate">Take turns (spreads the free limits)</MenuItem>
              <MenuItem value="failover">Use the first one until it runs out</MenuItem>
            </TextField>
            {on.length > 0 && <Chip size="small" color={ready ? 'success' : 'warning'} label={`${ready} of ${on.length} ready`} />}
          </Stack>
          {data.providers.map((p) => (
            <Stack key={p.id} direction="row" alignItems="center" spacing={1}
              sx={{ p: 0.75, pl: 1, border: 1, borderColor: 'divider', borderRadius: 2, opacity: p.enabled ? 1 : 0.55 }}>
              <Switch size="small" checked={p.enabled} onChange={async (e) => done(await api.updateProvider(p.id, { enabled: e.target.checked }))} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography fontWeight={700} fontSize={14} noWrap>{p.model}</Typography>
                <Typography fontSize={12} color="text.secondary" noWrap>{p.name} · {p.base_url.replace(/^https?:\/\//, '')}</Typography>
              </Box>
              {p.api_key_set && <Chip size="small" label={`key ${p.api_key_hint}`} />}
              {resting(p) && <Tooltip title={p.last_error || 'Hit its limit'}><Chip size="small" color="warning" label={resting(p)} /></Tooltip>}
              <IconButton size="small" aria-label="Edit" onClick={() => setForm({ ...p, keys: '', models: [] })}><Pencil size={16} /></IconButton>
              <IconButton size="small" aria-label="Delete" onClick={async () => done(await api.deleteProvider(p.id))}><Trash2 size={16} /></IconButton>
            </Stack>
          ))}
          {!data.providers.length && <Alert severity="info">Add models to get started. OpenRouter and Gemini give you a free key in a minute.</Alert>}
          {form
            ? <ProviderForm presets={data.presets} initial={form} onSaved={done} onCancel={() => setForm(null)} />
            : (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button startIcon={<Plus size={16} />} onClick={() => setForm({ ...EMPTY })}>Add models</Button>
                {data.providers.some((p) => p.cooldown_until) && (
                  <Button color="inherit" startIcon={<RotateCcw size={15} />} onClick={async () => done(await api.resetProviders())}>Wake all up now</Button>
                )}
                {data.providers.length > 1 && <Button color="inherit" onClick={async () => done(await api.deleteAllProviders())}>Remove all</Button>}
              </Stack>
            )}
        </Stack>
      ) : (
        <Typography fontSize={14} color="text.secondary">
          Claude Code runs on your own Claude subscription (Pro or Max) and posts through the Claude in Chrome extension. Pick this only if you have a paid plan.
        </Typography>
      )}
    </Panel>
  );
}
