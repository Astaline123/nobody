// Turns config.yaml into the `Rules` the contract takes. `node scripts/rules.mjs` prints them.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Reads the small part of YAML the config uses: `key: value`, one level of nesting, comments. */
export function parseConfig(text) {
  const config = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^(\s*)([a-z_]+):\s*(.*)$/);
    if (!match) throw new Error(`config.yaml: cannot read "${line}"`);
    const [, indent, key, value] = match;
    if (!value) {
      section = key;
      config[key] = {};
    } else if (indent) {
      config[section][key] = JSON.parse(value);
    } else {
      section = null;
      config[key] = JSON.parse(value);
    }
  }
  return config;
}

/** Decimal text to a whole number of base units, without going through floats. */
function units(value, decimals) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals)).toString();
}

export function toRules(config) {
  const need = (key) => {
    if (config[key] === undefined) throw new Error(`config.yaml: ${key} is missing`);
    return config[key];
  };
  const split = need('revenue_split');
  return {
    paused: need('kill_switch'),
    min_price: units(need('min_price_usd'), 6),
    max_price: units(need('max_price_usd'), 6),
    max_ai_per_day: units(need('max_ai_spend_usd_per_day'), 6),
    ai_reserve_per_run: units(need('ai_reserve_per_run_usd'), 6),
    contributors_bps: split.contributors_percent * 100,
    referrer_bps: split.referrer_percent * 100,
    stake_bps: split.stake_percent * 100,
    board_every: need('price_review_every_sales'),
    run_deposit: units(need('compute_deposit_near'), 24),
    near_floor: units(need('near_floor'), 24),
    ai_stake_cap: units(need('ai_stake_cap_near'), 24),
    keep_liquid: units(need('keep_liquid_near'), 24),
  };
}

export function loadRules(url = new URL('../config.yaml', import.meta.url)) {
  return toRules(parseConfig(readFileSync(url, 'utf8').replace(/\r\n/g, '\n')));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(loadRules(), null, 2));
}
