// Demo repository fb-web: the storefront of the fictional Fernbank Cycles (React, TSX, Vite).
// Everything here is invented. File contents are template strings so that TypeScript, lint and CodeQL tooling do not
// treat them as project source. Schema and rules: scripts/demo-workspace/README.md.
//
// Story shared with fb-api and fb-mobile: refunds (tickets FB-214, FB-231). The checked-out branch
// feature/checkout-redesign is two commits ahead of origin and merged main twice; the work tree holds a coupon field
// in progress, refund wiring and a renamed hook.

/** Template literal helper: drops the first newline so every file reads naturally in this source. */
const t = (s) => s[0].replace(/^\n/, "");

/** Replaces `from` by `to` exactly once and fails loudly when the anchor is missing (keeps versions in sync). */
const edit = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error("fb-web: edit anchor must occur exactly once: " + from.slice(0, 48));
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
const readme = t`
# fb-web

Storefront for Fernbank Cycles: browse bikes and parts, fill a cart, check out and follow your orders.

## Getting started

    pnpm install
    pnpm dev

The dev server proxies /api to the Fernbank API. Run the tests with pnpm test.
`;
const pkg = ({ version, deps, dev }) =>
  json({
    name: "@fernbank/web",
    version,
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview", test: "vitest run" },
    dependencies: deps,
    devDependencies: dev,
  });
const dev0 = { "@testing-library/react": "^16.0.0", "@types/react": "^18.3.3", "@types/react-dom": "^18.3.0", "@vitejs/plugin-react": "^4.3.1", jsdom: "^24.1.0", typescript: "^5.5.0", vite: "^5.3.1", vitest: "^1.6.0" };
const pkg0 = pkg({ version: "2.3.0", deps: { react: "^18.3.1", "react-dom": "^18.3.1", "react-router-dom": "^6.24.0" }, dev: dev0 });
const pkg1 = pkg({ version: "2.3.0", deps: { react: "^18.3.1", "react-dom": "^18.3.1", "react-router-dom": "^6.26.0" }, dev: { ...dev0, vite: "^5.4.2", vitest: "^2.0.5" } });
const pkg2 = edit(pkg1, '"version": "2.3.0"', '"version": "2.4.0"');
const tsconfig = json({
  compilerOptions: {
    target: "ES2020",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "ESNext",
    moduleResolution: "Bundler",
    jsx: "react-jsx",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src"],
});
const viteConfig = t`
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "https://api.fernbank.example", changeOrigin: true } },
  },
  test: { environment: "jsdom", globals: true },
});
`;
const indexHtml = t`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fernbank Cycles</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

// ---------------------------------------------------------------------------------------------------- shell
const main = t`
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles/theme.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
`;
const app1 = t`
import { AppRoutes } from "./routes";

export function App() {
  return (
    <div className="app">
      <main className="app-main">
        <AppRoutes />
      </main>
    </div>
  );
}
`;
const app2 = t`
import { useState } from "react";
import { CartDrawer } from "./components/CartDrawer";
import { Header } from "./components/Header";
import { AppRoutes } from "./routes";

export function App() {
  const [cartOpen, setCartOpen] = useState(false);
  return (
    <div className="app">
      <Header onOpenCart={() => setCartOpen(true)} />
      <main className="app-main">
        <AppRoutes />
      </main>
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </div>
  );
}
`;
const routes1 = t`
import { Route, Routes } from "react-router-dom";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<h1>Fernbank Cycles</h1>} />
    </Routes>
  );
}
`;
const routesOf = (entries) =>
  'import { Route, Routes } from "react-router-dom";\n' +
  entries.map(([, name, file]) => 'import { ' + name + ' } from "' + file + '";\n').join("") +
  "\nexport function AppRoutes() {\n  return (\n    <Routes>\n" +
  entries.map(([path, name]) => '      <Route path="' + path + '" element={<' + name + " />} />\n").join("") +
  "    </Routes>\n  );\n}\n";
const R_HOME = ["/", "HomePage", "./pages/HomePage"];
const R_ORDERS = ["/orders", "OrdersPage", "./pages/OrdersPage"];
const R_DETAIL = ["/orders/:id", "OrderDetailPage", "./pages/OrderDetailPage"];
const R_CHECKOUT = ["/checkout", "CheckoutPage", "./components/checkout/CheckoutPage"];
const routes2 = routesOf([R_HOME]);
const routes3 = routesOf([R_HOME, R_ORDERS]);
const routes4 = routesOf([R_HOME, R_ORDERS, R_DETAIL]);
const routes5 = routesOf([R_HOME, R_ORDERS, R_DETAIL, R_CHECKOUT]);

const css1 = t`
:root {
  --fb-green: #2f7d5b;
  --fb-ink: #1d2a24;
  --fb-paper: #f7f5ef;
  --fb-line: #d9d4c7;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  color: var(--fb-ink);
  background: var(--fb-paper);
}

.app-main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
.site-header { display: flex; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--fb-line); }
.btn { border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.btn-primary { background: var(--fb-green); color: white; }
.btn-secondary { background: transparent; border: 1px solid var(--fb-line); }
.product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
.product-card { background: white; border: 1px solid var(--fb-line); border-radius: 8px; padding: 16px; }
.badge { padding: 2px 8px; border-radius: 999px; background: var(--fb-line); font-size: 12px; }
`;
const css2 = css1 + ".cart-badge { display: inline-block; min-width: 20px; overflow: hidden; text-align: center; }\n";
const css3 = css2 + t`
:focus-visible { outline: 2px solid var(--fb-green); outline-offset: 2px; }
.checkout-steps > * + * { margin-top: 24px; }
.address-form { display: grid; gap: 12px; }
.field-error { color: #a33a2b; font-size: 13px; }
`;
const cssFinal = css3 + t`
.coupon-field { display: flex; gap: 8px; align-items: center; }
.coupon-field input { flex: 1; text-transform: uppercase; }
`;

// ---------------------------------------------------------------------------------------------------- api, lib, state
const apiClient = t`
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}
`;
const apiCatalog = t`
import { api } from "./client";

export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  category: string;
  stock: number;
}

export const listProducts = () => api<{ items: Product[] }>("/products").then((response) => response.items);
export const getProduct = (sku: string) => api<Product>("/products/" + sku);
`;
const apiOrders1 = t`
import { api } from "./client";

export interface Order {
  id: string;
  status: string;
  total: number;
  createdAt: string;
}

export const listOrders = () => api<{ items: Order[] }>("/orders").then((response) => response.items);
export const getOrder = (id: string) => api<Order>("/orders/" + id);
`;
const apiOrders2 = edit(apiOrders1, "  total: number;\n", "  total: number;\n  refundedTotal: number;\n");
const apiOrdersFinal = apiOrders2 + 'export const listRefunds = (id: string) => api<{ items: { id: string; status: string }[] }>("/orders/" + id + "/refunds");\n';
const apiRefunds = t`
import { api } from "./client";

export interface RefundResult {
  id: string;
  status: "requested" | "approved" | "rejected";
}

export const requestRefund = (orderId: string, amount: number, reason: string) =>
  api<RefundResult>("/refunds", {
    method: "POST",
    body: JSON.stringify({ orderId, amount, reason }),
  });
`;
const format = t`
const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

export function formatMoney(cents: number): string {
  return money.format(cents / 100);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatOrderNumber(id: string): string {
  return "FBO-" + id.slice(0, 8).toUpperCase();
}
`;
const formatTest = t`
import { describe, expect, it } from "vitest";
import { formatMoney, formatOrderNumber } from "./format";

describe("format", () => {
  it("formats cents as euros", () => {
    expect(formatMoney(4995)).toContain("49.95");
  });

  it("builds a short order number", () => {
    expect(formatOrderNumber("a1b2c3d4-0000-4000-8000-000000000000")).toBe("FBO-A1B2C3D4");
  });
});
`;
const cart1 = t`
export interface CartItem {
  sku: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export type CartAction =
  | { type: "add"; item: Omit<CartItem, "quantity"> }
  | { type: "remove"; sku: string }
  | { type: "clear" };

export function cartReducer(items: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case "add":
      return [...items, { ...action.item, quantity: 1 }];
    case "remove":
      return items.filter((item) => item.sku !== action.sku);
    case "clear":
      return [];
  }
}

export const cartTotal = (items: CartItem[]) => items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
`;
const cart2 = edit(
  cart1,
  '    case "add":\n      return [...items, { ...action.item, quantity: 1 }];\n',
  t`
    case "add": {
      const existing = items.find((item) => item.sku === action.item.sku);
      if (!existing) return [...items, { ...action.item, quantity: 1 }];
      return items.map((item) => (item.sku === existing.sku ? { ...item, quantity: item.quantity + 1 } : item));
    }
`,
);
const useCart = t`
import { useSyncExternalStore } from "react";
import { cartReducer, cartTotal, type CartAction, type CartItem } from "../state/cart";

let items: CartItem[] = [];
const listeners = new Set<() => void>();

function dispatch(action: CartAction) {
  items = cartReducer(items, action);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useCart() {
  const snapshot = useSyncExternalStore(subscribe, () => items);
  return { items: snapshot, total: cartTotal(snapshot), dispatch };
}
`;
const useOrders1 = t`
import { useEffect, useState } from "react";
import { listOrders, type Order } from "../api/orders";

export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void listOrders()
      .then(setOrders)
      .finally(() => setLoading(false));
  }, []);

  return { orders, loading };
}
`;
const useOrders2 = edit(useOrders1, "      .then(setOrders)\n", "      .then((items) => setOrders([...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))))\n");
const useDebounce = t`
import { useEffect, useState } from "react";

export function useDebounce<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
`;
const useDebouncedValue = edit(useDebounce, "useDebounce<T>", "useDebouncedValue<T>");
const useCheckout1 = t`
import { useState } from "react";
import type { Address } from "../components/checkout/AddressForm";
import { useCart } from "./useCart";

export type Step = "address" | "shipping" | "payment";

export function useCheckout() {
  const { items, total, dispatch } = useCart();
  const [step, setStep] = useState<Step>("address");
  const [address, setAddress] = useState<Address | null>(null);

  return {
    items,
    total,
    step,
    address,
    submitAddress: (value: Address) => {
      setAddress(value);
      setStep("shipping");
    },
    chooseShipping: () => setStep("payment"),
    finish: () => dispatch({ type: "clear" }),
  };
}
`;
const useCheckout2 = edit(
  edit(
    edit(
      edit(useCheckout1, 'export type Step = "address" | "shipping" | "payment";', 'export type Step = "address" | "shipping" | "payment" | "confirmation";'),
      "  const [address, setAddress] = useState<Address | null>(null);\n",
      '  const [address, setAddress] = useState<Address | null>(null);\n  const [paid, setPaid] = useState({ orderNumber: "", total: 0 });\n',
    ),
    "    address,\n",
    "    address,\n    paid,\n",
  ),
  "    finish: () => dispatch({ type: \"clear\" }),\n",
  '    finish: () => {\n      setPaid({ orderNumber: "FBO-" + String(Date.now()).slice(-8), total });\n      dispatch({ type: "clear" });\n      setStep("confirmation");\n    },\n',
);
const useCheckoutFinal = edit(
  edit(useCheckout2, '  const [paid, setPaid]', '  const [coupon, setCoupon] = useState("");\n  const [paid, setPaid]'),
  "    paid,\n",
  "    paid,\n    coupon,\n    applyCoupon: setCoupon,\n",
);

// ---------------------------------------------------------------------------------------------------- components
const button1 = t`
import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
}

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return <button className={"btn btn-" + variant + " " + className} {...props} />;
}
`;
const button2 = t`
import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
}

export function Button({ variant = "primary", loading = false, className = "", children, ...props }: ButtonProps) {
  return (
    <button className={"btn btn-" + variant + " " + className} aria-busy={loading} {...props} disabled={loading || props.disabled}>
      {loading ? "Working..." : children}
    </button>
  );
}
`;
const header1 = t`
import { Link } from "react-router-dom";
import { useCart } from "../hooks/useCart";

export function Header({ onOpenCart }: { onOpenCart: () => void }) {
  const { items } = useCart();
  const count = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <header className="site-header">
      <Link to="/" className="logo">
        Fernbank Cycles
      </Link>
      <nav>
        <Link to="/orders">Orders</Link>
        <button className="cart-button" onClick={onOpenCart}>
          Cart <span className="cart-badge">{count}</span>
        </button>
      </nav>
    </header>
  );
}
`;
const header2 = edit(header1, '<span className="cart-badge">{count}</span>', '<span className="cart-badge">{count > 99 ? "99+" : count}</span>');
const productCard = t`
import type { Product } from "../api/catalog";
import { formatMoney } from "../lib/format";
import { Button } from "./Button";

interface ProductCardProps {
  product: Product;
  onAdd: (product: Product) => void;
}

export function ProductCard({ product, onAdd }: ProductCardProps) {
  const soldOut = product.stock === 0;
  return (
    <article className="product-card">
      <h3>{product.name}</h3>
      <p className="product-price">{formatMoney(product.priceCents)}</p>
      <Button disabled={soldOut} onClick={() => onAdd(product)}>
        {soldOut ? "Sold out" : "Add to cart"}
      </Button>
    </article>
  );
}
`;
const productCardTest = t`
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductCard } from "./ProductCard";

const product = { sku: "BK-100", name: "City bike", priceCents: 59900, category: "bikes", stock: 3 };

describe("ProductCard", () => {
  it("shows the price", () => {
    render(<ProductCard product={product} onAdd={vi.fn()} />);
    expect(screen.getByText(/599/)).toBeTruthy();
  });

  it("disables the button when sold out", () => {
    render(<ProductCard product={{ ...product, stock: 0 }} onAdd={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Sold out" }).hasAttribute("disabled")).toBe(true);
  });
});
`;
const productGrid1 = t`
import type { Product } from "../api/catalog";
import { ProductCard } from "./ProductCard";

export function ProductGrid({ products, onAdd }: { products: Product[]; onAdd: (product: Product) => void }) {
  return (
    <section className="product-grid">
      {products.map((product) => (
        <ProductCard key={product.sku} product={product} onAdd={onAdd} />
      ))}
    </section>
  );
}
`;
const productGrid2 = edit(
  edit(productGrid1, "  return (\n    <section", "  const inStock = products.filter((product) => product.stock > 0);\n  return (\n    <section"),
  "{products.map(",
  "{inStock.map(",
);
const cartDrawer = t`
import { Link } from "react-router-dom";
import { useCart } from "../hooks/useCart";
import { formatMoney } from "../lib/format";
import { Button } from "./Button";

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { items, total, dispatch } = useCart();
  if (!open) return null;

  return (
    <aside className="cart-drawer" role="dialog" aria-label="Cart">
      <button className="drawer-close" onClick={onClose} aria-label="Close cart">x</button>
      {items.length === 0 && <p>Your cart is empty.</p>}
      {items.map((item) => (
        <div key={item.sku} className="cart-line">
          <span>{item.quantity} x {item.name}</span>
          <Button variant="secondary" onClick={() => dispatch({ type: "remove", sku: item.sku })}>Remove</Button>
        </div>
      ))}
      <p>Total {formatMoney(total)}</p>
      <Link to="/checkout" onClick={onClose}>Go to checkout</Link>
    </aside>
  );
}
`;
const orderList = t`
import { Link } from "react-router-dom";
import type { Order } from "../api/orders";
import { formatDate, formatMoney, formatOrderNumber } from "../lib/format";
import { OrderStatusBadge } from "./OrderStatusBadge";

export function OrderList({ orders }: { orders: Order[] }) {
  if (orders.length === 0) return <p>You have not placed an order yet.</p>;
  return (
    <ul className="order-list">
      {orders.map((order) => (
        <li key={order.id}>
          <Link to={"/orders/" + order.id}>{formatOrderNumber(order.id)}</Link>
          <span>{formatDate(order.createdAt)}</span>
          <OrderStatusBadge status={order.status} />
          <strong>{formatMoney(order.total)}</strong>
        </li>
      ))}
    </ul>
  );
}
`;
const badge1 = t`
const LABELS: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  shipped: "On its way",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function OrderStatusBadge({ status }: { status: string }) {
  return <span className={"badge badge-" + status}>{LABELS[status] ?? status}</span>;
}
`;
const badge2 = edit(badge1, '  cancelled: "Cancelled",\n', '  cancelled: "Cancelled",\n  refunded: "Refunded",\n');
const badgeFinal = edit(badge2, '  refunded: "Refunded",\n', '  refunded: "Refunded",\n  partially_refunded: "Partly refunded",\n');
const refundDialog = t`
import { useState } from "react";
import type { Order } from "../api/orders";
import { formatMoney } from "../lib/format";
import { Button } from "./Button";

const REASONS = ["Damaged", "Wrong item", "Not as described", "Changed my mind"];

export function RefundDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const [reason, setReason] = useState(REASONS[0]);

  return (
    <dialog open className="refund-dialog">
      <h2>Request a refund</h2>
      <p>You can get back up to {formatMoney(order.total - order.refundedTotal)}.</p>
      <select value={reason} onChange={(event) => setReason(event.target.value)}>
        {REASONS.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
    </dialog>
  );
}
`;
const refundDialogFinal = edit(
  edit(
    edit(refundDialog, 'import type { Order } from "../api/orders";\n', 'import { requestRefund } from "../api/refunds";\nimport type { Order } from "../api/orders";\n'),
    "  const [reason, setReason] = useState(REASONS[0]);\n",
    "  const [reason, setReason] = useState(REASONS[0]);\n  const submit = async () => {\n    await requestRefund(order.id, order.total - order.refundedTotal, reason);\n    onClose();\n  };\n",
  ),
  '      <Button variant="secondary" onClick={onClose}>',
  '      <Button onClick={submit}>Send request</Button>\n      <Button variant="secondary" onClick={onClose}>',
);

// checkout
const checkoutPage1 = t`
import { useState } from "react";
import { useCart } from "../../hooks/useCart";
import { AddressForm, type Address } from "./AddressForm";
import { OrderSummary } from "./OrderSummary";
import { PaymentStep } from "./PaymentStep";

export function CheckoutPage() {
  const { items, total, dispatch } = useCart();
  const [address, setAddress] = useState<Address | null>(null);

  return (
    <div className="checkout">
      <h1>Checkout</h1>
      <AddressForm onSubmit={setAddress} />
      <OrderSummary items={items} total={total} />
      <PaymentStep disabled={!address || items.length === 0} onPaid={() => dispatch({ type: "clear" })} />
    </div>
  );
}
`;
const checkoutPage2 = t`
import { useState } from "react";
import { useCart } from "../../hooks/useCart";
import { AddressForm, type Address } from "./AddressForm";
import { OrderSummary } from "./OrderSummary";
import { PaymentStep } from "./PaymentStep";
import { ShippingOptions } from "./ShippingOptions";

type Step = "address" | "shipping" | "payment";

export function CheckoutPage() {
  const { items, total, dispatch } = useCart();
  const [step, setStep] = useState<Step>("address");
  const [address, setAddress] = useState<Address | null>(null);
  const toShipping = (value: Address) => {
    setAddress(value);
    setStep("shipping");
  };

  return (
    <div className="checkout checkout-steps">
      <h1>Checkout</h1>
      {step === "address" && <AddressForm onSubmit={toShipping} />}
      {step === "shipping" && <ShippingOptions country={address?.country ?? "NL"} onChoose={() => setStep("payment")} />}
      {step === "payment" && <PaymentStep disabled={items.length === 0} onPaid={() => dispatch({ type: "clear" })} />}
      <OrderSummary items={items} total={total} />
    </div>
  );
}
`;
const checkoutPage3 = t`
import { useCheckout } from "../../hooks/useCheckout";
import { AddressForm } from "./AddressForm";
import { OrderSummary } from "./OrderSummary";
import { PaymentStep } from "./PaymentStep";
import { ShippingOptions } from "./ShippingOptions";

export function CheckoutPage() {
  const checkout = useCheckout();

  return (
    <div className="checkout checkout-steps">
      <h1>Checkout</h1>
      {checkout.step === "address" && <AddressForm onSubmit={checkout.submitAddress} />}
      {checkout.step === "shipping" && <ShippingOptions country={checkout.address?.country ?? "NL"} onChoose={checkout.chooseShipping} />}
      {checkout.step === "payment" && <PaymentStep disabled={checkout.items.length === 0} onPaid={checkout.finish} />}
      <OrderSummary items={checkout.items} total={checkout.total} />
    </div>
  );
}
`;
const checkoutPage4 = edit(
  edit(checkoutPage3, 'import { OrderSummary } from "./OrderSummary";\n', 'import { ConfirmationStep } from "./ConfirmationStep";\nimport { OrderSummary } from "./OrderSummary";\n'),
  "      <OrderSummary items",
  '      {checkout.step === "confirmation" && <ConfirmationStep orderNumber={checkout.paid.orderNumber} total={checkout.paid.total} />}\n      <OrderSummary items',
);
const checkoutPageFinal = edit(
  edit(checkoutPage4, 'import { ConfirmationStep } from "./ConfirmationStep";\n', 'import { ConfirmationStep } from "./ConfirmationStep";\nimport { CouponField } from "./CouponField";\n'),
  "      <OrderSummary items",
  "      <CouponField value={checkout.coupon} onApply={checkout.applyCoupon} />\n      <OrderSummary items",
);
const addressForm1 = t`
import { useState } from "react";
import { Button } from "../Button";

export interface Address {
  name: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

const empty: Address = { name: "", street: "", city: "", postalCode: "", country: "NL" };

export function AddressForm({ onSubmit }: { onSubmit: (address: Address) => void }) {
  const [address, setAddress] = useState(empty);
  const set = (key: keyof Address) => (event: { target: { value: string } }) => setAddress({ ...address, [key]: event.target.value });

  return (
    <form className="address-form" onSubmit={(event) => { event.preventDefault(); onSubmit(address); }}>
      <input placeholder="Full name" value={address.name} onChange={set("name")} />
      <input placeholder="Street and number" value={address.street} onChange={set("street")} />
      <input placeholder="Postal code" value={address.postalCode} onChange={set("postalCode")} />
      <input placeholder="City" value={address.city} onChange={set("city")} />
      <Button type="submit">Continue</Button>
    </form>
  );
}
`;
const addressForm2 = t`
import { useState } from "react";
import { Button } from "../Button";

export type Address = Record<"name" | "street" | "city" | "postalCode" | "country", string>;

type Errors = Partial<Record<keyof Address, string>>;
const empty: Address = { name: "", street: "", city: "", postalCode: "", country: "NL" };
const FIELDS = ["name", "street", "postalCode", "city"] as const;

function validate(a: Address): Errors {
  const errors: Errors = {};
  if (!a.name.trim()) errors.name = "Enter your full name";
  if (!a.street.trim()) errors.street = "Enter a street and number";
  if (!/^[0-9]{4} ?[A-Za-z]{2}$/.test(a.postalCode)) errors.postalCode = "Use a format like 1011 AB";
  if (!a.city.trim()) errors.city = "Enter a city";
  return errors;
}

export function AddressForm({ onSubmit }: { onSubmit: (address: Address) => void }) {
  const [address, setAddress] = useState(empty);
  const [errors, setErrors] = useState<Errors>({});
  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const found = validate(address);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(address);
  };
  return (
    <form className="address-form" onSubmit={submit} noValidate>
      {FIELDS.map((key) => (
        <label key={key}>
          <input placeholder={key} value={address[key]} onChange={(event) => setAddress({ ...address, [key]: event.target.value })} />
          {errors[key] && <span className="field-error">{errors[key]}</span>}
        </label>
      ))}
      <Button type="submit">Continue</Button>
    </form>
  );
}
`;
const shipping1 = t`
import { useState } from "react";
import { Button } from "../Button";

const OPTIONS = [
  { id: "standard", label: "Standard delivery", priceCents: 595 },
  { id: "express", label: "Express delivery", priceCents: 1295 },
];

export function ShippingOptions({ country, onChoose }: { country: string; onChoose: (id: string) => void }) {
  const [selected, setSelected] = useState("standard");

  return (
    <fieldset className="shipping-options">
      <legend>Delivery to {country}</legend>
      {OPTIONS.map((option) => (
        <label key={option.id}>
          <input type="radio" checked={selected === option.id} onChange={() => setSelected(option.id)} />
          {option.label}
        </label>
      ))}
      <Button onClick={() => onChoose(selected)}>Continue</Button>
    </fieldset>
  );
}
`;
const shipping2 = edit(
  edit(
    edit(
      edit(shipping1, 'import { Button } from "../Button";\n', 'import { formatMoney } from "../../lib/format";\nimport { Button } from "../Button";\n'),
      'label: "Standard delivery", priceCents: 595 }', 'label: "Standard delivery", priceCents: 595, days: "3 to 5 days" }'),
    'label: "Express delivery", priceCents: 1295 }', 'label: "Express delivery", priceCents: 1295, days: "next day" }'),
  "          {option.label}\n",
  "          {option.label} ({option.days}, {formatMoney(option.priceCents)})\n",
);
const shippingTest = t`
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShippingOptions } from "./ShippingOptions";

describe("ShippingOptions", () => {
  it("continues with the selected option", () => {
    const chosen: string[] = [];
    render(<ShippingOptions country="NL" onChoose={(id) => chosen.push(id)} />);
    fireEvent.click(screen.getByLabelText(/Express/));
    fireEvent.click(screen.getByText("Continue"));
    expect(chosen).toEqual(["express"]);
  });
});
`;
const payment1 = t`
import { useState } from "react";
import { Button } from "../Button";

export function PaymentStep({ disabled, onPaid }: { disabled: boolean; onPaid: () => void }) {
  const [busy, setBusy] = useState(false);

  async function pay() {
    setBusy(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    setBusy(false);
    onPaid();
  }

  return (
    <section className="payment-step">
      <h2>Payment</h2>
      <Button disabled={disabled || busy} onClick={pay}>
        {busy ? "Paying..." : "Pay now"}
      </Button>
    </section>
  );
}
`;
const payment2 = edit(
  payment1,
  '      <Button disabled={disabled || busy} onClick={pay}>\n        {busy ? "Paying..." : "Pay now"}\n      </Button>\n',
  "      <Button disabled={disabled} loading={busy} onClick={pay}>\n        Pay now\n      </Button>\n",
);
const paymentFinal = edit(payment2, "      <h2>Payment</h2>\n", '      <h2>Payment</h2>\n      <p className="payment-note">You will be asked to confirm in your banking app.</p>\n');
const orderSummary1 = t`
import { formatMoney } from "../../lib/format";
import type { CartItem } from "../../state/cart";

export function OrderSummary({ items, total }: { items: CartItem[]; total: number }) {
  return (
    <aside className="order-summary">
      <h2>Your order</h2>
      <ul>
        {items.map((item) => (
          <li key={item.sku}>
            {item.quantity} x {item.name} <span>{formatMoney(item.priceCents * item.quantity)}</span>
          </li>
        ))}
      </ul>
      <p className="order-total">Total {formatMoney(total)}</p>
    </aside>
  );
}
`;
const orderSummary2 = edit(
  edit(orderSummary1, 'className="order-summary"', 'className="order-summary order-summary-sticky"'),
  '      <p className="order-total">',
  '      <p className="order-note">Delivery costs are added in the next step.</p>\n      <p className="order-total">',
);
const confirmation = t`
import { Link } from "react-router-dom";
import { formatMoney } from "../../lib/format";

export function ConfirmationStep({ orderNumber, total }: { orderNumber: string; total: number }) {
  return (
    <section className="confirmation">
      <h2>Thank you for your order</h2>
      <p>
        Order <strong>{orderNumber}</strong> is confirmed. We charged {formatMoney(total)}.
      </p>
      <Link to="/orders">See your orders</Link>
    </section>
  );
}
`;
const confirmationFinal = edit(confirmation, '      <Link to="/orders">', "      <p>A confirmation message is on its way.</p>\n      <Link to=\"/orders\">");
const couponField = t`
import { useState } from "react";
import { Button } from "../Button";

export function CouponField({ value, onApply }: { value: string; onApply: (code: string) => void }) {
  const [draft, setDraft] = useState(value);

  return (
    <div className="coupon-field">
      <input placeholder="Coupon code" value={draft} onChange={(event) => setDraft(event.target.value.trim())} />
      <Button variant="secondary" disabled={!draft} onClick={() => onApply(draft)}>
        Apply
      </Button>
    </div>
  );
}
`;
const couponFieldTest = t`
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CouponField } from "./CouponField";

describe("CouponField", () => {
  it("applies the typed code", () => {
    const onApply = vi.fn();
    render(<CouponField value="" onApply={onApply} />);
    fireEvent.change(screen.getByPlaceholderText("Coupon code"), { target: { value: "SPRING10" } });
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith("SPRING10");
  });
});
`;
const checkoutQa = t`
# Checkout redesign QA notes

- Back button from the payment step should keep the chosen delivery option.
- Coupon field: decide whether codes are case sensitive (the API uppercases them).
- Confirmation screen: the cart badge in the header must show 0 afterwards.
- Check focus order on the address form with the keyboard only.
`;

// ---------------------------------------------------------------------------------------------------- pages
const homePage1 = t`
import { useEffect, useState } from "react";
import { listProducts, type Product } from "../api/catalog";
import { ProductGrid } from "../components/ProductGrid";
import { useCart } from "../hooks/useCart";

export function HomePage() {
  const [products, setProducts] = useState<Product[]>([]);
  const { dispatch } = useCart();

  useEffect(() => {
    void listProducts().then(setProducts);
  }, []);

  return (
    <>
      <h1>Bikes, parts and everything in between</h1>
      <ProductGrid products={products} onAdd={(product) => dispatch({ type: "add", item: product })} />
    </>
  );
}
`;
const homePage2 = t`
import { useEffect, useState } from "react";
import { listProducts, type Product } from "../api/catalog";
import { ProductGrid } from "../components/ProductGrid";
import { useCart } from "../hooks/useCart";
import { useDebounce } from "../hooks/useDebounce";

export function HomePage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState("");
  const search = useDebounce(query.trim().toLowerCase());
  const { dispatch } = useCart();

  useEffect(() => {
    void listProducts().then(setProducts);
  }, []);

  const visible = products.filter((product) => product.name.toLowerCase().includes(search));
  return (
    <>
      <h1>Bikes, parts and everything in between</h1>
      <input type="search" placeholder="Search products" value={query} onChange={(event) => setQuery(event.target.value)} />
      <ProductGrid products={visible} onAdd={(product) => dispatch({ type: "add", item: product })} />
    </>
  );
}
`;
const homePageFinal = edit(
  edit(homePage2, 'import { useDebounce } from "../hooks/useDebounce";', 'import { useDebouncedValue } from "../hooks/useDebouncedValue";'),
  "useDebounce(query",
  "useDebouncedValue(query",
);
const ordersPage = t`
import { OrderList } from "../components/OrderList";
import { useOrders } from "../hooks/useOrders";

export function OrdersPage() {
  const { orders, loading } = useOrders();

  return (
    <>
      <h1>Your orders</h1>
      {loading ? <p>Loading...</p> : <OrderList orders={orders} />}
    </>
  );
}
`;
const detail1 = t`
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getOrder, type Order } from "../api/orders";
import { OrderStatusBadge } from "../components/OrderStatusBadge";
import { formatMoney, formatOrderNumber } from "../lib/format";

export function OrderDetailPage() {
  const { id = "" } = useParams();
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    void getOrder(id).then(setOrder);
  }, [id]);

  if (!order) return <p>Loading...</p>;
  return (
    <>
      <h1>Order {formatOrderNumber(order.id)}</h1>
      <OrderStatusBadge status={order.status} />
      <p>Total {formatMoney(order.total)}</p>
    </>
  );
}
`;
const detail2 = edit(detail1, "      <p>Total {formatMoney(order.total)}</p>\n", "      <p>Total {formatMoney(order.total)}</p>\n      {order.refundedTotal > 0 && <p>Refunded {formatMoney(order.refundedTotal)}</p>}\n");
const detail3 = edit(
  edit(
    edit(detail2, 'import { OrderStatusBadge } from "../components/OrderStatusBadge";\n', 'import { Button } from "../components/Button";\nimport { OrderStatusBadge } from "../components/OrderStatusBadge";\nimport { RefundDialog } from "../components/RefundDialog";\n'),
    "  const [order, setOrder] = useState<Order | null>(null);\n",
    "  const [order, setOrder] = useState<Order | null>(null);\n  const [refunding, setRefunding] = useState(false);\n",
  ),
  "      {order.refundedTotal > 0 &&",
  '      <Button variant="secondary" onClick={() => setRefunding(true)}>\n        Request a refund\n      </Button>\n      {refunding && <RefundDialog order={order} onClose={() => setRefunding(false)} />}\n      {order.refundedTotal > 0 &&',
);

// ---------------------------------------------------------------------------------------------------- HEAD tree
const files = {
  ".gitignore": gitignore,
  "README.md": readme,
  "package.json": pkg2,
  "tsconfig.json": tsconfig,
  "vite.config.ts": viteConfig,
  "index.html": indexHtml,
  "src/main.tsx": main,
  "src/App.tsx": app2,
  "src/routes.tsx": routes5,
  "src/styles/theme.css": css3,
  "src/api/client.ts": apiClient,
  "src/api/catalog.ts": apiCatalog,
  "src/api/orders.ts": apiOrders2,
  "src/hooks/useCart.ts": useCart,
  "src/hooks/useOrders.ts": useOrders2,
  "src/hooks/useDebounce.ts": useDebounce,
  "src/hooks/useCheckout.ts": useCheckout2,
  "src/state/cart.ts": cart2,
  "src/lib/format.ts": format,
  "src/lib/format.test.ts": formatTest,
  "src/components/Button.tsx": button2,
  "src/components/Header.tsx": header2,
  "src/components/ProductCard.tsx": productCard,
  "src/components/ProductCard.test.tsx": productCardTest,
  "src/components/ProductGrid.tsx": productGrid2,
  "src/components/CartDrawer.tsx": cartDrawer,
  "src/components/OrderList.tsx": orderList,
  "src/components/OrderStatusBadge.tsx": badge2,
  "src/components/RefundDialog.tsx": refundDialog,
  "src/components/checkout/AddressForm.tsx": addressForm2,
  "src/components/checkout/ShippingOptions.tsx": shipping2,
  "src/components/checkout/ShippingOptions.test.tsx": shippingTest,
  "src/components/checkout/PaymentStep.tsx": payment2,
  "src/components/checkout/OrderSummary.tsx": orderSummary2,
  "src/components/checkout/CheckoutPage.tsx": checkoutPage4,
  "src/components/checkout/ConfirmationStep.tsx": confirmation,
  "src/pages/HomePage.tsx": homePage2,
  "src/pages/OrdersPage.tsx": ordersPage,
  "src/pages/OrderDetailPage.tsx": detail3,
};

// ---------------------------------------------------------------------------------------------------- history
const step = (at, author, message, changes, extra = {}) => ({ at, author, message, changes, ...extra });
const merge = (at, author, branch, from, message) => ({ at, author, message, branch, merge: { from, message } });
const FEATURE = "feature/checkout-redesign";

const history = [
  step("2026-08-24T09:30:00Z", "priya", "chore: initial commit", { ".gitignore": gitignore, "README.md": readme, "package.json": pkg0, "tsconfig.json": tsconfig, "vite.config.ts": viteConfig, "index.html": indexHtml }, { branch: "main" }),
  step("2026-08-25T10:15:00Z", "priya", "feat: app shell and routing", { "src/main.tsx": main, "src/App.tsx": app1, "src/routes.tsx": routes1, "src/styles/theme.css": css1 }),
  step("2026-08-26T09:20:00Z", "mira", "feat(api): typed fetch client", { "src/api/client.ts": apiClient }),
  step("2026-08-27T11:00:00Z", "daniel", "feat(lib): money and date formatting", { "src/lib/format.ts": format, "src/lib/format.test.ts": formatTest }),
  step("2026-08-28T10:40:00Z", "daniel", "feat(cart): cart state with a tiny store", { "src/state/cart.ts": cart1, "src/hooks/useCart.ts": useCart }),
  step("2026-08-29T09:50:00Z", "mira", "feat(catalog): product grid and cards", { "src/api/catalog.ts": apiCatalog, "src/components/Button.tsx": button1, "src/components/ProductCard.tsx": productCard, "src/components/ProductGrid.tsx": productGrid1, "src/pages/HomePage.tsx": homePage1, "src/routes.tsx": routes2 }),
  step("2026-08-30T14:10:00Z", "priya", "feat(cart): cart drawer and header", { "src/components/CartDrawer.tsx": cartDrawer, "src/components/Header.tsx": header1, "src/App.tsx": app2 }),
  step("2026-09-01T10:30:00Z", "tomas", "feat(orders): orders list page", { "src/api/orders.ts": apiOrders1, "src/hooks/useOrders.ts": useOrders1, "src/components/OrderList.tsx": orderList, "src/components/OrderStatusBadge.tsx": badge1, "src/pages/OrdersPage.tsx": ordersPage, "src/routes.tsx": routes3 }),
  step("2026-09-02T11:25:00Z", "mira", "feat(orders): order detail page", { "src/pages/OrderDetailPage.tsx": detail1, "src/routes.tsx": routes4 }),
  step("2026-09-03T15:00:00Z", "daniel", "feat(checkout): single page checkout", { "src/components/checkout/CheckoutPage.tsx": checkoutPage1, "src/components/checkout/AddressForm.tsx": addressForm1, "src/components/checkout/PaymentStep.tsx": payment1, "src/components/checkout/OrderSummary.tsx": orderSummary1, "src/routes.tsx": routes5 }),
  step("2026-09-04T09:40:00Z", "priya", "test: product card price and sold out state", { "src/components/ProductCard.test.tsx": productCardTest }),
  step("2026-09-05T16:15:00Z", "tomas", "fix(cart): keep the quantity when the same product is added", { "src/state/cart.ts": cart2 }),
  step("2026-09-08T10:05:00Z", "daniel", "feat(search): debounced product search", { "src/hooks/useDebounce.ts": useDebounce, "src/pages/HomePage.tsx": homePage2 }),
  step("2026-09-09T09:35:00Z", "mira", "fix(header): cart badge overflows on small screens", { "src/components/Header.tsx": header2, "src/styles/theme.css": css2 }),
  step("2026-09-10T13:20:00Z", "priya", "feat(orders): show refund status on the order detail (FB-231)", { "src/components/OrderStatusBadge.tsx": badge2, "src/pages/OrderDetailPage.tsx": detail2, "src/api/orders.ts": apiOrders2 }),
  step("2026-09-11T10:00:00Z", "mira", "feat(checkout): step layout for the redesign", { "src/components/checkout/CheckoutPage.tsx": checkoutPage2, "src/components/checkout/ShippingOptions.tsx": shipping1 }, { branch: FEATURE }),
  step("2026-09-12T09:15:00Z", "tomas", "chore(deps): bump react-router and vite", { "package.json": pkg1 }, { branch: "main" }),
  step("2026-09-14T11:30:00Z", "mira", "feat(checkout): address form with inline validation", { "src/components/checkout/AddressForm.tsx": addressForm2 }, { branch: FEATURE }),
  step("2026-09-15T10:20:00Z", "daniel", "fix(orders): list the newest orders first", { "src/hooks/useOrders.ts": useOrders2 }, { branch: "main" }),
  step("2026-09-16T14:05:00Z", "priya", "feat(checkout): delivery estimates on shipping options", { "src/components/checkout/ShippingOptions.tsx": shipping2 }, { branch: FEATURE }),
  step("2026-09-17T09:00:00Z", "release-bot", "chore(release): v2.4.0", { "package.json": pkg2 }, { branch: "main", tag: { name: "v2.4.0", message: "Release v2.4.0" } }),
  merge("2026-09-17T15:30:00Z", "mira", FEATURE, "main", "Merge branch 'main' into feature/checkout-redesign"),
  step("2026-09-18T10:45:00Z", "mira", "feat(checkout): sticky order summary", { "src/components/checkout/OrderSummary.tsx": orderSummary2 }),
  step("2026-09-19T11:10:00Z", "priya", "feat(checkout): payment step uses the loading button", { "src/components/checkout/PaymentStep.tsx": payment2, "src/components/Button.tsx": button2 }),
  step("2026-09-22T09:25:00Z", "daniel", "fix(catalog): hide products that are out of stock", { "src/components/ProductGrid.tsx": productGrid2 }, { branch: "main" }),
  step("2026-09-22T14:40:00Z", "tomas", "test(checkout): shipping option selection", { "src/components/checkout/ShippingOptions.test.tsx": shippingTest }, { branch: FEATURE }),
  step("2026-09-23T10:10:00Z", "priya", "feat(orders): request a refund from the order detail (FB-214)", { "src/components/RefundDialog.tsx": refundDialog, "src/pages/OrderDetailPage.tsx": detail3 }, { branch: "main" }),
  step("2026-09-23T15:20:00Z", "mira", "refactor(checkout): extract a useCheckout hook", { "src/hooks/useCheckout.ts": useCheckout1, "src/components/checkout/CheckoutPage.tsx": checkoutPage3 }, { branch: FEATURE }),
  merge("2026-09-24T11:00:00Z", "tomas", FEATURE, "main", "Merge branch 'main' into feature/checkout-redesign"),
  step("2026-09-25T10:30:00Z", "priya", "feat(checkout): confirmation screen", { "src/components/checkout/ConfirmationStep.tsx": confirmation, "src/hooks/useCheckout.ts": useCheckout2, "src/components/checkout/CheckoutPage.tsx": checkoutPage4 }),
  step("2026-09-25T16:45:00Z", "mira", "style(checkout): spacing and focus rings", { "src/styles/theme.css": css3 }),
];

// ---------------------------------------------------------------------------------------------------- work tree
const worktree = {
  modify: {
    "src/components/checkout/ConfirmationStep.tsx": confirmationFinal,
    "src/components/checkout/CheckoutPage.tsx": checkoutPageFinal,
    "src/components/checkout/PaymentStep.tsx": paymentFinal,
    "src/hooks/useCheckout.ts": useCheckoutFinal,
    "src/components/OrderStatusBadge.tsx": badgeFinal,
    "src/components/RefundDialog.tsx": refundDialogFinal,
    "src/api/orders.ts": apiOrdersFinal,
    "src/pages/HomePage.tsx": homePageFinal,
    "src/styles/theme.css": cssFinal,
  },
  stageAdd: { "src/api/refunds.ts": apiRefunds },
  stageRename: [{ from: "src/hooks/useDebounce.ts", to: "src/hooks/useDebouncedValue.ts", text: useDebouncedValue }],
  untracked: {
    "src/components/checkout/CouponField.tsx": couponField,
    "src/components/checkout/CouponField.test.tsx": couponFieldTest,
    "notes/checkout-qa.md": checkoutQa,
  },
};

export default {
  id: "fb-web",
  name: "fb-web",
  branch: FEATURE,
  files,
  history,
  worktree,
  // The Run B scenario of the mock demo (RC13) edits this badge: one line added to the label table.
  agentEdit: { path: "src/components/OrderStatusBadge.tsx", before: '  refunded: "Refunded",\n', after: '  refunded: "Refunded",\n  partially_refunded: "Partly refunded",\n' },
  upstream: { ahead: 2, behind: 0 },
};

/** Ticket ids of the refund story that fb-api and fb-mobile history refer to as well. */
export const TICKETS = ["FB-214", "FB-231"];
