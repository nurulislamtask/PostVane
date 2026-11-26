import React, { useEffect, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, Chip, FormControlLabel, IconButton, Link, MenuItem, Radio, Stack, TextField,
  ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { api } from '../api.js';
import { Panel } from '../components.jsx';

const EMPTY = { id: null, kind: 'openrouter', name: '', base_url: '', api_key: '', model: '', vision: false };

function ProviderForm({ presets, initial, onSaved, onCancel }) {
  const [f, setF] = useState(initial);
  const [models, setModels] = useState([]);
  const [msg, setMsg] = useState(null); // { severity, text }
  const [busy, setBusy] = useState('');
  const preset = presets.find((p) => p.kind === f.kind);
  const editing = Boolean(f.id);

  function pickKind(kind) {
    const p = presets.find((x) => x.kind === kind);
    setF({ ...f, kind, name: f.name && editing ? f.name : p.name, base_url: p.base_url });
    setModels([]);
  }
  useEffect(() => { if (!editing && !f.base_url) pickKind(f.kind); /* first preset */ }, []); // eslint-disable-line

  const body = () => ({ id: f.id || undefined, base_url: f.base_url, api_key: f.api_key, model: f.model });

  async function fetchModels() {
    setBusy('models'); setMsg(null);
    try {
      const r = await api.providerModels(body());
      setModels(r.models);
      setMsg(r.error ? { severity: 'error', text: r.error } : { severity: 'success', text: `${r.models.length} models found. Pick one above.` });
    } finally { setBusy(''); }
  }
  async function test() {
    setBusy('test'); setMsg(null);
    try {
      const r = await api.testProvider(body());
      setMsg(r.ok ? { severity: 'success', text: `Works (${(r.ms / 1000).toFixed(1)}s). The model said: ${r.reply}` } : { severity: 'error', text: r.error });
    } finally { setBusy(''); }
  }
  async function save() {
    setBusy('save'); setMsg(null);
    try {
      const payload = { kind: f.kind, name: f.name, base_url: f.base_url, model: f.model, vision: f.vision,
        ...(f.api_key !== '' || !editing ? { api_key: f.api_key } : {}) };
      onSaved(editing ? await api.updateProvider(f.id, payload) : await api.addProvider(payload));
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
      <TextField label="API key" type="password" autoComplete="off" value={f.api_key}
        onChange={(e) => setF({ ...f, api_key: e.target.value })}
        placeholder={editing && f.api_key_set ? `Saved ${f.api_key_hint}. Leave empty to keep it` : preset?.needs_key ? '' : 'Not needed'}
        helperText={preset?.key_url ? <>Get one at <Link href={preset.key_url} target="_blank" rel="noreferrer">{preset.key_url.replace('https://', '')}</Link>. It stays on this computer.</> : 'Stays on this computer.'} />
      <Autocomplete freeSolo options={models} inputValue={f.model} onInputChange={(_, v) => setF({ ...f, model: v })}
        renderInput={(params) => <TextField {...params} label="Model" helperText={preset?.model_hint || ''} />} />
      <FormControlLabel control={<Checkbox checked={f.vision} onChange={(e) => setF({ ...f, vision: e.target.checked })} />}
        label="This model can look at screenshots (leave off if unsure)" />
      {msg && <Alert severity={msg.severity}>{msg.text}</Alert>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant="contained" onClick={save} disabled={Boolean(busy)}>{editing ? 'Save provider' : 'Add provider'}</Button>
        <Button onClick={test} disabled={Boolean(busy) || !f.model} startIcon={<Zap size={15} />}>{busy === 'test' ? 'Testing…' : 'Test'}</Button>
        <Button onClick={fetchModels} disabled={Boolean(busy)}>{busy === 'models' ? 'Loading…' : 'Fetch models'}</Button>
        <Button color="inherit" onClick={onCancel}>Cancel</Button>
      </Stack>
    </Stack>
  );
}

export default function AiProviders({ engine, onEngine, onChange }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.providers().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  if (!data) return error ? <Alert severity="error">{error}</Alert> : null;

  const done = (next) => { setData(next); setForm(null); onChange?.(); };
  async function activate(id) { done(await api.activateProvider(id)); }
  async function remove(id) { done(await api.deleteProvider(id)); }

  return (
    <Panel title="AI engine">
      <ToggleButtonGroup exclusive size="small" value={engine} onChange={(_, v) => v && onEngine(v)} sx={{ mb: 2 }}>
        <ToggleButton value="api">Any AI provider (free options)</ToggleButton>
        <ToggleButton value="claude">Claude Code (Pro or Max)</ToggleButton>
      </ToggleButtonGroup>
      {engine === 'api' ? (
        <Stack spacing={1.5}>
          <Typography fontSize={14} color="text.secondary">
            An AI model reads each page and clicks and types in your own Chrome, one saved login per account. Use OpenRouter or Google
            Gemini (both have free models), Ollama on this computer, or any OpenAI-compatible URL. The same model also writes posts in Compose.
            Stronger models post more reliably; very small ones often get lost on Facebook.
          </Typography>
          {data.providers.map((p) => (
            <Stack key={p.id} direction="row" alignItems="center" spacing={1} sx={{ p: 1, border: 1, borderColor: p.active ? 'primary.main' : 'divider', borderRadius: 2 }}>
              <Radio checked={p.active} onChange={() => activate(p.id)} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography fontWeight={700} noWrap>{p.name}</Typography>
                <Typography fontSize={13} color="text.secondary" noWrap>{p.model} · {p.base_url}</Typography>
              </Box>
              {p.api_key_set && <Chip size="small" label={`key ${p.api_key_hint}`} />}
              {p.active && <Chip size="small" color="primary" label="In use" />}
              <IconButton aria-label="Edit" onClick={() => setForm({ ...p, api_key: '' })}><Pencil size={17} /></IconButton>
              <IconButton aria-label="Delete" onClick={() => remove(p.id)}><Trash2 size={17} /></IconButton>
            </Stack>
          ))}
          {!data.providers.length && <Alert severity="info">Add a provider to get started. OpenRouter and Gemini give you a free key in a minute.</Alert>}
          {form
            ? <ProviderForm presets={data.presets} initial={form} onSaved={done} onCancel={() => setForm(null)} />
            : <Box><Button startIcon={<Plus size={16} />} onClick={() => setForm({ ...EMPTY })}>Add provider</Button></Box>}
        </Stack>
      ) : (
        <Typography fontSize={14} color="text.secondary">
          Claude Code runs on your own Claude subscription (Pro or Max) and posts through the Claude in Chrome extension. Pick this only if you have a paid plan.
        </Typography>
      )}
    </Panel>
  );
}
