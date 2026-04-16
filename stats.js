/**
 * Shared coffee stats via a GitHub Gist.
 *
 * The gist contains a single file "coffee-stats.json" with:
 * {
 *   "totalCoffees": 42,
 *   "lastOrder": { "ts": "...", "user": "Erik", "product": "Americano" }
 * }
 *
 * Requires GITHUB_TOKEN and GITHUB_GIST_ID in .env.
 */

const GIST_FILE = 'coffee-stats.json';

function getConfig() {
  const token = process.env.GITHUB_TOKEN;
  const gistId = process.env.GITHUB_GIST_ID;
  if (!token || !gistId) return null;
  return { token, gistId };
}

async function readStats(config) {
  const res = await fetch(`https://api.github.com/gists/${config.gistId}`, {
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to read gist (${res.status}): ${await res.text()}`);
  }
  const gist = await res.json();
  const raw = gist.files?.[GIST_FILE]?.content;
  if (!raw) {
    return { totalCoffees: 0, lastOrder: null };
  }
  return JSON.parse(raw);
}

async function writeStats(config, stats) {
  const res = await fetch(`https://api.github.com/gists/${config.gistId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [GIST_FILE]: {
          content: JSON.stringify(stats, null, 2),
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to update gist (${res.status}): ${await res.text()}`);
  }
}

/**
 * Record a successful coffee order. Increments the counter and updates lastOrder.
 * Fails silently if stats are not configured — ordering should never break because of vanity metrics.
 */
export async function recordOrder({ user, product }) {
  const config = getConfig();
  if (!config) return;
  try {
    const stats = await readStats(config);
    stats.totalCoffees += 1;
    stats.lastOrder = { ts: new Date().toISOString(), user, product };
    await writeStats(config, stats);
  } catch (err) {
    // Vanity metrics should never block the happy path
    process.stderr.write(`[stats] Failed to record order: ${err.message}\n`);
  }
}

/**
 * Get current stats. Returns null if not configured.
 */
export async function getStats() {
  const config = getConfig();
  if (!config) return null;
  return readStats(config);
}
