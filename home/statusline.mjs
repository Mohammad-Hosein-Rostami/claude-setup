// Status line: model tier, effort, CONTEXT SIZE in tokens (what every tool call re-reads), cost, 5h usage.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch {}
  const name = d.model?.display_name ?? '?';
  const id = d.model?.id ?? '';
  const tier = /opus/i.test(id + name) ? '\x1b[35mOPUS\x1b[0m' : /haiku/i.test(id + name) ? '\x1b[36mhaiku\x1b[0m' : '\x1b[32msonnet\x1b[0m';
  const effort = d.effort?.level;
  const tokens = d.context_window?.total_input_tokens ?? 0;
  const k = Math.round(tokens / 1000);
  // Cost per tool call scales with this number: green < 60k, yellow < 150k, red above.
  const color = tokens >= 150000 ? '31' : tokens >= 60000 ? '33' : '32';
  const cost = d.cost?.total_cost_usd;
  const five = d.rate_limits?.five_hour?.used_percentage;
  const parts = [`${tier} ${name}${effort ? ` (${effort})` : ''}`, `\x1b[${color}mctx ${k}k\x1b[0m`];
  if (typeof cost === 'number') parts.push(`$${cost.toFixed(2)}`);
  if (typeof five === 'number') parts.push(`5h ${Math.round(five)}%`);
  if (tokens >= 150000) parts.push('\x1b[31m/clear before the next task\x1b[0m');
  else if (tokens >= 60000) parts.push('\x1b[33mlong ctx: batch calls\x1b[0m');
  console.log(parts.join(' │ '));
});
