// Demo repository fb-mobile: the shopping app of the fictional Fernbank Cycles (React Native, TypeScript, Expo).
// Everything here is invented. File contents are template strings so that TypeScript, lint and CodeQL tooling do not
// treat them as project source. Schema and rules: scripts/demo-workspace/README.md.
//
// Story shared with fb-api and fb-web: the refund work (tickets FB-214, FB-231). The checked-out branch is main and
// one commit ahead of origin (so the push dialog asks for the typed live-branch confirmation); develop is merged once
// and carries one more commit; the work tree holds the unfinished refund request.

/** Template literal helper: drops the first newline so every file reads naturally in this source. */
const t = (s) => s[0].replace(/^\n/, "");

/** Replaces `from` by `to` exactly once and fails loudly when the anchor is missing (keeps versions in sync). */
const edit = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error("fb-mobile: edit anchor must occur exactly once: " + from.slice(0, 48));
  return text.replace(from, () => to);
};

const json = (o) => JSON.stringify(o, null, 2) + "\n";

// ---------------------------------------------------------------------------------------------------- tooling
const gitignore = t`
node_modules
.expo
dist
*.log
.DS_Store
`;
const readme = t`
# fb-mobile

The Fernbank shopping app: browse bikes and parts, fill a cart and follow your orders.

## Getting started

    pnpm install
    pnpm start

The app talks to the Fernbank API. Run the tests with pnpm test.
`;
const pkg = ({ version, deps }) =>
  json({
    name: "@fernbank/mobile",
    version,
    private: true,
    main: "expo/AppEntry.js",
    scripts: { start: "expo start", ios: "expo run:ios", android: "expo run:android", test: "jest" },
    dependencies: deps,
    devDependencies: { "@testing-library/react-native": "^12.5.0", "@types/react": "~18.2.79", jest: "^29.7.0", "jest-expo": "~51.0.3", typescript: "~5.3.3" },
  });
const deps0 = { expo: "~51.0.8", react: "18.2.0", "react-native": "0.74.1", "@react-navigation/native": "^6.1.17", "@react-navigation/native-stack": "^6.9.26", "@react-native-async-storage/async-storage": "1.23.1" };
const pkg0 = pkg({ version: "0.8.0", deps: deps0 });
const pkg1 = pkg({ version: "0.8.0", deps: { ...deps0, expo: "~51.0.28", "react-native": "0.74.5" } });
const pkg2 = edit(pkg1, '"version": "0.8.0"', '"version": "0.9.0"');
const tsconfig = json({ extends: "expo/tsconfig.base", compilerOptions: { strict: true }, include: ["**/*.ts", "**/*.tsx"] });
const app = (version) =>
  json({
    expo: {
      name: "Fernbank",
      slug: "fernbank",
      version,
      orientation: "portrait",
      ios: { bundleIdentifier: "example.fernbank.mobile" },
      android: { package: "example.fernbank.mobile" },
    },
  });
const app0 = app("0.8.0");
const app1 = app("0.9.0");
const babel = t`
module.exports = function (api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
`;

// ---------------------------------------------------------------------------------------------------- theme and lib
const colors1 = t`
export const colors = {
  brand: "#1f6f5c",
  onBrand: "#ffffff",
  surface: "#f5f7f6",
  text: "#18211f",
  muted: "#5d6b67",
  border: "#d5dcda",
  warn: "#b26a00",
  danger: "#b3261e",
} as const;
`;
const colors2 = edit(colors1, 'muted: "#5d6b67"', 'muted: "#4a5754"');
const spacing = t`
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export type Spacing = keyof typeof spacing;
`;
const storage = t`
import AsyncStorage from "@react-native-async-storage/async-storage";

export async function loadJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function saveJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}
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
  return "#" + id.slice(0, 6).toUpperCase();
}
`;
const formatTest = t`
import { formatMoney, formatOrderNumber } from "./format";

describe("formatMoney", () => {
  it("formats cents with two decimals", () => {
    expect(formatMoney(12950)).toContain("129.50");
  });
});

describe("formatOrderNumber", () => {
  it("shortens and upper-cases the id", () => {
    expect(formatOrderNumber("a1b2c3d4")).toBe("#A1B2C3");
  });
});
`;

// ---------------------------------------------------------------------------------------------------- api
const apiClient = t`
const BASE_URL = "https://api.fernbank.example";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(BASE_URL + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new ApiError(response.status, "Request failed: " + path);
  return (await response.json()) as T;
}
`;
const apiCatalog = t`
import { api } from "./client";

export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
}

export const listProducts = () => api<{ items: Product[] }>("/products").then((response) => response.items);
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
const apiRefundsFinal = edit(
  edit(apiRefunds, "reason: string) =>", "reason: string, note?: string) =>"),
  "JSON.stringify({ orderId, amount, reason })",
  "JSON.stringify({ orderId, amount, reason, note })",
);

// ---------------------------------------------------------------------------------------------------- state and hooks
const cart1 = t`
import type { Product } from "../api/catalog";

export interface CartLine {
  sku: string;
  name: string;
  priceCents: number;
  quantity: number;
}

let lines: CartLine[] = [];
const listeners = new Set<() => void>();

export const getLines = () => lines;
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function addProduct(product: Product) {
  lines = [...lines, { sku: product.sku, name: product.name, priceCents: product.priceCents, quantity: 1 }];
  listeners.forEach((listener) => listener());
}
`;
const cart2 = edit(
  cart1,
  "  lines = [...lines, { sku: product.sku, name: product.name, priceCents: product.priceCents, quantity: 1 }];\n",
  t`
  const existing = lines.find((line) => line.sku === product.sku);
  lines = existing
    ? lines.map((line) => (line === existing ? { ...line, quantity: line.quantity + 1 } : line))
    : [...lines, { sku: product.sku, name: product.name, priceCents: product.priceCents, quantity: 1 }];
`,
);
const cart3 =
  cart2 +
  t`

export function removeProduct(sku: string) {
  lines = lines.filter((line) => line.sku !== sku);
  listeners.forEach((listener) => listener());
}
`;
const useCart1 = t`
// Subscribes to the in-memory cart and derives the total.
import { useSyncExternalStore } from "react";
import { getLines, subscribe } from "../state/cart";

export function useCart() {
  const lines = useSyncExternalStore(subscribe, getLines);
  const total = lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  return { lines, total };
}
`;
const useCart2 = edit(
  useCart1,
  "  return { lines, total };\n",
  "  const count = lines.reduce((sum, line) => sum + line.quantity, 0);\n  return { lines, total, count };\n",
);
const useOrders = t`
import { useEffect, useState } from "react";
import { listOrders, type Order } from "../api/orders";

export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listOrders().then(setOrders).finally(() => setLoading(false));
  }, []);

  return { orders, loading };
}
`;
const useDebounce = t`
import { useEffect, useState } from "react";

export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
`;

// ---------------------------------------------------------------------------------------------------- navigation
// [route, component, title, params]; the navigator grows one screen at a time.
const SCREENS = [
  ["Catalog", "CatalogScreen", "Shop", "undefined"],
  ["Cart", "CartScreen", "Your cart", "undefined"],
  ["Orders", "OrdersScreen", "Orders", "undefined"],
  ["OrderDetail", "OrderDetailScreen", "Order", "{ orderId: string }"],
  ["Settings", "SettingsScreen", "Settings", "undefined"],
  ["Refund", "RefundScreen", "Request a refund", "{ orderId: string }"],
];
const navTypes = (n) =>
  [
    "// Screen names and the params each screen expects.",
    "// A screen without params is declared as undefined.",
    "export type RootStackParamList = {",
    ...SCREENS.slice(0, n).map(([name, , , params]) => "  " + name + ": " + params + ";"),
    "};",
    "",
    "export type ScreenName = keyof RootStackParamList;",
    "export type ScreenParams<T extends ScreenName> = RootStackParamList[T];",
    "",
  ].join("\n");
const navigator = (n) =>
  [
    'import { createNativeStackNavigator } from "@react-navigation/native-stack";',
    ...SCREENS.slice(0, n).map(([, component]) => "import { " + component + ' } from "../screens/' + component + '";'),
    'import type { RootStackParamList } from "./types";',
    "",
    "const Stack = createNativeStackNavigator<RootStackParamList>();",
    "",
    "export function RootNavigator() {",
    "  return (",
    '    <Stack.Navigator initialRouteName="Catalog">',
    ...SCREENS.slice(0, n).map(([name, component, title]) => '      <Stack.Screen name="' + name + '" component={' + component + "} options={{ title: " + JSON.stringify(title) + " }} />"),
    "    </Stack.Navigator>",
    "  );",
    "}",
    "",
  ].join("\n");
const app1Tsx = t`
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { RootNavigator } from "./src/navigation/RootNavigator";

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="auto" />
      <RootNavigator />
    </NavigationContainer>
  );
}
`;

// ---------------------------------------------------------------------------------------------------- components
const button = t`
import { Pressable, StyleSheet, Text } from "react-native";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}

export function Button({ label, onPress, variant = "primary", disabled = false }: ButtonProps) {
  const secondary = variant === "secondary";
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.base, secondary ? styles.secondary : styles.primary, disabled && styles.disabled]}>
      <Text style={secondary ? styles.secondaryLabel : styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: 8, alignItems: "center" },
  primary: { backgroundColor: colors.brand },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.brand },
  disabled: { opacity: 0.5 },
  label: { color: colors.onBrand, fontWeight: "600" },
  secondaryLabel: { color: colors.brand, fontWeight: "600" },
});
`;
const emptyState = t`
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", padding: spacing.xl },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  hint: { marginTop: spacing.sm, color: colors.muted, textAlign: "center" },
});
`;
const productRow = t`
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Product } from "../api/catalog";
import { formatMoney } from "../lib/format";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

export function ProductRow({ product, onAdd }: { product: Product; onAdd: (product: Product) => void }) {
  const soldOut = product.stock === 0;
  return (
    <Pressable style={styles.row} onPress={() => onAdd(product)} disabled={soldOut}>
      <View>
        <Text style={styles.name}>{product.name}</Text>
        <Text style={styles.price}>{soldOut ? "Sold out" : formatMoney(product.priceCents)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { padding: spacing.lg, borderBottomWidth: 1, borderColor: colors.border },
  name: { fontSize: 16, color: colors.text },
  price: { color: colors.muted, marginTop: spacing.xs },
});
`;
const statusPill1 = t`
import { StyleSheet, Text } from "react-native";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

const LABELS: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  shipped: "Shipped",
  delivered: "Delivered",
};

export function StatusPill({ status }: { status: string }) {
  return <Text style={styles.pill}>{LABELS[status] ?? status}</Text>;
}

const styles = StyleSheet.create({
  pill: { alignSelf: "flex-start", color: colors.brand, fontSize: 12, paddingHorizontal: spacing.sm },
});
`;
const statusPill2 = edit(statusPill1, '  delivered: "Delivered",\n', '  delivered: "Delivered",\n  refunded: "Refunded",\n');
const AGENT_BEFORE = '  refunded: "Refunded",\n';
const AGENT_AFTER = '  refunded: "Refunded",\n  partially_refunded: "Partly refunded",\n';
const statusPillFinal = edit(statusPill2, AGENT_BEFORE, AGENT_AFTER);
const statusPillTest = t`
import { render } from "@testing-library/react-native";
import { StatusPill } from "./StatusPill";

describe("StatusPill", () => {
  it("shows a readable label", () => {
    const { getByText } = render(<StatusPill status="shipped" />);
    expect(getByText("Shipped")).toBeTruthy();
  });

  it("falls back to the raw status", () => {
    const { getByText } = render(<StatusPill status="on_hold" />);
    expect(getByText("on_hold")).toBeTruthy();
  });
});
`;
const orderRow1 = t`
import { Pressable, StyleSheet, Text } from "react-native";
import type { Order } from "../api/orders";
import { formatDate, formatMoney, formatOrderNumber } from "../lib/format";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";
import { StatusPill } from "./StatusPill";

export function OrderRow({ order, onPress }: { order: Order; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={styles.title}>{formatOrderNumber(order.id)}</Text>
      <Text style={styles.meta}>{formatDate(order.createdAt)} - {formatMoney(order.total)}</Text>
      <StatusPill status={order.status} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { padding: spacing.lg, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontWeight: "600", color: colors.text },
  meta: { color: colors.muted, marginVertical: spacing.xs },
});
`;
const orderRow2 = edit(orderRow1, "  row: { padding: spacing.lg,", "  row: { minHeight: 64, padding: spacing.lg,");

// ---------------------------------------------------------------------------------------------------- screens
const catalog1 = t`
import { useEffect, useState } from "react";
import { FlatList } from "react-native";
import { listProducts, type Product } from "../api/catalog";
import { EmptyState } from "../components/EmptyState";
import { ProductRow } from "../components/ProductRow";
import { addProduct } from "../state/cart";

export function CatalogScreen() {
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    listProducts().then(setProducts).catch(() => setProducts([]));
  }, []);

  return (
    <FlatList
      data={products}
      keyExtractor={(product) => product.sku}
      renderItem={({ item }) => <ProductRow product={item} onAdd={addProduct} />}
      ListEmptyComponent={<EmptyState title="No products yet" hint="Pull down to try again." />}
    />
  );
}
`;
const catalog2 = edit(
  edit(
    edit(catalog1, "  const [products, setProducts] = useState<Product[]>([]);\n", "  const [products, setProducts] = useState<Product[]>([]);\n  const [refreshing, setRefreshing] = useState(false);\n"),
    "  useEffect(() => {\n    listProducts().then(setProducts).catch(() => setProducts([]));\n  }, []);\n",
    t`
  const load = () => listProducts().then(setProducts).catch(() => setProducts([]));

  useEffect(() => {
    load();
  }, []);

  const refresh = () => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  };
`,
  ),
  "      data={products}\n",
  "      data={products}\n      refreshing={refreshing}\n      onRefresh={refresh}\n",
);
const catalog3 = edit(
  edit(
    edit(
      edit(catalog2, 'import { FlatList } from "react-native";', 'import { FlatList, TextInput } from "react-native";'),
      "  const [refreshing, setRefreshing] = useState(false);\n",
      '  const [refreshing, setRefreshing] = useState(false);\n  const [query, setQuery] = useState("");\n',
    ),
    "      data={products}\n",
    "      data={products.filter((product) => product.name.toLowerCase().includes(query.toLowerCase()))}\n",
  ),
  "      refreshing={refreshing}\n",
  '      ListHeaderComponent={<TextInput placeholder="Search" value={query} onChangeText={setQuery} />}\n      refreshing={refreshing}\n',
);
const catalog4 = edit(
  edit(
    edit(catalog3, 'import { ProductRow } from "../components/ProductRow";\n', 'import { ProductRow } from "../components/ProductRow";\nimport { useDebounce } from "../hooks/useDebounce";\n'),
    '  const [query, setQuery] = useState("");\n',
    '  const [query, setQuery] = useState("");\n  const search = useDebounce(query, 250);\n',
  ),
  ".includes(query.toLowerCase())",
  ".includes(search.toLowerCase())",
);
const cartScreen = t`
import { FlatList, StyleSheet, Text, View } from "react-native";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { useCart } from "../hooks/useCart";
import { formatMoney } from "../lib/format";
import { spacing } from "../theme/spacing";

export function CartScreen() {
  const { lines, total } = useCart();
  if (lines.length === 0) return <EmptyState title="Your cart is empty" />;

  return (
    <View style={styles.page}>
      <FlatList
        data={lines}
        keyExtractor={(line) => line.sku}
        renderItem={({ item }) => <Text>{item.quantity} x {item.name}</Text>}
      />
      <Text style={styles.total}>Total {formatMoney(total)}</Text>
      <Button label="Check out" onPress={() => undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: spacing.lg },
  total: { fontSize: 18, fontWeight: "600", marginVertical: spacing.md },
});
`;
const orders1 = t`
import { FlatList } from "react-native";
import { EmptyState } from "../components/EmptyState";
import { OrderRow } from "../components/OrderRow";
import { useOrders } from "../hooks/useOrders";

export function OrdersScreen() {
  const { orders } = useOrders();

  return (
    <FlatList
      data={orders}
      keyExtractor={(order) => order.id}
      renderItem={({ item }) => <OrderRow order={item} onPress={() => undefined} />}
      ListEmptyComponent={<EmptyState title="No orders yet" />}
    />
  );
}
`;
const orders3 = edit(
  edit(
    edit(
      edit(orders1, 'import { FlatList } from "react-native";\n', 'import { FlatList } from "react-native";\nimport type { NativeStackScreenProps } from "@react-navigation/native-stack";\n'),
      'import { useOrders } from "../hooks/useOrders";\n',
      'import { useOrders } from "../hooks/useOrders";\nimport type { RootStackParamList } from "../navigation/types";\n',
    ),
    "export function OrdersScreen() {",
    'export function OrdersScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Orders">) {',
  ),
  "onPress={() => undefined}",
  'onPress={() => navigation.navigate("OrderDetail", { orderId: item.id })}',
);
const detail1 = t`
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { getOrder, type Order } from "../api/orders";
import { StatusPill } from "../components/StatusPill";
import { formatMoney, formatOrderNumber } from "../lib/format";
import type { RootStackParamList } from "../navigation/types";
import { spacing } from "../theme/spacing";

export function OrderDetailScreen({ route }: NativeStackScreenProps<RootStackParamList, "OrderDetail">) {
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    getOrder(route.params.orderId).then(setOrder);
  }, [route.params.orderId]);

  if (!order) return <Text style={styles.loading}>Loading...</Text>;

  return (
    <View style={styles.page}>
      <Text style={styles.title}>{formatOrderNumber(order.id)}</Text>
      <StatusPill status={order.status} />
      <Text>Total {formatMoney(order.total)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg },
  title: { fontSize: 20, fontWeight: "600" },
  loading: { padding: spacing.lg },
});
`;
const detail2 = edit(detail1, "      <Text>Total {formatMoney(order.total)}</Text>\n", "      <Text>Total {formatMoney(order.total)}</Text>\n      {order.refundedTotal > 0 ? <Text>Refunded {formatMoney(order.refundedTotal)}</Text> : null}\n");
const detail3 = edit(
  edit(
    edit(detail2, 'import { StatusPill } from "../components/StatusPill";\n', 'import { Button } from "../components/Button";\nimport { StatusPill } from "../components/StatusPill";\n'),
    "OrderDetailScreen({ route }:",
    "OrderDetailScreen({ route, navigation }:",
  ),
  "    </View>\n  );\n}\n",
  t`
      {order.status === "delivered" ? (
        <Button label="Request a refund" variant="secondary" onPress={() => navigation.navigate("Refund", { orderId: order.id })} />
      ) : null}
    </View>
  );
}
`,
);
const settings1 = t`
import Constants from "expo-constants";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/colors";
import { spacing } from "../theme/spacing";

export function SettingsScreen() {
  return (
    <View style={styles.page}>
      <Text style={styles.label}>Version</Text>
      <Text style={styles.value}>{Constants.expoConfig?.version ?? "dev"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg },
  label: { color: colors.muted },
  value: { fontSize: 16, color: colors.text, marginTop: spacing.xs },
});
`;
const settings2 = edit(
  settings1,
  '      <Text style={styles.value}>{Constants.expoConfig?.version ?? "dev"}</Text>\n',
  '      <Text style={styles.value}>{Constants.expoConfig?.version ?? "dev"}</Text>\n      <Text style={styles.label}>Language</Text>\n      <Text style={styles.value}>English</Text>\n',
);
const refund1 = t`
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button } from "../components/Button";
import type { RootStackParamList } from "../navigation/types";
import { spacing } from "../theme/spacing";

const REASONS = ["Damaged", "Wrong item", "Not as described", "Changed my mind"];

export function RefundScreen({ navigation }: NativeStackScreenProps<RootStackParamList, "Refund">) {
  const [reason, setReason] = useState(REASONS[0]);

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Why are you returning this?</Text>
      {REASONS.map((value) => (
        <Button key={value} label={value} variant={value === reason ? "primary" : "secondary"} onPress={() => setReason(value)} />
      ))}
      <Button label="Cancel" variant="secondary" onPress={() => navigation.goBack()} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.sm },
  title: { fontSize: 18, fontWeight: "600" },
});
`;
const refundFinal = edit(
  edit(
    edit(
      edit(refund1, 'import { Button } from "../components/Button";\n', 'import { requestRefund } from "../api/refunds";\nimport { Button } from "../components/Button";\n'),
      "RefundScreen({ navigation }:",
      "RefundScreen({ navigation, route }:",
    ),
    "  const [reason, setReason] = useState(REASONS[0]);\n",
    "  const [reason, setReason] = useState(REASONS[0]);\n  const amount = 0; // TODO(FB-214): use the remaining amount of the order\n",
  ),
  '      <Button label="Cancel"',
  '      <Button label="Send request" onPress={() => requestRefund(route.params.orderId, amount, reason).then(() => navigation.goBack())} />\n      <Button label="Cancel"',
);
const refundSheet = t`
import { Modal, StyleSheet, Text, View } from "react-native";
import { spacing } from "../theme/spacing";
import { Button } from "./Button";

interface Props {
  visible: boolean;
  reasons: string[];
  onPick: (reason: string) => void;
  onClose: () => void;
}

export function RefundReasonSheet({ visible, reasons, onPick, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Text style={styles.title}>Reason</Text>
        {reasons.map((reason) => (
          <Button key={reason} label={reason} variant="secondary" onPress={() => onPick(reason)} />
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { marginTop: "auto", padding: spacing.lg, backgroundColor: "#ffffff", gap: spacing.sm },
  title: { fontSize: 16, fontWeight: "600" },
});
`;

// ---------------------------------------------------------------------------------------------------- HEAD tree
const files = {
  ".gitignore": gitignore,
  "README.md": readme,
  "package.json": pkg2,
  "tsconfig.json": tsconfig,
  "app.json": app1,
  "babel.config.js": babel,
  "App.tsx": app1Tsx,
  "src/navigation/types.ts": navTypes(6),
  "src/navigation/RootNavigator.tsx": navigator(6),
  "src/theme/colors.ts": colors2,
  "src/theme/spacing.ts": spacing,
  "src/api/client.ts": apiClient,
  "src/api/catalog.ts": apiCatalog,
  "src/api/orders.ts": apiOrders2,
  "src/api/refunds.ts": apiRefunds,
  "src/lib/format.ts": format,
  "src/lib/format.test.ts": formatTest,
  "src/lib/storage.ts": storage,
  "src/state/cart.ts": cart3,
  "src/hooks/useCart.ts": useCart2,
  "src/hooks/useOrders.ts": useOrders,
  "src/hooks/useDebounce.ts": useDebounce,
  "src/components/Button.tsx": button,
  "src/components/EmptyState.tsx": emptyState,
  "src/components/ProductRow.tsx": productRow,
  "src/components/OrderRow.tsx": orderRow2,
  "src/components/StatusPill.tsx": statusPill2,
  "src/components/StatusPill.test.tsx": statusPillTest,
  "src/screens/CatalogScreen.tsx": catalog4,
  "src/screens/CartScreen.tsx": cartScreen,
  "src/screens/OrdersScreen.tsx": orders3,
  "src/screens/OrderDetailScreen.tsx": detail3,
  "src/screens/RefundScreen.tsx": refund1,
  "src/screens/SettingsScreen.tsx": settings1,
};

// ---------------------------------------------------------------------------------------------------- history
const step = (at, author, message, changes, extra = {}) => ({ at, author, message, changes, ...extra });
const DEVELOP = "develop";

const history = [
  step("2026-08-24T09:00:00Z", "daniel", "chore: initial commit", { ".gitignore": gitignore, "README.md": readme, "package.json": pkg0, "tsconfig.json": tsconfig, "app.json": app0, "babel.config.js": babel }, { branch: "main" }),
  step("2026-08-25T10:00:00Z", "tomas", "feat(theme): colour and spacing scale", { "src/theme/colors.ts": colors1, "src/theme/spacing.ts": spacing }),
  step("2026-08-26T09:30:00Z", "tomas", "feat(api): typed fetch client and storage helpers", { "src/api/client.ts": apiClient, "src/lib/storage.ts": storage }),
  step("2026-08-27T11:00:00Z", "daniel", "feat(lib): money and date formatting", { "src/lib/format.ts": format, "src/lib/format.test.ts": formatTest }),
  step("2026-08-28T10:30:00Z", "daniel", "feat(cart): cart state and hook", { "src/state/cart.ts": cart1, "src/hooks/useCart.ts": useCart1 }),
  step("2026-08-29T14:00:00Z", "priya", "feat(catalog): product list screen and navigation shell", { "App.tsx": app1Tsx, "src/navigation/types.ts": navTypes(1), "src/navigation/RootNavigator.tsx": navigator(1), "src/api/catalog.ts": apiCatalog, "src/components/Button.tsx": button, "src/components/EmptyState.tsx": emptyState, "src/components/ProductRow.tsx": productRow, "src/screens/CatalogScreen.tsx": catalog1 }),
  step("2026-08-31T10:15:00Z", "tomas", "feat(cart): cart screen", { "src/screens/CartScreen.tsx": cartScreen, "src/navigation/types.ts": navTypes(2), "src/navigation/RootNavigator.tsx": navigator(2) }),
  step("2026-09-01T11:00:00Z", "priya", "feat(orders): orders list", { "src/api/orders.ts": apiOrders1, "src/hooks/useOrders.ts": useOrders, "src/components/OrderRow.tsx": orderRow1, "src/components/StatusPill.tsx": statusPill1, "src/screens/OrdersScreen.tsx": orders1, "src/navigation/types.ts": navTypes(3), "src/navigation/RootNavigator.tsx": navigator(3) }),
  step("2026-09-02T10:40:00Z", "daniel", "feat(orders): order detail screen", { "src/screens/OrderDetailScreen.tsx": detail1, "src/screens/OrdersScreen.tsx": orders3, "src/navigation/types.ts": navTypes(4), "src/navigation/RootNavigator.tsx": navigator(4) }),
  step("2026-09-04T15:10:00Z", "tomas", "fix(cart): keep the quantity when the same product is added", { "src/state/cart.ts": cart2 }),
  step("2026-09-05T09:45:00Z", "priya", "feat(settings): settings screen with the app version", { "src/screens/SettingsScreen.tsx": settings1, "src/navigation/types.ts": navTypes(5), "src/navigation/RootNavigator.tsx": navigator(5) }),
  step("2026-09-07T10:20:00Z", "daniel", "chore(deps): bump expo and react-native", { "package.json": pkg1 }),
  step("2026-09-08T11:30:00Z", "tomas", "feat(catalog): pull to refresh", { "src/screens/CatalogScreen.tsx": catalog2 }, { branch: DEVELOP }),
  step("2026-09-09T10:00:00Z", "priya", "fix(orders): keep a minimum height for the order row", { "src/components/OrderRow.tsx": orderRow2 }, { branch: "main" }),
  step("2026-09-10T13:20:00Z", "priya", "feat(orders): show refund status on the order detail (FB-231)", { "src/components/StatusPill.tsx": statusPill2, "src/screens/OrderDetailScreen.tsx": detail2, "src/api/orders.ts": apiOrders2 }),
  step("2026-09-11T10:50:00Z", "tomas", "feat(catalog): search field on the product list", { "src/screens/CatalogScreen.tsx": catalog3 }, { branch: DEVELOP }),
  step("2026-09-14T09:35:00Z", "daniel", "fix(theme): more contrast for muted text", { "src/theme/colors.ts": colors2 }, { branch: "main" }),
  step("2026-09-15T11:05:00Z", "tomas", "feat(catalog): debounce the search input", { "src/hooks/useDebounce.ts": useDebounce, "src/screens/CatalogScreen.tsx": catalog4 }, { branch: DEVELOP }),
  step("2026-09-16T14:25:00Z", "daniel", "test(orders): status pill labels", { "src/components/StatusPill.test.tsx": statusPillTest }, { branch: "main" }),
  step("2026-09-17T09:00:00Z", "release-bot", "chore(release): v0.9.0", { "package.json": pkg2, "app.json": app1 }, { tag: { name: "v0.9.0", message: "Release v0.9.0" } }),
  { at: "2026-09-18T10:30:00Z", author: "priya", message: "Merge branch 'develop'", branch: "main", merge: { from: DEVELOP, message: "Merge branch 'develop'" } },
  step("2026-09-21T10:10:00Z", "tomas", "fix(cart): update the item count after removing a line", { "src/state/cart.ts": cart3, "src/hooks/useCart.ts": useCart2 }),
  step("2026-09-22T11:40:00Z", "priya", "feat(refunds): refund call on the API client (FB-214)", { "src/api/refunds.ts": apiRefunds }),
  step("2026-09-23T10:25:00Z", "daniel", "feat(refunds): refund request screen (FB-214)", { "src/screens/RefundScreen.tsx": refund1, "src/navigation/types.ts": navTypes(6), "src/navigation/RootNavigator.tsx": navigator(6) }),
  step("2026-09-24T15:45:00Z", "tomas", "feat(settings): show the app language", { "src/screens/SettingsScreen.tsx": settings2 }, { branch: DEVELOP }),
  step("2026-09-26T11:15:00Z", "daniel", "feat(refunds): open the refund screen from the order detail (FB-214)", { "src/screens/OrderDetailScreen.tsx": detail3 }, { branch: "main" }),
];

// ---------------------------------------------------------------------------------------------------- work tree
const worktree = {
  modify: {
    "src/components/StatusPill.tsx": statusPillFinal,
    "src/screens/RefundScreen.tsx": refundFinal,
    "src/api/refunds.ts": apiRefundsFinal,
  },
  untracked: {
    "src/components/RefundReasonSheet.tsx": refundSheet,
  },
};

export default {
  id: "fb-mobile",
  name: "fb-mobile",
  branch: "main",
  files,
  history,
  worktree,
  // A third mock run (RC13) may reuse this: one line added to the status label table.
  agentEdit: { path: "src/components/StatusPill.tsx", before: AGENT_BEFORE, after: AGENT_AFTER },
  upstream: { ahead: 1, behind: 0 },
};

/** Ticket ids of the refund story that fb-api and fb-web history refer to as well. */
export const TICKETS = ["FB-214", "FB-231"];
