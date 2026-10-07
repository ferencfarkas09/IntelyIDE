// Demo repository fb-api: the order, catalog and customer API of the fictional Fernbank Cycles (TypeScript, Fastify, zod).
// Everything here is invented. File contents are template strings so that TypeScript, lint and CodeQL tooling do not
// treat them as project source. Schema and rules: scripts/demo-workspace/README.md.
//
// Story shared with fb-web and fb-mobile: the refund work (tickets FB-214, FB-231, FB-248). The checked-out branch
// feature/order-refunds is three commits ahead of origin; the work tree holds the unfinished refund service and routes.

/** Template literal helper: drops the first newline so every file reads naturally in this source. */
const t = (s) => s[0].replace(/^\n/, "");

/** Replaces `from` by `to` exactly once and fails loudly when the anchor is missing (keeps versions in sync). */
const edit = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error("fb-api: edit anchor must occur exactly once: " + from.slice(0, 48));
  return text.replace(from, () => to);
};

const json = (o) => JSON.stringify(o, null, 2) + "\n";

// ---------------------------------------------------------------------------------------------------- tooling
const gitignore = t`
node_modules
dist
coverage
*.log
.DS_Store
`;

const readme1 = t`
# fb-api

Order, catalog and customer API for Fernbank Cycles.

## Getting started

    pnpm install
    cp .env.example .env
    pnpm db:migrate
    pnpm dev

The service listens on port 3000 and exposes a health check at /health.
`;
const readme2 = edit(
  readme1,
  "The service listens on port 3000 and exposes a health check at /health.\n",
  t`
The service listens on port 3000 and exposes a health check at /health.

## Order lifecycle

Orders start as pending and move through paid, shipped and delivered. Only
pending and paid orders can be cancelled. Every transition is validated by the
order service, so an invalid move answers 409.

## Tests

    pnpm test
`,
);
const readme3 = edit(
  readme2,
  "## Tests\n",
  t`
## Refunds

A customer can ask for a refund within 30 days of delivery (FB-214). Small
amounts are approved automatically, larger ones wait for a person. The policy
lives in src/refunds/refund.policy.ts; the gateway call is made by the refund
service once the request is approved.

## Tests
`,
);

const pkg = ({ version, deps, dev, extraScripts = {} }) =>
  json({
    name: "@fernbank/api",
    version,
    private: true,
    type: "module",
    scripts: {
      dev: "tsx watch src/server.ts",
      build: "tsc -p tsconfig.json",
      start: "node dist/server.js",
      test: "vitest run",
      ...extraScripts,
      "db:migrate": "tsx scripts/migrate.ts",
    },
    dependencies: deps,
    devDependencies: dev,
  });
const deps0 = { fastify: "^4.28.0", "fastify-plugin": "^4.5.1", jsonwebtoken: "^9.0.2", pg: "^8.12.0", zod: "^3.23.0" };
const dev0 = { "@types/node": "^20.14.0", tsx: "^4.16.0", typescript: "^5.5.0" };
const pkg0 = pkg({ version: "1.7.0", deps: deps0, dev: dev0 });
const pkg1 = pkg({ version: "1.7.0", deps: deps0, dev: { ...dev0, eslint: "^9.6.0", prettier: "^3.3.0", vitest: "^1.6.0" }, extraScripts: { lint: "eslint src test" } });
const pkg2 = edit(pkg1, '"version": "1.7.0"', '"version": "1.8.0"');
const deps3 = { fastify: "^4.28.1", "fastify-plugin": "^4.5.1", jsonwebtoken: "^9.0.2", pg: "^8.12.1", zod: "^3.23.8" };
const pkg3 = pkg({ version: "1.8.0", deps: deps3, dev: { ...dev0, eslint: "^9.6.0", prettier: "^3.3.2", vitest: "^2.0.0" }, extraScripts: { lint: "eslint src test" } });
const pkg4 = edit(pkg3, '"version": "1.8.0"', '"version": "1.9.0"');

const tsconfig = json({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    outDir: "dist",
    rootDir: ".",
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  },
  include: ["src", "scripts", "test"],
});

const envExample1 = t`
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://fernbank@db.fernbank.example:5432/fernbank
LOG_LEVEL=info
JWT_SECRET=change-me
`;
const envExample2 = envExample1 + t`
PAYMENT_GATEWAY_URL=https://pay.fernbank.example
PAYMENT_API_KEY=change-me
`;
const envExample3 = envExample2 + t`
REFUND_WINDOW_DAYS=30
REFUND_AUTO_APPROVE_BELOW=2500
`;

// ---------------------------------------------------------------------------------------------------- app shell
const server1 = t`
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ port: 3000, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
`;
const server2 = t`
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });
  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
`;

const app1 = t`
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./health/health.routes.js";

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  await app.register(healthRoutes, { prefix: "/health" });
  return app;
}
`;
const app2 = t`
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { healthRoutes } from "./health/health.routes.js";

export interface AppOptions {
  config: Config;
}

export async function buildApp({ config }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  await app.register(healthRoutes, { prefix: "/health" });
  return app;
}
`;
const app3 = t`
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { productRoutes } from "./catalog/product.routes.js";
import { customerRoutes } from "./customers/customer.routes.js";
import { createPool } from "./db/client.js";
import { healthRoutes } from "./health/health.routes.js";
import { errorHandler } from "./lib/errors.js";
import { orderRoutes } from "./orders/order.routes.js";

export interface AppOptions {
  config: Config;
}

export async function buildApp({ config }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  const pool = createPool(config.DATABASE_URL);
  app.setErrorHandler(errorHandler);
  app.addHook("onClose", async () => pool.end());
  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(productRoutes, { prefix: "/products", pool });
  await app.register(customerRoutes, { prefix: "/customers", pool });
  await app.register(orderRoutes, { prefix: "/orders", pool });
  return app;
}
`;
const app4 = edit(
  edit(app3, 'import { orderRoutes } from "./orders/order.routes.js";\n', 'import { orderRoutes } from "./orders/order.routes.js";\nimport { authPlugin } from "./plugins/auth.js";\n'),
  '  await app.register(healthRoutes, { prefix: "/health" });\n',
  '  await app.register(authPlugin, { secret: config.JWT_SECRET });\n  await app.register(healthRoutes, { prefix: "/health" });\n',
);
const app5 = edit(
  edit(app4, 'import { orderRoutes } from "./orders/order.routes.js";\n', 'import { orderRoutes } from "./orders/order.routes.js";\nimport { paymentRoutes } from "./payments/payment.routes.js";\n'),
  '  await app.register(orderRoutes, { prefix: "/orders", pool });\n',
  '  await app.register(orderRoutes, { prefix: "/orders", pool });\n  await app.register(paymentRoutes, { prefix: "/payments", pool });\n',
);
const app6 = edit(
  edit(
    edit(app5, 'import { paymentRoutes } from "./payments/payment.routes.js";\n', 'import { createPaymentClient } from "./payments/payment.client.js";\nimport { paymentRoutes } from "./payments/payment.routes.js";\nimport { refundRoutes } from "./refunds/refund.routes.js";\n'),
    '  app.setErrorHandler(errorHandler);\n',
    '  const payments = createPaymentClient(config.PAYMENT_GATEWAY_URL, config.PAYMENT_API_KEY);\n  app.setErrorHandler(errorHandler);\n',
  ),
  '  await app.register(paymentRoutes, { prefix: "/payments", pool });\n',
  '  await app.register(paymentRoutes, { prefix: "/payments", pool });\n  await app.register(refundRoutes, { prefix: "/refunds", pool, payments });\n',
);

const config1 = t`
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  JWT_SECRET: z.string().min(8),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new Error("Invalid environment: " + fields.join(", "));
  }
  return parsed.data;
}
`;
const config2 = edit(config1, "  JWT_SECRET: z.string().min(8),\n", "  JWT_SECRET: z.string().min(8),\n  PAYMENT_GATEWAY_URL: z.string().url(),\n  PAYMENT_API_KEY: z.string().min(1),\n");

const health = t`
import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => ({ status: "ok", uptime: Math.round(process.uptime()) }));

  app.get("/ready", async (_request, reply) => {
    // Readiness stays cheap on purpose; the load balancer calls it every few seconds.
    return reply.code(200).send({ ready: true });
  });
};
`;

// ---------------------------------------------------------------------------------------------------- database
const dbClient = t`
import pg from "pg";

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export async function withTransaction<T>(pool: Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
`;
const migrateScript = t`
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/client.js";

const dir = join(import.meta.dirname, "..", "src", "db", "migrations");

async function run(): Promise<void> {
  const pool = createPool(loadConfig().DATABASE_URL);
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)");
  const done = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    await pool.query(await readFile(join(dir, name), "utf8"));
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    console.log("applied", name);
  }
  await pool.end();
}

void run();
`;
const backfill = t`
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/client.js";

// One-off: give every order created before migration 0003 a first history row.
async function run(): Promise<void> {
  const pool = createPool(loadConfig().DATABASE_URL);
  const { rowCount } = await pool.query(
    "INSERT INTO order_status_history (order_id, status, changed_at) SELECT id, status, created_at FROM orders WHERE id NOT IN (SELECT order_id FROM order_status_history)",
  );
  console.log("backfilled", rowCount, "orders");
  await pool.end();
}

void run();
`;
const mig1 = t`
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  category text NOT NULL,
  stock integer NOT NULL DEFAULT 0
);
`;
const mig2 = t`
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  shipping_country char(2) NOT NULL,
  subtotal integer NOT NULL,
  discount integer NOT NULL DEFAULT 0,
  tax integer NOT NULL,
  shipping integer NOT NULL,
  total integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  sku text NOT NULL REFERENCES products (sku),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price integer NOT NULL,
  discount_percent numeric(5, 2) NOT NULL DEFAULT 0
);
`;
const mig3a = t`
CREATE TABLE order_status_history (
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  status text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, changed_at);
`;
const mig3b = mig3a + t`

CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);
`;
const mig4 = t`
-- Refunds (FB-214, FB-248): two more order states and a refunds table.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'partially_refunded', 'refunded'));
ALTER TABLE orders ADD COLUMN refunded_total integer NOT NULL DEFAULT 0;

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  amount integer NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

// ---------------------------------------------------------------------------------------------------- lib
const errors = t`
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "error",
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, what + " not found", "not_found");
export const conflict = (message: string) => new HttpError(409, message, "conflict");

export function errorHandler(error: FastifyError | HttpError | ZodError, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ code: "invalid_request", issues: error.issues });
  }
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  }
  return reply.code(500).send({ code: "internal", message: "Something went wrong" });
}
`;
const money1 = t`
// Amounts are integers in minor units (cents). Never use floats for money.
export type Cents = number;

export function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}

export function formatMoney(cents: Cents, currency = "EUR"): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);
}

export function applyPercent(cents: Cents, percent: number): Cents {
  return Math.round((cents * percent) / 100);
}
`;
const money2 = edit(
  money1,
  "export function applyPercent(cents: Cents, percent: number): Cents {\n  return Math.round((cents * percent) / 100);\n}\n",
  "export function roundHalfUp(value: number): Cents {\n  return Math.floor(value + 0.5);\n}\n\nexport function applyPercent(cents: Cents, percent: number): Cents {\n  return roundHalfUp((cents * percent) / 100);\n}\n",
);
const money3 = edit(
  money2,
  "  return Math.floor(value + 0.5);\n",
  "  // Math.floor(-2.5 + 0.5) is -2, which would round negatives toward zero; mirror the sign instead.\n  return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);\n",
);
const pagination = t`
import { z } from "zod";

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
});

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(createdAt.toISOString() + "|" + id).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  return { createdAt: new Date(iso), id };
}
`;

// ---------------------------------------------------------------------------------------------------- catalog
const productSchema1 = t`
import { z } from "zod";

export const productSchema = z.object({
  sku: z.string().min(3).max(32),
  name: z.string().min(1).max(120),
  priceCents: z.number().int().nonnegative(),
  category: z.enum(["bikes", "parts", "apparel", "accessories"]),
  stock: z.number().int().nonnegative().default(0),
});

export const productParams = z.object({ sku: z.string() });

export type Product = z.infer<typeof productSchema>;
`;
const productSchema2 = edit(productSchema1, "  stock: z.number().int().nonnegative().default(0),\n", "  stock: z.number().int().nonnegative().default(0),\n  salePriceCents: z.number().int().nonnegative().optional(),\n");
const pricing1 = t`
import type { Cents } from "../lib/money.js";
import type { Product } from "./product.schema.js";

export function currentPrice(product: Product): Cents {
  return product.priceCents;
}

export function isInStock(product: Product, quantity = 1): boolean {
  return product.stock >= quantity;
}
`;
const pricing2 = edit(
  pricing1,
  "  return product.priceCents;\n",
  "  const { salePriceCents, priceCents } = product;\n  return salePriceCents !== undefined && salePriceCents < priceCents ? salePriceCents : priceCents;\n",
);
const productRoutes1 = t`
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "../db/client.js";
import { notFound } from "../lib/errors.js";
import { productParams, productSchema } from "./product.schema.js";

const toProduct = (row: Record<string, unknown>) => ({
  sku: row.sku,
  name: row.name,
  priceCents: row.price_cents,
  category: row.category,
  stock: row.stock,
});

export const productRoutes: FastifyPluginAsync<{ pool: Pool }> = async (app, { pool }) => {
  app.get("/", async () => {
    const { rows } = await pool.query("SELECT * FROM products ORDER BY name");
    return { items: rows.map(toProduct) };
  });

  app.get("/:sku", async (request) => {
    const { sku } = productParams.parse(request.params);
    const { rows } = await pool.query("SELECT * FROM products WHERE sku = $1", [sku]);
    if (!rows[0]) throw notFound("Product");
    return toProduct(rows[0]);
  });

  app.post("/", async (request, reply) => {
    const body = productSchema.parse(request.body);
    await pool.query("INSERT INTO products (sku, name, price_cents, category, stock) VALUES ($1, $2, $3, $4, $5)", [body.sku, body.name, body.priceCents, body.category, body.stock]);
    return reply.code(201).send(body);
  });
};
`;
const productRoutes2 = edit(
  edit(productRoutes1, "[body.sku, body.name, body.priceCents,", "[body.sku, body.name.trim(), body.priceCents,"),
  "return reply.code(201).send(body);",
  "return reply.code(201).send({ ...body, name: body.name.trim() });",
);

// ---------------------------------------------------------------------------------------------------- customers
const customerSchema1 = t`
import { z } from "zod";

export const customerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(32).optional(),
  marketingOptIn: z.boolean().default(false),
});

export const customerParams = z.object({ id: z.string().uuid() });
`;
const customerSchema2 = customerSchema1 + "export const customerQuery = z.object({ email: z.string().email().optional() });\n";
const customerService1 = t`
import type { z } from "zod";
import type { Pool } from "../db/client.js";
import { conflict, notFound } from "../lib/errors.js";
import type { customerSchema } from "./customer.schema.js";

export type NewCustomer = z.infer<typeof customerSchema>;

export function createCustomerService(pool: Pool) {
  return {
    async create(input: NewCustomer) {
      const existing = await pool.query("SELECT id FROM customers WHERE email = $1", [input.email]);
      if (existing.rows[0]) throw conflict("A customer with this e-mail address already exists");
      const { rows } = await pool.query(
        "INSERT INTO customers (name, email, phone, marketing_opt_in) VALUES ($1, $2, $3, $4) RETURNING id",
        [input.name, input.email, input.phone ?? null, input.marketingOptIn],
      );
      return { id: rows[0].id as string, ...input };
    },
    async get(id: string) {
      const { rows } = await pool.query("SELECT * FROM customers WHERE id = $1", [id]);
      if (!rows[0]) throw notFound("Customer");
      return rows[0];
    },
  };
}
`;
const customerService2 = edit(
  customerService1,
  "    async get(id: string) {",
  "    async findByEmail(email: string) {\n      const { rows } = await pool.query(\"SELECT * FROM customers WHERE lower(email) = lower($1)\", [email]);\n      return rows;\n    },\n    async get(id: string) {",
);
const customerRoutes1 = t`
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "../db/client.js";
import { customerParams, customerSchema } from "./customer.schema.js";
import { createCustomerService } from "./customer.service.js";

export const customerRoutes: FastifyPluginAsync<{ pool: Pool }> = async (app, { pool }) => {
  const customers = createCustomerService(pool);

  app.post("/", async (request, reply) => {
    const created = await customers.create(customerSchema.parse(request.body));
    return reply.code(201).send(created);
  });

  app.get("/:id", async (request) => {
    const { id } = customerParams.parse(request.params);
    return customers.get(id);
  });
};
`;
const customerRoutes2 = edit(
  edit(customerRoutes1, 'import { customerParams, customerSchema }', 'import { customerParams, customerQuery, customerSchema }'),
  '  app.get("/:id", async (request) => {',
  '  app.get("/", async (request) => {\n    const { email } = customerQuery.parse(request.query);\n    return { items: email ? await customers.findByEmail(email) : [] };\n  });\n\n  app.get("/:id", async (request) => {',
);

// ---------------------------------------------------------------------------------------------------- orders
const orderSchema1 = t`
import { z } from "zod";

export const orderStatus = z.enum(["pending", "paid", "shipped", "delivered", "cancelled"]);

export const orderLineSchema = z.object({
  sku: z.string().min(3),
  quantity: z.number().int().positive().max(50),
  unitPrice: z.number().int().nonnegative(),
  discountPercent: z.number().min(0).max(100).optional(),
});

export const newOrderSchema = z.object({
  customerId: z.string().uuid(),
  lines: z.array(orderLineSchema).min(1),
  shippingCountry: z.string().length(2),
});

export type NewOrder = z.infer<typeof newOrderSchema>;
export type OrderStatus = z.infer<typeof orderStatus>;
`;
const orderSchema2 = edit(orderSchema1, "export type NewOrder", "export const statusChangeSchema = z.object({ status: orderStatus, note: z.string().max(200).optional() });\n\nexport type NewOrder");
const orderSchema3 = edit(orderSchema2, 'z.enum(["pending", "paid", "shipped", "delivered", "cancelled"])', 'z.enum(["pending", "paid", "shipped", "delivered", "cancelled", "partially_refunded", "refunded"])');

// totals.ts: v1 hand-rolled rounding, v2 (= HEAD) shared helper. The work tree adds exactly three separate hunks.
const totals1 = t`
import type { Cents } from "../lib/money.js";
import type { NewOrder } from "./order.schema.js";

export type OrderLine = NewOrder["lines"][number];

export interface OrderTotals {
  subtotal: Cents;
  discount: Cents;
  tax: Cents;
  shipping: Cents;
  total: Cents;
}

const TAX_PERCENT = 21;
const FREE_SHIPPING_FROM: Cents = 5000;
const FLAT_SHIPPING: Cents = 595;

export function lineDiscount(line: OrderLine): Cents {
  if (!line.discountPercent) return 0;
  return Math.round((line.unitPrice * line.quantity * line.discountPercent) / 100);
}

export function shippingFor(subtotal: Cents): Cents {
  return subtotal >= FREE_SHIPPING_FROM ? 0 : FLAT_SHIPPING;
}

export function computeTotals(lines: OrderLine[]): OrderTotals {
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const discount = lines.reduce((sum, line) => sum + lineDiscount(line), 0);
  const taxable = subtotal - discount;
  const tax = Math.round((taxable * TAX_PERCENT) / 100);
  const shipping = shippingFor(taxable);
  return { subtotal, discount, tax, shipping, total: taxable + tax + shipping };
}

export function netTotal(totals: OrderTotals): Cents {
  return totals.total - totals.tax;
}
`;
const totals2 = edit(
  edit(
    edit(totals1, 'import type { Cents } from "../lib/money.js";', 'import { applyPercent, type Cents } from "../lib/money.js";'),
    "return Math.round((line.unitPrice * line.quantity * line.discountPercent) / 100);",
    "return applyPercent(line.unitPrice * line.quantity, line.discountPercent);",
  ),
  "const tax = Math.round((taxable * TAX_PERCENT) / 100);",
  "const tax = applyPercent(taxable, TAX_PERCENT);",
);
// staged part: the new optional field only
const totalsStaged = edit(totals2, "  total: Cents;\n}", "  total: Cents;\n  refunded?: Cents;\n}");
// work tree: a doc comment next to the staged line (hunk 1), a new helper (hunk 2) and the net total (hunk 3)
const totalsFinal = edit(
  edit(
    edit(totalsStaged, "  refunded?: Cents;\n", "  /** Sum of the refunds already paid out for this order. */\n  refunded?: Cents;\n"),
    "export function computeTotals(",
    "export function refundableAmount(totals: OrderTotals): Cents {\n  return Math.max(0, totals.total - (totals.refunded ?? 0));\n}\n\nexport function computeTotals(",
  ),
  "  return totals.total - totals.tax;\n",
  "  return totals.total - totals.tax - (totals.refunded ?? 0);\n",
);
const totalsAgentBefore = "export function netTotal(totals: OrderTotals): Cents {\n  return totals.total - totals.tax;\n}\n";
const totalsAgentAfter = "export function netTotal(totals: OrderTotals): Cents {\n  return totals.total - totals.tax - (totals.refunded ?? 0);\n}\n";

const totalsTest1 = t`
import { describe, expect, it } from "vitest";
import { computeTotals, shippingFor } from "./totals.js";

describe("computeTotals", () => {
  it("adds tax and flat shipping below the free shipping threshold", () => {
    const totals = computeTotals([{ sku: "BK-100", quantity: 1, unitPrice: 3000 }]);
    expect(totals.tax).toBe(630);
    expect(totals.shipping).toBe(595);
    expect(totals.total).toBe(4225);
  });

  it("ships for free from 50 EUR", () => {
    expect(shippingFor(5000)).toBe(0);
    expect(shippingFor(4999)).toBe(595);
  });

  it("applies line discounts before tax", () => {
    const totals = computeTotals([{ sku: "TY-020", quantity: 2, unitPrice: 2500, discountPercent: 10 }]);
    expect(totals.discount).toBe(500);
    expect(totals.tax).toBe(945);
  });
});
`;
const totalsTest2 = edit(
  totalsTest1,
  "    expect(totals.tax).toBe(945);\n  });\n",
  t`
    expect(totals.tax).toBe(945);
  });

  it("rounds half cents up", () => {
    const totals = computeTotals([{ sku: "BT-007", quantity: 1, unitPrice: 1050, discountPercent: 5 }]);
    expect(totals.discount).toBe(53);
  });
`,
);

const orderRepository1 = t`
import { withTransaction, type Pool } from "../db/client.js";
import type { NewOrder, OrderStatus } from "./order.schema.js";
import type { OrderTotals } from "./totals.js";

export function createOrderRepository(pool: Pool) {
  return {
    insert(order: NewOrder, totals: OrderTotals) {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          "INSERT INTO orders (customer_id, shipping_country, subtotal, discount, tax, shipping, total) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at",
          [order.customerId, order.shippingCountry, totals.subtotal, totals.discount, totals.tax, totals.shipping, totals.total],
        );
        for (const line of order.lines) {
          await client.query(
            "INSERT INTO order_lines (order_id, sku, quantity, unit_price, discount_percent) VALUES ($1, $2, $3, $4, $5)",
            [rows[0].id, line.sku, line.quantity, line.unitPrice, line.discountPercent ?? 0],
          );
        }
        return { id: rows[0].id as string, createdAt: rows[0].created_at as Date };
      });
    },
    async find(id: string) {
      const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
      return rows[0] ?? null;
    },
    async setStatus(id: string, status: OrderStatus) {
      await pool.query("UPDATE orders SET status = $2 WHERE id = $1", [id, status]);
    },
  };
}
`;
const orderRepository2 = edit(
  orderRepository1,
  "    async setStatus(",
  t`
    async list(limit: number, after?: { createdAt: Date; id: string }) {
      const { rows } = await pool.query(
        "SELECT * FROM orders WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1, $2)) ORDER BY created_at DESC, id DESC LIMIT $3",
        [after?.createdAt ?? null, after?.id ?? null, limit + 1],
      );
      return rows;
    },
    async setStatus(`,
);
const orderRepository3 = edit(
  orderRepository2,
  '      await pool.query("UPDATE orders SET status = $2 WHERE id = $1", [id, status]);\n',
  '      await withTransaction(pool, async (client) => {\n        await client.query("UPDATE orders SET status = $2 WHERE id = $1", [id, status]);\n        await client.query("INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)", [id, status]);\n      });\n',
);

const orderService1 = t`
import type { Pool } from "../db/client.js";
import { conflict, notFound } from "../lib/errors.js";
import { createOrderRepository } from "./order.repository.js";
import type { NewOrder, OrderStatus } from "./order.schema.js";
import { computeTotals } from "./totals.js";

const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

export function createOrderService(pool: Pool) {
  const orders = createOrderRepository(pool);
  return {
    async place(input: NewOrder) {
      const totals = computeTotals(input.lines);
      const { id } = await orders.insert(input, totals);
      return { id, ...totals };
    },
    async transition(id: string, next: OrderStatus) {
      const order = await orders.find(id);
      if (!order) throw notFound("Order");
      if (!NEXT_STATUS[order.status as OrderStatus].includes(next)) {
        throw conflict("Cannot move an order from " + order.status + " to " + next);
      }
      await orders.setStatus(id, next);
    },
  };
}
`;
const orderService2 = edit(orderService1, "      await orders.setStatus(id, next);\n", "      await orders.setStatus(id, next);\n      return next;\n");
const orderService3 = edit(
  edit(
    orderService2,
    '  paid: ["shipped", "cancelled"],\n  shipped: ["delivered"],\n  delivered: [],\n  cancelled: [],\n',
    '  paid: ["shipped", "cancelled", "partially_refunded", "refunded"],\n  shipped: ["delivered", "partially_refunded", "refunded"],\n  delivered: ["partially_refunded", "refunded"],\n  cancelled: [],\n  partially_refunded: ["partially_refunded", "refunded"],\n  refunded: [],\n',
  ),
  "const NEXT_STATUS",
  "// Refund states are reachable from every state in which money was taken (FB-248).\nconst NEXT_STATUS",
);
const orderServiceFinal = edit(
  orderService3,
  "    async transition(",
  "    async refundedTotal(id: string) {\n      const order = await orders.find(id);\n      if (!order) throw notFound(\"Order\");\n      return order.refunded_total as number;\n    },\n    async transition(",
);

const orderRoutes1 = t`
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { notFound } from "../lib/errors.js";
import { createOrderRepository } from "./order.repository.js";
import { newOrderSchema } from "./order.schema.js";
import { createOrderService } from "./order.service.js";

const params = z.object({ id: z.string().uuid() });

export const orderRoutes: FastifyPluginAsync<{ pool: Pool }> = async (app, { pool }) => {
  const orders = createOrderService(pool);
  const repository = createOrderRepository(pool);

  app.post("/", async (request, reply) => {
    const placed = await orders.place(newOrderSchema.parse(request.body));
    return reply.code(201).send(placed);
  });

  app.get("/:id", async (request) => {
    const { id } = params.parse(request.params);
    const order = await repository.find(id);
    if (!order) throw notFound("Order");
    return order;
  });
};
`;
const orderRoutes2 = edit(
  edit(orderRoutes1, 'import { notFound } from "../lib/errors.js";\n', 'import { notFound } from "../lib/errors.js";\nimport { decodeCursor, encodeCursor, pageQuery } from "../lib/pagination.js";\n'),
  '  app.get("/:id", async (request) => {',
  t`
  app.get("/", async (request) => {
    const { limit, after } = pageQuery.parse(request.query);
    const rows = await repository.list(limit, after ? decodeCursor(after) : undefined);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, next: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
  });

  app.get("/:id", async (request) => {`,
);
const orderRoutesFinal = edit(
  edit(
    orderRoutes2,
    'import { createOrderService } from "./order.service.js";\n',
    'import { createOrderService } from "./order.service.js";\nimport { refundableAmount, type OrderTotals } from "./totals.js";\n',
  ),
  "  });\n};\n",
  t`
  });

  app.get("/:id/refundable", async (request) => {
    const { id } = params.parse(request.params);
    const order = await repository.find(id);
    if (!order) throw notFound("Order");
    return { refundable: refundableAmount({ total: order.total, refunded: order.refunded_total } as OrderTotals) };
  });
};
`,
);

// ---------------------------------------------------------------------------------------------------- plugins, payments
const auth1 = t`
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import { HttpError } from "../lib/errors.js";

interface AuthOptions {
  secret: string;
}

const plugin: FastifyPluginAsync<AuthOptions> = async (app, { secret }) => {
  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/health")) return;
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) throw new HttpError(401, "Missing bearer token", "unauthorized");
    try {
      jwt.verify(header.slice(7), secret);
    } catch {
      throw new HttpError(401, "Invalid token", "unauthorized");
    }
  });
};

export const authPlugin = fp(plugin, { name: "auth" });
`;
const auth2 = edit(
  auth1,
  '    } catch {\n      throw new HttpError(401, "Invalid token", "unauthorized");\n',
  '    } catch (err) {\n      const expired = err instanceof Error && err.name === "TokenExpiredError";\n      throw new HttpError(401, expired ? "Token expired" : "Invalid token", "unauthorized");\n',
);
const paymentClient1 = t`
import type { Cents } from "../lib/money.js";

export interface Charge {
  orderId: string;
  amount: Cents;
  currency: string;
}

export function createPaymentClient(baseUrl: string, apiKey: string) {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Payment gateway answered " + response.status);
    return (await response.json()) as T;
  }

  return {
    charge: (charge: Charge) => post<{ id: string; status: string }>("/v1/charges", charge),
  };
}
`;
const paymentClient2 = edit(
  paymentClient1,
  '    charge: (charge: Charge) => post<{ id: string; status: string }>("/v1/charges", charge),\n',
  '    charge: (charge: Charge) => post<{ id: string; status: string }>("/v1/charges", charge),\n    refund: (chargeId: string, amount: Cents) => post<{ id: string; status: string }>("/v1/refunds", { chargeId, amount }),\n',
);
const paymentRoutes = t`
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Pool } from "../db/client.js";
import { createOrderService } from "../orders/order.service.js";

const webhook = z.object({
  type: z.enum(["charge.succeeded", "charge.failed"]),
  orderId: z.string().uuid(),
});

export const paymentRoutes: FastifyPluginAsync<{ pool: Pool }> = async (app, { pool }) => {
  const orders = createOrderService(pool);

  app.post("/webhook", async (request, reply) => {
    const event = webhook.parse(request.body);
    if (event.type === "charge.succeeded") await orders.transition(event.orderId, "paid");
    return reply.code(204).send();
  });
};
`;

// ---------------------------------------------------------------------------------------------------- refunds
const refundSchema = t`
import { z } from "zod";

export const refundReason = z.enum(["damaged", "wrong_item", "not_as_described", "changed_mind", "other"]);

export const refundRequestSchema = z.object({
  orderId: z.string().uuid(),
  amount: z.number().int().positive(),
  reason: refundReason,
  note: z.string().max(500).optional(),
});

export const refundStatus = z.enum(["requested", "approved", "rejected", "paid_out"]);

export type RefundRequest = z.infer<typeof refundRequestSchema>;
export type RefundStatus = z.infer<typeof refundStatus>;
`;
const refundPolicy = t`
import type { Cents } from "../lib/money.js";

export const REFUND_WINDOW_DAYS = 30;
export const AUTO_APPROVE_BELOW: Cents = 2500;

export interface RefundContext {
  deliveredAt: Date;
  total: Cents;
  alreadyRefunded: Cents;
  now: Date;
}

export function isWithinWindow(deliveredAt: Date, now: Date): boolean {
  const days = (now.getTime() - deliveredAt.getTime()) / 86_400_000;
  return days <= REFUND_WINDOW_DAYS;
}

export function refundableLeft(context: RefundContext): Cents {
  return Math.max(0, context.total - context.alreadyRefunded);
}

export function decide(amount: Cents, context: RefundContext): "approved" | "requested" | "rejected" {
  if (!isWithinWindow(context.deliveredAt, context.now)) return "rejected";
  if (amount > refundableLeft(context)) return "rejected";
  return amount < AUTO_APPROVE_BELOW ? "approved" : "requested";
}
`;
const refundPolicyTest1 = t`
import { describe, expect, it } from "vitest";
import { decide, isWithinWindow } from "./refund.policy.js";

const now = new Date("2026-09-20T12:00:00Z");
const delivered = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);

describe("refund policy", () => {
  it("accepts refunds inside the 30 day window", () => {
    expect(isWithinWindow(delivered(29), now)).toBe(true);
    expect(isWithinWindow(delivered(31), now)).toBe(false);
  });

  it("auto-approves small refunds", () => {
    const context = { deliveredAt: delivered(2), total: 9000, alreadyRefunded: 0, now };
    expect(decide(1500, context)).toBe("approved");
    expect(decide(4000, context)).toBe("requested");
  });
});
`;
const refundPolicyTest2 = edit(
  refundPolicyTest1,
  '    expect(decide(4000, context)).toBe("requested");\n  });\n',
  t`
    expect(decide(4000, context)).toBe("requested");
  });

  it("rejects more than is left to refund", () => {
    const context = { deliveredAt: delivered(2), total: 9000, alreadyRefunded: 8000, now };
    expect(decide(2000, context)).toBe("rejected");
  });
`,
);

const refundService = t`
import type { Pool } from "../db/client.js";
import { withTransaction } from "../db/client.js";
import { conflict, notFound } from "../lib/errors.js";
import type { createPaymentClient } from "../payments/payment.client.js";
import { decide } from "./refund.policy.js";
import type { RefundRequest } from "./refund.schema.js";

export function createRefundService(pool: Pool, payments: ReturnType<typeof createPaymentClient>) {
  return {
    async request(input: RefundRequest, now = new Date()) {
      const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [input.orderId]);
      const order = rows[0];
      if (!order) throw notFound("Order");
      if (order.status === "cancelled") throw conflict("Cancelled orders cannot be refunded");
      const outcome = decide(input.amount, {
        deliveredAt: order.delivered_at,
        total: order.total,
        alreadyRefunded: order.refunded_total,
        now,
      });
      return withTransaction(pool, async (client) => {
        const saved = await client.query(
          "INSERT INTO refunds (order_id, amount, reason, status) VALUES ($1, $2, $3, $4) RETURNING id",
          [input.orderId, input.amount, input.reason, outcome],
        );
        if (outcome === "approved") await payments.refund(order.charge_id, input.amount);
        return { id: saved.rows[0].id as string, status: outcome };
      });
    },
  };
}
`;
const refundRoutes = t`
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "../db/client.js";
import type { createPaymentClient } from "../payments/payment.client.js";
import { refundRequestSchema } from "./refund.schema.js";
import { createRefundService } from "./refund.service.js";

interface RefundRoutesOptions {
  pool: Pool;
  payments: ReturnType<typeof createPaymentClient>;
}

export const refundRoutes: FastifyPluginAsync<RefundRoutesOptions> = async (app, { pool, payments }) => {
  const refunds = createRefundService(pool, payments);

  app.post("/", async (request, reply) => {
    const body = refundRequestSchema.parse(request.body);
    const result = await refunds.request(body);
    return reply.code(result.status === "rejected" ? 422 : 201).send(result);
  });
};
`;
const refundServiceTest = t`
import { describe, expect, it, vi } from "vitest";
import { createRefundService } from "./refund.service.js";

describe("refund service", () => {
  it("does not call the gateway for a request that needs a person", async () => {
    const refund = vi.fn();
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: "o1", status: "delivered", total: 9000, refunded_total: 0, delivered_at: new Date("2026-09-20T12:00:00Z") }] }) };
    const service = createRefundService(pool as never, { refund } as never);
    await service.request({ orderId: "o1", amount: 4000, reason: "damaged" }, new Date("2026-09-22T12:00:00Z")).catch(() => undefined);
    expect(refund).not.toHaveBeenCalled();
  });
});
`;
const refundNotes = t`
# Refund edge cases (work in progress)

- Partial refunds: the order moves to partially_refunded until the full amount is paid out.
- A refund requested on day 30 counts as inside the window.
- Gateway errors must leave the refund row in "requested" so support can retry.
- Open question: do gift cards refund to the card or to a new gift card?
`;

// ---------------------------------------------------------------------------------------------------- tests
const buildTestApp = t`
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

export async function buildTestApp() {
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: "postgres://fernbank@db.fernbank.example:5432/fernbank_test",
    LOG_LEVEL: "error",
    JWT_SECRET: "change-me",
    PAYMENT_GATEWAY_URL: "https://pay.fernbank.example",
    PAYMENT_API_KEY: "change-me",
  });
  return buildApp({ config });
}
`;
const ordersRoutesTest = t`
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/build-test-app.js";

describe("orders routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects requests without a bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/orders" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const response = await app.inject({ method: "GET", url: "/orders", headers: { authorization: "Bearer test-token" } });
    expect(response.statusCode).toBe(401);
  });
});
`;
const ordersRoutesTestMoved = edit(ordersRoutesTest, 'from "./helpers/build-test-app.js"', 'from "../helpers/build-test-app.js"');

// ---------------------------------------------------------------------------------------------------- HEAD tree
const files = {
  ".gitignore": gitignore,
  "README.md": readme3,
  "package.json": pkg4,
  "tsconfig.json": tsconfig,
  ".env.example": envExample2,
  "src/app.ts": app5,
  "src/server.ts": server2,
  "src/config.ts": config2,
  "src/health/health.routes.ts": health,
  "src/db/client.ts": dbClient,
  "src/db/migrations/0001_init.sql": mig1,
  "src/db/migrations/0002_orders.sql": mig2,
  "src/db/migrations/0003_order_status_history.sql": mig3b,
  "src/db/migrations/0004_refunds.sql": mig4,
  "scripts/migrate.ts": migrateScript,
  "scripts/backfill-status-history.ts": backfill,
  "src/lib/errors.ts": errors,
  "src/lib/money.ts": money3,
  "src/lib/pagination.ts": pagination,
  "src/catalog/product.schema.ts": productSchema2,
  "src/catalog/pricing.ts": pricing2,
  "src/catalog/product.routes.ts": productRoutes2,
  "src/customers/customer.schema.ts": customerSchema2,
  "src/customers/customer.service.ts": customerService2,
  "src/customers/customer.routes.ts": customerRoutes2,
  "src/orders/order.schema.ts": orderSchema3,
  "src/orders/order.repository.ts": orderRepository3,
  "src/orders/order.service.ts": orderService3,
  "src/orders/order.routes.ts": orderRoutes2,
  "src/orders/totals.ts": totals2,
  "src/orders/totals.test.ts": totalsTest2,
  "src/plugins/auth.ts": auth2,
  "src/payments/payment.client.ts": paymentClient2,
  "src/payments/payment.routes.ts": paymentRoutes,
  "src/refunds/refund.schema.ts": refundSchema,
  "src/refunds/refund.policy.ts": refundPolicy,
  "src/refunds/refund.policy.test.ts": refundPolicyTest2,
  "test/helpers/build-test-app.ts": buildTestApp,
  "test/orders.routes.test.ts": ordersRoutesTest,
};

// ---------------------------------------------------------------------------------------------------- history
const step = (at, author, message, changes, extra = {}) => ({ at, author, message, changes, ...extra });
const merge = (at, author, branch, from, message) => ({ at, author, message, branch, merge: { from, message } });

const history = [
  step("2026-08-24T09:00:00Z", "mira", "chore: initial commit", { ".gitignore": gitignore, "README.md": readme1, "package.json": pkg0, "tsconfig.json": tsconfig }, { branch: "main" }),
  step("2026-08-24T14:30:00Z", "mira", "chore: add vitest, eslint and prettier", { "package.json": pkg1 }),
  step("2026-08-25T10:00:00Z", "mira", "feat: fastify app skeleton with a health route", { "src/app.ts": app1, "src/server.ts": server1, "src/health/health.routes.ts": health }),
  step("2026-08-25T16:20:00Z", "daniel", "feat(config): validate the environment with zod", { "src/config.ts": config1, ".env.example": envExample1, "src/app.ts": app2, "src/server.ts": server2 }),
  step("2026-08-26T11:10:00Z", "daniel", "feat(db): pg pool, transactions and a migration runner", { "src/db/client.ts": dbClient, "scripts/migrate.ts": migrateScript, "src/db/migrations/0001_init.sql": mig1 }),
  step("2026-08-26T15:45:00Z", "priya", "feat(lib): money helpers and http error types", { "src/lib/money.ts": money1, "src/lib/errors.ts": errors }),
  step("2026-08-27T10:05:00Z", "priya", "feat(catalog): product schema, pricing and routes", { "src/catalog/product.schema.ts": productSchema1, "src/catalog/pricing.ts": pricing1, "src/catalog/product.routes.ts": productRoutes1 }),
  step("2026-08-28T09:40:00Z", "mira", "feat(customers): customer schema, service and routes", { "src/customers/customer.schema.ts": customerSchema1, "src/customers/customer.service.ts": customerService1, "src/customers/customer.routes.ts": customerRoutes1 }),
  step("2026-08-29T10:25:00Z", "tomas", "feat(orders): order schema and totals", { "src/orders/order.schema.ts": orderSchema1, "src/orders/totals.ts": totals1 }),
  step("2026-08-30T13:00:00Z", "tomas", "feat(orders): repository and service", { "src/orders/order.repository.ts": orderRepository1, "src/orders/order.service.ts": orderService1, "src/db/migrations/0002_orders.sql": mig2 }),
  step("2026-08-31T09:30:00Z", "daniel", "feat(orders): order routes and module wiring", { "src/orders/order.routes.ts": orderRoutes1, "src/app.ts": app3 }),
  step("2026-09-01T11:15:00Z", "priya", "test(orders): totals unit tests", { "src/orders/totals.test.ts": totalsTest1 }),
  step("2026-09-01T16:00:00Z", "mira", "feat(auth): bearer token verification", { "src/plugins/auth.ts": auth1, "src/app.ts": app4 }),
  step("2026-09-02T10:10:00Z", "daniel", "feat(lib): cursor pagination for order lists", { "src/lib/pagination.ts": pagination, "src/orders/order.repository.ts": orderRepository2, "src/orders/order.routes.ts": orderRoutes2 }),
  step("2026-09-03T09:50:00Z", "mira", "feat(payments): gateway client and webhook", { "src/payments/payment.client.ts": paymentClient1, "src/payments/payment.routes.ts": paymentRoutes, "src/config.ts": config2, ".env.example": envExample2, "src/app.ts": app5 }),
  step("2026-09-04T14:20:00Z", "priya", "test: route tests with a test app helper", { "test/helpers/build-test-app.ts": buildTestApp, "test/orders.routes.test.ts": ordersRoutesTest }),
  step("2026-09-05T10:00:00Z", "tomas", "docs: describe local setup and the order lifecycle", { "README.md": readme2 }),
  step("2026-09-08T09:00:00Z", "release-bot", "chore(release): v1.8.0", { "package.json": pkg2 }, { tag: { name: "v1.8.0", message: "Release v1.8.0" } }),
  step("2026-09-09T10:00:00Z", "priya", "refactor(totals): share half-up rounding with the money helpers", { "src/orders/totals.ts": totals2, "src/lib/money.ts": money2 }, { branch: "fix/rounding-totals" }),
  step("2026-09-09T14:30:00Z", "daniel", "feat(customers): look up a customer by e-mail", { "src/customers/customer.schema.ts": customerSchema2, "src/customers/customer.service.ts": customerService2, "src/customers/customer.routes.ts": customerRoutes2 }, { branch: "main" }),
  step("2026-09-10T11:20:00Z", "priya", "test(totals): cover half-cent rounding", { "src/orders/totals.test.ts": totalsTest2 }, { branch: "fix/rounding-totals" }),
  merge("2026-09-11T09:00:00Z", "tomas", "main", "fix/rounding-totals", "Merge branch 'fix/rounding-totals'"),
  step("2026-09-12T10:40:00Z", "mira", "feat(catalog): sale prices", { "src/catalog/product.schema.ts": productSchema2, "src/catalog/pricing.ts": pricing2 }),
  step("2026-09-15T09:10:00Z", "daniel", "chore(deps): bump fastify, zod and vitest", { "package.json": pkg3 }),
  step("2026-09-15T15:30:00Z", "priya", "fix(money): round negative amounts away from zero", { "src/lib/money.ts": money3 }, { branch: "fix/rounding-totals" }),
  merge("2026-09-16T09:20:00Z", "tomas", "main", "fix/rounding-totals", "Merge branch 'fix/rounding-totals'"),
  step("2026-09-17T10:15:00Z", "mira", "feat(orders): keep an order status history", { "src/orders/order.schema.ts": orderSchema2, "src/orders/order.repository.ts": orderRepository3, "src/orders/order.service.ts": orderService2, "src/db/migrations/0003_order_status_history.sql": mig3a, "scripts/backfill-status-history.ts": backfill }),
  step("2026-09-18T11:00:00Z", "daniel", "perf(orders): index orders by customer and created date", { "src/db/migrations/0003_order_status_history.sql": mig3b }),
  step("2026-09-19T09:45:00Z", "priya", "fix(auth): answer expired tokens with a clear 401", { "src/plugins/auth.ts": auth2 }),
  step("2026-09-22T09:00:00Z", "release-bot", "chore(release): v1.9.0", { "package.json": pkg4 }, { tag: { name: "v1.9.0", message: "Release v1.9.0" } }),
  step("2026-09-22T11:30:00Z", "mira", "feat(refunds): refund request schema (FB-214)", { "src/refunds/refund.schema.ts": refundSchema }, { branch: "feature/order-refunds" }),
  step("2026-09-23T10:00:00Z", "mira", "feat(refunds): refund policy and eligibility window (FB-214)", { "src/refunds/refund.policy.ts": refundPolicy, "src/refunds/refund.policy.test.ts": refundPolicyTest1 }),
  step("2026-09-23T14:15:00Z", "tomas", "fix(catalog): trim product names on write", { "src/catalog/product.routes.ts": productRoutes2 }, { branch: "main" }),
  step("2026-09-24T09:30:00Z", "priya", "feat(payments): refund call on the gateway client (FB-214)", { "src/payments/payment.client.ts": paymentClient2 }, { branch: "feature/order-refunds" }),
  merge("2026-09-24T15:00:00Z", "mira", "feature/order-refunds", "main", "Merge branch 'main' into feature/order-refunds"),
  step("2026-09-25T10:20:00Z", "daniel", "feat(orders): refunded and partially refunded statuses (FB-248)", { "src/orders/order.schema.ts": orderSchema3, "src/orders/order.service.ts": orderService3, "src/db/migrations/0004_refunds.sql": mig4 }),
  step("2026-09-25T15:10:00Z", "priya", "test(refunds): reject refunds above the remaining amount (FB-248)", { "src/refunds/refund.policy.test.ts": refundPolicyTest2 }),
  step("2026-09-26T11:00:00Z", "mira", "docs: document the refund flow (FB-214)", { "README.md": readme3 }),
];

// ---------------------------------------------------------------------------------------------------- work tree
const worktree = {
  modify: {
    "src/orders/totals.ts": totalsStaged,
    ".env.example": envExample3,
    "src/orders/order.routes.ts": orderRoutesFinal,
    "src/orders/order.service.ts": orderServiceFinal,
    "src/app.ts": app6,
    "package.json": edit(pkg4, '"test": "vitest run",', '"test": "vitest run",\n    "test:refunds": "vitest run src/refunds",'),
  },
  stage: ["src/orders/totals.ts"],
  thenModify: { "src/orders/totals.ts": totalsFinal },
  stageAdd: {
    "src/refunds/refund.service.ts": refundService,
    "src/refunds/refund.routes.ts": refundRoutes,
  },
  delete: ["scripts/backfill-status-history.ts"],
  stageRename: [{ from: "test/orders.routes.test.ts", to: "test/orders/routes.test.ts", text: ordersRoutesTestMoved }],
  untracked: {
    ".env": t`
# local settings, never committed
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://fernbank@db.fernbank.example:5432/fernbank
JWT_SECRET=change-me
PAYMENT_GATEWAY_URL=https://pay.fernbank.example
PAYMENT_API_KEY=change-me
`,
    "notes/refund-edge-cases.md": refundNotes,
    "src/refunds/refund.service.test.ts": refundServiceTest,
    "dump_2026-09-30/orders.json": '[{"id":"ord_1001","status":"paid","total":4290},{"id":"ord_1002","status":"shipped","total":15990}]\n',
    "dump_2026-09-30/customers.json": '[{"id":"cus_01","name":"Sample Customer","email":"sample.customer@example.com"}]\n',
  },
  hunkTargets: [{ path: "src/orders/totals.ts", hunks: 3 }],
};

export default {
  id: "fb-api",
  name: "fb-api",
  branch: "feature/order-refunds",
  files,
  history,
  worktree,
  agentEdit: { path: "src/orders/totals.ts", before: totalsAgentBefore, after: totalsAgentAfter },
  upstream: { ahead: 3, behind: 0 },
  remoteOnlyBranches: [{ name: "release/1.9", from: "v1.9.0" }],
};

/** Ticket ids of the refund story that fb-web and fb-mobile history refer to as well (checked by the whole-demo test). */
export const TICKETS = ["FB-214", "FB-231", "FB-248"];
