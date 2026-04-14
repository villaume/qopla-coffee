# Qopla Coffee Ordering

Order coffee from Brod & Salt (Torsplan) via your Qopla subscription, from the command line.

## Setup

```bash
cd tools/qopla-coffee
npm install
cp .env.example .env
# Fill in your team's Qopla credentials in .env
```

## Usage

```bash
# Check subscription status and cooldown
node cli.js status

# See what's on the menu
node cli.js menu

# Order coffee (default: Americano, first user in .env)
node cli.js order

# Dry run (check if you can order without placing it)
node cli.js order --dry-run

# Order for a specific team member
node cli.js order --user Erik

# Order a different product (use `menu` to find IDs)
node cli.js order --product "Enkel espresso" --product-id 60be0eec8a69f0381f37f6a6 --price 33

# Help
node cli.js --help
node cli.js order --help
```

## How it works

1. Logs into Qopla with your credentials via GraphQL API
2. Checks your "Coworker" subscription status and 2-hour cooldown
3. Places a subscription redemption order (100% discount, no payment needed)

## Adding team members

Edit `.env` and add more users:

```env
QOPLA_USER_2_NAME=Alice
QOPLA_USER_2_EMAIL=alice@wundrblock.com
QOPLA_USER_2_PASSWORD=their-password
```

Then order for them with `node cli.js order --user Alice`.
