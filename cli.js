#!/usr/bin/env node

/**
 * qopla-coffee CLI — Order coffee from Brod & Salt via Qopla subscription.
 *
 * Commands:
 *   order   — Place a subscription order (default: Americano)
 *   status  — Check subscription status and cooldown
 *   menu    — List available menu items
 */

import { buildCommand, buildRouteMap, buildApplication, run, numberParser } from '@stricli/core';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  login,
  getSubscription,
  getMinimumPurchaseInterval,
  getMenu,
  checkCooldown,
  placeOrder,
} from './qopla-client.js';
import { recordOrder, getStats } from './stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- .env loader ----------

function loadEnv() {
  try {
    const envPath = resolve(__dirname, '.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* .env is optional */ }
}

loadEnv();

// ---------- Shared helpers ----------

function getUsers() {
  const users = [];
  for (let i = 1; i <= 20; i++) {
    const name = process.env[`QOPLA_USER_${i}_NAME`];
    const email = process.env[`QOPLA_USER_${i}_EMAIL`];
    const password = process.env[`QOPLA_USER_${i}_PASSWORD`];
    if (email && password) {
      users.push({ name: name || email, email, password });
    }
  }
  return users;
}

function resolveUser(userName) {
  const users = getUsers();
  if (users.length === 0) {
    throw new Error('No users configured. Copy .env.example to .env and fill in credentials.');
  }
  if (userName) {
    const found = users.find(u => u.name.toLowerCase() === userName.toLowerCase());
    if (!found) {
      throw new Error(`User "${userName}" not found. Available: ${users.map(u => u.name).join(', ')}`);
    }
    return found;
  }
  return users[0];
}

async function authenticate(stdout, userName) {
  const user = resolveUser(userName);
  stdout.write(`Logging in as ${user.name} (${user.email})...\n`);
  const { userAccountId, cookies } = await login(user.email, user.password);
  stdout.write(`  Logged in. Account ID: ${userAccountId}\n`);
  return { user, userAccountId, cookies };
}

// ---------- "order" command ----------

const orderCommand = buildCommand({
  async func(flags) {
    const stdout = this.process.stdout;
    const { user, userAccountId, cookies } = await authenticate(stdout, flags.user);

    // Check subscription + cooldown
    const sub = await getSubscription(userAccountId, cookies);
    stdout.write(`Subscription: ${sub.subscriptionName} (${sub.status})\n`);

    const intervalMs = await getMinimumPurchaseInterval(cookies);
    const cooldown = checkCooldown(sub.latestOrderTimestamp, intervalMs);

    if (!cooldown.canOrder) {
      stdout.write(`\nCannot order yet. ${cooldown.minutesRemaining} minutes remaining.\n`);
      stdout.write(`Next order available at: ${cooldown.nextOrderTime.toLocaleTimeString()}\n`);
      return;
    }

    if (flags.dryRun) {
      stdout.write('\nReady to order! (--dry-run: skipping)\n');
      return;
    }

    // Resolve product
    const productName = flags.product || ' Americano';
    const refProductId = flags.productId || '620104c9b75c162283cf3146';
    const unitPrice = flags.price ?? 46;

    stdout.write(`\nPlacing order: ${productName.trim()} (${unitPrice} kr, 100% subscription discount)...\n`);

    const result = await placeOrder({
      userAccountId,
      userSubscriptionId: sub.userSubscriptionId,
      subscriptionId: sub.subscriptionId,
      subscriptionName: sub.subscriptionName,
      productName,
      refProductId,
      unitPrice,
      contactInformation: {
        name: user.name,
        email: user.email,
        phoneNumber: '',
      },
    }, cookies);

    stdout.write(`Order placed! Order #${result.orderNo} (${result.status})\n`);

    await recordOrder({ user: user.name, product: productName.trim() });
  },
  parameters: {
    flags: {
      user: {
        kind: 'parsed',
        parse: String,
        brief: 'Name of the team member to order for',
        optional: true,
      },
      dryRun: {
        kind: 'boolean',
        brief: 'Check status without placing an order',
        optional: true,
        default: false,
      },
      product: {
        kind: 'parsed',
        parse: String,
        brief: 'Product name (default: Americano)',
        optional: true,
      },
      productId: {
        kind: 'parsed',
        parse: String,
        brief: 'Product ID from the menu (use "menu" command to find IDs)',
        optional: true,
      },
      price: {
        kind: 'parsed',
        parse: numberParser,
        brief: 'Unit price of the product in kr (default: 46)',
        optional: true,
      },
    },
  },
  docs: {
    brief: 'Place a subscription coffee order',
  },
});

// ---------- "status" command ----------

const statusCommand = buildCommand({
  async func(flags) {
    const stdout = this.process.stdout;
    const { userAccountId, cookies } = await authenticate(stdout, flags.user);

    const sub = await getSubscription(userAccountId, cookies);
    const intervalMs = await getMinimumPurchaseInterval(cookies);
    const cooldown = checkCooldown(sub.latestOrderTimestamp, intervalMs);

    stdout.write(`\nSubscription: ${sub.subscriptionName}\n`);
    stdout.write(`Status: ${sub.status}\n`);
    stdout.write(`Last order: ${sub.latestOrderTimestamp || 'never'}\n`);
    stdout.write(`Cooldown: ${intervalMs / 60000} minutes\n`);

    if (cooldown.canOrder) {
      stdout.write(`\nReady to order!\n`);
    } else {
      stdout.write(`\n${cooldown.minutesRemaining} minutes until next order.\n`);
      stdout.write(`Next order at: ${cooldown.nextOrderTime.toLocaleTimeString()}\n`);
    }
  },
  parameters: {
    flags: {
      user: {
        kind: 'parsed',
        parse: String,
        brief: 'Name of the team member',
        optional: true,
      },
    },
  },
  docs: {
    brief: 'Check subscription status and cooldown',
  },
});

// ---------- "menu" command ----------

const menuCommand = buildCommand({
  async func(flags) {
    const stdout = this.process.stdout;
    const { cookies } = await authenticate(stdout, flags.user);

    stdout.write('\nLoading menu...\n');
    const menus = await getMenu(cookies);

    for (const menu of menus) {
      stdout.write(`\n=== ${menu.name} ===\n`);
      for (const cat of menu.menuProductCategories || []) {
        stdout.write(`\n  ${cat.name}:\n`);
        for (const mp of cat.menuProducts || []) {
          const p = mp.refProduct;
          const price = mp.price ?? p.defaultPrice;
          stdout.write(`    - ${p.name} (${price} kr) [id: ${p.id}]\n`);
        }
      }
    }
  },
  parameters: {
    flags: {
      user: {
        kind: 'parsed',
        parse: String,
        brief: 'Name of the team member (for auth)',
        optional: true,
      },
    },
  },
  docs: {
    brief: 'List available menu items with product IDs',
  },
});

// ---------- "stats" command ----------

const statsCommand = buildCommand({
  async func() {
    const stdout = this.process.stdout;
    const stats = await getStats();
    if (!stats) {
      stdout.write('Stats not configured. Set GITHUB_TOKEN and GITHUB_GIST_ID in .env\n');
      return;
    }

    stdout.write(`\nTotal coffees ordered: ${stats.totalCoffees}\n`);

    if (stats.lastOrder) {
      const last = new Date(stats.lastOrder.ts);
      const ago = Date.now() - last.getTime();
      const mins = Math.floor(ago / 60000);
      const hours = Math.floor(mins / 60);
      const days = Math.floor(hours / 24);

      let agoStr;
      if (days > 0) agoStr = `${days}d ${hours % 24}h ago`;
      else if (hours > 0) agoStr = `${hours}h ${mins % 60}m ago`;
      else agoStr = `${mins}m ago`;

      stdout.write(`Last order: ${stats.lastOrder.product} by ${stats.lastOrder.user} (${agoStr})\n`);
    }
  },
  parameters: { flags: {} },
  docs: {
    brief: 'Show coffee counter and time since last order',
  },
});

// ---------- App ----------

const routes = buildRouteMap({
  routes: {
    order: orderCommand,
    status: statusCommand,
    menu: menuCommand,
    stats: statsCommand,
  },
  docs: {
    brief: 'Order coffee from Brod & Salt via Qopla subscription',
  },
});

const app = buildApplication(routes, {
  name: 'qopla-coffee',
  versionInfo: {
    currentVersion: '1.0.0',
  },
  scanner: {
    caseStyle: 'allow-kebab-for-camel',
  },
});

await run(app, process.argv.slice(2), {
  process,
});
